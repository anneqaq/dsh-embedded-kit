/**
 * SMBus / PMBus 命令层：超时与时钟拉伸判定、PEC、数据格式换算、读事务时序。
 *
 * 本模块**只管命令层**：
 *   - 电气层（上拉区间、总线电容、上升时间）在 `lib/i2c.js`，这里不重复算；
 *   - CRC 引擎在 `lib/crc.js`，PEC **直接复用其中的 `crc8` 预设**，本模块不另造 CRC。
 *
 * ── 设计值 vs 必须实测 ────────────────────────────────────────────────────────
 * 设计值（规范给定，可当契约）：tTIMEOUT / tLOW:SEXT / tLOW:MEXT 的上限；LINEAR11 /
 *   LINEAR16 / DIRECT 的换算公式；PEC 的 CRC 参数（多项式、初值、是否反射）。
 * 必须实测 / 必须查手册：总线上实际的最长单次 SCL 低电平、从器件与主器件的累计
 *   拉伸时间、读事务是否真的用了重复起始（看波形上是 Sr 还是 STOP）、器件手册给出的
 *   m / b / R 系数、VID 码表、VOUT_MODE 的实际位域约定。
 * 本模块**不接受"我猜应该是"的输入**：凡器件相关的量都必须调用方传入，缺哪一项就在
 *   notes 里点名。
 *
 * ── 缺输入时的两种行为（全模块统一）────────────────────────────────────────────
 *   1. **换算函数**（linear11ToPhysical 等）缺必填输入 → 抛 `Error`，消息里点名缺的是
 *      哪一项、出自规范哪一条。因为缺了它根本算不出任何数，返回 null 只会让错误往下游跑。
 *   2. **判定函数**（analyze* 系列）缺可选实测数据 → 不抛错，推入一条 notes 点名缺什么，
 *      并把对应的 check 标成 `pass: null, skipped: true`（"没数据"和"不通过"是两件事，
 *      checklist 上必须能区分）。
 *
 * ── 出处登记（联网核实时间 2026-09-20）────────────────────────────────────────
 * [S1] SMBus Specification **Version 3.0**（2014-12）Table 2 "SMBus AC specifications"。
 *      三个速率等级（100 k / 400 k / 1 MHz）的这三项**完全一致**：
 *        tTIMEOUT    min 25 ms / max 35 ms
 *        tLOW:SEXT   max 25 ms（从器件，一次消息内 start→stop 的累计拉伸；Note 5）
 *        tLOW:MEXT   max 10 ms（主器件，每个字节内 start→ack / ack→ack / ack→stop 的累计拉伸；Note 6）
 *      Note 3 原文：任一单次 SCL 低电平区间超过 tTIMEOUT,MIN(25 ms) 时，参与传输的器件
 *      可以中止传输并释放总线；已检测到超时的器件必须在 tTIMEOUT,MAX(35 ms) 之前复位通信，
 *      并且"只有把 SCL 持续拉低到 ≥ tTIMEOUT,MAX 才能**确保**逼出对端超时"。
 *      → 25 与 35 不是"典型值"的两个数，而是**下限阈值与清除期限**（见本文件注释）。
 *      SMBus 1.0（1995）§2.1 已是同一组数值；最新版为 3.3.1（2024-10-20）。
 *      文档：http://www.smbus.org/specs/SMBus_3_3_1_20241020.pdf
 *      交叉核对（数值口径一致）：PMBus Part I Rev 1.2 §5.2.6.2 Table 2（专为 400 kHz
 *      列出）与 TI LM25056 / bq2060 数据手册的 SMBus AC 表。
 * [S2] 官方在线 PEC 计算器与规范正文：SMBus 3.3.1 §6.4 Packet Error Checking ——
 *      "The PEC is a CRC-8 error-checking byte, calculated on all the message bytes
 *      (including addresses and read/write bits)."；PEC 由提供最后一个数据字节的一方追加；
 *      §6.4.1 鼓励在 PEC 不对时回 NACK。Quick Command 与 Host Notify 两种协议没有 PEC 变体。
 *      计算器：http://smbus.org/faq/crc8Applet.htm
 * [S3] PEC 的 CRC-8 **参数**：多项式 x^8+x^2+x^1+1（0x07）、初值 0x00、输入/输出均不反射、
 *      xorout 0x00。多项式与覆盖范围见 SBS-IF / 厂商应用笔记（MLX90614 SMBus App Note：
 *      "C(x) = x8 + x2 + x1 + 1 … must be calculated in the order of the bits as received.
 *      The PEC calculation includes all bytes in the transmission, including address, command
 *      and data. … does not include ACK, NACK, START, STOP nor Repeated START bits."）；
 *      "初值 0x00 + 不反射"由 ST 官方社区线程（STM32 CRC 外设配置 GeneratingPolynomial=0x07、
 *      InitValue=0x00、INPUTDATA_INVERSION_NONE、OUTPUTDATA_INVERSION_DISABLE 得到 0xE8）
 *      与 SMBus 官方计算器互相印证。
 *      → 逐字段等于 `lib/crc.js` 里的 **`crc8`** 预设，所以这里直接 `computePreset`，
 *        不再抄一份 CRC 实现（抄两份迟早会漂移）。
 * [S4] PEC 已知报文基准（见 `PEC_KNOWN_VECTORS`，probe 逐条断言；本机已用 `crc8` 预设复算一致）：
 *        TI bq2084-V143 数据手册 SLUS732 "PEC Calculation"：Read Word
 *          0x16 0F 17 E9 03 → PEC 0xE8
 *        TI E2E 论坛帖 131585：Read Word 0x16 0D 17 10 00 → PEC 0x64
 * [P1] PMBus Specification **Part I Rev 1.2**（2010-09）§5.1：
 *      "PMBus devices must use the System Management Bus (SMBus), Version 2.0 … for transport
 *       with the extensions and exceptions listed below."（§5.2 是扩展清单）
 * [P2] PMBus Part II Rev 1.3.1 §7.3 **LINEAR11**："X = Y · 2^N"，Y 为 11 位二进制补码尾数，
 *      N 为 5 位二进制补码指数；两字节在总线上按 {N, Y} 排（高字节高 5 位是 N、低 3 位是
 *      Y 的高 3 位，低字节是 Y 的低 8 位）。规范原文："Devices that use the LINEAR11 format
 *      must accept and be able to process any value of N." —— 写方向"选哪个 N"是实现自由度，
 *      所以本模块的编码方向让调用方决定（不指定时才自动选，规则见 physicalToLinear11）。
 * [P3] PMBus Part II §7.4.1 **DIRECT**：读回值 "X = (1/m)(Y × 10^−R − b)"；写入值反解
 *      "Y = (mX + b) × 10^R"。m（斜率）与 b（偏置）是两字节二进制补码，R（指数）是一字节
 *      二进制补码，Y 是器件返回的两字节二进制补码。m / b / R 由 COEFFICIENTS 命令或器件
 *      手册给出 —— 本模块**不内置任何一组系数**。
 * [P4] PMBus Part II §8.1~8.3 **VOUT_MODE**（命令码 0x20）：数据字节 = {Mode[7:5], Parameter[4:0]}；
 *        Mode 000b = Linear（Parameter 是输出侧 16 位尾数共用的 5 位补码指数 N）
 *        Mode 001b = VID   （Parameter = VID Code Type，见 §8.3.2 Table 3）
 *        Mode 010b = Direct（§8.3.3；Parameter 规范定为 00000b）
 *        Mode 011b = IEEE half precision floating point
 *      **LINEAR16**（§8.3.1）：Voltage = V × 2^N，V 为 16 位 —— ULINEAR16 无符号（VOUT_COMMAND
 *      等输出电压参数），SLINEAR16 二进制补码（VOUT_TRIM / VOUT_CAL_OFFSET 等允许为负的量）。
 *      **VID**（§8.3.2）：VID code 右对齐，VID0 在低字节 bit0，未用位补 0；VID Code Type
 *      1Eh / 1Fh 为厂商自定义，原文 "The details of the relationship between the VID codes and
 *      output voltage shall be provided in the PMBus device product literature" —— 所以
 *      **码→电压表必须由调用方传入**，本模块只做位域提取与查表。
 *      ⚠ 器件差异（实测存在）：至少一家（Vishay SiC951 手册）把 bit7 改定义为"0 绝对 /
 *        1 相对"，模式位挪到 [6:5]。`parseVoutMode` 支持两种位域，但**必须调用方显式指定**，
 *        不猜。
 * [P5] 读事务必须用**重复起始（Sr）**，不得用"停止 + 起始"：
 *      [P1] §5.1 要求 PMBus 设备采用 SMBus 传输层；SMBus 3.0 §6.5 的 Read Byte / Read Word
 *      协议图本身就是用 Sr 把"写命令"与"读数据"两段连成一次传输的。
 *      第三方口径一致：
 *        EEWeb《Implementing a Robust PMBus System》："Repeated starts (restarts) are not
 *          supported by all I²C controllers but are required for PMBus/SMBus reads."
 *        Infineon SMBus/PMBus Slave 组件手册："For read transactions, the host switches
 *          between writing the read command code to reading the requested data by issuing a
 *          REPEATED START bus condition. The STOP bit is only generated once the entire
 *          transaction is completed."
 *        CERN IPMC 论坛实例：同一块器件用"STOP 再 START"读 COEFFICIENTS 得到 0xFFFFFFFFFF,
 *          换成 Sr 才拿到正确系数 —— 写错不是"慢一点"，是读回垃圾。
 *      ⚠ 条款号待复核：PMBus Part I §5 是 "Transport"，本仓库核对到的位置是 §5.1（采用 SMBus 2.0）
 *        与 §5.2（扩展，其中 Group Command Protocol 明确用 Sr 分隔子包）；"读事务必须用 Sr"
 *        这句在 Part I 里的**确切条款号未逐字核到**，请主代理复核。厂商手册与第三方应用笔记
 *        口径一致，实践上无争议。
 *
 * @module dsh-embedded-kit/pmbus
 */

import { computePreset } from './crc.js'

// ─────────────────────────────────────────────────────────────────────────────
// 常量（出处见文件头出处登记）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SMBus / PMBus 传输层的时钟超时与拉伸上限。
 *
 * 出处：[S1] SMBus 3.0 Table 2（100 k / 400 k / 1 MHz 三档同值）；
 * 交叉核对 PMBus Part I Rev 1.2 §5.2.6.2 Table 2、TI LM25056 / bq2060 数据手册。
 *
 * `tTimeoutMinMs` / `tTimeoutMaxMs` 的语义（别当成"典型值"）：
 *   - 单次 SCL 低电平 > `tTimeoutMinMs`（25 ms）时，参与传输的器件**可以**中止传输并释放总线；
 *   - 检测到超时的器件必须在 `tTimeoutMaxMs`（35 ms）之前复位通信，能接收新的 START；
 *   - 因此"保证不会误触发超时"的设计目标是单次低电平 **< 25 ms**；
 *     而"确保逼出对端超时"则要求主动拉低 **≥ 35 ms**。
 */
export const SMBUS_TRANSPORT_LIMITS = {
	tTimeoutMinMs: 25,
	tTimeoutMaxMs: 35,
	tLowSextMaxMs: 25,
	tLowMextMaxMs: 10,
	/** 总线空闲时间下限 tBUF（STOP 到 START），按 fSMB 分档，单位 µs —— 用于估"错误地用 STOP 分段"放开的窗口有多长。 */
	tBufMinUs: { 100000: 4.7, 400000: 1.3, 1000000: 0.5 },
	source: 'SMBus 3.0 (2014-12) Table 2；交叉核对 PMBus Part I Rev 1.2 §5.2.6.2 Table 2',
}

/**
 * PEC 使用的 CRC 参数，逐字段对应 `lib/crc.js` 的 `crc8` 预设。
 * 出处：[S3]。`width/poly/init/refin/refout/xorout` 为该预设的内容，此处只做登记与自检用。
 */
export const PEC_CRC_PARAMS = {
	presetName: 'crc8',
	width: 8,
	poly: 0x07,
	init: 0x00,
	refin: false,
	refout: false,
	xorout: 0x00,
	polynomial: 'x^8 + x^2 + x^1 + 1',
	source: 'SMBus 3.3.1 §6.4 与 SBS-IF/厂商应用笔记；参数组合等价于 lib/crc.js 的 crc8 预设',
}

/**
 * PEC 已知报文基准（出处 [S4]）。probe 会逐条断言。
 * `bytes` 是**参与 PEC 计算的全部字节**（含地址字节，不含 PEC 自身、不含 ACK/START/STOP/Sr）。
 */
export const PEC_KNOWN_VECTORS = [
	{
		label: 'bq2084-V143 Read Word（RemainingCapacity）',
		bytes: [0x16, 0x0f, 0x17, 0xe9, 0x03],
		pec: 0xe8,
		source: 'TI bq2084-V143 数据手册 SLUS732 "PEC Calculation"（地址+W 0x16 / 命令 0x0F / 地址+R 0x17 / 数据 0x03E9 小端）',
	},
	{
		label: 'TI E2E 131585 Read Word',
		bytes: [0x16, 0x0d, 0x17, 0x10, 0x00],
		pec: 0x64,
		source: 'TI E2E 论坛帖 131585（命令 0x0D、数据 0x0010 → 报文 0x160D171000 → PEC 0x64）',
	},
]

/**
 * 数据格式换算的已知基准对（出处 [P2] / [P3] / [P4]），供 probe 与后续 selftest 断言之用。
 * 全部来自厂商手册里"寄存器值 + 期望物理值"成对出现的表格，不是本模块反推的。
 */
export const PMBUS_FORMAT_VECTORS = {
	linear11: [
		{ label: 'VOUT_TRANSITION_RATE', raw: 0xe002, value: 0.125, exponent: -4, mantissa: 2, source: 'Vishay SiC951 手册 0x27 默认值 0xE002 = 0.125 mV/µs' },
		{ label: 'VOUT_SCALE_LOOP', raw: 0xe808, value: 1, exponent: -3, mantissa: 8, source: 'Vishay SiC951 手册 0x29 默认值 0xE808 = 1' },
		{ label: 'VIN_ON', raw: 0xf814, value: 10, exponent: -1, mantissa: 20, source: 'Vishay SiC951 手册 0x35 默认值 0xF814 = 10 V' },
		{ label: 'FREQUENCY_SWITCH', raw: 0x0258, value: 600, exponent: 0, mantissa: 600, source: 'Vishay SiC951 手册 0x33 默认值 0x0258 = 600 kHz' },
	],
	linear16: [
		{ label: 'VOUT_COMMAND (ULINEAR16, N=-13)', raw: 0x2666, exponent: -13, signed: false, value: 9830 * 2 ** -13, source: 'Intel/Altera EM22xx 应用笔记：0x2666 = 9830 × 2^−13 = 1.2 V' },
		{ label: 'VOUT_COMMAND (SLINEAR16, N=-9)', raw: 0x0133, exponent: -9, signed: true, value: 307 * 2 ** -9, source: 'Vishay SiC951 手册 0x21 默认值 0x0133、VOUT_MODE=0x17（N=−9）= 0.6 V' },
	],
	direct: [
		{ label: 'READ_VIN (m=4617, b=-140, R=-2)', raw: 552, m: 4617, b: -140, r: -2, value: (552 * 100 + 140) / 4617, source: 'Richtek RTQ1950 数据手册 §18.2 系数表（VIN 组：m=4617, b=−140, R=−2），Y 由本模块反解得到' },
	],
}

/**
 * VOUT_MODE 数据字节支持的两种位域约定（出处 [P4] 及其⚠）。
 *   - `spec-7:5`：规范写法，Mode = 数据字节 bit[7:5]、Parameter = bit[4:0]。
 *   - `legacy-6:5`：部分器件把 bit7 挪作"0 绝对 / 1 相对"标志，Mode 缩到 bit[6:5]。
 * 本模块不猜用哪一种，必须调用方显式指定。
 */
export const VOUT_MODE_LAYOUTS = {
	'spec-7:5': { modeShift: 5, modeMask: 0b111, modeBitHigh: 7, hasRelativeBit: false, source: 'PMBus Part II §8.2 Table 2' },
	'legacy-6:5': { modeShift: 5, modeMask: 0b011, modeBitHigh: 6, hasRelativeBit: true, source: '厂商器件手册中的变体（如 Vishay SiC951 的 0x20 定义）' },
}

/** VOUT_MODE 的 Mode 位取值 → 名称（出处 [P4]）。 */
export const VOUT_MODE_MODES = {
	0b000: 'linear',
	0b001: 'vid',
	0b010: 'direct',
	0b011: 'ieee-half',
}

/** VOUT_MODE 的 Mode 位取值对应的中文说明。 */
export const VOUT_MODE_MODE_LABELS = {
	linear: 'Linear（ULINEAR16 / SLINEAR16，Parameter 是 5 位补码指数 N）',
	vid: 'VID（Parameter 是 VID Code Type）',
	direct: 'Direct（Parameter 规范定为 00000b；R 来自 COEFFICIENTS 或手册）',
	'ieee-half': 'IEEE 754 半精度浮点（本模块不实现换算）',
}

/** PMBus 读事务的协议名（出处 [P5]，SMBus 3.0 §6.5）。 */
export const PMBUS_READ_KINDS = {
	'read-byte': { dataBytes: 1, label: 'Read Byte' },
	'read-word': { dataBytes: 2, label: 'Read Word（低字节先）' },
	'block-read': { dataBytes: null, label: 'Block Read（首字节是后续数据字节个数）' },
}

/** LINEAR11 指数 N 的可取范围（5 位二进制补码）。 */
export const LINEAR11_EXPONENT_RANGE = { min: -16, max: 15 }

/** LINEAR11 尾数 Y 的可取范围（11 位二进制补码）。 */
export const LINEAR11_MANTISSA_RANGE = { min: -1024, max: 1023 }

// ─────────────────────────────────────────────────────────────────────────────
// 内部工具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把 `bits` 位二进制补码还原成有符号整数。
 *
 * @param {number} value - 无符号位域值。
 * @param {number} bits - 位宽。
 * @returns {number} 有符号值。
 */
function signExtend(value, bits) {
	const signBit = 1 << (bits - 1)
	const masked = value & ((1 << bits) - 1)
	return (masked ^ signBit) - signBit
}

/**
 * 四舍五入并远离零（负数也对称）。JS 的 `Math.round(-0.5)` 得 `-0`，在补码编码里容易踩坑。
 *
 * @param {number} x - 输入。
 * @returns {number} 整数。
 */
function roundAwayFromZero(x) {
	return x < 0 ? -Math.round(-x) : Math.round(x)
}

/**
 * 校验一个整数是否落在闭区间内。
 *
 * @param {string} name - 参数名（用于错误消息）。
 * @param {number} value - 待校验值。
 * @param {number} min - 下限。
 * @param {number} max - 上限。
 * @param {string} why - 为什么有这个约束（写清出处，便于排查）。
 */
function assertIntInRange(name, value, min, max, why) {
	if (!Number.isInteger(value)) throw new Error(`${name} 必须是整数，收到 ${value}。${why}`)
	if (value < min || value > max) throw new Error(`${name} = ${value} 超出 [${min}, ${max}]。${why}`)
}

/**
 * 判断两个字节数组是否逐元素相等。
 *
 * @param {number[]} a - 数组 A。
 * @param {number[]} b - 数组 B。
 * @returns {boolean} 是否相等。
 */
function bytesEqual(a, b) {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) if ((a[i] & 0xff) !== (b[i] & 0xff)) return false
	return true
}

/**
 * 把字节数组格式化成 `0x0F 0x17` 形式，便于写进 detail。
 *
 * @param {number[]} bytes - 字节数组。
 * @returns {string} 十六进制字符串。
 */
function hexList(bytes) {
	return bytes.map((b) => `0x${(b & 0xff).toString(16).toUpperCase().padStart(2, '0')}`).join(' ')
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. SMBus 超时与时钟拉伸
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SMBus 超时与时钟拉伸上限判定。
 *
 * 输入全是**实测值**，本模块不替你把"应该不会太久"当成 0。缺的项会在 notes 里点名，
 * 对应的 check 标 `pass: null, skipped: true`。
 *
 * @param {object} [input] - 输入。
 * @param {number} [input.maxClockLowMs] - 实测**最长单次** SCL 低电平（ms），对上 tTIMEOUT。逻辑分析仪量一次完整消息里最长的那个低电平区间。
 * @param {number} [input.slaveStretchCumulativeMs] - 从器件在一次消息（start→stop）内的**累计**拉伸（ms），对上 tLOW:SEXT。
 * @param {number} [input.masterStretchCumulativeMs] - 主器件在**每个字节内**（start→ack / ack→ack / ack→stop）的累计拉伸（ms），对上 tLOW:MEXT。
 * @param {number} [input.forceTimeoutHoldMs] - 若某器件想"确保逼出"对端超时，它把 SCL 拉低的时长（ms），对上 tTIMEOUT(max)。
 * @param {number} [input.busSpeedHz] - 实际总线速率（Hz），只用于解释 tBUF 窗口，不参与判定。
 * @returns {object} `{ limits, marginsMs, checks, warnings, notes, ...实测值 }`；`checks[].pass === null` 表示该输入没给、无法判定。
 */
export function analyzeSmbusTiming(input = {}) {
	const limits = SMBUS_TRANSPORT_LIMITS
	const { maxClockLowMs, slaveStretchCumulativeMs, masterStretchCumulativeMs, forceTimeoutHoldMs, busSpeedHz } = input

	const checks = []
	const warnings = []
	const notes = []
	/** @type {Record<string, number|null>} */
	const marginsMs = {
		maxClockLow: null,
		slaveStretch: null,
		masterStretch: null,
		forceTimeout: null,
	}

	notes.push(
		`上限出处：${limits.source}。tTIMEOUT 的 25 ms 是**误触发阈值**（单次低电平超过它，` +
			`参与传输的器件可以中止并释放总线），35 ms 是**清除期限**（检测到超时的器件必须在此之前复位通信）。`,
	)
	notes.push(
		'tLOW:SEXT 与 tLOW:MEXT 都是**累计**量，不是单次量：SEXT 从一次消息的 start 累到 stop，' +
			'MEXT 在每个字节内（start→ack / ack→ack / ack→stop）重新起算。判定前先用逻辑分析仪/示波器把' +
			'这两个累计量和"最长单次低电平"分开量出来，不要用手册的 typ 值代替。',
	)

	// 1) 单次 SCL 低电平 tTIMEOUT
	if (typeof maxClockLowMs === 'number') {
		const ok = maxClockLowMs < limits.tTimeoutMinMs
		marginsMs.maxClockLow = limits.tTimeoutMinMs - maxClockLowMs
		checks.push({
			name: 'tTIMEOUT（单次 SCL 低电平）',
			pass: ok,
			detail: `实测最长单次低电平 ${maxClockLowMs} ms，判定线 tTIMEOUT(min) = ${limits.tTimeoutMinMs} ms，裕量 ${marginsMs.maxClockLow.toFixed(2)} ms`,
		})
		if (!ok) {
			if (maxClockLowMs < limits.tTimeoutMaxMs) {
				warnings.push(
					`最长单次 SCL 低电平 ${maxClockLowMs} ms 已越过 tTIMEOUT(min) = ${limits.tTimeoutMinMs} ms 但未到 ` +
						`${limits.tTimeoutMaxMs} ms：对端**允许**在这个区间内判定超时并中止传输、释放总线，` +
						`但规范不强制它一定已经复位完毕 —— 这是最危险的灰区，通信会偶发失败且难以复现。把暂停拆小。`,
				)
			} else {
				warnings.push(
					`最长单次 SCL 低电平 ${maxClockLowMs} ms ≥ tTIMEOUT(max) = ${limits.tTimeoutMaxMs} ms：` +
						`对端必然已判超时并复位通信，本次传输作废。查为什么会有这么长的时钟拉伸（从器件卡住？主设备被高优先级中断抢占？）。`,
				)
			}
		}
	} else {
		checks.push({
			name: 'tTIMEOUT（单次 SCL 低电平）',
			pass: null,
			skipped: true,
			detail: `缺 maxClockLowMs：需要实测（或从器件手册查）最长单次 SCL 低电平，判定线 ${limits.tTimeoutMinMs} ms`,
		})
		notes.push('缺 `maxClockLowMs`：未判定 tTIMEOUT。这一项**必须实测**，手册只给器件的拉伸能力上限，不给你的固件会不会超。')
	}

	// 2) 从器件累计拉伸 tLOW:SEXT
	if (typeof slaveStretchCumulativeMs === 'number') {
		const ok = slaveStretchCumulativeMs <= limits.tLowSextMaxMs
		marginsMs.slaveStretch = limits.tLowSextMaxMs - slaveStretchCumulativeMs
		checks.push({
			name: 'tLOW:SEXT（从器件累计拉伸）',
			pass: ok,
			detail: `实测累计 ${slaveStretchCumulativeMs} ms，上限 ${limits.tLowSextMaxMs} ms，裕量 ${marginsMs.slaveStretch.toFixed(2)} ms`,
		})
		if (!ok) {
			warnings.push(
				`从器件累计拉伸 ${slaveStretchCumulativeMs} ms 超过 tLOW:SEXT = ${limits.tLowSextMaxMs} ms。` +
					`规范期望此时从器件释放 SCL/SDA 并复位自己；实际表现是本条消息后半段开始读到垃圾。` +
					`对策：拆分消息（多读几次少读几个字节）、降低该器件的处理负担，或降到更慢的总线速率给它更多时间。`,
			)
		}
	} else {
		checks.push({
			name: 'tLOW:SEXT（从器件累计拉伸）',
			pass: null,
			skipped: true,
			detail: `缺 slaveStretchCumulativeMs：需要实测一次消息内从器件的累计拉伸，上限 ${limits.tLowSextMaxMs} ms`,
		})
		notes.push('缺 `slaveStretchCumulativeMs`：未判定 tLOW:SEXT。注意它按**整条消息**累计，器件手册给的"典型拉伸 20 ms"这类数字要换算成你实际会连读多少个字节。')
	}

	// 3) 主器件累计拉伸 tLOW:MEXT
	if (typeof masterStretchCumulativeMs === 'number') {
		const ok = masterStretchCumulativeMs <= limits.tLowMextMaxMs
		marginsMs.masterStretch = limits.tLowMextMaxMs - masterStretchCumulativeMs
		checks.push({
			name: 'tLOW:MEXT（主器件每字节累计拉伸）',
			pass: ok,
			detail: `实测每字节内累计 ${masterStretchCumulativeMs} ms，上限 ${limits.tLowMextMaxMs} ms，裕量 ${marginsMs.masterStretch.toFixed(2)} ms`,
		})
		if (!ok) {
			warnings.push(
				`主器件在单个字节内的累计时钟拉伸 ${masterStretchCumulativeMs} ms 超过 tLOW:MEXT = ${limits.tLowMextMaxMs} ms。` +
					`注意：规范只允许主器件在**主动逼出从器件超时**时违反这条，正常收发时不允许。` +
					`典型原因是在中断里做 I²C 状态机、被更高优先级中断抢占过久，或字节间做了 Flash 写。`,
			)
		}
	} else {
		checks.push({
			name: 'tLOW:MEXT（主器件每字节累计拉伸）',
			pass: null,
			skipped: true,
			detail: `缺 masterStretchCumulativeMs：需要实测主器件在每个字节内的累计拉伸，上限 ${limits.tLowMextMaxMs} ms`,
		})
		notes.push('缺 `masterStretchCumulativeMs`：未判定 tLOW:MEXT。软件位操作 I²C（bit-banging）几乎必然拉伸，必须实测而不是"反正是主设备我说了算"。')
	}

	// 4) 主动逼超时：必须 ≥ tTIMEOUT(max)
	if (typeof forceTimeoutHoldMs === 'number') {
		const ok = forceTimeoutHoldMs >= limits.tTimeoutMaxMs
		marginsMs.forceTimeout = forceTimeoutHoldMs - limits.tTimeoutMaxMs
		checks.push({
			name: '主动逼出对端超时（需 ≥ tTIMEOUT(max)）',
			pass: ok,
			detail: `计划拉低 ${forceTimeoutHoldMs} ms，要求 ≥ ${limits.tTimeoutMaxMs} ms，裕量 ${marginsMs.forceTimeout.toFixed(2)} ms`,
		})
		if (!ok) {
			warnings.push(
				`想靠拉低 SCL ${forceTimeoutHoldMs} ms 来逼对端超时是不够的：规范明确"只有拉低到 ≥ tTIMEOUT,MAX = ` +
					`${limits.tTimeoutMaxMs} ms 才能**确保**超时"。低于这个值对端可能只是判定了超时但还没复位完，` +
					`随后你发的 START 它接不住。`,
			)
		}
	}

	// 总线速率只用于解释 tBUF 窗口
	if (typeof busSpeedHz === 'number') {
		const keys = Object.keys(limits.tBufMinUs).map(Number).sort((a, b) => a - b)
		const nearest = keys.find((k) => k >= busSpeedHz) ?? keys[keys.length - 1]
		notes.push(
			`总线速率 ${busSpeedHz} Hz：同档位下 tBUF（STOP 到下一个 START 的最小空闲）为 ${limits.tBufMinUs[nearest]} µs。` +
				`这个窗口就是"用 STOP 把读事务切成两段"时放开给其它主器件的抢占机会（见 analyzeReadTransaction）。`,
		)
	}

	return {
		limits,
		maxClockLowMs: maxClockLowMs ?? null,
		slaveStretchCumulativeMs: slaveStretchCumulativeMs ?? null,
		masterStretchCumulativeMs: masterStretchCumulativeMs ?? null,
		forceTimeoutHoldMs: forceTimeoutHoldMs ?? null,
		marginsMs,
		checks,
		warnings,
		notes,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. PEC（Packet Error Checking）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 组装 PEC 的**覆盖字节序列**（即在 SDA 上按传输顺序出现、且参与 CRC 的那些字节）。
 *
 * 覆盖范围（出处 [S2] / [S3]）：地址字节（7 位地址 + R/W# 合成 1 字节）、命令字节、
 * 全部数据字节；**不含** PEC 自身、ACK/NACK、START/STOP/Repeated START。
 * 多字节数据按总线字节序（SMBus/PMBus 是小端：低字节先）。
 *
 * `read` 的语义是"**这是一次读事务**"，不是"这个地址字节的 R/W# 位"—— 因为读事务的
 * 覆盖里**地址字节出现两次**（一次 +W 送命令、一次 +R 收数据），两次都要算。三档行为：
 *   - `read: false`（写事务）：`[addr+W] + [command] + data`
 *   - `read: true` 且有 `command`（Read Byte / Word / Block Read）：
 *     `[addr+W] + [command] + [addr+R] + data`
 *   - `read: true` 且无 `command`（Receive Byte / ARA）：
 *     `[addr+R] + data` —— 这种协议本来就只有一段地址，没有"写命令"那一段。
 * Block Read 的 `data` 要**把首字节的 COUNT 也算进去**（规范里 PEC 覆盖它）。
 *
 * 漏掉读事务里的第二个地址字节，是"PEC 一直对不上"的头号原因。
 *
 * @param {object} input - 输入。
 * @param {number} input.address7 - 7 位器件地址（0..127）。
 * @param {boolean} [input.read] - 是否读事务，语义见上。默认 false。
 * @param {number} [input.command] - 命令码（0..255）。Quick Command 没有 PEC 变体（出处 [S2]），故可省。
 * @param {number[]|Uint8Array} [input.data] - 数据字节，**按总线顺序**（低字节先）。
 * @returns {number[]} 参与 PEC 计算的字节数组。
 * @throws {Error} 地址或命令码越界、缺地址时抛出。
 */
export function pecCoverageBytes({ address7, read = false, command, data = [] }) {
	assertIntInRange('address7', address7, 0, 0x7f, 'SMBus/PMBus 是 7 位地址，R/W# 位另算（出自 SMBus 3.0 §5.1 地址格式）')
	const addrByte = (rw) => (address7 << 1) | rw
	const hasCommand = command !== undefined && command !== null
	if (hasCommand) {
		assertIntInRange('command', command, 0, 0xff, '命令码是 1 字节（出处 PMBus Part II §5.3：所有命令都是 8 位）')
	}

	const out = []
	if (read && !hasCommand) {
		// Receive Byte / ARA：只有一段 +R 地址
		out.push(addrByte(1))
	} else if (read) {
		// Read Byte / Word / Block Read：+W 送命令，+R 收数据，两段地址都算
		out.push(addrByte(0), command & 0xff, addrByte(1))
	} else {
		out.push(addrByte(0))
		if (hasCommand) out.push(command & 0xff)
	}

	for (const b of data) {
		assertIntInRange('data 元素', b, 0, 0xff, '数据字节必须是 0..255')
		out.push(b & 0xff)
	}
	return out
}

/**
 * 计算 SMBus PEC。
 *
 * 直接复用 `lib/crc.js` 的 `crc8` 预设（多项式 0x07、初值 0x00、不反射、xorout 0x00），
 * 本模块不另写 CRC 实现 —— 同一个协议存在两份 CRC 代码，迟早会有一份漂移。
 *
 * @param {number[]|Uint8Array} bytes - 参与计算的字节（用 {@link pecCoverageBytes} 生成）。
 * @returns {number} PEC 字节（0..255）。
 */
export function computePec(bytes) {
	return computePreset(bytes, PEC_CRC_PARAMS.presetName) & 0xff
}

/**
 * 比对收到的 PEC。
 *
 * @param {number[]|Uint8Array} bytes - 参与计算的字节（用 {@link pecCoverageBytes} 生成）。
 * @param {number} receivedPec - 总线上收到的 PEC 字节。
 * @returns {{ok: boolean, expected: number, received: number, expectedHex: string, receivedHex: string}} 比对结果。
 */
export function verifyPec(bytes, receivedPec) {
	const expected = computePec(bytes)
	return {
		ok: expected === (receivedPec & 0xff),
		expected,
		received: receivedPec & 0xff,
		expectedHex: `0x${expected.toString(16).toUpperCase().padStart(2, '0')}`,
		receivedHex: `0x${(receivedPec & 0xff).toString(16).toUpperCase().padStart(2, '0')}`,
	}
}

/**
 * PEC 判定：算出应有值、比对收到的值，并检查"参与计算的字节序列"是否与波形一致。
 *
 * 第二个检查是这里最有价值的一条 —— `observedBytes`（逻辑分析仪抓到的、PEC 之前的全部
 * 字节）和模块按 (地址, R/W#, 命令, 数据) 推出的应有序列一比，就能立刻定位
 * "读事务漏掉第二个地址字节""把 PEC 自己也算进去了""16 位数据写成大端"这三类高频错误。
 *
 * @param {object} input - 输入。
 * @param {number} input.address7 - 7 位器件地址。
 * @param {boolean} [input.read] - 是否读事务。**会影响覆盖范围**：读事务的覆盖里有 +W 与 +R 两个地址字节，语义见 {@link pecCoverageBytes}。
 * @param {number} [input.command] - 命令码。读事务里它是 +W 那一段的命令。
 * @param {number[]|Uint8Array} [input.data] - 数据字节，按总线顺序（Block Read 要含 COUNT 字节）。
 * @param {number} [input.receivedPec] - 总线上收到的 PEC。
 * @param {number[]|Uint8Array} [input.observedBytes] - 波形上实际参与 PEC 覆盖的字节，用于交叉校验。
 * @returns {object} `{ coverage, expectedPec, receivedPec, checks, warnings, notes }`。
 */
export function analyzePec({ address7, read = false, command, data = [], receivedPec, observedBytes }) {
	const coverage = pecCoverageBytes({ address7, read, command, data })
	const expectedPec = computePec(coverage)
	const checks = []
	const warnings = []
	const notes = []

	notes.push(
		`PEC 覆盖范围（出处 [S2] SMBus 3.3.1 §6.4）：地址字节（含 R/W#）、命令码、全部数据字节；` +
			`**不含** PEC 自身、ACK/NACK、START/STOP/Repeated START。本例应有 ${coverage.length} 个字节参与计算：${hexList(coverage)}。`,
	)
	notes.push(
		`CRC 参数：${PEC_CRC_PARAMS.polynomial}，poly=0x${PEC_CRC_PARAMS.poly.toString(16).padStart(2, '0')}、` +
			`init=0x${PEC_CRC_PARAMS.init.toString(16).padStart(2, '0')}、refin/refout=不反射、xorout=0x00；` +
			`等价于 lib/crc.js 的 \`${PEC_CRC_PARAMS.presetName}\` 预设（出处 [S3]）。`,
	)
	if (read) {
		notes.push(
			command === undefined || command === null
				? '读事务（Receive Byte / ARA 类）：覆盖里只有一段 +R 地址（这种协议本来就没有"写命令"那一段）。'
				: '读事务里地址字节算**两次**（第一步 +W 送命令、第二步 +R 收数据），两次都要进 CRC。' +
						'对照波形数一下 coverage 的地址字节：两个只差最低位（R/W#）。',
		)
	}

	// 覆盖字节序列：有波形数据才判定
	if (observedBytes) {
		const observed = Array.from(observedBytes, (b) => b & 0xff)
		const ok = bytesEqual(observed, coverage)
		let detail = `波形 ${hexList(observed)} vs 应有 ${hexList(coverage)}`
		if (!ok) {
			const n = Math.min(observed.length, coverage.length)
			let at = -1
			for (let i = 0; i < n; i += 1) {
				if (observed[i] !== coverage[i]) {
					at = i
					break
				}
			}
			detail +=
				at >= 0
					? `；第 ${at + 1} 个字节起不一致（波形 0x${observed[at].toString(16)} vs 应有 0x${coverage[at].toString(16)}）`
					: `；前 ${n} 个字节一致，但长度不同（${observed.length} vs ${coverage.length}）`
			warnings.push(
				'波形上的字节序列与应有覆盖范围不一致，PEC 必然对不上。按顺序排查三件事：' +
					'(1) 读事务是否漏掉了第二个地址字节；(2) 是否把 PEC 字节自己也算进了 CRC；' +
					'(3) 16 位数据是否按小端（低字节先）送入 CRC。',
			)
		}
		checks.push({ name: 'PEC 覆盖字节序列', pass: ok, detail })
	} else {
		checks.push({
			name: 'PEC 覆盖字节序列',
			pass: null,
			skipped: true,
			detail: '缺 observedBytes：未与波形交叉校验。建议用逻辑分析仪抓 PEC 之前的全部字节传进来，这是定位"PEC 总对不上"最快的一步',
		})
		notes.push('缺 `observedBytes`：无法确认发送方与接收方的覆盖范围一致。只比对 CRC 值无法区分"算法不一致"和"范围不一致"。')
	}

	// PEC 值本身
	if (typeof receivedPec === 'number') {
		const v = verifyPec(coverage, receivedPec)
		checks.push({
			name: 'PEC 校验值',
			pass: v.ok,
			detail: `应有 ${v.expectedHex}，收到 ${v.receivedHex}${v.ok ? '（一致）' : '（不一致）'}`,
		})
		if (!v.ok) {
			warnings.push(
				`PEC 不匹配（应有 ${v.expectedHex}，收到 ${v.receivedHex}）。SMBus 3.3.1 §6.4.1 鼓励接收方在 PEC 错时回 NACK；` +
					`发送方收到 PEC 后的 NACK 说明对端链路层已发现错误，不要重试同一个值，要重发整条消息。` +
					`若长期 100% 不匹配（而不是偶发），按上一段的三个顺序排查覆盖范围，而不是怀疑信号质量。`,
			)
		}
	} else {
		checks.push({
			name: 'PEC 校验值',
			pass: null,
			skipped: true,
			detail: `缺 receivedPec：只算出了应有值 ${`0x${expectedPec.toString(16).toUpperCase().padStart(2, '0')}`}`,
		})
	}

	return { address7, read, command: command ?? null, data: Array.from(data), coverage, expectedPec, receivedPec: receivedPec ?? null, checks, warnings, notes }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. PMBus 数据格式换算
// ─────────────────────────────────────────────────────────────────────────────

/**
 * LINEAR11 解码：原始两字节 → 物理值。出处 [P2]：X = Y · 2^N。
 *
 * 位域：`raw = (N << 11) | (Y & 0x7FF)`，即高字节 bits[7:3] = N、bits[2:0] = Y 的高 3 位。
 * N 是 5 位二进制补码，Y 是 11 位二进制补码（**都为有符号**，器件返回负值是正常的，
 * 例如负温度、负电流）。
 *
 * @param {number} raw - 原始 16 位值（0..0xFFFF）。
 * @returns {{raw: number, exponent: number, mantissa: number, value: number}} 指数 N、尾数 Y 与物理值 X。
 * @throws {Error} raw 不是 0..0xFFFF 的整数时抛出。
 */
export function linear11ToPhysical(raw) {
	assertIntInRange('raw', raw, 0, 0xffff, 'LINEAR11 是两字节值（出处 PMBus Part II §7.3）')
	const exponent = signExtend((raw >>> 11) & 0x1f, 5)
	const mantissa = signExtend(raw & 0x7ff, 11)
	return { raw, exponent, mantissa, value: mantissa * 2 ** exponent }
}

/**
 * LINEAR11 编码：物理值 → 原始两字节。
 *
 * 指数 N 由调用方指定时按指定值编码（PMBus 允许任意 N，选哪个 N 是主机实现自由度，
 * 见出处 [P2]）。未指定时自动选**能表示 x 且分辨率最细的那个 N**：在 [-16, 15] 里从小到大
 * 取第一个使 `round(x / 2^N)` 落在 11 位补码范围内的 N。
 *
 * 可表示范围：约 `±1023 × 2^15 ≈ ±3.35e7` 到 `1 × 2^-16 ≈ 1.5e-5`；越界会抛错而不是静默饱和。
 * x = 0 时自动选择会返回 N = -16、Y = 0（物理值不受指数影响）。
 *
 * @param {number} value - 物理值 X。
 * @param {object} [options] - 选项。
 * @param {number} [options.exponent] - 指定指数 N（-16..15）。器件若对某些命令有固定 N，必须显式给。
 * @returns {{raw: number, exponent: number, mantissa: number, value: number}} 编码结果；`value` 是**反解回来**的实际值，可与输入比较看量化误差。
 * @throws {Error} value 非有限数、指定的指数越界、或该值无法用 LINEAR11 表示时抛出。
 */
export function physicalToLinear11(value, { exponent } = {}) {
	if (!Number.isFinite(value)) throw new Error(`value 必须是有限数，收到 ${value}`)

	let n = exponent
	let y
	if (n === undefined) {
		let found = null
		for (let cand = LINEAR11_EXPONENT_RANGE.min; cand <= LINEAR11_EXPONENT_RANGE.max; cand += 1) {
			const rounded = roundAwayFromZero(value / 2 ** cand)
			if (rounded >= LINEAR11_MANTISSA_RANGE.min && rounded <= LINEAR11_MANTISSA_RANGE.max) {
				found = { n: cand, y: rounded }
				break
			}
		}
		if (found === null) {
			throw new Error(
				`${value} 无法用 LINEAR11 表示。可表示范围约 ±(1023 × 2^15) ≈ ±3.35e7 到 ±(1 × 2^-16) ≈ 1.53e-5` +
					`（出处 PMBus Part II §7.3：11 位补码尾数 + 5 位补码指数）。`,
			)
		}
		n = found.n
		y = found.y
	} else {
		assertIntInRange(
			'exponent',
			n,
			LINEAR11_EXPONENT_RANGE.min,
			LINEAR11_EXPONENT_RANGE.max,
			'LINEAR11 指数是 5 位二进制补码（出处 PMBus Part II §7.3）',
		)
		y = roundAwayFromZero(value / 2 ** n)
		if (y < LINEAR11_MANTISSA_RANGE.min || y > LINEAR11_MANTISSA_RANGE.max) {
			throw new Error(
				`value = ${value} 在指数 N = ${n} 下需要尾数 Y = ${y}，超出 11 位补码范围 [${LINEAR11_MANTISSA_RANGE.min}, ${LINEAR11_MANTISSA_RANGE.max}]。` +
					`换一个更大的指数（分辨率变粗），或确认器件对该命令是否允许任意 N。`,
			)
		}
	}

	const raw = (((n & 0x1f) << 11) | (y & 0x7ff)) & 0xffff
	return { raw, exponent: n, mantissa: y, value: y * 2 ** n }
}

/**
 * LINEAR16 解码：原始两字节 → 输出电压类物理值。出处 [P4]：Voltage = V × 2^N。
 *
 * 指数 N **必须由调用方传入**：它来自器件 VOUT_MODE 命令（0x20）数据字节的 Parameter
 * bits[4:0]，是这一路输出所有电压类参数共用的。本模块没有、也不该有默认指数 ——
 * 器件之间 N 各不相同（常见 -9 / -13），猜错会让电压差几百倍。
 *
 * @param {number} raw - 原始 16 位值（0..0xFFFF）。
 * @param {object} options - 选项。
 * @param {number} options.exponent - 5 位补码指数 N（-16..15），来自 VOUT_MODE。
 * @param {boolean} [options.signed] - true = SLINEAR16（16 位补码，VOUT_TRIM / VOUT_CAL_OFFSET 等可为负的量）；默认 false = ULINEAR16（无符号）。
 * @returns {{raw: number, exponent: number, mantissa: number, signed: boolean, value: number}} 换算结果。
 * @throws {Error} 缺 exponent 或越界、raw 越界时抛出。
 */
export function linear16ToPhysical(raw, { exponent, signed = false } = {}) {
	if (exponent === undefined || exponent === null) {
		throw new Error(
			'缺 exponent（指数 N）：LINEAR16 的 N 来自器件 VOUT_MODE（0x20）数据字节的 Parameter bits[4:0]，' +
				'必须由调用方读回后传入（出处 PMBus Part II §8.3.1）。本模块不内置任何默认指数 —— 器件之间 N 不同，猜错会差几个数量级。',
		)
	}
	assertIntInRange('exponent', exponent, -16, 15, 'VOUT_MODE 的 Parameter 是 5 位二进制补码（PMBus Part II §8.2）')
	assertIntInRange('raw', raw, 0, 0xffff, 'LINEAR16 是两字节值（PMBus Part II §8.3.1）')
	const mantissa = signed ? signExtend(raw, 16) : raw & 0xffff
	return { raw, exponent, mantissa, signed, value: mantissa * 2 ** exponent }
}

/**
 * LINEAR16 编码：物理值 → 原始两字节。
 *
 * @param {number} value - 物理值（例如输出电压，单位 V）。
 * @param {object} options - 选项。
 * @param {number} options.exponent - 指数 N，来自 VOUT_MODE。
 * @param {boolean} [options.signed] - true = SLINEAR16（16 位补码），默认 false = ULINEAR16。
 * @returns {{raw: number, exponent: number, mantissa: number, signed: boolean, value: number}} 编码结果；`value` 是反解值，用于看量化误差。
 * @throws {Error} 缺 exponent、或量化后的尾数超出该格式范围时抛出。
 */
export function physicalToLinear16(value, { exponent, signed = false } = {}) {
	if (exponent === undefined || exponent === null) {
		throw new Error('缺 exponent（指数 N）：必须来自器件 VOUT_MODE，见 linear16ToPhysical 的说明。')
	}
	assertIntInRange('exponent', exponent, -16, 15, 'VOUT_MODE 的 Parameter 是 5 位二进制补码（PMBus Part II §8.2）')
	if (!Number.isFinite(value)) throw new Error(`value 必须是有限数，收到 ${value}`)

	const mantissa = roundAwayFromZero(value / 2 ** exponent)
	const min = signed ? -32768 : 0
	const max = signed ? 32767 : 65535
	if (mantissa < min || mantissa > max) {
		throw new Error(
			`value = ${value} 在指数 N = ${exponent} 下需要尾数 ${mantissa}，超出 ${signed ? 'SLINEAR16（有符号）' : 'ULINEAR16（无符号）'} 范围 [${min}, ${max}]。` +
				`${signed ? '' : '若该量本来就可以为负（VOUT_TRIM / VOUT_CAL_OFFSET），应改用 signed: true。'}`,
		)
	}
	return { raw: mantissa & 0xffff, exponent, mantissa, signed, value: mantissa * 2 ** exponent }
}

/**
 * DIRECT 解码：原始两字节 → 物理值。出处 [P3]：X = (1/m)(Y × 10^-R − b)。
 *
 * m / b / R **必须由调用方传入**：它们来自 COEFFICIENTS 命令或器件手册的系数表，
 * 每类量（电压 / 电流 / 功率 / 温度）各不相同，甚至同一类量在同一器件里按量程分两组。
 * 本模块不内置任何一组系数。
 *
 * @param {number} raw - 器件返回的两字节（0..0xFFFF），按 16 位二进制补码解释为 Y。
 * @param {object} options - 选项。
 * @param {number} options.m - 斜率系数，两字节二进制补码整数，不能为 0。
 * @param {number} options.b - 偏置，两字节二进制补码整数。
 * @param {number} options.r - 指数 R，一字节二进制补码整数。
 * @returns {{raw: number, y: number, m: number, b: number, r: number, value: number}} 换算结果。
 * @throws {Error} 缺 m / b / r 或 m === 0 时抛出。
 */
export function directToPhysical(raw, { m, b, r } = {}) {
	assertDirectCoefficients({ m, b, r })
	assertIntInRange('raw', raw, 0, 0xffff, 'DIRECT 数据是两字节（PMBus Part II §7.4）')
	const y = signExtend(raw, 16)
	return { raw, y, m, b, r, value: (y * 10 ** -r - b) / m }
}

/**
 * DIRECT 编码：物理值 → 原始两字节。出处 [P3]：Y = (mX + b) × 10^R。
 *
 * @param {number} value - 物理值 X。
 * @param {object} options - 选项（同 {@link directToPhysical} 的 m / b / r）。
 * @returns {{raw: number, y: number, m: number, b: number, r: number, value: number}} 编码结果；`value` 是反解值，用于看量化台阶（DIRECT 的台阶是 `1/m × 10^-R`，不是 2 的幂）。
 * @throws {Error} 缺系数、或量化后的 Y 超出 16 位补码范围时抛出。
 */
export function physicalToDirect(value, { m, b, r } = {}) {
	assertDirectCoefficients({ m, b, r })
	if (!Number.isFinite(value)) throw new Error(`value 必须是有限数，收到 ${value}`)
	const y = roundAwayFromZero((m * value + b) * 10 ** r)
	if (y < -32768 || y > 32767) {
		throw new Error(
			`value = ${value} 在 m=${m}, b=${b}, R=${r} 下需要 Y = ${y}，超出两字节二进制补码范围 [-32768, 32767]。` +
				`请核对系数是否选对了量程分组（同一器件不同量程的 m / b 不同）。`,
		)
	}
	return { raw: y & 0xffff, y, m, b, r, value: (y * 10 ** -r - b) / m }
}

/**
 * 校验 DIRECT 三系数是否齐全。
 *
 * @param {object} coeffs - `{ m, b, r }`。
 * @throws {Error} 缺项或非法时抛出，消息里点名缺哪一项。
 */
function assertDirectCoefficients({ m, b, r }) {
	const missing = []
	if (typeof m !== 'number' || !Number.isFinite(m)) missing.push('m（斜率）')
	if (typeof b !== 'number' || !Number.isFinite(b)) missing.push('b（偏置）')
	if (typeof r !== 'number' || !Number.isInteger(r)) missing.push('r（指数 R，整数）')
	if (missing.length > 0) {
		throw new Error(
			`DIRECT 换算缺系数：${missing.join('、')}。这三个系数由 COEFFICIENTS 命令或器件手册的系数表给出，` +
				`本模块不内置任何默认值（出处 PMBus Part II §7.4.1）。`,
		)
	}
	if (m === 0) throw new Error('DIRECT 的斜率系数 m 不能为 0（会除以 0，且物理上无意义）。')
	if (m < -32768 || m > 32767) throw new Error(`m = ${m} 超出两字节二进制补码范围 [-32768, 32767]。`)
	if (b < -32768 || b > 32767) throw new Error(`b = ${b} 超出两字节二进制补码范围 [-32768, 32767]。`)
	if (r < -128 || r > 127) throw new Error(`r = ${r} 超出一字节二进制补码范围 [-128, 127]。`)
}

/**
 * 解析 VOUT_MODE（命令码 0x20）数据字节。出处 [P4]。
 *
 * 规范位域是 `{Mode[7:5], Parameter[4:0]}`；但确有器件把 bit7 改成"0 绝对 / 1 相对"标志、
 * 把 Mode 缩到 bit[6:5]，所以位域必须调用方指定，本模块不猜。
 *
 * Linear 模式下 Parameter 直接给出指数 N（5 位补码）；Direct 模式下按规范 Parameter 位是
 * `00000b`，**R 不在这里**，要去 COEFFICIENTS 或手册取。
 *
 * @param {number} raw - VOUT_MODE 读回的 1 字节。
 * @param {object} [options] - 选项。
 * @param {'spec-7:5'|'legacy-6:5'} [options.layout] - 位域约定，见 {@link VOUT_MODE_LAYOUTS}。默认 `spec-7:5`（规范写法）。
 * @returns {object} `{ raw, layout, modeCode, mode, modeLabel, parameter, exponent, relative, checks, warnings, notes }`；`exponent` 仅在 linear 模式非 null。
 * @throws {Error} raw 越界、layout 未知时抛出。
 */
export function parseVoutMode(raw, { layout = 'spec-7:5' } = {}) {
	const spec = VOUT_MODE_LAYOUTS[layout]
	if (!spec) throw new Error(`未知的 VOUT_MODE 位域约定 '${layout}'。可用：${Object.keys(VOUT_MODE_LAYOUTS).join(' / ')}`)
	assertIntInRange('raw', raw, 0, 0xff, 'VOUT_MODE 是 1 字节命令（出处 PMBus Part II §8.2）')

	const checks = []
	const warnings = []
	const notes = []
	const modeCode = (raw >> spec.modeShift) & spec.modeMask
	const parameter = raw & 0x1f
	const mode = VOUT_MODE_MODES[modeCode] ?? 'reserved'
	const relative = spec.hasRelativeBit ? ((raw >> 7) & 1) === 1 : null

	notes.push(
		`位域约定 '${layout}'：${spec.source}。Mode = bit[${spec.modeBitHigh}:${spec.modeShift}]、Parameter = bit[4:0]。` +
			`（出处 [P4] 的⚠：本模块不猜用哪一种位域，必须调用方指定。）`,
	)
	notes.push('VOUT_MODE 是**读**回来的器件状态，不是你可以随便写的：多数器件在出厂时固定，写入会被拒绝并置 CML 通信故障。')

	if (mode === 'reserved') {
		warnings.push(
			`Mode = ${modeCode.toString(2).padStart(3, '0')}b 是保留值（规范只定义 000b~011b）。` +
				`要么位域约定选错了（试试 layout: 'legacy-6:5'），要么器件不兼容。`,
		)
	}
	if (mode === 'direct' && parameter !== 0) {
		warnings.push(
			`Direct 模式下 Parameter = ${parameter}（应为 00000b，出处 PMBus Part II §8.2 Table 2）。` +
				`有些器件把 R 放在这里 —— 若手册这么说，就用这个值当 R，但别把它当指数 N 用。`,
		)
	}
	if (mode === 'ieee-half') {
		notes.push('IEEE 754 半精度浮点格式：本模块不提供换算（PMBus 里少见），请按 IEEE 754 binary16 自行解析。')
	}

	let exponent = null
	if (mode === 'linear') {
		exponent = signExtend(parameter, 5)
		notes.push(`Linear 模式：Parameter = ${parameter} → 指数 N = ${exponent}（5 位补码）。该 N 被这一路输出的**所有**电压类参数共用。`)
	}
	if (mode === 'vid') {
		notes.push(
			`VID 模式：Parameter = ${parameter} 是 VID Code Type（PMBus Part II §8.3.2 Table 3）。` +
				`规范里 00h~11h 多为"保留给未来代次"、1Eh/1Fh 为厂商自定义，且明确要求码→电压的对应关系写在**器件手册**里 —— ` +
				`所以本模块不提供任何内置码表，请用 vidCodeToPhysical 传入你手册上的那张表。`,
		)
	}

	checks.push({
		name: 'VOUT_MODE 解析',
		pass: mode !== 'reserved',
		detail: `0x${raw.toString(16).toUpperCase().padStart(2, '0')} → Mode=${modeCode.toString(2).padStart(3, '0')}b(${mode})、Parameter=0x${parameter.toString(16).padStart(2, '0')}${exponent === null ? '' : `（N=${exponent}）`}${relative === null ? '' : `、relative=${relative}`}`,
	})

	return { raw, layout, modeCode, mode, modeLabel: VOUT_MODE_MODE_LABELS[mode] ?? '保留值', parameter, exponent, relative, checks, warnings, notes }
}

/**
 * VID 码 → 电压。出处 [P4] §8.3.2。
 *
 * VID 的位序：VID code **右对齐**，VID0 在**低字节 bit0**，未用位补 0；码→电压的对应表
 * 规范明确要求由器件手册提供。因此本模块只做两件事：按 `bitCount` 把 VID 位抠出来、
 * 拿调用方给的 `codeTable` 查表。**不内置任何码表**（VR10/VR11/AMD 各代码表都不同，
 * 抄错一张表会让输出电压错得离谱）。
 *
 * @param {number} raw - 输出电压类命令的 16 位数据字节。
 * @param {object} options - 选项。
 * @param {number} options.bitCount - 该器件的 VID 位数（VR10 = 5、VR11 = 8 之类，以手册为准）。**必填**。
 * @param {(number[]|Record<string, number>|Map<number, number>)} options.codeTable - 码→电压（V）表，来自器件手册。**必填**。
 * @param {number} [options.extraVolts] - 需要加到查表结果上的偏移（有的器件是 "VDAC + offset" 形式）。默认 0 —— 这是**计算参数**不是手册默认值，调用方按手册决定。
 * @returns {object} `{ raw, code, bitCount, voltage, missing, checks, warnings, notes }`；`voltage` 在码表里查不到时为 null。
 * @throws {Error} 缺 bitCount、缺 codeTable、或 raw 越界时抛出（消息里点名缺哪一项）。
 */
export function vidCodeToPhysical(raw, { bitCount, codeTable, extraVolts = 0 } = {}) {
	const missing = []
	if (bitCount === undefined || bitCount === null) missing.push('bitCount（VID 位数）')
	if (codeTable === undefined || codeTable === null) missing.push('codeTable（码→电压表）')
	if (missing.length > 0) {
		throw new Error(
			`VID 换算缺：${missing.join('、')}。PMBus Part II §8.3.2 明确要求"VID code 与输出电压的关系由器件手册给出"，` +
				`所以本模块不内置任何码表、也不猜 VID 位数（VR10 / VR11 / AMD 各代都不同）。`,
		)
	}
	assertIntInRange('raw', raw, 0, 0xffff, '输出电压类命令的数据是两字节（PMBus Part II §8.3）')
	assertIntInRange('bitCount', bitCount, 1, 16, 'VID 位数不能超过数据字节宽度')

	const checks = []
	const warnings = []
	const notes = []
	const mask = bitCount === 16 ? 0xffff : (1 << bitCount) - 1
	const code = raw & mask
	const unusedMask = (~mask) & 0xffff

	notes.push(
		`VID 位序（§8.3.2）：码右对齐、VID0 在低字节 bit0，未用位应补 0。取低 ${bitCount} 位 → code = 0x${code.toString(16).toUpperCase()}。`,
	)
	if ((raw & unusedMask) !== 0) {
		warnings.push(
			`数据 0x${raw.toString(16).toUpperCase().padStart(4, '0')} 在 bit${bitCount}..bit15 上不是 0（未用位未补零）。` +
				`要么 bitCount 写小了，要么这不是 VID 数据。`,
		)
	}

	let voltage = null
	if (Array.isArray(codeTable)) {
		if (code < codeTable.length && typeof codeTable[code] === 'number') voltage = codeTable[code]
	} else if (codeTable instanceof Map) {
		if (codeTable.has(code)) voltage = codeTable.get(code)
	} else if (typeof codeTable === 'object') {
		const hit = codeTable[String(code)] ?? codeTable[`0x${code.toString(16)}`] ?? codeTable[code]
		if (typeof hit === 'number') voltage = hit
	}
	if (voltage === null) {
		warnings.push(`码 0x${code.toString(16).toUpperCase()} 在你给的表里查不到。VID 表通常有"该码 = OFF / 无效"的项，别把它当 0 V 处理。`)
	} else {
		voltage += extraVolts
	}

	checks.push({
		name: 'VID 码提取',
		pass: voltage !== null,
		detail: `code = 0x${code.toString(16).toUpperCase()}（${bitCount} 位）→ ${voltage === null ? '表中无此项' : `${voltage} V`}`,
	})

	return { raw, code, bitCount, voltage, extraVolts, checks, warnings, notes }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 命令层时序：读事务必须用重复起始（Sr）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 读事务的重复起始（Sr）判定与帧结构说明。出处 [P5]。
 *
 * **差异**：读命令（Read Byte / Read Word / Block Read）分两段 —— 先按"写方向"把命令码发给
 * 器件，再切到"读方向"收数据。SMBus 的 Read Byte/Word 协议图里，这两段之间是 **Sr
 * （重复起始）**，全程只有末尾一个 STOP：整条消息对总线是原子的。
 * `STOP + START` 虽然电气上也能跑通（SMBus 允许任何主器件在 tBUF 之后重新发起 START），
 * 但它把一次事务拆成了两次。
 *
 * **写错会怎样**（按发生频率排序，都有真实案例支撑）：
 *   1. 器件内部状态被打断 → 读回垃圾值。CERN IPMC 论坛的实例：同一块电源模块读
 *      COEFFICIENTS，用 STOP 分段读回 `0xFFFFFFFFFF`，改成 Sr 才拿到正确系数。
 *   2. 命令指针丢失 → 某些器件在检测到 STOP 时认为"这条写事务已完整结束"，命令上下文作废；
 *      随后单独一次"地址+R"读请求没有上文，器件按未定义命令处理（可能回 0xFF 或 NACK）。
 *   3. 非原子 → 两次独立事务之间总线被放开至少 tBUF（100 kHz 下 4.7 µs），别的控制器可以
 *      插进来改同一寄存器，你读到的是"写命令时"和"读数据时"两个不同时刻的混合状态。
 *   4. 协议层报错 → 严格实现 PMBus 的器件会因非法命令序列置 STATUS_CML，进而拉低 SMBALERT#。
 *   5. PEC 不容易发现这类错误：覆盖字节序列其实一样，CRC 照样算得出、照样对得上
 *      （数据本身就是器件给的垃圾）。所以这条**不能靠 PEC 兜底**。
 *
 * 另外，很多 MCU 的 I²C 外设**不支持** Sr（只能 START…STOP）—— 选型/写驱动时先确认。
 *
 * @param {object} input - 输入。
 * @param {number} [input.address7] - 7 位器件地址（用于画帧）。
 * @param {number} [input.command] - 命令码（用于画帧）。
 * @param {'read-byte'|'read-word'|'block-read'} [input.readKind] - 协议种类，默认 `read-word`。
 * @param {boolean} [input.usesRepeatedStart] - 波形/驱动里实际用的是 Sr 还是 STOP+START。**这是唯一必须由调用方给的事实**。
 * @param {boolean} [input.pec] - 是否启用 PEC（影响画出的帧）。
 * @param {boolean} [input.controllerSupportsSr] - 所用 I²C 控制器/驱动是否支持 Sr，见上。
 * @returns {object} `{ readKind, frame, correctFrame, checks, warnings, notes }`；`checks[].pass === null` 表示该项没给。
 */
export function analyzeReadTransaction({ address7, command, readKind, usesRepeatedStart, pec = false, controllerSupportsSr } = {}) {
	const effectiveKind = readKind ?? 'read-word'
	const kind = PMBUS_READ_KINDS[effectiveKind]
	const checks = []
	const warnings = []
	const notes = []

	const addrW = typeof address7 === 'number' ? `0x${((address7 << 1) | 0).toString(16).toUpperCase().padStart(2, '0')}` : 'ADDR+W'
	const addrR = typeof address7 === 'number' ? `0x${((address7 << 1) | 1).toString(16).toUpperCase().padStart(2, '0')}` : 'ADDR+R'
	const cmd = typeof command === 'number' ? `0x${(command & 0xff).toString(16).toUpperCase().padStart(2, '0')}` : 'CMD'

	if (!kind) {
		warnings.push(`未知的读协议 '${effectiveKind}'，帧结构未生成。已支持：${Object.keys(PMBUS_READ_KINDS).join(' / ')}`)
	}

	const dataCells = effectiveKind === 'read-byte' ? ['DATA'] : effectiveKind === 'read-word' ? ['DATA_L(低字节先)', 'DATA_H'] : effectiveKind === 'block-read' ? ['COUNT', 'DATA…'] : []
	const pecCell = pec ? ['PEC'] : []
	const correctFrame = ['S', addrW, 'A', cmd, 'A', 'Sr', addrR, 'A', ...dataCells, 'N', ...pecCell, 'P']
	const stopStartFrame = ['S', addrW, 'A', cmd, 'A', 'P', 'S', addrR, 'A', ...dataCells, 'N', ...pecCell, 'P']

	notes.push(`正确的读帧（出处 [P5]，SMBus 3.0 §6.5 ${kind?.label ?? effectiveKind}）：${correctFrame.join(' ')}`)
	notes.push(
		'S = START、Sr = REPEATED START、A/N = ACK/NACK、P = STOP。注意整条消息只有末尾那一个 P。' +
			'另一个常见错点：读方向的数据字节由主机回 ACK，但**最后一个字节必须回 NACK**（表示"不要再发了"），' +
			'回到 ACK 会让从器件继续驱动 SDA，收尾时总线冲突。',
	)
	if (readKind === undefined) {
		notes.push('未指定 readKind，帧结构按默认的 read-word 画出。若实际是 Read Byte / Block Read，数据字节数不同，请显式传入以免对着错误的帧排查。')
	}

	if (typeof usesRepeatedStart === 'boolean') {
		checks.push({
			name: '读事务使用重复起始（Sr）',
			pass: usesRepeatedStart,
			detail: usesRepeatedStart ? `波形/驱动使用 Sr：${correctFrame.join(' ')}` : `实际用的是 STOP+START：${stopStartFrame.join(' ')}`,
		})
		if (!usesRepeatedStart) {
			warnings.push(
				'读事务用了"STOP 再 START"而不是 Sr。这不是"慢一点"的问题，是**功能性错误**：' +
					'(1) 器件内部状态被 STOP 打断，CERN IPMC 论坛的实例里读回的是 0xFFFFFFFFFF，改成 Sr 才正确；' +
					'(2) 命令指针可能作废，后面的"地址+R"没有上文；' +
					'(3) 两段之间总线放开 ≥ tBUF，其它主器件可插入，读到非原子数据；' +
					'(4) 严格实现会置 STATUS_CML 并拉低 SMBALERT#。' +
					'**并且 PEC 兜不住这条**：覆盖字节序列不变、CRC 照样对得上，因为数据本身就是器件返的垃圾。',
			)
		}
	} else {
		checks.push({
			name: '读事务使用重复起始（Sr）',
			pass: null,
			skipped: true,
			detail: '缺 usesRepeatedStart：需要看波形上命令码之后是 Sr 还是 P（用逻辑分析仪抓一次即可）',
		})
		notes.push('缺 `usesRepeatedStart`：没判定。这一项**必须看波形**确认 —— 驱动代码里写的是"两次 separate transfer"还是"read_reg"，看代码不一定看得出来。')
	}

	if (typeof controllerSupportsSr === 'boolean') {
		checks.push({
			name: '控制器支持 Sr',
			pass: controllerSupportsSr,
			detail: controllerSupportsSr ? '该控制器/驱动可生成重复起始' : '该控制器/驱动不能生成重复起始',
		})
		if (!controllerSupportsSr) {
			warnings.push(
				'所用 I²C 控制器/驱动不支持重复起始，而 PMBus 读事务需要它。可选：换用支持 Sr 的控制器、' +
					'改用支持 Sr 的驱动 API，或退回软件位操作（注意此时 tLOW:MEXT 会明显变大，回头跑 analyzeSmbusTiming）。',
			)
		}
	} else {
		notes.push('缺 `controllerSupportsSr`：未判定控制器能力。很多 MCU 的硬件 I²C 只发 START…STOP，选型时先确认。')
	}

	if (pec) {
		notes.push(
			`启用 PEC 时，覆盖范围是 ${addrW} ${cmd} ${addrR} + 数据字节（**两个地址字节都算**），不含 PEC 自身、不含 ACK/Sr。` +
				`读事务必须用 pecCoverageBytes({ address7, read: true, ... }) 把两次地址都带进去。`,
		)
	}

	return { readKind: effectiveKind, address7: address7 ?? null, command: command ?? null, pec, frame: usesRepeatedStart === false ? stopStartFrame : correctFrame, correctFrame, checks, warnings, notes }
}
