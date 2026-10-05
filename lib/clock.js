/**
 * 时钟树：整除性求解与逐节点校验。
 *
 * 两块内容：
 *   1. **求解**：给晶振频率与目标频率，找出"能精确命中"的 PLL / 分频组合。
 *      关系是确定的：fout = fsrc / inputDiv × mul / outputDiv（整数运算）。
 *      命中不了就是命中不了——这时要么换晶振，要么接受频率误差（如 UART 的波特率偏差）。
 *   2. **校验**：给一条已定的分频链，逐节点算出实际频率，并与各外设的时钟上限比对。
 *
 * 设计值：算出来的是"寄存器配置对应的频率"。实际频率还受晶振本身精度与温漂影响，
 * 那部分必须实测（或用有源晶振的规格书）。
 *
 * @module dsh-embedded-kit/clock
 */

/** 常见的外设时钟上限经验值**不提供**——必须由调用方按具体芯片手册给出。 */

/**
 * 求解 PLL 配置。
 *
 * @param {object} input - 输入。
 * @param {number} input.sourceHz - 晶振 / 时钟源频率（Hz）。
 * @param {number} input.targetHz - 目标频率（Hz）。
 * @param {number} [input.inputDivMin] - 输入分频下限，默认 1。
 * @param {number} [input.inputDivMax] - 输入分频上限，默认 16。
 * @param {number} [input.mulMin] - 倍频下限，默认 2。
 * @param {number} [input.mulMax] - 倍频上限，默认 512。
 * @param {number} [input.outputDivMax] - 输出分频上限，默认 16。
 * @param {number} [input.vcoMinHz] - PLL VCO 频率下限（手册给，如 100e6）。
 * @param {number} [input.vcoMaxHz] - PLL VCO 频率上限（手册给，如 432e6）。
 * @returns {object} 精确命中的组合（可能为空）。
 */
export function solvePll({
	sourceHz,
	targetHz,
	inputDivMin = 1,
	inputDivMax = 16,
	mulMin = 2,
	mulMax = 512,
	outputDivMax = 16,
	vcoMinHz,
	vcoMaxHz,
}) {
	if (!(sourceHz > 0) || !(targetHz > 0)) throw new Error('source_hz 与 target_hz 必须为正数')

	const solutions = []
	const warnings = []
	const notes = []
	let nearMissBest = null

	for (let inputDiv = inputDivMin; inputDiv <= inputDivMax; inputDiv += 1) {
		const pllIn = sourceHz / inputDiv
		if (!Number.isInteger(pllIn)) continue
		for (let mul = mulMin; mul <= mulMax; mul += 1) {
			const vco = pllIn * mul
			if (vcoMinHz !== undefined && vco < vcoMinHz) continue
			if (vcoMaxHz !== undefined && vco > vcoMaxHz) continue
			for (let outputDiv = 1; outputDiv <= outputDivMax; outputDiv += 1) {
				const fout = vco / outputDiv
				if (!Number.isInteger(fout)) continue
				const err = fout - targetHz
				if (err === 0) {
					solutions.push({ inputDiv, mul, outputDiv, pllInHz: pllIn, vcoHz: vco, outHz: fout })
				} else if (nearMissBest === null || Math.abs(err) < Math.abs(nearMissBest.errHz)) {
					nearMissBest = { inputDiv, mul, outputDiv, pllInHz: pllIn, vcoHz: vco, outHz: fout, errHz: err }
				}
			}
		}
	}

	// 排序：VCO 越高越靠近约束边界，越不稳健；优先给 VCO 居中或倍数简单的
	solutions.sort((a, b) => a.mul - b.mul || a.outputDiv - b.outputDiv)

	if (solutions.length === 0) {
		warnings.push(
			`在给定范围内**找不到**能精确得到 ${targetHz} Hz 的组合。` +
				(nearMissBest
					? `最接近的是 ${nearMissBest.outHz} Hz（误差 ${nearMissBest.errHz} Hz，` +
						`相对 ${((nearMissBest.errHz / targetHz) * 100).toFixed(3)}%）。`
					: '范围内没有任何可行组合。') +
				' 这个误差能不能接受取决于用途：UART 按位同步容错通常要 <±2%，而 USB / CAN / I²S 对频率有硬要求。',
		)
	} else {
		notes.push(
			`共 ${solutions.length} 组能精确命中。优先选 **VCO 落在手册建议区间中部**、` +
				`且 mul/outputDiv 较小的组合——VCO 贴着上下限时，温漂与批次差异容易把它推出合法区间。`,
		)
		if (vcoMinHz === undefined || vcoMaxHz === undefined) {
			notes.push('未给 vco_min_hz / vco_max_hz，未对 VCO 区间做筛选——**这两项必须来自芯片手册**。')
		}
	}

	return { sourceHz, targetHz, solutions, nearMiss: solutions.length === 0 ? nearMissBest : null, warnings, notes }
}

/**
 * 逐节点评估一条分频链。
 *
 * @param {object} input - 输入。
 * @param {number} input.sourceHz - 源频率（Hz）。
 * @param {Array<{name:string, kind:string, value:number}>} input.stages - 分频/倍频级。
 *   kind: 'div' 除以 value、'mul' 乘以 value（value 必须是正整数）。
 * @param {Array<{name:string, maxHz:number}>} [input.limits] - 各节点的频率上限（来自芯片手册）。
 * @returns {object} 各节点频率与判定。
 */
export function evaluateClockChain({ sourceHz, stages, limits = [] }) {
	if (!(sourceHz > 0)) throw new Error('source_hz 必须为正数')
	if (!Array.isArray(stages) || stages.length === 0) throw new Error('stages 至少给一级')

	const checks = []
	const warnings = []
	const notes = []
	const nodes = []
	let f = sourceHz

	nodes.push({ name: 'source', hz: f })
	for (const s of stages) {
		if (!Number.isInteger(s.value) || s.value <= 0) {
			throw new Error(`级「${s.name}」的 value 必须是正整数，收到 ${s.value}`)
		}
		if (s.kind === 'div') f = f / s.value
		else if (s.kind === 'mul') f = f * s.value
		else throw new Error(`级「${s.name}」的 kind 只能是 'div' 或 'mul'`)
		nodes.push({ name: s.name, hz: f, integer: Number.isInteger(f) })
	}

	for (const n of nodes.slice(1)) {
		if (!n.integer) {
			warnings.push(`节点「${n.name}」的频率 ${n.hz} Hz 不是整数——分频链有误，实际会取整到别的值。`)
		}
	}

	for (const lim of limits) {
		const node = nodes.find((n) => n.name === lim.name)
		if (!node) {
			warnings.push(`限值里给了「${lim.name}」，但分频链里没有这个节点名，无法比对。`)
			continue
		}
		const pass = node.hz <= lim.maxHz
		checks.push({
			name: `${lim.name} 频率上限`,
			pass,
			detail: `${node.hz} Hz vs 上限 ${lim.maxHz} Hz`,
		})
		if (!pass) {
			warnings.push(`「${lim.name}」超频：${node.hz} Hz > ${lim.maxHz} Hz。超频的外设可能"能用"但不保证，温度角上会先坏。`)
		}
	}

	notes.push('各节点频率是**寄存器配置对应的设计值**；实际频率还取决于晶振精度与温漂，必须实测（或查有源晶振规格）。')
	if (limits.length === 0) {
		notes.push('未给任何 limits，没有做上限校验。**各外设的时钟上限必须按具体芯片手册填入**，本工具不内置任何经验值。')
	}

	return { sourceHz, nodes, checks, warnings, notes }
}

/**
 * 频率误差对串行通信的影响速算。
 *
 * 异步串口按起始位重新同步、每帧最多 10~11 位，所以两端累计误差要在
 * 半个位时间内吸收掉：总误差 < 0.5 / 位数。
 *
 * @param {object} input - 输入。
 * @param {number} input.actualHz - 实际时钟（Hz）。
 * @param {number} input.nominalHz - 标称时钟（Hz）。
 * @param {number} [input.bitsPerFrame] - 每帧位数（含起止与校验），默认 10。
 * @returns {object} 误差与判定。
 */
export function uartTolerance({ actualHz, nominalHz, bitsPerFrame = 10 }) {
	if (!(actualHz > 0) || !(nominalHz > 0)) throw new Error('actual_hz 与 nominal_hz 必须为正数')
	const relError = (actualHz - nominalHz) / nominalHz
	const budget = 0.5 / bitsPerFrame
	const pass = Math.abs(relError) <= budget
	const notes = [
		`异步串口的同步窗口：接收方在每个起始位重新对齐，之后要在这个帧内不再对齐，` +
			`所以两端**累计**相对误差必须小于 0.5 / ${bitsPerFrame} = ${(budget * 100).toFixed(2)}%。`,
		'上面只算了本端的时钟误差；总预算要在**发送方与接收方之间分配**，实际每端只占一半左右。',
	]
	return {
		relativeErrorPercent: relError * 100,
		budgetPercent: budget * 100,
		pass,
		notes,
	}
}
