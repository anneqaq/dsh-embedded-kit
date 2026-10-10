/**
 * BLE：连接间隔 / 吞吐 / 广播占空比。
 *
 * 分四块：
 *   1. **逐层开销与理论吞吐**：一条应用数据要依次啃掉 ATT 头 3 octets、L2CAP 头 4 octets、
 *      LL 头 2 + MIC 4 + CRC 3 + 前导码 + 4 octets AA，再加上两个 T_IFS 与对端的空包 ACK。
 *   2. **各 PHY 的包时间**：1M / 2M 未编码，Coded PHY 的 S=2 / S=8（1 Msym/s 恒定，靠重复编码降速）。
 *   3. **广播占空比**：广播间隔、三个主广播信道、事件内相邻包起始间隔 ≤ 10 ms、legacy 31 octets 与扩展广播。
 *   4. **连接参数合法性**：连接间隔 / Slave Latency / Supervision Timeout 的可判定组合。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 联网核实的出处与数字（核实日期 2026-09-20）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * [S1] Bluetooth Core Specification，Vol 6 Part B（Link Layer Specification），
 *      官方 HTML 版（Core 6.1）
 *      https://www.bluetooth.com/wp-content/uploads/Files/Specification/HTML/Core-61/out/en/low-energy-controller/link-layer-specification.html
 *   · §2.1 LE Uncoded PHY 包格式原文：
 *     "Packets (not including the Constant Tone Extension) take between 44 and 2128 µs to transmit."
 *   · §2.2 LE Coded PHY 包格式原文：
 *     "The Preamble is not coded." / "The Preamble is 80 symbols in length" /
 *     "FEC block 1 consists of ... Access Address, Coding Indicator (CI), and TERM1. These shall use the S=8
 *      coding scheme" / "FEC block 2 consists of ... PDU, CRC, and TERM2 ... either S=2 or S=8" /
 *     "The entire packet is transmitted with 1 Msym/s modulation." /
 *     "Packets take between 462 and 17040 µs to transmit."
 *   · §2.2 Table 2.1（LE Coded PHY 各字段时长，单位 µs）：
 *       Preamble 80 / 80；Access Address 256 / 256；CI 16 / 16；TERM1 24 / 24；
 *       PDU 128–16448（S=8）/ 32–4112（S=2）；CRC 192 / 48；TERM2 24 / 6。
 *     → 本模块用 "296 µs（= 37 bits × 8）+ (PDU bits + 27) × S" 复现了上下端点 462 / 17040 µs。
 *   · §1.4：40 个 RF 信道中 3 个是 primary advertising channels；Table 1.3 给出 2402/2426/2480 MHz
 *     = 信道号 37/38/39。广播信道包的 Access Address 恒为 0x8E89BED6。
 *   · §2.3：legacy 广播 PDU 的 Length 字段有效范围 6–37 octets（即 AdvA 6 + AdvData ≤ 31）。
 *   · §2.3.3.1 CONNECT_IND：`connInterval = Interval × 1.25 ms`。
 *
 * [S2] Bluetooth Core Specification，Vol 4 Part E（HCI）——各参数的合法区间
 *   · LE Set Data Length / LE Write Suggested Default Data Length：
 *       MaxTxOctets 0x001B–0x00FB（27–251 octets）；MaxTxTime 0x0148–0x0848（328–2120 µs）。
 *     ★ 这两个端点正是"LE 1M + MIC"下 27 octets 与 251 octets 的包时间，是本模块最强的自校验锚点
 *       （见 probe：packetTimeUs 必须精确等于 328 / 2120）。
 *   · LE Set Advertising Parameters：Advertising_Interval_Min/Max = 0x0020–0x4000，
 *     单位 0.625 ms → **20 ms ～ 10.24 s**。
 *   · LE Set Scan Parameters：LE_Scan_Interval / LE_Scan_Window = 0x0004–0x4000，
 *     单位 0.625 ms → 2.5 ms ～ 10.24 s，且 **Scan_Window ≤ Scan_Interval**。
 *   · LE Create Connection：Conn_Interval 0x0006–0x0C80（单位 1.25 ms → 7.5 ms ～ 4 s）；
 *       Conn_Latency 0x0000–0x01F3（0–499）；Supervision_Timeout 0x000A–0x0C80
 *       （单位 10 ms → **100 ms ～ 32 s**，且必须是 10 ms 的整数倍）。
 *     注：本项区间以 Silicon Labs WiSeConnect API 文档对照核实
 *       https://docs.silabs.com/wiseconnect/latest/wiseconnect-api-reference-guide-ble/rsi-ble-apis-h
 *       （该页把 Conn_Latency 写成 0x01F4 = 500，与 0x01F3 = 499 不一致，本模块取 499，见下方"待复核"。）
 *
 * [S3] Vol 6 Part B §4.5.2 Supervision timeout：
 *      `connSupervisionTimeout > (1 + connPeripheralLatency) × connSubrateFactor × connInterval × 2`
 *      且 connSupervisionTimeout 必须是 10 ms 的倍数、落在 100 ms ～ 32.0 s。
 *      对照出处：Nordic DevZone 引 Core 5.4 原文
 *      https://devzone.nordicsemi.com/f/nordic-q-a/103540/...
 *
 * [S4] Bluetooth SIG 博客《Higher speed: How fast can Bluetooth Core 5.0 be?》
 *      https://www.bluetooth.com/blog/exploring-bluetooth-5-how-fast-can-it-be/
 *      · 空 PDU（ACK） = 1 + 4 + 2 + 3 = 10 octets = **80 µs** @1 Mbps
 *      · 4.0/4.1 最大包 = 1 + 4 + 2 + 27 + 4 + 3 = 41 octets = **328 µs**
 *      · 4.2 DLE 最大包 = 1 + 4 + 2 + 251 + 4 + 3 = 265 octets = **2120 µs**
 *      · T_IFS 恒为 **150 µs**（Vol 6 Part B §4.1）
 *
 * [S5] Silicon Labs《Throughput with Bluetooth Low Energy Technology》
 *      https://docs.silabs.com/bluetooth/8.2.0/bluetooth-fundamentals-system-performance/throughput
 *      · 27 B：328 + 150 + 80 + 150 = 708 µs → 305,080 bps
 *      · 251 B：2120 + 150 + 80 + 150 = 2500 µs → 803,200 bps
 *      · ATT 有效载荷 = PDU − 4（L2CAP）− 3（GATT）→ (251−7)/2500 µs = **780,800 bps**
 *
 * [S6] Memfault《A Practical Guide to BLE Throughput》
 *      https://interrupt.memfault.com/blog/ble-throughput-primer
 *      · 251 B 一次往返 2500 µs → ~0.803 Mbps；2M PHY 下 ≈1400 µs → ~1.434 Mbps
 *      · 7 个 27 B 包在 15 ms 内：7 × (328+150+80+150) = 4.956 ms
 *      · 4 包 / 11.25 ms = 0.713 Mbps；5 包 / 12.5 ms = 0.803 Mbps（**间隔取周期整数倍更划算**）
 *
 * [S7] Goodix BLE Wiki（做交叉校验，注意该文未计 MIC）
 *      https://goodix-ble-wiki-en.readthedocs.io/latest/AppNote/BLE/BLE基础/BLE 吞吐率.html
 *      · 2M：TX 1048 µs + 空包 44 µs + 2×150 µs = 1392 µs → (244×8)/1392 ≈ 1402 kbps
 *      · 1M：2120 µs + 80 µs + 2×150 µs = 2500 µs → (244×8)/2500 ≈ 780 kbps
 *
 * [S8] Ezurio DTM 应用笔记（**LE Coded 的独立基准向量**）
 *      https://www.ezurio.com/documentation/application-note-how-to-get-packet-error-rate-per-in-ble-regulation-test
 *      · LE Coded S=8、37 octets payload：80（前导）+ 296（AA+CI+TERM1）+ (312+24+3)×8 = **3088 µs**
 *        （DTM 包不带 MIC；本模块 packetTimeUs 可精确复现 3088）
 *
 * [S9] Ellisys《ADVB_L – Legacy Advertising》
 *      https://www.ellisys.com/technology/edu_bt01_lecomm_ch03_advbl.pdf
 *      · 广播间隔 20 ms ～ 10.24 s，advDelay 每次随机取 0–10 ms
 *      · 一个广播事件内在不同信道上连发 1–3 份同一个包，**相邻包起始间隔 ≤ 10 ms**
 *      · legacy 广播包 < 400 µs
 *
 * [S10] Walsh Medical Media（ADV_IND 帧格式）
 *      · ADV_IND 最大帧 = 1 + 4 + 2 + 6 + 31 + 3 = 47 octets，@1 Mbps = **0.376 ms**
 *      · 广播包总长范围 80–376 bits（10–47 octets）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 哪些是设计值、哪些必须实测
 * ═══════════════════════════════════════════════════════════════════════════
 * 设计值（可算）：
 *   · 包时间、每包周期、每连接事件最多能塞几个包（由连接间隔/事件长度上限决定）
 *   · 逐层开销（ATT / L2CAP / LL / PHY）与各 PHY 的理论吞吐上限
 *   · 广播占空比、广播数据速率
 *   · 连接参数的规范合法性（区间、步进、timeout 不等式）
 *
 * 必须实测（本模块**不内置**任何默认值）：
 *   · 协议栈**每个连接事件实际发几个包**（受 TX buffer 数、队列深度、调度器限制；
 *     实测值通常明显低于规范允许的理论值）
 *   · 协议栈允许的**最大连接事件长度**（如 nRF S132 默认 7.5 ms，可配到几十 ms；各栈不同）
 *   · 实际协商到的 DLE（251 不一定给）与 ATT_MTU（对端可能与你要的不一样）
 *   · 重传率（每丢一次包就白等一个 T_IFS 与重传窗口，吞吐按实测 loss 打折）
 *   · RSSI / 信道环境、双方时钟精度（决定 supervision timeout 的工程余量）
 *
 * 已知的**规范内部不一致**（本模块取 HCI 的 2120 µs，见 probe 的对照）：
 *   [S1] 说未编码包最大 2128 µs，比逐字节推导的 2120 µs（= [S2] HCI MaxTxTime）多 8 µs；
 *   8 µs 恰好是 1M PHY 的一个前导码 octet。两处原文均未解释差异，需人工复核。
 *
 * @module dsh-embedded-kit/ble
 */

// ─────────────────────────────────────────────────────────────────────────────
// 规范常量（全部注明出处；无出处的经验值一律不内置）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 各 PHY 的物理层参数。symbolRateHz 恒定 1 Msym/s（Coded 也是），降速全靠重复编码。
 *
 * @type {Record<string, object>}
 */
export const BLE_PHYS = {
	'le-1m': {
		id: 'le-1m',
		label: 'LE 1M PHY（未编码）',
		symbolRateHz: 1_000_000,
		bitRateBps: 1_000_000,
		preambleSymbols: 8,
		coded: false,
		s: null,
		source: '[S1] Vol 6 Part B §2.1：未编码 PHY，前导码 1 octet（8 bits）。',
	},
	'le-2m': {
		id: 'le-2m',
		label: 'LE 2M PHY（未编码，2 Msym/s）',
		symbolRateHz: 2_000_000,
		bitRateBps: 2_000_000,
		preambleSymbols: 16,
		coded: false,
		s: null,
		source: '[S1] Vol 6 Part B §2.1：未编码 PHY，2M 的前导码 2 octets；符号率 2 Msym/s。',
	},
	'le-coded-s2': {
		id: 'le-coded-s2',
		label: 'LE Coded PHY, S=2（500 kbps）',
		symbolRateHz: 1_000_000,
		bitRateBps: 500_000,
		preambleSymbols: 80,
		coded: true,
		s: 2,
		source: '[S1] Vol 6 Part B §2.2 Table 2.1：前导码 80 symbols；1 bit → 2 symbols。',
	},
	'le-coded-s8': {
		id: 'le-coded-s8',
		label: 'LE Coded PHY, S=8（125 kbps）',
		symbolRateHz: 1_000_000,
		bitRateBps: 125_000,
		preambleSymbols: 80,
		coded: true,
		s: 8,
		source: '[S1] Vol 6 Part B §2.2 Table 2.1：前导码 80 symbols；1 bit → 8 symbols。',
	},
}

/** PHY id 清单。 */
export const BLE_PHY_IDS = Object.keys(BLE_PHYS)

/** T_IFS：包间间隔，规范固定 150 µs。出处 [S4]/[S1] Vol 6 Part B §4.1。 */
export const T_IFS_US = 150

/** Access Address 32 bits（前导码之后的固定字段）。出处 [S1] §2.1。 */
export const LL_ACCESS_ADDRESS_BITS = 32

/** LL 头 2 octets（广播 PDU 与数据 PDU 都是 16-bit Header）。出处 [S1] §2.3 / §2.4。 */
export const LL_HEADER_OCTETS = 2

/** CRC 24 bits = 3 octets。出处 [S1] §2.1。 */
export const LL_CRC_OCTETS = 3

/** 加密连接的 MIC = 4 octets；未加密 / 广播 / DTM 包没有 MIC。出处 [S4]。 */
export const LL_MIC_OCTETS = 4

/** L2CAP 头 = 2（Length）+ 2（CID）= 4 octets。出处 [S5]。 */
export const L2CAP_HEADER_OCTETS = 4

/** ATT 通知 / Write Without Response 的头 = 1（opcode）+ 2（handle）= 3 octets。出处 [S5]。 */
export const ATT_HEADER_OCTETS = 3

/** ATT_MTU 的规范默认值 23 octets。出处 [S5] / Core Vol 3 Part F。 */
export const DEFAULT_ATT_MTU_OCTETS = 23

/**
 * ATT_MTU 上限的推导值 517 = 512（长属性值上限，Core Vol 3 Part F §3.2.9）+ 5（ATT PDU 开销）。
 * 这是**推导值**，不是规范原文直接给的数。
 */
export const MAX_ATT_MTU_OCTETS = 517

/** DLE 允许的 LL 载荷范围 27–251 octets。出处 [S2]/[S4]。 */
export const DLE_MIN_PAYLOAD_OCTETS = 27

/** 见上。 */
export const DLE_MAX_PAYLOAD_OCTETS = 251

/** HCI MaxTxTime 的合法区间端点（恰好是 1M + MIC 下 27 / 251 octets 的包时间）。出处 [S2]。 */
export const HCI_MIN_TX_TIME_US = 328

/** 见上。 */
export const HCI_MAX_TX_TIME_US = 2120

/** 连接间隔：7.5 ms 起、1.25 ms 步进、最大 4 s。出处 [S2]。 */
export const CONN_INTERVAL = {
	minMs: 7.5,
	maxMs: 4000,
	stepMs: 1.25,
	hciMin: 0x0006,
	hciMax: 0x0c80,
	source: '[S2] HCI LE Create Connection：0x0006–0x0C80，单位 1.25 ms。',
}

/** Slave Latency（connPeripheralLatency）：0–499，单位"可跳过的连接事件数"。出处 [S2]。 */
export const CONN_LATENCY = {
	min: 0,
	// 0x01F3 = 499。部分厂商文档写作 0x01F4 = 500（疑似笔误），见文件头"待复核"。
	max: 499,
	hciMax: 0x01f3,
	source: '[S2] HCI LE Create Connection：Conn_Latency 0x0000–0x01F3。',
}

/** Supervision Timeout：100 ms 起、10 ms 步进、最大 32 s。出处 [S2]/[S3]。 */
export const SUPERVISION_TIMEOUT = {
	minMs: 100,
	maxMs: 32000,
	stepMs: 10,
	hciMin: 0x000a,
	hciMax: 0x0c80,
	source: '[S2] HCI：0x000A–0x0C80，单位 10 ms，Time Range 100 ms–32 s。',
}

/** 广播间隔：20 ms 起、0.625 ms 步进、最大 10.24 s。出处 [S2]/[S9]。 */
export const ADV_INTERVAL = {
	minMs: 20,
	maxMs: 10240,
	stepMs: 0.625,
	hciMin: 0x0020,
	hciMax: 0x4000,
	source: '[S2] HCI LE Set Advertising Parameters：0x0020–0x4000，单位 0.625 ms。',
}

/** advDelay 每次广播事件重新随机取，范围 0–10 ms（含端点）。出处 [S9]。 */
export const ADV_DELAY_MAX_MS = 10

/**
 * 同一个广播事件内，相邻（不同信道上）包**起始时刻**的最大间隔 10 ms。出处 [S9]/[S1] §4.4.2。
 * 高占空比定向广播不受此限。
 */
export const ADV_EVENT_MAX_PACKET_START_GAP_US = 10_000

/** 三个主广播信道。出处 [S1] §1.4 Table 1.3。 */
export const PRIMARY_ADV_CHANNELS = [
	{ index: 37, mhz: 2402 },
	{ index: 38, mhz: 2426 },
	{ index: 39, mhz: 2480 },
]

/** legacy 广播单包 AdvData 上限 31 octets。出处 [S2]/[S10]。 */
export const LEGACY_ADV_DATA_MAX_OCTETS = 31

/** legacy 广播 PDU 载荷（AdvA + AdvData）范围 6–37 octets。出处 [S1] §2.3。 */
export const LEGACY_ADV_PDU_PAYLOAD_MIN_OCTETS = 6

/** 见上。 */
export const LEGACY_ADV_PDU_PAYLOAD_MAX_OCTETS = 37

/** 广播 PDU 载荷上限 255 octets（扩展广播用 8-bit Length）。出处 [S1] §2.3。 */
export const ADV_PDU_PAYLOAD_MAX_OCTETS = 255

/** 扩展广播 host 侧数据总量上限 1650 octets。出处 Core 5.0 特性文档（SIG）。 */
export const EXT_ADV_HOST_DATA_MAX_OCTETS = 1650

/** 扩展广播单包 host 数据上限 254 octets。出处同上（SIG Core 5.0 特性文档对比表）。 */
export const EXT_ADV_PER_PACKET_DATA_MAX_OCTETS = 254

/** 扫描间隔 / 扫描窗口：2.5 ms 起、0.625 ms 步进、最大 10.24 s，且 window ≤ interval。出处 [S2]。 */
export const SCAN_INTERVAL = {
	minMs: 2.5,
	maxMs: 10240,
	stepMs: 0.625,
	hciMin: 0x0004,
	hciMax: 0x4000,
	source: '[S2] HCI LE Set Scan Parameters：0x0004–0x4000，单位 0.625 ms。',
}

/**
 * 主动扫描 / 连接请求的 PDU 载荷 octets（规范字段大小推导）：
 *   SCAN_REQ   = AdvA 6 + ScanA 6 = 12
 *   CONNECT_IND = InitA 6 + AdvA 6 + LLData 22 = 34
 * 出处 [S1] §2.3.3（CONNECT_IND 的 LLData = 22 octets）。
 */
export const ADV_RESPONSE_PDU_PAYLOAD_OCTETS = {
	scanReq: 12,
	connectInd: 34,
}

/**
 * 规范原文给出的包时间上下界（µs）。用于交叉校验逐字节模型。
 * 注意 uncoded.max = 2128 与 HCI MaxTxTime = 2120 差 8 µs（见文件头"规范内部不一致"）。
 */
export const SPEC_PACKET_TIME_BOUNDS_US = {
	uncoded: { min: 44, max: 2128, source: '[S1] Vol 6 Part B §2.1 原文。' },
	coded: { min: 462, max: 17040, source: '[S1] Vol 6 Part B §2.2 原文。' },
}

/** Coded PHY 的 FEC block 1（AA 32 + CI 2 + TERM1 3 = 37 bits）恒用 S=8，合计 296 µs。出处 [S1] Table 2.1。 */
const CODED_FEC_BLOCK1_US = 296

/** FEC block 2 尾部：CRC 24 bits + TERM2 3 bits（时长 = 27 × S）µs。出处 [S1] Table 2.1。 */
const CODED_FEC_BLOCK2_TAIL_BITS = 27

// ─────────────────────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 判断 value 是否为 step 的整数倍（浮点容差）。
 *
 * @param {number} value - 待判定值。
 * @param {number} step - 步进。
 * @returns {boolean} 是否整除。
 */
function isStepMultiple(value, step) {
	const q = value / step
	return Math.abs(q - Math.round(q)) < 1e-9
}

/**
 * 取 phy 规格，非法时抛错。
 *
 * @param {string} phy - PHY id。
 * @returns {object} PHY 规格。
 */
function requirePhy(phy) {
	const spec = BLE_PHYS[phy]
	if (!spec) throw new Error(`未知的 PHY：${phy}（可用：${BLE_PHY_IDS.join(' / ')}）`)
	return spec
}

/**
 * 取正整数并校验区间。
 *
 * @param {number} value - 值。
 * @param {string} name - 参数名（报错用）。
 * @param {number} min - 下限（含）。
 * @param {number} max - 上限（含）。
 * @returns {number} 原值。
 */
function requireIntInRange(value, name, min, max) {
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} 必须是 ${min}~${max} 的整数，收到 ${value}`)
	}
	return value
}

/**
 * 校验 MIC 长度只能是 0 或 4。
 *
 * @param {number} micOctets - MIC octets。
 * @returns {number} 原值。
 */
function requireMicOctets(micOctets) {
	if (micOctets !== 0 && micOctets !== LL_MIC_OCTETS) {
		throw new Error(
			`mic_octets 只能是 0（未加密连接 / 广播包 / DTM 包）或 ${LL_MIC_OCTETS}（加密连接），收到 ${micOctets}`,
		)
	}
	return micOctets
}

// ─────────────────────────────────────────────────────────────────────────────
// 1) 包时间与每包周期
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 单个链路层包的空中时间（µs）。
 *
 * 未编码 PHY：前导码 + AA 32 bits + LL 头 + 载荷 + 可选 MIC + CRC 24 bits，全部按比特率计时。
 * Coded PHY：前导码 80 symbols（不编码）+ FEC block 1（AA+CI+TERM1 = 37 bits，恒 S=8 → 296 µs）
 *            + FEC block 2（(PDU bits + 27) × S）。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - PHY id（BLE_PHYS 的键）。
 * @param {number} input.payloadOctets - PDU 载荷 octets（**不含** 2 octets 的 LL 头与 3 octets 的 CRC）。
 *   数据信道包填数据长度；广播包填 AdvA + AdvData（legacy 时 6~37，扩展时 ≤ 255）。
 * @param {number} input.micOctets - MIC 长度，只能 0（未加密/广播/DTM）或 4（加密连接）。
 *   空包 ACK 恒为 0——ACK 是 Length=0 的包，不带载荷也不带 MIC。
 * @returns {number} 包时间（µs），保留浮点。
 */
export function packetTimeUs({ phy, payloadOctets, micOctets }) {
	const spec = requirePhy(phy)
	requireMicOctets(micOctets)
	requireIntInRange(payloadOctets, 'payload_octets', 0, ADV_PDU_PAYLOAD_MAX_OCTETS)

	const pduBits = (LL_HEADER_OCTETS + payloadOctets + micOctets) * 8
	const preambleUs = (spec.preambleSymbols / spec.symbolRateHz) * 1e6

	if (!spec.coded) {
		const bitsPerUs = spec.bitRateBps / 1e6
		return preambleUs + (LL_ACCESS_ADDRESS_BITS + pduBits + LL_CRC_OCTETS * 8) / bitsPerUs
	}
	return preambleUs + CODED_FEC_BLOCK1_US + (pduBits + CODED_FEC_BLOCK2_TAIL_BITS) * spec.s
}

/**
 * 一次"数据包 + 空包 ACK"往返的周期（µs）：包时间 + T_IFS + ACK + T_IFS。
 *
 * 这是吞吐计算的**原子单位**：一个连接事件里能塞进几个这样的周期，决定了吞吐上限。
 * 对端若也捎带数据（双向流），把 ackPayloadOctets 设成对端包长即可。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - PHY id。
 * @param {number} input.dataLenOctets - 本端数据长度 octets。
 * @param {number} input.micOctets - 本端 MIC octets（0 或 4）。
 * @param {number} [input.ackPayloadOctets] - 对端 ACK 里捎带的载荷 octets，默认 0（纯空包 ACK）。
 * @param {number} [input.tIfsUs] - 包间间隔，默认 T_IFS_US = 150 µs（规范值）。
 * @returns {object} 包时间、ACK 时间与总周期。
 */
export function packetCycleUs({ phy, dataLenOctets, micOctets, ackPayloadOctets = 0, tIfsUs = T_IFS_US }) {
	requireMicOctets(micOctets)
	if (!(tIfsUs > 0)) throw new Error('t_ifs_us 必须为正数（规范值 150 µs）')
	const dataUs = packetTimeUs({ phy, payloadOctets: dataLenOctets, micOctets })
	// ACK 是空包：载荷 0、无 MIC（加密连接的空包也不带 MIC）。
	const ackUs = packetTimeUs({ phy, payloadOctets: ackPayloadOctets, micOctets: 0 })
	return {
		dataPacketUs: dataUs,
		ackPacketUs: ackUs,
		tIfsUs,
		cycleUs: dataUs + tIfsUs + ackUs + tIfsUs,
	}
}

/**
 * 一个连接事件里实际能塞几个包。
 *
 * 上限有三个，取最小：
 *   ① 连接间隔决定：floor(connInterval / cycle)
 *   ② 事件长度上限决定：floor(maxEventLengthUs / cycle)（**设计值**，各栈不同，必须由调用方给出）
 *   ③ 协议栈队列 / buffer 数决定：maxPacketsPerEvent（**设计值**，必须实测或查 SDK 文档）
 * ②③ 都不给时只按 ① 算，并在 warnings 里明确说明"没有计入栈的实际限制，理论值会偏乐观"。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - PHY id。
 * @param {number} input.dataLenOctets - 数据长度 octets。
 * @param {number} input.micOctets - MIC octets（0 或 4）。
 * @param {number} input.connIntervalMs - 连接间隔 ms。
 * @param {number} [input.maxEventLengthUs] - 协议栈允许的最大连接事件长度（µs），设计值，无默认。
 * @param {number} [input.maxPacketsPerEvent] - 协议栈每事件最多发包数，设计值，无默认。
 * @param {number} [input.ackPayloadOctets] - 对端 ACK 捎带载荷，默认 0。
 * @param {number} [input.tIfsUs] - T_IFS，默认 150 µs。
 * @returns {object} 包数与填充率等。
 */
export function planConnectionEvent({
	phy,
	dataLenOctets,
	micOctets,
	connIntervalMs,
	maxEventLengthUs,
	maxPacketsPerEvent,
	ackPayloadOctets = 0,
	tIfsUs = T_IFS_US,
}) {
	requirePhy(phy)
	requireMicOctets(micOctets)
	if (!(connIntervalMs > 0)) throw new Error('conn_interval_ms 必须为正数')

	const intervalUs = connIntervalMs * 1000
	const cycle = packetCycleUs({ phy, dataLenOctets, micOctets, ackPayloadOctets, tIfsUs })

	const byInterval = Math.floor(intervalUs / cycle.cycleUs)
	let byEventLength = null
	let byStackCap = null
	let packets = byInterval
	const warnings = []
	const notes = []

	if (maxEventLengthUs !== undefined && maxEventLengthUs !== null) {
		if (!(maxEventLengthUs > 0)) throw new Error('max_event_length_us 必须为正数')
		byEventLength = Math.floor(maxEventLengthUs / cycle.cycleUs)
		packets = Math.min(packets, byEventLength)
		if (maxEventLengthUs > intervalUs) {
			warnings.push(
				`max_event_length_us=${maxEventLengthUs} µs 大于连接间隔 ${intervalUs} µs，` +
					'没有意义（连接事件必须在下一次连接事件锚点前结束）。',
			)
		}
	} else {
		notes.push(
			'未给 max_event_length_us：只按连接间隔算了上限。**协议栈的事件长度上限是设计值**（如某些 Nordic 栈默认 7.5 ms），' +
				'实际每事件包数往往明显低于这个数，必须实测。',
		)
	}

	if (maxPacketsPerEvent !== undefined && maxPacketsPerEvent !== null) {
		requireIntInRange(maxPacketsPerEvent, 'max_packets_per_event', 0, 65535)
		byStackCap = maxPacketsPerEvent
		packets = Math.min(packets, byStackCap)
	} else {
		notes.push(
			'未给 max_packets_per_event：实际每事件包数由 TX buffer 数 / 队列深度决定，**这是最常见的实测瓶颈**，' +
				'请在嗅探器上数一数 More Data 位，或查 SDK 文档。',
		)
	}

	if (packets < 1) {
		warnings.push(
			`一个连接事件连一个包都放不下：单次往返需 ${cycle.cycleUs.toFixed(0)} µs > 间隔 ${intervalUs.toFixed(0)} µs。` +
				'必须放长连接间隔、缩短数据长度或换更快的 PHY。',
		)
	}

	const busyUs = Math.max(0, packets) * cycle.cycleUs
	return {
		intervalUs,
		packetsPerEvent: Math.max(0, packets),
		packetsByInterval: byInterval,
		packetsByEventLength: byEventLength,
		packetsByStackCap: byStackCap,
		eventBusyUs: busyUs,
		eventFillRatio: intervalUs > 0 ? busyUs / intervalUs : 0,
		...cycle,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) DLE / MTU 的逐层开销
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 逐层开销与 ATT_MTU 匹配关系。
 *
 * 映射链：LL 载荷 N → L2CAP SDU = N − 4 → ATT PDU ≤ N − 4 → 通知类操作的应用有效数据 = ATT_MTU − 3。
 * 因此 **ATT_MTU 的理论上限 = N − 4**：N=27 时是 23（规范默认值），N=251 时是 247（常说的最大 MTU）。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - PHY id。
 * @param {number} input.dataLenOctets - LL 数据长度 octets（27–251）。
 * @param {number} input.encrypted - 连接是否加密（决定有没有 4 octets MIC）。**必须显式给出**，无默认。
 * @param {number} [input.attMtuOctets] - 协商到的 ATT_MTU，默认取规范默认值 23。
 * @returns {object} 各层开销、包时间与应用有效载荷。
 */
export function analyzeDataLength({ phy, dataLenOctets, encrypted, attMtuOctets = DEFAULT_ATT_MTU_OCTETS }) {
	requirePhy(phy)
	requireIntInRange(dataLenOctets, 'data_len_octets', DLE_MIN_PAYLOAD_OCTETS, DLE_MAX_PAYLOAD_OCTETS)
	if (typeof encrypted !== 'boolean') {
		throw new Error('encrypted 必须显式给出 true / false（加密连接的数据包多 4 octets MIC，无默认值）')
	}
	requireIntInRange(attMtuOctets, 'att_mtu_octets', DEFAULT_ATT_MTU_OCTETS, 65535)

	const checks = []
	const warnings = []
	const notes = []

	const micOctets = encrypted ? LL_MIC_OCTETS : 0
	const pduOctets = LL_HEADER_OCTETS + dataLenOctets + micOctets
	const packetUs = packetTimeUs({ phy, payloadOctets: dataLenOctets, micOctets })
	const maxMtu = dataLenOctets - L2CAP_HEADER_OCTETS

	// ATT_MTU 与 LL 载荷的匹配
	const mtuFitsOnePacket = attMtuOctets <= maxMtu
	checks.push({
		name: 'ATT_MTU ≤ LL 载荷 − L2CAP 头',
		pass: mtuFitsOnePacket,
		detail:
			`ATT_MTU=${attMtuOctets}，本长度下上限 ${maxMtu}（= ${dataLenOctets} − ${L2CAP_HEADER_OCTETS}）` +
			(mtuFitsOnePacket ? '，一个 ATT PDU 放得进一个 LL 包' : '，L2CAP 需要把 ATT PDU 分片到多个 LL 包'),
	})
	if (!mtuFitsOnePacket) {
		warnings.push(
			`ATT_MTU=${attMtuOctets} > ${maxMtu}：L2CAP 会把一个 ATT PDU 拆到 ${Math.ceil(attMtuOctets / maxMtu)} 个 LL 包里。` +
				'功能上没问题，但每个分片都要单独 ACK，且**最后一个分片常常装不满**——要么把 MTU 收敛到 ' +
				`${maxMtu}，要么接受这种"碎尾巴"损耗。`,
		)
	}
	if (attMtuOctets > MAX_ATT_MTU_OCTETS) {
		warnings.push(
			`ATT_MTU=${attMtuOctets} 超过常见上限 ${MAX_ATT_MTU_OCTETS}（= 512 字节长属性值 + 5 字节 ATT 开销，推导值）。` +
				'多数协议栈与手机不会接受这么大的 MTU。',
		)
	}

	// ATT 有效载荷
	const appValueOctets = attMtuOctets - ATT_HEADER_OCTETS
	const fragmentsPerAttPdu = Math.ceil(attMtuOctets / maxMtu)
	const appOctetsPerLlPacket = appValueOctets / fragmentsPerAttPdu
	const idealAppOctetsPerLlPacket = dataLenOctets - L2CAP_HEADER_OCTETS - ATT_HEADER_OCTETS

	if (dataLenOctets === DLE_MIN_PAYLOAD_OCTETS && attMtuOctets > DEFAULT_ATT_MTU_OCTETS) {
		warnings.push(
			'数据长度还是 4.0/4.1 时代的 27 octets：ATT_MTU 再大也只会被 L2CAP 切成多个包，' +
				'吞吐不会提升，反而更"碎"。先把 DLE 打开到 251。',
		)
	}
	if (attMtuOctets === maxMtu && dataLenOctets === DLE_MAX_PAYLOAD_OCTETS) {
		notes.push('ATT_MTU=247 与 DLE=251 是配套的：一个 ATT 通知正好装满一个 LL 包，没有碎尾巴。')
	}

	checks.push({
		name: 'HCI MaxTxTime 一致性',
		pass: packetUs <= HCI_MAX_TX_TIME_US,
		detail:
			`本包时间 ${packetUs.toFixed(0)} µs，HCI MaxTxTime 合法区间 ${HCI_MIN_TX_TIME_US}–${HCI_MAX_TX_TIME_US} µs` +
			`（本模块模型在 1M + 加密 + 27/251 octets 时精确命中这两个端点）`,
	})

	notes.push(
		`逐层开销：LL 头 ${LL_HEADER_OCTETS} + CRC ${LL_CRC_OCTETS} + MIC ${micOctets} + 前导码/AA，` +
			`L2CAP ${L2CAP_HEADER_OCTETS}，ATT ${ATT_HEADER_OCTETS}；` +
			`${dataLenOctets} octets 的 LL 载荷最终只交出 ${appOctetsPerLlPacket.toFixed(1)} octets 应用数据/包。`,
	)

	return {
		phy,
		phyLabel: BLE_PHYS[phy].label,
		dataLenOctets,
		encrypted,
		micOctets,
		pduOctets,
		packetTimeUs: packetUs,
		attMtuOctets,
		maxAttMtuForThisDataLenOctets: maxMtu,
		l2capSduOctets: dataLenOctets - L2CAP_HEADER_OCTETS,
		fragmentsPerAttPdu,
		appValueOctets: appValueOctets,
		appOctetsPerLlPacket,
		idealAppOctetsPerLlPacket,
		overhead: {
			llHeader: LL_HEADER_OCTETS,
			crc: LL_CRC_OCTETS,
			mic: micOctets,
			l2cap: L2CAP_HEADER_OCTETS,
			att: ATT_HEADER_OCTETS,
		},
		dataLength: { min: DLE_MIN_PAYLOAD_OCTETS, max: DLE_MAX_PAYLOAD_OCTETS },
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) 理论吞吐与瓶颈定位
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 理论吞吐与**瓶颈在哪一层**。
 *
 * 三个候选瓶颈各自的"天花板"（都是应用层 bps，取最小者即瓶颈）：
 *   · phy            ：物理层包时间（前导码/AA/CRC/MIC/T_IFS/ACK 的固定开销）→ 假设事件永不结束、MTU 完美匹配
 *   · packetsPerEvent：每事件包数受连接间隔与事件长度上限约束 → 间隔里装不满的那些"空档"是纯浪费
 *   · mtu            ：ATT_MTU 与 LL 载荷不匹配（太小则每包装不满，太大则分片留碎尾巴）
 *
 * 输出同时给三层的**损失比**，便于判断"先改哪个旋钮"。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - PHY id。
 * @param {number} input.dataLenOctets - 本端数据长度 octets（27–251）。
 * @param {number} input.encrypted - 连接是否加密（决定 MIC）。**必须显式给出**。
 * @param {number} input.connIntervalMs - 连接间隔 ms。
 * @param {number} [input.attMtuOctets] - ATT_MTU，默认规范默认值 23。
 * @param {number} [input.maxEventLengthUs] - 协议栈最大连接事件长度（设计值）。
 * @param {number} [input.maxPacketsPerEvent] - 协议栈每事件最多发包数（设计值）。
 * @param {number} [input.ackPayloadOctets] - 对端 ACK 捎带载荷，默认 0。
 * @param {number} [input.tIfsUs] - T_IFS，默认 150 µs。
 * @returns {object} 吞吐、三层损失比与瓶颈判定。
 */
export function analyzeThroughput({
	phy,
	dataLenOctets,
	encrypted,
	connIntervalMs,
	attMtuOctets = DEFAULT_ATT_MTU_OCTETS,
	maxEventLengthUs,
	maxPacketsPerEvent,
	ackPayloadOctets = 0,
	tIfsUs = T_IFS_US,
}) {
	const spec = requirePhy(phy)
	const link = analyzeDataLength({ phy, dataLenOctets, encrypted, attMtuOctets })

	const plan = planConnectionEvent({
		phy,
		dataLenOctets,
		micOctets: link.micOctets,
		connIntervalMs,
		maxEventLengthUs,
		maxPacketsPerEvent,
		ackPayloadOctets,
		tIfsUs,
	})

	const warnings = [...link.warnings, ...plan.warnings]
	const notes = [...plan.notes]

	// 每包实际交出的应用数据 vs 若 MTU 完美匹配时的理想值
	const appOctetsPerPacket = link.appOctetsPerLlPacket
	const idealAppOctetsPerPacket = link.idealAppOctetsPerLlPacket

	const intervalUs = plan.intervalUs
	const n = plan.packetsPerEvent
	const cycleUs = plan.cycleUs

	const appBps = (n * appOctetsPerPacket * 8 * 1e6) / intervalUs
	const idealEventBps = (n * idealAppOctetsPerPacket * 8 * 1e6) / intervalUs
	const idealPhyBps = (idealAppOctetsPerPacket * 8 * 1e6) / cycleUs

	const lossPhy = Math.max(0, 1 - idealPhyBps / spec.bitRateBps)
	const lossPackets = Math.max(0, 1 - idealEventBps / (idealPhyBps || 1))
	const lossMtu = Math.max(0, 1 - appBps / (idealEventBps || 1))

	const layers = [
		{ layer: 'phy', loss: lossPhy },
		{ layer: 'packetsPerEvent', loss: lossPackets },
		{ layer: 'mtu', loss: lossMtu },
	]
	// 次高者也不能忽略时提示"多因素"
	layers.sort((a, b) => b.loss - a.loss)
	const primary = layers[0]
	const bottleneckLayer = n < 1 ? 'packetsPerEvent' : primary.loss < 0.05 ? 'balanced' : primary.layer

	const layerText = {
		phy: '物理层的固定开销（前导码 / AA / CRC / MIC / 两个 T_IFS / 空包 ACK）',
		packetsPerEvent: '每个连接事件能塞进的包数（连接间隔与事件长度上限把时间切碎了）',
		mtu: 'ATT_MTU 与 LL 载荷不匹配（MTU 太小装不满，或 MTU 太大被 L2CAP 分片留碎尾巴）',
		balanced: '没有单一主导瓶颈',
	}
	notes.push(
		`瓶颈判定：**${layerText[bottleneckLayer]}**。三层损失比 —— ` +
			`物理层 ${(lossPhy * 100).toFixed(1)}% / 每事件包数 ${(lossPackets * 100).toFixed(1)}% / MTU ${(lossMtu * 100).toFixed(1)}%。`,
	)
	// 用 `== null` 同时覆盖 null 与 undefined：planConnectionEvent 未给协议栈包数上限时
	// 返回的是 **null**，只判 `undefined` 会让这条提示永不出现。
	if (bottleneckLayer === 'packetsPerEvent' && plan.packetsByStackCap == null) {
		notes.push(
			'注意：这里说的"每事件包数"只是连接间隔切出来的上限，协议栈实际能连发几个包必须实测 —— ' +
				'实测吞吐低于本模块理论值，绝大多数情况就是卡在这里。',
		)
	}

	// 连接间隔取"包周期整数倍"能显著减少空档
	const fill = plan.eventFillRatio
	if (n >= 1 && fill < 0.9) {
		const cycleMs = cycleUs / 1000
		const better = Math.ceil(cycleUs / 1000 / CONN_INTERVAL.stepMs) * CONN_INTERVAL.stepMs
		notes.push(
			`本事件只填充了 ${(fill * 100).toFixed(1)}% 的间隔（${n} 包 × ${cycleMs.toFixed(2)} ms = ${(plan.eventBusyUs / 1000).toFixed(2)} ms）。` +
				`把连接间隔调到包周期的整数倍附近（如 ≥${better.toFixed(2)} ms，或刚好等于 ${n} 个周期）可以白捡吞吐——` +
				'这也是"间隔调大一点反而更快"的原因。',
		)
	}

	const checks = [...link.checks]
	checks.push({
		name: '连接间隔下能塞进包',
		pass: n >= 1,
		detail: `每事件 ${n} 包（单包周期 ${cycleUs.toFixed(0)} µs，间隔 ${intervalUs.toFixed(0)} µs）`,
	})
	checks.push({
		name: '连接间隔步进',
		pass: isStepMultiple(connIntervalMs, CONN_INTERVAL.stepMs),
		detail: `${connIntervalMs} ms 需为 ${CONN_INTERVAL.stepMs} ms 的整数倍（规范单位 1.25 ms）`,
	})
	checks.push({
		name: '数据长度在 DLE 区间内',
		pass: dataLenOctets >= DLE_MIN_PAYLOAD_OCTETS && dataLenOctets <= DLE_MAX_PAYLOAD_OCTETS,
		detail: `${dataLenOctets} octets（规范 ${DLE_MIN_PAYLOAD_OCTETS}–${DLE_MAX_PAYLOAD_OCTETS}）`,
	})

	notes.push('以上是**理论值**：假设每个事件都发满、零丢包、对端总能立刻回空包 ACK，且每包都装满。')

	return {
		phy,
		phyLabel: spec.label,
		phyBitRateBps: spec.bitRateBps,
		dataLenOctets,
		attMtuOctets,
		connIntervalMs,
		intervalUs,
		packetsPerEvent: n,
		eventBusyUs: plan.eventBusyUs,
		eventFillRatio: fill,
		packetsByEventLength: plan.packetsByEventLength,
		packetsByStackCap: plan.packetsByStackCap,
		dataPacketUs: plan.dataPacketUs,
		ackPacketUs: plan.ackPacketUs,
		cycleUs,
		appOctetsPerPacket,
		fragmentsPerAttPdu: link.fragmentsPerAttPdu,
		throughput: {
			llPayloadBps: (n * dataLenOctets * 8 * 1e6) / intervalUs,
			l2capSduBps: (n * (dataLenOctets - L2CAP_HEADER_OCTETS) * 8 * 1e6) / intervalUs,
			attAppBps: appBps,
			llPayloadKbps: (n * dataLenOctets * 8) / (intervalUs / 1000),
			attAppKbps: (n * appOctetsPerPacket * 8) / (intervalUs / 1000),
		},
		ceilingsBps: {
			phy: idealPhyBps,
			packetsPerEvent: idealEventBps,
			mtu: appBps,
		},
		losses: { phy: lossPhy, packetsPerEvent: lossPackets, mtu: lossMtu },
		bottleneckLayer,
		bottleneckLoss: primary.loss,
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) 广播占空比与广播吞吐
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 广播占空比、广播数据速率与"可被扫描/连接"的时序约束。
 *
 * 一个广播事件 = 在 1~3 个主广播信道上各发一份同一个包（相邻包起始间隔 ≤ 10 ms）。
 * 事件频率 = 1 / (advInterval + advDelay)，advDelay 每次随机取 0–10 ms，
 * 所以占空比与数据速率都是一个**区间**（advDelay=0 最差、=10 ms 最好）。
 *
 * 主动扫描 / 可连接广播还要在每份广播包之后等对端的 SCAN_REQ / CONNECT_IND：
 * 监听窗口 = T_IFS + 对端包时间（由对端 PDU 载荷 octets 算出，是规范字段大小）。
 *
 * @param {object} input - 输入。
 * @param {string} input.phy - 广播所用 PHY id（legacy 广播在规范上只能用 LE 1M）。
 * @param {number} input.advIntervalMs - 广播间隔 ms（20 ms 起，0.625 ms 步进）。
 * @param {boolean} input.legacy - 是否 legacy 广播。**必须显式给出**。
 * @param {number} input.channelCount - 广播信道数 1–3（来自 channel map）。**必须显式给出**。
 * @param {number} input.advDataOctets - 单个包里 host 广播数据 octets（legacy ≤ 31；扩展每包 ≤ 254）。
 * @param {boolean} [input.expectResponse] - 是否需要在每包后监听 SCAN_REQ / CONNECT_IND，默认 false。
 * @param {'scanReq'|'connectInd'} [input.responseKind] - expectResponse=true 时必填。
 * @param {number} [input.extHeaderOctets] - 扩展广播的扩展头 octets（legacy 不用）。**设计细节，无默认**。
 * @param {number} [input.hostDataTotalOctets] - 扩展广播 host 侧总数据量（≤1650），用于算 AUX 链。
 * @param {string} [input.auxPhy] - AUX 包用的 PHY；不给则按与主信道同 PHY 计算（会在 notes 里说明）。
 * @returns {object} 占空比区间、数据速率与判定。
 */
export function analyzeAdvertising({
	phy,
	advIntervalMs,
	legacy,
	channelCount,
	advDataOctets,
	expectResponse = false,
	responseKind,
	extHeaderOctets,
	hostDataTotalOctets,
	auxPhy,
}) {
	const spec = requirePhy(phy)
	if (typeof legacy !== 'boolean') throw new Error('legacy 必须显式给出 true / false（legacy 与扩展广播的数据上限不同）')
	requireIntInRange(channelCount, 'channel_count', 1, PRIMARY_ADV_CHANNELS.length)
	requireIntInRange(advDataOctets, 'adv_data_octets', 0, ADV_PDU_PAYLOAD_MAX_OCTETS)
	if (!(advIntervalMs > 0)) throw new Error('adv_interval_ms 必须为正数')

	const checks = []
	const warnings = []
	const notes = []

	// ── 广播间隔合法性 ──
	checks.push({
		name: '广播间隔范围',
		pass: advIntervalMs >= ADV_INTERVAL.minMs && advIntervalMs <= ADV_INTERVAL.maxMs,
		detail: `${advIntervalMs} ms，规范 ${ADV_INTERVAL.minMs}–${ADV_INTERVAL.maxMs} ms`,
	})
	checks.push({
		name: '广播间隔步进',
		pass: isStepMultiple(advIntervalMs, ADV_INTERVAL.stepMs),
		detail: `${advIntervalMs} ms 需为 ${ADV_INTERVAL.stepMs} ms（0.625 ms）的整数倍`,
	})
	if (legacy && advIntervalMs < ADV_INTERVAL.minMs) {
		warnings.push('legacy 广播间隔下限就是 20 ms（Core 5.0 前非连接广播下限曾是 100 ms）。')
	}

	// ── 数据长度合法性 ──
	if (legacy) {
		if (phy !== 'le-1m') {
			warnings.push(`legacy 广播在规范上只能用 LE 1M PHY，这里给的是 ${spec.label}。`)
		}
		checks.push({
			name: 'legacy 广播数据 ≤ 31 octets',
			pass: advDataOctets <= LEGACY_ADV_DATA_MAX_OCTETS,
			detail: `${advDataOctets} octets，上限 ${LEGACY_ADV_DATA_MAX_OCTETS}（超出请改用扩展广播）`,
		})
	} else {
		if (extHeaderOctets === undefined || extHeaderOctets === null) {
			throw new Error('扩展广播必须给 ext_header_octets（扩展头 octets，随含哪些字段而变，属设计细节，无默认值）')
		}
		requireIntInRange(extHeaderOctets, 'ext_header_octets', 1, ADV_PDU_PAYLOAD_MAX_OCTETS)
		checks.push({
			name: '扩展广播单包 host 数据 ≤ 254 octets',
			pass: advDataOctets <= EXT_ADV_PER_PACKET_DATA_MAX_OCTETS,
			detail: `${advDataOctets} octets，上限 ${EXT_ADV_PER_PACKET_DATA_MAX_OCTETS}`,
		})
		checks.push({
			name: '扩展广播 PDU 载荷 ≤ 255 octets',
			pass: extHeaderOctets + advDataOctets <= ADV_PDU_PAYLOAD_MAX_OCTETS,
			detail: `扩展头 ${extHeaderOctets} + 数据 ${advDataOctets} = ${extHeaderOctets + advDataOctets}，上限 ${ADV_PDU_PAYLOAD_MAX_OCTETS}`,
		})
		if (hostDataTotalOctets !== undefined && hostDataTotalOctets !== null) {
			checks.push({
				name: '扩展广播 host 数据总量 ≤ 1650 octets',
				pass: hostDataTotalOctets <= EXT_ADV_HOST_DATA_MAX_OCTETS,
				detail: `${hostDataTotalOctets} octets，上限 ${EXT_ADV_HOST_DATA_MAX_OCTETS}`,
			})
		}
	}

	// ── 包时间 ──
	// legacy 广播包载荷 = AdvA 6 octets + AdvData；扩展广播的载荷 = 扩展头 + AdvData。
	const pduPayloadOctets = legacy ? LEGACY_ADV_PDU_PAYLOAD_MIN_OCTETS + advDataOctets : extHeaderOctets + advDataOctets
	const packetUs = packetTimeUs({ phy, payloadOctets: pduPayloadOctets, micOctets: 0 })

	// ── 事件内相邻包起始间隔 ≤ 10 ms ──
	if (expectResponse && responseKind === undefined) {
		throw new Error(
			`expect_response=true 时必须给 response_kind（${Object.keys(ADV_RESPONSE_PDU_PAYLOAD_OCTETS).join(' / ')}）`,
		)
	}
	const listenUs = expectResponse
		? T_IFS_US +
			packetTimeUs({ phy, payloadOctets: ADV_RESPONSE_PDU_PAYLOAD_OCTETS[responseKind], micOctets: 0 })
		: 0
	const gapUs = packetUs + T_IFS_US + listenUs
	checks.push({
		name: '事件内相邻包起始间隔 ≤ 10 ms',
		pass: channelCount < 2 || gapUs <= ADV_EVENT_MAX_PACKET_START_GAP_US,
		detail: `同信道内每包占用 ${gapUs.toFixed(0)} µs（包 ${packetUs.toFixed(0)} + T_IFS 150${listenUs > 0 ? ` + 监听 ${listenUs.toFixed(0)}` : ''}），上限 ${ADV_EVENT_MAX_PACKET_START_GAP_US} µs`,
	})

	// ── AUX 链（扩展广播的数据实际走副信道）──
	let aux = null
	let chainUs = 0
	if (!legacy && hostDataTotalOctets) {
		const auxSpec = requirePhy(auxPhy ?? phy)
		if (auxPhy === undefined) {
			notes.push(`未给 aux_phy，AUX 链按与主信道相同的 ${spec.label} 计算（实际可选 1M/2M/Coded，属设计选择）。`)
		}
		const perPacket = Math.min(advDataOctets, EXT_ADV_PER_PACKET_DATA_MAX_OCTETS)
		const chainPackets = Math.ceil(hostDataTotalOctets / perPacket)
		const auxPacketUs = packetTimeUs({ phy: auxSpec.id, payloadOctets: extHeaderOctets + perPacket, micOctets: 0 })
		chainUs = chainPackets * (auxPacketUs + T_IFS_US)
		aux = {
			phy: auxSpec.id,
			chainPackets,
			auxPacketUs,
			chainUs,
			chainDutyNote: 'AUX 链与主信道事件是**同一事件的不同阶段**，链必须在下一个广播事件前结束。',
		}
	}

	// ── 占空比与数据速率（advDelay 决定区间）──
	const txUs = channelCount * (packetUs + T_IFS_US) + chainUs
	const radioOnUs = channelCount * gapUs + chainUs
	const eventUs = txUs
	const perEventDataOctets = legacy ? advDataOctets : (hostDataTotalOctets ?? advDataOctets)

	const rateAt = (advDelayMs) => {
		const periodMs = advIntervalMs + advDelayMs
		const periodUs = periodMs * 1000
		return {
			advDelayMs,
			periodMs,
			eventsPerSecond: 1e6 / periodUs,
			txDutyPercent: (txUs / periodUs) * 100,
			radioOnDutyPercent: (radioOnUs / periodUs) * 100,
			dataRateBps: (perEventDataOctets * 8 * 1e6) / periodUs,
		}
	}
	const at0 = rateAt(0)
	const atMax = rateAt(ADV_DELAY_MAX_MS)

	checks.push({
		name: 'AUX 链装得进一个广播事件',
		pass: chainUs === 0 || txUs <= advIntervalMs * 1000,
		detail:
			chainUs === 0
				? '（legacy 广播无 AUX 链）'
				: `事件总占用 ${txUs.toFixed(0)} µs（含 AUX 链 ${chainUs.toFixed(0)} µs） vs 最短事件周期 ${(advIntervalMs * 1000).toFixed(0)} µs`,
	})
	if (chainUs > 0 && txUs > advIntervalMs * 1000) {
		warnings.push(
			`广播 + AUX 链共 ${(txUs / 1000).toFixed(2)} ms，超过最短事件周期 ${advIntervalMs} ms：` +
				'事件会互相挤，实际速率达不到计算值。拉长 advInterval 或减少每事件的数据量。',
		)
	}

	if (at0.radioOnDutyPercent > 10) {
		notes.push(
			`占空比偏高（${at0.radioOnDutyPercent.toFixed(2)}% 起）：广播是**纯 TX 且无 ACK 重传**，` +
				'平均电流基本正比于这个占空比，可以用它直接估电池寿命。',
		)
	}
	notes.push(
		`同一份 host 数据会在 ${channelCount} 个信道上各发一遍 —— 占空比按 ${channelCount} 份算，` +
			'但**数据速率只算一份**（信道数不增加信息量，只提高被扫到的概率）。',
	)
	notes.push(
		'advDelay（0–10 ms 随机）是规范强制的抖动，用来避免两台设备长期撞在一起；' +
			'它使实际占空比比 advInterval 单独算出来的更低，代价是扫描端必须覆盖更宽的时间窗。',
	)

	return {
		phy,
		phyLabel: spec.label,
		legacy,
		channelCount,
		advIntervalMs,
		advDataOctets,
		pduPayloadOctets,
		packetUs,
		listenUs,
		eventTxUs: txUs,
		eventRadioOnUs: radioOnUs,
		perEventDataOctets,
		aux,
		duty: { advDelay0Ms: at0, advDelayMaxMs: atMax },
		throughput: { dataRateBpsAt0: at0.dataRateBps, dataRateBpsAtMax: atMax.dataRateBps },
		channelOffsetsUs: PRIMARY_ADV_CHANNELS.slice(0, channelCount).map((c, i) => ({
			channel: c.index,
			mhz: c.mhz,
			startOffsetUs: i * gapUs,
		})),
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) 扫描端：占空比与"多久能被发现"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 扫描参数与发现时间估算。
 *
 * 硬约束：Scan_Window ≤ Scan_Interval（规范），两者都是 2.5 ms–10.24 s、0.625 ms 步进。
 * 扫描窗口内要在三个主广播信道之间轮转，所以单信道驻留时间 ≈ Scan_Window / 3，
 * **驻留时间必须 ≥ 广播包时间**，否则该信道上包还没发完就跳走了。
 *
 * 发现时间是**估算**：假设相位随机均匀、无丢包，用"一个扫描窗口（+广播事件时长）落在
 * 一个扫描周期内的概率"来推期望。
 *
 * @param {object} input - 输入。
 * @param {number} input.scanIntervalMs - 扫描间隔 ms。
 * @param {number} input.scanWindowMs - 扫描窗口 ms（≤ scanIntervalMs）。
 * @param {number} input.advPacketUs - 被扫的广播包时间（µs），由 analyzeAdvertising 给出。
 * @param {number} input.advIntervalMs - 被扫设备的广播间隔 ms。
 * @param {number} [input.channelCount] - 被扫设备使用的广播信道数，默认 3（规范上 legacy 广播最多 3 个）。
 * @param {number} [input.advDelayMaxMs] - advDelay 上限，默认 ADV_DELAY_MAX_MS = 10 ms。
 * @returns {object} 占空比与发现时间估算。
 */
export function analyzeScanning({
	scanIntervalMs,
	scanWindowMs,
	advPacketUs,
	advIntervalMs,
	channelCount = PRIMARY_ADV_CHANNELS.length,
	advDelayMaxMs = ADV_DELAY_MAX_MS,
}) {
	requireIntInRange(channelCount, 'channel_count', 1, PRIMARY_ADV_CHANNELS.length)
	if (!(scanIntervalMs > 0) || !(scanWindowMs > 0)) throw new Error('scan_interval_ms 与 scan_window_ms 必须为正数')
	if (!(advPacketUs > 0) || !(advIntervalMs > 0)) throw new Error('adv_packet_us 与 adv_interval_ms 必须为正数')

	const checks = []
	const warnings = []
	const notes = []

	checks.push({
		name: '扫描窗口 ≤ 扫描间隔',
		pass: scanWindowMs <= scanIntervalMs,
		detail: `${scanWindowMs} ms vs ${scanIntervalMs} ms（规范硬约束；相等即连续扫描）`,
	})
	checks.push({
		name: '扫描参数范围',
		pass:
			scanIntervalMs >= SCAN_INTERVAL.minMs &&
			scanIntervalMs <= SCAN_INTERVAL.maxMs &&
			scanWindowMs >= SCAN_INTERVAL.minMs &&
			scanWindowMs <= SCAN_INTERVAL.maxMs,
		detail: `范围 ${SCAN_INTERVAL.minMs}–${SCAN_INTERVAL.maxMs} ms`,
	})
	checks.push({
		name: '扫描参数步进',
		pass: isStepMultiple(scanIntervalMs, SCAN_INTERVAL.stepMs) && isStepMultiple(scanWindowMs, SCAN_INTERVAL.stepMs),
		detail: `两者都需为 ${SCAN_INTERVAL.stepMs} ms 的整数倍（规范单位 0.625 ms）`,
	})

	const dwellUs = (scanWindowMs * 1000) / channelCount
	checks.push({
		name: '单信道驻留 ≥ 广播包时间',
		pass: dwellUs >= advPacketUs,
		detail: `驻留 ≈ ${dwellUs.toFixed(0)} µs（窗口 ${scanWindowMs} ms / ${channelCount} 信道） vs 包 ${advPacketUs.toFixed(0)} µs`,
	})
	if (dwellUs < advPacketUs) {
		warnings.push(
			`单信道驻留 ${dwellUs.toFixed(0)} µs 短于一个广播包（${advPacketUs.toFixed(0)} µs）：` +
				'在信道上驻留期间可能整包都没发完就跳走了，会明显漏掉广播。加大扫描窗口或减少信道数。',
		)
	}

	const scanDutyPercent = (Math.min(scanWindowMs, scanIntervalMs) / scanIntervalMs) * 100
	if (scanWindowMs > scanIntervalMs) {
		warnings.push(
			`扫描窗口 ${scanWindowMs} ms > 扫描间隔 ${scanIntervalMs} ms，规范不允许（窗口等于间隔就是连续扫描，再大没有意义）。` +
				'下面的占空比已按窗口 = 间隔截断。',
		)
	}
	const advEventUs = channelCount * (advPacketUs + T_IFS_US)
	const coverUs = scanWindowMs * 1000 + advEventUs
	const catchProb = Math.min(1, coverUs / (scanIntervalMs * 1000))
	const expectedEvents = catchProb > 0 ? 1 / catchProb : Infinity
	const meanAdvPeriodMs = advIntervalMs + advDelayMaxMs / 2
	const expectedDiscoverMs = expectedEvents * meanAdvPeriodMs

	notes.push(
		`广播事件时长 ≈ ${(advEventUs / 1000).toFixed(2)} ms（${channelCount} 信道 × (包 ${advPacketUs.toFixed(0)} + T_IFS 150)），` +
			`扫描覆盖概率 ≈ (窗口 ${scanWindowMs} ms + 事件 ${(advEventUs / 1000).toFixed(2)} ms) / 周期 ${scanIntervalMs} ms = ${(catchProb * 100).toFixed(1)}%。`,
	)
	notes.push(
		`发现时间 ≈ 覆盖概率的倒数 × 平均广播周期 = ${expectedDiscoverMs.toFixed(0)} ms。` +
			'这是**估算**：假设相位随机均匀、无丢包、无同频碰撞；真实环境下信道拥塞与丢包会让它变长，必须实测。',
	)
	notes.push('连续扫描（window = interval）可以发现得最快，但接收机常开，功耗最高——这是"响应速度 vs 电池"的直接取舍。')

	return {
		scanIntervalMs,
		scanWindowMs,
		scanDutyPercent,
		channelCount,
		perChannelDwellUs: dwellUs,
		advPacketUs,
		advEventUs,
		catchProbability: catchProb,
		expectedEventsToBeSeen: expectedEvents,
		expectedDiscoverEstimateMs: expectedDiscoverMs,
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) 连接参数的合法性
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在给定连接间隔与监督超时下，Slave Latency 的**最大合法值**。
 *
 * 由 [S3] 的不等式反解：latency ≤ timeout / (2 × subrateFactor × interval) − 1，再取整数与规范上限 499。
 *
 * @param {object} input - 输入。
 * @param {number} input.connIntervalMs - 连接间隔 ms。
 * @param {number} input.supervisionTimeoutMs - 监督超时 ms。
 * @param {number} [input.subrateFactor] - 连接子速率因子，默认 1（普通连接）。
 * @returns {number} 最大合法 Slave Latency（可能为负，表示该组合本身就非法）。
 */
export function maxLegalSlaveLatency({ connIntervalMs, supervisionTimeoutMs, subrateFactor = 1 }) {
	if (!(connIntervalMs > 0) || !(supervisionTimeoutMs > 0)) throw new Error('连接间隔与监督超时都必须为正数')
	if (!(subrateFactor >= 1)) throw new Error('subrate_factor 必须 ≥ 1（普通连接为 1）')
	const raw = Math.floor(supervisionTimeoutMs / (2 * subrateFactor * connIntervalMs) - 1)
	let candidate = Math.min(raw, CONN_LATENCY.max)
	// 回代自检：规范是**严格**不等式 timeout > (1+latency)·sub·interval·2。
	// 整除边界时 floor 会给出刚好不满足严格不等式的值（如 100ms/2000ms 算出 9，
	// 但 latency=9 要求 timeout > 2000ms 不成立）——回代验证，不满足就回退一步。
	while (candidate > 0 && !(supervisionTimeoutMs > (1 + candidate) * subrateFactor * connIntervalMs * 2)) {
		candidate -= 1
	}
	return candidate
}

/**
 * 校验一组连接参数（连接间隔 / Slave Latency / Supervision Timeout）是否合法、是否稳健。
 *
 * 规范可判定项（全部来自 [S2]/[S3]）：
 *   ① 连接间隔落在 7.5 ms–4 s，且是 1.25 ms 的整数倍
 *   ② Slave Latency ∈ 0–499
 *   ③ Supervision Timeout ∈ 100 ms–32 s，且是 10 ms 的整数倍
 *   ④ timeout > (1 + latency) × subrateFactor × interval × 2   ← 规范硬约束
 *   ⑤ 由 ④ 推出的上限：latency ≤ timeout / (2 × sub × interval) − 1
 * 另可给**可选**的厂商余量系数（如某些手机厂商推荐 timeout ≥ 3×，`:vendorTimeoutFactor`），不内置默认值。
 *
 * @param {object} input - 输入。
 * @param {number} input.connIntervalMs - 连接间隔 ms。
 * @param {number} input.latency - Slave Latency（可跳过的连接事件数）。
 * @param {number} input.supervisionTimeoutMs - 监督超时 ms。
 * @param {number} [input.subrateFactor] - 连接子速率因子，默认 1。
 * @param {number} [input.vendorTimeoutFactor] - 可选的厂商余量系数（如 3），不给就不判这一条。
 * @param {string} [input.vendorNote] - 厂商系数出处的自由说明。
 * @returns {object} 判定结果与派生的时间量。
 */
export function checkConnectionParams({
	connIntervalMs,
	latency,
	supervisionTimeoutMs,
	subrateFactor = 1,
	vendorTimeoutFactor,
	vendorNote,
}) {
	if (!(connIntervalMs > 0) || !(supervisionTimeoutMs > 0)) throw new Error('连接间隔与监督超时都必须为正数')
	if (!Number.isInteger(latency) || latency < 0) throw new Error('latency 必须是非负整数')
	if (!(subrateFactor >= 1)) throw new Error('subrate_factor 必须 ≥ 1（普通连接为 1）')

	const checks = []
	const warnings = []
	const notes = []

	checks.push({
		name: '连接间隔范围',
		pass: connIntervalMs >= CONN_INTERVAL.minMs && connIntervalMs <= CONN_INTERVAL.maxMs,
		detail: `${connIntervalMs} ms，规范 ${CONN_INTERVAL.minMs}–${CONN_INTERVAL.maxMs} ms`,
	})
	checks.push({
		name: '连接间隔步进',
		pass: isStepMultiple(connIntervalMs, CONN_INTERVAL.stepMs),
		detail: `${connIntervalMs} ms 需为 ${CONN_INTERVAL.stepMs} ms（1.25 ms）的整数倍`,
	})
	checks.push({
		name: 'Slave Latency 范围',
		pass: latency >= CONN_LATENCY.min && latency <= CONN_LATENCY.max,
		detail: `${latency}，规范 ${CONN_LATENCY.min}–${CONN_LATENCY.max}`,
	})
	checks.push({
		name: '监督超时范围',
		pass: supervisionTimeoutMs >= SUPERVISION_TIMEOUT.minMs && supervisionTimeoutMs <= SUPERVISION_TIMEOUT.maxMs,
		detail: `${supervisionTimeoutMs} ms，规范 ${SUPERVISION_TIMEOUT.minMs}–${SUPERVISION_TIMEOUT.maxMs} ms`,
	})
	checks.push({
		name: '监督超时步进',
		pass: isStepMultiple(supervisionTimeoutMs, SUPERVISION_TIMEOUT.stepMs),
		detail: `${supervisionTimeoutMs} ms 需为 ${SUPERVISION_TIMEOUT.stepMs} ms 的整数倍`,
	})

	const silenceWindowMs = (1 + latency) * subrateFactor * connIntervalMs
	const minRequiredMs = 2 * silenceWindowMs
	const timeoutOk = supervisionTimeoutMs > minRequiredMs
	checks.push({
		name: 'timeout > (1 + latency) × sub × interval × 2',
		pass: timeoutOk,
		detail:
			`需要 > ${minRequiredMs} ms（跳过窗口 ${silenceWindowMs} ms），实际 ${supervisionTimeoutMs} ms` +
			`${timeoutOk ? '' : ' —— 参数组合非法，对端会拒绝'}`,
	})
	if (!timeoutOk) {
		warnings.push(
			'该组合**违反规范硬约束**：如果从机可以连续跳过 ' +
				`${latency} 个事件（= ${silenceWindowMs} ms 不吭声），链路会在这之前就被判超时断开。` +
				`把 timeout 提高到 > ${minRequiredMs} ms（且取 10 ms 倍数），或把 latency 降到 ≤ ${maxLegalSlaveLatency({ connIntervalMs, supervisionTimeoutMs, subrateFactor })}。`,
		)
	}

	const legalMaxLatency = maxLegalSlaveLatency({ connIntervalMs, supervisionTimeoutMs, subrateFactor })
	if (legalMaxLatency < 0 && timeoutOk) {
		warnings.push('按下限推不出任何合法的 latency，请复核参数。')
	}

	if (vendorTimeoutFactor !== undefined && vendorTimeoutFactor !== null) {
		const want = vendorTimeoutFactor * silenceWindowMs
		const pass = supervisionTimeoutMs >= want
		checks.push({
			name: `厂商余量：timeout ≥ ${vendorTimeoutFactor} × 跳过窗口`,
			pass,
			detail: `${supervisionTimeoutMs} ms vs ${want} ms${vendorNote ? `（${vendorNote}）` : ''}`,
		})
		if (!pass) {
			warnings.push(
				`按 ${vendorTimeoutFactor}× 余量不足：空中瞬时拥塞连续丢几个事件就可能被判超时断开。` +
					'规范只要求 2×，但工程上（尤其是要给手机 / 网关连接时）通常留更大余量。',
			)
		}
	} else {
		notes.push('未给 vendor_timeout_factor，只按规范下限 2× 判定。手机厂商的连接参数推荐值更严（属设计约束，本模块不内置）。')
	}

	notes.push(
		`Slave Latency 的物理含义：从机最多可以连续跳过 ${latency} 个连接事件不回复，` +
			`即最坏自报间隔 ${silenceWindowMs} ms。**latency 不降低吞吐**（有数据时从机照样事件一到就回），` +
			'它只降低"空闲时的唤醒次数"，是纯粹的空载省电手段。',
	)
	notes.push(
		'Supervision Timeout 的工程取舍：规范给的是**下限关系**（2×），上界 32 s。' +
			'太短 → 丢几个包就假断连；太长 → 设备走远或关机后要等很久才发现，重连体验差。这两个时间量必须实测验证。',
	)
	notes.push(
		'本函数只判规范可判定项。对端（手机 / 网关）是否接受这组参数、实际协商到哪个连接间隔，' +
			'必须在真机上抓包确认 —— 从机只能"申请"，主设备说了算。',
	)

	return {
		connIntervalMs,
		latency,
		supervisionTimeoutMs,
		subrateFactor,
		peripheralSilenceWindowMs: silenceWindowMs,
		minRequiredTimeoutMs: minRequiredMs,
		legal: checks.every((c) => c.pass),
		maxLegalLatency: legalMaxLatency,
		effectiveIntervalMs: connIntervalMs,
		worstCaseResponseIntervalMs: silenceWindowMs,
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 7) 速查表
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 三种 PHY 在"最大 DLE 包 + 加密"下的包时间与周期速查（含 1M/2M/Coded 对比）。
 *
 * @param {boolean} encrypted - 连接是否加密（决定有没有 4 octets MIC）。**必须显式给出**。
 * @param {number} [dataLenOctets] - 数据长度，默认取 DLE 上限 251 octets（规范值）。
 * @returns {Array<object>} 每个 PHY 一行的对比表。
 */
export function comparePhys(encrypted, dataLenOctets = DLE_MAX_PAYLOAD_OCTETS) {
	if (typeof encrypted !== 'boolean') {
		throw new Error('encrypted 必须显式给出 true / false（加密连接的数据包多 4 octets MIC，无默认值）')
	}
	requireIntInRange(dataLenOctets, 'data_len_octets', DLE_MIN_PAYLOAD_OCTETS, DLE_MAX_PAYLOAD_OCTETS)
	const micOctets = encrypted ? LL_MIC_OCTETS : 0
	return BLE_PHY_IDS.map((id) => {
		const cycle = packetCycleUs({ phy: id, dataLenOctets, micOctets })
		return {
			phy: id,
			label: BLE_PHYS[id].label,
			bitRateBps: BLE_PHYS[id].bitRateBps,
			packetUs: cycle.dataPacketUs,
			emptyPacketUs: packetTimeUs({ phy: id, payloadOctets: 0, micOctets: 0 }),
			cycleUs: cycle.cycleUs,
			/** 若能无限发包（间隔足够长）时的应用层上限。 */
			ceilingAppBps: ((dataLenOctets - L2CAP_HEADER_OCTETS - ATT_HEADER_OCTETS) * 8 * 1e6) / cycle.cycleUs,
		}
	})
}