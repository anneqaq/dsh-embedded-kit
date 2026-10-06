/**
 * 看门狗超时窗口与喂狗点可行性。
 *
 * 确定性关系（按计数器型看门狗，自由运行或独立看门狗同理）：
 *
 *   超时时间 = (reload + 1) × prescaler / 计数时钟频率
 *
 * 窗口型看门狗还多一个**下限**：喂得太早同样复位。
 * 所以喂狗周期必须落在一个区间里：
 *
 *   窗口下限 < 喂狗周期(最坏) < 超时时间(留余量)
 *
 * 三个最容易忽略的点（本模块会在结果里点出来）：
 *   1. 用的是**最坏**喂狗间隔，不是平均——被最长任务/最长 ISR 撑开的那一次才是判据。
 *   2. 超时时间要覆盖**上电初始化**与**异常恢复**路径，不只是主循环。
 *   3. **在中断里喂狗会掩盖主循环卡死**：中断照常跑、狗照常喂，但业务已经死了。
 *
 * @module dsh-embedded-kit/watchdog
 */

/**
 * 由计数参数算超时时间。
 *
 * @param {object} input - 输入。
 * @param {number} input.clockHz - 看门狗计数时钟（Hz）。
 * @param {number} input.prescaler - 预分频（正整数）。
 * @param {number} input.reload - 重载值（正整数；实际计数为 reload + 1）。
 * @returns {number} 超时时间（µs）。
 */
export function timeoutUs({ clockHz, prescaler, reload }) {
	if (!(clockHz > 0)) throw new Error('clock_hz 必须为正数')
	if (!Number.isInteger(prescaler) || prescaler <= 0) throw new Error('prescaler 必须是正整数')
	if (!Number.isInteger(reload) || reload <= 0) throw new Error('reload 必须是正整数（实际计数为 reload + 1）')
	return (((reload + 1) * prescaler) / clockHz) * 1e6
}

/**
 * 由目标超时时间反算需要的预分频与重载组合。
 *
 * @param {object} input - 输入。
 * @param {number} input.clockHz - 计数时钟（Hz）。
 * @param {number} input.targetTimeoutUs - 目标超时（µs）。
 * @param {number} [input.prescalerMax] - 预分频上限，默认 256。
 * @param {number} [input.reloadMax] - 重载值上限，默认 4095。
 * @returns {object} 精确与近似组合。
 */
export function solveTimeout({ clockHz, targetTimeoutUs, prescalerMax = 256, reloadMax = 4095 }) {
	if (!(clockHz > 0) || !(targetTimeoutUs > 0)) throw new Error('clock_hz 与 target_timeout_us 必须为正数')
	const targetCycles = (targetTimeoutUs / 1e6) * clockHz

	const exact = []
	const near = []
	for (let prescaler = 1; prescaler <= prescalerMax; prescaler += 1) {
		if (!Number.isInteger(targetCycles / prescaler)) continue
		const reload = targetCycles / prescaler - 1
		if (!Number.isInteger(reload) || reload < 1 || reload > reloadMax) continue
		exact.push({ prescaler, reload, timeoutUs: timeoutUs({ clockHz, prescaler, reload }) })
	}
	// 无精确解时给最近的几组
	if (exact.length === 0) {
		for (let prescaler = 1; prescaler <= prescalerMax; prescaler += 1) {
			const reload = Math.round(targetCycles / prescaler) - 1
			if (reload < 1 || reload > reloadMax) continue
			const actual = timeoutUs({ clockHz, prescaler, reload })
			near.push({ prescaler, reload, timeoutUs: actual, errorUs: actual - targetTimeoutUs })
		}
		near.sort((a, b) => Math.abs(a.errorUs) - Math.abs(b.errorUs))
	}

	const notes = [
		`超时时间 = (reload + 1) × prescaler / 计数时钟。目标 ${targetTimeoutUs} µs 对应 ${targetCycles} 个计数。`,
	]
	if (exact.length === 0) {
		notes.push(
			'没有能**精确**命中目标超时的组合（该时钟除不尽）。看门狗超时本来就只需落在合理区间，' +
				'用下面的近似值即可，但要把实际值记进设计文档。',
		)
	} else {
		notes.push(`共 ${exact.length} 组精确命中。优先选 reload 较大、prescaler 较小的组合——分辨率更细。`)
	}

	return { clockHz, targetTimeoutUs, exact, near: near.slice(0, 5), notes }
}

/**
 * 判定喂狗周期是否可行。
 *
 * @param {object} input - 输入。
 * @param {number} input.timeoutUs - 看门狗超时（µs）。
 * @param {number} input.worstFeedIntervalUs - **最坏**（最长）喂狗间隔（µs），由最长任务/ISR 决定，判超时上限用。
 * @param {number} [input.bestFeedIntervalUs] - **最快**（最短）一圈的喂狗间隔（µs），判窗口下限用。
 *   窗口型看门狗"喂太早"违规取决于最短间隔——主循环最快一圈就喂狗的场景。缺省时窗口下限只能部分判定。
 * @param {number} [input.windowLowerUs] - 窗口型看门狗的最早允许喂狗时间（µs）。0 表示无窗口限制。
 * @param {number} [input.marginRatio] - 要求的安全余量比例，默认 0.3。
 * @param {number} [input.initTimeUs] - 上电初始化耗时（µs）；给了就检查超时是否够长。
 * @returns {object} 判定与说明。
 */
export function analyzeWatchdog({
	timeoutUs: tUs,
	worstFeedIntervalUs,
	bestFeedIntervalUs,
	windowLowerUs = 0,
	marginRatio = 0.3,
	initTimeUs,
}) {
	if (!(tUs > 0)) throw new Error('timeout_us 必须为正数')
	if (!(worstFeedIntervalUs > 0)) throw new Error('worst_feed_interval_us 必须为正数（取最坏值）')
	if (bestFeedIntervalUs !== undefined && !(bestFeedIntervalUs > 0)) {
		throw new Error('best_feed_interval_us 若提供必须为正数（取最快一圈的值）')
	}
	if (bestFeedIntervalUs !== undefined && bestFeedIntervalUs > worstFeedIntervalUs) {
		throw new Error('best_feed_interval_us（最快一圈）不能大于 worst_feed_interval_us（最慢一圈）')
	}

	const checks = []
	const warnings = []
	const notes = []

	const upperLimit = tUs * (1 - marginRatio)
	const fitsUpper = worstFeedIntervalUs <= upperLimit
	checks.push({
		name: `喂狗周期是否小于超时的 ${((1 - marginRatio) * 100).toFixed(0)}%`,
		pass: fitsUpper,
		detail: `最坏喂狗 ${worstFeedIntervalUs} µs vs 允许上限 ${upperLimit.toFixed(1)} µs（超时 ${tUs} µs）`,
	})
	if (!fitsUpper) {
		warnings.push(
			`最坏喂狗间隔 ${worstFeedIntervalUs} µs 逼近或超过超时 ${tUs} µs。` +
				'**注意这是最坏值**——正常工况下不会复位，只在负载最高/最长 ISR 时才狗叫，' +
				'这类问题在现场表现为"偶发重启"，很难复现。',
		)
	}

	if (windowLowerUs > 0) {
		// "喂太早"违规取决于**最短**喂狗间隔（最快一圈），不是最长间隔。
		// 最长间隔只够判"必违规"方向：worst ≤ lower 时最短必然也 ≤ lower。
		if (bestFeedIntervalUs !== undefined) {
			const fitsLower = bestFeedIntervalUs > windowLowerUs
			checks.push({
				name: '喂狗是否晚于窗口下限',
				pass: fitsLower,
				detail: `最快一圈喂狗 ${bestFeedIntervalUs} µs vs 窗口下限 ${windowLowerUs} µs（判定依据是最短间隔）`,
			})
			if (!fitsLower) {
				warnings.push(
					`窗口下限 ${windowLowerUs} µs 没有被满足：最快一圈 ${bestFeedIntervalUs} µs 就喂了狗，喂得**太早**同样会复位。` +
						'窗口型看门狗必须同时满足上下限，只在"主循环最短一圈"的路径上喂狗最容易踩这条。',
				)
			}
		} else if (worstFeedIntervalUs <= windowLowerUs) {
			// 最长间隔都早于下限 → 最短必然更早，必违规（保守可判定）
			checks.push({
				name: '喂狗是否晚于窗口下限',
				pass: false,
				detail: `最坏喂狗 ${worstFeedIntervalUs} µs ≤ 窗口下限 ${windowLowerUs} µs —— 最短间隔只会更早，必违规`,
			})
			warnings.push(
				`最坏喂狗间隔 ${worstFeedIntervalUs} µs 都早于窗口下限 ${windowLowerUs} µs：喂得太早，必复位。`,
			)
		} else {
			// worst > lower 且没给 best：无法判定，如实说明而不是拿 worst 硬判
			checks.push({
				name: '喂狗是否晚于窗口下限',
				pass: null,
				detail: `窗口下限 ${windowLowerUs} µs，但未提供 best_feed_interval_us（最快一圈）—— 最坏间隔 ${worstFeedIntervalUs} µs 只能排除"必违规"，不能确认安全`,
			})
			notes.push(
				`窗口下限判定需要 **best_feed_interval_us**（主循环最快一圈的喂狗间隔）：` +
					'喂得太早违规取决于最短间隔。补上这个参数才能给出确定性结论。',
			)
		}
		notes.push(`窗口型：喂狗时刻必须落在 ${windowLowerUs} ~ ${tUs} µs 之间（且离两端都留余量）。`)
	}

	if (initTimeUs !== undefined) {
		const pass = initTimeUs < tUs
		checks.push({
			name: '上电初始化是否来得及',
			pass,
			detail: `初始化 ${initTimeUs} µs vs 超时 ${tUs} µs`,
		})
		if (!pass) {
			warnings.push(
				`上电初始化耗时 ${initTimeUs} µs 超过超时 ${tUs} µs：**必须在这段里提前喂一次狗**，` +
					'否则一切正常但上电就复位。外设长延时初始化（Flash 擦除、传感器上电等）最容易踩。',
			)
		}
	} else {
		notes.push('未给 init_time_us，没有检查上电路径。外设初始化较慢时这一项必须补上。')
	}

	notes.push(
		`最坏喂狗间隔要看**所有路径**：主循环最长一圈、最长 ISR 叠加、以及错误处理路径。` +
			`建议按超时的 ${((1 - marginRatio) * 100).toFixed(0)}% 以内设喂狗点。`,
	)
	notes.push(
		'**不要在中断里喂狗**（除非中断本身就是你要监控的对象）。中断照常跑、狗照常喂，' +
			'但主循环卡死时系统已经失去功能，看门狗却永远不会叫——这是最典型的"看门狗形同虚设"。',
	)
	notes.push(
		'调试时挂断点会暂停整个内核、狗也停不住（独立看门狗尤其）；调试期通常需要先关闭看门狗或延长超时，' +
			'但**发版前一定要恢复**。',
	)

	return {
		timeoutUs: tUs,
		worstFeedIntervalUs,
		bestFeedIntervalUs: bestFeedIntervalUs ?? null,
		windowLowerUs,
		upperLimit,
		slackUs: tUs - worstFeedIntervalUs,
		checks,
		warnings,
		notes,
	}
}
