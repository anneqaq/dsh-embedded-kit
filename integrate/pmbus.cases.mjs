/**
 * `pmbus_check` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './pmbus.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖三类东西：
 *   ① lib/pmbus.js 里**规范基准向量**——两个厂商的 PEC 已知报文
 *      （bq2084 的 0xE8、TI E2E 的 0x64）、LINEAR11 / LINEAR16 / DIRECT 的已知换算对、
 *      SMBus 的 25 / 35 ms 两条判定线；
 *   ② 工具描述符（integrate/pmbus.tool.mjs）的形状与参数约束；
 *   ③ 负向用例：PEC 不符、覆盖范围与波形不一致、超时越限、逼超时不足，
 *      以及"缺必填输入必须抛错点名"（缺 N、缺 DIRECT 系数、越界）。
 *
 * 用例全部是**同步**的：宿主给的 `test` 签名是 `(label, fn) => void`，不 await。
 * 所以走的是工具导出的同步分派器 `dispatch`（`tool.execute` 内部就是它），
 * 这样不必依赖宿主 test 实现是否 await 一个 Promise。用例只读，不修改任何 lib 文件。
 *
 * @module dsh-embedded-kit/integrate/pmbus.cases
 */

import {
	computePec,
	directToPhysical,
	linear11ToPhysical,
	PEC_CRC_PARAMS,
	PEC_KNOWN_VECTORS,
	pecCoverageBytes,
	PMBUS_FORMAT_VECTORS,
	SMBUS_TRANSPORT_LIMITS,
} from '../lib/pmbus.js'

import { dispatch, PARAM_NAMES, tool } from './pmbus.tool.mjs'

/**
 * 按名字取出一条 check（check 的顺序由模块决定，断言不该依赖下标）。
 *
 * @param {object} result - 任一分支的返回值。
 * @param {string} name - check 名。
 * @returns {object} 该条 check。
 */
function findCheck(result, name) {
	const hit = result.checks.find((c) => c.name === name)
	if (!hit) throw new Error(`没有名为 '${name}' 的 check，实际有：${result.checks.map((c) => c.name).join(' / ')}`)
	return hit
}

/** 16 位十六进制渲染，仅用于断言消息。 */
const hex4 = (v) => `0x${(v & 0xffff).toString(16).toUpperCase().padStart(4, '0')}`

/** 探针里用过的 bq2084 读事务参数（地址 0x0B → 线上 +W 0x16 / +R 0x17）。 */
const BQ2084 = { address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03] }

/** 探针里用过的 Richtek RTQ1950 §18.2 VIN 组系数。 */
const DIRECT_VIN_COEFF = { m: 4617, b: -140, r: -2 }

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例（同步）。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert }) {
	/* ── ① 规范基准向量 ─────────────────────────────────────────── */

	test('PEC 覆盖范围：读事务含两个地址字节，Receive Byte 只有一个，写事务只有 +W', () => {
		// 读事务：地址字节出现两次（+W 送命令、+R 收数据），两次都要进 CRC
		assert.deepEqual(pecCoverageBytes({ address7: 0x0b, read: true, command: 0x0f, data: [0xe9, 0x03] }), [
			0x16, 0x0f, 0x17, 0xe9, 0x03,
		])
		// Receive Byte / ARA：没有"写命令"那一段，只有一段 +R 地址
		assert.deepEqual(pecCoverageBytes({ address7: 0x0b, read: true, data: [0x42] }), [0x17, 0x42])
		// 写事务：只有 +W
		assert.deepEqual(pecCoverageBytes({ address7: 0x0b, read: false, command: 0x10, data: [0x00] }), [
			0x16, 0x10, 0x00,
		])

		// 工具侧必须映射出同样的覆盖序列（地址由 7 位地址左移 + R/W# 得到，不用调用方换算）
		const viaTool = dispatch({ action: 'pec', ...BQ2084 })
		assert.deepEqual(viaTool.coverage, [0x16, 0x0f, 0x17, 0xe9, 0x03])
		assert.equal(viaTool.read, true)
		assert.equal(viaTool.command, 0x0f)
		assert.equal(viaTool.receivedPec, null)

		// 地址必须是 7 位
		assert.throws(() => pecCoverageBytes({ address7: 200 }), /address7/)
	})

	test('PEC 基准向量：bq2084（0xE8）与 TI E2E（0x64）——两个独立厂商的已知报文', () => {
		// lib 里登记的基准本身没有漂移
		for (const v of PEC_KNOWN_VECTORS) {
			assert.equal(computePec(v.bytes), v.pec, `${v.label}：实算应等于登记的 PEC`)
		}

		// 逐条走工具：地址取第一字节的高 7 位，命令与数据按总线顺序传
		const bq = PEC_KNOWN_VECTORS[0]
		assert.deepEqual(bq.bytes, [0x16, 0x0f, 0x17, 0xe9, 0x03])
		assert.equal(bq.pec, 0xe8)
		const rBq = dispatch({ action: 'pec', ...BQ2084, received_pec: 0xe8, observed_bytes: bq.bytes })
		assert.equal(rBq.expectedPec, 0xe8)
		assert.ok(rBq.checks.every((c) => c.pass === true), 'bq2084 报文应全部通过')
		assert.equal(rBq.warnings.length, 0)

		const ti = PEC_KNOWN_VECTORS[1]
		assert.deepEqual(ti.bytes, [0x16, 0x0d, 0x17, 0x10, 0x00])
		assert.equal(ti.pec, 0x64)
		const rTi = dispatch({
			action: 'pec',
			address7: 0x0b,
			read: true,
			command: 0x0d,
			data: [0x10, 0x00],
			received_pec: 0x64,
			observed_bytes: ti.bytes,
		})
		assert.equal(rTi.expectedPec, 0x64)
		assert.ok(rTi.checks.every((c) => c.pass === true), 'TI E2E 报文应全部通过')
		assert.equal(rTi.warnings.length, 0)

		// CRC 参数就是 lib/crc.js 的 crc8 预设（poly 0x07 / init 0x00 / 不反射 / xorout 0x00）
		assert.equal(PEC_CRC_PARAMS.presetName, 'crc8')
		assert.equal(PEC_CRC_PARAMS.poly, 0x07)
		assert.equal(PEC_CRC_PARAMS.init, 0x00)
		assert.equal(PEC_CRC_PARAMS.refin, false)
		assert.equal(PEC_CRC_PARAMS.refout, false)
	})

	test('LINEAR16 基准：0x2666 @N=−13 → 1.199951171875；1.2 @N=−13 编回 0x2666', () => {
		// 注：这条向量在 lib/pmbus.js 里登记在 PMBUS_FORMAT_VECTORS.linear16
		//（'VOUT_COMMAND (ULINEAR16, N=-13)'，出处 Intel/Altera EM22xx 应用笔记）。
		const dec = dispatch({ action: 'linear', format: 'linear16', raw: 0x2666, exponent: -13 })
		assert.equal(dec.direction, 'decode')
		assert.equal(dec.mantissa, 9830)
		assert.equal(dec.signed, false)
		assert.equal(dec.value, 9830 * 2 ** -13)
		assert.equal(dec.value, 1.199951171875)
		assert.equal(dec.quantStep, 2 ** -13)
		assert.ok(dec.checks.every((c) => c.pass === true), '解码与"编回原码"两条判定都应通过')
		assert.equal(dec.matchedVector, 'VOUT_COMMAND (ULINEAR16, N=-13)')

		const enc = dispatch({ action: 'linear', format: 'linear16', value: 1.2, exponent: -13 })
		assert.equal(enc.direction, 'encode')
		assert.equal(enc.raw, 0x2666)
		assert.equal(enc.mantissa, 9830)
		assert.ok(enc.checks.every((c) => c.pass === true), '编码应落在最近的格子上')

		// 同一个 16 位字按 LINEAR11 读是完全不同的数 —— N 猜错就是这种量级的错
		const asLinear11 = linear11ToPhysical(0x2666)
		assert.equal(asLinear11.exponent, 4)
		assert.equal(asLinear11.mantissa, -410)
		assert.equal(asLinear11.value, -6560)
	})

	test('LINEAR11 基准对：0xE002 / 0xE808 / 0xF814 / 0x0258 与负值 0xD7F9', () => {
		const vectors = [
			[0xe002, -4, 2, 0.125], // VOUT_TRANSITION_RATE
			[0xe808, -3, 8, 1], // VOUT_SCALE_LOOP
			[0xf814, -1, 20, 10], // VIN_ON
			[0x0258, 0, 600, 600], // FREQUENCY_SWITCH
		]
		for (const [raw, n, y, x] of vectors) {
			const r = dispatch({ action: 'linear', format: 'linear11', raw })
			assert.equal(r.exponent, n, `${hex4(raw)} 的 N`)
			assert.equal(r.mantissa, y, `${hex4(raw)} 的 Y`)
			assert.equal(r.value, x, `${hex4(raw)} 的物理值`)
			assert.equal(r.quantStep, 2 ** n)
			assert.ok(r.checks.every((c) => c.pass === true), `${hex4(raw)} 解码自洽性判定应通过`)
		}

		// 尾数为负是正常的（N=−6、Y=−7 → −7/64）
		const neg = dispatch({ action: 'linear', format: 'linear11', raw: 0xd7f9 })
		assert.equal(neg.exponent, -6)
		assert.equal(neg.mantissa, -7)
		assert.equal(neg.value, -7 / 64)

		// 命中 lib 登记的已知基准时要在 notes 里点名出处
		const vinOn = dispatch({ action: 'linear', format: 'linear11', raw: 0xf814 })
		assert.equal(vinOn.matchedVector, 'VIN_ON')
		assert.ok(vinOn.notes.some((n) => n.includes('出处')), '命中基准向量时应给出出处')

		// 与 lib 直接调用一致
		assert.equal(linear11ToPhysical(0xf814).value, 10)
		assert.equal(PMBUS_FORMAT_VECTORS.linear11.length, 4)
	})

	test('SMBus 判定线：tTIMEOUT 25/35 ms 是"误触发阈值 + 清除期限"，SEXT+MEXT = 35', () => {
		assert.equal(SMBUS_TRANSPORT_LIMITS.tTimeoutMinMs, 25)
		assert.equal(SMBUS_TRANSPORT_LIMITS.tTimeoutMaxMs, 35)
		assert.equal(SMBUS_TRANSPORT_LIMITS.tLowSextMaxMs, 25)
		assert.equal(SMBUS_TRANSPORT_LIMITS.tLowMextMaxMs, 10)
		// 规范里两个数字互相吻合的地方
		assert.equal(SMBUS_TRANSPORT_LIMITS.tLowSextMaxMs + SMBUS_TRANSPORT_LIMITS.tLowMextMaxMs, SMBUS_TRANSPORT_LIMITS.tTimeoutMaxMs)
		assert.equal(SMBUS_TRANSPORT_LIMITS.tBufMinUs[100000], 4.7)
		assert.equal(SMBUS_TRANSPORT_LIMITS.tBufMinUs[400000], 1.3)

		// 工具必须把 25/35 的语义说清楚，而不是当"典型值上下限"
		const r = dispatch({ action: 'timing', bus_speed_hz: 100000 })
		assert.equal(r.limits.tTimeoutMinMs, 25)
		assert.ok(r.notes.some((n) => n.includes('误触发阈值')))
		assert.ok(r.notes.some((n) => n.includes('清除期限')))
	})

	/* ── ② 正向：真实用例 ──────────────────────────────────────── */

	test('超时正向：厂商标称值全部落在规范上限内，裕量逐项正确', () => {
		const r = dispatch({
			action: 'timing',
			max_clock_low_ms: 6,
			slave_stretch_ms: 12,
			master_stretch_ms: 1.5,
			bus_speed_hz: 100000,
		})
		assert.equal(r.checks.length, 3)
		assert.ok(r.checks.every((c) => c.pass === true), '三项都应在限内')
		assert.equal(r.warnings.length, 0)

		assert.equal(r.marginsMs.maxClockLow, 19) // 25 − 6
		assert.equal(r.marginsMs.slaveStretch, 13) // 25 − 12
		assert.equal(r.marginsMs.masterStretch, 8.5) // 10 − 1.5
		assert.equal(r.marginsMs.forceTimeout, null) // 没给就不编

		// tBUF 只在给了 bus_speed_hz 时进 notes，不参与判定
		assert.ok(r.notes.some((n) => n.includes('4.7')))
	})

	test('超时负向：30 ms 落进 25~35 ms 灰区、28 ms 超 tLOW:SEXT，必须各自报警', () => {
		const r = dispatch({ action: 'timing', max_clock_low_ms: 30, slave_stretch_ms: 28, master_stretch_ms: 1.5 })
		assert.equal(r.checks.filter((c) => c.pass === false).length, 2, '应有两项不通过')
		assert.equal(r.warnings.length, 2)
		// 30 ms 已越过误触发阈值但未到清除期限 —— 这是最危险的灰区
		assert.equal(findCheck(r, 'tTIMEOUT（单次 SCL 低电平）').pass, false)
		assert.ok(r.warnings.some((w) => w.includes('灰区')))
		assert.ok(r.warnings.some((w) => w.includes('tLOW:SEXT')))
		assert.equal(findCheck(r, 'tLOW:MEXT（主器件每字节累计拉伸）').pass, true)

		// ≥ 35 ms 是另一种后果：对端必然已判超时并复位
		const beyond = dispatch({ action: 'timing', max_clock_low_ms: 40 })
		assert.equal(findCheck(beyond, 'tTIMEOUT（单次 SCL 低电平）').pass, false)
		assert.ok(beyond.warnings.some((w) => w.includes('必然')))

		// 主器件每字节超过 10 ms 也要报
		const mext = dispatch({ action: 'timing', master_stretch_ms: 12 })
		assert.equal(findCheck(mext, 'tLOW:MEXT（主器件每字节累计拉伸）').pass, false)
		assert.ok(mext.warnings.some((w) => w.includes('tLOW:MEXT')))
	})

	test('超时负向：逼对端超时拉低不足 35 ms 必须报警，40 ms 才通过', () => {
		const name = '主动逼出对端超时（需 ≥ tTIMEOUT(max)）'
		const short = dispatch({ action: 'timing', force_timeout_hold_ms: 20 })
		// 只给了这一项：其余三项仍是 pass=null + skipped，只有这一项是真正的判定
		assert.equal(short.checks.filter((c) => c.pass !== null).length, 1)
		assert.equal(short.checks.filter((c) => c.pass === null && c.skipped === true).length, 3)
		assert.equal(findCheck(short, name).pass, false)
		assert.equal(short.marginsMs.forceTimeout, -15)
		assert.ok(short.warnings.some((w) => w.includes('确保')), '应说明"只有 ≥ 35 ms 才能确保"')

		const enough = dispatch({ action: 'timing', force_timeout_hold_ms: 40 })
		assert.equal(findCheck(enough, name).pass, true)
		assert.equal(enough.marginsMs.forceTimeout, 5)
		assert.equal(enough.warnings.length, 0)
	})

	test('超时缺输入：未实测的量必须标 pass=null + skipped，而不是当成 0 或猜一个值', () => {
		const r = dispatch({ action: 'timing', bus_speed_hz: 400000 })
		assert.equal(r.checks.length, 3)
		assert.ok(
			r.checks.every((c) => c.pass === null && c.skipped === true),
			'三项都应是"没数据"而不是"不通过"',
		)
		assert.equal(r.warnings.length, 0, '缺数据不该产生 warning')
		assert.ok(r.notes.length >= 4)
		assert.ok(r.notes.some((n) => n.includes('maxClockLowMs')))
		assert.ok(r.notes.some((n) => n.includes('slaveStretchCumulativeMs')))
		assert.ok(r.notes.some((n) => n.includes('masterStretchCumulativeMs')))
		// 累计量的口径必须在 notes 里说清
		assert.ok(r.notes.some((n) => n.includes('累计')))
	})

	test('线性换算正向往返：LINEAR11 编码 0.125 @N=−4 → 0xE002；DIRECT Y=552 → 55340/4617', () => {
		// LINEAR11 写方向：器件默认指数下应还原出厂商寄存器默认值
		const l11 = dispatch({ action: 'linear', format: 'linear11', value: 0.125, exponent: -4 })
		assert.equal(l11.raw, 0xe002)
		assert.equal(l11.quantizationError, 0)
		assert.equal(l11.quantStep, 2 ** -4)
		assert.ok(l11.checks.every((c) => c.pass === true))

		// 不给指数时自动选能表示该值的最细指数（PMBus 允许任意 N）
		const auto = dispatch({ action: 'linear', format: 'linear11', value: 600 })
		assert.equal(auto.raw, 0x0258)
		assert.equal(auto.exponent, 0)

		// DIRECT 读方向
		const dec = dispatch({ action: 'linear', format: 'direct', raw: 552, ...DIRECT_VIN_COEFF })
		assert.equal(dec.mantissa, 552)
		assert.equal(dec.value, 55340 / 4617)
		assert.equal(dec.quantStep, 100 / 4617)
		assert.ok(dec.checks.every((c) => c.pass === true))
		assert.ok(Math.abs(dec.value - 11.9861) < 5e-4)
		// 偏置项确实被减掉：Y = 0 时不等于 0 V
		assert.equal(
			dispatch({ action: 'linear', format: 'direct', raw: 0, ...DIRECT_VIN_COEFF }).value,
			140 / 4617,
		)

		// DIRECT 写方向：12.0 V → Y = 553，且误差在半个台阶内
		const enc = dispatch({ action: 'linear', format: 'direct', value: 12.0, ...DIRECT_VIN_COEFF })
		assert.equal(enc.mantissa, 553)
		assert.equal(enc.raw, 553)
		assert.equal(enc.quantStep, 100 / 4617)
		assert.ok(Math.abs(enc.quantizationError) <= enc.quantStep / 2)
		assert.ok(enc.checks.every((c) => c.pass === true), '应判定为"已落到最近的格子"')
		// 量化台阶不是 2 的幂
		assert.notEqual(enc.quantStep, 2 ** Math.round(Math.log2(enc.quantStep)))

		// 量化后反解即为编码值（与 lib 的 probe 断言同一口径）
		const back = dispatch({ action: 'linear', format: 'direct', raw: enc.raw, ...DIRECT_VIN_COEFF })
		assert.equal(back.value, enc.value)
		assert.equal(directToPhysical(enc.raw, DIRECT_VIN_COEFF).value, enc.value)
	})

	/* ── ③ 负向：缺输入必须抛错点名，不许静默给默认值 ────────────── */

	test('负向：LINEAR16 缺 exponent 必须抛错并点名 VOUT_MODE（不得内置默认指数）', () => {
		assert.throws(() => dispatch({ action: 'linear', format: 'linear16', raw: 0x2666 }), /VOUT_MODE/)
		assert.throws(() => dispatch({ action: 'linear', format: 'linear16', value: 1.2 }), /VOUT_MODE/)
		// 指数越界同样抛错
		assert.throws(() => dispatch({ action: 'linear', format: 'linear16', raw: 0x2666, exponent: 20 }), /exponent/)
		// 负量走 SLINEAR16：0xFFFF @N=−9 → −1/512
		const s = dispatch({ action: 'linear', format: 'linear16', raw: 0xffff, exponent: -9, signed: true })
		assert.equal(s.mantissa, -1)
		assert.equal(s.value, -1 / 512)
		assert.equal(s.signed, true)
	})

	test('负向：DIRECT 缺系数 / m=0 必须抛错点名，不得内置任何一组系数', () => {
		assert.throws(
			() => dispatch({ action: 'linear', format: 'direct', raw: 100, m: 4617, r: -2 }),
			/b（偏置）/,
		)
		assert.throws(() => dispatch({ action: 'linear', format: 'direct', raw: 100, m: 4617, b: -140 }), /r（指数 R/)
		assert.throws(() => directToPhysical(100, { m: 0, b: 0, r: 0 }), /不能为 0/)
		// 负值合法：0xFFFF 按 16 位补码读出 Y = −1
		assert.equal(dispatch({ action: 'linear', format: 'direct', raw: 0xffff, m: 16000, b: 0, r: -3 }).mantissa, -1)
		// 方向二选一 / 参数自相矛盾都要抛错
		assert.throws(() => dispatch({ action: 'linear', format: 'linear11', raw: 1, value: 1 }), /只能给一个/)
		assert.throws(() => dispatch({ action: 'linear', format: 'linear11' }), /需要 raw/)
		assert.throws(() => dispatch({ action: 'linear', format: 'bogus', raw: 1 }), /未知的格式/)
		assert.throws(() => dispatch({ action: 'linear', format: 'linear11', value: 1e9 }), /无法用 LINEAR11 表示/)
	})

	test('负向：PEC 不符时必须报 fail + 说明后果，不得静默通过', () => {
		const r = dispatch({ action: 'pec', ...BQ2084, received_pec: 0x00 })
		const valueCheck = findCheck(r, 'PEC 校验值')
		assert.equal(valueCheck.pass, false)
		assert.equal(r.expectedPec, 0xe8)
		assert.equal(r.receivedPec, 0x00)
		assert.ok(r.warnings.some((w) => w.includes('PEC 不匹配')))
		// 只比对 CRC 值定位不了原因：没给 observed_bytes 时覆盖检查必须标 skipped
		assert.equal(findCheck(r, 'PEC 覆盖字节序列').pass, null)
		assert.equal(findCheck(r, 'PEC 覆盖字节序列').skipped, true)
		// 不给 received_pec 时不做校验判定
		assert.equal(findCheck(dispatch({ action: 'pec', ...BQ2084 }), 'PEC 校验值').pass, null)
	})

	test('负向：驱动漏掉读事务的第二个地址字节 → 覆盖检查要点出第几个字节不一致', () => {
		// 波形上是 [0x16 0x0F 0xE9 0x03]：把这次读当写事务算了 PEC
		const wrongBytes = [0x16, 0x0f, 0xe9, 0x03]
		const diag = dispatch({ action: 'pec', ...BQ2084, received_pec: 0xe8, observed_bytes: wrongBytes })
		const coverageCheck = findCheck(diag, 'PEC 覆盖字节序列')
		assert.equal(coverageCheck.pass, false)
		assert.ok(coverageCheck.detail.includes('第 3 个字节起不一致'), coverageCheck.detail)
		// 器件发出的是 0xE8，按正确覆盖算也确实是 0xE8 —— 说明错的是驱动侧的范围
		assert.equal(diag.expectedPec, 0xe8)
		assert.ok(diag.warnings.some((w) => w.includes('覆盖范围不一致')))

		// 驱动自己的覆盖是自洽的：按写事务算出一个不同的值（0xA3）
		const asWrite = dispatch({ action: 'pec', address7: 0x0b, read: false, command: 0x0f, data: [0xe9, 0x03], received_pec: 0xe8 })
		assert.equal(asWrite.expectedPec, 0xa3)
		assert.equal(findCheck(asWrite, 'PEC 校验值').pass, false)
		assert.deepEqual(asWrite.coverage, wrongBytes)
	})

	/* ── ④ 工具描述符 ───────────────────────────────────────────── */

	test('工具描述符：名称固定 pmbus_check、参数不超过 20 个、每项都有 type 与中文 description', () => {
		assert.equal(tool.name, 'pmbus_check')
		assert.equal(typeof tool.title, 'string')
		assert.ok(tool.title.length > 0)
		assert.equal(typeof tool.description, 'string')
		assert.ok(tool.description.length > 200, 'description 应足够长以说明硬约束')
		assert.equal(typeof tool.execute, 'function')
		assert.equal(typeof tool.summaryLines, 'function')

		const names = Object.keys(tool.parameters)
		assert.ok(names.length <= 20, `参数 ${names.length} 个，超过 20 个上限`)
		assert.deepEqual(names, PARAM_NAMES)
		assert.deepEqual(tool.parameters.action.enum, ['timing', 'pec', 'linear'])
		assert.equal(tool.parameters.action.required, true)

		const allowed = ['integer', 'number', 'string', 'boolean', 'array']
		for (const [key, p] of Object.entries(tool.parameters)) {
			assert.ok(allowed.includes(p.type), `${key} 的 type='${p.type}' 不在允许集合内`)
			assert.equal(typeof p.description, 'string', `${key} 缺 description`)
			assert.ok(p.description.length > 0, `${key} 的 description 为空`)
		}

		// 三个动作各自需要的键都要在参数表里
		for (const key of [
			'action',
			'max_clock_low_ms',
			'slave_stretch_ms',
			'master_stretch_ms',
			'force_timeout_hold_ms',
			'address7',
			'read',
			'command',
			'data',
			'received_pec',
			'observed_bytes',
			'format',
			'raw',
			'value',
			'exponent',
			'signed',
			'm',
			'b',
			'r',
		]) {
			assert.ok(names.includes(key), `缺少参数 ${key}`)
		}
		// 换算类的值必须是扁平整数字段，不得嵌套 object
		assert.equal(tool.parameters.raw.type, 'integer')
		assert.equal(tool.parameters.exponent.type, 'integer')
		assert.equal(tool.parameters.r.type, 'integer')
		assert.deepEqual(tool.parameters.format.enum, ['linear11', 'linear16', 'direct'])
	})

	test('三个动作的返回值都含 checks / warnings / notes，summaryLines 给出具体数值行', () => {
		const cases = [
			{ action: 'timing', max_clock_low_ms: 6, slave_stretch_ms: 12, master_stretch_ms: 1.5 },
			{ action: 'pec', ...BQ2084, received_pec: 0xe8 },
			{ action: 'linear', format: 'linear16', raw: 0x2666, exponent: -13 },
		]
		for (const args of cases) {
			const v = dispatch(args)
			assert.ok(Array.isArray(v.checks) && Array.isArray(v.warnings) && Array.isArray(v.notes), `${args.action} 缺三条 key`)
			assert.equal(v.action, args.action)
			const lines = tool.summaryLines(v)
			assert.ok(Array.isArray(lines) && lines.length > 0, `${args.action} 的 summaryLines 为空`)
			assert.ok(lines.every((l) => typeof l === 'string'))
		}

		const pecText = tool.summaryLines(dispatch({ action: 'pec', ...BQ2084, received_pec: 0xe8 })).join('\n')
		assert.ok(pecText.includes('0xE8'))
		assert.ok(pecText.includes('0x16') && pecText.includes('0x17'), '应列出两个地址字节')

		const linearText = tool.summaryLines(dispatch({ action: 'linear', format: 'linear16', raw: 0x2666, exponent: -13 })).join('\n')
		assert.ok(linearText.includes('0x2666'))
		assert.ok(linearText.includes('1.199951171875'))

		const timingText = tool.summaryLines(
			dispatch({ action: 'timing', max_clock_low_ms: 6, slave_stretch_ms: 12, master_stretch_ms: 1.5 }),
		).join('\n')
		assert.ok(timingText.includes('25') && timingText.includes('35'), '应给出 25 / 35 两条判定线')
		assert.ok(timingText.includes('13'), '应给出 tLOW:SEXT 的裕量 13 ms')

		// 未知 action 抛错；summaryLines 对空值/未知形状要安全
		assert.throws(() => dispatch({ action: 'nope' }), /未知 action/)
		assert.deepEqual(tool.summaryLines(null), [])
		assert.deepEqual(tool.summaryLines({ action: 'unknown' }), [])
	})
}
