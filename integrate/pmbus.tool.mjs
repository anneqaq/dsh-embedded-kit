/**
 * `pmbus_check` 工具描述符 —— 把 lib/pmbus.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**：判定逻辑、换算公式、以及全部出处（lib/pmbus.js 文件头
 * 的 [S1]~[P5]）都留在 lib/pmbus.js，这里一个字节的算法都没有重算。
 *
 * 三个动作对应 lib 里的三组函数：
 *   timing → analyzeSmbusTiming（tTIMEOUT / tLOW:SEXT / tLOW:MEXT / 主动逼超时）
 *   pec    → analyzePec（覆盖范围、CRC-8 算出的 PEC、与波形字节序列的交叉校验）
 *   linear → linear11ToPhysical / linear16ToPhysical / directToPhysical 及其编码方向
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键（形状与 lib/i2c.js 一致）。
 * lib 的换算函数本身不产出判定（缺必填输入时直接抛错，见 pmbus.js 文件头的
 * "缺输入时的两种行为"），所以 linear 分支的这三条 key 由本文件补齐 ——
 * 补齐的只是**判定措辞**，`value` / `raw` / `exponent` 等数值仍然全部来自 lib。
 *
 * @module dsh-embedded-kit/integrate/pmbus.tool
 */

import {
	analyzePec,
	analyzeSmbusTiming,
	directToPhysical,
	linear11ToPhysical,
	linear16ToPhysical,
	PEC_CRC_PARAMS,
	physicalToDirect,
	physicalToLinear11,
	physicalToLinear16,
	PMBUS_FORMAT_VECTORS,
	SMBUS_TRANSPORT_LIMITS,
} from '../lib/pmbus.js'

/** 三个可用动作。 */
const ACTIONS = ['timing', 'pec', 'linear']

/** linear 动作支持的三种数据格式。 */
const LINEAR_FORMATS = ['linear11', 'linear16', 'direct']

/**
 * 把 0~65535 渲染成补足位宽的十六进制串（仅用于展示）。
 *
 * @param {number} v - 值。
 * @param {number} [width] - 补零位数，默认 4。
 * @returns {string} 形如 `0x2666`。
 */
function hex(v, width = 4) {
	return `0x${(v & 0xffff).toString(16).toUpperCase().padStart(width, '0')}`
}

/**
 * 把字节数组渲染成 `0x16 0x0F 0x17` 形式（仅用于展示）。
 *
 * @param {number[]|Uint8Array} bytes - 字节数组。
 * @returns {string} 十六进制串。
 */
function hexList(bytes) {
	return Array.from(bytes, (b) => hex(b & 0xff, 2)).join(' ')
}

/**
 * 渲染一个可能缺失的量。
 *
 * @param {number|null|undefined} x - 值。
 * @param {string} unit - 单位。
 * @returns {string} 文本。
 */
function num(x, unit = ' ms') {
	return x === null || x === undefined ? '未提供' : `${x}${unit}`
}

/* ------------------------------------------------------------------ */
/* 动作 1：timing                                                      */
/* ------------------------------------------------------------------ */

/**
 * SMBus 超时与时钟拉伸判定。
 *
 * 四个输入全是实测值。没给的那一项由 lib 推一条 notes 并把对应 check 标成
 * `pass: null, skipped: true`（"没数据"和"不通过"是两件事）。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runTiming(args) {
	const r = analyzeSmbusTiming({
		maxClockLowMs: args.max_clock_low_ms,
		slaveStretchCumulativeMs: args.slave_stretch_ms,
		masterStretchCumulativeMs: args.master_stretch_ms,
		forceTimeoutHoldMs: args.force_timeout_hold_ms,
		busSpeedHz: args.bus_speed_hz,
	})
	return { action: 'timing', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 2：pec                                                         */
/* ------------------------------------------------------------------ */

/**
 * PEC 计算与校验。
 *
 * 地址、命令、data 由本工具映射进 `analyzePec`，覆盖字节序列由 lib 的
 * `pecCoverageBytes` 推出（读事务会把地址字节算两次）。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runPec(args) {
	const r = analyzePec({
		address7: args.address7,
		read: args.read === true,
		command: args.command,
		data: Array.isArray(args.data) ? args.data : [],
		receivedPec: args.received_pec,
		observedBytes: args.observed_bytes,
	})
	return { action: 'pec', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 3：linear                                                      */
/* ------------------------------------------------------------------ */

/**
 * 给线性换算结果补上 `checks` / `warnings` / `notes`。
 *
 * lib 的换算函数只返回数值（缺必填输入时抛错），判定必须在这里合成：
 *   - 第一条 check 说明这次换算用的公式与位域（恒为通过，它是"做了什么"的记录）；
 *   - 第二条 check 是**真正的自洽性判定**：解码方向把结果按同一指数编回原码，
 *     编码方向比较反解值与输入值的差是否落在半个台阶内（即码已经是最近的格子）。
 *
 * @param {object} params - 组装好的结果字段。
 * @param {string} params.format - linear11 / linear16 / direct。
 * @param {string} params.direction - decode / encode。
 * @param {object} params.lib - lib 换算函数的原始返回值。
 * @param {object} params.roundTrip - `{ raw, ok }` 自洽性判定（解码方向）。
 * @param {number|null} params.inputValue - 编码方向的输入物理值。
 * @param {number|null} params.quantStep - 量化台阶。
 * @returns {{checks: object[], warnings: string[], notes: string[]}} 三条 key。
 */
function linearVerdict({ format, direction, lib, roundTrip, inputValue, quantStep }) {
	const checks = []
	const warnings = []
	const notes = []

	if (format === 'linear11') {
		checks.push({
			name: 'LINEAR11 解码（X = Y · 2^N）',
			pass: true,
			detail:
				`raw ${hex(lib.raw)} → N = ${lib.exponent}（5 位补码，取 bit[15:11]）、` +
				`Y = ${lib.mantissa}（11 位补码，取 bit[10:0]）→ X = ${lib.value}`,
		})
	} else if (format === 'linear16') {
		checks.push({
			name: direction === 'decode' ? 'LINEAR16 解码（X = V · 2^N）' : 'LINEAR16 编码（V = round(X / 2^N)）',
			pass: true,
			detail:
				`raw ${hex(lib.raw)} @N = ${lib.exponent}（来自 VOUT_MODE）${lib.signed ? '、SLINEAR16（16 位补码）' : '、ULINEAR16（无符号）'}` +
				` → 尾数 V = ${lib.mantissa} → X = ${lib.value}`,
		})
	} else {
		checks.push({
			name: direction === 'decode' ? 'DIRECT 解码（X = (1/m)(Y × 10^−R − b)）' : 'DIRECT 编码（Y = (mX + b) × 10^R）',
			pass: true,
			detail:
				`raw ${hex(lib.raw)} → Y = ${lib.y}（16 位补码）、m = ${lib.m}、b = ${lib.b}、R = ${lib.r}` +
				` → X = ${lib.value}`,
		})
	}

	if (direction === 'decode') {
		checks.push({
			name: '按同一参数编回原码（解码自洽）',
			pass: roundTrip.ok,
			detail: roundTrip.ok
				? `X = ${lib.value} 按同一${format === 'direct' ? ' m / b / R' : `指数 N = ${lib.exponent}`}编码回 ${hex(roundTrip.raw)}，与原码一致`
				: `X = ${lib.value} 编回 ${hex(roundTrip.raw)}，与原码 ${hex(lib.raw)} 不一致 —— 位域或系数可能对不上`,
		})
	} else {
		// 编码方向唯一有意义的判定是"有没有落到最近的格子上"：误差超过半个台阶说明取整错了。
		const error = lib.value - inputValue
		const halfStep = quantStep / 2
		const withinHalfStep = Math.abs(error) <= halfStep + Math.abs(quantStep) * Number.EPSILON
		checks.push({
			name: '编码是否已落到最近的格子（|误差| ≤ 半个台阶）',
			pass: withinHalfStep,
			detail:
				error === 0
					? `X = ${inputValue} 恰好落在 ${hex(lib.raw)} 上，反解值与输入完全相同`
					: `X = ${inputValue} → ${hex(lib.raw)}，反解 ${lib.value}，误差 ${error}（半个台阶 ${halfStep}）`,
		})
	}

	notes.push(
		`量化台阶 = ${quantStep}${format === 'direct' ? '（= 10^−R / m，DIRECT 的台阶不是 2 的幂）' : `（= 2^${lib.exponent}）`}。` +
			`写方向只能落到台阶的整数倍上，反解值与你的目标值不会完全相等。`,
	)
	if (format === 'linear16') {
		notes.push(
			'指数 N 必须来自器件 VOUT_MODE（0x20）读回的 Parameter bits[4:0]，本工具不内置默认值：' +
				'器件之间 N 常见 -9 / -13，猜错会让电压差几个数量级。',
		)
	}
	if (format === 'direct') {
		notes.push(
			'm / b / R 由 COEFFICIENTS 命令或器件手册的系数表给出，每类量（电压 / 电流 / 功率 / 温度）各不相同，' +
				'同一器件不同量程也分两组 —— 本工具不内置任何一组系数。',
		)
	}
	if (!checks[1].pass) {
		warnings.push(
			direction === 'decode'
				? `${checks[1].name}不通过：${checks[1].detail}。解码方向编不回原码，通常意味着位域约定、m / b / R 选错了量程分组，或 VOUT_MODE 的指数取错了。`
				: `${checks[1].name}不通过：${checks[1].detail}。误差超过半个台阶说明取整出了问题，请核对 format 与系数是否选对 —— 这不是正常的量化误差。`,
		)
	}

	return { checks, warnings, notes }
}

/**
 * LINEAR11 / LINEAR16 / DIRECT 换算。
 *
 * 方向由给了哪个键决定：给 `raw` 走解码（器件读回 → 物理值），给 `value` 走编码
 * （物理值 → 写回值）。两者都缺或都给都会抛错，不猜。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runLinear(args) {
	const format = args.format ?? 'linear11'
	if (!LINEAR_FORMATS.includes(format)) {
		throw new Error(`未知的格式 '${format}'。可用：${LINEAR_FORMATS.join(' / ')}`)
	}

	const hasRaw = Number.isInteger(args.raw)
	const hasValue = typeof args.value === 'number'
	if (hasRaw && hasValue) {
		throw new Error('raw 与 value 只能给一个：给 raw 走解码（器件读回 → 物理值），给 value 走编码（物理值 → 写回值）')
	}
	if (!hasRaw && !hasValue) {
		throw new Error('需要 raw（解码方向）或 value（编码方向）二者之一')
	}

	/** @type {object} */
	let lib
	let roundTrip = null
	let inputValue = null
	let quantStep

	if (format === 'linear11') {
		if (hasRaw) {
			lib = linear11ToPhysical(args.raw)
			const back = physicalToLinear11(lib.value, { exponent: lib.exponent })
			roundTrip = { raw: back.raw, ok: back.raw === lib.raw }
		} else {
			inputValue = args.value
			// 不给 exponent 时 lib 会自动选能表示该值的最细指数（PMBus 允许任意 N）。
			lib = physicalToLinear11(args.value, Number.isInteger(args.exponent) ? { exponent: args.exponent } : {})
		}
		quantStep = 2 ** lib.exponent
	} else if (format === 'linear16') {
		const signed = args.signed === true
		if (hasRaw) {
			lib = linear16ToPhysical(args.raw, { exponent: args.exponent, signed })
			const back = physicalToLinear16(lib.value, { exponent: lib.exponent, signed })
			roundTrip = { raw: back.raw, ok: back.raw === lib.raw }
		} else {
			inputValue = args.value
			lib = physicalToLinear16(args.value, { exponent: args.exponent, signed })
		}
		quantStep = 2 ** lib.exponent
	} else {
		const coeff = { m: args.m, b: args.b, r: args.r }
		if (hasRaw) {
			lib = directToPhysical(args.raw, coeff)
			const back = physicalToDirect(lib.value, coeff)
			roundTrip = { raw: back.raw, ok: back.raw === lib.raw }
		} else {
			inputValue = args.value
			lib = physicalToDirect(args.value, coeff)
		}
		quantStep = 10 ** -lib.r / lib.m
	}

	const verdict = linearVerdict({ format, direction: hasRaw ? 'decode' : 'encode', lib, roundTrip, inputValue, quantStep })

	// 命中原 lib 登记的已知基准向量时点名，便于对照厂商手册。
	const known = (PMBUS_FORMAT_VECTORS[format] ?? []).find(
		(v) => v.raw === lib.raw && (v.exponent === undefined || v.exponent === lib.exponent),
	)
	if (known) {
		verdict.notes.push(
			`该原始值命中 lib/pmbus.js 登记的已知基准：${known.label} = ${known.value}。出处：${known.source}`,
		)
	}

	const mantissa = format === 'direct' ? lib.y : lib.mantissa
	return {
		action: 'linear',
		format,
		direction: hasRaw ? 'decode' : 'encode',
		raw: lib.raw,
		inputValue,
		value: lib.value,
		exponent: format === 'direct' ? lib.r : lib.exponent,
		mantissa,
		signed: format === 'linear16' ? lib.signed : null,
		m: format === 'direct' ? lib.m : null,
		b: format === 'direct' ? lib.b : null,
		r: format === 'direct' ? lib.r : null,
		quantStep,
		quantizationError: inputValue === null ? 0 : lib.value - inputValue,
		matchedVector: known ? known.label : null,
		...verdict,
	}
}

/* ------------------------------------------------------------------ */
/* 同步分派器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按 action 分派到对应分支，**同步**返回结果。
 *
 * `execute` 走的也是这条路径，导出它是为了让自测能在不 await 的前提下覆盖全部分支
 * （宿主给的 `test` 是同步签名）。
 *
 * @param {object} args - 工具入参（键名与 parameters 一致）。
 * @returns {object} 必含 checks / warnings / notes 的结果。
 */
export function dispatch(args = {}) {
	const action = args.action ?? 'timing'
	if (action === 'timing') return runTiming(args)
	if (action === 'pec') return runPec(args)
	if (action === 'linear') return runLinear(args)
	throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
}

/* ------------------------------------------------------------------ */
/* 展示行                                                              */
/* ------------------------------------------------------------------ */

/**
 * timing 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function timingLines(v) {
	const lim = v.limits
	const m = v.marginsMs
	const lines = [
		`  判定线（${SMBUS_TRANSPORT_LIMITS.source}）：tTIMEOUT ${lim.tTimeoutMinMs} ms（误触发阈值）→ ${lim.tTimeoutMaxMs} ms（清除期限）；` +
			`tLOW:SEXT ≤ ${lim.tLowSextMaxMs} ms；tLOW:MEXT ≤ ${lim.tLowMextMaxMs} ms`,
		`  最长单次 SCL 低电平：${num(v.maxClockLowMs)}（对 tTIMEOUT(min)，裕量 ${num(m.maxClockLow) }）`,
		`  从器件累计拉伸（整条消息）：${num(v.slaveStretchCumulativeMs)}（上限 ${lim.tLowSextMaxMs} ms，裕量 ${num(m.slaveStretch)}）`,
		`  主器件累计拉伸（每字节）：${num(v.masterStretchCumulativeMs)}（上限 ${lim.tLowMextMaxMs} ms，裕量 ${num(m.masterStretch)}）`,
	]
	if (v.forceTimeoutHoldMs !== null) {
		lines.push(
			`  主动逼出对端超时：计划拉低 ${v.forceTimeoutHoldMs} ms（要求 ≥ ${lim.tTimeoutMaxMs} ms，裕量 ${num(m.forceTimeout)}）`,
		)
	}
	return lines
}

/**
 * pec 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function pecLines(v) {
	const lines = [
		`  参与 PEC 计算的 ${v.coverage.length} 个字节（按总线顺序，含地址与 R/W#）：${hexList(v.coverage)}`,
		`  应有 PEC = ${hex(v.expectedPec, 2)}（CRC-8：${PEC_CRC_PARAMS.polynomial}，poly ${hex(PEC_CRC_PARAMS.poly, 2)}、` +
			`init ${hex(PEC_CRC_PARAMS.init, 2)}、不反射、xorout ${hex(PEC_CRC_PARAMS.xorout, 2)}）`,
	]
	if (v.receivedPec === null) {
		lines.push('  总线上收到的 PEC：未提供 —— 只算出应有值，未做校验判定')
	} else {
		lines.push(
			`  总线上收到的 PEC = ${hex(v.receivedPec, 2)}（${v.receivedPec === v.expectedPec ? '一致' : '**不一致**'}）`,
		)
	}
	if (v.read) {
		lines.push(
			v.command === null
				? '  读事务（Receive Byte / ARA 类）：覆盖里只有一段 +R 地址，没有"写命令"那一段'
				: '  读事务：地址字节算两次（+W 送命令、+R 收数据），只差最低位 —— 漏掉第二个是 PEC 对不上的头号原因',
		)
	}
	return lines
}

/**
 * linear 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function linearLines(v) {
	const head = {
		linear11: `LINEAR11（N = ${v.exponent}、Y = ${v.mantissa}）`,
		linear16: `LINEAR16（N = ${v.exponent}、尾数 = ${v.mantissa}${v.signed ? '、SLINEAR16' : '、ULINEAR16'}）`,
		direct: `DIRECT（m = ${v.m}, b = ${v.b}, R = ${v.r}, Y = ${v.mantissa}）`,
	}[v.format]
	const lines = [
		`  ${head}`,
		`  台阶 = ${v.quantStep}；量化台阶是写方向能落到的最小格子`,
	]
	if (v.direction === 'decode') {
		lines.push(`  解码：raw ${hex(v.raw)} → 物理值 ${v.value}`)
	} else {
		lines.push(
			`  编码：物理值 ${v.inputValue} → raw ${hex(v.raw)}，反解 ${v.value}，误差 ${v.quantizationError}`,
		)
	}
	if (v.matchedVector) lines.push(`  命中已登记基准向量：${v.matchedVector}`)
	return lines
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
	name: 'pmbus_check',
	title: 'SMBus / PMBus 命令层校验（超时与时钟拉伸 / PEC / 数据格式换算）',
	description:
		'PMBus / SMBus **命令层**校验与换算（口径：SMBus 3.0 Table 2、PMBus Part I Rev 1.2 §5.2.6.2、PMBus Part II §7.3 / §7.4.1 / §8.3.1）。' +
		'三种动作：' +
		'① action=timing：拿实测的最长单次 SCL 低电平与两个累计拉伸量，逐项对 tTIMEOUT(25/35 ms)、tLOW:SEXT(25 ms)、tLOW:MEXT(10 ms)，给出每一项的裕量；也可以判定"主动拉低 SCL 逼对端超时"的时长是否够（规范要求 ≥ 35 ms 才能**确保**逼出）。' +
		'② action=pec：按 (7 位地址, R/W#, 命令, 数据) 推出 PEC 的覆盖字节序列，用 CRC-8（poly 0x07、init 0x00、不反射）算出应有 PEC 并与总线上收到的值比对；若再给逻辑分析仪抓到的字节序列，会逐字节交叉校验覆盖范围，直接指出第几个字节起不一致。' +
		'③ action=linear：LINEAR11 / LINEAR16 / DIRECT 的双向换算（解码给 raw，编码给 value），并给出量化台阶与量化误差。' +
		`返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 每项形如 { name, pass, detail, skipped? }）。` +
		'硬约束（请如实对待）：' +
		'（1）**本工具不内置任何器件相关的默认值**。LINEAR16 的指数 N 必须来自器件 VOUT_MODE（0x20）读回的 Parameter；DIRECT 的 m / b / R 必须来自 COEFFICIENTS 命令或器件手册系数表；以上缺哪一项就抛错点名，绝不替你猜一个"常见值"。' +
		'（2）timing 的四项输入全是**实测值**，不是手册 typ 值。缺哪一项就把对应 check 标成 `pass: null, skipped: true`（"没数据"和"不通过"必须能区分），并在 notes 里点名要量什么。tLOW:SEXT 与 tLOW:MEXT 都是**累计**量：前者按整条消息 start→stop 累计，后者在每个字节内重新起算。' +
		'（3）PEC 的覆盖范围里，**读事务的地址字节出现两次**（+W 送命令、+R 收数据），漏掉第二个是"PEC 一直对不上"的头号原因；Block Read 的 COUNT 字节也算。只比对 CRC 值无法区分"算法不一致"与"范围不一致"，要定位必须给 observed_bytes。' +
		'（4）25 ms 与 35 ms 不是"典型值的上下限"：25 ms 是**误触发阈值**（单次低电平超过它，参与传输的器件可以中止并释放总线），35 ms 是**清除期限**（检测到超时的器件必须在此之前复位通信）。落在 25~35 ms 之间的灰区最危险——通信偶发失败且难以复现。' +
		'（5）本工具只做命令层。上拉区间、总线电容、上升时间属于电气层，请用 i2c_bus；CRC 引擎在 lib/crc.js，PEC 直接复用其 crc8 预设，不另造一份。',
	parameters: {
		action: {
			type: 'string',
			required: true,
			enum: ACTIONS,
			description:
				'timing=SMBus 超时与时钟拉伸判定（需实测的 ms 值）；' +
				'pec=PEC 覆盖范围与校验值（需 address7，可选 command / data / received_pec / observed_bytes）；' +
				'linear=LINEAR11 / LINEAR16 / DIRECT 换算（需 format，且 raw 或 value 二选一）。',
		},
		max_clock_low_ms: {
			type: 'number',
			description:
				'实测**最长单次** SCL 低电平（ms），对上 tTIMEOUT（判定线 25 ms）。' +
				'必须是逻辑分析仪量出来的实测值 —— 手册只给器件的拉伸能力上限，不告诉你你的固件会不会超。仅 action=timing 有效。',
		},
		slave_stretch_ms: {
			type: 'number',
			description:
				'实测从器件在**一次消息内（start→stop）**的累计时钟拉伸（ms），上限 tLOW:SEXT = 25 ms。' +
				'注意它是累计量、不是单次量：手册里的"典型拉伸"要换算成你实际会连读多少个字节。仅 action=timing 有效。',
		},
		master_stretch_ms: {
			type: 'number',
			description:
				'实测主器件在**每个字节内**（start→ack / ack→ack / ack→stop）的累计拉伸（ms），上限 tLOW:MEXT = 10 ms。' +
				'软件位操作 I²C、在中断里跑 I²C 状态机、字节间做 Flash 写都会明显拉伸，必须实测。仅 action=timing 有效。',
		},
		force_timeout_hold_ms: {
			type: 'number',
			description:
				'想靠持续拉低 SCL 逼出对端超时时计划的时长（ms）。规范明确只有 ≥ tTIMEOUT(max) = 35 ms 才能**确保**逼出，' +
				'低于此值对端可能只是判定了超时却没复位完，你随后的 START 它接不住。仅 action=timing 有效。',
		},
		bus_speed_hz: {
			type: 'integer',
			description:
				'实际总线速率（Hz），如 100000 / 400000 / 1000000。**只用于在 notes 里解释 tBUF 空闲窗口**（STOP 到下一个 START 的最小空闲），不参与任何判定。仅 action=timing 有效。',
		},
		address7: {
			type: 'integer',
			description:
				'7 位器件地址（0~127）。PEC 覆盖里的地址字节由它左移一位再加 R/W# 得到，**不用你换算成线上字节**，也不会把 R/W# 当参数传入。action=pec 必填。',
		},
		read: {
			type: 'boolean',
			description:
				'这次事务是不是**读**（Read Byte / Word / Block Read）。默认 false（写事务）。' +
				'读事务的 PEC 覆盖里地址字节会出现**两次**（+W 送命令、+R 收数据），且覆盖范围随它变化 —— 这是最常见的算错点。仅 action=pec 有效。',
		},
		command: {
			type: 'integer',
			description:
				'命令码（0~255），如 0x21 = VOUT_COMMAND。读事务里它是 +W 那一段的命令码。' +
				'Receive Byte / ARA 这类协议没有命令码，可省略（省略后读事务的覆盖只剩一段 +R 地址）。仅 action=pec 有效。',
		},
		data: {
			type: 'array',
			description:
				'数据字节数组，**按总线顺序**（SMBus / PMBus 是小端，低字节先），每项 0~255。' +
				'Block Read 要把首字节的 COUNT 也算进来（规范里 PEC 覆盖它）。仅 action=pec 有效。',
		},
		received_pec: {
			type: 'integer',
			description:
				'总线上实际收到的 PEC 字节（0~255）。给了才做一致性判定；不给则只算出应有值并把该项标 skipped。仅 action=pec 有效。',
		},
		observed_bytes: {
			type: 'array',
			description:
				'逻辑分析仪抓到的、PEC 之前的全部字节数组。给了才会与按 (地址, R/W#, 命令, 数据) 推出的应有覆盖序列逐字节比对 —— ' +
				'**这是定位"PEC 总对不上"最快的一步**，能直接报出第几个字节起不一致，从而区分"算法不一致"与"覆盖范围不一致"。仅 action=pec 有效。',
		},
		format: {
			type: 'string',
			enum: LINEAR_FORMATS,
			description:
				'数据格式，默认 linear11。LINEAR11：指数 N 与尾数 Y 都编码在同一个 16 位字里，两个键都不用你给；' +
				'LINEAR16：N 必须另外给（来自 VOUT_MODE）；DIRECT：m / b / R 必须另外给。action=linear 必填。',
		},
		raw: {
			type: 'integer',
			description:
				'器件读回的原始 16 位整数（0~65535），**解码方向**用（器件 → 物理值）。与 value 二选一，两个都给会报错。仅 action=linear 有效。',
		},
		value: {
			type: 'number',
			description:
				'物理值（要写回器件的量），**编码方向**用（物理值 → 写回值）。与 raw 二选一。仅 action=linear 有效。',
		},
		exponent: {
			type: 'integer',
			description:
				'指数：LINEAR11 / LINEAR16 是 5 位二进制补码的 N（-16~15）。' +
				'LINEAR16 的 N 读方向**必须**给，且必须来自器件 VOUT_MODE（0x20）读回的 Parameter bits[4:0] —— 本工具不内置任何默认指数（器件之间常见 -9 / -13，猜错差几个数量级）；' +
				'LINEAR11 写方向不给时会自动选能精确表示该值的最细指数（PMBus 允许任意 N）。DIRECT 不用这个键（用 r）。',
		},
		signed: {
			type: 'boolean',
			description:
				'LINEAR16 是否为 SLINEAR16（16 位二进制补码，VOUT_TRIM / VOUT_CAL_OFFSET 这类允许为负的量）；' +
				'默认 false = ULINEAR16（无符号，VOUT_COMMAND 等输出侧电压参数）。仅 action=linear 且 format=linear16 有效。',
		},
		m: {
			type: 'number',
			description:
				'DIRECT 的斜率系数 m（两字节二进制补码整数，不能为 0），来自 COEFFICIENTS 命令或器件手册系数表。' +
				'同一器件不同量程分组的 m 不同，本工具不内置任何一组系数。仅 action=linear 且 format=direct 有效。',
		},
		b: {
			type: 'number',
			description: 'DIRECT 的偏置系数 b（两字节二进制补码整数）。仅 action=linear 且 format=direct 有效。',
		},
		r: {
			type: 'integer',
			description:
				'DIRECT 的指数 R（一字节二进制补码整数，如 -2）。注意它不是 LINEAR16 的 N：DIRECT 的量化台阶是 10^−R / m，不是 2 的幂。仅 action=linear 且 format=direct 有效。',
		},
	},
	/**
	 * 按 action 分派到 lib/pmbus.js 的对应函数。
	 *
	 * @param {object} args - 模型传入的参数。
	 * @returns {Promise<object>} 含 checks / warnings / notes 的结果。
	 */
	async execute(args) {
		return dispatch(args)
	},
	/**
	 * 供渲染层展示的具体数值行。
	 *
	 * @param {object} v - execute 的返回值。
	 * @returns {string[]} 文本行。
	 */
	summaryLines(v) {
		if (!v || typeof v !== 'object') return []
		if (v.action === 'timing') return timingLines(v)
		if (v.action === 'pec') return pecLines(v)
		if (v.action === 'linear') return linearLines(v)
		return []
	},
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)
