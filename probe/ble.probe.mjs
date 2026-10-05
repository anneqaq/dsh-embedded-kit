/**
 * dsh-embedded-kit / lib/ble.js 的独立探针。
 *
 * 直接跑：`node probe/ble.probe.mjs`
 *
 * 做三件事：
 *   ① 用本模块的公式**复现公开文档里现成的包时间 / 吞吐数值**（基准向量），逐条断言，防止实现漂移；
 *   ② 拿**真实硅片实测**吞吐表对照理论值，看差多少、差在哪一层；
 *   ③ 跑几个真实用例：1M+DLE 251+7.5 ms 的吞吐、Coded S=8 的对比、广播占空比、连接参数合法性。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 基准向量的出处（编号与 lib/ble.js 文件头一致）
 * ─────────────────────────────────────────────────────────────────────────────
 *   V1  HCI（Core Spec Vol 4 Part E）LE Set Data Length：MaxTxTime 0x0148–0x0848 = 328–2120 µs
 *       —— 这是**规范自己给的** 1M + MIC 下 27 / 251 octets 的包时间，最强的自校验锚点。
 *   V2  Bluetooth SIG 博客《Higher speed: How fast can Bluetooth Core 5.0 be?》
 *       空包 10 octets = 80 µs；4.0/4.1 最大包 41 octets = 328 µs；DLE 最大包 265 octets = 2120 µs。
 *   V3  Core Spec Vol 6 Part B §2.1 / §2.2：未编码包 44–2128 µs；Coded 包 462–17040 µs；
 *       Table 2.1 的 Coded 各字段时长。
 *   V4  Silicon Labs《Throughput with Bluetooth Low Energy Technology》
 *       27 B → 708 µs → 305,080 bps；251 B → 2500 µs → 803,200 bps；通知有效载荷 → 780,800 bps。
 *   V5  Memfault《A Practical Guide to BLE Throughput》
 *       251 B 往返 2500 µs → 0.803 Mbps；2M 下 ≈1400 µs → 1.434 Mbps；
 *       11.25 ms 装 4 包 → 0.713 Mbps；12.5 ms 装 5 包 → 0.803 Mbps。
 *   V6  Goodix BLE Wiki（该文未计 MIC）2M：1048 + 44 + 300 = 1392 µs → 1402 kbps；1M → 780 kbps。
 *   V7  Ezurio DTM 应用笔记：Coded S=8、37 octets payload → 3088 µs（DTM 包无 MIC）。
 *   V8  Walsh Medical Media：ADV_IND 最大帧 47 octets @1 Mbps = 0.376 ms = 376 µs。
 *   V9  EnGenius 白皮书《Bluetooth Low-Energy 5.0 Throughput Testing》——**真实设备实测吞吐表**。
 *
 * 本脚本不依赖任何 npm 包，也不改动库文件。
 */

import {
	ADV_DELAY_MAX_MS,
	analyzeAdvertising,
	analyzeScanning,
	analyzeThroughput,
	BLE_PHY_IDS,
	checkConnectionParams,
	comparePhys,
	DEFAULT_ATT_MTU_OCTETS,
	DLE_MAX_PAYLOAD_OCTETS,
	MAX_ATT_MTU_OCTETS,
	packetCycleUs,
	packetTimeUs,
	SPEC_PACKET_TIME_BOUNDS_US,
} from '../lib/ble.js'

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

/**
 * 打印小节标题。
 *
 * @param {string} title - 标题。
 */
function section(title) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/**
 * 相对容差比较。
 *
 * @param {number} actual - 实测/算出的值。
 * @param {number} expected - 文档值。
 * @param {number} relTol - 允许的相对误差（如 0.01 = 1%）。
 * @returns {boolean} 是否在容差内。
 */
function approx(actual, expected, relTol) {
	return Math.abs(actual - expected) <= Math.abs(expected) * relTol
}

/**
 * 千比特每秒格式化。
 *
 * @param {number} bps - 比特每秒。
 * @returns {string} 形如 "780.8 kbps"。
 */
function kbps(bps) {
	return `${(bps / 1000).toFixed(1)} kbps`
}

// ═════════════════════════════════════════════════════════════════════════════
// ① 基准向量：包时间
// ═════════════════════════════════════════════════════════════════════════════

section('① 基准向量 A —— 单个包的空中时间（逐层开销模型 vs 公开文档）')

console.log(
	[
		'有没有公开的"某参数下已知吞吐"数值对？—— **有，而且不止一组**：',
		'  · 规范侧：HCI 的 MaxTxTime 上下界 328 / 2120 µs（等于 1M+MIC 下 27 / 251 octets 的包时间）',
		'  · 厂商/文档侧：Silicon Labs 的 708 µs / 2500 µs / 780,800 bps，Memfault 的 2M 1400 µs / 1.434 Mbps，',
		'    Goodix 的 2M 1392 µs / 1402 kbps，Ezurio 的 Coded S=8 DTM 3088 µs，SIG 博客的 80/328/2120 µs',
		'  · 实测侧：EnGenius 的 2M/1M/Coded S=8 实测吞吐表（见 ②）',
		'下面逐条断言。',
	].join('\n'),
)

/** 包时间基准向量：micOctets=4 表示加密连接的数据包，0 表示空包/广播/DTM 包。 */
const PACKET_VECTORS = [
	{ label: 'V1 1M / 27 octets + MIC', phy: 'le-1m', payloadOctets: 27, micOctets: 4, expect: 328, src: 'HCI MaxTxTime 下限 0x0148 = 328 µs' },
	{ label: 'V1 1M / 251 octets + MIC', phy: 'le-1m', payloadOctets: 251, micOctets: 4, expect: 2120, src: 'HCI MaxTxTime 上限 0x0848 = 2120 µs' },
	{ label: 'V2 1M / 空包 ACK', phy: 'le-1m', payloadOctets: 0, micOctets: 0, expect: 80, src: 'SIG 博客：空 PDU = 10 octets = 80 µs' },
	{ label: 'V3 2M / 空包 ACK', phy: 'le-2m', payloadOctets: 0, micOctets: 0, expect: 44, src: '规范 §2.1 未编码包下界 44 µs = 2M 空包' },
	{ label: 'V2 1M / 4.0-4.1 最大包（27+MIC）', phy: 'le-1m', payloadOctets: 31, micOctets: 0, expect: 328, src: 'SIG 博客：41 octets = 328 µs（等价于 27+MIC）' },
	{ label: 'V2 1M / DLE 最大包（251+MIC）', phy: 'le-1m', payloadOctets: 255, micOctets: 0, expect: 2120, src: 'SIG 博客：265 octets = 2120 µs' },
	{ label: 'V6 1M / 251 octets 无 MIC', phy: 'le-1m', payloadOctets: 251, micOctets: 0, expect: 2088, src: 'Goodix：TX 包 2088 µs（该文未计 MIC）' },
	{ label: 'V6 2M / 251 octets 无 MIC', phy: 'le-2m', payloadOctets: 251, micOctets: 0, expect: 1048, src: 'Goodix：TX 包 1048 µs（该文未计 MIC）' },
	{ label: 'V7 Coded S=8 / 37 octets（DTM，无 MIC）', phy: 'le-coded-s8', payloadOctets: 37, micOctets: 0, expect: 3088, src: 'Ezurio DTM：80 + 296 + (312+24+3)×8 = 3088 µs' },
	{ label: 'V3 Coded S=2 / 空包（规范下界）', phy: 'le-coded-s2', payloadOctets: 0, micOctets: 0, expect: SPEC_PACKET_TIME_BOUNDS_US.coded.min, src: '规范 §2.2：Coded 包下界 462 µs' },
	{ label: 'V3 Coded S=8 / 最大包（规范上界）', phy: 'le-coded-s8', payloadOctets: 255, micOctets: 0, expect: SPEC_PACKET_TIME_BOUNDS_US.coded.max, src: '规范 §2.2：Coded 包上界 17040 µs' },
	{ label: 'V8 1M / legacy ADV_IND（AdvA 6 + AdvData 31）', phy: 'le-1m', payloadOctets: 37, micOctets: 0, expect: 376, src: 'Walsh：47 octets 帧 @1 Mbps = 0.376 ms' },
]

for (const v of PACKET_VECTORS) {
	const got = packetTimeUs({ phy: v.phy, payloadOctets: v.payloadOctets, micOctets: v.micOctets })
	check(v.label, approx(got, v.expect, 1e-9), `${got} µs（文档 ${v.expect} µs）｜${v.src}`)
}

console.log(
	'\n说明：Coded PHY 的两个端点（462 / 17040 µs）与 DTM 的 3088 µs 都是**从规范 Table 2.1 的字段时长**推出来的，\n' +
		'本模块用 "前导码 80 + FEC block1 296 + (PDU bits + 27) × S" 三条式子同时命中三个值 —— 这是 Coded 分支的强校验。',
)

// ─────────────────────────────────────────────────────────────────────────────
// 规范原文的 2128 µs 与模型 2120 µs 的差异
// ─────────────────────────────────────────────────────────────────────────────

section('① 附：规范原文 2128 µs vs HCI MaxTxTime 2120 µs（已知不一致，本模块的取舍）')

const modelMax1m = packetTimeUs({ phy: 'le-1m', payloadOctets: 255, micOctets: 0 })
console.log(
	[
		`规范 §2.1 原文：未编码包 "take between 44 and ${SPEC_PACKET_TIME_BOUNDS_US.uncoded.max} µs"。`,
		`本模块逐字节模型给的最大包时间：${modelMax1m} µs（260 octets × 8 bits @1 Mbps）。`,
		`HCI 的 MaxTxTime 上限：${2120} µs —— 与逐字节模型**完全一致**。`,
		`两者差 ${SPEC_PACKET_TIME_BOUNDS_US.uncoded.max - modelMax1m} µs，恰好是 1M PHY 一个前导码 octet。`,
		'结论：本模块取 2120 µs（有 HCI 与 SIG 博客双重支撑），并把 2128 µs 作为已知差异记录下来，需人工复核。',
	].join('\n'),
)
check('模型最大包时间 = HCI MaxTxTime = 2120 µs', modelMax1m === 2120, `${modelMax1m} µs`)

// ═════════════════════════════════════════════════════════════════════════════
// ② 基准向量：每包周期与吞吐
// ═════════════════════════════════════════════════════════════════════════════

section('② 基准向量 B —— 包往返周期与吞吐（vs Silicon Labs / Memfault / Goodix）')

/** 周期与吞吐基准向量。throughputKind: 'll' = LL 载荷速率，'app' = 通知类应用有效数据速率。 */
const CYCLE_VECTORS = [
	{ label: 'V4 1M / 27 octets + MIC 的往返周期', phy: 'le-1m', dl: 27, mic: 4, cycle: 708, src: 'Silabs：328+150+80+150 = 708 µs' },
	{ label: 'V4 1M / 251 octets + MIC 的往返周期', phy: 'le-1m', dl: 251, mic: 4, cycle: 2500, src: 'Silabs / Memfault：2120+150+80+150 = 2500 µs' },
	{ label: 'V5 2M / 251 octets + MIC 的往返周期', phy: 'le-2m', dl: 251, mic: 4, cycle: 1400, src: 'Memfault：~1400 µs（未给精确值；本模型的 1064+150+44+150 = 1408）' },
	{ label: 'V6 2M / 251 octets 无 MIC 的往返周期', phy: 'le-2m', dl: 251, mic: 0, cycle: 1392, src: 'Goodix：1048+150+44+150 = 1392 µs' },
]

for (const v of CYCLE_VECTORS) {
	const got = packetCycleUs({ phy: v.phy, dataLenOctets: v.dl, micOctets: v.mic }).cycleUs
	// Memfault 的 1400 µs 是四舍五入值，给 1% 容差；其余要求精确命中。
	const tol = v.cycle === 1400 ? 0.01 : 1e-9
	check(v.label, approx(got, v.cycle, tol), `${got} µs（文档 ${v.cycle} µs）｜${v.src}`)
}

/** 吞吐基准向量：连续流（间隔足够长）下的上限。 */
const THROUGHPUT_VECTORS = [
	{ label: 'V4 1M / LL 载荷速率', phy: 'le-1m', dl: 27, mic: 4, bytes: 27, expect: 305080, src: 'Silabs：27 B / 708 µs = 305,080 bps' },
	{ label: 'V4 1M / LL 载荷速率（DLE 251）', phy: 'le-1m', dl: 251, mic: 4, bytes: 251, expect: 803200, src: 'Silabs：251 B / 2500 µs = 803,200 bps' },
	{ label: 'V4 1M / 通知应用有效数据（MTU=247）', phy: 'le-1m', dl: 251, mic: 4, bytes: 244, expect: 780800, src: 'Silabs：(251−4−3) B / 2500 µs = 780,800 bps' },
	{ label: 'V6 2M / 通知应用有效数据（无 MIC）', phy: 'le-2m', dl: 251, mic: 0, bytes: 244, expect: 1402000, src: 'Goodix：(244×8)/1392 µs ≈ 1402 kbps' },
]

for (const v of THROUGHPUT_VECTORS) {
	const cycle = packetCycleUs({ phy: v.phy, dataLenOctets: v.dl, micOctets: v.mic }).cycleUs
	const got = (v.bytes * 8 * 1e6) / cycle
	check(v.label, approx(got, v.expect, 0.01), `${Math.round(got)} bps（文档 ${v.expect} bps）｜${v.src}`)
}

console.log(
	'\n上面四条都是"间隔长到能无限发包"时的上限（本模块 ceilingsBps.phy）。\n' +
		'实际吞吐还要乘上"每个连接事件能塞几个包"的填充率，见下。',
)

// ─────────────────────────────────────────────────────────────────────────────
// Memfault 的"每事件包数 × 间隔"算例
// ─────────────────────────────────────────────────────────────────────────────

section('② 附：连接间隔切分（Memfault 的算例）')

// Memfault 原文："7 × (328µs Data + 150µs + 80µs ACK + 150µs) = 4.956ms"（15 ms 间隔内放 7 个包）。
// 注意 7 这个数字**不是间隔算出来的**（15 ms 其实塞得下 21 个 27 octets 包），而是 iOS 栈每事件最多发 7 个包。
const mfPackets = 7
const mfCycle = packetCycleUs({ phy: 'le-1m', dataLenOctets: 27, micOctets: 4 }).cycleUs
check(
	'V5 7 × 708 µs = 4.956 ms ≤ 15 ms（间隔本身装得下）',
	approx(mfPackets * mfCycle, 4956, 1e-9) && mfPackets * mfCycle <= 15000,
	`7 × ${mfCycle} µs = ${mfPackets * mfCycle} µs`,
)
const mfNoCap = analyzeThroughput({ phy: 'le-1m', dataLenOctets: 27, encrypted: true, connIntervalMs: 15, attMtuOctets: 23 })
const mfCapped = analyzeThroughput({
	phy: 'le-1m',
	dataLenOctets: 27,
	encrypted: true,
	connIntervalMs: 15,
	attMtuOctets: 23,
	maxPacketsPerEvent: 7,
})
check(
	'V5 同上，但按 iOS 的"每事件最多 7 包"上限 → 复现 Memfault 的 7 包',
	mfCapped.packetsPerEvent === 7 && mfNoCap.packetsPerEvent === 21,
	`不给栈上限时算得 ${mfNoCap.packetsPerEvent} 包/事件，给 maxPacketsPerEvent=7 后为 ${mfCapped.packetsPerEvent} 包`,
)
console.log(
	'  → 这条正是"理论值与实测值差在哪"的教科书例子：间隔明明够发 21 个包，栈只肯发 7 个。\n' +
		'    max_packets_per_event 是本模块**唯一必须实测**的输入，缺了它理论值会高估 3 倍。',
)

const memfaultCases = [
	{ ci: 11.25, dl: 251, mic: 4, packets: 4, note: '11.25 ms / 2500 µs → 只能装 4 个（余 1.25 ms 白扔）' },
	{ ci: 12.5, dl: 251, mic: 4, packets: 5, note: '12.5 ms / 2500 µs → 正好 5 个，利用率 100%' },
]
for (const c of memfaultCases) {
	const t = analyzeThroughput({
		phy: 'le-1m',
		dataLenOctets: c.dl,
		encrypted: c.mic === 4,
		connIntervalMs: c.ci,
		attMtuOctets: c.dl - 4,
	})
	check(
		`V5 1M / ${c.dl} octets / CI ${c.ci} ms → 每事件 ${c.packets} 包`,
		t.packetsPerEvent === c.packets,
		`本模型 ${t.packetsPerEvent} 包，填充率 ${(t.eventFillRatio * 100).toFixed(1)}%，应用吞吐 ${kbps(t.throughput.attAppBps)}｜${c.note}`,
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// 真实硅片实测对照
// ─────────────────────────────────────────────────────────────────────────────

section('③ 真实设备实测吞吐 vs 本模块理论值（EnGenius 白皮书）')

/**
 * EnGenius《Bluetooth Low-Energy 5.0 Throughput Testing》的实测表。
 * 只取标签自洽的行：该表里有几行把 "Data Length 251 bytes" 与 "DLE OFF" 写在一起，属自相矛盾，已剔除。
 */
const MEASURED = [
	{ label: '2M / MTU247 / DL251 / CI 400 ms', phy: 'le-2m', ci: 400, mtu: 247, dl: 251, measuredKbps: 1317 },
	{ label: '1M / MTU247 / DL251 / CI 400 ms', phy: 'le-1m', ci: 400, mtu: 247, dl: 251, measuredKbps: 760 },
	{ label: 'Coded S=8 / MTU247 / DL251 / CI 400 ms', phy: 'le-coded-s8', ci: 400, mtu: 247, dl: 251, measuredKbps: 57 },
	{ label: '2M / MTU247 / DL251 / CI 50 ms', phy: 'le-2m', ci: 50, mtu: 247, dl: 251, measuredKbps: 1309 },
	{ label: '2M / MTU247 / DL251 / CI 7.5 ms', phy: 'le-2m', ci: 7.5, mtu: 247, dl: 251, measuredKbps: 1047 },
]

console.log('用例'.padEnd(46) + '理论 kbps   实测 kbps   理论/实测   每事件包数   瓶颈层')
console.log('-'.repeat(104))
for (const m of MEASURED) {
	const t = analyzeThroughput({
		phy: m.phy,
		dataLenOctets: m.dl,
		encrypted: true,
		connIntervalMs: m.ci,
		attMtuOctets: m.mtu,
	})
	const theoryKbps = t.throughput.attAppBps / 1000
	const ratio = theoryKbps / m.measuredKbps
	console.log(
		m.label.padEnd(46) +
			theoryKbps.toFixed(1).padStart(9) +
			m.measuredKbps.toFixed(0).padStart(11) +
			ratio.toFixed(3).padStart(12) +
			String(t.packetsPerEvent).padStart(13) +
			'   ' +
			t.bottleneckLayer,
	)
	// 理论是上界：必须 ≥ 实测；同时不应离谱到 2 倍以上（否则公式或参数模型有问题）。
	check(
		`实测对照 ${m.label}`,
		ratio >= 1 && ratio <= 2,
		`理论/实测 = ${ratio.toFixed(3)}（理论上界，实测达 ${(100 / ratio).toFixed(0)}%）`,
	)
}
console.log(
	'\n读法：理论值是"每事件发满、零丢包、对端秒回空包 ACK"的上界，所以比值恒 ≥ 1。\n' +
		'1M/2M 大间隔下实测已达理论的 95%+（说明包时间模型是对的）；\n' +
		'Coded S=8 只有 53%（长包更容易被干扰打断，重传代价也大）；2M + 7.5 ms 只有 80%（栈每事件发不满）。',
)

// ═════════════════════════════════════════════════════════════════════════════
// ④ 真实用例
// ═════════════════════════════════════════════════════════════════════════════

section('④ 用例 1：1M PHY + DLE 251 + 连接间隔 7.5 ms')

const caseA = analyzeThroughput({
	phy: 'le-1m',
	dataLenOctets: DLE_MAX_PAYLOAD_OCTETS,
	encrypted: true,
	connIntervalMs: 7.5,
	attMtuOctets: 247,
})
console.log(
	[
		`单包 ${caseA.dataPacketUs} µs + T_IFS 150 + 空包 ACK ${caseA.ackPacketUs} + T_IFS 150 = 往返 ${caseA.cycleUs} µs`,
		`连接间隔 7500 µs / 2500 µs → 每事件 ${caseA.packetsPerEvent} 包，填充率 ${(caseA.eventFillRatio * 100).toFixed(0)}%`,
		`LL 载荷吞吐   ${kbps(caseA.throughput.llPayloadBps)}`,
		`L2CAP SDU      ${kbps(caseA.throughput.l2capSduBps)}`,
		`ATT 应用数据   ${kbps(caseA.throughput.attAppBps)}（每包 244 octets 有效）`,
		`瓶颈层         ${caseA.bottleneckLayer}`,
		`三层损失比     物理层 ${(caseA.losses.phy * 100).toFixed(1)}% / 每事件包数 ${(caseA.losses.packetsPerEvent * 100).toFixed(1)}% / MTU ${(caseA.losses.mtu * 100).toFixed(1)}%`,
	].join('\n'),
)
check(
	'7.5 ms 恰好是 2500 µs 的 3 倍 → 填充率 100%，吞吐等于连续流上限',
	approx(caseA.throughput.attAppBps, 780800, 1e-9),
	kbps(caseA.throughput.attAppBps),
)

console.log('\n把同一个 251 octets 包丢进更长的间隔，看"每事件包数"这一层：')
for (const ci of [7.5, 15, 30, 100, 400]) {
	const t = analyzeThroughput({ phy: 'le-1m', dataLenOctets: 251, encrypted: true, connIntervalMs: ci, attMtuOctets: 247 })
	console.log(
		`  CI ${String(ci).padStart(5)} ms → ${String(t.packetsPerEvent).padStart(3)} 包/事件，填充率 ${(t.eventFillRatio * 100).toFixed(1).padStart(5)}%，应用吞吐 ${kbps(t.throughput.attAppBps).padStart(12)}`,
	)
}
console.log('  → 间隔越大越接近上限（空档相对变小），但延迟同步变大；这与"间隔越小越快"的直觉相反。')

// ─────────────────────────────────────────────────────────────────────────────

section('④ 用例 2：Coded PHY S=8 对比（同一个 251 octets 包）')

const table = comparePhys(true, 251)
console.log('PHY'.padEnd(15) + '速率'.padStart(10) + '数据包 µs'.padStart(12) + '空包 µs'.padStart(10) + '往返 µs'.padStart(11) + '连续流上限'.padStart(14))
console.log('-'.repeat(76))
for (const r of table) {
	console.log(
		r.phy.padEnd(15) +
			`${(r.bitRateBps / 1000).toFixed(0)} kbps`.padStart(10) +
			r.packetUs.toFixed(0).padStart(12) +
			r.emptyPacketUs.toFixed(0).padStart(10) +
			r.cycleUs.toFixed(0).padStart(11) +
			kbps(r.ceilingAppBps).padStart(14),
	)
}
console.log('（表里是"应用层"上限，即每包 244 octets 有效数据；PHY 速率 1000/2000/500/125 kbps 是空口调制速率。）')

console.log('\nCoded S=8 在不同连接间隔下的可用性：')
for (const ci of [7.5, 20, 50, 400]) {
	const t = analyzeThroughput({ phy: 'le-coded-s8', dataLenOctets: 251, encrypted: true, connIntervalMs: ci, attMtuOctets: 247 })
	console.log(
		`  CI ${String(ci).padStart(5)} ms → ${String(t.packetsPerEvent).padStart(2)} 包/事件，填充率 ${(t.eventFillRatio * 100).toFixed(1).padStart(5)}%，应用吞吐 ${kbps(t.throughput.attAppBps).padStart(12)}` +
			(t.packetsPerEvent === 0 ? '   ← 一个包都放不下！' : t.eventFillRatio < 0.95 ? '   ← 装不满的间隔就是白扔' : ''),
	)
}
const s8At75 = analyzeThroughput({ phy: 'le-coded-s8', dataLenOctets: 251, encrypted: true, connIntervalMs: 7.5, attMtuOctets: 247 })
check(
	'Coded S=8 + 251 octets 在 7.5 ms 间隔下放不下一个包',
	s8At75.packetsPerEvent === 0 && s8At75.warnings.length > 0,
	`往返 ${s8At75.cycleUs} µs > 间隔 7500 µs`,
)
check(
	'Coded S=8 的连续流上限约为 1M 的 1/7（125 kbps vs 1 Mbps）',
	approx(table[3].ceilingAppBps / table[0].ceilingAppBps, 1 / 7, 0.06),
	`${kbps(table[3].ceilingAppBps)} / ${kbps(table[0].ceilingAppBps)} = ${(table[3].ceilingAppBps / table[0].ceilingAppBps).toFixed(3)}`,
)

console.log('\n把数据长度从 251 降到 37 octets，Coded S=8 才能塞进 7.5 ms：')
for (const dl of [251, 128, 64, 37, 27]) {
	const t = analyzeThroughput({ phy: 'le-coded-s8', dataLenOctets: dl, encrypted: true, connIntervalMs: 7.5, attMtuOctets: dl - 4 })
	console.log(
		`  DL ${String(dl).padStart(3)} octets → 往返 ${t.cycleUs.toFixed(0).padStart(6)} µs，${String(t.packetsPerEvent).padStart(2)} 包/事件，应用吞吐 ${kbps(t.throughput.attAppBps).padStart(12)}`,
	)
}

// ─────────────────────────────────────────────────────────────────────────────

section('④ 用例 3：广播占空比（legacy 31 octets vs 扩展广播）')

for (const ci of [20, 100, 1000, 10240]) {
	const a = analyzeAdvertising({ phy: 'le-1m', advIntervalMs: ci, legacy: true, channelCount: 3, advDataOctets: 31 })
	console.log(
		`  legacy ADV_IND 31 octets @CI ${String(ci).padStart(5)} ms：包 ${a.packetUs.toFixed(0)} µs，事件 ${a.eventTxUs.toFixed(0)} µs，` +
			`TX 占空比 ${a.duty.advDelay0Ms.txDutyPercent.toFixed(3)}%–${a.duty.advDelayMaxMs.txDutyPercent.toFixed(3)}%，` +
			`数据速率 ${a.throughput.dataRateBpsAt0.toFixed(0)}–${a.throughput.dataRateBpsAtMax.toFixed(0)} bps`,
	)
}
const adv20 = analyzeAdvertising({ phy: 'le-1m', advIntervalMs: 20, legacy: true, channelCount: 3, advDataOctets: 31 })
check('legacy ADV_IND（31 octets）单包 376 µs', adv20.packetUs === 376, `${adv20.packetUs} µs`)
check(
	'20 ms 广播间隔下，三个信道各发一遍的 TX 占空比 ≈ 7.9%',
	approx(adv20.duty.advDelay0Ms.txDutyPercent, 7.89, 0.01),
	`${adv20.duty.advDelay0Ms.txDutyPercent.toFixed(2)}%（3 × (376+150) / 20000）`,
)
check(
	'相邻包起始间隔 526 µs ≤ 规范上限 10 ms',
	adv20.checks.find((c) => c.name.includes('10 ms')).pass,
	'3 个信道依次发，事件内相邻包起始间隔必须 ≤ 10 ms',
)

console.log('\n主动扫描 / 可连接广播：每包之后还要留监听窗（T_IFS + 对端包时间）：')
for (const kind of ['scanReq', 'connectInd']) {
	const a = analyzeAdvertising({
		phy: 'le-1m',
		advIntervalMs: 100,
		legacy: true,
		channelCount: 3,
		advDataOctets: 31,
		expectResponse: true,
		responseKind: kind,
	})
	console.log(
		`  ${kind.padEnd(11)}：监听窗 ${a.listenUs.toFixed(0)} µs，事件 ${a.eventTxUs.toFixed(0)} µs，` +
			`占用占空比 ${a.duty.advDelay0Ms.radioOnDutyPercent.toFixed(3)}%`,
	)
}

const ext = analyzeAdvertising({
	phy: 'le-2m',
	advIntervalMs: 100,
	legacy: false,
	channelCount: 3,
	advDataOctets: 242,
	extHeaderOctets: 13,
	hostDataTotalOctets: 1650,
	auxPhy: 'le-2m',
})
console.log(
	[
		'',
		'扩展广播（host 数据 1650 octets，2M PHY，扩展头 13 octets）：',
		`  AUX 链 ${ext.aux.chainPackets} 包 × ${ext.aux.auxPacketUs.toFixed(0)} µs，链时长 ${ext.aux.chainUs.toFixed(0)} µs`,
		`  广播事件总占用 ${ext.eventTxUs.toFixed(0)} µs（主信道 3 包 + AUX 链），@100 ms 间隔占空比 ${ext.duty.advDelay0Ms.txDutyPercent.toFixed(2)}%`,
		`  数据速率 ${ext.throughput.dataRateBpsAt0.toFixed(0)} bps（1650 octets / 100 ms）`,
		`  对比 legacy 31 octets @100 ms：${(31 * 8 * 10000).toFixed(0)} bps —— 消息量差 ${(1650 / 31).toFixed(0)} 倍`,
	].join('\n'),
)
check(
	'1650 octets 扩展广播装得进一个 100 ms 广播事件',
	ext.checks.find((c) => c.name.includes('AUX')).pass,
	`事件 ${ext.eventTxUs.toFixed(0)} µs`,
)

// ─────────────────────────────────────────────────────────────────────────────

section('④ 用例 4：连接参数合法性（Slave Latency / Supervision Timeout）')

const paramCases = [
	{ label: '游戏 HID：CI 7.5 ms，SL 0，timeout 500 ms', ci: 7.5, sl: 0, timeout: 500 },
	{ label: '穿戴：CI 30 ms，SL 9，timeout 2000 ms', ci: 30, sl: 9, timeout: 2000 },
	{ label: '传感器：CI 500 ms，SL 4，timeout 10000 ms', ci: 500, sl: 4, timeout: 10000 },
	{ label: '☆ 非法：CI 100 ms，SL 4，timeout 500 ms', ci: 100, sl: 4, timeout: 500 },
	{ label: '☆ 非法：CI 4 s，SL 0，timeout 5000 ms', ci: 4000, sl: 0, timeout: 5000 },
	{ label: '☆ 非法：timeout 2505 ms 不是 10 ms 倍数', ci: 100, sl: 0, timeout: 2505 },
	{ label: '☆ 非法：CI 7.6 ms 不是 1.25 ms 倍数', ci: 7.6, sl: 0, timeout: 5000 },
]
for (const c of paramCases) {
	const r = checkConnectionParams({ connIntervalMs: c.ci, latency: c.sl, supervisionTimeoutMs: c.timeout })
	const bad = r.checks.filter((x) => !x.pass).map((x) => x.name)
	console.log(
		`  ${c.label.padEnd(42)} → ${r.legal ? '合法' : '不合法'}｜跳过窗口 ${r.peripheralSilenceWindowMs} ms，` +
			`最小合法 timeout ${r.minRequiredTimeoutMs} ms，SL 上限 ${r.maxLegalLatency}` +
			(bad.length > 0 ? `｜违反：${bad.join('、')}` : ''),
	)
}
const illegal = checkConnectionParams({ connIntervalMs: 100, latency: 4, supervisionTimeoutMs: 500 })
check(
	'规范硬约束：timeout 必须 > (1+SL) × CI × 2',
	!illegal.legal && illegal.warnings.length > 0,
	`CI 100 ms + SL 4 → 需要 > ${illegal.minRequiredTimeoutMs} ms，实际 500 ms`,
)
const legal = checkConnectionParams({ connIntervalMs: 30, latency: 9, supervisionTimeoutMs: 2000 })
check(
	'CI 30 ms + SL 9 + timeout 2000 ms 合法',
	legal.legal,
	`跳过窗口 ${legal.peripheralSilenceWindowMs} ms < ${legal.supervisionTimeoutMs / 2} ms`,
)
check(
	'SL 上限反解：timeout 2000 / (2×30) − 1 = 32',
	legal.maxLegalLatency === 32,
	`${legal.maxLegalLatency}`,
)

// ─────────────────────────────────────────────────────────────────────────────

section('④ 用例 5：扫描端占空比与发现时间')

for (const [si, sw] of [
	[10, 10],
	[100, 10],
	[1000, 50],
	[1000, 100],
	[50, 30],
]) {
	const s = analyzeScanning({ scanIntervalMs: si, scanWindowMs: sw, advPacketUs: 376, advIntervalMs: 100 })
	console.log(
		`  扫描 ${String(si).padStart(4)} / 窗口 ${String(sw).padStart(5)} ms → 占空比 ${s.scanDutyPercent.toFixed(1).padStart(6)}%，` +
			`单信道驻留 ${s.perChannelDwellUs.toFixed(0).padStart(5)} µs，覆盖概率 ${(s.catchProbability * 100).toFixed(1).padStart(5)}%，` +
			`预计发现时间 ≈ ${s.expectedDiscoverEstimateMs.toFixed(0)} ms`,
	)
}
const badScan = analyzeScanning({ scanIntervalMs: 1000, scanWindowMs: 10, advPacketUs: 376, advIntervalMs: 100 })
check(
	'窗口 10 ms 时单信道驻留 3.33 ms > 376 µs，够听完整包',
	badScan.perChannelDwellUs > 376,
	`驻留 ${badScan.perChannelDwellUs.toFixed(0)} µs`,
)
const shortScan = analyzeScanning({ scanIntervalMs: 100, scanWindowMs: 2.5, advPacketUs: 376, advIntervalMs: 100 })
check(
	'窗口 2.5 ms 时单信道驻留 833 µs —— 仍够，但覆盖概率低（发现慢）',
	shortScan.perChannelDwellUs > 376,
	`驻留 ${shortScan.perChannelDwellUs.toFixed(0)} µs，覆盖概率 ${(shortScan.catchProbability * 100).toFixed(1)}%`,
)
const tinyScan = analyzeScanning({ scanIntervalMs: 100, scanWindowMs: 1.0, advPacketUs: 376, advIntervalMs: 100 })
check(
	'窗口 1.0 ms 违反规范下限 2.5 ms',
	!tinyScan.checks.find((c) => c.name === '扫描参数范围').pass,
	`窗口 ${tinyScan.scanWindowMs} ms < 2.5 ms`,
)

// ═════════════════════════════════════════════════════════════════════════════

section('⑤ 参数校验：异常输入必须被拒绝')

const throws = (fn) => {
	try {
		fn()
		return false
	} catch {
		return true
	}
}
check('未知 PHY 被拒绝', throws(() => packetTimeUs({ phy: 'le-4m', payloadOctets: 10, micOctets: 0 })), '抛出异常')
check(
	'micOctets=2 被拒绝',
	throws(() => packetTimeUs({ phy: 'le-1m', payloadOctets: 10, micOctets: 2 })),
	'MIC 只能 0 或 4',
)
check(
	'analyzeDataLength 不给 encrypted 被拒绝',
	throws(() => analyzeThroughput({ phy: 'le-1m', dataLenOctets: 251, connIntervalMs: 30 })),
	'加密与否决定有没有 4 octets MIC，必须显式给出',
)
check(
	'数据长度 300 octets 被拒绝',
	throws(() => analyzeThroughput({ phy: 'le-1m', dataLenOctets: 300, encrypted: true, connIntervalMs: 30 })),
	'DLE 区间 27–251',
)
check(
	'ATT_MTU 10 被拒绝',
	throws(() => analyzeThroughput({ phy: 'le-1m', dataLenOctets: 251, encrypted: true, connIntervalMs: 30, attMtuOctets: 10 })),
	'ATT_MTU 规范下限 23',
)
check(
	'扩展广播不给 extHeaderOctets 被拒绝',
	throws(() =>
		analyzeAdvertising({ phy: 'le-2m', advIntervalMs: 100, legacy: false, channelCount: 3, advDataOctets: 100 }),
	),
	'扩展头大小属设计细节，无默认值',
)
check(
	'legacy 广播 100 octets 数据被报警（超 31）',
	!analyzeAdvertising({ phy: 'le-1m', advIntervalMs: 100, legacy: true, channelCount: 3, advDataOctets: 100 }).checks.find(
		(c) => c.name.includes('31'),
	).pass,
	'ADV_IND 的 Length 字段上限 37（AdvA 6 + AdvData 31）',
)

console.log(
	'\n注：legacy 广播 100 octets 那一项只报警不断言，因为**规范上不可能发生**（主机侧 HCI 就只能给 31 octets）；' +
		'真正的扩展广播要用 legacy:false。',
)

// ─────────────────────────────────────────────────────────────────────────────

section('⑥ 速查表：ATT_MTU 与 DLE 的匹配关系')

console.log('DL octets'.padEnd(12) + 'LL 包 µs'.padStart(10) + 'MTU 上限'.padStart(10) + 'MTU 默认 23 时应用 octets/包'.padStart(28) + 'MTU 匹配时'.padStart(12))
console.log('-'.repeat(78))
for (const dl of [27, 64, 128, 251]) {
	const t = analyzeThroughput({ phy: 'le-1m', dataLenOctets: dl, encrypted: true, connIntervalMs: 400, attMtuOctets: DEFAULT_ATT_MTU_OCTETS })
	const t2 = analyzeThroughput({ phy: 'le-1m', dataLenOctets: dl, encrypted: true, connIntervalMs: 400, attMtuOctets: dl - 4 })
	console.log(
		String(dl).padEnd(12) +
			t.dataPacketUs.toFixed(0).padStart(10) +
			String(t2.attMtuOctets).padStart(10) +
			t.appOctetsPerPacket.toFixed(1).padStart(28) +
			t2.appOctetsPerPacket.toFixed(1).padStart(12),
	)
}
console.log(
	`\nMTU 上限 ${MAX_ATT_MTU_OCTETS} 是推导值（512 字节长属性值 + 5 字节 ATT 开销），不是规范原文直接给的数；\n` +
		'MTU 与 DLE 不匹配时，缺口全部落在"最后一段分片装不满"上 —— 这是最容易被忽略的一层损耗。',
)

// ─────────────────────────────────────────────────────────────────────────────
// 小结
// ─────────────────────────────────────────────────────────────────────────────

section('小结')
console.log(`断言：通过 ${passed}，失败 ${failed}`)
console.log(
	[
		'',
		`未覆盖的已知差异：规范 §2.1 说未编码包最大 ${SPEC_PACKET_TIME_BOUNDS_US.uncoded.max} µs，` +
			`逐字节模型与 HCI MaxTxTime 都是 2120 µs（差 8 µs = 1M 前导码 octet）—— 已在 ① 附 中标注，需人工复核。`,
		`广播 advDelay 上限 ${ADV_DELAY_MAX_MS} ms；本脚本的广播数据速率给的是 advDelay=0 与 =10 ms 两个端点。`,
		'所有"每事件包数"结果都只是**连接间隔切出来的上限**，没有计入协议栈实际队列深度与事件长度上限 —— 那两项必须实测。',
	].join('\n'),
)

if (failed > 0) {
	console.log('\n存在失败断言 —— 公式或实现可能已漂移，请复核。')
	process.exitCode = 1
} else {
	console.log('\n全部通过：包时间模型命中了规范 / HCI / SIG / Silabs / Memfault / Goodix / Ezurio 的公开数值，')
	console.log('且与 EnGenius 的真实设备实测吞吐（理论/实测 = 1.03~1.88）方向一致。')
}
