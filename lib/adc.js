/**
 * ADC 输入负载与采样功耗分析（纯函数）。
 *
 * 补齐一块常被电量计算漏掉的开销：**ADC 每次采样都要把采样保持电容充到输入电压**，
 * 这个电荷从信号源取走，折算成平均电流就是
 *
 *     I_avg = f_sample × C_sample × V_ref × 通道数
 *
 * 它**随采样率线性增长**，而且不在"引脚漏电"里、也不在"运行电流"里 ——
 * 不显式加上就会低估电池消耗；采样率高的场合（如音频、高频传感器）这一项相当可观。
 *
 * 同时回答一个更要紧的工程问题：**外部源阻抗会不会让采样来不及建立**。
 * 采样窗口内充不到 ½ LSB，读数就是错的 —— 这比功耗问题更致命。
 *
 * 所需参数（C_sample / R_ADC / I_LK / 采样窗口）**都必须从数据手册取**，
 * 本模块不提供任何默认猜测值；缺哪项就说明缺哪项、相应结论不给。
 *
 * @module dsh-embedded-kit/adc
 */

/** 采样网络建立到 ½ LSB 所需的 τ 倍数 = (n+1)·ln2。 */
function tauMultiplier(bits) {
	return (bits + 1) * Math.LN2
}

/**
 * 分析一个 ADC 输入的负载与采样功耗。
 *
 * @param {object} spec - 输入。
 * @param {number} spec.v_ref - 参考电压（V）。**必需**。
 * @param {number} spec.resolution_bits - 分辨率（位），如 12 / 16。**必需**。
 * @param {number} spec.sample_rate_hz - 该输入的采样率（Hz）。**必需**。
 * @param {number} [spec.c_sample_pf] - 采样保持电容 C_ADC（pF），**数据手册给出**。
 * @param {number} [spec.r_adc_ohm] - 内部采样开关电阻 R_ADC（Ω），**数据手册给出**。
 * @param {number} [spec.source_r_ohm] - 外部信号源阻抗（Ω）。
 * @param {number} [spec.sample_time_ns] - 采样窗口时长（ns），**数据手册或你的配置**。
 * @param {number} [spec.channels] - 参与采样的通道数，默认 1。
 * @param {number} [spec.input_leakage_ua] - 每通道输入漏电流 I_LK（µA），**数据手册给出**。
 * @param {Array<{name?: string, r_top_ohm: number, r_bottom_ohm: number}>} [spec.dividers]
 *   常接在电源上的分压网络（如电池电压检测），贡献常态电流 V/(R_top+R_bottom)。
 * @param {Array<{name?: string, r_ohm: number}>} [spec.grounded_loads]
 *   常接到地的电阻性负载（如 LED 限流、偏置），贡献常态电流 V/R。
 * @returns {object} 分析报告。
 * @throws {Error} 必填项缺失或非法时抛出。
 */
export function analyzeAdcLoad(spec) {
	const {
		v_ref,
		resolution_bits,
		sample_rate_hz,
		c_sample_pf = null,
		r_adc_ohm = null,
		source_r_ohm = null,
		sample_time_ns = null,
		channels = 1,
		input_leakage_ua = null,
		dividers = [],
		grounded_loads = [],
	} = spec

	if (!Number.isFinite(v_ref) || v_ref <= 0) throw new Error('v_ref 必须是正数（V）')
	if (!Number.isInteger(resolution_bits) || resolution_bits < 4 || resolution_bits > 32) {
		throw new Error('resolution_bits 必须是 4-32 的整数')
	}
	if (!Number.isFinite(sample_rate_hz) || sample_rate_hz <= 0) throw new Error('sample_rate_hz 必须是正数')
	if (!Number.isInteger(channels) || channels < 1) throw new Error('channels 必须是 ≥1 的整数')

	const notes = []
	const warnings = []
	/** 需要从数据手册补的项 → 受影响的结论。 */
	const pending = []

	// ---- 1. 采样网络的电荷转移电流 ----
	let chargeCurrentUa = null
	if (Number.isFinite(c_sample_pf) && c_sample_pf > 0) {
		// I = f × C × V_ref × 通道数（最坏情况：每次采样都跨越满量程）
		const amps = (sample_rate_hz * (c_sample_pf * 1e-12) * v_ref) * channels
		chargeCurrentUa = round4(amps * 1e6)
		notes.push(
			`采样电荷转移电流 = ${sample_rate_hz} Hz × ${c_sample_pf} pF × ${v_ref} V × ${channels} 通道 = ${chargeCurrentUa} µA。` +
				'这是**最坏情况**（每次采样都跨越满量程）；输入信号变化幅度小时实际更小。它随采样率线性增长，采样率翻倍这一项也翻倍。',
		)
		notes.push('这一项只在实际采样期间产生，应计入**正在采样的那个模式**的电流，而不是休眠电流。')
	} else {
		pending.push('c_sample_pf（采样保持电容，查数据手册）')
	}

	// ---- 2. 建立时间与源阻抗上限 ----
	let settling = null
	if (Number.isFinite(c_sample_pf) && c_sample_pf > 0 && Number.isFinite(r_adc_ohm) && r_adc_ohm >= 0) {
		const mult = tauMultiplier(resolution_bits)
		const cSampleF = c_sample_pf * 1e-12
		settling = { tauMultiplier: round4(mult) }

		if (Number.isFinite(sample_time_ns) && sample_time_ns > 0) {
			const sampleTimeSec = sample_time_ns * 1e-9
			// R_source_max 满足 t_sample ≥ (n+1)·ln2·C·(R_source + R_ADC)
			const rTotalMax = sampleTimeSec / (mult * cSampleF)
			const rSourceMax = rTotalMax - r_adc_ohm
			settling.sampleTimeNs = sample_time_ns
			settling.maxTotalROhm = round2(rTotalMax)
			settling.maxSourceROhm = round2(rSourceMax)
			settling.internalROhm = r_adc_ohm

			if (Number.isFinite(source_r_ohm)) {
				const rTotal = source_r_ohm + r_adc_ohm
				const tauSec = rTotal * cSampleF
				const requiredSec = tauSec * mult
				settling.sourceROhm = source_r_ohm
				settling.totalROhm = rTotal
				settling.tauNs = round4(tauSec * 1e9)
				settling.requiredSettleNs = round4(requiredSec * 1e9)
				settling.marginNs = round4(sample_time_ns - requiredSec * 1e9)
				settling.sourceWithinLimit = rSourceMax > 0 && source_r_ohm <= rSourceMax
				// 最坏情况误差（以 LSB 计）：e^(-t/τ) × 2^n
				const errLsb = Math.exp(-sampleTimeSec / tauSec) * Math.pow(2, resolution_bits)
				settling.worstCaseErrorLsb = round4(errLsb)

				if (!settling.sourceWithinLimit) {
					warnings.push(
						`源阻抗 ${source_r_ohm} Ω 超过上限 ${settling.maxSourceROhm} Ω —— ${sample_time_ns} ns 的采样窗口内充不到 ½ LSB。` +
							`**读数会偏低且非线性**（这比功耗问题更致命）。修法：加长采样时间、降源阻抗（加缓冲/减小分压电阻）、或降低采样率。`,
					)
				} else {
					notes.push(
						`源阻抗检查通过：${source_r_ohm} Ω ≤ 上限 ${settling.maxSourceROhm} Ω，` +
							`所需建立时间 ${settling.requiredSettleNs} ns ≤ 采样窗口 ${sample_time_ns} ns（余量 ${settling.marginNs} ns），最坏误差约 ${settling.worstCaseErrorLsb} LSB。`,
					)
				}
			} else {
				pending.push('source_r_ohm（外部源阻抗）—— 未给则无法判断建立是否足够')
			}
		} else {
			pending.push('sample_time_ns（采样窗口时长）—— 未给则无法判断建立是否足够')
		}
	} else {
		if (!Number.isFinite(r_adc_ohm)) pending.push('r_adc_ohm（内部采样开关电阻，查数据手册）')
	}

	// ---- 3. 常态静态负载 ----
	const staticRows = []
	let staticUa = 0
	for (const [i, d] of dividers.entries()) {
		const name = d.name ?? `divider${i + 1}`
		const rSum = (d.r_top_ohm ?? 0) + (d.r_bottom_ohm ?? 0)
		if (!(rSum > 0)) continue
		const ua = (v_ref / rSum) * 1e6
		staticUa += ua
		staticRows.push({ name, kind: 'divider', description: `${d.r_top_ohm} Ω + ${d.r_bottom_ohm} Ω 分压`, currentUa: round4(ua) })
	}
	for (const [i, g] of grounded_loads.entries()) {
		const name = g.name ?? `load${i + 1}`
		if (!(g.r_ohm > 0)) continue
		const ua = (v_ref / g.r_ohm) * 1e6
		staticUa += ua
		staticRows.push({ name, kind: 'grounded-load', description: `${g.r_ohm} Ω 到 GND`, currentUa: round4(ua) })
	}
	if (Number.isFinite(input_leakage_ua) && input_leakage_ua > 0) {
		const ua = input_leakage_ua * channels
		staticUa += ua
		staticRows.push({
			name: 'ADC 输入漏电流',
			kind: 'input-leakage',
			description: `${input_leakage_ua} µA × ${channels} 通道`,
			currentUa: round4(ua),
		})
	} else {
		pending.push('input_leakage_ua（ADC 输入漏电流 I_LK，查数据手册）—— 未使用通道也会有这部分')
	}
	if (staticRows.length > 0) {
		notes.push(
			`常态静态负载合计 ${round4(staticUa)} µA。这部分**不随采样率变化、休眠时也一直在**，应计入 power_budget 的 sleep_leak_ua。`,
		)
	}

	// ---- 4. 汇总 ----
	const adcRelatedTotal = (chargeCurrentUa ?? 0) + staticUa
	const totalAdcRelatedUa = adcRelatedTotal > 0 ? round4(adcRelatedTotal) : null

	if (pending.length > 0) {
		notes.push(`以下参数未提供，相关结论未给出（均应取自数据手册，不猜）：${pending.join('；')}。`)
	}
	notes.push(
		'提醒：数据手册的 C_ADC / R_ADC / I_LK 通常给典型值或范围，且**随温度变化**。' +
			'做最坏情况设计要对这些量取最不利端，并留余量；实测验证请在信号源与地之间串采样电阻看压差，或直接测整机电流随采样率的变化。',
	)

	return {
		vRef: v_ref,
		resolutionBits: resolution_bits,
		sampleRateHz: sample_rate_hz,
		channels,
		chargeCurrentUa,
		staticLoads: staticRows,
		staticLoadUa: staticRows.length > 0 ? round4(staticUa) : null,
		/** 采样动态 + 常态静态的合计（可直接作为该模式的附加电流）。 */
		totalAdcRelatedUa,
		settling,
		pending,
		notes,
		warnings,
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
