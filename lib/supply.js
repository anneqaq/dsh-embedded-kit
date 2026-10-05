/**
 * 电源树功耗与结温。
 *
 * 全部是确定公式：
 *
 *   LDO：   Pd = (Vin − Vout) × Iout          效率 = Vout / Vin（与电流无关）
 *   DCDC：  Pin = Pout / η                     Pd = Pin − Pout
 *   结温：  Tj = Ta + Pd × Rθja
 *   允许：  Pd(max) = (Tj(max) − Ta) / Rθja
 *   热阻链：Rθja = Rθjc + Rθcs + Rθsa         （壳到散热器到环境，可只给 Rθja）
 *
 * **LDO 的坑**：效率等于电压比，与输出电流**无关**。所以"输入电压越高、压差越大"时效率越低，
 * 而且压差全部变成热。这是把 12 V 降到 3.3 V 用 LDO 时的典型翻车点——
 * 看似只有 100 mA，却有 0.87 W 要散掉。
 *
 * Rθja / Tj(max) / η 必须来自器件手册；本模块不内置任何默认值。
 *
 * @module dsh-embedded-kit/supply
 */

/**
 * 分析一条电源轨。
 *
 * @param {object} input - 输入。
 * @param {string} input.name - 轨名。
 * @param {string} input.type - 'ldo' 或 'dcdc'。
 * @param {number} input.vinV - 输入电压（V）。
 * @param {number} input.voutV - 输出电压（V）。
 * @param {number} input.ioutA - 输出电流（A）。
 * @param {number} [input.efficiency] - DCDC 效率（0~1），来自手册曲线。ldo 不需要。
 * @param {number} [input.rthjaCPerW] - 结到环境热阻（°C/W），来自手册。
 * @param {number} [input.tjMaxC] - 最高结温（°C），来自手册。
 * @param {number} [input.ambientC] - 环境温度（°C），默认 25。
 * @returns {object} 功耗、结温与判定。
 */
export function analyzeRail({
	name,
	type,
	vinV,
	voutV,
	ioutA,
	efficiency,
	rthjaCPerW,
	tjMaxC,
	ambientC = 25,
}) {
	if (!(vinV > 0) || !(voutV > 0) || !(ioutA >= 0)) {
		throw new Error(`轨「${name}」的电压必须为正、电流不能为负`)
	}
	if (type !== 'ldo' && type !== 'dcdc') throw new Error(`轨「${name}」的 type 只能是 'ldo' 或 'dcdc'`)

	const checks = []
	const warnings = []
	const notes = []

	const pOut = voutV * ioutA
	let pIn
	let eff
	if (type === 'ldo') {
		pIn = vinV * ioutA
		eff = voutV / vinV
		if (vinV < voutV) {
			warnings.push(`轨「${name}」是 LDO 但输入 ${vinV} V 低于输出 ${voutV} V，这不可能工作（需要升压）。`)
		}
		notes.push(
			`LDO 效率 = Vout / Vin = ${voutV} / ${vinV} = **${(eff * 100).toFixed(1)}%**，与输出电流无关。` +
				`压差 ${(vinV - voutV).toFixed(2)} V 全部变成热。`,
		)
	} else {
		if (efficiency === undefined || !(efficiency > 0) || efficiency > 1) {
			throw new Error(`轨「${name}」是 DCDC，必须给 efficiency（0~1，来自手册效率曲线）`)
		}
		eff = efficiency
		pIn = pOut / eff
		notes.push(`DCDC：Pin = Pout / η = ${pOut.toFixed(4)} / ${eff} = ${pIn.toFixed(4)} W。`)
	}

	const pDissipated = pIn - pOut

	/** @type {number|null} */
	let tjC = null
	/** @type {number|null} */
	let allowedPdW = null
	if (rthjaCPerW !== undefined && tjMaxC !== undefined) {
		tjC = ambientC + pDissipated * rthjaCPerW
		allowedPdW = (tjMaxC - ambientC) / rthjaCPerW
		const pass = tjC <= tjMaxC
		checks.push({
			name: `${name} 结温`,
			pass,
			detail: `Tj = ${ambientC} + ${pDissipated.toFixed(4)} × ${rthjaCPerW} = ${tjC.toFixed(1)} °C，上限 ${tjMaxC} °C`,
		})
		checks.push({
			name: `${name} 允许功耗`,
			pass: pDissipated <= allowedPdW,
			detail: `实际耗散 ${pDissipated.toFixed(4)} W vs 允许 ${allowedPdW.toFixed(4)} W`,
		})
		if (!pass) {
			warnings.push(
				`轨「${name}」结温 ${tjC.toFixed(1)} °C 超过 ${tjMaxC} °C。` +
					'换 DCDC、降低压差、或加大铜箔/加散热片（降低 Rθja）。',
			)
		} else if (tjC > (tjMaxC + ambientC) / 2) {
			warnings.push(
				`轨「${name}」结温 ${tjC.toFixed(1)} °C 已超过上限与环境的中点，余量偏小。` +
					'注意 Rθja 随铜箔面积变化很大，手册值通常对应特定板层/铜面积，实际板子可能更差。',
			)
		}
	} else {
		notes.push(`轨「${name}」未给 rthja_c_per_w 与 tj_max_c，没有算结温。**这两项必须来自器件手册。**`)
	}

	notes.push(
		`耗散 ${pDissipated.toFixed(4)} W 是**按典型参数算的设计值**。实际还受效率随负载变化（DCDC 轻载效率显著变差）、` +
			'环境温升、以及封装焊盘散热影响，量产前应做热成像或测结温。',
	)

	return {
		name,
		type,
		vinV,
		voutV,
		ioutA,
		pOut,
		pIn,
		pDissipated,
		efficiency: eff,
		tjC,
		allowedPdW,
		ambientC,
		checks,
		warnings,
		notes,
	}
}

/**
 * 分析整棵电源树。
 *
 * @param {object} input - 输入。
 * @param {number} [input.ambientC] - 环境温度（°C），默认 25。
 * @param {Array<object>} input.rails - 各轨参数，见 analyzeRail。
 * @returns {object} 各轨结果与合计。
 */
export function analyzePowerTree({ ambientC = 25, rails }) {
	if (!Array.isArray(rails) || rails.length === 0) throw new Error('rails 至少给一条')

	const results = rails.map((r) => analyzeRail({ ambientC, ...r }))
	const checks = results.flatMap((r) => r.checks)
	const warnings = results.flatMap((r) => r.warnings.map((w) => w))
	const notes = []

	const totalPOut = results.reduce((a, r) => a + r.pOut, 0)
	const totalPIn = results.reduce((a, r) => a + r.pIn, 0)
	const totalPdissipated = results.reduce((a, r) => a + r.pDissipated, 0)
	const overallEfficiency = totalPIn > 0 ? totalPOut / totalPIn : 0

	// 找出最热的轨
	const withTj = results.filter((r) => r.tjC !== null)
	const hottest = withTj.length > 0 ? withTj.reduce((a, b) => (b.tjC > a.tjC ? b : a)) : null

	notes.push(
		`合计：负载 ${totalPOut.toFixed(4)} W，输入 ${totalPIn.toFixed(4)} W，**耗散 ${totalPdissipated.toFixed(4)} W**，` +
			`整树效率 ${(overallEfficiency * 100).toFixed(1)}%。`,
	)
	if (hottest) {
		notes.push(`最热的轨是「${hottest.name}」：Tj = ${hottest.tjC.toFixed(1)} °C。热设计先盯它。`)
	}
	// LDO 占比提示
	const ldoLoss = results.filter((r) => r.type === 'ldo').reduce((a, r) => a + r.pDissipated, 0)
	if (totalPdissipated > 0 && ldoLoss / totalPdissipated > 0.5) {
		notes.push(
			`耗散里 ${((ldoLoss / totalPdissipated) * 100).toFixed(0)}% 来自 LDO。` +
				'压差大的 LDO 换成 DCDC 通常是收益最大的一步。',
		)
	}
	notes.push(
		'整树效率是各轨**独立**相乘的结果，未考虑上级轨的负载对它的效率影响（DCDC 效率随负载变化）。' +
			'要准确评估应按实际负载点查效率曲线，而不是用单一 η。',
	)

	return {
		ambientC,
		rails: results,
		totalPOut,
		totalPIn,
		totalPdissipated,
		overallEfficiency,
		hottestRail: hottest ? { name: hottest.name, tjC: hottest.tjC } : null,
		checks,
		warnings,
		notes,
	}
}
