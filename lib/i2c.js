/**
 * I²C / SMBus 总线电气与可行性。
 *
 * **公式出处：NXP UM10204（I²C-bus specification and user manual）。**
 * 这里算的是**设计值**；真实总线电容与实际上升时间必须在成品板上实测
 * （探头电容本身就会加几个 pF，算出来的余量不等于实测余量）。
 *
 * 三条核心关系：
 *   1. 上拉下限由灌电流决定      Rp(min) = (VDD − VOL(max)) / IOL(max)
 *   2. 上拉上限由上升时间决定    tr = 0.8473 × Rp × Cb   →   Rp(max) = tr(max) / (0.8473 × Cb)
 *      0.8473 = ln(0.7/0.3)，即从 0.3·VDD 充到 0.7·VDD 所需的 RC 时间常数倍数。
 *   3. 总线电容必须在该模式上限之内（它是硬约束，不是"尽量小"）。
 *
 * 另外还有一个容易被忽略的上限：上拉电阻不能大到"器件漏电流把高电平拖下去"——
 * 即 VDD − Rp × Ii(total) 仍需 ≥ VIH(min)。给了总漏电流才算这一条。
 *
 * @module dsh-embedded-kit/i2c
 */

/** 各模式的规范上限。tr 单位 ns，Cb 单位 pF。 */
export const I2C_MODES = {
	standard: {
		id: 'standard',
		label: 'Standard-mode (100 kHz)',
		fmaxHz: 100_000,
		trMaxNs: 1000,
		cbMaxPf: 400,
		volMaxV: 0.4,
		iolMaxA: 0.003,
		vihRatio: 0.7,
	},
	fast: {
		id: 'fast',
		label: 'Fast-mode (400 kHz)',
		fmaxHz: 400_000,
		trMaxNs: 300,
		cbMaxPf: 400,
		volMaxV: 0.4,
		iolMaxA: 0.003,
		vihRatio: 0.7,
	},
	'fast-plus': {
		id: 'fast-plus',
		label: 'Fast-mode Plus (1 MHz)',
		fmaxHz: 1_000_000,
		trMaxNs: 120,
		cbMaxPf: 550,
		volMaxV: 0.4,
		iolMaxA: 0.02,
		vihRatio: 0.7,
	},
	'high-speed': {
		id: 'high-speed',
		label: 'High-speed mode (3.4 MHz, Cb ≤ 100 pF)',
		fmaxHz: 3_400_000,
		trMaxNs: 80,
		cbMaxPf: 100,
		volMaxV: 0.4,
		iolMaxA: 0.003,
		vihRatio: 0.7,
		// HS 模式的总线在高速段由**电流源**上拉驱动，且串联了分离的电阻，
		// 与标准/快速模式的"电阻上拉"不是同一套。这里的 Rp 区间只能当数量级参考。
		caveat:
			'HS 模式在高速段用电流源上拉（并串入分离电阻），不是普通电阻上拉；' +
			'下面的 Rp 区间只能当数量级参考，实际取值请按器件手册的 HS 章节。',
	},
}

/** tr = ln(0.7 / 0.3) × Rp × Cb。 */
export const RISE_TIME_FACTOR = 0.8473

/**
 * 由上升时间上限与总线电容算上拉上限。
 *
 * @param {number} trMaxNs - 该模式允许的最大上升时间（ns）。
 * @param {number} cbPf - 总线总电容（pF）。
 * @returns {number|null} 上拉上限（Ω）；电容非正时返回 null（视为无约束）。
 */
export function rpMaxFromRiseTime(trMaxNs, cbPf) {
	if (!(cbPf > 0)) return null
	// ns / pF = 1e-9 s / 1e-12 F = 1e3 Ω
	return (trMaxNs / (RISE_TIME_FACTOR * cbPf)) * 1000
}

/**
 * 由上拉与总线电容算实际上升时间。
 *
 * @param {number} rpOhm - 上拉电阻（Ω）。
 * @param {number} cbPf - 总线总电容（pF）。
 * @returns {number} 上升时间（ns）。
 */
export function riseTimeNs(rpOhm, cbPf) {
	return (RISE_TIME_FACTOR * rpOhm * cbPf) / 1000
}

/**
 * 上拉下限：灌电流能力约束。
 *
 * @param {number} vddV - 电源电压（V）。
 * @param {number} volMaxV - 器件在 IOL 下的最大低电平（V）。
 * @param {number} iolMaxA - 器件最大灌电流（A）。
 * @returns {number} 上拉下限（Ω）。
 */
export function rpMinFromSink(vddV, volMaxV, iolMaxA) {
	return (vddV - volMaxV) / iolMaxA
}

/**
 * 上拉上限：总输入漏电流约束。
 *
 * 条件：VDD − Rp × Ii(total) ≥ VIH(min)。
 *
 * @param {number} vddV - 电源电压（V）。
 * @param {number} vihRatio - VIH / VDD，规范值为 0.7。
 * @param {number} totalLeakA - 总线上所有器件的高电平输入漏电流之和（A）。
 * @returns {number|null} 上拉上限（Ω）；漏电流为 0 时无约束，返回 null。
 */
export function rpMaxFromLeakage(vddV, vihRatio, totalLeakA) {
	if (!(totalLeakA > 0)) return null
	return (vddV - vihRatio * vddV) / totalLeakA
}

/**
 * 由总线电容与目标速率反推该模式下需要的最大上升时间是否够用。
 *
 * 一个 SCL 周期内至少要给上升时间留出余量：规范把 tr(max) 定在周期的一部分，
 * 所以这里只做"电容是否超限 + tr 是否超限"的硬判定，不假装能算精确裕量。
 *
 * @param {object} input - 输入。
 * @param {string} input.mode - 模式 id。
 * @param {number} input.cbPf - 总线总电容（pF）。
 * @param {number} [input.rpOhm] - 选定的上拉（Ω）。给了就算实际上升时间。
 * @param {number} [input.vddV] - 电源（V）。
 * @param {number} [input.totalLeakA] - 总输入漏电流（A）。
 * @returns {object} 计算结果与判定。
 */
export function analyzeI2c({ mode, cbPf, rpOhm, vddV = 3.3, totalLeakA = 0 }) {
	const spec = I2C_MODES[mode]
	if (!spec) throw new Error(`未知的 I²C 模式：${mode}（可用：${Object.keys(I2C_MODES).join(' / ')}）`)
	if (!(cbPf > 0)) throw new Error('cb_pf 必须为正数（总线总电容，含走线、引脚、器件）')

	const checks = []
	const warnings = []
	const notes = []

	if (spec.caveat) notes.push(spec.caveat)

	// 1) 电容硬上限
	if (cbPf > spec.cbMaxPf) {
		warnings.push(
			`总线电容 ${cbPf} pF 超过 ${spec.label} 的规范上限 ${spec.cbMaxPf} pF。` +
				`这是硬约束：降速到更低的模式，或减小走线/器件电容。`,
		)
	}

	// 2) 上拉区间
	const rpMin = rpMinFromSink(vddV, spec.volMaxV, spec.iolMaxA)
	const rpMaxTr = rpMaxFromRiseTime(spec.trMaxNs, cbPf)
	const rpMaxLeak = rpMaxFromLeakage(vddV, spec.vihRatio, totalLeakA)

	/** @type {number[]} */
	const upperLimits = []
	if (rpMaxTr !== null) upperLimits.push(rpMaxTr)
	if (rpMaxLeak !== null) upperLimits.push(rpMaxLeak)
	const rpMax = upperLimits.length > 0 ? Math.min(...upperLimits) : null

	notes.push(
		`上拉下限按 IOL=${(spec.iolMaxA * 1000).toFixed(spec.iolMaxA < 0.01 ? 2 : 0)} mA、` +
			`VOL=${spec.volMaxV} V 算：Rp(min) = (${vddV} − ${spec.volMaxV}) / ${spec.iolMaxA} A。`,
	)
	notes.push(`上拉上限按 tr(max)=${spec.trMaxNs} ns 与 Cb=${cbPf} pF 算：Rp(max) = tr / (0.8473 × Cb)。`)
	if (rpMaxLeak !== null) {
		notes.push(
			`漏电流也参与上限：VDD − Rp × Ii ≥ VIH(min)=${(spec.vihRatio * vddV).toFixed(2)} V，` +
				`对应 Rp ≤ ${Math.round(rpMaxLeak)} Ω。`,
		)
	} else {
		notes.push('未提供总输入漏电流，未计入"漏电流把高电平拖低"这条上限；器件漏电流较大时应补上。')
	}

	checkRange(rpMin, rpMax, checks, warnings)

	// 3) 若给了实际上拉，算实际上升时间
	/** @type {number|null} */
	let trActualNs = null
	if (rpOhm !== undefined && rpOhm !== null) {
		trActualNs = riseTimeNs(rpOhm, cbPf)
		const ok = trActualNs <= spec.trMaxNs
		checks.push({
			name: '上升时间',
			pass: ok,
			detail: `Rp=${rpOhm} Ω × Cb=${cbPf} pF → tr≈${trActualNs.toFixed(0)} ns，上限 ${spec.trMaxNs} ns`,
		})
		if (!ok) {
			warnings.push(
				`选定的 ${rpOhm} Ω 上升时间约 ${trActualNs.toFixed(0)} ns，超出 ${spec.label} 的 ${spec.trMaxNs} ns，` +
					`该模式跑不到标称速率。减小上拉或降低总线电容。`,
			)
		}
		if (rpOhm < rpMin) {
			warnings.push(`${rpOhm} Ω 低于下限 ${Math.round(rpMin)} Ω：低电平灌电流不足，VOL 会超标。`)
		}
		if (rpMax !== null && rpOhm > rpMax) {
			warnings.push(`${rpOhm} Ω 高于上限 ${Math.round(rpMax)} Ω：上升沿太慢。`)
		}
	}

	return {
		mode: spec.id,
		modeLabel: spec.label,
		cbPf,
		rpMinOhm: rpMin,
		rpMaxOhm: rpMax,
		rpMaxFromTrOhm: rpMaxTr,
		rpMaxFromLeakOhm: rpMaxLeak,
		rpActualOhm: rpOhm ?? null,
		trActualNs,
		trMaxNs: spec.trMaxNs,
		cbMaxPf: spec.cbMaxPf,
		checks,
		warnings,
		notes,
	}
}

/**
 * 区间合理性检查。
 *
 * @param {number} rpMin - 下限。
 * @param {number|null} rpMax - 上限。
 * @param {Array<object>} checks - 结果收集。
 * @param {string[]} warnings - 警告收集。
 */
function checkRange(rpMin, rpMax, checks, warnings) {
	if (rpMax === null) {
		checks.push({ name: '上拉区间', pass: true, detail: `Rp ≥ ${Math.round(rpMin)} Ω（无上限约束）` })
		return
	}
	const pass = rpMax > rpMin
	checks.push({
		name: '上拉区间',
		pass,
		detail: `${Math.round(rpMin)} Ω ≤ Rp ≤ ${Math.round(rpMax)} Ω`,
	})
	if (!pass) {
		warnings.push(
			`区间为空（下限 ${Math.round(rpMin)} Ω > 上限 ${Math.round(rpMax)} Ω）：` +
				`这个电容在该模式下不可行。降速到更低模式，或减小总线电容。`,
		)
	}
}

/** 供文档与自测使用的模式名清单。 */
export const I2C_MODE_IDS = Object.keys(I2C_MODES)
