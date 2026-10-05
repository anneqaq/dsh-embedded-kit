/**
 * LoRa 空中时间（Time on Air）与 EU868 占空比法规。
 *
 * 本模块只做两件事：
 *   1. 按 Semtech 的空中时间公式，由 SF / BW / CR / payload 长度 / 前导长度算出**总空中时间**；
 *   2. 把空中时间放到 ETSI 的占空比法规下，判定"这个发送周期合不合规"。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 出处登记（2026-09 联网核实）
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 【A】空中时间公式
 *   Semtech《SX1276/77/78/79 Low Power Long Range Transceiver Datasheet》Rev.7 (2020-05)
 *   §4.1.1.7 "Time on air"；同一组公式也出现在 Semtech AN1200.13
 *   《LoRa Modem Designer's Guide》。核实到的原文形式：
 *
 *       Ts        = 2^SF / BW                              （符号时间）
 *       Tpreamble = (npreamble + 4.25) × Ts                  （前导，+4.25 是固定的帧同步开销）
 *       npayload  = 8 + max( ceil( (8PL − 4SF + 28 + 16CRC − 20IH) / (4(SF − 2DE)) ) × (CR + 4), 0 )
 *       Tpayload  = npayload × Ts
 *       Tpacket   = Tpreamble + Tpayload
 *
 *   依赖项（数据手册原文）：PL 为 payload 字节数 1~255；SF 为 6~12（SX1276 系列）；
 *   IH = 0 表示**带**显式包头，IH = 1 表示**不带**包头（隐式）；DE = 1 表示
 *   LowDataRateOptimize 打开；CR = 1~4 分别对应编码率 4/5、4/6、4/7、4/8。
 *   分子里的 28 是 Semtech 公式的固定开销项，20 是包头的位数，16 是 payload CRC 的位数。
 *
 * 【B】LDRO（低数据率优化）
 *   同一数据手册 §4.1.1.6：LowDataRateOptimize 的"使用在符号时长超过 16 ms 时是强制的
 *   （its use is mandated when the symbol duration exceeds 16ms）"，且**收发两端必须一致**。
 *   本模块的 'auto' 就按这条 16 ms 规则走，不是臆造阈值。注意：忘记置位 LDRO 时
 *   SF11/SF12 @125 kHz 的接收端会解不出来，但**算出来的空中时间会偏小**——这是最坑的地方。
 *
 * 【C】EU868 占空比与发射时长
 *   ETSI EN 300 220-2 V3.2.2 (2024-03)，Table 2「Equipment Operating frequency bands and
 *   technical parameters」，863~870 MHz 部分（原文摘录，e.r.p. 与 duty cycle 均为原文数值）：
 *
 *     K0  862,000–863,000 MHz  25 mW   ≤ 0,1 % duty cycle
 *     K   863–865 MHz          25 mW   ≤ 0,1 % duty cycle 或 polite spectrum access
 *     L   865–868 MHz          25 mW   ≤ 1 %   duty cycle 或 polite spectrum access
 *     M   868,000–868,600 MHz  25 mW   ≤ 1 %   duty cycle 或 polite spectrum access
 *     N   868,700–869,200 MHz  25 mW   ≤ 0,1 % duty cycle 或 polite spectrum access
 *     O   869,400–869,650 MHz  500 mW  ≤ 10 %  duty cycle 或 polite spectrum access
 *     P   869,700–870,000 MHz  5 mW    No requirement（无占空比要求）
 *     Q   869,700–870,000 MHz  25 mW   ≤ 1 %   duty cycle 或 polite spectrum access
 *     V   863–870 MHz          25 mW   ≤ 0,1 % duty cycle（FHSS，≥47 跳频信道，dwell ≤ 400 ms）
 *
 *   同一标准 §4.4.3.2 给出占空比定义："Duty cycle is the ratio expressed as a percentage,
 *   of the cumulative duration of transmissions Ton_cum within an observation interval Tobs on
 *   an observation bandwidth Fobs. Unless otherwise specified, Tobs is 1 hour and the
 *   observation bandwidth Fobs is the Permitted Frequency Band."
 *   → 默认观察窗 Tobs = 1 小时，且**按整个子频段**统计（不是按单个信道）。
 *
 *   §4.4.3.1 Applicability："The duty cycle requirement shall apply to all transmitters except
 *   equipment operating in bands K, L, M, N, O, Q or W using polite spectrum access."
 *   → 占空比与 polite spectrum access 是**二选一**的两条合规路径，不是叠加约束。
 *
 *   §4.4.12 短时行为（Ton / Toff）："The short term behaviour requirement shall apply to
 *   equipment when Ton or Toff limits are specified in NRI"，且 §4.4.12.3 说限值"as specified
 *   in Table 2 or in NRI"。**Table 2 对 K/L/M/N/O/P/Q 并没有给出 Ton/Toff**——所以本模块
 *   **不会**替 868 MHz 的 LoRa 子频段编造"单次最长发射 X 秒"。要把 Ton/Toff 纳入判定，
 *   必须由调用方通过 maxOnTimeSec / minOffTimeSec 显式传入（并注明来源，例如某个国家的 NRI）。
 *   Table 2 里出现 Ton_max 的只有 X / Y 频段（ER-GSM 保护，Ton_max ≤ 5 ms/1 s），与 LoRa 无关。
 *
 *   作为对照，另一条合规路径 polite spectrum access 的时限在 **Table 16「Limits for Polite
 *   Spectrum Access timing parameters」**（原文数值，一字未改）：
 *     Minimum CCA interval                        160 µs
 *     Maximum Transmission Duration Ton  Max 1 s  For a single transmission
 *     Maximum Transmission Duration Ton  Max 4 s  For a transmission dialogue or a polling sequence
 *     Max Tcum_on over 1 hour            100 s/1 h per 200 kHz spectrum
 *     Minimum Toff_min at the same nominal operating frequency   100 ms
 *   这组 1 s / 4 s / 100 ms / 100 s-per-200kHz 只在**走 polite spectrum access 时**才适用。
 *
 * 【D】LoRaWAN / TTN 侧的限值（网络策略，不是频谱法规）
 *   - LoRaWAN 的 EU868 三个强制信道为 868,1 / 868,3 / 868,5 MHz（125 kHz，DR0~DR5），
 *     受限 1 % 占空比；LoRa Alliance 建议欧洲频段整体按 1 % 占空比使用（最大 +16 dBm EIRP）。
 *   - TTN（The Things Network）Fair Use Policy：**每节点每日上行空中时间 ≤ 30 s**，
 *     **每节点每日下行 ≤ 10 条**。
 *   这些是**网络方的策略**，与 ETSI 法规是两套东西，本模块分开处理。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 哪些是设计值、哪些必须实测
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 本模块算出的空中时间是**公式口径的理论值**（Semtech 公式按奈奎斯特采样点近似），
 *     真实硬件还会多出 TX 起振/PLL 锁定/PA ramp 的时间（SX127x 量级为毫秒级），
 *     以及 MCU 到射频的 SPI 传输时间。做**法规**预算时这部分不能忽略——
 *     请用 extraOverheadSec 显式传入你实测/数据手册标注的值，本模块不内置这个数。
 *   · 法规判定依赖你传进来的 subband / regime。子频段的"实际落在哪一段"取决于你的
 *     信道中心频率与占用带宽，必须按最终产品实测占用带宽（99 % OBW）来定，不能靠推算。
 *   · 占空比是**法规符合性测试**测出来的量（EN 300 220-2 §5.4.3 用功率采样统计 Ton），
 *     本模块给的是设计期预算，不能替代测试报告。
 *   · 灵敏度 / 发射功率 / 天线增益必须来自具体器件的数据手册与实测，本模块不内置。
 *
 * @module dsh-embedded-kit/lora
 */

// ─────────────────────────────────────────────────────────────────────────────
// 常量
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 空中时间公式里的固定常数。
 *
 * 这些是**公式自带的数值**（Semtech 数据手册 §4.1.1.7 原文），不是可调的设计参数，
 * 因此内置并在此注明出处；其余参数（SF/BW/CR/payload/前导/包头/CRC/LDRO）一律由调用方给。
 */
export const AIRTIME_FORMULA_CONSTANTS = Object.freeze({
	/** 前导时长的固定开销：Tpreamble = (npreamble + 4.25) × Ts。 */
	preambleOverheadSymbols: 4.25,
	/** 公式分子的固定开销项（数据手册写死的 28）。 */
	fixedOverheadBits: 28,
	/** 显式包头对应的位数：IH=1（无包头）时从分子里减掉 20。 */
	headerBits: 20,
	/** payload CRC 位数：CRC 打开时分子 +16。 */
	crcBits: 16,
	/** 无论 payload 多小，payload 段至少有 8 个符号（数据手册公式的常数项）。 */
	basePayloadSymbols: 8,
	/** 编码率分母偏移：编码率 4/(CR+4)，CR ∈ [1,4]。 */
	codingRateDenominatorOffset: 4,
})

/** 编码率名字 → 公式里的 CR 取值。出处：Semtech 数据手册 §4.1.1.7 依赖项说明。 */
export const CODING_RATES = Object.freeze({
	'4/5': 1,
	'4/6': 2,
	'4/7': 3,
	'4/8': 4,
})

/**
 * LDRO 的强制门限：符号时长 > 16 ms 时 LowDataRateOptimize 必须打开。
 *
 * 出处：Semtech SX1276/77/78/79 数据手册 Rev.7 §4.1.1.6
 * "its use is mandated when the symbol duration exceeds 16ms"。
 * 在 125 kHz 带宽下等价于 SF11（16.384 ms）与 SF12（32.768 ms）。
 */
export const LDRO_SYMBOL_TIME_LIMIT_SEC = 0.016

/**
 * EU868 子频段（ETSI EN 300 220-2 V3.2.2 Table 2，863~870 MHz 部分）。
 *
 * 字段说明：
 *   · dutyCycle —— 法规占空比上限（小数）。null 表示 Table 2 写的是 "No requirement"。
 *   · politeSpectrumAccess —— 该子频段是否允许用 polite spectrum access（LBT+AFA）**替代**占空比。
 *   · maxErpMw —— Table 2 的 "Maximum effective radiated power, e.r.p."，单位 mW（原文口径）。
 *   · maxOnTimeSec / minOffTimeSec —— 保持 null：Table 2 对这些子频段**没有**规定 Ton/Toff
 *     （见文件头 §C 的说明）。不要往这里填猜的数。
 *   · 这些是**法规参数**，调用方可以整体覆盖（传入自己的对象即可），本模块不锁定。
 */
export const EU868_SUBBANDS = Object.freeze({
	k0: Object.freeze({
		id: 'k0',
		band: 'K0',
		label: 'K0 / 862.0–863.0 MHz',
		fromMHz: 862.0,
		toMHz: 863.0,
		maxErpMw: 25,
		dutyCycle: 0.001,
		politeSpectrumAccess: false,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	k: Object.freeze({
		id: 'k',
		band: 'K',
		label: 'K / 863–865 MHz',
		fromMHz: 863.0,
		toMHz: 865.0,
		maxErpMw: 25,
		dutyCycle: 0.001,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	l: Object.freeze({
		id: 'l',
		band: 'L',
		label: 'L / 865–868 MHz',
		fromMHz: 865.0,
		toMHz: 868.0,
		maxErpMw: 25,
		dutyCycle: 0.01,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	m: Object.freeze({
		id: 'm',
		band: 'M',
		label: 'M / 868.0–868.6 MHz（LoRaWAN 三个强制信道在此段）',
		fromMHz: 868.0,
		toMHz: 868.6,
		maxErpMw: 25,
		dutyCycle: 0.01,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	n: Object.freeze({
		id: 'n',
		band: 'N',
		label: 'N / 868.7–869.2 MHz',
		fromMHz: 868.7,
		toMHz: 869.2,
		maxErpMw: 25,
		dutyCycle: 0.001,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	o: Object.freeze({
		id: 'o',
		band: 'O',
		label: 'O / 869.4–869.65 MHz（LoRaWAN RX2 / 下行常用）',
		fromMHz: 869.4,
		toMHz: 869.65,
		maxErpMw: 500,
		dutyCycle: 0.1,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	p: Object.freeze({
		id: 'p',
		band: 'P',
		label: 'P / 869.7–870.0 MHz',
		fromMHz: 869.7,
		toMHz: 870.0,
		maxErpMw: 5,
		// Table 2 原文就是 "No requirement"：没有占空比上限。5 mW 的功率上限是这里的实际约束。
		dutyCycle: null,
		politeSpectrumAccess: false,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	q: Object.freeze({
		id: 'q',
		band: 'Q',
		label: 'Q / 869.7–870.0 MHz',
		fromMHz: 869.7,
		toMHz: 870.0,
		maxErpMw: 25,
		dutyCycle: 0.01,
		politeSpectrumAccess: true,
		maxOnTimeSec: null,
		minOffTimeSec: null,
	}),
	v: Object.freeze({
		id: 'v',
		band: 'V',
		label: 'V / 863–870 MHz（FHSS，≥47 跳频信道）',
		fromMHz: 863.0,
		toMHz: 870.0,
		maxErpMw: 25,
		dutyCycle: 0.001,
		politeSpectrumAccess: false,
		// FHSS 的 Ton 由 §4.4.11.3 d) 给出：dwell time ≤ 400 ms（这是唯一在 Table 2 之外
		// 对 868 段明确规定单次发射时长的条款，且只适用于跳频设备）。
		maxOnTimeSec: 0.4,
		minOffTimeSec: null,
	}),
})

/**
 * polite spectrum access 的时限（ETSI EN 300 220-2 V3.2.2 Table 16，原文数值）。
 *
 * 只有设备**选择走 polite spectrum access**（替代占空比）时才适用这组限值。
 */
export const POLITE_SPECTRUM_ACCESS_LIMITS = Object.freeze({
	/** Minimum CCA interval：最小 CCA 侦听时长。 */
	ccaMinSec: 160e-6,
	/** Maximum Transmission Duration Ton，For a single transmission：单次发射上限。 */
	maxSingleTransmissionSec: 1,
	/** Maximum Transmission Duration Ton，For a transmission dialogue or a polling sequence。 */
	maxDialogueSec: 4,
	/** Max Tcum_on over 1 hour：每 200 kHz 频谱每小时的累计发射时间上限。 */
	maxCumulativeOnSecPerHourPer200kHz: 100,
	/** Minimum Toff_min at the same nominal operating frequency：发射后在同一频点必须静默的时长。 */
	minOffTimeSec: 0.1,
	/** Table 16 所在版本。 */
	source: 'ETSI EN 300 220-2 V3.2.2 (2024-03) Table 16',
})

/**
 * 占空比法规的观察窗默认值。
 *
 * 出处：EN 300 220-2 §4.4.3.2 —— "Unless otherwise specified, Tobs is 1 hour and the
 * observation bandwidth Fobs is the Permitted Frequency Band."
 * 也就是说：默认按**小时**统计，且统计范围是**整个子频段**而不是单个信道。
 */
export const DUTY_CYCLE_OBSERVATION_WINDOW_SEC = 3600

/** LoRaWAN EU868 的强制信道（TTN《Regional Limitations of RF Use》）。 */
export const LORAWAN_EU868_MANDATORY_CHANNELS_MHZ = Object.freeze([868.1, 868.3, 868.5])

/**
 * TTN Fair Use Policy 的上行/下行额度（网络方策略，非频谱法规）。
 *
 * 出处：TTN 文档与多篇论文引用口径一致 —— 每节点每日上行空中时间 30 s，
 * 每节点每日下行 10 条消息。私有网络不受此限，但仍受 ETSI 限制。
 */
export const TTN_FAIR_USE_POLICY = Object.freeze({
	uplinkAirTimeSecPerDay: 30,
	downlinkMessagesPerDay: 10,
	source: 'The Things Network Fair Use Policy',
})

/**
 * ADR 与发射功率说明。
 *
 * 这里**只说明它们各自影响什么**，不给任何阈值——具体的链路余量门限、SF 回退步长、
 * 起始 SF 都是网络服务器（NS）的实现策略，不在 LoRaWAN 规范里写死，不能预设。
 */
export const ADR_TX_POWER_NOTES = Object.freeze([
	'ADR（自适应数据速率）影响的是"你实际会用哪个 SF / 哪个发射功率 / 哪个信道"，' +
		'于是间接决定了每次发送的空中时间和占空比开销；ADR 本身不改变任何法规限值。',
	'ADR 依赖上行链路余量做判决，只对静止终端成立。移动终端按 LoRaWAN 规范必须关闭 ADR，' +
		'否则网络服务器会拿过时的链路余量给出不合适的 SF。',
	'开了 ADR 之后"单包空中时间"不是定值：做占空比预算必须按**最坏情况（允许的最大 SF）**算。' +
		'本模块的 analyzeLinkPlan 就是按你给的 SF 上限算的，不给平均值的假象。',
	'发射功率只改变链路余量和电流消耗，**不改变空中时间**（时间由 SF/BW/CR/前导/payload 决定）。' +
		'所以"加功率"省不了占空比，"降 SF"才省——这是两个不同维度的旋钮。',
	'发射功率有两条上限，取小者：法规侧是该子频段的 max e.r.p.（见 EU868_SUBBANDS）；' +
		'硬件侧是 PA 与模块数据手册的额定输出。天线增益会改变 e.i.r.p.，必须一并计入。',
	'在 EN 300 220-2 里，占空比与发射功率是**两个独立约束**，都要各自满足；' +
		'该标准的占空比表格不随发射功率放宽，不存在"功率降一点就多占点时间"的换算。',
])

/** SF 每加一级的理论扩频增益（10·log10 2），说明用；实际灵敏度以数据手册 Sensitivity 表为准。 */
export const SF_STEP_THEORETICAL_GAIN_DB = 10 * Math.log10(2)

// ─────────────────────────────────────────────────────────────────────────────
// 内部参数校验
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 校验扩频因子。范围按 Semtech SX1276/77/78/79 数据手册的 SF 6~12；
 * 其他系列的芯片（SX126x）支持到 SF5，请直接传值，本函数不拦。
 *
 * @param {number} sf - 扩频因子。
 */
function assertSf(sf) {
	if (!Number.isInteger(sf) || sf < 1 || sf > 12) {
		throw new Error(`sf 必须是 1~12 的整数（SX127x 为 6~12），收到 ${sf}`)
	}
}

/**
 * 校验带宽。按公式口径必须传 Hz（例如 125000），不是 kHz。
 *
 * 这里是**单位防呆**而不是规范限值：Semtech 的带宽寄存器最低档是 7.8 kHz，
 * 任何以 Hz 为单位的合法带宽都 ≥ 7800 Hz，所以小于 1000 的值只可能是
 * "把 kHz 当 Hz 传了"。不拦的话 Ts = 2^SF / BW 会静默算出大 1000 倍的结果。
 *
 * @param {number} bwHz - 带宽（Hz）。
 */
function assertBw(bwHz) {
	if (!(bwHz > 0)) throw new Error(`bwHz 必须是正数且单位为 Hz（例如 125000），收到 ${bwHz}`)
	if (bwHz < 1000) {
		throw new Error(
			`bwHz=${bwHz} 太小，几乎可以肯定你传的是 kHz。本模块按公式口径要 Hz：125 kHz 请传 125000。`,
		)
	}
}

/**
 * 校验前导符号数。范围取寄存器 RegPreambleMsb/Lsb 的 6~65535。
 *
 * @param {number} preambleSymbols - 前导符号数。
 */
function assertPreamble(preambleSymbols) {
	if (!Number.isInteger(preambleSymbols) || preambleSymbols < 6 || preambleSymbols > 65535) {
		throw new Error(`preambleSymbols 必须是 6~65535 的整数（RegPreamble 的范围），收到 ${preambleSymbols}`)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 空中时间
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 符号时间 Ts = 2^SF / BW。
 *
 * @param {number} sf - 扩频因子（SX127x 系列为 6~12）。
 * @param {number} bwHz - 带宽（Hz，按公式口径是 Hz 而不是 kHz）。
 * @returns {number} 符号时间（秒）。
 */
export function symbolTimeSec(sf, bwHz) {
	assertSf(sf)
	assertBw(bwHz)
	return 2 ** sf / bwHz
}

/**
 * 前导时长 Tpreamble = (npreamble + 4.25) × Ts。
 *
 * @param {object} input - 输入。
 * @param {number} input.sf - 扩频因子。
 * @param {number} input.bwHz - 带宽（Hz）。
 * @param {number} input.preambleSymbols - 编程进 RegPreamble 的前导符号数（LoRaWAN 用 8；Meshtastic 用 16）。
 * @returns {number} 前导时长（秒）。
 */
export function preambleDurationSec({ sf, bwHz, preambleSymbols }) {
	assertPreamble(preambleSymbols)
	return (preambleSymbols + AIRTIME_FORMULA_CONSTANTS.preambleOverheadSymbols) * symbolTimeSec(sf, bwHz)
}

/**
 * 编码率归一化：'4/5' 或数字 1 都能接受。
 *
 * @param {string|number} codingRate - '4/5'|'4/6'|'4/7'|'4/8' 或 1|2|3|4。
 * @returns {number} 公式里的 CR 值（1~4）。
 */
export function codingRateValue(codingRate) {
	if (typeof codingRate === 'string') {
		const v = CODING_RATES[codingRate]
		if (v === undefined) {
			throw new Error(`未知的编码率：${codingRate}（可用：${Object.keys(CODING_RATES).join(' / ')}，或 1~4）`)
		}
		return v
	}
	if (!Number.isInteger(codingRate) || codingRate < 1 || codingRate > 4) {
		throw new Error(`编码率 CR 必须是 1~4 的整数（对应 4/5~4/8），收到 ${codingRate}`)
	}
	return codingRate
}

/**
 * LDRO 是否强制：符号时长 > 16 ms（Semtech 数据手册 §4.1.1.6）。
 *
 * @param {number} sf - 扩频因子。
 * @param {number} bwHz - 带宽（Hz）。
 * @returns {boolean} 是否必须打开 LowDataRateOptimize。
 */
export function ldroRequired(sf, bwHz) {
	return symbolTimeSec(sf, bwHz) > LDRO_SYMBOL_TIME_LIMIT_SEC
}

/**
 * 解析 LDRO 取值。'auto' 按数据手册的 16 ms 规则，不是猜的。
 *
 * @param {boolean|'auto'} ldro - true / false / 'auto'。
 * @param {number} sf - 扩频因子。
 * @param {number} bwHz - 带宽（Hz）。
 * @returns {boolean} 实际使用的 DE 值。
 */
function resolveLdro(ldro, sf, bwHz) {
	if (ldro === 'auto') return ldroRequired(sf, bwHz)
	if (typeof ldro !== 'boolean') {
		throw new Error(`ldro 只能是 true / false / 'auto'，收到 ${JSON.stringify(ldro)}`)
	}
	return ldro
}

/**
 * payload 段符号数 npayload。
 *
 *   npayload = 8 + max( ceil( (8PL − 4SF + 28 + 16CRC − 20IH) / (4(SF − 2DE)) ) × (CR + 4), 0 )
 *
 * @param {object} input - 输入。
 * @param {number} input.sf - 扩频因子。
 * @param {number} input.codingRate - 编码率（'4/5' 或 1~4）。
 * @param {number} input.payloadBytes - payload 字节数 PL（1~255，PHY 层口径）。
 * @param {boolean} input.crc - 是否带 payload CRC（对应公式里 CRC 取 1）。
 * @param {boolean} input.implicitHeader - 是否使用隐式包头（true 对应 IH = 1，公式里减 20）。
 * @param {boolean} input.ldro - 是否打开 LDRO（对应 DE）。
 * @returns {{ payloadSymbols: number, betaSymbols: number, numeratorBits: number, denominator: number }}
 *   payload 符号数及中间量（便于核对公式）。
 */
export function payloadSymbolCount({ sf, codingRate, payloadBytes, crc, implicitHeader, ldro }) {
	assertSf(sf)
	const cr = codingRateValue(codingRate)
	if (!Number.isInteger(payloadBytes) || payloadBytes < 1 || payloadBytes > 255) {
		throw new Error(`payloadBytes 必须是 1~255 的整数（PHY 层字节数），收到 ${payloadBytes}`)
	}
	if (typeof crc !== 'boolean') throw new Error(`crc 必须是布尔值（是否带 payload CRC），收到 ${JSON.stringify(crc)}`)
	if (typeof implicitHeader !== 'boolean') {
		throw new Error(`implicitHeader 必须是布尔值（是否隐式包头），收到 ${JSON.stringify(implicitHeader)}`)
	}
	if (typeof ldro !== 'boolean') throw new Error(`ldro 必须是布尔值（是否打开 LDRO），收到 ${JSON.stringify(ldro)}`)

	const c = AIRTIME_FORMULA_CONSTANTS
	const numeratorBits = 8 * payloadBytes - 4 * sf + c.fixedOverheadBits + (crc ? c.crcBits : 0) - (implicitHeader ? c.headerBits : 0)
	const denominator = 4 * (sf - 2 * (ldro ? 1 : 0))
	if (denominator <= 0) {
		throw new Error(`SF=${sf} 配 LDRO=${ldro} 时分母 4(SF−2DE)=${denominator} 非正，参数组合无意义`)
	}
	const betaSymbols = Math.ceil(numeratorBits / denominator)
	const payloadSymbols = c.basePayloadSymbols + Math.max(betaSymbols * (cr + c.codingRateDenominatorOffset), 0)
	return { payloadSymbols, betaSymbols, numeratorBits, denominator }
}

/**
 * 完整空中时间分解。
 *
 * 返回的是**公式口径的理论值**：不含 TX 起振 / PLL 锁定 / PA ramp / SPI 传输时间。
 * 做法规预算时那部分必须另加（见 analyzeAirTime 的 extraOverheadSec）。
 *
 * @param {object} input - 输入。
 * @param {number} input.sf - 扩频因子（6~12）。
 * @param {number} input.bwHz - 带宽（Hz）。
 * @param {string|number} input.codingRate - 编码率。
 * @param {number} input.preambleSymbols - 前导符号数。
 * @param {number} input.payloadBytes - PHY 层 payload 字节数（1~255）。
 * @param {boolean} input.crc - 是否带 payload CRC。
 * @param {boolean} input.implicitHeader - 是否隐式包头。
 * @param {boolean|'auto'} [input.ldro] - LDRO；'auto' 按 16 ms 规则自动判定。若省略则视为 'auto'。
 * @returns {object} 空中时间分解（秒）。
 */
export function airTime({
	sf,
	bwHz,
	codingRate,
	preambleSymbols,
	payloadBytes,
	crc,
	implicitHeader,
	ldro = 'auto',
}) {
	const tsSec = symbolTimeSec(sf, bwHz)
	const ldroUsed = resolveLdro(ldro, sf, bwHz)
	const requiredLdro = ldroRequired(sf, bwHz)
	const counts = payloadSymbolCount({ sf, codingRate, payloadBytes, crc, implicitHeader, ldro: ldroUsed })
	const cr = codingRateValue(codingRate)

	const tpreambleSec = preambleDurationSec({ sf, bwHz, preambleSymbols })
	const tpayloadSec = counts.payloadSymbols * tsSec
	const toaSec = tpreambleSec + tpayloadSec
	const totalSymbols = preambleSymbols + AIRTIME_FORMULA_CONSTANTS.preambleOverheadSymbols + counts.payloadSymbols

	// 标称（奈奎斯特）比特率：Rb = SF × (BW / 2^SF) × 4/(CR+4)。
	// 这是简化式，用来做量级判断；实际吞吐还要再被前导/包头/CRC 摊薄。
	const nominalBitRateBps = sf * (bwHz / 2 ** sf) * (4 / (cr + 4))

	return {
		sf,
		bwHz,
		codingRate: cr,
		codingRateLabel: `${4}/${cr + 4}`,
		preambleSymbols,
		payloadBytes,
		crc,
		implicitHeader,
		ldro: ldroUsed,
		ldroRequired: requiredLdro,
		ldroMismatch: ldroUsed !== requiredLdro,
		tsSec,
		tpreambleSec,
		payloadSymbols: counts.payloadSymbols,
		betaSymbols: counts.betaSymbols,
		numeratorBits: counts.numeratorBits,
		denominator: counts.denominator,
		tpayloadSec,
		toaSec,
		totalSymbols,
		nominalBitRateBps,
		/** payload 的有效吞吐（把前导和包头都算掉的"实测会看到"的速率）。 */
		payloadBitRateBps: (payloadBytes * 8) / toaSec,
	}
}

/**
 * 空中时间 + 结构性检查（LDRO、payload 上限、编码率）。
 *
 * @param {object} input - 与 airTime 相同，另加：
 * @param {number} [input.extraOverheadSec] - 额外的射频起振 / ramp / SPI 时间（秒）。
 *   本模块**不给默认值**：SX127x 量级是毫秒级，具体值必须按你的模块数据手册或实测填。
 * @param {number} [input.maxPayloadBytes] - 该 SF/BW 下规范允许的最大 PHY payload 字节数。
 *   不给就不判（LoRaWAN 区域参数里各 DR 的上限不同，不能一刀切）。
 * @returns {object} `{ checks, warnings, notes, ...空中时间数值 }`
 */
export function analyzeAirTime(input) {
	const { extraOverheadSec, maxPayloadBytes } = input
	const base = airTime(input)

	if (extraOverheadSec !== undefined && !(extraOverheadSec >= 0)) {
		throw new Error(`extraOverheadSec 必须是非负数（秒），收到 ${extraOverheadSec}`)
	}
	const overheadSec = extraOverheadSec ?? 0
	const totalOnAirSec = base.toaSec + overheadSec

	const checks = []
	const warnings = []
	const notes = []

	if (base.ldroMismatch) {
		warnings.push(
			`SF=${base.sf} / BW=${base.bwHz} 的符号时间 ${(base.tsSec * 1000).toFixed(3)} ms ` +
				`${base.ldroRequired ? '超过' : '未超过'} 16 ms 门限，但你选的 LDRO=${base.ldro} 与手册要求` +
				`${base.ldroRequired ? '（应打开）' : '（应关闭）'}不一致。收发两端 LDRO 必须一致，否则收不到。`,
		)
	}

	checks.push({
		name: 'LDRO 设置',
		pass: !base.ldroMismatch,
		detail:
			`Ts=${(base.tsSec * 1000).toFixed(3)} ms，16 ms 门限 → 要求 LDRO=` +
			`${base.ldroRequired ? 'on' : 'off'}，实际 ${base.ldro ? 'on' : 'off'}（Semtech §4.1.1.6）`,
	})

	if (maxPayloadBytes !== undefined) {
		const ok = base.payloadBytes <= maxPayloadBytes
		checks.push({
			name: 'payload 长度上限',
			pass: ok,
			detail: `PL=${base.payloadBytes} 字节，给定上限 ${maxPayloadBytes} 字节`,
		})
		if (!ok) {
			warnings.push(
				`payload ${base.payloadBytes} 字节超过给定上限 ${maxPayloadBytes} 字节。` +
					`注意 LoRaWAN 的 MAC 层还会再加约 13 字节（MHDR + FHDR + FPort + MIC），` +
					`换算成 PHY payload 时要一起算进去。`,
			)
		}
	} else {
		notes.push('未给 maxPayloadBytes，未判 payload 上限。LoRaWAN 各 DR 的 payload 上限不同，请按区域参数传。')
	}

	if (overheadSec > 0) {
		notes.push(
			`已叠加额外的 ${(overheadSec * 1000).toFixed(3)} ms 射频/MCU 开销：` +
				`总在线时长 ${(totalOnAirSec * 1000).toFixed(3)} ms。这部分不是公式项，来源必须由调用方负责。`,
		)
	} else {
		notes.push(
			'未叠加 TX 起振 / PLL 锁定 / PA ramp / SPI 传输时间。SX127x 量级为毫秒级；' +
				'做**法规**占空比预算时应通过 extraOverheadSec 加上你实测或数据手册标注的值。',
		)
	}

	notes.push(
		`公式口径（Semtech SX1276 数据手册 Rev.7 §4.1.1.7 / AN1200.13）：` +
			`Ts=2^SF/BW=${(base.tsSec * 1000).toFixed(6)} ms，` +
			`Tpreamble=(${base.preambleSymbols}+4.25)×Ts=${(base.tpreambleSec * 1000).toFixed(3)} ms，` +
			`npayload=${base.payloadSymbols} 符号 → Tpayload=${(base.tpayloadSec * 1000).toFixed(3)} ms。`,
	)

	return {
		checks,
		warnings,
		notes,
		...base,
		overheadSec,
		totalOnAirSec,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 占空比法规
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在给定观察窗内，某个占空比上限允许的累计发射时间。
 *
 * @param {number} dutyCycle - 占空比上限（小数，例如 0.01 表示 1%）。null / undefined 视为无限制。
 * @param {number} windowSec - 观察窗长度（秒），ETSI 默认 3600。
 * @returns {number|null} 允许的累计发射秒数；无限制时返回 null。
 */
export function maxTransmitSecPerWindow(dutyCycle, windowSec) {
	if (dutyCycle === null || dutyCycle === undefined) return null
	if (!(dutyCycle > 0 && dutyCycle <= 1)) throw new Error(`dutyCycle 必须落在 (0, 1] 内，收到 ${dutyCycle}`)
	if (!(windowSec > 0)) throw new Error(`windowSec 必须为正数，收到 ${windowSec}`)
	return dutyCycle * windowSec
}

/**
 * 在给定观察窗内，按占空比上限最多能发几包。
 *
 * @param {number} airTimeSec - 单包（含额外开销）的在线时长（秒）。
 * @param {number} dutyCycle - 占空比上限（小数）。
 * @param {number} windowSec - 观察窗长度（秒）。
 * @returns {number|null} 允许的包数（向下取整）；无限制时返回 null。
 */
export function maxPacketsPerWindow(airTimeSec, dutyCycle, windowSec) {
	const budgetSec = maxTransmitSecPerWindow(dutyCycle, windowSec)
	if (budgetSec === null) return null
	if (!(airTimeSec > 0)) throw new Error(`airTimeSec 必须为正数，收到 ${airTimeSec}`)
	return Math.floor(budgetSec / airTimeSec)
}

/**
 * 发完一包之后必须静默多久才能再发（占空比路径）。
 *
 * 由 Ton / (Ton + Toff) ≤ DC 推出 Toff ≥ Ton × (1/DC − 1)。
 * 这是按"连续等间隔发送"这个最坏解释算的：EN 300 220-2 §4.4.3.2 统计的是
 * 观察窗内的**累计** Ton，所以严格地说只要一小时内的累计量不超即可；
 * 但很多收发器/网络栈是按"发一包必须静默 Toff"来做限流的（例如 LoRaWAN 的 duty cycle 限流），
 * 所以本模块同时给出这两种口径，别只信一个。
 *
 * @param {number} airTimeSec - 单包（含额外开销）的在线时长（秒）。
 * @param {number} dutyCycle - 占空比上限（小数）。
 * @returns {number|null} 最小静默时长（秒）；无限制时返回 null。
 */
export function requiredSilenceSec(airTimeSec, dutyCycle) {
	if (dutyCycle === null || dutyCycle === undefined) return null
	if (!(airTimeSec > 0)) throw new Error(`airTimeSec 必须为正数，收到 ${airTimeSec}`)
	if (!(dutyCycle > 0 && dutyCycle <= 1)) throw new Error(`dutyCycle 必须落在 (0, 1] 内，收到 ${dutyCycle}`)
	return airTimeSec * (1 / dutyCycle - 1)
}

/**
 * 两包之间的最小周期（起-起）：Tperiod ≥ Ton / DC。
 *
 * @param {number} airTimeSec - 单包（含额外开销）的在线时长（秒）。
 * @param {number} dutyCycle - 占空比上限（小数）。
 * @returns {number|null} 最小周期（秒）；无限制时返回 null。
 */
export function minPeriodSec(airTimeSec, dutyCycle) {
	if (dutyCycle === null || dutyCycle === undefined) return null
	if (!(airTimeSec > 0)) throw new Error(`airTimeSec 必须为正数，收到 ${airTimeSec}`)
	return airTimeSec / dutyCycle
}

/**
 * 求得某个子频段定义（内置的 EU868 表，或调用方传入的自定义对象）。
 *
 * @param {string|object} subband - EU868_SUBBANDS 的 key，或直接给一个同形状的对象。
 * @returns {object} 子频段定义。
 */
export function resolveSubband(subband) {
	if (typeof subband === 'string') {
		const found = EU868_SUBBANDS[subband]
		if (!found) {
			throw new Error(`未知的 EU868 子频段：${subband}（可用：${Object.keys(EU868_SUBBANDS).join(' / ')}）`)
		}
		return found
	}
	if (subband && typeof subband === 'object') return subband
	throw new Error('subband 必须是 EU868_SUBBANDS 的 key 或一个子频段对象')
}

/**
 * 占空比合规判定。
 *
 * 两条互斥的合规路径（EN 300 220-2 §4.4.3.1）：
 *   · regime = 'duty-cycle'             —— 按子频段的占空比上限判；
 *   · regime = 'polite-spectrum-access' —— 按 Table 16 的 Ton/Toff/Tcum 判，**不**再受占空比约束。
 *
 * @param {object} input - 输入。
 * @param {number} input.airTimeSec - 单包在线时长（秒，含 extraOverheadSec）。
 *   ⚠ 注意口径：占空比统计的是**射频实际在线时间**，所以这里应该传 totalOnAirSec 而不是公式 ToA。
 * @param {string|object} input.subband - 子频段（EU868_SUBBANDS 的 key 或自定义对象）。
 * @param {'duty-cycle'|'polite-spectrum-access'} [input.regime] - 合规路径，默认 'duty-cycle'。
 * @param {number} [input.windowSec] - 观察窗（秒），默认 3600（ETSI 默认 Tobs = 1 h）。
 * @param {number} [input.targetPeriodSec] - 期望的发送周期（起-起，秒）。给了就判"这个周期合不合规"。
 * @param {number} [input.packetsPerWindow] - 或者直接给"每个观察窗想发几包"。与 targetPeriodSec 二选一。
 * @param {number} [input.maxOnTimeSec] - 单次发射时长上限（秒）。不给则用子频段定义里的值；
 *   两者都没有时**不做这项判定**并给出说明——ETSI Table 2 对 868 的 LoRa 子频段没有规定 Ton。
 *   ⚠ 这个值必须来自法规/NRI 或网络策略，不要凭感觉填。
 * @param {number} [input.minOffTimeSec] - 最小静默时长（秒，法规口径）。不给则用子频段定义里的值。
 * @param {number} [input.networkAirTimeSecPerDay] - 网络侧每日上行空中时间额度（秒），例如 TTN 的 30 s。
 * @returns {object} `{ checks, warnings, notes, ...判定与预算数值 }`
 */
export function analyzeDutyCycle(input) {
	const {
		airTimeSec,
		targetPeriodSec,
		packetsPerWindow,
		regime = 'duty-cycle',
		windowSec = DUTY_CYCLE_OBSERVATION_WINDOW_SEC,
		networkAirTimeSecPerDay,
	} = input

	if (!(airTimeSec > 0)) throw new Error(`airTimeSec 必须为正数（秒），收到 ${airTimeSec}`)
	if (regime !== 'duty-cycle' && regime !== 'polite-spectrum-access') {
		throw new Error(`regime 只能是 'duty-cycle' 或 'polite-spectrum-access'，收到 ${regime}`)
	}
	const band = resolveSubband(input.subband)

	const checks = []
	const warnings = []
	const notes = []

	// 统计口径说明 —— 这是最容易搞错的一点：占空比按**整个子频段**统计，不是按单个信道。
	notes.push(
		`统计口径（EN 300 220-2 §4.4.3.2）：占空比 = 观察窗内累计发射时间 / 观察窗，` +
			`默认观察窗 ${windowSec} s（ETSI 默认 Tobs = 1 h），` +
			`观察带宽 Fobs 是**整个子频段**（${band.label}），不是单个信道。` +
			`即：在 ${band.label} 内任何一个信道发过，都算进同一份额度。`,
	)

	// 包数：优先 targetPeriodSec，其次 packetsPerWindow。
	/** @type {number|null} */
	let packets = null
	let packetBasis = '未指定'
	if (targetPeriodSec !== undefined && targetPeriodSec !== null) {
		if (!(targetPeriodSec > 0)) throw new Error(`targetPeriodSec 必须为正数，收到 ${targetPeriodSec}`)
		packets = windowSec / targetPeriodSec
		packetBasis = `按周期 ${targetPeriodSec} s 在 ${windowSec} s 内均匀发送 → ${packets.toFixed(3)} 包`
	} else if (packetsPerWindow !== undefined && packetsPerWindow !== null) {
		if (!(packetsPerWindow >= 0)) throw new Error(`packetsPerWindow 必须非负，收到 ${packetsPerWindow}`)
		packets = packetsPerWindow
		packetBasis = `显式给定 ${packets} 包 / ${windowSec} s`
	}

	const usedTransmitSec = packets === null ? null : packets * airTimeSec
	const usedDutyCycle = usedTransmitSec === null ? null : usedTransmitSec / windowSec

	if (packets !== null) {
		notes.push(packetBasis)
	}

	/** @type {object} */
	const result = {
		regime,
		subband: band.id ?? null,
		subbandLabel: band.label,
		airTimeSec,
		windowSec,
		packets,
		usedTransmitSec,
		usedDutyCycle,
		// 下面这些按 regime 填
		effectiveDutyCycleLimit: null,
		maxTransmitSecPerHour: null,
		maxTransmitSecPerDay: null,
		maxPacketsPerHour: null,
		maxPacketsPerDay: null,
		minPeriodSec: null,
		requiredSilenceSec: null,
	}

	if (regime === 'duty-cycle') {
		const dc = band.dutyCycle
		result.effectiveDutyCycleLimit = dc ?? null
		result.maxTransmitSecPerHour = maxTransmitSecPerWindow(dc, 3600)
		result.maxTransmitSecPerDay = maxTransmitSecPerWindow(dc, 86400)
		result.maxPacketsPerHour = maxPacketsPerWindow(airTimeSec, dc, 3600)
		result.maxPacketsPerDay = maxPacketsPerWindow(airTimeSec, dc, 86400)
		result.minPeriodSec = minPeriodSec(airTimeSec, dc)
		result.requiredSilenceSec = requiredSilenceSec(airTimeSec, dc)

		if (dc === null) {
			checks.push({
				name: '占空比',
				pass: true,
				detail: `${band.label} 在 Table 2 里是 "No requirement"，没有占空比上限；实际约束是该段的 e.r.p. ≤ ${band.maxErpMw} mW。`,
			})
			notes.push(
				`${band.label} 无占空比要求，但仍受 e.r.p. ≤ ${band.maxErpMw} mW 限制，` +
					`且必须避开 Table 2 列出的告警频段。`,
			)
		} else {
			const dcOk = usedDutyCycle === null ? true : usedDutyCycle <= dc
			checks.push({
				name: '占空比',
				pass: dcOk,
				detail:
					usedDutyCycle === null
						? `上限 ${(dc * 100).toFixed(3)}%，未给发送周期/包数，只给出预算：每小时 ≤ ${result.maxTransmitSecPerHour.toFixed(1)} s`
						: `实际 ${(usedDutyCycle * 100).toFixed(4)}% vs 上限 ${(dc * 100).toFixed(3)}%（窗口 ${windowSec} s 内累计 ${usedTransmitSec.toFixed(3)} s）`,
			})
			if (!dcOk) {
				warnings.push(
					`超出占空比：窗口 ${windowSec} s 内累计发射 ${usedTransmitSec.toFixed(3)} s ` +
						`= ${(usedDutyCycle * 100).toFixed(4)}%，上限 ${(dc * 100).toFixed(3)}%` +
						`（对应 ≤ ${result.maxTransmitSecPerHour.toFixed(1)} s/h、≤ ${result.maxPacketsPerHour} 包/h）。` +
						`要么拉长周期到 ≥ ${result.minPeriodSec.toFixed(3)} s，要么降 payload，要么降 SF。`,
				)
			}
			notes.push(
				`上限 ${(dc * 100).toFixed(3)}% 的两条等价口径：` +
					`见 §4.4.3.2 的"累计 Ton 不超过 ${(result.maxTransmitSecPerHour).toFixed(1)} s/h"；` +
					`以及常见的"发完必须静默 ≥ ${result.requiredSilenceSec.toFixed(3)} s"` +
					`（最小周期 ${result.minPeriodSec.toFixed(3)} s）。前者是法规原文口径，后者是多数协议栈的限流实现口径。`,
			)
		}
	}

	if (regime === 'polite-spectrum-access') {
		const psa = POLITE_SPECTRUM_ACCESS_LIMITS
		if (!band.politeSpectrumAccess && band.id) {
			warnings.push(
				`${band.label} 在 Table 2 里**没有**写 "or polite spectrum access"，` +
					`该子频段不能靠 LBT+AFA 替代占空比。请改用占空比路径。`,
			)
		}
		const singleOk = airTimeSec <= psa.maxSingleTransmissionSec
		checks.push({
			name: 'polite spectrum access 单次发射',
			pass: singleOk,
			detail: `Ton=${airTimeSec.toFixed(3)} s vs 上限 ${psa.maxSingleTransmissionSec} s（Table 16，单次发射）`,
		})
		if (!singleOk) {
			warnings.push(
				`单次发射 ${airTimeSec.toFixed(3)} s 超过 Table 16 的 1 s 上限。` +
					`Table 16 另有"一次传输对话/轮询序列 ≤ 4 s"，但那要求拆成多段、中间留出 CCA 与静默。`,
			)
		}
		result.maxTransmitSecPerHour = psa.maxCumulativeOnSecPerHourPer200kHz
		result.maxPacketsPerHour = Math.floor(psa.maxCumulativeOnSecPerHourPer200kHz / airTimeSec)
		result.maxPacketsPerDay = Math.floor((psa.maxCumulativeOnSecPerHourPer200kHz * 24) / airTimeSec)
		result.maxTransmitSecPerDay = psa.maxCumulativeOnSecPerHourPer200kHz * 24
		result.requiredSilenceSec = psa.minOffTimeSec
		result.minPeriodSec = airTimeSec + psa.minOffTimeSec
		if (packets !== null) {
			const cumOk = packets * airTimeSec <= psa.maxCumulativeOnSecPerHourPer200kHz
			checks.push({
				name: 'polite spectrum access 累计在线',
				pass: cumOk,
				detail:
					`每 200 kHz 每小时累计 ${(packets * airTimeSec).toFixed(3)} s vs 上限 ` +
					`${psa.maxCumulativeOnSecPerHourPer200kHz} s`,
			})
			if (!cumOk) {
				warnings.push(
					`走 polite spectrum access 时，每 200 kHz 频谱每小时累计发射不得超过 ${psa.maxCumulativeOnSecPerHourPer200kHz} s；` +
						`当前等效为 ${(packets * airTimeSec).toFixed(3)} s/h（超过时可通过更多 AFA 信道摊薄，见 Table 16 注）。`,
				)
			}
		}
		notes.push(
			`polite spectrum access 来自 ${psa.source}：CCA ≥ ${(psa.ccaMinSec * 1e6).toFixed(0)} µs、` +
				`单次 Ton ≤ ${psa.maxSingleTransmissionSec} s、对话/轮询序列 ≤ ${psa.maxDialogueSec} s、` +
				`每 200 kHz 每小时累计 ≤ ${psa.maxCumulativeOnSecPerHourPer200kHz} s、同频点 Toff ≥ ${psa.minOffTimeSec * 1000} ms。` +
				`选择这条路径时，§4.4.3.1 明确**不再**叠加占空比约束。`,
		)
	}

	// 单次发射时长 / 最小静默：只在有来源时才判，绝不替 868 的 LoRa 子频段编一个值。
	if (regime === 'duty-cycle') {
		const maxOn = input.maxOnTimeSec ?? band.maxOnTimeSec
		if (maxOn !== null && maxOn !== undefined) {
			const ok = airTimeSec <= maxOn
			checks.push({
				name: '单次发射时长',
				pass: ok,
				detail: `Ton=${airTimeSec.toFixed(3)} s vs 上限 ${maxOn} s`,
			})
			if (!ok) warnings.push(`单次发射 ${airTimeSec.toFixed(3)} s 超过给定的 Ton 上限 ${maxOn} s。`)
		} else {
			checks.push({
				name: '单次发射时长',
				pass: true,
				detail: `${band.label} 未规定 Ton（Table 2 对 K/L/M/N/O/P/Q 无 Ton/Toff）→ 本项不作为合规条件`,
			})
			notes.push(
				`**未判定单次发射时长**：EN 300 220-2 §4.4.12 的 Ton/Toff 只在 "specified in Table 2 or in NRI" 时适用，` +
					`而 Table 2 对 ${band.label} 没有规定。需要判这一条时，请用 maxOnTimeSec 传入你所在国家 NRI 的数值` +
					`（本模块不会替你猜）。`,
			)
		}
		const minOff = input.minOffTimeSec ?? band.minOffTimeSec
		if (minOff !== null && minOff !== undefined) {
			checks.push({
				name: '最小静默时长',
				pass: true,
				detail: `法规要求 ≥ ${minOff} s；占空比路径由公式给出的静默需求为 ${result.requiredSilenceSec?.toFixed(3) ?? 'n/a'} s`,
			})
		}
	}

	// 网络侧额度（与法规是两套约束，分开判）
	if (networkAirTimeSecPerDay !== undefined && networkAirTimeSecPerDay !== null) {
		const perDay = packets === null ? null : (packets * airTimeSec * 86400) / windowSec
		if (perDay !== null) {
			const ok = perDay <= networkAirTimeSecPerDay
			checks.push({
				name: '网络侧每日上行空中时间',
				pass: ok,
				detail: `等效 ${perDay.toFixed(2)} s/天 vs 额度 ${networkAirTimeSecPerDay} s/天`,
			})
			if (!ok) {
				warnings.push(
					`即使频谱法规过得去，网络侧额度也不够：等效 ${perDay.toFixed(2)} s/天 > ${networkAirTimeSecPerDay} s/天。` +
						`这是网络方策略（例如 TTN Fair Use Policy 的 ${TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay} s/天），不是频谱法规。`,
				)
			}
		} else {
			notes.push(
				`给了网络侧每日额度 ${networkAirTimeSecPerDay} s，但没有发送周期/包数，无法折算成每日量。` +
					`按该额度和当前空中时间，每天最多 ${Math.floor(networkAirTimeSecPerDay / airTimeSec)} 包。`,
			)
		}
	}

	return { checks, warnings, notes, ...result }
}

// ─────────────────────────────────────────────────────────────────────────────
// 链路侧：SF 的影响
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 同一 payload 在不同 SF 下的空中时间与占空比可行性对比。
 *
 * 说清楚一件事：SF 每加一级，Ts 翻倍，符号数也大约翻倍量级，
 * 于是空中时间约翻倍、占空比允许的包数约减半——这就是"灵敏度和占空比不可兼得"的定量形式。
 * 本函数**不预测灵敏度**：灵敏度必须来自器件数据手册的 Sensitivity 表。
 *
 * @param {object} input - 输入。
 * @param {number[]} [input.sfList] - 要对比的 SF 列表，默认 [7,8,9,10,11,12]（EU868 DR0~DR5 常用）。
 * @param {number} input.bwHz - 带宽（Hz）。
 * @param {string|number} input.codingRate - 编码率。
 * @param {number} input.preambleSymbols - 前导符号数。
 * @param {number} input.payloadBytes - PHY 层 payload 字节数。
 * @param {boolean} input.crc - 是否带 payload CRC。
 * @param {boolean} input.implicitHeader - 是否隐式包头。
 * @param {boolean|'auto'} [input.ldro] - LDRO。'auto' 会按 16 ms 规则**逐 SF** 重新判定。
 * @param {number} [input.extraOverheadSec] - 额外在线时间（秒），同 analyzeAirTime。
 * @param {string|object} [input.subband] - 用于占空比折算的子频段；不给就只给空中时间对比。
 * @param {number} [input.windowSec] - 观察窗（秒），默认 3600。
 * @returns {object} `{ checks, warnings, notes, rows, ... }`
 */
export function compareSpreadingFactors(input) {
	const {
		sfList = [7, 8, 9, 10, 11, 12],
		bwHz,
		codingRate,
		preambleSymbols,
		payloadBytes,
		crc,
		implicitHeader,
		ldro = 'auto',
		extraOverheadSec,
		subband,
		windowSec = DUTY_CYCLE_OBSERVATION_WINDOW_SEC,
	} = input

	if (!Array.isArray(sfList) || sfList.length === 0) throw new Error('sfList 必须是非空数组')

	const checks = []
	const warnings = []
	const notes = []

	const band = subband === undefined || subband === null ? null : resolveSubband(subband)
	const overheadSec = extraOverheadSec ?? 0

	const rows = sfList.map((sf) => {
		const a = airTime({
			sf,
			bwHz,
			codingRate,
			preambleSymbols,
			payloadBytes,
			crc,
			implicitHeader,
			// 'auto' 时逐 SF 重新判 LDRO：SF11/SF12@125k 会翻转到 on，这是必须的。
			ldro,
		})
		const totalOnAirSec = a.toaSec + overheadSec
		const row = {
			sf,
			tsSec: a.tsSec,
			preambleSec: a.tpreambleSec,
			payloadSymbols: a.payloadSymbols,
			payloadSec: a.tpayloadSec,
			toaSec: a.toaSec,
			totalOnAirSec,
			ldro: a.ldro,
			ldroRequired: a.ldroRequired,
			nominalBitRateBps: a.nominalBitRateBps,
			dutyCycleLimit: band ? band.dutyCycle : null,
			maxPacketsPerHour: null,
			maxPacketsPerDay: null,
			minPeriodSec: null,
			requiredSilenceSec: null,
		}
		if (band && band.dutyCycle !== null) {
			row.maxPacketsPerHour = maxPacketsPerWindow(totalOnAirSec, band.dutyCycle, 3600)
			row.maxPacketsPerDay = maxPacketsPerWindow(totalOnAirSec, band.dutyCycle, 86400)
			row.minPeriodSec = minPeriodSec(totalOnAirSec, band.dutyCycle)
			row.requiredSilenceSec = requiredSilenceSec(totalOnAirSec, band.dutyCycle)
		}
		return row
	})

	// 逐 SF 的结构性检查：LDRO 是否与手册要求一致
	for (const row of rows) {
		const ok = row.ldro === row.ldroRequired
		checks.push({
			name: `LDRO @SF${row.sf}`,
			pass: ok,
			detail:
				`Ts=${(row.tsSec * 1000).toFixed(3)} ms → 要求 ${row.ldroRequired ? 'on' : 'off'}，` +
				`实际 ${row.ldro ? 'on' : 'off'}`,
		})
	}

	// 单调性自检：SF 增大时 Ts 必须翻倍、空中时间必须单调不减。公式实现漂移会在这里暴露。
	for (let i = 1; i < rows.length; i += 1) {
		const prev = rows[i - 1]
		const cur = rows[i]
		const tsOk = Math.abs(cur.tsSec / prev.tsSec - 2 ** (cur.sf - prev.sf)) < 1e-9
		checks.push({
			name: `Ts 比例 SF${prev.sf}→SF${cur.sf}`,
			pass: tsOk,
			detail: `${(prev.tsSec * 1000).toFixed(3)} → ${(cur.tsSec * 1000).toFixed(3)} ms（倍数 ${(cur.tsSec / prev.tsSec).toFixed(4)}）`,
		})
		if (cur.toaSec < prev.toaSec) {
			warnings.push(`SF${cur.sf} 的空中时间 ${(cur.toaSec * 1000).toFixed(3)} ms 小于 SF${prev.sf} 的，违反单调性。`)
		}
	}

	// 全局结论：SF 抬高带来的占空比可行性差异
	const lo = rows[0]
	const hi = rows[rows.length - 1]
	notes.push(
		`同一 payload（PL=${payloadBytes} 字节、CR ${4}/${codingRateValue(codingRate) + 4}、` +
			`前导 ${preambleSymbols} 符号）下，SF${lo.sf} 的空中时间 ${(lo.toaSec * 1000).toFixed(3)} ms，` +
			`SF${hi.sf} 是 ${(hi.toaSec * 1000).toFixed(3)} ms，相差 ${(hi.toaSec / lo.toaSec).toFixed(1)} 倍。`,
	)
	notes.push(
		`SF 每加一级，Ts 与符号数大致翻倍 → 空中时间约翻倍、占空比允许的包数约减半。` +
			`这就是"灵敏度换占空比"的定量形式：SF 提升带来扩频增益（理论 ${SF_STEP_THEORETICAL_GAIN_DB.toFixed(2)} dB/级，` +
			`实际接收灵敏度必须以器件数据手册的 Sensitivity 表为准），代价是法规允许的发送频次。`,
	)
	if (band && band.dutyCycle !== null) {
		notes.push(
			`在 ${band.label}（占空比上限 ${(band.dutyCycle * 100).toFixed(3)}%，窗口 ${windowSec} s）下换算：` +
				`SF${lo.sf} 每小时最多 ${lo.maxPacketsPerHour} 包，SF${hi.sf} 只剩 ${hi.maxPacketsPerHour} 包。` +
				`若业务需要的上报频次在 SF${hi.sf} 下达不到，正确做法是**降 SF / 缩 payload**（省的是时间），` +
				`而不是加发射功率（功率不省时间）。`,
		)
	}
	if (rows.some((r) => r.toaSec > POLITE_SPECTRUM_ACCESS_LIMITS.maxSingleTransmissionSec)) {
		const bad = rows.filter((r) => r.toaSec > POLITE_SPECTRUM_ACCESS_LIMITS.maxSingleTransmissionSec).map((r) => `SF${r.sf}`)
		warnings.push(
			`${bad.join(' / ')} 的单包空中时间超过 ${POLITE_SPECTRUM_ACCESS_LIMITS.maxSingleTransmissionSec} s。` +
				`若你打算走 polite spectrum access 路径，这已经违反 Table 16 的"单次发射 ≤ 1 s"；` +
				`走占空比路径则不受这条限制（但受占空比限制）。`,
		)
	}

	return { checks, warnings, notes, rows, subband: band ? band.id ?? null : null, subbandLabel: band ? band.label : null, windowSec }
}

// ─────────────────────────────────────────────────────────────────────────────
// 总入口
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一站式链路规划：空中时间 + 占空比合规 + SF 对比 + ADR/功率说明。
 *
 * @param {object} input - 输入。
 * @param {number} input.sf - 实际（或最坏情况）使用的扩频因子。
 * @param {number} input.bwHz - 带宽（Hz）。
 * @param {string|number} input.codingRate - 编码率。
 * @param {number} input.preambleSymbols - 前导符号数。LoRaWAN 为 8，不要用"常见的默认值"糊过去。
 * @param {number} input.payloadBytes - PHY 层 payload 字节数（LoRaWAN 记得加上约 13 字节 MAC 开销）。
 * @param {boolean} input.crc - 是否带 payload CRC。
 * @param {boolean} input.implicitHeader - 是否隐式包头。
 * @param {boolean|'auto'} [input.ldro] - LDRO，默认 'auto'（按 16 ms 规则）。
 * @param {unknown} input.subband - 子频段（必填）。不填就无法做合规判定，本函数会要求你明确给出。
 * @param {number} [input.extraOverheadSec] - 额外的射频起振 / ramp / SPI 时间（秒），无默认值。
 * @param {number} [input.targetPeriodSec] - 目标发送周期（秒）。
 * @param {number} [input.packetsPerWindow] - 或直接给每窗口包数。
 * @param {'duty-cycle'|'polite-spectrum-access'} [input.regime] - 合规路径。
 * @param {number} [input.maxOnTimeSec] - 单次发射上限（秒），必须来自法规/NRI。
 * @param {number} [input.maxPayloadBytes] - 该 SF/BW 的 payload 上限。
 * @param {number} [input.networkAirTimeSecPerDay] - 网络侧每日上行空中时间额度（秒）。
 * @param {number[]} [input.sfListForComparison] - 参与 SF 对比的列表。
 * @returns {object} 综合结果 `{ checks, warnings, notes, airTime, dutyCycle, sfComparison, ... }`
 */
export function analyzeLinkPlan(input) {
	if (input.subband === undefined || input.subband === null) {
		throw new Error(
			'analyzeLinkPlan 需要 subband（EU868_SUBBANDS 的 key 或自定义子频段对象）。' +
				'没有子频段就无法判断占空比法规——本模块不会替你假设一个默认区域。',
		)
	}

	const air = analyzeAirTime(input)
	const duty = analyzeDutyCycle({
		airTimeSec: air.totalOnAirSec,
		subband: input.subband,
		regime: input.regime,
		targetPeriodSec: input.targetPeriodSec,
		packetsPerWindow: input.packetsPerWindow,
		windowSec: input.windowSec,
		maxOnTimeSec: input.maxOnTimeSec,
		minOffTimeSec: input.minOffTimeSec,
		networkAirTimeSecPerDay: input.networkAirTimeSecPerDay,
	})

	const cmp = compareSpreadingFactors({
		sfList: input.sfListForComparison,
		bwHz: input.bwHz,
		codingRate: input.codingRate,
		preambleSymbols: input.preambleSymbols,
		payloadBytes: input.payloadBytes,
		crc: input.crc,
		implicitHeader: input.implicitHeader,
		ldro: input.ldro ?? 'auto',
		extraOverheadSec: air.overheadSec,
		subband: input.subband,
		windowSec: input.windowSec,
	})

	const notes = [
		...air.notes,
		...duty.notes,
		...ADR_TX_POWER_NOTES.map((n) => `[ADR/功率] ${n}`),
	]
	const warnings = [...air.warnings, ...duty.warnings]
	const checks = [...air.checks, ...duty.checks]

	// 法规合规与网络策略合规是**两回事**，必须分开报：法规由 ETSI 定，
	// 网络额度由运营商定（例如 TTN 的 30 s/天），两者都可能独立地把方案枪毙。
	const NETWORK_SCOPE_CHECK_NAMES = ['网络侧每日上行空中时间']
	const networkChecks = checks.filter((c) => NETWORK_SCOPE_CHECK_NAMES.includes(c.name))
	const regulatoryChecks = checks.filter((c) => !NETWORK_SCOPE_CHECK_NAMES.includes(c.name))

	// SF 对比的单调性/Ts 自检属于实现自检，不混进"合规判定"里，单独放。
	return {
		checks,
		warnings,
		notes,
		airTime: air,
		dutyCycle: duty,
		sfComparison: cmp,
		implementationChecks: cmp.checks,
		/** 频谱法规（ETSI EN 300 220-2）是否全部通过。 */
		regulatoryCompliance: regulatoryChecks.every((c) => c.pass),
		/** 网络侧额度（如 TTN Fair Use Policy）是否通过；未给额度时为 true。 */
		networkCompliance: networkChecks.every((c) => c.pass),
		/** 全部通过才算 true。法规过了但网络额度不够时，这里也是 false。 */
		compliance: checks.every((c) => c.pass),
	}
}
