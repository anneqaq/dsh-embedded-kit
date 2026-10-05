/**
 * 功耗预算与电池寿命估算（纯函数）。
 *
 * 把"各工作模式的电流 × 驻留时间"加权成平均电流，再折算电池寿命 ——
 * 这是低功耗设计里**唯一能提前算清、也必须提前算清**的一笔账。
 *
 * 关键纪律：**本模块不猜任何电流值**。没有实测（或数据手册给出的典型/最大）电流，
 * 就算不出结果；缺哪一项就明确说缺哪一项，不拿一个"看起来合理"的数凑答案。
 *
 * @module dsh-embedded-kit/power
 */

/**
 * 计算功耗预算。
 *
 * 每个模式必须给出电流，以及**时间占比或绝对时长之一**：
 *   - `duty_percent`：占空比（%），所有模式之和应等于 100（可略小于 100，余量按最低功耗模式补）
 *   - `duration_us` / `duration_ms`：一次循环内该模式的绝对时长
 *
 * @param {object} spec - 输入。
 * @param {Array<{name?: string, current_ua: number, duty_percent?: number, duration_us?: number, duration_ms?: number}>} spec.modes
 *   工作模式表。
 * @param {number} [spec.sleep_leak_ua] - 常驻漏电（µA），例如引脚漏电/稳压器静态电流，会叠加进平均电流。
 * @param {number} [spec.battery_mah] - 电池容量（mAh）。给了才折算寿命。
 * @param {number} [spec.battery_derating] - 电池可用系数（0-1），默认 0.8（温度、老化、截止电压导致的可用容量折损）。
 * @param {number} [spec.battery_self_discharge_ua] - 电池自放电（µA），可选。
 * @returns {object} 预算报告。
 * @throws {Error} 输入非法时抛出。
 */
export function computePowerBudget(spec) {
	const {
		modes = [],
		sleep_leak_ua = 0,
		battery_mah = null,
		battery_derating = 0.8,
		battery_self_discharge_ua = 0,
	} = spec

	if (!Array.isArray(modes) || modes.length === 0) throw new Error('modes 不能为空')

	const warnings = []
	const notes = []

	// 判定使用占空比还是绝对时长。
	const useDuty = modes.every((m) => Number.isFinite(m.duty_percent))
	const useDuration = modes.every((m) => Number.isFinite(m.duration_us) || Number.isFinite(m.duration_ms))
	if (!useDuty && !useDuration) {
		throw new Error(
			'每个模式必须一致地提供 duty_percent（占空比 %）或 duration_us/duration_ms（绝对时长）之一，不要混用。',
		)
	}

	/** 每个模式的时长（µs），或 null。 */
	const durations = useDuration
		? modes.map((m) => (Number.isFinite(m.duration_us) ? m.duration_us : m.duration_ms * 1000))
		: null
	const totalDuration = durations ? durations.reduce((a, b) => a + b, 0) : null
	if (durations && totalDuration <= 0) throw new Error('时长之和必须为正数')

	const dutySum = useDuty ? modes.reduce((a, m) => a + m.duty_percent, 0) : null
	if (useDuty && dutySum > 100.0001) {
		warnings.push(`占空比之和为 ${round2(dutySum)}% > 100%，不可能成立。请核对各模式的占比。`)
	} else if (useDuty && dutySum < 99.9999) {
		notes.push(
			`占空比之和为 ${round2(dutySum)}%，不足 100%。计算按各自占比加权（不做归一化），因此剩下的 ${round2(100 - dutySum)}% 被隐含地当作**零电流**处理 —— 若那段其实是某个模式的驻留时间，请补上。`,
		)
	}

	// 平均电流 = Σ(电流 × 时间占比)。
	let avgUa = 0
	const rows = modes.map((m, i) => {
		const name = m.name ?? `mode${i + 1}`
		const share = useDuty ? m.duty_percent / 100 : durations[i] / totalDuration
		const contribution = m.current_ua * share
		avgUa += contribution
		return {
			name,
			currentUa: m.current_ua,
			dutyPercent: useDuty ? round2(m.duty_percent) : round4(share * 100),
			durationUs: durations ? durations[i] : null,
			contributionUa: round4(contribution),
			contributionPercent: null,
		}
	})

	const baseUa = sleep_leak_ua + battery_self_discharge_ua
	avgUa += baseUa

	for (const r of rows) {
		r.contributionPercent = avgUa === 0 ? 0 : round2((r.contributionUa / avgUa) * 100)
	}

	const report = {
		method: useDuty ? 'duty-percent' : 'absolute-duration',
		totalDurationUs: totalDuration,
		nominalAverageUa: round4(avgUa - baseUa),
		baseCurrentUa: baseUa,
		sleepLeakUa: sleep_leak_ua,
		batterySelfDischargeUa: battery_self_discharge_ua,
		averageUa: round4(avgUa),
		averageMa: round4(avgUa / 1000),
		modes: rows,
		batteryLife: null,
		warnings,
		notes,
	}

	if (Number.isFinite(battery_mah) && battery_mah > 0) {
		if (avgUa <= 0) {
			warnings.push('平均电流为 0，电池寿命无穷大 —— 这通常意味着输入有误（缺少某一模式或电流填成了 0）。')
		} else {
			const usableMah = battery_mah * clamp01(battery_derating)
			const hours = (usableMah * 1000) / avgUa
			report.batteryLife = {
				batteryMah: battery_mah,
				derating: clamp01(battery_derating),
				usableMah: round4(usableMah),
				hours: round2(hours),
				days: round2(hours / 24),
				years: round4(hours / 24 / 365),
			}
			if (battery_derating >= 0.99) {
				notes.push('电池可用系数取了接近 1，通常是乐观估计；低温、老化与截止电压一般会吃掉 20% 以上容量。')
			}
		}
	} else {
		notes.push('未提供 battery_mah，因此只算了平均电流、没有折算寿命。')
	}

	// 指出谁最耗电 —— 优化从这里下手最有效。
	const top = [...rows].sort((a, b) => b.contributionUa - a.contributionUa)[0]
	if (top) {
		notes.push(
			`对平均电流贡献最大的模式是「${top.name}」（${top.contributionUa}µA，占 ${top.contributionPercent}%）。低功耗优化应先压这一项，而不是先调最低功耗模式。`,
		)
	}
	if (sleep_leak_ua > 0) {
		const leakShare = avgUa === 0 ? 0 : round2((sleep_leak_ua / avgUa) * 100)
		notes.push(
			`常驻漏电 ${sleep_leak_ua}µA 占平均电流 ${leakShare}%。这类电流**不随占空比下降**，是电池寿命的硬地板 —— 占总电流比例越大，越应该先去查引脚漏电与稳压器静态功耗，而不是继续优化运行时间。`,
		)
	}
	notes.push('所有电流值应来自数据手册的**典型值或实测值**，并注明来源；本模块只做加权计算，不对你给的电流做任何推测或修正。')

	return report
}

/**
 * 把值限制到 [0,1]。
 * @param {number} v - 原值。
 * @returns {number} 结果。
 */
function clamp01(v) {
	if (!Number.isFinite(v)) return 0.8
	return Math.min(1, Math.max(0, v))
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
