/**
 * SD / SDIO / eMMC 的总线速率档与实际吞吐。
 *
 * ## 联网核实到的出处与数字
 *
 * **1) SD Association《SD Specifications Part 1 Physical Layer Simplified Specification》**
 * （Ver 3.01 / 4.10 / 7.10 三版交叉核对，逐字引用）：
 *   - 命令令牌长度固定 48 位：
 *     “Each command token is preceded by a start bit (0) and succeeded by an end bit (1).
 *      The total length is 48 bits.”
 *     结构 = 起始位 1 + 传输位 1 + 命令号 6 + 参数 32 + CRC7 7 + 结束位 1 = 48。
 *   - 响应令牌两种长度：“Response tokens have one of four coding schemes…
 *     The token length is either 48 or 136 bits.”
 *     其中 R1 / R3 / R6 = 48 位；R2（CID、CSD） = 136 位（图 3-5）。
 *   - 数据块校验：“The CRC protection algorithm for block data is a 16-bit CCITT polynomial.”
 *     数据包 = 起始位 + 数据 + CRC16 + 结束位；**位宽模式（4 线）下每根 DAT 线各自
 *     带起始位/CRC/结束位**：“Start and end bits, as well as the CRC bits, are transmitted
 *     for every one of the DAT lines.” —— 所以第 2 节的 18 个时钟开销与位宽无关。
 *   - 总线速度档表（Max bus speed / Max clock frequency / Signal voltage）：
 *       Default Speed 12.5 MB/s @ 25 MHz, 3.3 V；
 *       High Speed    25 MB/s  @ 50 MHz, 3.3 V；
 *       SDR12         12.5 MB/s @ 25 MHz, 1.8 V；
 *       SDR25         25 MB/s  @ 50 MHz, 1.8 V；
 *       SDR50         50 MB/s  @ 100 MHz, 1.8 V；
 *       SDR104        104 MB/s @ 208 MHz, 1.8 V；
 *       DDR50         50 MB/s  @ 50 MHz, 1.8 V（“sampled on both clock edges”，双沿）。
 *   - 初始化限速：4.2.3 “The host starts the card identification process with the
 *     identification clock rate f_OD (Maximum 400KHz).”
 *     4.3 “Until the end of Card Identification Mode the host must remain at f_OD frequency
 *     because some cards may have operating frequency restrictions during the card
 *     identification mode. In Data Transfer Mode the host may operate the card in f_PP
 *     frequency range (Up to 25MHz in default mode and up to 50MHz in high speed mode).”
 *
 * **2) JEDEC JESD84（eMMC；经 JESD84-B50/B51 器件手册转述的 Table “Bus Speed Mode”）**：
 *       Single（向后兼容 legacy MMC）0–26 MHz，1/4/8 位，26 MB/s；
 *       High Speed SDR  0–52 MHz，4/8 位，52 MB/s；
 *       High Speed DDR  0–52 MHz，4/8 位，双沿，104 MB/s；
 *       HS200           0–200 MHz，1.8 V，单沿，200 MB/s，**读方向需要 tuning**；
 *       HS400           0–200 MHz，1.8 V，双沿 + Data Strobe，400 MB/s，**仅支持 8 位**。
 *     （HS400 特性原文：“DDR Data sampling method - CLK frequency up to 200MHz,
 *      Data rate is – up to 400MB/s / Only 8-bit bus width supported / Signaling levels
 *      of 1.8V / Data strobe signal is toggled only for Data out and CRC response”。）
 *
 * **3) NXP i.MX 系列参考手册 MMC/SD 时序章节（交叉验证低速/高速时钟区间）**：
 *     “In Low-Speed mode, card clock must be lower than 400 kHz, voltage ranges from
 *      2.7 to 3.6 V. In Normal (Full)-Speed mode for SD/SDIO card, clock frequency can be
 *      any value between 0–25 MHz. In High-speed mode, clock frequency can be any value
 *      between 0–50 MHz. In Normal (Full)-Speed mode for MMC card, clock frequency can be
 *      any value between 0–20 MHz. In High-speed mode…0–52 MHz.”
 *
 * **4) SDIO 卡类型与档位《SD Specifications Part E1 SDIO Simplified Specification》2.1 原文**：
 *     “The Full-Speed card supports SPI, 1-bit SD and the 4-bit SD transfer modes at the
 *      full clock range of 0-25MHz. Full-Speed SDIO cards have a data transfer rate of over
 *      100 Mb/second (10 MB/Sec). … Low-Speed SDIO cards shall support a full clock range
 *      of 0-400 KHz.”；“The 4-bit SD mode provides the highest data transfer possible,
 *      up to 100 Mb/sec.”
 *     另有 CIS 元组约束：“This value shall be 25 Mb/Sec (0x32) for all Full-Speed SDIO
 *      cards. The minimum value for Low-Speed SDIO cards shall be 400 Kb/Sec (0x48).”
 *     High Speed 档 0–50 MHz（3.3 V，4 位）与 f_OD ≤ 400 kHz / f_PP 0–25 MHz 的时序表，
 *     经 u-blox JODY-W2 器件手册表 6/7 转述；UHS-I 各档（SDR12/25/50/104、DDR50）
 *     与 SD 存储卡同表、同为 1.8 V。
 *     **注意**：广为流传的一张 SDIO 表把 Low Speed 写成 “400 kHz / 200 KB/s”，
 *     这与 400 kHz × 1 位 = 400 kbit/s（= 50 KB/s）算不出来，规范里也只有
 *     “≥400 Kb/Sec”这个下限。本模块的 MB/s 列一律取“时钟 × 位宽 ÷ 8”的算术口径，
 *     该条因此记为 0.05 MB/s 并单独加了 note。
 *
 * ## 哪些是设计值、哪些必须实测
 *
 * - **规范常量（内置并注明出处）**：各档时钟上限、位宽上限、单/双沿、信令电压、
 *   命令令牌 48 位、响应 48/136 位、数据包每线 18 个时钟开销（1 起始 + 16 CRC + 1 结束）、
 *   初始化阶段 400 kHz 上限。这些取自公开规范，不随板子变化。
 * - **必须由调用方传入（不内置默认值）**：命令与响应的实际往返延迟、写方向 DAT0 忙等待、
 *   块间空隙、主机/DMA 每事务开销、走线长度与组内偏斜上限、负载电容上限。
 *   这些**与具体器件、卡、控制器、走线强相关**，规范里查不到，本模块一律要求调用方给出；
 *   未给出时按 0 计入并明确告警——那是**乐观上界**，不是预测值。
 *
 * @module dsh-embedded-kit/sdio
 */

/**
 * 命令令牌固定长度（位）。出处：SD Part 1 Simplified Spec —— “The total length is 48 bits.”
 */
export const COMMAND_TOKEN_BITS = 48

/**
 * 各类响应令牌的长度（位）。出处：SD Part 1 Simplified Spec 图 3-5 ——
 * “The token length is either 48 or 136 bits.”
 *
 * - R1 / R1b：返回卡状态与命令号（48 位），R1b 额外在 DAT0 上带忙信号。
 * - R2：返回 CID / CSD 寄存器完整内容（136 位），本表最长的一类。
 * - R3：ACMD41 返回 OCR（48 位，无 CRC 保护）。
 * - R4 / R5：SDIO 专用（48 位）。
 * - R6：CMD3 返回已发布的 RCA（48 位）。
 * - R7：CMD8 返回电压支持与检测模式回显（48 位）。
 */
export const RESPONSE_BITS = {
	R1: 48,
	R1b: 48,
	R2: 136,
	R3: 48,
	R4: 48,
	R5: 48,
	R6: 48,
	R7: 48,
}

/**
 * 数据包每根 DAT 线的固定开销（时钟数）= 起始位 1 + CRC16 16 + 结束位 1。
 *
 * 出处：SD Part 1 Simplified Spec —— 数据包 = Start bit + Data + CRC + End bit，
 * 且“Start and end bits, as well as the CRC bits, are transmitted for every one of the
 * DAT lines. CRC bits are calculated and checked for every DAT line individually.”
 * **因此这个开销与总线位宽无关**：4 位模式下 4 根线各自带 16 位 CRC，并行发，
 * 仍占 18 个时钟。这是"位宽翻 4 倍不等于吞吐翻 4 倍"的根源之一。
 */
export const DATA_PACKET_OVERHEAD_CLOCKS = 18

/**
 * 卡识别阶段（Card Identification Mode）的时钟上限。
 *
 * 出处：SD Part 1 Simplified Spec 4.2.3 “the identification clock rate f_OD
 * (Maximum 400KHz)”，4.3 要求识别阶段全程保持在 f_OD。
 */
export const INITIALIZATION_CLOCK_MAX_HZ = 400_000

/**
 * 各速度档的规范定义。
 *
 * 字段含义：
 *   family            'sd' | 'sdio' | 'emmc'，用于归类与提示。
 *   clockMaxHz        该档的时钟上限（规范值）。
 *   busWidths         该档允许的总线位宽（规范值）。
 *   edgesPerClock     1 = 单沿采样（SDR），2 = 双沿采样（DDR）。
 *   signalingV        信令电压（规范值）；requires1v8 表示该档**必须**切到 1.8 V。
 *   maxBusMBps        规范表格给出的该档最大总线速率（以 4 位/8 位满配计）。
 *   requiresTuning    该档读方向需要主机做 tuning（可调采样点）。
 *   requiresDataStrobe 该档需要 Data Strobe 信号（eMMC HS400/HS400ES）。
 *   note              规范明确写出、但容易踩的约束。
 */
export const SD_BUS_MODES = {
	'sd-default-speed': {
		id: 'sd-default-speed',
		label: 'SD Default Speed (DS, 3.3 V)',
		family: 'sd',
		clockMaxHz: 25_000_000,
		busWidths: [1, 4],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 12.5,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	'sd-high-speed': {
		id: 'sd-high-speed',
		label: 'SD High Speed (HS, 3.3 V)',
		family: 'sd',
		clockMaxHz: 50_000_000,
		busWidths: [1, 4],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 25,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	sdr12: {
		id: 'sdr12',
		label: 'SDR12 (UHS-I, 1.8 V)',
		family: 'sd',
		clockMaxHz: 25_000_000,
		busWidths: [4],
		edgesPerClock: 1,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 12.5,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	sdr25: {
		id: 'sdr25',
		label: 'SDR25 (UHS-I, 1.8 V)',
		family: 'sd',
		clockMaxHz: 50_000_000,
		busWidths: [4],
		edgesPerClock: 1,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 25,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	sdr50: {
		id: 'sdr50',
		label: 'SDR50 (UHS-I, 1.8 V)',
		family: 'sd',
		clockMaxHz: 100_000_000,
		busWidths: [4],
		edgesPerClock: 1,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 50,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	sdr104: {
		id: 'sdr104',
		label: 'SDR104 (UHS-I, 1.8 V)',
		family: 'sd',
		clockMaxHz: 208_000_000,
		busWidths: [4],
		edgesPerClock: 1,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 104,
		requiresTuning: true,
		requiresDataStrobe: false,
		note:
			'规范要求读方向做 tuning（可调采样点）来补偿往返延迟。' +
			'tuning 失败或反复重调，通常就是信号完整性不足的直接表现。',
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	ddr50: {
		id: 'ddr50',
		label: 'DDR50 (UHS-I, 1.8 V, 双沿)',
		family: 'sd',
		clockMaxHz: 50_000_000,
		busWidths: [4],
		edgesPerClock: 2,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 50,
		requiresTuning: false,
		requiresDataStrobe: false,
		note: '“sampled on both clock edges”：时钟仍为 50 MHz，靠双沿采样把速率翻倍。',
		source: 'SD Part 1 Simplified Spec 总线速度档表',
	},
	'sdio-low-speed': {
		id: 'sdio-low-speed',
		label: 'SDIO Low Speed (3.3 V)',
		family: 'sdio',
		clockMaxHz: 400_000,
		busWidths: [1],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 0.05,
		requiresTuning: false,
		requiresDataStrobe: false,
		note:
			'“Low-Speed SDIO cards shall support a full clock range of 0-400 KHz”，规范只给出' +
			'“minimum value … shall be 400 Kb/Sec”这个下限；按 400 kHz × 1 位算峰值是 400 kbit/s = 50 KB/s。' +
			'（常见资料把这一档写成 200 KB/s，与 400 kHz 单线对不上，勿直接引用。）',
		source: 'SDIO Simplified Spec 2.1 + CIS 元组（Part E1）',
	},
	'sdio-full-speed': {
		id: 'sdio-full-speed',
		label: 'SDIO Full Speed (3.3 V)',
		family: 'sdio',
		clockMaxHz: 25_000_000,
		busWidths: [1, 4],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 12.5,
		requiresTuning: false,
		requiresDataStrobe: false,
		note:
			'规范原文只说 Full-Speed 卡“over 100 Mb/second (10 MB/Sec)”、4 位模式“up to 100 Mb/sec”；' +
			'25 MHz × 4 位 = 100 Mbit/s = 12.5 MB/s 是按时钟 × 位宽算出来的口径。',
		source: 'SDIO Simplified Spec 2.1 / 2.2.3（Part E1）',
	},
	'sdio-high-speed': {
		id: 'sdio-high-speed',
		label: 'SDIO High Speed (3.3 V)',
		family: 'sdio',
		clockMaxHz: 50_000_000,
		busWidths: [4],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 25,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'SDIO 时钟区间（u-blox JODY-W2 器件手册表 6/7 转述）',
	},
	'emmc-legacy': {
		id: 'emmc-legacy',
		label: 'eMMC Single / Legacy（兼容 legacy MMC）',
		family: 'emmc',
		clockMaxHz: 26_000_000,
		busWidths: [1, 4, 8],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 26,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'JEDEC JESD84 Bus Speed Mode 表（JESD84-B50/B51 器件手册转述）',
	},
	'emmc-high-speed-sdr': {
		id: 'emmc-high-speed-sdr',
		label: 'eMMC High Speed SDR',
		family: 'emmc',
		clockMaxHz: 52_000_000,
		busWidths: [4, 8],
		edgesPerClock: 1,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 52,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'JEDEC JESD84 Bus Speed Mode 表（JESD84-B50/B51 器件手册转述）',
	},
	'emmc-high-speed-ddr': {
		id: 'emmc-high-speed-ddr',
		label: 'eMMC High Speed DDR（DDR52，双沿）',
		family: 'emmc',
		clockMaxHz: 52_000_000,
		busWidths: [4, 8],
		edgesPerClock: 2,
		signalingV: 3.3,
		requires1v8: false,
		maxBusMBps: 104,
		requiresTuning: false,
		requiresDataStrobe: false,
		source: 'JEDEC JESD84 Bus Speed Mode 表（JESD84-B50/B51 器件手册转述）',
	},
	hs200: {
		id: 'hs200',
		label: 'eMMC HS200 (1.8 V, 单沿)',
		family: 'emmc',
		clockMaxHz: 200_000_000,
		busWidths: [4, 8],
		edgesPerClock: 1,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 200,
		requiresTuning: true,
		requiresDataStrobe: false,
		note:
			'规范明确：读方向主机必须有可调采样点（tuning），因为读数据的时钟与数据方向相反，' +
			'接收到的数据被往返延迟 + 输出延迟推后。写方向时钟与数据同向，不需要 tuning。' +
			'器件手册标注为 8 位总线支持。',
		source: 'JEDEC JESD84 HS200 特性（JESD84-B50/B51 器件手册转述）',
	},
	hs400: {
		id: 'hs400',
		label: 'eMMC HS400 (1.8 V, 双沿 + Data Strobe)',
		family: 'emmc',
		clockMaxHz: 200_000_000,
		busWidths: [8],
		edgesPerClock: 2,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 400,
		requiresTuning: false,
		requiresDataStrobe: true,
		note:
			'规范明确：仅支持 8 位总线；需要 Data Strobe（DS），且 DS 只在 Data out 与 CRC 响应时翻转；' +
			'主机按 DS 边沿对齐采样。',
		source: 'JEDEC JESD84 HS400 特性（JESD84-B50/B51 器件手册转述）',
	},
	'hs400es': {
		id: 'hs400es',
		label: 'eMMC HS400ES (Enhanced Strobe)',
		family: 'emmc',
		clockMaxHz: 200_000_000,
		busWidths: [8],
		edgesPerClock: 2,
		signalingV: 1.8,
		requires1v8: true,
		maxBusMBps: 400,
		requiresTuning: false,
		requiresDataStrobe: true,
		note: '与 HS400 同为 400 MB/s 档；用增强型选通，省去 tuning 流程。',
		source: 'JEDEC JESD84（器件手册 Enhanced Strobe 章节）',
	},
}

/** 供文档与自测使用的档位 id 清单。 */
export const SD_BUS_MODE_IDS = Object.keys(SD_BUS_MODES)

/**
 * 档位排序表：按家族分组、组内按时钟上限升序（同频段保持 {@link SD_BUS_MODES} 的定义顺序）。
 * 用途只有一个——给"该往哪一档退"的建议，所以排序口径是**能力从低到高**。
 */
export const SD_BUS_MODE_ORDER = [
	// SDIO 家族
	'sdio-low-speed',
	'sdio-full-speed',
	'sdio-high-speed',
	// SD 家族（含 UHS-I）
	'sd-default-speed',
	'sdr12',
	'sd-high-speed',
	'sdr25',
	'ddr50',
	'sdr50',
	'sdr104',
	// eMMC 家族
	'emmc-legacy',
	'emmc-high-speed-sdr',
	'emmc-high-speed-ddr',
	'hs200',
	'hs400',
	'hs400es',
]

/**
 * 取一个速度档的定义。
 *
 * @param {string} mode - 速度档 id，见 {@link SD_BUS_MODES}。
 * @returns {object} 该档的定义（规范值 + 出处）。
 * @throws {Error} 档位不存在时抛出。
 */
export function getBusMode(mode) {
	const m = SD_BUS_MODES[mode]
	if (!m) throw new Error(`未知的总线速度档：${mode}（可用：${SD_BUS_MODE_IDS.join(' / ')}）`)
	return m
}

/**
 * 建议的降档目标：在**同一家族内**退到能力更低的相邻一档。
 *
 * 只做"往下一档"的机械建议，不代表那一档在你的板子上一定可用——
 * 是否可用仍取决于调用方手册给出的偏斜/负载上限。
 *
 * @param {string} mode - 当前速度档 id。
 * @returns {string|null} 更低的一档 id；该家族内已是最低档时返回 null。
 */
export function suggestDowngrade(mode) {
	const spec = getBusMode(mode)
	const sameFamily = SD_BUS_MODE_ORDER.filter((id) => SD_BUS_MODES[id].family === spec.family)
	const idx = sameFamily.indexOf(mode)
	if (idx <= 0) return null
	return sameFamily[idx - 1]
}

/**
 * 理论峰值（裸线速率）：时钟 × 位宽 × 沿数。
 *
 * 只算线路本身能搬运的比特，不含任何命令、响应、CRC、忙等待。
 *
 * @param {object} input - 输入。
 * @param {number} input.clockHz - 总线时钟（Hz）。
 * @param {number} input.busWidth - 总线位宽（1 / 4 / 8）。
 * @param {number} [input.edgesPerClock] - 每个时钟采样的沿数，1 = SDR，2 = DDR。
 * @returns {object} 峰值比特率与字节率。
 */
export function peakThroughput({ clockHz, busWidth, edgesPerClock = 1 }) {
	if (!(clockHz > 0) || !(busWidth > 0)) throw new Error('clock_hz 与 bus_width 必须为正数')
	if (edgesPerClock !== 1 && edgesPerClock !== 2) throw new Error('edges_per_clock 只能是 1（单沿）或 2（双沿）')
	const bitsPerSecond = clockHz * busWidth * edgesPerClock
	return { bitsPerSecond, bytesPerSecond: bitsPerSecond / 8 }
}

/**
 * 命令阶段占用的时钟数：命令令牌 + 响应令牌（都在 CMD 线上，1 位/时钟串行）。
 *
 * @param {string} [responseType] - 响应类型，见 {@link RESPONSE_BITS}。
 * @returns {object} 命令与响应各自的位数、合计时钟数。
 * @throws {Error} 响应类型未知时抛出。
 */
export function commandPhaseClocks(responseType = 'R1') {
	const responseBits = RESPONSE_BITS[responseType]
	if (responseBits === undefined) {
		throw new Error(`未知的响应类型：${responseType}（可用：${Object.keys(RESPONSE_BITS).join(' / ')}）`)
	}
	return {
		responseType,
		commandBits: COMMAND_TOKEN_BITS,
		responseBits,
		totalClocks: COMMAND_TOKEN_BITS + responseBits,
	}
}

/**
 * 单块数据在 DAT 线上占用的时钟数。
 *
 * 每根 DAT 线各自要带 起始位 + CRC16 + 结束位 = {@link DATA_PACKET_OVERHEAD_CLOCKS} 个时钟，
 * 所以这个开销与位宽无关：
 *   clocks = 8 × blockBytes / busWidth + 18
 *
 * @param {number} blockBytes - 块大小（字节），SD/eMMC 常用 512，也有 4096。
 * @param {number} busWidth - 总线位宽（1 / 4 / 8）。
 * @returns {number} 该块的时钟数（单沿口径；双沿请再除以 2，见 {@link effectiveThroughput}）。
 */
export function dataPacketClocksPerBlock(blockBytes, busWidth) {
	if (!(blockBytes > 0) || !(busWidth > 0)) throw new Error('block_bytes 与 bus_width 必须为正数')
	return (blockBytes * 8) / busWidth + DATA_PACKET_OVERHEAD_CLOCKS
}

/**
 * 有效吞吐：扣掉命令/响应、块内 CRC 开销、写忙等待、块间空隙、主机事务开销。
 *
 * 时间账（单次事务）：
 *   T_cmd    = (48 + 响应位数) / f_clk                    ← CMD 线，1 位/时钟
 *   T_data   = Σ 每块(8N/位宽 + 18) / (f_clk × 沿数)      ← DAT 线
 *   T_busy   = 忙等待 × 块数                              ← 调用方实测（写方向尤其重要）
 *   T_gap    = 块间空隙 × (块数 − 1)                      ← 调用方实测
 *   T_host   = 主机/DMA 每事务开销 × 1                    ← 调用方实测
 *
 * 三者**没有默认值**：不传就按 0 计，并在 `notes` 里明确标出这是乐观上界。
 *
 * @param {object} input - 输入。
 * @param {string} input.mode - 速度档 id。
 * @param {number} input.clockHz - 实际总线时钟（Hz）。若超过该档规范上限会给出告警。
 * @param {number} input.busWidth - 总线位宽（1 / 4 / 8）。
 * @param {number} input.blockBytes - 块大小（字节）。
 * @param {string} [input.responseType] - 响应类型，默认 R1。
 * @param {number} [input.blocks] - 单次事务的块数，默认 1（单块命令）。
 * @param {('read'|'write')} [input.direction] - 方向，默认 read。
 * @param {number} [input.busyWaitNs] - **每块**的忙等待（ns），必须实测。
 * @param {number} [input.interBlockGapNs] - **相邻块之间**的空隙（ns），必须实测。
 * @param {number} [input.hostOverheadNs] - **每事务一次**的主机/DMA 开销（ns），必须实测。
 * @returns {object} 统一形状：检查项 + 告警 + 说明 + 具体数值与时间账。
 */
export function effectiveThroughput({
	mode,
	clockHz,
	busWidth,
	blockBytes,
	responseType = 'R1',
	blocks = 1,
	direction = 'read',
	busyWaitNs,
	interBlockGapNs,
	hostOverheadNs,
}) {
	const spec = getBusMode(mode)
	if (!(clockHz > 0)) throw new Error('clock_hz 必须为正数（实际总线时钟，来自你的分频配置）')
	if (!(busWidth > 0)) throw new Error('bus_width 必须为正数（1 / 4 / 8）')
	if (!(blockBytes > 0)) throw new Error('block_bytes 必须为正数（SD/eMMC 常见 512 或 4096）')
	if (!(blocks >= 1) || !Number.isInteger(blocks)) throw new Error('blocks 必须是 ≥1 的整数')

	const checks = []
	const warnings = []
	const notes = []

	// 位宽是否在该档允许范围内（规范硬约束，非估计）
	const widthOk = spec.busWidths.includes(busWidth)
	checks.push({
		name: '总线位宽在该档允许范围内',
		pass: widthOk,
		detail: `${spec.label} 规范允许 ${spec.busWidths.join('/')} 位，收到 ${busWidth} 位`,
	})
	if (!widthOk) {
		warnings.push(
			`${spec.label} 不支持 ${busWidth} 位总线（规范允许 ${spec.busWidths.join('/')} 位）。` +
				`请核对总线宽度配置或改用别的档位。`,
		)
	}

	// 时钟是否超过规范上限
	const clockOk = clockHz <= spec.clockMaxHz
	checks.push({
		name: '时钟不超过该档规范上限',
		pass: clockOk,
		detail: `f_clk = ${(clockHz / 1e6).toFixed(3)} MHz，${spec.label} 上限 ${(spec.clockMaxHz / 1e6).toFixed(3)} MHz`,
	})
	if (!clockOk) {
		warnings.push(
			`时钟 ${(clockHz / 1e6).toFixed(3)} MHz 超过 ${spec.label} 的规范上限 ` +
				`${(spec.clockMaxHz / 1e6).toFixed(3)} MHz：此时器件是否可用、信号是否还能收敛都无法保证。`,
		)
	}

	const { totalClocks: cmdClocks, responseBits } = commandPhaseClocks(responseType)
	const clkPerSecond = clockHz * spec.edgesPerClock

	const cmdNs = (cmdClocks / clockHz) * 1e9
	const clocksPerBlock = dataPacketClocksPerBlock(blockBytes, busWidth)
	const dataClocks = clocksPerBlock * blocks
	const dataNs = (dataClocks / clkPerSecond) * 1e9

	// 器件/板级参数：没有就按 0 计，并明确标注这是乐观上界
	const busyPerBlock = busyWaitNs ?? 0
	const gapPerBlock = interBlockGapNs ?? 0
	const hostOnce = hostOverheadNs ?? 0
	const busyTotalNs = busyPerBlock * blocks
	const gapTotalNs = gapPerBlock * Math.max(0, blocks - 1)

	if (busyWaitNs === undefined) {
		notes.push(
			'未提供 busy_wait_ns（每块忙等待）：已按 0 计。' +
				(direction === 'write'
					? '**写方向这是最容易被低估的一项**——卡在 DAT0 上拉低表示"还在写内部 NAND"，' +
						'时长随块内容、磨损状态、温度变化，必须实测。'
					: '读方向若用 R1b（如 CMD7/CMD12）也会有忙等待，需要时请补上。'),
		)
	}
	if (interBlockGapNs === undefined) {
		notes.push(
			`未提供 inter_block_gap_ns（相邻块之间的空隙）：已按 0 计（${blocks - 1} 处）。` +
				'多块连续传输的实际块间仍有总线转向/CRC 状态令牌等间隙，多块场景务必实测。',
		)
	}
	if (hostOverheadNs === undefined) {
		notes.push('未提供 host_overhead_ns（每事务一次的主机/DMA 开销）：已按 0 计。小块高频事务时它会主导效率。')
	}
	if (busyWaitNs === undefined || interBlockGapNs === undefined || hostOverheadNs === undefined) {
		notes.push(
			'上述"按 0 计"的项使下面的有效吞吐成为**乐观上界**：真实值只会更低。' +
				'要拿到可用数字，请把这几个参数换成你板子上的实测值（逻辑分析仪测 CMD/DAT 波形即可）。',
		)
	}

	const totalNs = cmdNs + dataNs + busyTotalNs + gapTotalNs + hostOnce
	const payloadBytes = blockBytes * blocks
	const peak = peakThroughput({ clockHz, busWidth, edgesPerClock: spec.edgesPerClock })
	const effectiveBytesPerSecond = payloadBytes / (totalNs * 1e-9)
	const efficiencyPercent = (effectiveBytesPerSecond / peak.bytesPerSecond) * 100

	// 规范要求但容易漏掉的两条硬件前提，只做提示，不判定
	if (spec.requires1v8) {
		notes.push(
			`${spec.label} 属 1.8 V 信令档：I/O 电压必须先切到 1.8 V（规范表格 Signal voltage = 1.8 V）。` +
				'这是硬件电源架构确定的事，软件提速前必须已经切好，否则会直接通信失败。',
		)
	}
	if (spec.requiresTuning) {
		notes.push(
			`${spec.label} 的读方向需要 tuning（规范要求主机提供可调采样点）` +
				(direction === 'write' ? '；写方向时钟与数据同向，不需要。' : '。'),
		)
	}
	if (spec.requiresDataStrobe) {
		notes.push(`${spec.label} 需要 Data Strobe 信号，主机按 DS 边沿对齐采样。`)
	}
	if (spec.note) notes.push(spec.note)

	// 效率低下的量化归因：命令开销占比
	const cmdSharePercent = (cmdNs / totalNs) * 100
	if (cmdSharePercent > 20) {
		warnings.push(
			`命令/响应阶段占了本次事务时间的 ${cmdSharePercent.toFixed(1)}%（${cmdNs.toFixed(0)} ns）。` +
				`小块高频事务的效率瓶颈就在这里：合并成多块传输（提高 blocks）能显著摊薄它。`,
		)
	}

	// 整体效率过低时的归因（小块损耗是重点）
	const overheadSharePercent = 100 - efficiencyPercent
	if (efficiencyPercent < 80) {
		const pct = (ns) => ((ns / totalNs) * 100).toFixed(1)
		// 块内固定开销的耗时：每块多出的 起始/CRC16/结束 时钟
		const crcOverheadNs = ((blocks * DATA_PACKET_OVERHEAD_CLOCKS) / clkPerSecond) * 1e9
		warnings.push(
			`有效效率只有 ${efficiencyPercent.toFixed(1)}%，开销合计 ${overheadSharePercent.toFixed(1)}%：` +
				`命令/响应 ${pct(cmdNs)}% + 块内 起始/CRC16/结束 ${pct(crcOverheadNs)}%` +
				` + 忙等 ${pct(busyTotalNs)}% + 块间 ${pct(gapTotalNs)}% + 主机 ${pct(hostOnce)}%。` +
				`小块高频事务的典型症状：把块大小提到 4 KB 量级、或减少事务次数（多块 / 更大传输）最有效。` +
				`但注意每块都固定带 ${DATA_PACKET_OVERHEAD_CLOCKS} 个时钟的起始/CRC/结束开销（每根 DAT 线各一份），` +
				'所以"多块"也不等于零成本。',
		)
	}

	const blockPayloadBytes = blockBytes * blocks
	const usefulBits = blockPayloadBytes * 8
	notes.push(
		`数据包开销：每块在 DAT 线上多出 ${DATA_PACKET_OVERHEAD_CLOCKS} 个时钟` +
			`（1 起始 + 16 CRC16 + 1 结束，每根 DAT 线各带一份，与位宽无关）。` +
			`本例 ${blocks} 块共 ${dataClocks.toFixed(0)} 个数据时钟，承载 ${usefulBits} 位净荷。`,
	)
	notes.push(
		'以上是**设计值**：命令/响应按规范位数、按 1 位/时钟串行计算，' +
			'不含控制器分频取整、FIFO 停顿、卡内部读写延迟与重传。真机吞吐必须用实测（或总线分析仪）对齐。',
	)

	return {
		mode: spec.id,
		modeLabel: spec.label,
		family: spec.family,
		signalingV: spec.signalingV,
		clockHz,
		clockMaxHz: spec.clockMaxHz,
		busWidth,
		edgesPerClock: spec.edgesPerClock,
		responseType,
		responseBits,
		direction,
		blockBytes,
		blocks,
		clocksPerBlock,
		dataClocks,
		peakBitsPerSecond: peak.bitsPerSecond,
		peakBytesPerSecond: peak.bytesPerSecond,
		payloadBytes,
		totalNs,
		cmdNs,
		dataNs,
		busyTotalNs,
		gapTotalNs,
		hostOverheadNs: hostOnce,
		cmdSharePercent,
		effectiveBytesPerSecond,
		efficiencyPercent,
		checks,
		warnings,
		notes,
	}
}

/**
 * 初始化阶段的速度检查。
 *
 * 依据（规范原文）：
 *   - “the identification clock rate f_OD (Maximum 400KHz)”
 *   - “Until the end of Card Identification Mode the host must remain at f_OD frequency
 *      because some cards may have operating frequency restrictions during the card
 *      identification mode.”
 * 识别完成后（拿到 RCA、进入 Data Transfer Mode）才可以切到 f_PP（默认 ≤25 MHz / 高速 ≤50 MHz）。
 *
 * @param {object} input - 输入。
 * @param {number} input.clockHz - 该阶段实际使用的时钟（Hz）。
 * @param {('identification'|'transfer')} [input.phase] - 阶段，默认 identification。
 * @returns {object} 统一形状的检查结果。
 */
export function checkInitializationClock({ clockHz, phase = 'identification' }) {
	if (!(clockHz > 0)) throw new Error('clock_hz 必须为正数')
	const checks = []
	const warnings = []
	const notes = []

	if (phase === 'identification') {
		const ok = clockHz <= INITIALIZATION_CLOCK_MAX_HZ
		checks.push({
			name: '识别阶段时钟 ≤ 400 kHz',
			pass: ok,
			detail: `f_OD = ${(clockHz / 1000).toFixed(1)} kHz，规范上限 400 kHz`,
		})
		if (!ok) {
			warnings.push(
				`识别阶段时钟 ${(clockHz / 1000).toFixed(1)} kHz 超过 f_OD 上限 400 kHz。` +
					'规范要求识别阶段全程停在 f_OD：卡在识别态可能有自己的频率限制，' +
					'用高速时钟发 CMD0/CMD8/ACMD41/CMD2/CMD3 会出现"有的卡能认、有的卡认不到"的偶发问题。',
			)
		}
		notes.push(
			`识别流程（SD）：CMD0 → CMD8 → ACMD41（CMD55 前置）→ CMD2 → CMD3，` +
				'全程 f_OD ≤ 400 kHz；拿到 RCA 进入 Data Transfer Mode 后才允许提速到 f_PP。' +
				'识别阶段会用到 R2（136 位，CMD2/CMD9）这一类长响应，' +
				'在 400 kHz 下单条长响应就要 ' +
				`${((COMMAND_TOKEN_BITS + RESPONSE_BITS.R2) / INITIALIZATION_CLOCK_MAX_HZ * 1e6).toFixed(0)} µs，` +
				'这也是识别阶段偏慢的固有原因。',
		)
		notes.push(
			'很多卡（尤其 SD NAND / 工业卡）要求比 400 kHz 更保守的识别时钟；' +
				'具体取值请查该卡的器件手册或实测识别成功率，不要照抄 400 kHz 当"最优值"。',
		)
	} else {
		checks.push({
			name: '传输阶段时钟已脱离识别限速',
			pass: clockHz > INITIALIZATION_CLOCK_MAX_HZ,
			detail: `f_PP = ${(clockHz / 1e6).toFixed(3)} MHz`,
		})
		if (!(clockHz > INITIALIZATION_CLOCK_MAX_HZ)) {
			warnings.push(
				`已进入传输阶段但时钟仍是 ${(clockHz / 1000).toFixed(1)} kHz（≤ f_OD）。` +
					'若是有意为之（稳妥起见）可以忽略；若是忘了提速，吞吐会低一到两个数量级。',
			)
		}
		notes.push(
			'提速前应先确认卡支持的模式（CMD6/EXT_CSD 查询），再按档位逐步切换；' +
				'切频时通常需要停止时钟、改分频、再重新使能，并留出稳定时间。',
		)
	}

	return { phase, clockHz, initClockMaxHz: INITIALIZATION_CLOCK_MAX_HZ, checks, warnings, notes }
}

/**
 * 信号完整性相关的降速判据。
 *
 * **本函数不内置任何阈值**：偏斜上限、负载上限都随 SoC 手册与板子不同，
 * 属于"必须由调用方传入"的一类。传了才判定，没传就只给规范层面的通用提示。
 *
 * 判定逻辑（都在调用方给的限值之内做比较）：
 *   1. 组内偏斜 = 组内最大长度差 × 单位长度传播延迟，与手册给出的偏斜上限比较。
 *   2. 总负载电容（走线 + 卡座 + ESD 器件 + 卡）与手册给出的负载上限比较。
 *   3. 规范层面的固有要求：1.8 V 信令、UHS-I SDR104 / HS200 读方向 tuning、
 *      HS400 仅 8 位 + 需要 Data Strobe —— 这些是规范事实，不是估计。
 *
 * @param {object} input - 输入。
 * @param {string} input.mode - 速度档 id。
 * @param {number} [input.busWidth] - 总线位宽。
 * @param {number} [input.propagationPsPerMm] - 走线单位传播延迟（ps/mm）。板级参数，必传才做换算。
 * @param {number} [input.traceMismatchMm] - 组内（CLK/CMD/DAT）最大长度差（mm），实测或设计值。
 * @param {number} [input.maxSkewPs] - 主控手册给出的组内偏斜上限（ps）。**必传**，不内置。
 * @param {number} [input.loadPf] - 该组信号总负载电容（pF），实测或估算值。
 * @param {number} [input.maxLoadPf] - 器件手册给出的负载上限（pF）。**必传**，不内置。
 * @returns {object} 统一形状的检查结果，附降档建议。
 */
export function assessSignalIntegrity({
	mode,
	busWidth,
	propagationPsPerMm,
	traceMismatchMm,
	maxSkewPs,
	loadPf,
	maxLoadPf,
}) {
	const spec = getBusMode(mode)
	const checks = []
	const warnings = []
	const notes = []

	/** @type {number|null} */
	let skewPs = null
	if (propagationPsPerMm !== undefined && traceMismatchMm !== undefined) {
		if (!(propagationPsPerMm > 0) || !(traceMismatchMm >= 0)) {
			throw new Error('propagation_ps_per_mm 必须为正数，trace_mismatch_mm 必须 ≥ 0')
		}
		skewPs = propagationPsPerMm * traceMismatchMm
	}

	if (maxSkewPs === undefined) {
		notes.push(
			'未提供 max_skew_ps（主控手册给出的组内偏斜上限），**不做偏斜判定**。' +
				'这个值在各家 SoC 手册的 MMC/SD AC timing 表里，不同档位要求差别很大' +
				'（越高档越严），本模块不臆造阈值。',
		)
	} else if (skewPs !== null) {
		const ok = skewPs <= maxSkewPs
		checks.push({
			name: '组内偏斜在手册上限内',
			pass: ok,
			detail: `${traceMismatchMm} mm × ${propagationPsPerMm} ps/mm = ${skewPs.toFixed(1)} ps，上限 ${maxSkewPs} ps`,
		})
		if (!ok) {
			warnings.push(
				`组内偏斜约 ${skewPs.toFixed(1)} ps 超过手册上限 ${maxSkewPs} ps：` +
					`${spec.label} 下必须降档。`,
			)
		}
	} else {
		notes.push('给了 max_skew_ps 但缺 propagation_ps_per_mm 或 trace_mismatch_mm，无法把长度差换算成偏斜。')
	}

	if (maxLoadPf === undefined) {
		notes.push('未提供 max_load_pf（手册给出的负载上限），**不做负载判定**。走线、卡座、ESD 器件与卡本身都会加电容。')
	} else if (loadPf !== undefined) {
		const ok = loadPf <= maxLoadPf
		checks.push({
			name: '总线负载电容在手册上限内',
			pass: ok,
			detail: `负载 ${loadPf} pF，上限 ${maxLoadPf} pF`,
		})
		if (!ok) {
			warnings.push(`负载电容 ${loadPf} pF 超过手册上限 ${maxLoadPf} pF：${spec.label} 下必须降档。`)
		}
	} else {
		notes.push('给了 max_load_pf 但缺 load_pf（实测/估算负载），无法判定。')
	}

	// 规范层面的固有要求：这些与板子无关，属于"这一档本来就要做到的事"
	if (spec.requires1v8) {
		notes.push(`${spec.label} 要求 1.8 V 信令。I/O 电压没切到 1.8 V 时，这一档根本不可能跑起来。`)
	}
	if (spec.requiresTuning) {
		notes.push(
			`${spec.label} 在读方向需要 tuning。**tuning 失败、反复重调、或换卡后重调，` +
				'就是信号完整性不足最直接的现象**——先降一档验证，再回头查走线与端接。',
		)
	}
	if (spec.requiresDataStrobe) {
		notes.push(`${spec.label} 依赖 Data Strobe 对齐采样；DS 走线应与数据组一起做等长控制。`)
	}
	if (busWidth !== undefined && !spec.busWidths.includes(busWidth)) {
		notes.push(`${spec.label} 规范只支持 ${spec.busWidths.join('/')} 位，${busWidth} 位属于非法配置。`)
	}

	notes.push(
		'降速判据的**用法**而不是阈值：先用示波器/分析仪看眼图与过冲，再看主控报的 tuning 结果与 CRC 错误计数；' +
			'出现异常时按 {@link suggestDowngrade} 退一档复测。' +
			'高频档的常见做法是 50 Ω 单端受控阻抗、完整地参考面、点对点拓扑、' +
			'源端串小阻值端接（阻值 = 走线阻抗 − 驱动器 RDSON，由你的器件手册给出），' +
			'但**具体限值一律以你的 SoC / 存储器手册为准**。',
	)

	const suggested = warnings.length > 0 ? suggestDowngrade(mode) : null
	if (suggested) {
		notes.push(
			`降档建议：先退到 ${SD_BUS_MODES[suggested].label}（${suggested}）复测，` +
				`它的时钟上限 ${(SD_BUS_MODES[suggested].clockMaxHz / 1e6).toFixed(3)} MHz 更低、对走线更宽松。`,
		)
	}

	return {
		mode: spec.id,
		modeLabel: spec.label,
		busWidth: busWidth ?? null,
		skewPs,
		maxSkewPs: maxSkewPs ?? null,
		loadPf: loadPf ?? null,
		maxLoadPf: maxLoadPf ?? null,
		suggestedDowngrade: suggested,
		checks,
		warnings,
		notes,
	}
}

/**
 * 总入口：把一个速度档 + 一块传输参数，走完整条链路。
 *
 * 依次做四件事：
 *   1. 档位与时钟合理性（规范上限）；
 *   2. 位宽合法性（规范允许的位宽）；
 *   3. 理论峰值 → 扣开销 → 有效吞吐与效率；
 *   4. 把 1.8 V 信令 / tuning / Data Strobe 这些规范前提作为 `notes` 抛出。
 *
 * @param {object} input - 见 {@link effectiveThroughput}，另加：
 * @param {number} [input.identificationClockHz] - 若给了，附带做识别阶段限速检查。
 * @returns {object} 统一形状的完整结果。
 */
export function analyzeSdio(input) {
	const t = effectiveThroughput(input)
	const spec = getBusMode(input.mode)
	const checks = [...t.checks]
	const warnings = [...t.warnings]
	const notes = [...t.notes]

	let init = null
	if (input.identificationClockHz !== undefined) {
		init = checkInitializationClock({ clockHz: input.identificationClockHz, phase: 'identification' })
		checks.push(...init.checks)
		warnings.push(...init.warnings)
		notes.push(...init.notes)
	} else {
		notes.push(
			'未提供 identification_clock_hz，未检查识别阶段是否停留在 f_OD ≤ 400 kHz。' +
				'识别阶段用错时钟是一类典型现场问题（换卡才复现），建议把实际识别时钟传进来。',
		)
	}

	// 档位与宿主能力的对照：（SDHC/SDXC 卡在高速档下若卡本身不支持，需要靠 CMD6 查询确认）
	if (spec.family === 'sd' && spec.maxBusMBps >= 50) {
		notes.push(
			`${spec.label} 属于 UHS-I 高档：卡端必须有对应能力（CMD6 的 Switch Function / ` +
				'SCR 里的版本位），主机能力与卡能力取交集，否则实际只能跑在更低的档上。',
		)
	}

	return {
		mode: t.mode,
		modeLabel: t.modeLabel,
		family: t.family,
		signalingV: t.signalingV,
		clockHz: t.clockHz,
		busWidth: t.busWidth,
		edgesPerClock: t.edgesPerClock,
		blockBytes: t.blockBytes,
		blocks: t.blocks,
		direction: t.direction,
		responseType: t.responseType,
		responseBits: t.responseBits,
		peakBytesPerSecond: t.peakBytesPerSecond,
		peakBitsPerSecond: t.peakBitsPerSecond,
		effectiveBytesPerSecond: t.effectiveBytesPerSecond,
		efficiencyPercent: t.efficiencyPercent,
		cmdSharePercent: t.cmdSharePercent,
		totalNs: t.totalNs,
		cmdNs: t.cmdNs,
		dataNs: t.dataNs,
		busyTotalNs: t.busyTotalNs,
		gapTotalNs: t.gapTotalNs,
		hostOverheadNs: t.hostOverheadNs,
		identification: init,
		checks,
		warnings,
		notes,
	}
}
