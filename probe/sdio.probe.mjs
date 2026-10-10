/**
 * dsh-embedded-kit / lib/sdio.js 的独立探针。
 *
 * 直接跑：`node probe/sdio.probe.mjs`
 *
 * 做三件事：
 *   ① 打印本模块**规范基准表**（各速度档的时钟上限 / 位宽 / 单双沿 / 信令电压、
 *      命令与响应令牌位数、数据包开销、初始化 400 kHz 上限），并逐条断言，防止实现漂移；
 *   ② 跑真实用例：
 *      - SDR50 4 位 @ 100 MHz：读 512 B 块 vs 4 KB 块的有效吞吐与效率；
 *      - 同一档下 1 位 vs 4 位（看"位宽翻 4 倍"到底翻几倍）；
 *      - eMMC HS200 vs HS400（4 KB 块）；
 *      - 多块传输怎么摊薄命令开销；
 *      - R1（48 位）vs R2（136 位）在 400 kHz 识别阶段的代价；
 *   ③ 演示两条"必须由调用方传参"的路径：不传板级实测参数时给乐观上界 + 明确告警；
 *      信号完整性判定在没有手册限值时不臆造阈值。
 *
 * 脚本里出现的板级数字（走线长度差、传播延迟、负载电容、每事务主机开销等）
 * **只是演示值**，不是模块默认值，换成你自己板子的实测值才有意义。
 *
 * 本脚本不依赖任何 npm 包，也不改动任何库文件（只 import）。
 */

import {
	analyzeSdio,
	assessSignalIntegrity,
	checkInitializationClock,
	commandPhaseClocks,
	dataPacketClocksPerBlock,
	effectiveThroughput,
	getBusMode,
	peakThroughput,
	suggestDowngrade,
	COMMAND_TOKEN_BITS,
	DATA_PACKET_OVERHEAD_CLOCKS,
	INITIALIZATION_CLOCK_MAX_HZ,
	RESPONSE_BITS,
	SD_BUS_MODES,
	SD_BUS_MODE_IDS,
} from '../lib/sdio.js'

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
 * 字节率格式化。
 *
 * @param {number} bps - 字节/秒。
 * @returns {string} 人类可读字符串。
 */
function mbps(bps) {
	return `${(bps / 1e6).toFixed(3)} MB/s`
}

/**
 * 按显示宽度右填充（CJK 算 2 列），保证表格列对齐。
 *
 * @param {string} s - 文本。
 * @param {number} width - 目标显示宽度。
 * @returns {string} 补齐后的文本。
 */
function padRight(s, width) {
	let w = 0
	for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
	return s + ' '.repeat(Math.max(1, width - w))
}

/**
 * 打印一次 effectiveThroughput / analyzeSdio 的结果摘要。
 *
 * @param {string} label - 用例名。
 * @param {object} r - 结果。
 */
function dumpCase(label, r) {
	console.log(`\n-- ${label}`)
	console.log(
		`   档位 ${r.modeLabel}（${r.mode}，${r.signalingV} V，${r.busWidth} 位，` +
			`${r.edgesPerClock === 2 ? '双沿' : '单沿'}）  块 ${r.blockBytes} B × ${r.blocks} 块  ${r.responseType}(${r.responseBits} 位)`,
	)
	console.log(`   理论峰值  ${mbps(r.peakBytesPerSecond)}`)
	console.log(`   有效吞吐  ${mbps(r.effectiveBytesPerSecond)}   效率 ${r.efficiencyPercent.toFixed(1)}%`)
	console.log(
		`   时间账    ${(r.totalNs / 1000).toFixed(2)} µs = 命令 ${(r.cmdNs / 1000).toFixed(2)}` +
			` + 数据 ${(r.dataNs / 1000).toFixed(2)} + 忙等 ${(r.busyTotalNs / 1000).toFixed(2)}` +
			` + 块间 ${(r.gapTotalNs / 1000).toFixed(2)} + 主机 ${(r.hostOverheadNs / 1000).toFixed(2)} µs`,
	)
	console.log(`   命令占事务时间 ${r.cmdSharePercent.toFixed(1)}%`)
	for (const w of r.warnings) console.log(`   [warn] ${w}`)
}

// ---------------------------------------------------------------------------
section('① 规范基准表（lib/sdio.js 内置的常量与出处）')
// ---------------------------------------------------------------------------

console.log(`
出处：
  [SD]   SD Association, SD Specifications Part 1 Physical Layer Simplified Specification
         （Ver 3.01 / 4.10 / 7.10）—— 速度档表、令牌长度、CRC16、f_OD 400 kHz
  [SDIO] SD Specifications Part E1 SDIO Simplified Specification 2.1
  [eMMC] JEDEC JESD84（JESD84-B50/B51）Bus Speed Mode 表，经 NXP / Etron / RS 器件手册转述
  [NXP]  NXP i.MX 参考手册 MMC/SD 时序章节（低速 400 kHz、SD f_PP 25/50 MHz、MMC 20/52 MHz）
`)

console.log('档位 id             家族   时钟上限      位宽     采样   信令    总线速率(算术口径)')
console.log('-'.repeat(94))
for (const id of SD_BUS_MODE_IDS) {
	const m = SD_BUS_MODES[id]
	console.log(
		padRight(m.id, 20) +
			padRight(m.family, 7) +
			padRight(`${(m.clockMaxHz / 1e6).toFixed(3)} MHz`, 14) +
			padRight(`${m.busWidths.join('/')} 位`, 8) +
			padRight(m.edgesPerClock === 2 ? '双沿' : '单沿', 8) +
			padRight(`${m.signalingV} V`, 8) +
			`${m.maxBusMBps} MB/s`,
	)
}

console.log('\n逐档断言 "时钟 × 位宽 × 沿数 ÷ 8 == 表中总线速率"（规范表格自洽性）：')
for (const id of SD_BUS_MODE_IDS) {
	const m = SD_BUS_MODES[id]
	const width = Math.max(...m.busWidths)
	const arith = (m.clockMaxHz * width * m.edgesPerClock) / 8 / 1e6
	check(`${id} 速率自洽`, Math.abs(arith - m.maxBusMBps) < 1e-6, `${arith} MB/s vs 表中 ${m.maxBusMBps} MB/s`)
}

console.log('\n关键规范常量：')
console.log(`  COMMAND_TOKEN_BITS             = ${COMMAND_TOKEN_BITS} 位`)
console.log(`  RESPONSE_BITS                  = ${JSON.stringify(RESPONSE_BITS)}`)
console.log(`  DATA_PACKET_OVERHEAD_CLOCKS    = ${DATA_PACKET_OVERHEAD_CLOCKS} 个时钟/块（每根 DAT 线各一份：1 起始 + 16 CRC + 1 结束）`)
console.log(`  INITIALIZATION_CLOCK_MAX_HZ    = ${INITIALIZATION_CLOCK_MAX_HZ / 1000} kHz (f_OD)`)
check('命令令牌 48 位', COMMAND_TOKEN_BITS === 48)
check('R1 响应 48 位', RESPONSE_BITS.R1 === 48)
check('R2 响应 136 位', RESPONSE_BITS.R2 === 136)
check('R3 响应 48 位', RESPONSE_BITS.R3 === 48)
check('R6 响应 48 位', RESPONSE_BITS.R6 === 48)
check('R2 比 R1 长 88 位', RESPONSE_BITS.R2 - RESPONSE_BITS.R1 === 88)
check('数据包每线开销 18 时钟', DATA_PACKET_OVERHEAD_CLOCKS === 18)
check('识别时钟上限 400 kHz', INITIALIZATION_CLOCK_MAX_HZ === 400_000)

check('SD 默认速度 25 MHz / 3.3 V', SD_BUS_MODES['sd-default-speed'].clockMaxHz === 25e6)
check('SD 高速 50 MHz / 3.3 V', SD_BUS_MODES['sd-high-speed'].clockMaxHz === 50e6)
check('SDR50 100 MHz / 1.8 V', SD_BUS_MODES.sdr50.clockMaxHz === 100e6 && SD_BUS_MODES.sdr50.requires1v8)
check('SDR104 208 MHz / 需要 tuning', SD_BUS_MODES.sdr104.clockMaxHz === 208e6 && SD_BUS_MODES.sdr104.requiresTuning)
check('DDR50 50 MHz 双沿', SD_BUS_MODES.ddr50.clockMaxHz === 50e6 && SD_BUS_MODES.ddr50.edgesPerClock === 2)
check('eMMC legacy 26 MHz', SD_BUS_MODES['emmc-legacy'].clockMaxHz === 26e6)
check('eMMC 高速 52 MHz', SD_BUS_MODES['emmc-high-speed-sdr'].clockMaxHz === 52e6)
check('eMMC HS200 200 MHz 单沿', SD_BUS_MODES.hs200.clockMaxHz === 200e6 && SD_BUS_MODES.hs200.edgesPerClock === 1)
check('eMMC HS400 200 MHz 双沿、仅 8 位', SD_BUS_MODES.hs400.edgesPerClock === 2 && SD_BUS_MODES.hs400.busWidths.join() === '8')
check('SD 高档只支持 4 位', SD_BUS_MODES.sdr104.busWidths.join() === '4')
check('UHS-I 档位都要求 1.8 V', ['sdr12', 'sdr25', 'sdr50', 'sdr104', 'ddr50'].every((k) => SD_BUS_MODES[k].requires1v8))

console.log('\n数据包开销与位宽无关（规范：每根 DAT 线各自带起始/CRC/结束）：')
for (const w of [1, 4, 8]) {
	console.log(`  ${w} 位 @ 512 B 块 → ${dataPacketClocksPerBlock(512, w)} 个时钟`)
}
check(
	'512 B 块：1 位与 8 位的开销差恰好等于净荷差',
	dataPacketClocksPerBlock(512, 1) - dataPacketClocksPerBlock(512, 8) === (512 * 8) / 1 - (512 * 8) / 8,
)
check('4 位 @ 512 B = 1024 + 18 = 1042', dataPacketClocksPerBlock(512, 4) === 1042)

// ---------------------------------------------------------------------------
section('② 真实用例 A：SDR50 4 位 @ 100 MHz —— 512 B 块 vs 4 KB 块')
// ---------------------------------------------------------------------------

console.log(`
场景：UHS-I SDR50，4 位总线，100 MHz，单块读（CMD17/CMD18 + R1）。
先说"纯规范边界"（不传任何板级开销 → 模块会给乐观上界告警）：`)

const sdr50Base = { mode: 'sdr50', clockHz: 100e6, busWidth: 4, direction: 'read', responseType: 'R1' }
const a512 = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1 })
const a4k = effectiveThroughput({ ...sdr50Base, blockBytes: 4096, blocks: 1 })
dumpCase('SDR50 512 B（未传板级开销）', a512)
dumpCase('SDR50 4 KB（未传板级开销）', a4k)
check('512 B 效率低于 4 KB', a512.efficiencyPercent < a4k.efficiencyPercent, `${a512.efficiencyPercent.toFixed(1)}% < ${a4k.efficiencyPercent.toFixed(1)}%`)
check('未传忙等待/块间/主机开销时有明确说明', a512.notes.some((n) => n.includes('未提供 busy_wait_ns')))

console.log(`
再给上板级实测参数（下面这些数字是**演示值**，必须换成你板子的实测数）：
每事务主机/DMA 开销 3000 ns，相邻块间空隙 300 ns。`)

/** 演示用的板级实测参数——仅为跑通示例，不代表任何器件的真实值。 */
const BOARD = { hostOverheadNs: 3000, interBlockGapNs: 300 }

const b512 = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1, ...BOARD })
const b4k = effectiveThroughput({ ...sdr50Base, blockBytes: 4096, blocks: 1, ...BOARD })
dumpCase('SDR50 512 B（含板级开销）', b512)
dumpCase('SDR50 4 KB（含板级开销）', b4k)
console.log(
	`\n   >> 512 B 效率 ${b512.efficiencyPercent.toFixed(1)}% vs 4 KB 效率 ${b4k.efficiencyPercent.toFixed(1)}%；` +
		`绝对吞吐 ${mbps(b512.effectiveBytesPerSecond)} vs ${mbps(b4k.effectiveBytesPerSecond)}`,
)
check('含开销后 512 B 效率仍低于 4 KB', b512.efficiencyPercent < b4k.efficiencyPercent)
check('4 KB 的有效吞吐高于 512 B', b4k.effectiveBytesPerSecond > b512.effectiveBytesPerSecond)
check('512 B 效率跌破 80%，命中开销归因告警', b512.warnings.some((w) => w.includes('有效效率只有')))
check('4 KB 效率正常，不触发该告警', !b4k.warnings.some((w) => w.includes('有效效率只有')))

console.log('\n换个角度：4096 B 的数据量，用 8 × 512 B 多块传输 vs 1 × 4 KB 单块，哪个划算？')
const multi8 = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 8, ...BOARD })
const multi8NoGap = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 8, hostOverheadNs: 3000, interBlockGapNs: 0 })
console.log(
	`   8 × 512 B（多块，块间空隙 300 ns）：${mbps(multi8.effectiveBytesPerSecond)}  效率 ${multi8.efficiencyPercent.toFixed(1)}%` +
		'（命令只付一次，块间空隙付 7 次）',
)
console.log(`   8 × 512 B（多块，块间空隙按 0）：${mbps(multi8NoGap.effectiveBytesPerSecond)}  效率 ${multi8NoGap.efficiencyPercent.toFixed(1)}%`)
console.log(`   1 × 4 KB（单块）              ：${mbps(b4k.effectiveBytesPerSecond)}  效率 ${b4k.efficiencyPercent.toFixed(1)}%`)
console.log(
	`\n   >> 即使把块间空隙清零，1 × 4 KB 仍略优：每块固定带 ${DATA_PACKET_OVERHEAD_CLOCKS} 个时钟的` +
		'起始/CRC/结束开销（每根 DAT 线各一份），8 块就付 8 次。' +
		'"大块少事务"比"多块小事务"更省。',
)
check('多块只付一次命令开销，但仍打不过单块 4 KB（块内 CRC 开销 ×8）', b4k.effectiveBytesPerSecond > multi8NoGap.effectiveBytesPerSecond)
check('块间空隙越大，多块方案越吃亏', multi8.effectiveBytesPerSecond < multi8NoGap.effectiveBytesPerSecond)
check('块内开销不随块数摊薄：8×512B 的块内开销是 1×4KB 的 8 倍', 8 * DATA_PACKET_OVERHEAD_CLOCKS === 144)

// ---------------------------------------------------------------------------
section('③ 真实用例 B：同一档位下 1 位 vs 4 位（看"位宽 ×4"到底 ×几）')
// ---------------------------------------------------------------------------

const hsBase = { mode: 'sd-high-speed', clockHz: 50e6, direction: 'read', responseType: 'R1', ...BOARD }
const w1 = effectiveThroughput({ ...hsBase, busWidth: 1, blockBytes: 512, blocks: 1 })
const w4 = effectiveThroughput({ ...hsBase, busWidth: 4, blockBytes: 512, blocks: 1 })
dumpCase('SD 高速 50 MHz / 1 位 / 512 B', w1)
dumpCase('SD 高速 50 MHz / 4 位 / 512 B', w4)
const ratio = w4.effectiveBytesPerSecond / w1.effectiveBytesPerSecond
console.log(
	`\n   >> 4 位相对 1 位的实测比值 = ${ratio.toFixed(2)}×，理论峰值比是 ` +
		`${(w4.peakBytesPerSecond / w1.peakBytesPerSecond).toFixed(2)}×。` +
		'差的这一截来自命令/主机开销与每线 18 时钟的 CRC 开销——它们不随位宽摊薄。',
)
check('4 位有效吞吐高于 1 位', w4.effectiveBytesPerSecond > w1.effectiveBytesPerSecond)
check('有效吞吐比值 < 理论峰值比值 4×', ratio < 4, `${ratio.toFixed(2)}×`)

// ---------------------------------------------------------------------------
section('④ 真实用例 C：eMMC HS200 vs HS400（8 位，200 MHz，4 KB 块）')
// ---------------------------------------------------------------------------

const mmcBase = { busWidth: 8, clockHz: 200e6, direction: 'read', responseType: 'R1', blockBytes: 4096, blocks: 1, ...BOARD }
const hs200 = effectiveThroughput({ ...mmcBase, mode: 'hs200' })
const hs400 = effectiveThroughput({ ...mmcBase, mode: 'hs400' })
dumpCase('eMMC HS200 单沿 200 MHz', hs200)
dumpCase('eMMC HS400 双沿 200 MHz', hs400)
console.log(
	`\n   >> 同样 200 MHz、同样 8 位：HS400 靠双沿把峰值从 ${mbps(hs200.peakBytesPerSecond)} 提到 ` +
		`${mbps(hs400.peakBytesPerSecond)}；有效吞吐 ${mbps(hs400.effectiveBytesPerSecond)}（效率 ` +
		`${hs400.efficiencyPercent.toFixed(1)}%）。这里每事务 3 µs 的固定主机开销开始主导——` +
		'总线越快，固定开销的相对占比越大，"换更快的档"不一定能把吞吐同比例换回来。',
)
check('HS400 峰值是 HS200 的 2 倍', Math.abs(hs400.peakBytesPerSecond / hs200.peakBytesPerSecond - 2) < 1e-9)
check('HS400 有效吞吐高于 HS200', hs400.effectiveBytesPerSecond > hs200.effectiveBytesPerSecond)
check('HS400 吞吐提升不到 2 倍（固定开销吃掉了差额）', hs400.effectiveBytesPerSecond / hs200.effectiveBytesPerSecond < 2)
check('HS200 提示读方向需要 tuning', hs200.notes.some((n) => n.includes('tuning')))
check('HS400 提示 Data Strobe 与仅 8 位', hs400.notes.some((n) => n.includes('Data Strobe')))

const hs400x4 = effectiveThroughput({ ...mmcBase, mode: 'hs400', busWidth: 4 })
console.log(`\n   HS400 配 4 位总线的判定：pass=${hs400x4.checks[0].pass} — ${hs400x4.checks[0].detail}`)
check('HS400 用 4 位被判定为不合法', hs400x4.checks[0].pass === false)
check('HS400 用 4 位给出告警', hs400x4.warnings.length > 0)

const overclock = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1, clockHz: 200e6 })
check('SDR50 跑 200 MHz 被判超限', overclock.checks[1].pass === false && overclock.warnings.length > 0)

// ---------------------------------------------------------------------------
section('⑤ R1（48 位）vs R2（136 位）：差 88 位，代价在哪里？')
// ---------------------------------------------------------------------------

const c1 = commandPhaseClocks('R1')
const c2 = commandPhaseClocks('R2')
const c6 = commandPhaseClocks('R6')
console.log(`  R1：${c1.commandBits} + ${c1.responseBits} = ${c1.totalClocks} 个时钟`)
console.log(`  R2：${c2.commandBits} + ${c2.responseBits} = ${c2.totalClocks} 个时钟（CMD2/CMD9/CMD10 的 CID/CSD）`)
console.log(`  R6：${c6.commandBits} + ${c6.responseBits} = ${c6.totalClocks} 个时钟`)
check('R2 比 R1 多用 88 个时钟', c2.totalClocks - c1.totalClocks === 88)

console.log('\n识别阶段（f_OD = 400 kHz）单条命令的绝对代价：')
for (const [name, bits] of [['R1', RESPONSE_BITS.R1], ['R2', RESPONSE_BITS.R2]]) {
	console.log(`  ${name}：(${COMMAND_TOKEN_BITS} + ${bits}) / 400 kHz = ${((COMMAND_TOKEN_BITS + bits) / 400e3 * 1e6).toFixed(0)} µs`)
}
check('识别阶段 R2 单条要 460 µs', Math.abs(((48 + 136) / 400e3) * 1e6 - 460) < 1e-6)

console.log('\n同样 88 位差，在高时钟 + 大块下几乎看不见：')
const r1_512 = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1, responseType: 'R1', ...BOARD })
const r2_512 = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1, responseType: 'R2', ...BOARD })
const r1_4k = effectiveThroughput({ ...sdr50Base, blockBytes: 4096, blocks: 1, responseType: 'R1', ...BOARD })
const r2_4k = effectiveThroughput({ ...sdr50Base, blockBytes: 4096, blocks: 1, responseType: 'R2', ...BOARD })
console.log(`  SDR50 512 B：R1 效率 ${r1_512.efficiencyPercent.toFixed(1)}% → R2 效率 ${r2_512.efficiencyPercent.toFixed(1)}%`)
console.log(`  SDR50 4 KB ：R1 效率 ${r1_4k.efficiencyPercent.toFixed(1)}% → R2 效率 ${r2_4k.efficiencyPercent.toFixed(1)}%`)
check('512 B 时 R2 明显拖低效率', r2_512.efficiencyPercent < r1_512.efficiencyPercent)
check('4 KB 时 R2 的影响远小于 512 B', r1_4k.efficiencyPercent - r2_4k.efficiencyPercent < r1_512.efficiencyPercent - r2_512.efficiencyPercent)

// ---------------------------------------------------------------------------
section('⑥ 初始化阶段的限速（f_OD ≤ 400 kHz）')
// ---------------------------------------------------------------------------

const okInit = checkInitializationClock({ clockHz: 400e3 })
const badInit = checkInitializationClock({ clockHz: 25e6 })
console.log(`  400 kHz：pass=${okInit.checks[0].pass} — ${okInit.checks[0].detail}`)
console.log(`   说明：${okInit.notes[0]}`)
console.log(`  25 MHz ：pass=${badInit.checks[0].pass} — ${badInit.checks[0].detail}`)
console.log(`   告警：${badInit.warnings[0]}`)
check('识别阶段 400 kHz 通过', okInit.checks[0].pass === true)
check('识别阶段 25 MHz 不通过', badInit.checks[0].pass === false)
check('告警里点出了"有的卡能认、有的卡认不到"这类偶发现象', badInit.warnings[0].includes('偶发'))

const viaAnalyze = analyzeSdio({ ...sdr50Base, blockBytes: 4096, blocks: 1, ...BOARD, identificationClockHz: 25e6 })
console.log(`\n  通过 analyze_sdio 一并检查：checks 共 ${viaAnalyze.checks.length} 条，告警 ${viaAnalyze.warnings.length} 条`)
check('analyzeSdio 带出识别阶段告警', viaAnalyze.warnings.some((w) => w.includes('超过 f_OD 上限')))
check('analyzeSdio 不含识别参数时给出提醒', analyzeSdio({ ...sdr50Base, blockBytes: 4096, blocks: 1 }).notes.some((n) => n.includes('identification_clock_hz')))

// ---------------------------------------------------------------------------
section('⑦ 信号完整性：给限值才判定，不给限值绝不臆造阈值')
// ---------------------------------------------------------------------------

const noLimits = assessSignalIntegrity({ mode: 'sdr104', busWidth: 4 })
console.log('  只给档位（不传任何手册限值）：')
console.log(`   checks=${noLimits.checks.length} 条（0 条 = 不做判定），warnings=${noLimits.warnings.length} 条`)
for (const n of noLimits.notes) console.log(`   · ${n}`)
check('不给限值时不产生 checks', noLimits.checks.length === 0)
check('不给限值时明确说明不判定', noLimits.notes.some((n) => n.includes('不做偏斜判定')))

console.log('\n  给上限值（数字仍是演示值，须换成你 SoC 手册里的数）：')
const withLimits = assessSignalIntegrity({
	mode: 'sdr104',
	busWidth: 4,
	propagationPsPerMm: 6.6,
	traceMismatchMm: 5,
	maxSkewPs: 30,
	loadPf: 25,
	maxLoadPf: 20,
})
for (const c of withLimits.checks) console.log(`   ${c.pass ? '[ ok ]' : '[FAIL]'} ${c.name} — ${c.detail}`)
for (const w of withLimits.warnings) console.log(`   [warn] ${w}`)
console.log(`   降档建议：${withLimits.suggestedDowngrade}（${SD_BUS_MODES[withLimits.suggestedDowngrade].label}）`)
check('偏斜超限被判不合格', withLimits.checks[0].pass === false)
check('负载超限被判不合格', withLimits.checks[1].pass === false)
check('给出降档建议（同家族内），sdr104 → sdr50', withLimits.suggestedDowngrade === 'sdr50')

const goodSi = assessSignalIntegrity({
	mode: 'sdr50',
	busWidth: 4,
	propagationPsPerMm: 6.6,
	traceMismatchMm: 1,
	maxSkewPs: 50,
	loadPf: 15,
	maxLoadPf: 20,
})
check('余量充足时全部通过', goodSi.checks.every((c) => c.pass) && goodSi.warnings.length === 0)

const chain = []
for (let cur = 'sdr104'; cur !== null; ) {
	chain.push(cur)
	cur = suggestDowngrade(cur)
}
console.log(`\n  SD 家族降档链：${chain.join(' → ')} →（已是最低档）`)
console.log(`  eMMC 家族降档链：hs400 → ${suggestDowngrade('hs400')} → ${suggestDowngrade('hs200')} → ${suggestDowngrade('emmc-high-speed-sdr')}`)
check('SD 家族最低档不再降', suggestDowngrade('sd-default-speed') === null)
check('eMMC 家族最低档不再降', suggestDowngrade('emmc-legacy') === null)
check('降档不会跨家族（SDR104 退到同为 SD 家族的 SDR50）', chain[1] === 'sdr50' && !chain.includes('emmc-high-speed-ddr'))

// ---------------------------------------------------------------------------
section('⑧ 不内置器件/板级默认值（该报错就报错，该提醒就提醒）')
// ---------------------------------------------------------------------------

let threwUnknownMode = false
try {
	getBusMode('sd-ultra-9000')
} catch {
	threwUnknownMode = true
}
check('未知档位直接报错', threwUnknownMode)

let threwBadEdge = false
try {
	peakThroughput({ clockHz: 100e6, busWidth: 4, edgesPerClock: 3 })
} catch {
	threwBadEdge = true
}
check('沿数不是 1/2 直接报错', threwBadEdge)

let threwBadResponse = false
try {
	commandPhaseClocks('R99')
} catch {
	threwBadResponse = true
}
check('未知响应类型直接报错', threwBadResponse)

let threwBadWidth = false
try {
	effectiveThroughput({ mode: 'sdr50', clockHz: 100e6, busWidth: 0, blockBytes: 512 })
} catch {
	threwBadWidth = true
}
check('位宽为 0 直接报错', threwBadWidth)

const noBoard = effectiveThroughput({ ...sdr50Base, blockBytes: 512, blocks: 1 })
check('未传 busy_wait_ns 时按 0 计并说明', noBoard.busyTotalNs === 0 && noBoard.notes.some((n) => n.includes('未提供 busy_wait_ns')))
check('明确标注结果是乐观上界', noBoard.notes.some((n) => n.includes('乐观上界')))
check('峰值对 SDR50 4 位 100 MHz = 50 MB/s', Math.abs(noBoard.peakBytesPerSecond / 1e6 - 50) < 1e-9)
check(
	'peakThroughput 与 effectiveThroughput 的峰值口径一致',
	Math.abs(peakThroughput({ clockHz: 100e6, busWidth: 4 }).bytesPerSecond - noBoard.peakBytesPerSecond) < 1e-9,
)

// ---------------------------------------------------------------------------
section('结果')
// ---------------------------------------------------------------------------
console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`)
if (failed > 0) process.exitCode = 1
