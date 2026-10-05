/**
 * dsh-embedded-kit / lib/usb.js 的独立探针。
 *
 * 直接跑：`node probe/usb.probe.mjs`
 *
 * 做三件事：
 *   ① 打印本模块**联网核实过的规范基准**（最大包大小表、带宽保留比例、高带宽端点
 *      编码、包间延迟区间、规范第 5 章参考吞吐表），并逐条断言，防止实现漂移；
 *   ② 用位级模型**回算规范第 5 章公布的结论**（FS 批量 19 个事务/帧、
 *      HS 批量 13 个事务/微帧、HS 同步 3×1024），证明开销模型没走偏；
 *   ③ 跑几个真实用例：
 *      - HS 摄像头同步端点 + 中断端点的组合能否装进一个微帧；
 *      - 再加一个批量端点后批量还剩多少带宽；
 *      - 过订阅（装不下）与非法高带宽描述符的对照；
 *      - FIFO 单/双缓冲对可达吞吐的影响。
 *
 * 本脚本不依赖任何 npm 包，也不改动任何库文件（只 import）。
 */

import {
	analyzeUsbBandwidth,
	bIntervalToInterval,
	checkHighBandwidth,
	controlTransferBits,
	encodeWMaxPacketSize,
	estimatePeriodicEndpoint,
	fifoServiceLimit,
	fitEndpointsInFrame,
	frameBudget,
	parseWMaxPacketSize,
	packetBits,
	sofBitsPerFrame,
	transactionBits,
	BANDWIDTH_POLICY,
	HIGH_BANDWIDTH_ENCODING,
	INTER_PACKET_GAP_BITS,
	MAX_PACKET_SIZE,
	SPEC_THROUGHPUT_REFERENCE,
	USB_SPEEDS,
} from '../lib/usb.js'

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
	console.log(`\n=== ${title} ===`)
}

/**
 * 极简表格打印。
 *
 * @param {string[]} header - 表头。
 * @param {Array<Array<string|number>>} rows - 行。
 */
function table(header, rows) {
	const widths = header.map((h, i) => Math.max(String(h).length, ...rows.map((r) => String(r[i]).length)))
	const line = (cells) => `  ${cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`
	console.log(line(header))
	console.log(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`)
	for (const r of rows) console.log(line(r))
}

/**
 * 打印一次分析结果的 checks/warnings/notes。
 *
 * @param {object} res - `fitEndpointsInFrame` / `analyzeUsbBandwidth` 的返回值。
 * @param {number} [indent=1] - 缩进层级。
 */
function dumpAnalysis(res, indent = 1) {
	const pad = '  '.repeat(indent)
	for (const c of res.checks) console.log(`${pad}${c.pass ? '  +' : '  x'} ${c.name}: ${c.detail}`)
	if (res.warnings.length) {
		console.log(`${pad}warnings:`)
		for (const w of res.warnings) console.log(`${pad}  ! ${w}`)
	}
	if (res.notes.length) {
		console.log(`${pad}notes:`)
		for (const n of res.notes) console.log(`${pad}  - ${n}`)
	}
}

const GAP_FS = { turnaround: 8, hostToHost: 8 } // FS：反推自规范第 5 章用例（见 lib/usb.js 头注）
const GAP_HS = { turnaround: 8, hostToHost: 88 } // HS：规范下限（EL_22 / EL_23）

// ---------------------------------------------------------------------------
section('① 联网核实的规范基准')
// ---------------------------------------------------------------------------

console.log('\n-- 最大包大小（USB 2.0 §5.5–§5.8 / §9.6.6）--')
table(
	['传输类型', 'LS', 'FS', 'HS'],
	[
		['控制', '8（固定）', '8 / 16 / 32 / 64', '64（固定）'],
		['中断', '1..8', '1..64', '1..1024'],
		['批量', '不支持', '8 / 16 / 32 / 64', '512（固定）'],
		['同步', '不支持', '1..1023', '1..1024'],
	],
)
console.log('  出处：Renesas《USB CDC Driver》Table 3.1；Zephyr udc_sam_usbhs.c 引用规范 §5.5-5.8 同表；')
console.log('        Cypress FX2 应用笔记 Table 2；Microsoft Learn 同步传输文档。')

check(
	'HS 控制固定 64 字节',
	MAX_PACKET_SIZE.high.control.allowed.length === 1 && MAX_PACKET_SIZE.high.control.allowed[0] === 64,
)
check(
	'HS 批量固定 512 字节',
	MAX_PACKET_SIZE.high.bulk.allowed.length === 1 && MAX_PACKET_SIZE.high.bulk.allowed[0] === 512,
)
check('FS 批量只允许 8/16/32/64', JSON.stringify(MAX_PACKET_SIZE.full.bulk.allowed) === '[8,16,32,64]')
check('FS 同步上限 1023（不是 1024）', MAX_PACKET_SIZE.full.isochronous.max === 1023)
check('HS 同步上限 1024', MAX_PACKET_SIZE.high.isochronous.max === 1024)
check('HS 中断上限 1024', MAX_PACKET_SIZE.high.interrupt.max === 1024)
check('LS 不支持批量', MAX_PACKET_SIZE.low.bulk === null)
check('LS 不支持同步', MAX_PACKET_SIZE.low.isochronous === null)

console.log('\n-- 带宽保留比例（USB 2.0 §5.11.3 Bus Time Rationing）--')
table(
	['速率', '帧长', '微帧长', '周期(中断+同步)上限', '控制保留', '批量保留'],
	[
		['LS', '1 ms', '—', '90%', '10%', '0（不保留）'],
		['FS', '1 ms', '—', '90%', '10%', '0（不保留）'],
		['HS', '1 ms', '125 µs × 8', '80%', '20%', '0（不保留）'],
	],
)
console.log('  出处：规范 §5.11.3 原文；Chalmers 讲义表格转自规范第 5 章；OSDev wiki "Bus Time Rationing"；')
console.log('        usbzh.com 带宽分配一文；凡亿课堂《USB2.0实际传输速度为什么与480Mbps相差甚远》。')

check('FS 周期上限 90%', BANDWIDTH_POLICY.full.periodicMaxRatio === 0.9)
check('FS 控制保留 10%', BANDWIDTH_POLICY.full.controlReservedRatio === 0.1)
check('HS 周期上限 80%', BANDWIDTH_POLICY.high.periodicMaxRatio === 0.8)
check('HS 控制保留 20%', BANDWIDTH_POLICY.high.controlReservedRatio === 0.2)
check('LS 与 FS 同策略', BANDWIDTH_POLICY.low.periodicMaxRatio === 0.9 && BANDWIDTH_POLICY.low.controlReservedRatio === 0.1)
check(
	'各速率批量都不保留带宽',
	Object.values(BANDWIDTH_POLICY).every((p) => p.bulkReservedRatio === 0),
)

console.log('\n-- 帧预算换算（比例 → 绝对时间）--')
for (const id of ['full', 'high']) {
	const b = frameBudget(id)
	console.log(
		`  ${b.label}: (微)帧 ${b.unitUs} µs | 周期上限 ${b.periodicLimitUs.toFixed(2)} µs | ` +
			`控制保留 ${b.controlReservedUs.toFixed(2)} µs | 周期占满时批量剩 ${b.bulkAvailableUs.toFixed(2)} µs | ` +
			`无周期时批量上限 ${(b.bulkAvailableRatioUpperBound * 100).toFixed(0)}%`,
	)
}
check('FS 周期上限 900 µs', frameBudget('full').periodicLimitUs === 900)
check('HS 周期上限 100 µs（80% × 125 µs）', frameBudget('high').periodicLimitUs === 100)
check('HS 控制保留 25 µs（20% × 125 µs）', frameBudget('high').controlReservedUs === 25)
check('FS 周期+控制保留恰好占满 1 ms → 批量剩余 0', frameBudget('full').bulkAvailableUs === 0)
check('HS 周期+控制保留恰好占满 125 µs → 批量剩余 0', frameBudget('high').bulkAvailableUs === 0)

console.log('\n-- HS 高带宽端点编码（wMaxPacketSize bit 12..11，规范 §9.6.6）--')
table(
	['bit 12..11', '额外事务数', '事务/微帧', 'raw 位', '单微帧上限'],
	[
		['00', 0, 1, '0x0000', '1024 B'],
		['01', 1, 2, '0x0800', '2048 B'],
		['10', 2, 3, '0x1000', '3072 B'],
		['11', '保留', '—', '—', '—'],
	],
)
console.log('  出处：Microsoft USBD_PIPE_INFORMATION 文档；Cypress FX2 应用笔记 Table 5（0x0400/0x0C00/0x1400）；')
console.log('        usbzh.com《USB 高速高带宽端点 wMaxPacketSize》。仅适用于 HS 的中断与同步。')

check('2 事务 → raw 0x0C00', encodeWMaxPacketSize({ maxPacketBytes: 1024, additionalTransactions: 1 }) === 0x0c00)
check('3 事务 → raw 0x1400', encodeWMaxPacketSize({ maxPacketBytes: 1024, additionalTransactions: 2 }) === 0x1400)
const parsed = parseWMaxPacketSize(0x1400)
check('解析 0x1400 → 1024 B × 3 事务/微帧', parsed.maxPacketBytes === 1024 && parsed.transactionsPerMicroframe === 3)
check(
	'3 × 1024 = 3072 字节/微帧',
	1024 * HIGH_BANDWIDTH_ENCODING[2].transactionsPerMicroframe === 3072,
)

console.log('\n-- 包间延迟区间（USB 2.0 §7.1.18.2 / 电气一致性 EL_22、EL_23）--')
console.log(`  总线切换（收到后应答）：≥ ${INTER_PACKET_GAP_BITS.turnaroundMin} 位时间`)
console.log(`  主机连发两个包：        ≥ ${INTER_PACKET_GAP_BITS.hostToHostMin} 位时间`)
console.log(`  两者上限均为：          ≤ ${INTER_PACKET_GAP_BITS.max} 位时间`)
console.log('  出处：USB-IF《USB 2.0 Electrical Compliance Test Specification v1.07》§3.4 EL_22 / EL_23。')
console.log('  注意：这是**区间不是定值**，实际值随主控与 Hub 变化 → 本模块作为参数暴露，不硬编码。')
check('EL_22 下限 8 位时间', INTER_PACKET_GAP_BITS.turnaroundMin === 8)
check('EL_23 下限 88 位时间', INTER_PACKET_GAP_BITS.hostToHostMin === 88)
check('上限 192 位时间', INTER_PACKET_GAP_BITS.max === 192)

// ---------------------------------------------------------------------------
section('② 位级模型 vs 规范第 5 章公布结论（校准）')
// ---------------------------------------------------------------------------

console.log('\n-- 规范第 5 章参考吞吐表（单条管道每毫秒最大字节数）--')
table(
	['速率', '传输类型', '单包字节', '事务/帧', '字节/ms'],
	[
		['FS', '控制', 64, 13, 832],
		['FS', '批量', 64, 19, 1216],
		['FS', '中断', 64, 1, 64],
		['FS', '同步', 1023, 1, 1023],
		['HS', '控制', 64, 31, 15872],
		['HS', '批量', 512, 13, 53248],
		['HS', '中断', 1024, 3, 24576],
		['HS', '同步', 1024, 3, 24576],
	],
)
console.log('  出处：Chalmers 讲义表格（转自 USB 2.0 规范第 5 章）；Microchip Developer Help《USB Frames》')
console.log('        给出 FS Bulk「up to 19 / 1.2 Mbytes/s」与 HS Bulk「up to 13 / 53 MByte/s」一致。')

// FS 批量：64 字节 OUT 事务，用规范下限 8/8 位时间间隔
const fsBulkTx = transactionBits({
	speed: 'full',
	transferType: 'bulk',
	direction: 'out',
	payloadBytes: 64,
	gapBits: GAP_FS,
})
const fsBulkCount = Math.floor((1000 * 1000) / fsBulkTx.busTimeNs)
console.log(
	`\n  FS 批量 OUT / 64 B：令牌 ${fsBulkTx.tokenBits} + 数据 ${fsBulkTx.dataBits} + 握手 ${fsBulkTx.handshakeBits} ` +
		`+ 包间 ${fsBulkTx.gapBits} = ${fsBulkTx.totalBits} 位 → ${(fsBulkTx.busTimeNs / 1000).toFixed(2)} µs/事务`,
)
console.log(`  → 1000 µs / 帧 装得下 ${fsBulkCount} 个事务（规范第 5 章：19）`)
check('模型复现 FS 批量 19 个事务/帧', fsBulkCount === SPEC_THROUGHPUT_REFERENCE.full.bulk.transactionsPerFrame, `${fsBulkCount}`)
check(
	'FS 批量吞吐 ≈ 1.216 MB/s',
	Math.abs((64 * fsBulkCount * 1000) / 1e6 - 1.216) < 0.01,
	`${((64 * fsBulkCount * 1000) / 1e6).toFixed(3)} MB/s`,
)

// HS 批量：512 字节 OUT 事务，用规范下限 8/88 位时间间隔
const hsBulkTx = transactionBits({
	speed: 'high',
	transferType: 'bulk',
	direction: 'out',
	payloadBytes: 512,
	gapBits: GAP_HS,
})
const hsBulkCount = Math.floor((125 * 1000) / hsBulkTx.busTimeNs)
console.log(
	`\n  HS 批量 OUT / 512 B：令牌 ${hsBulkTx.tokenBits} + 数据 ${hsBulkTx.dataBits} + 握手 ${hsBulkTx.handshakeBits} ` +
		`+ 包间 ${hsBulkTx.gapBits} = ${hsBulkTx.totalBits} 位 → ${(hsBulkTx.busTimeNs / 1000).toFixed(2)} µs/事务`,
)
console.log(`  → 125 µs / 微帧 装得下 ${hsBulkCount} 个事务（规范第 5 章：13）`)
console.log(`  用主机连发下限 88 位时间才能得到 13；若用 8 位时间会得到 14，与规范不符。`)
check('模型复现 HS 批量 13 个事务/微帧', hsBulkCount === SPEC_THROUGHPUT_REFERENCE.high.bulk.transactionsPerFrame, `${hsBulkCount}`)
check(
	'HS 批量吞吐 ≈ 53.248 MB/s',
	Math.abs((512 * hsBulkCount * 8000) / 1e6 - 53.248) < 0.01,
	`${((512 * hsBulkCount * 8000) / 1e6).toFixed(3)} MB/s`,
)

// HS 同步 3×1024
const hsIsoTx = transactionBits({
	speed: 'high',
	transferType: 'isochronous',
	direction: 'in',
	payloadBytes: 1024,
	gapBits: GAP_HS,
})
const isoThreeUs = (hsIsoTx.busTimeNs * 3) / 1000
console.log(
	`\n  HS 同步 IN / 1024 B（无握手）：${hsIsoTx.totalBits} 位 → ${(hsIsoTx.busTimeNs / 1000).toFixed(2)} µs/事务`,
)
console.log(
	`  高带宽 3 事务/微帧 = ${isoThreeUs.toFixed(2)} µs = 微帧的 ${((isoThreeUs / 125) * 100).toFixed(1)}% ` +
		`（< 80% 周期上限 ${(125 * 0.8).toFixed(0)} µs，所以 3 次是描述符限制而非时间限制）`,
)
check('3×1024 同步占 < 80% 微帧', isoThreeUs < 100, `${isoThreeUs.toFixed(2)} µs`)
check(
	'HS 同步 3×1024 吞吐 = 24.576 MB/s',
	Math.abs((3 * 1024 * 8000) / 1e6 - 24.576) < 0.001,
)

// 控制传输（已知不可复现，如实标注）
const hsControl = controlTransferBits({
	speed: 'high',
	dataBytes: 64,
	maxPacketBytes: 64,
	dataDirection: 'in',
	gapBits: GAP_HS,
})
const hsControlUs = (hsControl.busTimeNs / 1000) * 8
console.log(
	`\n  HS 控制（8B 建立 + 64B 数据 + 状态）：${hsControl.transactionCount} 次事务 / ${hsControl.totalBits} 位 ` +
		`→ ${hsControlUs.toFixed(2)} µs/帧`,
)
console.log(
	`  规范第 5 章给的控制参考值是 31 事务/微帧（15872 字节/ms）。位级模型算不出这个数：`,
)
console.log(
	`  64 B 事务在本模型下只有 ${(transactionBits({ speed: 'high', transferType: 'control', direction: 'out', payloadBytes: 64, gapBits: GAP_HS }).busTimeNs / 1000).toFixed(2)} µs，`,
)
console.log(`  一个微帧能塞下 60+ 次 —— 说明规范那张表的控制条目用的是**另一套口径**（按完整控制传输计，`)
console.log(`  且受主机调度策略影响），不是纯位时间约束。本模块不假装能复现它，仅作参考值列出。`)
check('控制传输往返时间可计算且为正', hsControlUs > 0, `${hsControlUs.toFixed(3)} µs`)

// ---------------------------------------------------------------------------
section('③ 真实用例 1：HS 摄像头同步端点 + 中断端点 + 批量端点')
// ---------------------------------------------------------------------------

console.log('\n场景：一个 UVC 摄像头 —— 同步 IN 端点 1024 B × 3 事务/微帧（约 24.6 MB/s 画面数据），')
console.log('      外加一个 HID 风格中断 IN 端点（64 B，每 8 微帧一次，即 1 ms），再挂一条批量通道。')
console.log('      高速模式，包间延迟取规范下限（8 / 88 位时间）。\n')

const camera = {
	name: 'cam-iso-in',
	transferType: 'isochronous',
	direction: 'in',
	maxPacketBytes: 1024,
	transactionsPerMicroframe: 3,
	intervalMicroframes: 1,
}
const hid = {
	name: 'hid-int-in',
	transferType: 'interrupt',
	direction: 'in',
	maxPacketBytes: 64,
	intervalMicroframes: 8, // 8 个微帧 = 1 ms
}

const fit1 = fitEndpointsInFrame({ speed: 'high', endpoints: [camera, hid], gapBits: GAP_HS })
console.log('  逐端点占用：')
table(
	['端点', '类型', '包字节', '事务/微帧', '字节/帧', '字节/ms', 'µs/峰值微帧'],
	fit1.endpoints.map((e) => [
		e.name,
		e.transferType,
		e.maxPacketBytes,
		e.transactionsPerMicroframe,
		Math.round(e.bytesPerFrame),
		Math.round(e.bytesPerSecond / 1000),
		e.peakSlotUs.toFixed(2),
	]),
)
console.log(`\n  各微帧周期占用（µs）：[${fit1.perMicroframeUs.map((u) => u.toFixed(1)).join(', ')}]`)
console.log(`  峰值微帧 ${fit1.periodicPeakUs.toFixed(2)} µs / 平均 ${fit1.periodicAvgUs.toFixed(2)} µs / 上限 ${fit1.periodicLimitUs.toFixed(2)} µs`)
console.log(`  批量剩余 ${fit1.bulkAvailableUs.toFixed(2)} µs = 微帧的 ${(fit1.bulkAvailableRatio * 100).toFixed(1)}%`)
console.log(`  判定：${fit1.fits ? '装得下' : '装不下'}\n`)
dumpAnalysis(fit1)

check('摄像头同步端点 24.576 MB/s', Math.abs(fit1.endpoints[0].bytesPerSecond / 1e6 - 24.576) < 0.001)
check('该组合装得进一个微帧', fit1.fits === true)
check('周期峰值未超 80% 上限', fit1.periodicPeakUs <= 100, `${fit1.periodicPeakUs.toFixed(2)} µs`)
check('批量仍剩 > 0 带宽', fit1.bulkAvailableUs > 0, `${fit1.bulkAvailableUs.toFixed(2)} µs`)
check('摄像头端点独占每个微帧（间隔 1 微帧）', Math.abs(fit1.endpoints[0].peakSlotUs - 52.05) < 0.05)

// 统一入口再跑一遍，带上控制流量与 FIFO。
const full1 = analyzeUsbBandwidth({
	speed: 'high',
	endpoints: [camera, hid],
	gapBits: GAP_HS,
	controlBytesPerFrame: 256,
	controlMaxPacketBytes: 64,
	fifo: {
		name: 'cam-iso-in',
		maxPacketBytes: 1024,
		intervalUs: 125,
		serviceLatencyUs: 200,
		buffers: 2,
		busLimitedBytesPerSecond: fit1.endpoints[0].bytesPerSecond,
	},
})
console.log('\n  -- 统一入口 analyzeUsbBandwidth（含控制流量 256 B/帧、FIFO 双缓冲）--')
console.log(`  周期已用 ${(full1.periodicUsedRatio * 100).toFixed(1)}% / 上限 ${(full1.periodicMaxRatio * 100).toFixed(0)}%`)
console.log(`  批量可用 ${(full1.bulkAvailableRatio * 100).toFixed(1)}% / 无周期时上限 ${(full1.bulkAvailableRatioUpperBound * 100).toFixed(0)}%`)
console.log(`  FIFO：可达 ${(full1.fifo.achievableBytesPerSecond / 1e6).toFixed(3)} MB/s，瓶颈 = ${full1.fifo.limitingFactor}`)
check('统一入口给出 fits 字段', full1.fits === true)
check('统一入口带出 FIFO 结论', full1.fifo !== null && full1.fifo.limitingFactor === 'bus')
check('无周期流量时 HS 批量上限 80%', Math.abs(full1.bulkAvailableRatioUpperBound - 0.8) < 1e-9)
check('所有 checks 均带 name/pass/detail', full1.checks.every((c) => c.name && typeof c.pass === 'boolean' && c.detail))

// ---------------------------------------------------------------------------
section('④ 真实用例 2：过订阅（装不下）与非法高带宽描述符')
// ---------------------------------------------------------------------------

console.log('\n场景 A：两个摄像头同步端点，各 1024 B × 3 事务/微帧，看能不能都塞进一个微帧。\n')
const cam2 = { ...camera, name: 'cam2-iso-in' }
const fit2 = fitEndpointsInFrame({ speed: 'high', endpoints: [camera, cam2], gapBits: GAP_HS })
console.log(`  周期峰值 ${fit2.periodicPeakUs.toFixed(2)} µs / 上限 ${fit2.periodicLimitUs.toFixed(2)} µs`)
console.log(`  判定：${fit2.fits ? '装得下' : '装不下'}`)
dumpAnalysis(fit2)
check('两个满配同步端点装不下', fit2.fits === false, `${fit2.periodicPeakUs.toFixed(2)} µs > ${fit2.periodicLimitUs.toFixed(2)} µs`)
check('装不下时给出告警', fit2.warnings.length > 0)
check(
	'告警里点明规范出处 §5.11.3',
	fit2.warnings.some((w) => w.includes('5.11.3')),
)

console.log('\n场景 B：一个同步端点降到 512 B × 2 事务/微帧，再叠加一个中断端点，看是否回落。\n')
const camReduced = { ...camera, name: 'cam-iso-in-512', maxPacketBytes: 512, transactionsPerMicroframe: 2 }
const fit3 = fitEndpointsInFrame({ speed: 'high', endpoints: [camReduced, hid], gapBits: GAP_HS })
console.log(`  周期峰值 ${fit3.periodicPeakUs.toFixed(2)} µs / 上限 ${fit3.periodicLimitUs.toFixed(2)} µs（原方案 ${fit1.periodicPeakUs.toFixed(2)} µs）`)
console.log(`  判定：${fit3.fits ? '装得下' : '装不下'}`)
console.log(`  批量剩余 ${fit3.bulkAvailableUs.toFixed(2)} µs（${(fit3.bulkAvailableRatio * 100).toFixed(1)}%）`)
check('降配之后装得下', fit3.fits === true)
check('降配后批量剩余更多', fit3.bulkAvailableUs > fit1.bulkAvailableUs)

console.log('\n场景 C：非法描述符 —— 给 HS 批量端点声明每微帧 2 次事务（高带宽不适用于批量）。\n')
const badBulk = checkHighBandwidth({
	speed: 'high',
	transferType: 'bulk',
	maxPacketBytes: 512,
	additionalTransactions: 1,
})
dumpAnalysis(badBulk)
check('批量高带宽被拒', badBulk.checks.some((c) => c.name === '高带宽适用范围' && c.pass === false))
check(
	'并给出告警说明仅限中断/同步',
	badBulk.warnings.some((w) => w.includes('中断与同步')),
)

console.log('\n场景 D：非法描述符 —— HS 全速端点包大小超限 / 非法取值集合。\n')
const badSize = checkHighBandwidth({
	speed: 'full',
	transferType: 'bulk',
	maxPacketBytes: 512,
})
dumpAnalysis(badSize)
check('FS 批量 512 字节被拒', badSize.checks.some((c) => c.name === '最大包大小' && c.pass === false))

const badSet = checkHighBandwidth({ speed: 'full', transferType: 'bulk', maxPacketBytes: 100 })
check(
	'FS 批量 100 字节不在 {8,16,32,64} 内被拒',
	badSet.checks.some((c) => c.name === '最大包大小取值集合' && c.pass === false),
)

console.log('\n场景 E：单微帧字节上限 —— 1024 B × 3 恰好合法，1024 B 声称 4 次事务无法编码。\n')
check('1024 × 3 = 3072 合法', checkHighBandwidth({ speed: 'high', transferType: 'isochronous', maxPacketBytes: 1024, additionalTransactions: 2 }).checks.every((c) => c.pass))
let threw = false
try {
	checkHighBandwidth({ speed: 'high', transferType: 'isochronous', maxPacketBytes: 1024, additionalTransactions: 3 })
} catch {
	threw = true
}
check('额外事务数 3 被拒绝（bit 12..11 只有 0/1/2）', threw)

// ---------------------------------------------------------------------------
section('⑤ 全速对照：FS 摄像头同步端点 + 中断端点')
// ---------------------------------------------------------------------------

console.log('\n场景：全速设备，一个同步 IN 端点 1023 B/帧（规范上限），加一个中断 IN 端点 64 B 每帧。\n')
const fsIso = {
	name: 'fs-iso-in',
	transferType: 'isochronous',
	direction: 'in',
	maxPacketBytes: 1023,
	intervalFrames: 1,
}
const fsInt = {
	name: 'fs-int-in',
	transferType: 'interrupt',
	direction: 'in',
	maxPacketBytes: 64,
	intervalFrames: 1,
}
const fitFs = fitEndpointsInFrame({ speed: 'full', endpoints: [fsIso, fsInt], gapBits: GAP_FS })
table(
	['端点', '类型', '包字节', '字节/帧', 'µs/帧', '占帧'],
	fitFs.endpoints.map((e) => [
		e.name,
		e.transferType,
		e.maxPacketBytes,
		Math.round(e.bytesPerFrame),
		e.peakSlotUs.toFixed(2),
		`${((e.peakSlotUs / 1000) * 100).toFixed(1)}%`,
	]),
)
console.log(`\n  周期峰值 ${fitFs.periodicPeakUs.toFixed(2)} µs / 上限 ${fitFs.periodicLimitUs.toFixed(2)} µs（90%）`)
console.log(`  判定：${fitFs.fits ? '装得下' : '装不下'}`)
console.log(`  （全速同步端点每个帧只能发 1 次事务，不能像 HS 那样 2~3 次/微帧）`)
check('FS 同步 1023 B/帧 吞吐 ≈ 1.023 MB/s', Math.abs(fitFs.endpoints[0].bytesPerSecond / 1e6 - 1.023) < 0.001)
check('FS 组合装得下', fitFs.fits === true)

check('FS bInterval 1 → 1 帧', bIntervalToInterval({ speed: 'full', bInterval: 1 }).intervalUs === 1000)
check('HS bInterval 1 → 1 微帧 125 µs', bIntervalToInterval({ speed: 'high', bInterval: 1 }).intervalUs === 125)
check('HS bInterval 4 → 8 微帧 = 1 ms', bIntervalToInterval({ speed: 'high', bInterval: 4 }).intervalUs === 1000)
check('HS bInterval 7 → 64 微帧 = 8 ms', bIntervalToInterval({ speed: 'high', bInterval: 7 }).intervalUs === 8000)

console.log('\n跨帧服务间隔（HS bInterval 7 → 64 微帧 = 8 ms）：端点并非每帧都被服务，占用按平均摊。\n')
const slowPoll = {
	name: 'slow-int-in',
	transferType: 'interrupt',
	direction: 'in',
	maxPacketBytes: 64,
	intervalMicroframes: 64,
}
const fitSlow = fitEndpointsInFrame({ speed: 'high', endpoints: [slowPoll], gapBits: GAP_HS })
console.log(`  服务间隔 ${fitSlow.endpoints[0].intervalFrames} 帧；每帧被服务 ${fitSlow.endpoints[0].occurrencesPerFrame} 次`)
console.log(`  字节/帧 ${fitSlow.endpoints[0].bytesPerFrame}（= 64 B / 8 帧），峰值微帧 ${fitSlow.periodicPeakUs.toFixed(3)} µs`)
check('跨帧端点记账口径标为 average', fitSlow.endpoints[0].slotAccounting === 'average')
check('跨帧端点给出平均口径说明', fitSlow.notes.some((n) => n.includes('平均')))
check('跨帧端点吞吐 = 8 KB/s', Math.abs(fitSlow.endpoints[0].bytesPerSecond - 8000) < 1, `${fitSlow.endpoints[0].bytesPerSecond}`)

// ---------------------------------------------------------------------------
section('⑥ 端点数量与 FIFO / 双缓冲对吞吐的影响')
// ---------------------------------------------------------------------------

console.log('\n-- 端点拆分的代价：同样的总载荷，拆成多个端点开销翻倍 --')
console.log('   （HS 同步 IN，包间延迟 8 位时间，每个事务的固定开销与载荷无关）--\n')
table(
	['拆分方式', '单包字节', '事务总开销比', '有效载荷占比'],
	[
		[
			'1 × 1024 B',
			1024,
			(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 1024, gapBits: GAP_HS }).totalBits / 1024).toFixed(2) + ' 位/字节',
			`${(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 1024, gapBits: GAP_HS }).payloadRatio * 100).toFixed(2)}%`,
		],
		[
			'2 × 512 B',
			512,
			(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 512, gapBits: GAP_HS }).totalBits / 512).toFixed(2) + ' 位/字节',
			`${(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 512, gapBits: GAP_HS }).payloadRatio * 100).toFixed(2)}%`,
		],
		[
			'4 × 256 B',
			256,
			(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 256, gapBits: GAP_HS }).totalBits / 256).toFixed(2) + ' 位/字节',
			`${(transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 256, gapBits: GAP_HS }).payloadRatio * 100).toFixed(2)}%`,
		],
	],
)
const t1024 = transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 1024, gapBits: GAP_HS })
const t256 = transactionBits({ speed: 'high', transferType: 'isochronous', direction: 'in', payloadBytes: 256, gapBits: GAP_HS })
check('包越小有效载荷占比越低', t256.payloadRatio < t1024.payloadRatio)
check('拆成 4 个 256 B 事务的总线上位数 > 1 个 1024 B 事务', t256.totalBits * 4 > t1024.totalBits)

console.log('\n-- SOF 占用 --')
for (const id of ['full', 'high']) {
	const perMicro = packetBits({ speed: id, kind: 'sof' })
	const perFrame = sofBitsPerFrame(id)
	const s = USB_SPEEDS[id]
	console.log(
		`  ${s.label}: SOF 包 ${perMicro} 位 × ${s.microframesPerFrame} = ${perFrame} 位/帧 ` +
			`≈ ${((perFrame * (1e9 / s.bitRateHz)) / 1000).toFixed(3)} µs/帧`,
	)
}
check('FS SOF = 8+8+16+3 = 35 位', packetBits({ speed: 'full', kind: 'sof' }) === 35)
check('HS SOF = 32+8+16+40 = 96 位（EL_55 的 40 位 EOP）', packetBits({ speed: 'high', kind: 'sof' }) === 96)
check('HS 每帧 8 个 SOF = 768 位', sofBitsPerFrame('high') === 768)

console.log('\n-- FIFO 单缓冲 vs 双缓冲（构件的服务延迟 200 µs，必须实测提供）--\n')
const FIFO_LATENCY = 200
table(
	['缓冲', '服务窗口 µs', '有效间隔 µs', 'FIFO 可达 MB/s', '总线可达 MB/s', '瓶颈'],
	[1, 2].map((buffers) => {
		const r = fifoServiceLimit({
			name: 'cam-iso-in',
			maxPacketBytes: 1024,
			intervalUs: 125,
			serviceLatencyUs: FIFO_LATENCY,
			buffers,
			busLimitedBytesPerSecond: 24.576e6,
		})
		return [
			buffers === 1 ? '单缓冲' : '双缓冲',
			r.serviceWindowUs.toFixed(1),
			r.effectiveIntervalUs.toFixed(1),
			(r.fifoBytesPerSecond / 1e6).toFixed(3),
			(24.576).toFixed(3),
			r.limitingFactor,
		]
	}),
)
const single = fifoServiceLimit({ maxPacketBytes: 1024, intervalUs: 125, serviceLatencyUs: FIFO_LATENCY, buffers: 1, busLimitedBytesPerSecond: 24.576e6 })
const double = fifoServiceLimit({ maxPacketBytes: 1024, intervalUs: 125, serviceLatencyUs: FIFO_LATENCY, buffers: 2, busLimitedBytesPerSecond: 24.576e6 })
console.log(
	`  单缓冲：服务窗口 ${single.serviceWindowUs} µs > 服务间隔 125 µs → 有效间隔被拉到 ` +
		`${single.effectiveIntervalUs} µs，FIFO 只撑到 ${(single.fifoBytesPerSecond / 1e6).toFixed(3)} MB/s（瓶颈 ${single.limitingFactor}）`,
)
console.log(
	`  双缓冲：窗口摊到 ${double.serviceWindowUs} µs ≤ 125 µs，FIFO 不再卡住 → ` +
		`${(double.fifoBytesPerSecond / 1e6).toFixed(3)} MB/s，瓶颈回到 ${double.limitingFactor}`,
)
check('单缓冲被 FIFO 卡住', single.limitingFactor === 'fifo')
check('双缓冲后瓶颈回到总线', double.limitingFactor === 'bus')
check('单缓冲给出告警', single.warnings.length > 0)
check(
	'双缓冲把吞吐从 5.12 提到 8.192 MB/s（+60%）',
	Math.abs(single.fifoBytesPerSecond / 1e6 - 5.12) < 0.001 && Math.abs(double.fifoBytesPerSecond / 1e6 - 8.192) < 0.001,
)
check('双缓冲可达吞吐 > 单缓冲', double.achievableBytesPerSecond > single.achievableBytesPerSecond)

let fifoThrew = false
try {
	fifoServiceLimit({ maxPacketBytes: 1024, intervalUs: 125, buffers: 2 })
} catch {
	fifoThrew = true
}
check('不传 serviceLatencyUs 直接报错（不内置器件默认值）', fifoThrew)

console.log('\n-- 吞吐估算的边界：NAK/重传会进一步拉低，模型不含这些 --')
const nackDemo = estimatePeriodicEndpoint({
	speed: 'high',
	transferType: 'isochronous',
	direction: 'in',
	maxPacketBytes: 1024,
	transactionsPerMicroframe: 3,
	intervalMicroframes: 1,
	gapBits: GAP_HS,
})
console.log(
	`  HS 同步 3×1024：占微帧 ${(nackDemo.shareOfMicroframe * 100).toFixed(1)}%，` +
		`估算 ${(nackDemo.bytesPerSecond / 1e6).toFixed(3)} MB/s（= 规范第 5 章的 24.576 MB/s）`,
)
check('估算吞吐与规范参考表一致', Math.abs(nackDemo.bytesPerSecond / 1e6 - 24.576) < 0.001)

// ---------------------------------------------------------------------------
section('结果')
// ---------------------------------------------------------------------------
console.log(`\n通过 ${passed} 项，失败 ${failed} 项。`)
if (failed > 0) process.exitCode = 1
