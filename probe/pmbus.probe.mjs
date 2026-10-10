/**
 * dsh-embedded-kit / lib/pmbus.js 的独立探针。
 *
 * 直接跑：`node probe/pmbus.probe.mjs`
 *
 * 做两件事：
 *   ① 打印本模块**规范基准**（SMBus 超时/拉伸上限、PEC 的 CRC-8 参数与
 *      已知报文的 PEC 值、LINEAR11 / LINEAR16 / DIRECT 的已知换算对）并逐条断言，
 *      防止实现漂移；
 *   ② 跑几个真实用例：
 *      - 上拉/电容固定的总线上，结合电气层（lib/i2c.js）的上升时间，判定命令层的
 *        超时与时钟拉伸预算；
 *      - 几个 LINEAR11 / LINEAR16 / DIRECT 原始值的物理量换算（含反解与量化误差）；
 *      - PEC 对已知报文的取值，以及"读事务漏掉第二个地址字节"这个高频错误的对照；
 *      - 读事务用 Sr 与用 STOP+START 的帧结构对照。
 *
 * 本脚本不依赖任何 npm 包，也不改动任何库文件（只 import）。
 */

import { analyzeI2c, riseTimeNs } from '../lib/i2c.js'
import { computePreset } from '../lib/crc.js'
import {
	analyzePec,
	analyzeReadTransaction,
	analyzeSmbusTiming,
	computePec,
	directToPhysical,
	linear11ToPhysical,
	linear16ToPhysical,
	parseVoutMode,
	pecCoverageBytes,
	physicalToDirect,
	physicalToLinear11,
	physicalToLinear16,
	vidCodeToPhysical,
	PEC_CRC_PARAMS,
	PEC_KNOWN_VECTORS,
	PMBUS_FORMAT_VECTORS,
	SMBUS_TRANSPORT_LIMITS,
} from '../lib/pmbus.js'

let passed = 0
let failed = 0

/**
 * 断言辅助：既打印也计数。
 *
 * @param {string} label - 断言说明。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 细节。
 */
function check(label, ok, detail) {
	if (ok) passed += 1
	else failed += 1
	console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? `  →  ${detail}` : ''}`)
}

/**
 * 打印小节标题。
 *
 * @param {string} title - 标题。
 */
function section(title) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/**
 * 浮点近似比较（相对误差 1e-9）。
 *
 * @param {number} a - 实际值。
 * @param {number} b - 期望值。
 * @returns {boolean} 是否近似相等。
 */
function near(a, b) {
	if (a === b) return true
	const scale = Math.max(Math.abs(a), Math.abs(b), 1)
	return Math.abs(a - b) / scale < 1e-9
}

/**
 * 按名字取出一条 check（check 的顺序由模块决定，断言不该依赖下标）。
 *
 * @param {object} result - 任一 analyze* 的返回值。
 * @param {string} name - check 名。
 * @returns {object} 该条 check。
 */
function findCheck(result, name) {
	const hit = result.checks.find((c) => c.name === name)
	if (!hit) throw new Error(`没有名为 '${name}' 的 check，实际有：${result.checks.map((c) => c.name).join(' / ')}`)
	return hit
}

/**
 * 十六进制格式化。
 *
 * @param {number} v - 值。
 * @param {number} [width] - 补零位数。
 * @returns {string} `0x..` 形式。
 */
function hex(v, width = 2) {
	return `0x${(v & 0xffff).toString(16).toUpperCase().padStart(width, '0')}`
}

/**
 * 打印判定结果块的 checks / warnings / notes。
 *
 * @param {object} result - 任一 analyze* 的返回值。
 * @param {number} [indent] - 缩进空格数。
 */
function printVerdict(result, indent = 0) {
	const pad = ' '.repeat(indent)
	for (const c of result.checks) {
		const tag = c.pass === null ? '[skip]' : c.pass ? '[ ok ]' : '[FAIL]'
		console.log(`${pad}${tag} ${c.name}：${c.detail}`)
	}
	for (const w of result.warnings) console.log(`${pad}[warn] ${w}`)
	for (const n of result.notes) console.log(`${pad}[note] ${n}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 规范基准向量
// ─────────────────────────────────────────────────────────────────────────────

section('① 规范基准（联网核实，出处登记见 lib/pmbus.js 文件头 [S1]~[P5]）')

console.log('\n-- SMBus / PMBus 传输层上限（出处 [S1]：SMBus 3.0 Table 2；PMBus Part I Rev 1.2 §5.2.6.2 Table 2）--')
console.log(`tTIMEOUT    min ${SMBUS_TRANSPORT_LIMITS.tTimeoutMinMs} ms   max ${SMBUS_TRANSPORT_LIMITS.tTimeoutMaxMs} ms   ← 25 是误触发阈值，35 是清除期限，不是"典型值"`)
console.log(`tLOW:SEXT   max ${SMBUS_TRANSPORT_LIMITS.tLowSextMaxMs} ms   （从器件，一次消息 start→stop 累计）`)
console.log(`tLOW:MEXT   max ${SMBUS_TRANSPORT_LIMITS.tLowMextMaxMs} ms   （主器件，每字节 start→ack/ack→ack/ack→stop 累计）`)
console.log(`tBUF        100k ${SMBUS_TRANSPORT_LIMITS.tBufMinUs[100000]} µs / 400k ${SMBUS_TRANSPORT_LIMITS.tBufMinUs[400000]} µs / 1M ${SMBUS_TRANSPORT_LIMITS.tBufMinUs[1000000]} µs`)
check('tTIMEOUT = 25 / 35 ms', SMBUS_TRANSPORT_LIMITS.tTimeoutMinMs === 25 && SMBUS_TRANSPORT_LIMITS.tTimeoutMaxMs === 35)
check('tLOW:SEXT = 25 ms', SMBUS_TRANSPORT_LIMITS.tLowSextMaxMs === 25)
check('tLOW:MEXT = 10 ms', SMBUS_TRANSPORT_LIMITS.tLowMextMaxMs === 10)
check('SEXT(25) + MEXT(10) = 35 = tTIMEOUT(max)', 25 + 10 === SMBUS_TRANSPORT_LIMITS.tTimeoutMaxMs, '这是规范里两个数字互相吻合的地方')

console.log('\n-- PEC 的 CRC-8 参数（出处 [S3]）与 crc.js 预设的一致性 --')
console.log(`多项式 ${PEC_CRC_PARAMS.polynomial}（poly ${hex(PEC_CRC_PARAMS.poly)}）、init ${hex(PEC_CRC_PARAMS.init)}、` +
	`refin/refout = ${PEC_CRC_PARAMS.refin}/${PEC_CRC_PARAMS.refout}、xorout ${hex(PEC_CRC_PARAMS.xorout)}`)
check('参数等价于 lib/crc.js 的 crc8 预设', PEC_CRC_PARAMS.presetName === 'crc8' && PEC_CRC_PARAMS.poly === 0x07 && PEC_CRC_PARAMS.init === 0x00 && PEC_CRC_PARAMS.refin === false && PEC_CRC_PARAMS.refout === false)
check(
	'crc.js 的 crc8 预设标准 check 值 = 0xF4（对 ASCII "123456789"）',
	computePreset([...'123456789'].map((c) => c.charCodeAt(0)), 'crc8') === 0xf4,
)
check('pmbus.js 没有自己实现 CRC：computePec 走的就是 computePreset(…, "crc8")',
	computePec([0x00, 0x11, 0x22]) === computePreset([0x00, 0x11, 0x22], 'crc8'))

console.log('\n-- PEC 已知报文基准（出处 [S4]，逐字节参与 CRC，含地址字节、不含 PEC 自身/ACK/START/STOP/Sr）--')
for (const v of PEC_KNOWN_VECTORS) {
	const got = computePec(v.bytes)
	console.log(`${v.label}`)
	console.log(`  报文 ${v.bytes.map((b) => hex(b)).join(' ')}`)
	console.log(`  期望 PEC ${hex(v.pec)} / 实算 ${hex(got)}`)
	console.log(`  出处：${v.source}`)
	check(`${v.label} → PEC ${hex(v.pec)}`, got === v.pec, `实算 ${hex(got)}`)
}

console.log('\n-- 数据格式已知换算对（出处 [P2] LINEAR11 / [P4] LINEAR16 / [P3] DIRECT）--')
for (const v of PMBUS_FORMAT_VECTORS.linear11) {
	const r = linear11ToPhysical(v.raw)
	console.log(`LINEAR11 ${v.label.padEnd(22)} raw ${hex(v.raw, 4)} → N=${r.exponent} Y=${r.mantissa} X=${r.value}`)
	console.log(`          出处：${v.source}`)
	check(`${v.label} ${hex(v.raw, 4)} → ${v.value}`, near(r.value, v.value) && r.exponent === v.exponent && r.mantissa === v.mantissa,
		`N=${r.exponent}(期望 ${v.exponent}) Y=${r.mantissa}(期望 ${v.mantissa}) X=${r.value}`)
}
for (const v of PMBUS_FORMAT_VECTORS.linear16) {
	const r = linear16ToPhysical(v.raw, { exponent: v.exponent, signed: v.signed })
	console.log(`LINEAR16 ${v.label.padEnd(30)} raw ${hex(v.raw, 4)} → V=${r.mantissa} X=${r.value}`)
	console.log(`          出处：${v.source}`)
	check(`${v.label} ${hex(v.raw, 4)} @N=${v.exponent} → ${v.value.toFixed(6)}`, near(r.value, v.value),
		`实算 ${r.value.toFixed(6)}`)
}
for (const v of PMBUS_FORMAT_VECTORS.direct) {
	const r = directToPhysical(v.raw, { m: v.m, b: v.b, r: v.r })
	console.log(`DIRECT   ${v.label} raw ${hex(v.raw, 4)} → X=${r.value.toFixed(4)}`)
	console.log(`          出处：${v.source}`)
	check(`${v.label} ${hex(v.raw, 4)} → ${v.value.toFixed(4)}`, near(r.value, v.value), `实算 ${r.value.toFixed(4)}`)
}

console.log('\n-- VOUT_MODE 位域（出处 [P4] §8.2 Table 2）--')
for (const [raw, expectMode, expectExp] of [[0x17, 'linear', -9], [0x16, 'linear', -10], [0x20, 'vid', null], [0x40, 'direct', null], [0x80, 'reserved', null], [0x70, 'ieee-half', null]]) {
	const r = parseVoutMode(raw)
	console.log(`VOUT_MODE ${hex(raw)} → Mode=${r.modeCode.toString(2).padStart(3, '0')}b ${r.mode.padEnd(8)} Parameter=${hex(r.parameter)}${r.exponent === null ? '' : ` N=${r.exponent}`}`)
	check(`VOUT_MODE ${hex(raw)} → ${expectMode}`, r.mode === expectMode && r.exponent === expectExp, `实得 ${r.mode} / N=${r.exponent}`)
}
check('VOUT_MODE 0x17 → N = -9（PMBus Part II §8.2：Parameter 是 5 位补码）', parseVoutMode(0x17).exponent === -9)
check('legacy 位域：0x97 在 spec-7:5 下是保留值、在 legacy-6:5 下是 linear 且 relative=1',
	parseVoutMode(0x97).mode === 'reserved' && parseVoutMode(0x97, { layout: 'legacy-6:5' }).mode === 'linear' && parseVoutMode(0x97, { layout: 'legacy-6:5' }).relative === true)

// ─────────────────────────────────────────────────────────────────────────────
// ② 真实用例
// ─────────────────────────────────────────────────────────────────────────────

section('② 真实用例')

// ── 用例 1：上拉/电容固定的总线 ───────────────────────────────────────────────
console.log('\n-- 用例 1：Rp = 4.7 kΩ、Cb = 200 pF、VDD = 3.3 V 的 100 kHz SMBus 总线 --')
console.log('   电气层（lib/i2c.js）先算上升时间；命令层（本模块）再判超时与拉伸预算。')
const cbPf = 200
const rpOhm = 4700
const i2c = analyzeI2c({ mode: 'standard', cbPf, rpOhm, vddV: 3.3 })
const tr = riseTimeNs(rpOhm, cbPf)
console.log(`   上拉区间：${Math.round(i2c.rpMinOhm)} Ω … ${Math.round(i2c.rpMaxOhm)} Ω；实际上升时间 tr ≈ ${tr.toFixed(0)} ns（上限 ${i2c.trMaxNs} ns）`)
check('该 Rp/Cb 组合下电气层可行', i2c.checks.every((c) => c.pass) && tr <= i2c.trMaxNs)

// 器件手册（示例）：从器件最长累计拉伸 12 ms、单次最长低电平 6 ms；主控在中断里做 I²C，每字节按 1.5 ms 计。
const timingOk = analyzeSmbusTiming({
	maxClockLowMs: 6,
	slaveStretchCumulativeMs: 12,
	masterStretchCumulativeMs: 1.5,
	busSpeedHz: 100000,
})
console.log('\n   [通过的例子] 器件手册标称：单次最长低电平 6 ms、整条消息从器件累计拉伸 12 ms、主控每字节 1.5 ms')
printVerdict(timingOk, 3)
check('用例 1 全部通过', timingOk.checks.every((c) => c.pass === true) && timingOk.warnings.length === 0)
console.log(`   裕量：单次低电平 ${timingOk.marginsMs.maxClockLow} ms / 从器件累计 ${timingOk.marginsMs.slaveStretch} ms / 主器件每字节 ${timingOk.marginsMs.masterStretch} ms`)

console.log('\n   [不通过的例子] 同一总线上换成一颗慢器件：单次低电平 30 ms、累计拉伸 28 ms')
const timingBad = analyzeSmbusTiming({ maxClockLowMs: 30, slaveStretchCumulativeMs: 28, masterStretchCumulativeMs: 1.5 })
printVerdict(timingBad, 3)
check('用例 1b 正确判出两个失败项',
	timingBad.checks.filter((c) => c.pass === false).length === 2 && timingBad.warnings.length === 2)

console.log('\n   [逼超时的例子] 想让卡死的从器件释放总线')
const timingForceShort = analyzeSmbusTiming({ forceTimeoutHoldMs: 20 })
const timingForceOk = analyzeSmbusTiming({ forceTimeoutHoldMs: 40 })
const forceCheckShort = findCheck(timingForceShort, '主动逼出对端超时（需 ≥ tTIMEOUT(max)）')
const forceCheckOk = findCheck(timingForceOk, '主动逼出对端超时（需 ≥ tTIMEOUT(max)）')
console.log(`   拉低 20 ms：${forceCheckShort.pass ? '通过' : '不通过'}（规范要求 ≥ 35 ms 才能"确保"超时）`)
console.log(`   拉低 40 ms：${forceCheckOk.pass ? '通过' : '不通过'}，裕量 ${timingForceOk.marginsMs.forceTimeout} ms`)
check('20 ms 不足以逼出超时', forceCheckShort.pass === false)
check('40 ms 足以逼出超时', forceCheckOk.pass === true)

console.log('\n   [缺输入的例子] 手头还没有实测数据时，模块不猜、只点名缺什么')
const timingNoData = analyzeSmbusTiming({ busSpeedHz: 400000 })
printVerdict(timingNoData, 3)
check('缺实测数据时三项判定都标 skipped 且 pass=null',
	timingNoData.checks.length === 3 && timingNoData.checks.every((c) => c.pass === null && c.skipped === true) && timingNoData.notes.length >= 4)

// ── 用例 2：PEC 对已知报文 ───────────────────────────────────────────────────
console.log('\n-- 用例 2：PEC 对 bq2084 的 RemainingCapacity() 读事务（地址 0x0B → 线上 0x16/0x17）--')
const coverage = pecCoverageBytes({ address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03] })
console.log(`   覆盖字节：${coverage.map((b) => hex(b)).join(' ')}  （地址+W、命令、地址+R、数据低字节、数据高字节）`)
const pecRead = analyzePec({ address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03], receivedPec: 0xe8, observedBytes: coverage })
console.log(`   应有 PEC ${hex(pecRead.expectedPec)}`)
printVerdict(pecRead, 3)
check('用例 2 全部通过', pecRead.checks.every((c) => c.pass === true) && pecRead.warnings.length === 0)

console.log('\n   [三种协议形态的覆盖范围] 地址字节出现几次，是 PEC 最容易搞错的地方')
const covRead = pecCoverageBytes({ address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03] })
const covRecv = pecCoverageBytes({ address7: 0x0b, read: true, data: [0x42] })
const covWrite = pecCoverageBytes({ address7: 0x0b, read: false, command: 0x10, data: [0x00] })
console.log(`     Read Word（带命令）    → ${covRead.map((b) => hex(b)).join(' ')}   ← +W 与 +R 两个地址字节都算`)
console.log(`     Receive Byte（无命令） → ${covRecv.map((b) => hex(b)).join(' ')}          ← 只有一段 +R 地址`)
console.log(`     Write Byte            → ${covWrite.map((b) => hex(b)).join(' ')}          ← 只有 +W`)
check('Read Word 的覆盖含两个地址字节（0x16 与 0x17）', covRead[0] === 0x16 && covRead[2] === 0x17 && covRead.length === 5)
check('Receive Byte 的覆盖只有一段 +R 地址', covRecv.length === 2 && covRecv[0] === 0x17)
check('Write Byte 的覆盖只有一段 +W 地址', covWrite.length === 3 && covWrite[0] === 0x16)

console.log('\n   [高频错误] 驱动把这次读当成了写事务来算 PEC（漏掉 +R 那一段地址）')
const wrongBytes = [0x16, 0x0f, 0xe9, 0x03] // 漏了第二个地址字节 0x17
const pecWrong = analyzePec({ address7: 0x0b, read: false, command: 0x0f, data: [0xe9, 0x03], receivedPec: 0xe8 })
console.log(`   驱动按"写事务"算的覆盖：${wrongBytes.map((b) => hex(b)).join(' ')} → PEC ${hex(computePec(wrongBytes))}；器件实际发的是 ${hex(0xe8)}`)
printVerdict(pecWrong, 3)
check('覆盖范围不对称时，PEC 校验值能报错（应有 0xA3 / 收到 0xE8）',
	findCheck(pecWrong, 'PEC 校验值').pass === false && pecWrong.expectedPec === 0xa3)
check('但只看 CRC 值说明不了"是谁少算了"：驱动自己的覆盖序列是自洽的，覆盖检查反而通过',
	findCheck(pecWrong, 'PEC 覆盖字节序列').pass === null)

console.log('\n   [正确的排查姿势] 把逻辑分析仪抓到的字节传进 observedBytes，一眼定位到第 3 个字节')
const pecDiag = analyzePec({ address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03], receivedPec: 0xe8, observedBytes: wrongBytes })
const coverageCheck = findCheck(pecDiag, 'PEC 覆盖字节序列')
console.log(`   ${coverageCheck.detail}`)
check('覆盖序列检查把差异定位到第 3 个字节（0xE9 vs 0x17）',
	coverageCheck.pass === false && coverageCheck.detail.includes('第 3 个字节起不一致'))
check('按正确覆盖算出的 PEC 与器件发的完全一致（0xE8）', pecDiag.expectedPec === 0xe8)

// ── 用例 3：LINEAR11 / LINEAR16 / DIRECT 双向换算 ────────────────────────────
console.log('\n-- 用例 3：数据格式双向换算 --')

console.log('\n   LINEAR11 读方向（器件返回 → 物理值）')
for (const raw of [0xf814, 0x0258, 0xe002, 0xd7f9]) {
	const r = linear11ToPhysical(raw)
	console.log(`     ${hex(raw, 4)} → N=${String(r.exponent).padStart(3)} Y=${String(r.mantissa).padStart(5)} X=${r.value}`)
}
check('0xF814 → 10（VIN_ON 默认值）', near(linear11ToPhysical(0xf814).value, 10))
check('0xD7F9 → 负值（N=0x1A−0x20=−6、Y=0x7F9−0x800=−7 → −7/64）',
	linear11ToPhysical(0xd7f9).mantissa === -7 && linear11ToPhysical(0xd7f9).exponent === -6 && near(linear11ToPhysical(0xd7f9).value, -7 / 64),
	`N=${linear11ToPhysical(0xd7f9).exponent} Y=${linear11ToPhysical(0xd7f9).mantissa} X=${linear11ToPhysical(0xd7f9).value}`)

console.log('\n   LINEAR11 写方向（物理值 → 原始值，含反解与量化误差）')
for (const x of [1, 0.125, 10, 600, 3.3, -12.5, 0]) {
	const enc = physicalToLinear11(x)
	console.log(`     X=${String(x).padStart(7)} → raw ${hex(enc.raw, 4)}  N=${String(enc.exponent).padStart(3)} Y=${String(enc.mantissa).padStart(5)}  反解 ${enc.value}  误差 ${(enc.value - x).toExponential(2)}`)
}
check('physicalToLinear11(1) 与线性 11 位可精确表示：反解误差为 0', physicalToLinear11(1).value === 1)
check('physicalToLinear11(0.125, {exponent:-4}) 复用器件默认指数得 0xE002',
	physicalToLinear11(0.125, { exponent: -4 }).raw === 0xe002)
check('physicalToLinear11 越界抛错（可在 +1e9 这种超出 ±3.35e7 的值上触发）',
	(() => { try { physicalToLinear11(1e9); return false } catch { return true } })())
check('physicalToLinear11 指定指数装不下时抛错（600 在 N=-16 下需要 Y=39321600）',
	(() => { try { physicalToLinear11(600, { exponent: -16 }); return false } catch (e) { return e.message.includes('39321600') } })())

console.log('\n   LINEAR16（输出电压类，指数 N 必须来自 VOUT_MODE）')
for (const [raw, n, signed] of [[0x2666, -13, false], [0x0133, -9, true], [0x1c00, -9, true], [0xffff, -9, true]]) {
	const r = linear16ToPhysical(raw, { exponent: n, signed })
	console.log(`     ${hex(raw, 4)} @N=${String(n).padStart(3)} ${signed ? 'SLINEAR16' : 'ULINEAR16'} → V=${String(r.mantissa).padStart(6)} X=${r.value} V`)
}
check('0x2666 @N=-13 → 1.19995 V（EM22xx 应用笔记标称 1.2 V）', near(linear16ToPhysical(0x2666, { exponent: -13 }).value, 1.199951171875))
check('0x0133 @N=-9 → 0.59961 V（SiC951 默认 0.6 V）', near(linear16ToPhysical(0x0133, { exponent: -9 }).value, 0.599609375))
check('physicalToLinear16(1.2, {exponent:-13}) → 0x2666', physicalToLinear16(1.2, { exponent: -13 }).raw === 0x2666,
	`实得 ${hex(physicalToLinear16(1.2, { exponent: -13 }).raw, 4)}`)
check('linear16ToPhysical 缺 exponent 时抛错并点名（本模块不内置默认指数）',
	(() => { try { linear16ToPhysical(0x2666, {}); return false } catch (e) { return e.message.includes('VOUT_MODE') } })())

console.log('\n   DIRECT（系数必须来自 COEFFICIENTS 或手册；此处用 Richtek RTQ1950 §18.2 的 VIN 组 m=4617, b=-140, R=-2）')
const coeff = { m: 4617, b: -140, r: -2 }
for (const raw of [0x0000, 0x0228, 0x1000]) {
	const r = directToPhysical(raw, coeff)
	console.log(`     raw ${hex(raw, 4)} (Y=${String(r.y).padStart(6)}) → X=${r.value.toFixed(4)} V`)
}
check('Y=0 时 X = (0−(−140))/4617 = 140/4617 ≈ 0.03032 V（偏置项确实被减掉）', near(directToPhysical(0, coeff).value, 140 / 4617))
check('Y=552 → ≈11.9861 V', near(directToPhysical(552, coeff).value, 55340 / 4617))
const viEnc = physicalToDirect(12.0, coeff)
console.log(`     写方向：12.0000 V → Y=${viEnc.y}（未取整是 ${(4617 * 12 - 140) / 100}）→ raw ${hex(viEnc.raw, 4)}，反解 ${viEnc.value.toFixed(4)} V，量化误差 ${((viEnc.value - 12) * 1000).toFixed(2)} mV`)
console.log(`     量化台阶 = 1/m × 10^-R = ${(10 ** 2 / 4617).toFixed(5)} V/bit（不是 2 的幂）`)
check('DIRECT 往返一致（量化后反解即为编码值）', near(physicalToDirect(12.0, coeff).value, directToPhysical(physicalToDirect(12.0, coeff).raw, coeff).value))
check('DIRECT 缺系数时抛错并点名缺哪一项',
	(() => { try { directToPhysical(100, { m: 4617, r: -2 }); return false } catch (e) { return e.message.includes('b（偏置）') } })())
check('DIRECT 允许负温度（Y 为 16 位补码，raw=0xFFFF → Y=-1）', directToPhysical(0xffff, { m: 16000, b: 0, r: -3 }).y === -1)

console.log('\n   VID（码表必须由调用方提供 —— 本模块不内置任何厂商码表）')
try {
	vidCodeToPhysical(0x0042, { bitCount: 8 })
} catch (e) {
	console.log(`     不给码表时的行为：抛错 → 「${e.message}」`)
	check('VID 缺码表时抛错并点名缺哪一项', e.message.includes('codeTable'))
}
// 下面这张表是**编造的**，只为演示查表通路；真实的 VR11/VR12 码表见各器件手册。
const demoTable = { 0: 1.6, 1: 1.5, 2: 1.4, 66: 0.9 }
const vid = vidCodeToPhysical(0x0042, { bitCount: 8, codeTable: demoTable })
console.log(`     给码表时：raw 0x0042（低 8 位 = 0x42 = 十进制 ${vid.code}）→ ${vid.voltage} V`)
console.log('     注：上面的 demoTable 是**编造**的演示数据，不是任何厂商的 VID 码表。')
check('VID 查表通路可用', vid.voltage === 0.9)
check('VID 未用位非 0 时给警告', vidCodeToPhysical(0x0142, { bitCount: 8, codeTable: demoTable }).warnings.length === 1)

// ── 用例 4：读事务的 Sr 与 STOP+START ────────────────────────────────────────
console.log('\n-- 用例 4：读 VOUT_COMMAND (0x21)，地址 0x24 --')
const readOk = analyzeReadTransaction({ address7: 0x24, command: 0x21, readKind: 'read-word', usesRepeatedStart: true, pec: true, controllerSupportsSr: true })
console.log('   [正确] 用重复起始：')
printVerdict(readOk, 3)
check('用例 4 正确帧含 Sr 且只有一个 P', readOk.frame.join(' ').includes('Sr') && readOk.frame.filter((c) => c === 'P').length === 1)

const readBad = analyzeReadTransaction({ address7: 0x24, command: 0x21, readKind: 'read-word', usesRepeatedStart: false, controllerSupportsSr: false, pec: true })
console.log('\n   [错误] 用 STOP 再 START：')
printVerdict(readBad, 3)
check('用例 4b 判出 Sr 缺失与控制器不支持 Sr 两项失败',
	readBad.checks.filter((c) => c.pass === false).length === 2)
check('用例 4b 错误帧里有两个 P 和一个 S（事务被切成两段）',
	readBad.frame.filter((c) => c === 'P').length === 2 && readBad.frame.filter((c) => c === 'Sr').length === 0)

const readUnknown = analyzeReadTransaction({ address7: 0x24, command: 0x21 })
console.log('\n   [未给事实] 不知道波形上是 Sr 还是 STOP 时：')
printVerdict(readUnknown, 3)
check('未给 usesRepeatedStart 时该项标 skipped', readUnknown.checks[0].pass === null && readUnknown.checks[0].skipped === true)

// ─────────────────────────────────────────────────────────────────────────────

section('汇总')
console.log(`断言 ${passed + failed} 条：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
	console.log('存在失败断言，上面标 [FAIL] 的行就是问题所在。')
	process.exitCode = 1
} else {
	console.log('全部通过。')
}
