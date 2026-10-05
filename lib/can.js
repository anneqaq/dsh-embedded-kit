/**
 * CAN / CAN-FD 位时序计算。
 *
 * **公式出处：Bosch / CiA《The Configuration of the CAN Bit Timing》(boschcia99)。**
 * 该文献给出振荡器容差的两条约束，须同时满足、取小值：
 *
 *   I:  df ≤ min(Phase_Seg1, Phase_Seg2) / (2 × (13 × bit_time − Phase_Seg2))
 *   II: df ≤ SJW / (20 × bit_time)
 *
 * 其中 bit_time 以 tq 为单位。文献同时给出经典最优组合
 * Prop_Seg=1、Phase_Seg1=Phase_Seg2=SJW=4（bit_time=10 tq）→ df=1.587%，
 * 本模块的自测把这一组当基准向量钉住。
 *
 * 结构关系：
 *   bit_time = Sync_Seg(固定 1 tq) + Prop_Seg + Phase_Seg1 + Phase_Seg2
 *   tq       = BRP(功能值) / fCAN_CLK
 *   采样点   = (Sync_Seg + Prop_Seg + Phase_Seg1) / bit_time
 *   寄存器编程值 = 功能值 − 1（TSEG1/TSEG2/SJW/BRP 都是这个偏移）
 *
 * 这里算的是**设计值**；总线实际位宽、边沿抖动与误帧率必须用示波器/分析仪实测。
 *
 * @module dsh-embedded-kit/can
 */

/** Sync_Seg 恒为 1 tq。 */
export const SYNC_SEG_TQ = 1

/** 经典 CAN 的 SJW 功能值上限（寄存器 2 bit）。 */
export const SJW_MAX_CLASSIC = 4

/**
 * 由位时序分段算振荡器容差。
 *
 * @param {object} input - 分段（均为 tq 功能值）。
 * @param {number} input.propSeg - 传播段。
 * @param {number} input.phaseSeg1 - 相位缓冲段 1。
 * @param {number} input.phaseSeg2 - 相位缓冲段 2。
 * @param {number} input.sjw - 同步跳转宽度。
 * @returns {{nbt:number, df1:number, df2:number, df:number}} 总位时间与两条约束。
 */
export function oscillatorTolerance({ propSeg, phaseSeg1, phaseSeg2, sjw }) {
	const nbt = SYNC_SEG_TQ + propSeg + phaseSeg1 + phaseSeg2
	const df1 = Math.min(phaseSeg1, phaseSeg2) / (2 * (13 * nbt - phaseSeg2))
	const df2 = sjw / (20 * nbt)
	return { nbt, df1, df2, df: Math.min(df1, df2) }
}

/**
 * 采样点位置（0~1）。
 *
 * @param {number} propSeg - 传播段。
 * @param {number} phaseSeg1 - 相位缓冲段 1。
 * @param {number} nbt - 总位时间（tq）。
 * @returns {number} 采样点比例。
 */
export function samplePoint({ propSeg, phaseSeg1, nbt }) {
	return (SYNC_SEG_TQ + propSeg + phaseSeg1) / nbt
}

/**
 * 传播段能覆盖的最大单向延迟。
 *
 * 传播段要同时容纳"本节点 → 对端"与"对端 → 本节点"两段往返，
 * 再加收发器与控制器两侧的输入输出延迟，所以单向允许值只有 prop_seg 的一半。
 *
 * @param {number} propSeg - 传播段（tq）。
 * @param {number} tqS - 一时间量（秒）。
 * @returns {number} 最大单向延迟（秒）。
 */
export function maxOneWayDelayS(propSeg, tqS) {
	return (propSeg * tqS) / 2
}

/**
 * 枚举能精确命中目标波特率的位时序组合。
 *
 * @param {object} input - 输入。
 * @param {number} input.fclk - CAN 控制器输入时钟（Hz）。
 * @param {number} input.bitrate - 目标波特率（bit/s）。
 * @param {number} [input.samplePointTarget] - 期望采样点（比例），默认 0.875（CAN 惯例）。
 * @param {number} [input.samplePointMin] - 采样点下限（比例），默认 0.75。
 * @param {number} [input.samplePointMax] - 采样点上限（比例），默认 0.9。
 * @param {number} [input.nbtMin] - 总位时间下限（tq），默认 8。
 * @param {number} [input.nbtMax] - 总位时间上限（tq），默认 25。
 * @param {number} [input.sjwMax] - SJW 功能值上限，默认 4（经典 CAN）。
 * @param {number} [input.propSegMax] - 传播段上限（tq），默认 nbt − 3。
 * @returns {{candidates:Array<object>, exact:boolean, warnings:string[], notes:string[]}}
 */
export function enumerateBitTiming({
	fclk,
	bitrate,
	samplePointTarget = 0.875,
	samplePointMin = 0.75,
	samplePointMax = 0.9,
	nbtMin = 8,
	nbtMax = 25,
	sjwMax = SJW_MAX_CLASSIC,
	propSegMax,
}) {
	if (!(fclk > 0)) throw new Error('fclk 必须为正数')
	if (!(bitrate > 0)) throw new Error('bitrate 必须为正数')

	const warnings = []
	const notes = []
	const candidates = []

	// 目标：fclk / (BRP × NBT) == bitrate  →  BRP × NBT == fclk / bitrate
	const product = fclk / bitrate
	if (!Number.isInteger(product)) {
		warnings.push(
			`该时钟无法精确得到 ${bitrate} bit/s：fclk/bitrate = ${product} 不是整数。` +
				`换一个能整除的时钟，或接受下面的近似组合（有波特率误差）。`,
		)
	}

	const productRounded = Math.round(product)
	const brpCandidates = []
	for (let brp = 1; brp <= productRounded; brp += 1) {
		if (productRounded % brp === 0) brpCandidates.push(brp)
	}
	// 不可整除时，允许 BRP 向上取整，误差在结果里如实给出
	if (brpCandidates.length === 0) {
		for (let brp = 1; brp <= Math.ceil(product) + 2; brp += 1) brpCandidates.push(brp)
	}

	for (const brp of brpCandidates) {
		const nbtFloat = fclk / (brp * bitrate)
		const nbt = Math.round(nbtFloat)
		if (nbt < nbtMin || nbt > nbtMax) continue
		const actualBitrate = fclk / (brp * nbt)
		const bitrateErrorPpm = Math.round(((actualBitrate - bitrate) / bitrate) * 1e6)
		const tqS = brp / fclk

		// 分段穷举：sync 固定 1，剩下 nbt-1 分给 prop/phase1/phase2
		for (let propSeg = 1; propSeg <= (propSegMax ?? nbt - 3); propSeg += 1) {
			for (let phaseSeg1 = 1; phaseSeg1 <= nbt - propSeg - 2; phaseSeg1 += 1) {
				const phaseSeg2 = nbt - SYNC_SEG_TQ - propSeg - phaseSeg1
				if (phaseSeg2 < 1) continue
				const sp = samplePoint({ propSeg, phaseSeg1, nbt })
				if (sp < samplePointMin || sp > samplePointMax) continue

				const maxSjw = Math.min(sjwMax, phaseSeg1, phaseSeg2)
				for (let sjw = 1; sjw <= maxSjw; sjw += 1) {
					// 文献给出的协议要求：Phase_Seg1 + Phase_Seg2 > 2 × SJW
					if (phaseSeg1 + phaseSeg2 <= 2 * sjw) continue
					const tol = oscillatorTolerance({ propSeg, phaseSeg1, phaseSeg2, sjw })
					candidates.push({
						brp,
						tqNs: tqS * 1e9,
						nbt,
						propSeg,
						phaseSeg1,
						phaseSeg2,
						sjw,
						actualBitrate,
						bitrateErrorPpm,
						samplePointPercent: sp * 100,
						samplePointDistance: Math.abs(sp - samplePointTarget),
						oscTolerancePercent: tol.df * 100,
						oscToleranceDf1Percent: tol.df1 * 100,
						oscToleranceDf2Percent: tol.df2 * 100,
						maxOneWayDelayUs: maxOneWayDelayS(propSeg, tqS) * 1e6,
						registers: {
							// 编程值 = 功能值 − 1
							BRP: brp - 1,
							TSEG1: propSeg + phaseSeg1 - 1,
							TSEG2: phaseSeg2 - 1,
							SJW: sjw - 1,
						},
					})
				}
			}
		}
	}

	// 排序优先级：
	//   1. 波特率误差（越小越好）—— 命中不了目标波特率，别的都白搭
	//   2. 采样点离惯例值 87.5% 的远近 —— CAN 的实际惯例，不能只按容差最大选
	//   3. 振荡器容差（越大越好）
	//   4. 传播段（越长越好）—— 同样采样点下留更多总线延迟余量
	candidates.sort(
		(a, b) =>
			Math.abs(a.bitrateErrorPpm) - Math.abs(b.bitrateErrorPpm) ||
			a.samplePointDistance - b.samplePointDistance ||
			b.oscTolerancePercent - a.oscTolerancePercent ||
			b.propSeg - a.propSeg,
	)

	notes.push(
		'寄存器字段是**功能值 − 1**（文献明确：编程范围 [0..n-1] 对应功能值 [1..n]）。' +
			'Freescale/NXP 命名里 TSEG1 = Prop_Seg + Phase_Seg1。',
	)
	notes.push(
		'振荡器容差取 df1 与 df2 的较小值；df1 由相位缓冲段决定，df2 由 SJW 决定。' +
			'两者接近说明资源利用均衡。',
	)
	notes.push(
		`排序以采样点接近 ${(samplePointTarget * 100).toFixed(1)}% 为第二优先级（CAN 惯例值），` +
			`不是单纯取容差最大——容差最大的往往落在偏低的采样点上。需要精确 87.5% 时，` +
			`从候选里挑 sample_point_percent 最接近的一条并核对它的容差是否够用。`,
	)

	return {
		candidates,
		exact: Number.isInteger(product),
		fclk,
		bitrate,
		targetProductBrpNbt: product,
		warnings,
		notes,
	}
}

/**
 * 便利封装：给定时钟与波特率，返回最优组合与容差。
 *
 * @param {object} input - 同 enumerateBitTiming。
 * @returns {object} 最优组合 + 候选数量。
 */
export function bestBitTiming(input) {
	const r = enumerateBitTiming(input)
	return {
		...r,
		best: r.candidates.length > 0 ? r.candidates[0] : null,
	}
}
