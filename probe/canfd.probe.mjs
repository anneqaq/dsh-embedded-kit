/**
 * dsh-embedded-kit / lib/canfd.js 的独立探针。
 *
 * 直接跑：`node probe/canfd.probe.mjs`
 *
 * 做两件事：
 *   ① 打印本模块**联网核实过的规范基准向量**（DLC 映射表、CRC 17/21 分界、CRC 多项式、
 *      CRC 场固定填充位个数、BRS/CRC 界定符 mixed bit 时长）并逐条断言，防止实现漂移；
 *   ② 跑几个真实配置用例（40 MHz / 500 k / 2 M 等），打印两段位时序、采样点、BRS 切换点与整帧时长。
 *
 * 本脚本不依赖任何 npm 包，也不改动库文件。
 */

import {
	analyzeCanFdBitTiming,
	analyzeDlc,
	brsSwitchTiming,
	bytesToDlc,
	CRC_INPUT_COVERAGE,
	CRC_VARIANTS,
	dlcToBytes,
	dynamicStuffBitsWorstCase,
	estimateFrameTime,
	fixedStuffBits,
	frameLayout,
	stuffCountEncoding,
} from '../lib/canfd.js'

let passed = 0
let failed = 0

/**
 * 断言辅助：既打印也计数。
 *
 * @param {string} label - 断言说明。
 * @param {boolean} ok - 是否通过。
 * @param {string} detail - 细节。
 */
function check(label, ok, detail) {
	if (ok) passed += 1
	else failed += 1
	console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? `  →  ${detail}` : ''}`)
}

/** 打印小节标题。 */
function section(title) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 规范基准向量
// ─────────────────────────────────────────────────────────────────────────────

section('① 规范基准向量（联网核实，见 lib/canfd.js 文件头出处登记）')

console.log('\n-- DLC → 数据场字节数（出处：Vector certification / Kvaser / CiA / Beckhoff，口径一致）--')
console.log('DLC  经典 CAN    CAN FD')
const expectedFd = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]
for (let dlc = 0; dlc <= 15; dlc += 1) {
	const classic = dlcToBytes(dlc, { fd: false })
	const fd = dlcToBytes(dlc, { fd: true })
	console.log(
		`${String(dlc).padStart(3)}  ${String(classic).padStart(8)}  ${String(fd).padStart(8)}` +
			(dlc > 8 ? '   ← FD 非线性映射' : ''),
	)
	check(`DLC ${dlc} → FD ${expectedFd[dlc]} 字节`, fd === expectedFd[dlc], `实际 ${fd}`)
	check(`DLC ${dlc} → 经典 ${Math.min(dlc, 8)} 字节`, classic === Math.min(dlc, 8), `实际 ${classic}`)
}

console.log('\n-- CRC 变体与 17/21 位分界（出处：Bosch《CAN with Flexible Data-Rate》V1.0）--')
console.log(`CRC_15  0x${CRC_VARIANTS.crc15.polynomialHex.slice(2)}  ${CRC_VARIANTS.crc15.bits} 位  ${CRC_VARIANTS.crc15.appliesTo}`)
console.log(`CRC_17  0x${CRC_VARIANTS.crc17.polynomialHex.slice(2)}  ${CRC_VARIANTS.crc17.bits} 位  ${CRC_VARIANTS.crc17.appliesTo}`)
console.log(`CRC_21  0x${CRC_VARIANTS.crc21.polynomialHex.slice(2)}  ${CRC_VARIANTS.crc21.bits} 位  ${CRC_VARIANTS.crc21.appliesTo}`)
check('CRC17 多项式 = 0x3685B', CRC_VARIANTS.crc17.polynomialHex === '0x3685B')
check('CRC21 多项式 = 0x302899', CRC_VARIANTS.crc21.polynomialHex === '0x302899')
check('三者 Hamming 距离均为 6', [15, 17, 21].every((b) => CRC_VARIANTS[`crc${b}`].hammingDistance === 6))

for (const bytes of [0, 8, 12, 16, 20, 48, 64]) {
	const v = analyzeDlc({ dlc: bytesToDlc(bytes).dlc })
	// 12/16 字节走 DLC 9/10 → CRC17；20~64 字节走 DLC 11~15 → CRC21
	const wantBits = bytes <= 16 ? 17 : 21
	check(`数据场 ${bytes} 字节 → CRC${wantBits}`, v.crc.bits === wantBits, `实际 CRC${v.crc.bits}（DLC ${v.dlc}）`)
}
check(
	'16 字节用 CRC17、20 字节用 CRC21（分界处两侧）',
	analyzeDlc({ dlc: 10 }).crc.bits === 17 && analyzeDlc({ dlc: 11 }).crc.bits === 21,
	'DLC10→CRC17 / DLC11→CRC21',
)

console.log('\n-- CRC 场固定填充位（出处：ISO 11898-1:2015 §10.5，经 Linux 内核 commit 9fde4c557f78 引用核对）--')
const fsb17 = fixedStuffBits(17)
const fsb21 = fixedStuffBits(21)
console.log(`CRC17: CRC 场 = stuff count(4) + CRC(17) = ${fsb17.crcFieldBits} 位 → FSB ${fsb17.count} 个，插入位置 after [${fsb17.positionsAfter.join(', ')}]`)
console.log(`CRC21: CRC 场 = stuff count(4) + CRC(21) = ${fsb21.crcFieldBits} 位 → FSB ${fsb21.count} 个，插入位置 after [${fsb21.positionsAfter.join(', ')}]`)
console.log('公式：FSB = 1 + floor(CRC 场位数 / 4)；第 0 位表示插在 CRC 场首位之前，其余每 4 位一次，每个取前一位反值')
check('CRC17 → FSB 6 个', fsb17.count === 6, `实际 ${fsb17.count}`)
check('CRC21 → FSB 7 个', fsb21.count === 7, `实际 ${fsb21.count}`)
check('CRC17 位置 = [0,4,8,12,16,20]', JSON.stringify(fsb17.positionsAfter) === '[0,4,8,12,16,20]', JSON.stringify(fsb17.positionsAfter))
check('CRC21 位置 = [0,4,8,12,16,20,24]', JSON.stringify(fsb21.positionsAfter) === '[0,4,8,12,16,20,24]', JSON.stringify(fsb21.positionsAfter))

console.log('\n-- stuff count 编码（3 位格雷码 + 1 位偶校验，出处：ISO 11898-1:2015）--')
for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 13]) {
	const e = stuffCountEncoding(n)
	const ones = e.bits.reduce((a, b) => a + b, 0)
	console.log(`填充位 ${String(n).padStart(2)} 个 → mod8=${e.modulo8}  格雷码 ${e.grayCode.join('')}  校验 ${e.parity}  4 位 = ${e.bits.join('')}`)
	check(`stuff count ${n} 的 4 位总为偶校验`, ones % 2 === 0, `1 的个数 ${ones}`)
}
check('格雷码自洽（n ^ (n>>1)）', [0, 1, 2, 3, 4, 5, 6, 7].every((n) => {
	const g = n ^ (n >> 1)
	const e = stuffCountEncoding(n)
	return e.grayCode.join('') === g.toString(2).padStart(3, '0')
}))

console.log('\n-- 动态填充最坏个数交叉验证（出处：ISO 11898-1:2015 §10.5「含填充位」）--')
const classic8ByteRegion = 1 + 11 + 1 + 1 + 1 + 4 + 64 + 15
const worst = dynamicStuffBitsWorstCase(classic8ByteRegion)
console.log(`经典 CAN 标准帧 8 字节：动态填充区 = SOF(1)+ID(11)+RTR(1)+IDE(1)+r0(1)+DLC(4)+Data(64)+CRC(15) = ${classic8ByteRegion} 位`)
console.log(`最坏填充位 = floor((${classic8ByteRegion} − 1) / 4) = ${worst} 个；整帧最多 ${classic8ByteRegion + worst + 1 + 1 + 1 + 7} 位`)
check('最坏填充位 = 24（教材常引值）', worst === 24, `实际 ${worst}`)
check('整帧最多 132 位（教材常引值）', classic8ByteRegion + worst + 10 === 132, `实际 ${classic8ByteRegion + worst + 10}`)

console.log('\n-- BRS / CRC 界定符 mixed bit 时长（出处：NXP AMF-AUT-T3346 原文示例）--')
console.log('前提：仲裁段 500 kbit/s（位时间 2000 ns，SP 80%）、数据段 2 Mbit/s（位时间 500 ns，SP 60%）')
const nxp = brsSwitchTiming({
	arbitrationBitrate: 500_000,
	dataBitrate: 2_000_000,
	arbitrationSamplePoint: 0.8,
	dataSamplePoint: 0.6,
})
console.log(`BRS 位          = 2000 × 0.8 + 500 × (1 − 0.6) = ${nxp.brsBitNs} ns   （NXP 原文：1800 ns）`)
console.log(`CRC 界定符位    = 500 × 0.6 + 2000 × (1 − 0.8) = ${nxp.crcDelimiterBitNs} ns   （NXP 原文：700 ns）`)
check('BRS 位 = 1800 ns', nxp.brsBitNs === 1800, `实际 ${nxp.brsBitNs}`)
check('CRC 界定符位 = 700 ns', nxp.crcDelimiterBitNs === 700, `实际 ${nxp.crcDelimiterBitNs}`)

console.log('\n-- 帧结构位数定点（出处：Linux 内核 include/linux/can/length.h 的 SFF=67 / EFF=86）--')
console.log('注意：内核那 67 / 86 是**不含数据场**的固定开销（CRC21 口径），不是整帧位数。')
const sff = frameLayout({ dlc: 15 })
const eff = frameLayout({ dlc: 15, options: { extended: true } })
const sffOverhead = sff.totals.idealTotalBits - sff.dataBytes * 8
const effOverhead = eff.totals.idealTotalBits - eff.dataBytes * 8
console.log(`标准格式 11 位 ID、DLC15（64 字节）、CRC21、无动态填充：`)
console.log(`  整帧 ${sff.totals.idealTotalBits} 位 = 固定开销 ${sffOverhead} 位 + 数据场 ${sff.dataBytes * 8} 位（内核定义开销 67 位）`)
console.log(`扩展格式 29 位 ID、DLC15（64 字节）、CRC21、无动态填充：`)
console.log(`  整帧 ${eff.totals.idealTotalBits} 位 = 固定开销 ${effOverhead} 位 + 数据场 ${eff.dataBytes * 8} 位（内核定义开销 86 位）`)
console.log(`其中 标准格式：仲裁段速率 ${sff.totals.bitsByRate.arbitration} 位 / 数据段速率 ${sff.totals.bitsByRate.data} 位 / mixed ${sff.totals.bitsByRate.mixed} 位`)
check('标准格式固定开销 = 67 位（CRC21，不含数据场）', sffOverhead === 67, `实际 ${sffOverhead}`)
check('扩展格式固定开销 = 86 位（CRC21，不含数据场）', effOverhead === 86, `实际 ${effOverhead}`)
const sff16 = frameLayout({ dlc: 10 })
// CRC17 时：CRC 21→17 少 4 位、FSB 7→6 少 1 位，故开销 67 − 4 − 1 = 62
check('DLC10（CRC17 口径）标准格式固定开销 = 62 位（67 − 4 − 1）',
	sff16.totals.idealTotalBits - sff16.dataBytes * 8 === 62,
	`实际 ${sff16.totals.idealTotalBits - sff16.dataBytes * 8}`)

console.log('\n-- CRC 输入流覆盖范围（Bosch 原文：FD 含填充位 / 经典不含）--')
console.log(`经典 CAN : includesStuffBits=${CRC_INPUT_COVERAGE.classicCan.includesStuffBits}  verified=${CRC_INPUT_COVERAGE.classicCan.verified}`)
console.log(`non-ISO FD: includesStuffBits=${CRC_INPUT_COVERAGE.nonIsoCanFd.includesStuffBits}  includesStuffCount=${CRC_INPUT_COVERAGE.nonIsoCanFd.includesStuffCount}`)
console.log(`ISO FD    : includesStuffBits=${CRC_INPUT_COVERAGE.isoCanFd.includesStuffBits}  includesStuffCount=${CRC_INPUT_COVERAGE.isoCanFd.includesStuffCount}  verified=${CRC_INPUT_COVERAGE.isoCanFd.verified}`)
console.log(`  ⚠ ${CRC_INPUT_COVERAGE.isoCanFd.caveat}`)
check('经典 CAN 不计填充位、FD 计填充位（Bosch 原文）',
	CRC_INPUT_COVERAGE.classicCan.includesStuffBits === false && CRC_INPUT_COVERAGE.isoCanFd.includesStuffBits === true)

// ─────────────────────────────────────────────────────────────────────────────
// ② 真实配置用例
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 跑一个配置用例并打印两段位时序、BRS 切换点与整帧时长。
 *
 * @param {string} title - 用例标题。
 * @param {object} input - analyzeCanFdBitTiming 的入参。
 * @param {number} [dlc] - 算整帧时长用的 DLC。
 */
function runCase(title, input, dlc = 15) {
	section(`② ${title}`)
	const r = analyzeCanFdBitTiming(input)

	console.log(
		`时钟 ${r.clockHz / 1e6} MHz | 仲裁段 ${r.arbitrationBitrate / 1000} kbit/s | 数据段 ${r.dataBitrate / 1e6} Mbit/s`,
	)
	console.log(`控制器寄存器范围（limits）：${input.limits ? JSON.stringify(input.limits) : '（未提供——会出现在 warnings 里）'}\n`)

	for (const [name, seg] of [['仲裁段', r.arbitration], ['数据段', r.data]]) {
		if (!seg.best) {
			console.log(`${name}：**无可用候选**（该时钟在给定 limits 下配不出这个波特率）`)
			continue
		}
		const b = seg.best
		console.log(
			`${name} 最优候选：BRP=${b.brp} NBT=${b.nbt} tq=${b.tqNs.toFixed(2)} ns | ` +
				`Prop=${b.propSeg} PS1=${b.phaseSeg1} PS2=${b.phaseSeg2} | 采样点目标 ` +
				`${(seg.samplePointTarget * 100).toFixed(3)}% → 实际 ${b.samplePointPercent.toFixed(3)}%`,
		)
		console.log(
			`             寄存器值 BRP=${b.registers.BRP} TSEG1=${b.registers.TSEG1} TSEG2=${b.registers.TSEG2} SJW=${b.registers.SJW}` +
				`（= 功能值 − 1）| 实际波特率 ${b.actualBitrate} bit/s（误差 ${b.bitrateErrorPpm} ppm）| 候选数 ${seg.totalCandidates}`,
		)
	}

	if (r.brsSwitch) {
		const s = r.brsSwitch
		console.log(
			`\nBRS 切换点：仲裁位时间 ${s.arbitrationBitTimeNs.toFixed(1)} ns → 数据位时间 ${s.dataBitTimeNs.toFixed(1)} ns（${s.bitrateRatio.toFixed(2)}×）`,
		)
		console.log(
			`  BRS 位（mixed，仲裁→数据）= ${s.arbitrationBitTimeNs.toFixed(1)} × ${s.arbitrationSamplePoint.toFixed(4)} + ` +
				`${s.dataBitTimeNs.toFixed(1)} × (1 − ${s.dataSamplePoint.toFixed(4)}) = ${s.brsBitNs.toFixed(2)} ns`,
		)
		console.log(
			`  CRC 界定符位（mixed，数据→仲裁）= ${s.dataBitTimeNs.toFixed(1)} × ${s.dataSamplePoint.toFixed(4)} + ` +
				`${s.arbitrationBitTimeNs.toFixed(1)} × (1 − ${s.arbitrationSamplePoint.toFixed(4)}) = ${s.crcDelimiterBitNs.toFixed(2)} ns`,
		)
	}

	if (r.arbitration.best && r.data.best) {
		const ft = estimateFrameTime({
			dlc,
			arbitrationBitrate: r.arbitrationBitrate,
			dataBitrate: r.dataBitrate,
			arbitrationSamplePoint: r.arbitration.best.samplePointPercent / 100,
			dataSamplePoint: r.data.best.samplePointPercent / 100,
			options: { dynamicStuffBits: 0 },
		})
		console.log(
			`\nDLC ${dlc}（${ft.dataBytes} 字节，${ft.crc.id.toUpperCase()}）理想整帧：${ft.totals.idealTotalBits} 位 → ${ft.durationNs.toFixed(0)} ns ` +
				`（≈ ${(ft.estimatedFramesPerSecond / 1000).toFixed(1)} k 帧/秒）`,
		)
		console.log(`  最坏动态填充 ${ft.totals.worstCaseStuffBits} 个（动态填充区 ${ft.totals.stuffingRegionBits} 位）`)
	}

	console.log(`\nchecks（${r.checks.filter((c) => c.pass).length}/${r.checks.length} 通过）：`)
	for (const c of r.checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name} — ${c.detail}`)
	if (r.warnings.length > 0) {
		console.log('\nwarnings：')
		for (const w of r.warnings) console.log(`  ! ${w}`)
	} else {
		console.log('\nwarnings：（无）')
	}
	console.log(`\nnotes 条数：${r.notes.length}`)

	return r
}

const LIMITS_FD = {
	brpMax: 1024,
	tseg1TqMax: 256,
	tseg2TqMax: 128,
	sjwTqMax: 128,
	nbtMin: 8,
	nbtMax: 385,
}

// 用例 1：最常见的 40 MHz 时钟 / 500 k 仲裁 / 2 M 数据
runCase(
	'用例 1：40 MHz 时钟 / 500 k 仲裁（SP 80%）/ 2 M 数据（SP 75%）',
	{
		clockHz: 40_000_000,
		arbitrationBitrate: 500_000,
		dataBitrate: 2_000_000,
		arbitrationSamplePoint: 0.8,
		dataSamplePoint: 0.75,
		limits: LIMITS_FD,
		tdc: { enabled: true, dataBrp: 1, sspOffsetTq: 10 },
	},
	15,
)

// 用例 2：80 MHz + 实车测量报告里的真实参数
// 仲裁段 Prescaler=1 / TSEG1=126 / TSEG2=33 → 采样点 79.375%（实测 79.06%）
// 数据段 Prescaler=1 / TSEG1=31  / TSEG2=8  → 采样点 80.00%（实测 75.00%）
section('② 用例 2：80 MHz 时钟 / 500 k 仲裁 / 2 M 数据 —— 对齐实车测量报告的参数')
const realCase = analyzeCanFdBitTiming({
	clockHz: 80_000_000,
	arbitrationBitrate: 500_000,
	dataBitrate: 2_000_000,
	arbitrationSamplePoint: 0.79375,
	dataSamplePoint: 0.8,
	limits: LIMITS_FD,
	tdc: { enabled: true, dataBrp: 1 },
})
{
	const a = realCase.arbitration.best
	const d = realCase.data.best
	console.log('实车测量报告给出的参数（注意：报告里的 TSEG1/TSEG2 是**功能值**）：')
	console.log('  仲裁段：Prescaler 1, TSEG1 126, TSEG2 33 → 采样点 79.375%，实测 79.06%')
	console.log('  数据段：Prescaler 1, TSEG1 31,  TSEG2 8  → 采样点 80.00%，实测 75.00%')
	console.log('  （核算：仲裁 1+126+33 = 160 tq → 80 MHz / 160 = 500 kbit/s ✓；数据 1+31+8 = 40 tq → 2 Mbit/s ✓）')
	console.log('\n本模块反算结果（寄存器值 = 功能值 − 1）：')
	console.log(
		`  仲裁段：BRP ${a.brp}，TSEG1 ${a.registers.TSEG1}（功能值 ${a.registers.TSEG1 + 1}），` +
			`TSEG2 ${a.registers.TSEG2}（功能值 ${a.registers.TSEG2 + 1}）→ 采样点 ${a.samplePointPercent.toFixed(3)}%`,
	)
	console.log(
		`  数据段：BRP ${d.brp}，TSEG1 ${d.registers.TSEG1}（功能值 ${d.registers.TSEG1 + 1}），` +
			`TSEG2 ${d.registers.TSEG2}（功能值 ${d.registers.TSEG2 + 1}）→ 采样点 ${d.samplePointPercent.toFixed(3)}%`,
	)
	check('仲裁段复现 BRP=1 / TSEG1 功能值 126 / TSEG2 功能值 33',
		a.brp === 1 && a.registers.TSEG1 + 1 === 126 && a.registers.TSEG2 + 1 === 33,
		`实际 BRP=${a.brp} 功能 TSEG1=${a.registers.TSEG1 + 1} 功能 TSEG2=${a.registers.TSEG2 + 1}`)
	check('数据段复现 BRP=1 / TSEG1 功能值 31 / TSEG2 功能值 8',
		d.brp === 1 && d.registers.TSEG1 + 1 === 31 && d.registers.TSEG2 + 1 === 8,
		`实际 BRP=${d.brp} 功能 TSEG1=${d.registers.TSEG1 + 1} 功能 TSEG2=${d.registers.TSEG2 + 1}`)
	console.log(`\n数据段采样点(${d.samplePointPercent.toFixed(3)}%) 晚于仲裁段(${a.samplePointPercent.toFixed(3)}%) → 触发 warnings ${realCase.warnings.filter((w) => w.includes('晚于')).length} 条`)
	if (realCase.warnings.length > 0) {
		console.log('\nwarnings：')
		for (const w of realCase.warnings) console.log(`  ! ${w}`)
	}
	console.log(`\nchecks（${realCase.checks.filter((c) => c.pass).length}/${realCase.checks.length} 通过）`)
}

// 用例 3：数据段 5 Mbit/s（> 1 Mbit/s，CiA Rec.6 要求必须使能 TDC）
runCase(
	'用例 3：80 MHz 时钟 / 1 M 仲裁（SP 80%）/ 5 M 数据（SP 70%）—— 数据段 >1 Mbit/s 必须开 TDC',
	{
		clockHz: 80_000_000,
		arbitrationBitrate: 1_000_000,
		dataBitrate: 5_000_000,
		arbitrationSamplePoint: 0.8,
		dataSamplePoint: 0.7,
		limits: LIMITS_FD,
		tdc: { enabled: false },
	},
	13,
)

// 用例 4：时钟不够快时数据段根本配不出来——这是硬结论，不是「参数没调好」
section('② 用例 4：20 MHz 时钟 / 1 M 仲裁 / 5 M 数据 —— 时钟不够，数据段无解')
{
	const r = analyzeCanFdBitTiming({
		clockHz: 20_000_000,
		arbitrationBitrate: 1_000_000,
		dataBitrate: 5_000_000,
		arbitrationSamplePoint: 0.8,
		dataSamplePoint: 0.7,
		limits: LIMITS_FD,
		tdc: { enabled: true, dataBrp: 1 },
	})
	console.log(`clock / dataBitrate = ${20_000_000 / 5_000_000} → 每个数据位最多只有 4 个时钟周期`)
	console.log(`而 limits.nbtMin = ${LIMITS_FD.nbtMin}，结构下限也要求 NBT ≥ 4 tq → 无解`)
	console.log(`仲裁段候选 ${r.arbitration.totalCandidates} 组，数据段候选 ${r.data.totalCandidates} 组`)
	check('20 MHz 配 5 Mbit/s 数据段确实无解（会明确报出）', r.data.totalCandidates === 0,
		`数据段候选数 ${r.data.totalCandidates}`)
	const hitWarn = r.warnings.some((w) => w.startsWith('[数据段]') && w.includes('找不到任何组合'))
	check('无解时给出明确 warning 而不是静默返回空', hitWarn, hitWarn ? '已报出' : '未报出')
	console.log('\n数据段 warning：')
	for (const w of r.warnings.filter((w) => w.startsWith('[数据段]'))) console.log(`  ! ${w}`)
	console.log(`\nchecks（${r.checks.filter((c) => c.pass).length}/${r.checks.length} 通过）`)
}

// ─────────────────────────────────────────────────────────────────────────────
section('③ 负例：关键量缺失时必须点名，不得悄悄塞默认值')
for (const [label, fn] of [
	['缺 arbitration_sample_point', () => analyzeCanFdBitTiming({ clockHz: 40e6, arbitrationBitrate: 500e3, dataBitrate: 2e6, dataSamplePoint: 0.75 })],
	['缺 data_sample_point', () => analyzeCanFdBitTiming({ clockHz: 40e6, arbitrationBitrate: 500e3, dataBitrate: 2e6, arbitrationSamplePoint: 0.8 })],
	['缺 clock_hz', () => analyzeCanFdBitTiming({ arbitrationBitrate: 500e3, dataBitrate: 2e6, arbitrationSamplePoint: 0.8, dataSamplePoint: 0.75 })],
]) {
	try {
		fn()
		check(label, false, '没有抛错')
	} catch (err) {
		check(label, true, err.message.slice(0, 90) + (err.message.length > 90 ? '…' : ''))
	}
}
{
	const noLimits = analyzeCanFdBitTiming({
		clockHz: 40e6,
		arbitrationBitrate: 500e3,
		dataBitrate: 2e6,
		arbitrationSamplePoint: 0.8,
		dataSamplePoint: 0.75,
	})
	const hit = noLimits.warnings.some((w) => w.includes('缺少控制器位时序寄存器范围'))
	check('未提供 limits 时明确点名缺哪一项', hit, hit ? '已在 warnings 中点名' : '未点名')
	const tdcNote = noLimits.notes.some((n) => n.includes('未提供 tdc 配置'))
	check('未提供 tdc 时明确点名', tdcNote, tdcNote ? '已在 notes 中点名' : '未点名')
}

// ─────────────────────────────────────────────────────────────────────────────
section('汇总')
console.log(`断言：${passed} 通过 / ${failed} 失败`)
process.exitCode = failed === 0 ? 0 : 1
