/**
 * Cortex-M NVIC 优先级分组与实际中断延迟预算。
 *
 * 这一块全是**确定规则**（CMSIS / ARM 架构定义），没有经验估计：
 *
 * 1. 优先级寄存器是 8 位，但**只有高 N 位被实现**（`__NVIC_PRIO_BITS`，常见 2~4 位，
 *    必须查芯片手册）。写低位无效。
 * 2. PRIGROUP 把"N 个已实现位"再切成**抢占位**与**子优先级位**：
 *      抢占级数 = 2^抢占位数，子优先级只决定"同时挂起时谁先跑"，**不产生抢占**。
 * 3. **数值越小优先级越高。** 两个中断若抢占位相同，**彼此不能互相抢占**——
 *    这是最常见的误判："设了更高的优先级，为什么还是被挡住？"
 * 4. 中断延迟 = 当前关中断窗口剩余时间 + 正在执行的高优先级 ISR 时间 + 入栈/取向量开销。
 *
 * @module dsh-embedded-kit/nvic
 */

/**
 * 由"已实现的优先级位数"与"子优先级位数"算出分组结果。
 *
 * @param {object} input - 输入。
 * @param {number} input.implementedBits - 已实现的优先级位数（查手册，常见 2~4）。
 * @param {number} input.subPriorityBits - 划给子优先级的位数。
 * @returns {object} 抢占位/子优先级位、各级数与 8 位寄存器里的实际位置。
 */
export function priorityGrouping({ implementedBits, subPriorityBits }) {
	if (!Number.isInteger(implementedBits) || implementedBits < 1 || implementedBits > 8) {
		throw new Error('implemented_bits 必须是 1~8 的整数（来自芯片手册的 __NVIC_PRIO_BITS）')
	}
	if (!Number.isInteger(subPriorityBits) || subPriorityBits < 0 || subPriorityBits > implementedBits) {
		throw new Error('sub_priority_bits 必须在 0 ~ implemented_bits 之间')
	}
	const preemptBits = implementedBits - subPriorityBits
	const notes = [
		`8 位优先级寄存器里，只有高 ${implementedBits} 位被实现；低 ${8 - implementedBits} 位是保留位，写进去无效。`,
		`抢占位 = 已实现位数 − 子优先级位 = ${implementedBits} − ${subPriorityBits} = ${preemptBits} 位，` +
			`即 ${2 ** preemptBits} 个抢占级。`,
		`子优先级 ${subPriorityBits} 位（${2 ** subPriorityBits} 级）：**只决定同时挂起时的执行顺序，不产生抢占**。`,
		`**数值越小优先级越高。** 抢占位相同的两个中断彼此不能互相抢占，无论子优先级差多少。`,
	]
	if (subPriorityBits > 0) {
		notes.push(
			'子优先级位不为 0 时，"设了更小的优先级数值却仍被挡住"几乎总是因为差异落在子优先级位上——' +
				'把 sub_priority_bits 设为 0 可以用最少的位数换到最多的抢占级。',
		)
	}
	return {
		implementedBits,
		subPriorityBits,
		preemptBits,
		preemptLevels: 2 ** preemptBits,
		subLevels: 2 ** subPriorityBits,
		shift: 8 - implementedBits,
		notes,
	}
}

/**
 * 判断 a 能否抢占 b。
 *
 * 入参是**功能优先级值**（0 ~ 2^已实现位数 − 1），不是写进寄存器那个已左移的 8 位原始值——
 * 那样容易把"用户想配的级数"和"寄存器内容"混淆，也是实测中最常算错的地方。
 *
 * @param {object} input - 输入。
 * @param {number} input.aPriority - a 的功能优先级值（数值越小优先级越高）。
 * @param {number} input.bPriority - b 的功能优先级值。
 * @param {number} input.implementedBits - 已实现位数。
 * @param {number} input.subPriorityBits - 子优先级位数。
 * @returns {object} 判定与两者的实际抢占级/子级。
 */
export function canPreempt({ aPriority, bPriority, implementedBits, subPriorityBits }) {
	const g = priorityGrouping({ implementedBits, subPriorityBits })
	const mask = (1 << implementedBits) - 1
	const clamp = (v) => {
		if (!Number.isInteger(v) || v < 0) throw new Error('优先级必须是 ≥ 0 的整数')
		return v & mask
	}
	const a = clamp(aPriority)
	const b = clamp(bPriority)

	const preemptOf = (v) => v >> subPriorityBits
	const subOf = (v) => v & ((1 << subPriorityBits) - 1)

	const aPreempt = preemptOf(a)
	const bPreempt = preemptOf(b)
	const aSub = subOf(a)
	const bSub = subOf(b)
	const preempts = aPreempt < bPreempt

	const notes = [
		`a 的实际抢占级 = ${aPreempt}（子级 ${aSub}），b = ${bPreempt}（子级 ${bSub}）。`,
		preempts
			? '抢占级更小 → a 可以打断 b。'
			: aPreempt === bPreempt
				? '**抢占级相同 → a 不能打断 b**，只能等 b 跑完再执行。子优先级只决定同时挂起时的先后，**不产生抢占**——这是最常见的误判点。'
				: 'a 的抢占级更大（数值更大 = 优先级更低）→ a 不能打断 b。',
	]
	if (aPriority > mask || bPriority > mask) {
		notes.push(
			`注意：给的优先级值超出 ${implementedBits} 位能表示的范围（最大 ${mask}），已按位截断。` +
				'超出的位在硬件上会被丢弃，两个"看起来不同"的优先级可能落到同一级——这是"设了更高优先级却仍被挡住"的典型原因。',
		)
	}
	notes.push(
		`寄存器写入值 = 功能值 << ${8 - implementedBits}（CMSIS 的 NVIC_SetPriority 替你做这件事）。` +
			`本工具接收功能值，不接寄存器原始字节。`,
	)

	return { preempts, aPreempt, bPreempt, aSub, bSub, shift: g.shift, notes }
}

/**
 * 中断延迟上界的粗算。
 *
 * 延迟 = 最长关中断窗口 + 所有更高优先级 ISR 的执行时间之和（保守上界）+ 入栈开销。
 *
 * 保守处：更高优先级 ISR 不一定全部叠加，但按叠加算能得到一个安全上界。
 *
 * @param {object} input - 输入。
 * @param {Array<{name:string, us:number}>} [input.disabledWindowsUs] - 各处"关中断"代码段及其时长。
 * @param {Array<{name:string, us:number}>} [input.higherPriorityIsrsUs] - 所有更高优先级 ISR 的执行时间。
 * @param {number} [input.entryOverheadUs] - 入栈+取向量开销，Cortex-M 典型 12 周期，按主频折算。
 * @param {number} [input.requirementUs] - 业务要求的最坏响应时间；给了就判定。
 * @returns {object} 上界与判定。
 */
export function analyzeInterruptLatency({
	disabledWindowsUs = [],
	higherPriorityIsrsUs = [],
	entryOverheadUs = 0,
	requirementUs,
}) {
	const checks = []
	const warnings = []
	const notes = []
	for (const x of [...disabledWindowsUs, ...higherPriorityIsrsUs]) {
		if (!(x.us >= 0)) throw new Error(`「${x.name}」的时长必须是非负数`)
	}

	const longestDisabled = disabledWindowsUs.reduce((a, b) => (b.us > a.us ? b : a), { name: '（无）', us: 0 })
	const isrSum = higherPriorityIsrsUs.reduce((a, b) => a + b.us, 0)
	const upperBoundUs = longestDisabled.us + isrSum + entryOverheadUs

	notes.push(
		`上界 = 最长关中断窗口 ${longestDisabled.us} µs（${longestDisabled.name}）` +
			` + 更高优先级 ISR 之和 ${isrSum} µs + 入栈开销 ${entryOverheadUs} µs = **${upperBoundUs.toFixed(2)} µs**。`,
	)
	notes.push(
		'取"最长的那一个"关中断窗口而不是求和：中断只在**当前**那个关中断段结束时才可能被响应，' +
			'前面已经跑完的段不需要再等。',
	)
	notes.push(
		'更高优先级 ISR 按**求和**算是保守上界（它们不一定会叠加）。要收紧这个上界，' +
			'需要按实际到达顺序做调度分析，或直接把高优先级 ISR 做短。',
	)
	if (disabledWindowsUs.length > 1) {
		const sorted = [...disabledWindowsUs].sort((a, b) => b.us - a.us)
		if (sorted[1] && sorted[1].us > longestDisabled.us * 0.5) {
			notes.push(
				`第二长的关中断窗口是「${sorted[1].name}」${sorted[1].us} µs，与最长只差 ${(longestDisabled.us - sorted[1].us).toFixed(2)} µs——` +
					'说明延迟被**多处**共同决定，只优化最长那一处可能收益有限。',
			)
		}
	}
	if (disabledWindowsUs.length === 0) {
		warnings.push('没有提供任何关中断窗口。若代码里有临界区，这一项不能为空。')
	}

	if (requirementUs !== undefined) {
		const pass = upperBoundUs <= requirementUs
		checks.push({
			name: '最坏响应时间',
			pass,
			detail: `上界 ${upperBoundUs.toFixed(2)} µs vs 要求 ${requirementUs} µs`,
		})
		if (!pass) {
			warnings.push(
				`上界 ${upperBoundUs.toFixed(2)} µs 超过要求的 ${requirementUs} µs。` +
					'先缩短最长关中断段，再考虑降低高优先级 ISR 的执行时间。',
			)
		}
	}

	notes.push(
		'这是**静态上界**。实际延迟要用 GPIO 翻转（进 ISR 拉高、退出拉低）配合逻辑分析仪测，' +
			'或在示波器上同时抓中断源与 GPIO。断点会改变时序，涉及实时性时不要用断点测。',
	)

	return { longestDisabled, isrSum, entryOverheadUs, upperBoundUs, checks, warnings, notes }
}

/**
 * 由主频与周期数换算时间（用于把"12 周期入栈"这类开销折成 µs）。
 *
 * @param {number} cycles - 周期数。
 * @param {number} coreHz - 内核频率（Hz）。
 * @returns {number} 时间（µs）。
 */
export function cyclesToUs(cycles, coreHz) {
	if (!(coreHz > 0)) throw new Error('core_hz 必须为正数')
	return (cycles / coreHz) * 1e6
}
