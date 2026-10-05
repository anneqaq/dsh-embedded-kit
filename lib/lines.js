/**
 * 线路级低速协议的时序与电气检查：LIN / 1-Wire / RS-232·422。
 *
 * 常量来自各协议规范本身，出处写在每段的注释里。**不引用章节号**——
 * 记不准就不写编号，只写"出自 LIN 规范 / Maxim DS0009 / TIA-232-F"。
 * 凡是我没有把握精确到数值的项，一律标成"需按器件手册确认"，不填一个看起来合理的数。
 *
 * @module dsh-embedded-kit/lines
 */

/* ------------------------------------------------------------------ */
/* LIN                                                                 */
/* ------------------------------------------------------------------ */

/**
 * LIN 规范里的帧结构常量。
 *
 * 出处：LIN Specification 2.x。
 *   - break 场：≥ 13 个位的显性电平；break 分隔符 ≥ 1 个位的隐性
 *   - 每个字节按 8N1 传，即 10 位（1 起始 + 8 数据 + 1 停止）
 *   - 帧头 = break(13) + 分隔符(1) + sync(10) + PID(10) = 34 位
 *   - 响应 = (数据字节数 + 校验字节数) × 10 位
 *   - 调度表里一个帧槽的时长应 ≥ 该帧最大帧时间的 1.4 倍（规范给出的调度裕量）
 */
export const LIN_CONSTANTS = {
	breakBits: 13,
	delimiterBits: 1,
	perByteBits: 10,
	headerBits: 34,
	slotMarginFactor: 1.4,
	minBaud: 1000,
	maxBaud: 20000,
}

/**
 * 分析 LIN 帧与调度表时序。
 *
 * @param {object} input - 输入。
 * @param {number} input.baud - 波特率（bit/s）。
 * @param {Array<{name:string, dataBytes:number, checksumBytes?:number, slotMs?:number}>} input.frames - 帧定义。
 * @param {number} [input.schedulePeriodMs] - 调度表周期（ms）。给了就检查各帧槽总和是否装得下。
 * @returns {object} 帧时间与调度可行性。
 */
export function analyzeLin({ baud, frames, schedulePeriodMs }) {
	if (!(baud > 0)) throw new Error('baud 必须为正数')
	if (!Array.isArray(frames) || frames.length === 0) throw new Error('frames 至少给一帧')

	const checks = []
	const warnings = []
	const notes = []
	const bitTimeUs = 1e6 / baud

	if (baud < LIN_CONSTANTS.minBaud || baud > LIN_CONSTANTS.maxBaud) {
		warnings.push(
			`波特率 ${baud} 超出 LIN 的 ${LIN_CONSTANTS.minBaud}~${LIN_CONSTANTS.maxBaud} bit/s 范围。`,
		)
	}

	notes.push(`位时间 = 1e6 / ${baud} = ${bitTimeUs.toFixed(3)} µs（设计值）。`)
	notes.push(
		`帧头固定 ${LIN_CONSTANTS.headerBits} 位 = break ${LIN_CONSTANTS.breakBits} + 分隔符 ` +
			`${LIN_CONSTANTS.delimiterBits} + sync 10 + PID 10。`,
	)

	const rows = frames.map((f) => {
		const checksumBytes = f.checksumBytes ?? 1
		const responseBits = (f.dataBytes + checksumBytes) * LIN_CONSTANTS.perByteBits
		const totalBits = LIN_CONSTANTS.headerBits + responseBits
		const frameTimeUs = totalBits * bitTimeUs
		const minSlotUs = frameTimeUs * LIN_CONSTANTS.slotMarginFactor
		return {
			name: f.name,
			dataBytes: f.dataBytes,
			checksumBytes,
			responseBits,
			totalBits,
			frameTimeUs,
			minSlotUs,
			slotMs: f.slotMs ?? null,
			slotOk: f.slotMs === undefined || f.slotMs === null ? null : f.slotMs * 1000 >= minSlotUs,
		}
	})

	for (const r of rows) {
		if (r.slotOk === false) {
			warnings.push(
				`帧「${r.name}」槽位 ${r.slotMs} ms 小于规范要求的 ${(r.minSlotUs / 1000).toFixed(3)} ms` +
					`（= 帧时间 ${(r.frameTimeUs / 1000).toFixed(3)} ms × ${LIN_CONSTANTS.slotMarginFactor}）。`,
			)
		}
	}

	/** @type {number|null} */
	let slotSumMs = null
	if (schedulePeriodMs !== undefined && schedulePeriodMs !== null) {
		slotSumMs = rows.reduce((s, r) => s + (r.slotMs ?? r.minSlotUs / 1000), 0)
		const ok = slotSumMs <= schedulePeriodMs
		checks.push({
			name: '调度表周期',
			pass: ok,
			detail: `各帧槽合计 ≈ ${slotSumMs.toFixed(3)} ms，周期 ${schedulePeriodMs} ms`,
		})
		if (!ok) {
			warnings.push(
				`调度表装不下：帧槽合计 ${slotSumMs.toFixed(3)} ms 超过周期 ${schedulePeriodMs} ms。` +
					`拉长周期，或缩短帧/减少帧数。`,
			)
		}
	}

	notes.push(
		'帧时间是**设计值**（按位数 × 位时间算）。总线上实际的帧间隔还包含从节点响应延迟，' +
			'调度裕量是否够用应以逻辑分析仪抓到的实际帧边界为准。',
	)

	return { baud, bitTimeUs, frames: rows, slotSumMs, schedulePeriodMs: schedulePeriodMs ?? null, checks, warnings, notes }
}

/* ------------------------------------------------------------------ */
/* 1-Wire                                                              */
/* ------------------------------------------------------------------ */

/**
 * 1-Wire 标准速率的时序窗口。
 *
 * 出处：Maxim/Analog 应用笔记 DS0009《1-Wire Communication Through Software》与器件手册。
 * 单位 µs。**标准速率**的这些窗口是规范值；高速（Overdrive）速率请以具体器件手册为准，
 * 本模块不臆造 Overdrive 的数值。
 */
export const ONEWIRE_STANDARD = {
	slotMinUs: 60,
	slotMaxUs: 120,
	write1LowMinUs: 1,
	write1LowMaxUs: 15,
	write0LowMinUs: 60,
	write0LowMaxUs: 120,
	readLowMinUs: 1,
	readLowMaxUs: 15,
	sampleWithinUs: 15,
	recoveryMinUs: 1,
	resetLowMinUs: 480,
	presenceDetectHighMinUs: 15,
	presenceDetectHighMaxUs: 60,
	presenceDetectLowMinUs: 60,
	presenceDetectLowMaxUs: 240,
}

/**
 * 检查 1-Wire 标准速率的时隙是否落在窗口内。
 *
 * @param {object} input - 输入（µs）。
 * @param {number} [input.bitSlotUs] - 时隙长度。
 * @param {number} [input.write1LowUs] - 写 1 的拉低时间。
 * @param {number} [input.write0LowUs] - 写 0 的拉低时间。
 * @param {number} [input.readLowUs] - 读时隙里主控拉低的时间。
 * @param {number} [input.recoveryUs] - 时隙间恢复时间。
 * @returns {object} 各项判定。
 */
export function analyzeOneWire(input = {}) {
	const spec = ONEWIRE_STANDARD
	const checks = []
	const warnings = []
	const notes = []

	/**
	 * @param {string} label - 项目名。
	 * @param {number|undefined} value - 实测/设计值。
	 * @param {number} min - 下限。
	 * @param {number} max - 上限。
	 */
	const check = (label, value, min, max) => {
		if (value === undefined) return
		const pass = value >= min && value <= max
		checks.push({ name: label, pass, detail: `${value} µs，窗口 ${min}~${max} µs` })
		if (!pass) warnings.push(`${label} = ${value} µs 落在窗口 ${min}~${max} µs 之外。`)
	}

	check('时隙长度', input.bitSlotUs, spec.slotMinUs, spec.slotMaxUs)
	check('写 1 拉低', input.write1LowUs, spec.write1LowMinUs, spec.write1LowMaxUs)
	check('写 0 拉低', input.write0LowUs, spec.write0LowMinUs, spec.write0LowMaxUs)
	check('读时隙拉低', input.readLowUs, spec.readLowMinUs, spec.readLowMaxUs)
	if (input.recoveryUs !== undefined) {
		const pass = input.recoveryUs >= spec.recoveryMinUs
		checks.push({ name: '恢复时间', pass, detail: `${input.recoveryUs} µs，下限 ${spec.recoveryMinUs} µs` })
		if (!pass) warnings.push(`恢复时间 ${input.recoveryUs} µs 短于下限 ${spec.recoveryMinUs} µs。`)
	}

	notes.push(
		`标准速率复位窗口：主控拉低 ≥ ${spec.resetLowMinUs} µs，随后释放；` +
			`从器件在 ${spec.presenceDetectHighMinUs}~${spec.presenceDetectHighMaxUs} µs 内拉低作为存在脉冲。`,
	)
	notes.push(
		'这里的窗口是标准（Standard）速率。**Overdrive 速率的窗口窄一个量级且各器件略有差异，' +
			'必须查具体器件手册，本工具不给那组数。**',
	)
	notes.push(
		'这些是设计目标值；实际波形受上拉电阻与总线电容影响（该总线对电容敏感），' +
			'应以逻辑分析仪在真实总线上抓到的波形为准。',
	)

	return { spec: 'standard', checks, warnings, notes }
}

/* ------------------------------------------------------------------ */
/* RS-232 / RS-422                                                     */
/* ------------------------------------------------------------------ */

/** V.28（RS-232 电气层）的关键限值。出处：TIA-232-F / ITU-T V.28。 */
export const RS232_LIMITS = {
	driverMinV: 5,
	driverTypV: 12,
	receiverThresholdV: 3,
	maxSlewVPerUs: 30,
	maxCablePf: 2500,
	maxDataRateBps: 20000,
	loadMinOhm: 3000,
	loadMaxOhm: 7000,
}

/** V.11（RS-422/485 电气层）的关键限值。出处：TIA-422 / ITU-T V.11。 */
export const RS422_LIMITS = {
	diffMinV: 2,
	terminationOhm: 120,
}

/**
 * 分析一路 RS-232 链路。
 *
 * @param {object} input - 输入。
 * @param {number} [input.driverOutputV] - 驱动器空载或带载输出幅度（V）。
 * @param {number} [input.cableLengthM] - 线缆长度（m）。
 * @param {number} [input.cablePfPerM] - 线缆电容（pF/m）。
 * @param {number} [input.dataRateBps] - 数据率（bit/s）。
 * @returns {object} 各项判定与最长线长。
 */
export function analyzeRs232({ driverOutputV, cableLengthM, cablePfPerM, dataRateBps } = {}) {
	const L = RS232_LIMITS
	const checks = []
	const warnings = []
	const notes = []

	if (driverOutputV !== undefined) {
		const pass = driverOutputV >= L.driverMinV
		checks.push({
			name: '驱动器输出幅度',
			pass,
			detail: `${driverOutputV} V，V.28 要求 ≥ ±${L.driverMinV} V（接收器门限 ±${L.receiverThresholdV} V）`,
		})
		if (!pass) {
			warnings.push(`驱动器输出 ${driverOutputV} V 低于 V.28 要求的 ±${L.driverMinV} V。`)
		}
	}

	/** @type {number|null} */
	let maxLengthM = null
	if (cablePfPerM !== undefined && cablePfPerM > 0) {
		maxLengthM = (L.maxCablePf / cablePfPerM) * 1
		notes.push(
			`按 V.28 的线缆电容上限 ${L.maxCablePf} pF 与 ${cablePfPerM} pF/m 算，` +
				`最长约 ${maxLengthM.toFixed(0)} m（**设计值**，实际还受驱动能力与波特率影响）。`,
		)
		if (cableLengthM !== undefined) {
			const pass = cableLengthM * cablePfPerM <= L.maxCablePf
			checks.push({
				name: '线缆电容',
				pass,
				detail: `${cableLengthM} m × ${cablePfPerM} pF/m = ${(cableLengthM * cablePfPerM).toFixed(0)} pF，上限 ${L.maxCablePf} pF`,
			})
			if (!pass) {
				warnings.push(
					`线缆电容 ${(cableLengthM * cablePfPerM).toFixed(0)} pF 超过 V.28 的 ${L.maxCablePf} pF。` +
						`缩短线缆、换低电容线，或改用 RS-422/485 差分。`,
				)
			}
		}
	} else {
		notes.push('未给线缆电容（pF/m），未算最长线长。V.28 的上限是电容而不是米数。')
	}

	if (dataRateBps !== undefined) {
		const pass = dataRateBps <= L.maxDataRateBps
		checks.push({
			name: '数据率',
			pass,
			detail: `${dataRateBps} bit/s，V.28 上限 ${L.maxDataRateBps} bit/s`,
		})
		if (!pass) {
			warnings.push(
				`${dataRateBps} bit/s 超过 V.28 的 ${L.maxDataRateBps} bit/s。` +
					`需要更高数据率请改用 RS-422/485（V.11）。`,
			)
		}
	}

	notes.push(
		`摆率上限 ${L.maxSlewVPerUs} V/µs（V.28），驱动器负载范围 ` +
			`${L.loadMinOhm}~${L.loadMaxOhm} Ω。接收器门限 ±${L.receiverThresholdV} V。`,
	)
	notes.push('V.28 的长度限制来自**线缆电容**（2500 pF），不是某个固定的米数——所以要按 pF/m 折算。')

	return {
		maxLengthM,
		limits: L,
		checks,
		warnings,
		notes,
	}
}

/**
 * 分析一路 RS-422/485（V.11）链路的差分级。
 *
 * @param {object} input - 输入。
 * @param {number} [input.driverDiffV] - 驱动器差分输出幅度（V）。
 * @param {number} [input.terminationOhm] - 终端电阻（Ω）。
 * @param {number} [input.dataRateBps] - 数据率（bit/s）。
 * @param {number} [input.cableLengthM] - 线缆长度（m）。
 * @returns {object} 判定与"速率×长度"提示。
 */
export function analyzeRs422({ driverDiffV, terminationOhm, dataRateBps, cableLengthM } = {}) {
	const L = RS422_LIMITS
	const checks = []
	const warnings = []
	const notes = []

	if (driverDiffV !== undefined) {
		const pass = driverDiffV >= L.diffMinV
		checks.push({ name: '差分输出幅度', pass, detail: `${driverDiffV} V，V.11 下限 ${L.diffMinV} V` })
		if (!pass) warnings.push(`差分输出 ${driverDiffV} V 低于 V.11 的 ${L.diffMinV} V。`)
	}
	if (terminationOhm !== undefined) {
		const pass = Math.abs(terminationOhm - L.terminationOhm) < L.terminationOhm * 0.2
		checks.push({
			name: '终端电阻',
			pass,
			detail: `${terminationOhm} Ω，惯例 ${L.terminationOhm} Ω（应与线缆特性阻抗匹配）`,
		})
		if (!pass) {
			warnings.push(
				`终端电阻 ${terminationOhm} Ω 偏离 ${L.terminationOhm} Ω 较多——` +
					`应与所用线缆的特性阻抗匹配，否则反射会让误码率上升。`,
			)
		}
	}

	if (dataRateBps !== undefined && cableLengthM !== undefined) {
		notes.push(
			`给出的是 ${dataRateBps} bit/s × ${cableLengthM} m。V.11 的速率与长度是**互相制约**的` +
				`（典型量级：10 Mbit/s 约 12 m，1 Mbit/s 约 100 m，100 kbit/s 约 1200 m）。` +
				`具体曲线请查所用收发器的数据手册，本工具不替你定死。`,
		)
	}

	notes.push(
		'V.11 只看差分幅度与终端匹配；共模范围、地电位差与浪涌保护必须另查收发器手册。',
	)

	return { limits: L, checks, warnings, notes }
}
