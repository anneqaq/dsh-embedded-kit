/**
 * 调度可行性分析（纯函数）：多定时器分时调度、定时器 + 中断调度。
 *
 * 回答三个在写代码前就该算清的问题：
 *   1. **CPU 占用率**够不够？（不是"看着挺快"，是加权占用率）
 *   2. **节拍碰撞**：多个任务的周期落在同一节拍上时会叠加，最重的那一拍能不能跑完？
 *   3. **抖动**：同一拍上排在后面的任务，最坏要等多久？
 *
 * 两种模式：
 *   - `cooperative-tick`：一个定时器中断负责打节拍，各任务在节拍里轮流执行（前后台 / 时间片轮询）
 *   - `isr-direct`：各任务直接挂在各自的中断里执行（"定时器 + 中断调度"）
 *
 * 本模块只做**静态可计算**的部分（占用率、碰撞、抖动上界）。
 * 真实抖动还受中断延迟、抢占、缓存与总线上锁影响，必须实测 —— 输出里会如实标注。
 *
 * @module dsh-embedded-kit/sched
 */

/** 单次调度/中断进入退出的额外开销上限（µs），仅用于占用率的粗略补正。 */
const DEFAULT_DISPATCH_OVERHEAD_US = 0

/** 节拍碰撞扫描的周期上限（防止 LCM 爆炸）。 */
const MAX_SCAN_TICKS = 200_000

/**
 * 最大公约数。
 * @param {number} a - 正整数。
 * @param {number} b - 正整数。
 * @returns {number} gcd。
 */
function gcd(a, b) {
	while (b !== 0) {
		const t = a % b
		a = b
		b = t
	}
	return a
}

/**
 * 最小公倍数（带上限保护）。
 * @param {number[]} values - 正整数数组。
 * @param {number} cap - 上限。
 * @returns {{lcm: number|null, overflow: boolean}} lcm 与是否超上限。
 */
function lcmList(values, cap) {
	let l = 1
	for (const v of values) {
		if (!Number.isInteger(v) || v <= 0) return { lcm: null, overflow: false }
		l = (l / gcd(l, v)) * v
		if (!Number.isFinite(l) || l > cap) return { lcm: null, overflow: true }
	}
	return { lcm: l, overflow: false }
}

/**
 * 分析一套调度方案。
 *
 * @param {object} spec - 分析输入。
 * @param {number} spec.tick_us - 节拍/中断周期（µs）。cooperative-tick 模式必填；isr-direct 模式下可省。
 * @param {'cooperative-tick'|'isr-direct'} [spec.mode] - 调度模式，默认 cooperative-tick。
 * @param {Array<{name?: string, period_us: number, exec_us: number, deadline_us?: number, priority?: number}>} spec.tasks
 *   任务表。`period_us` 为周期，`exec_us` 为单次执行时间（最坏值）；`priority` 越小越优先，缺省按数组顺序。
 * @param {number} [spec.dispatch_overhead_us] - 每次调度切换的开销（µs），默认 0。
 * @returns {object} 分析报告。
 * @throws {Error} 输入非法时抛出。
 */
export function analyzeSchedule(spec) {
	const { tick_us = null, mode = 'cooperative-tick', tasks = [], dispatch_overhead_us = DEFAULT_DISPATCH_OVERHEAD_US } = spec

	if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks 不能为空')
	if (mode === 'cooperative-tick' && (!Number.isFinite(tick_us) || tick_us <= 0)) {
		throw new Error('cooperative-tick 模式必须提供正的 tick_us（节拍周期）')
	}

	const warnings = []
	const notes = []

	// 归一化成带优先级序的内部任务表。
	const norm = tasks.map((t, i) => {
		const name = t.name ?? `task${i + 1}`
		if (!Number.isFinite(t.period_us) || t.period_us <= 0) throw new Error(`${name}: period_us 必须是正数`)
		if (!Number.isFinite(t.exec_us) || t.exec_us < 0) throw new Error(`${name}: exec_us 必须是非负数`)
		if (t.exec_us > t.period_us) {
			warnings.push(`${name}: 单次执行时间 ${t.exec_us}µs 超过其周期 ${t.period_us}µs —— 该任务永远无法按时完成`)
		}
		return {
			name,
			period_us: t.period_us,
			exec_us: t.exec_us,
			deadline_us: t.deadline_us ?? t.period_us,
			priority: t.priority ?? i,
			order: i,
		}
	})
	// 优先级数值小者先跑；同优先级按声明顺序。
	norm.sort((a, b) => a.priority - b.priority || a.order - b.order)
	norm.forEach((t, i) => {
		t.rank = i
	})

	// ---- 1. CPU 占用率 ----
	// 分派开销按每个任务的执行次数计入（每次执行都要进出一次调度）。
	let utilSum = 0
	const perTask = []
	for (const t of norm) {
		const dispatchesPerSec = 1e6 / t.period_us
		const overheadPerSec = dispatchesPerSec * dispatch_overhead_us
		const util = (t.exec_us * dispatchesPerSec + overheadPerSec) / 1e6
		utilSum += util
		perTask.push({
			name: t.name,
			periodUs: t.period_us,
			execUs: t.exec_us,
			deadlineUs: t.deadline_us,
			priority: t.priority,
			dispatchesPerSec: Math.round(dispatchesPerSec),
			utilization: round4(util),
			utilizationPercent: round2(util * 100),
		})
	}

	const verdict =
		utilSum > 1
			? 'overload'
			: utilSum > 0.85
				? 'risky'
				: utilSum > 0.7
					? 'tight'
					: 'ok'

	if (utilSum > 1) {
		warnings.push(`CPU 占用率 ${round2(utilSum * 100)}% 超过 100%，这套周期/执行时间组合在数学上排不下 —— 必须加长周期、缩短执行时间或降低频率。`)
	} else if (utilSum > 0.7) {
		warnings.push(
			`CPU 占用率 ${round2(utilSum * 100)}% 偏高。嵌入式调度要留出余量给中断、故障路径与日后加功能，建议压到 70% 以下。`,
		)
	}

	// ---- 2. 节拍碰撞（仅节拍驱动模式有意义）----
	let collisions = null
	let resolvability = null
	if (mode === 'cooperative-tick') {
		// 每个任务的周期能否被节拍整除 —— 不能整除意味着实际周期会被量化，产生额外相位误差。
		resolvability = norm.map((t) => {
			const ticksExact = t.period_us / tick_us
			const ticks = Math.round(ticksExact)
			const quantized = ticks * tick_us
			return {
				name: t.name,
				requestedPeriodUs: t.period_us,
				ticksPerPeriodExact: round4(ticksExact),
				ticksPerPeriod: ticks,
				actualPeriodUs: quantized,
				errorUs: quantized - t.period_us,
				errorPercent: t.period_us === 0 ? 0 : round4(((quantized - t.period_us) / t.period_us) * 100),
			}
		})
		for (const r of resolvability) {
			if (!Number.isInteger(r.ticksPerPeriodExact)) {
				notes.push(
					`${r.name}: 周期 ${r.requestedPeriodUs}µs 不是节拍 ${tick_us}µs 的整数倍，实际会被量化到 ${r.actualPeriodUs}µs（偏差 ${r.errorUs}µs）`,
				)
			}
		}

		const tickCounts = resolvability.map((r) => r.ticksPerPeriod)
		const { lcm, overflow } = lcmList(tickCounts, MAX_SCAN_TICKS)
		if (overflow || lcm === null) {
			notes.push(
				`各任务周期的最小公倍数超过 ${MAX_SCAN_TICKS} 个节拍，跳过逐拍碰撞扫描（周期互质时会出现这种情况，本身也是一个提示：碰撞难以预测）。只给出占用率与量化误差。`,
			)
		} else {
			// 逐拍累计负载，找出最重的一拍，并算出排在后面的任务的最坏等待。
			let peakLoadUs = 0
			let peakTick = 0
			const worstWait = new Map(norm.map((t) => [t.name, 0]))
			const loadHistogram = new Map()

			for (let tick = 0; tick < lcm; tick++) {
				// 该拍到期的任务，按优先级排序。
				const due = norm.filter((t, i) => tick % resolvability[i].ticksPerPeriod === 0)
				if (due.length === 0) continue
				let load = 0
				for (const t of due) {
					const wait = load // 排在它前面的任务执行时间之和 = 它的最坏等待
					worstWait.set(t.name, Math.max(worstWait.get(t.name) ?? 0, wait))
					load += t.exec_us + dispatch_overhead_us
				}
				if (load > peakLoadUs) {
					peakLoadUs = load
					peakTick = tick
				}
				const key = due.length
				loadHistogram.set(key, (loadHistogram.get(key) ?? 0) + 1)
			}

			collisions = {
				cycleTicks: lcm,
				cycleUs: lcm * tick_us,
				peakTick,
				peakLoadUs,
				peakTickBudgetUs: tick_us,
				/** 最重的一拍能否在一拍内跑完 —— 这是节拍驱动的生死线。 */
				peakFitsInTick: peakLoadUs <= tick_us,
				worstWaitByTask: norm.map((t) => ({
					name: t.name,
					worstWaitUs: worstWait.get(t.name) ?? 0,
					jitterPercentOfPeriod: t.period_us === 0 ? 0 : round4(((worstWait.get(t.name) ?? 0) / t.period_us) * 100),
				})),
				coincidenceCounts: [...loadHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([dueCount, ticks]) => ({ tasksDueTogether: dueCount, ticks })),
			}

			if (!collisions.peakFitsInTick) {
				warnings.push(
					`最重的节拍（第 ${peakTick} 拍）需要 ${peakLoadUs}µs，但一拍只有 ${tick_us}µs —— **跑不完**。这一拍会顺延到下一拍，造成节拍漂移与抖动累积。要么把碰撞的任务错开相位，要么加长节拍，要么把任务挪到别的定时器。`,
				)
			}
		}
	}

	// ---- 3. 固定优先级的可调度性界（仅为参考）----
	const n = norm.length
	const rmBound = n > 0 ? n * (Math.pow(2, 1 / n) - 1) : 1
	notes.push(
		`任务数 ${n} 时，按周期单调优先级的充分条件（Liu & Layland 界）为占用率不高于 ${round4(rmBound)}（即 ${round2(rmBound * 100)}%）。注意这只是充分条件，不是必要条件：超过它也可能可调度，但必须逐案验证响应时间。`,
	)
	notes.push(
		'以上全部是**静态计算值**。真实抖动还要叠加中断响应延迟、更高优先级中断的抢占、Flash 等待周期与总线仲裁 —— 必须用 GPIO 翻转 + 逻辑分析仪/示波器实测，或读 DWT 周期计数器核对。',
	)
	if (mode === 'isr-direct') {
		notes.push(
			'isr-direct 模式下 exec_us 即中断服务程序本身的耗时。ISR 内耗时过长会阻塞同优先级与低优先级中断，并推迟主循环 —— 若某项超过数十 µs，应考虑改为"ISR 只置标志、主循环处理"的后台结构。',
		)
	}

	return {
		mode,
		tickUs: tick_us,
		dispatchOverheadUs: dispatch_overhead_us,
		taskCount: n,
		totalUtilization: round4(utilSum),
		totalUtilizationPercent: round2(utilSum * 100),
		verdict,
		tasks: perTask,
		tickResolvability: resolvability,
		collisions,
		rateMonotonicBound: round4(rmBound),
		warnings,
		notes,
	}
}

/**
 * 保留两位小数。
 * @param {number} v - 原值。
 * @returns {number} 结果。
 */
function round2(v) {
	return Math.round(v * 100) / 100
}

/**
 * 保留四位小数。
 * @param {number} v - 原值。
 * @returns {number} 结果。
 */
function round4(v) {
	return Math.round(v * 10000) / 10000
}
