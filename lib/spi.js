/**
 * SPI 时序可行性与 I²S/TDM 时钟可行性。
 *
 * **这里不做"规范公式"的宣称**——SPI 没有像 I²C 那样的统一时序规范，
 * 每个器件的 tSU/tH/tV 都在各自数据手册里。所以本模块只做两件事：
 *   1. 把 CPOL/CPHA 四种模式翻译成"哪个边沿采样、哪个边沿移出"（这一步是确定的定义，
 *      不是估计），避免最常见的一类接线/配置错误。
 *   2. 用**保守的一阶模型**估最高时钟：把数据手册里的 tV(主控输出有效)、
 *      tSU/tH(从器件建立保持)、走线偏斜串成一个不等式。
 *      模型的上界是**估计值**，最终必须用示波器在真实板子上量眼图。
 *
 * I²S 部分只做整除性与比率检查（BCLK/LRCK/MCLK 都是确定的算术关系）。
 *
 * @module dsh-embedded-kit/spi
 */

/** 四种 SPI 模式的边沿语义（CPOL=空闲电平，CPHA=0 在第一个边沿采样）。 */
export const SPI_MODES = {
	0: { cpol: 0, cpha: 0, idleLevel: 'low', sampleEdge: '上升沿（第一个边沿）', shiftEdge: '下降沿（第二个边沿）' },
	1: { cpol: 0, cpha: 1, idleLevel: 'low', sampleEdge: '下降沿（第二个边沿）', shiftEdge: '上升沿（第一个边沿）' },
	2: { cpol: 1, cpha: 0, idleLevel: 'high', sampleEdge: '下降沿（第一个边沿）', shiftEdge: '上升沿（第二个边沿）' },
	3: { cpol: 1, cpha: 1, idleLevel: 'high', sampleEdge: '上升沿（第二个边沿）', shiftEdge: '下降沿（第一个边沿）' },
}

/**
 * 解释一个 SPI 模式。
 *
 * @param {number} mode - 0~3。
 * @returns {object} 该模式的边沿语义。
 */
export function describeSpiMode(mode) {
	const m = SPI_MODES[mode]
	if (!m) throw new Error(`SPI 模式必须是 0~3，收到 ${mode}`)
	return { mode, ...m }
}

/**
 * 一阶模型估 SPI 最高时钟（写方向：主控发、从器件收）。
 *
 * 约束：半个 SCK 周期要装下
 *   主控从时钟边沿到数据有效的时间 tV(master)
 *   + 从器件的建立时间 tSU(slave)
 *   + 走线与探头带来的偏斜 tSkew
 * 于是 fmax = 1 / (2 × (tV + tSU + tSkew))。
 *
 * 同理读方向用从器件的 tV(slave) 与主控的 tSU(master)。
 *
 * @param {object} input - 输入（时间单位统一用 ns）。
 * @param {number} input.masterDataValidNs - 主控输出数据有效时间（写方向）。
 * @param {number} input.slaveSetupNs - 从器件数据建立时间（写方向）。
 * @param {number} [input.slaveDataValidNs] - 从器件输出数据有效时间（读方向）。
 * @param {number} [input.masterSetupNs] - 主控采样建立时间（读方向）。
 * @param {number} [input.skewNs] - 走线偏斜与余量，默认 0（保守起见应给正值）。
 * @returns {object} 两个方向的最高时钟与说明。
 */
export function estimateSpiMaxClock({
	masterDataValidNs,
	slaveSetupNs,
	slaveDataValidNs,
	masterSetupNs,
	skewNs = 0,
}) {
	if (!(masterDataValidNs > 0) || !(slaveSetupNs > 0)) {
		throw new Error('master_data_valid_ns 与 slave_setup_ns 必须为正数（来自手册）')
	}
	const notes = []
	const writeBudgetNs = masterDataValidNs + slaveSetupNs + skewNs
	const writeMaxHz = 1e9 / (2 * writeBudgetNs)

	/** @type {number|null} */
	let readMaxHz = null
	if (slaveDataValidNs !== undefined && masterSetupNs !== undefined) {
		if (slaveDataValidNs > 0 && masterSetupNs > 0) {
			const readBudgetNs = slaveDataValidNs + masterSetupNs + skewNs
			readMaxHz = 1e9 / (2 * readBudgetNs)
		}
	} else {
		notes.push('未同时给出从器件 tV 与主控 tSU，未估读方向的最高时钟。')
	}

	notes.push(
		'这是一阶模型：把 tV/tSU/偏斜串成半个周期的预算。真实上界还受驱动能力、' +
			'线长、器件内部采样窗口影响，**必须用示波器看 SCK 与数据的实际关系**。',
	)

	return {
		writeBudgetNs,
		writeMaxHz,
		readBudgetNs: readMaxHz === null ? null : slaveDataValidNs + masterSetupNs + skewNs,
		readMaxHz,
		bindingMaxHz: readMaxHz === null ? writeMaxHz : Math.min(writeMaxHz, readMaxHz),
		notes,
	}
}

/**
 * SPI 传输带宽预算。
 *
 * @param {object} input - 输入。
 * @param {number} input.sckHz - 实际 SCK 频率（Hz）。
 * @param {number} input.bitsPerFrame - 每帧位数（含地址/命令/数据）。
 * @param {number} [input.gapNs] - 帧间空隙（片选拉高、软件开销）。
 * @returns {object} 帧率与等效吞吐。
 */
export function spiBandwidth({ sckHz, bitsPerFrame, gapNs = 0 }) {
	if (!(sckHz > 0) || !(bitsPerFrame > 0)) throw new Error('sck_hz 与 bits_per_frame 必须为正数')
	const frameTimeNs = (bitsPerFrame / sckHz) * 1e9 + gapNs
	const framesPerSecond = 1e9 / frameTimeNs
	return {
		frameTimeNs,
		framesPerSecond,
		effectiveBitsPerSecond: framesPerSecond * bitsPerFrame,
		linkEfficiencyPercent: (bitsPerFrame / sckHz) * 1e9 / frameTimeNs * 100,
	}
}

/** 常见的 MCLK / fs 比率。 */
export const I2S_MCLK_RATIOS = [128, 192, 256, 384, 512, 768]

/**
 * I²S / TDM 时钟可行性。
 *
 * 确定关系（不是估计）：
 *   LRCK = fs
 *   BCLK = fs × 每帧位数 × 通道数
 *   每帧位数 = 每槽位数 × 每帧槽数（I²S 立体声即 2 槽；TDM 为实际槽数）
 *   MCLK = fs × 比率
 *
 * @param {object} input - 输入。
 * @param {number} input.sampleRateHz - 采样率（Hz）。
 * @param {number} input.slotBits - 每槽位数（如 16 / 24 / 32）。
 * @param {number} [input.slots] - 每帧槽数，默认 2（立体声 I²S）。
 * @param {number} [input.mclkHz] - 实际可提供的 MCLK（Hz）。给了就检查整除。
 * @param {number} [input.inputClockHz] - 主时钟源（Hz）。给了就算能否分频出 MCLK/BCLK。
 * @param {number[]} [input.mclkRatios] - 要检查的比率，默认常用值。
 * @returns {object} 各时钟与整除性检查。
 */
export function analyzeI2s({
	sampleRateHz,
	slotBits,
	slots = 2,
	mclkHz,
	inputClockHz,
	mclkRatios = I2S_MCLK_RATIOS,
}) {
	if (!(sampleRateHz > 0) || !(slotBits > 0) || !(slots > 0)) {
		throw new Error('sample_rate_hz / slot_bits / slots 必须为正数')
	}
	const bitsPerFrame = slotBits * slots
	const bclkHz = sampleRateHz * bitsPerFrame
	const checks = []
	const warnings = []
	const notes = []

	notes.push(`帧结构：${slots} 槽 × ${slotBits} 位 = 每帧 ${bitsPerFrame} 位，LRCK = fs = ${sampleRateHz} Hz。`)
	notes.push(`BCLK = fs × 每帧位数 = ${sampleRateHz} × ${bitsPerFrame} = ${bclkHz} Hz（确定关系）。`)

	// MCLK 比率表
	const ratios = []
	for (const r of mclkRatios) {
		ratios.push({ ratio: r, mclkHz: sampleRateHz * r })
	}

	// 给了实际 MCLK：检查它是不是整数倍 fs
	if (mclkHz !== undefined && mclkHz !== null) {
		const ratio = mclkHz / sampleRateHz
		const exact = Number.isInteger(ratio)
		checks.push({
			name: 'MCLK 与 fs 的比率',
			pass: exact,
			detail: `MCLK ${mclkHz} / fs ${sampleRateHz} = ${ratio}${exact ? '（整数）' : '（不是整数 —— 会产生周期性的采样点抖动）'}`,
		})
		if (!exact) {
			warnings.push(
				`MCLK 不是 fs 的整数倍（比值 ${ratio}）。I²S 允许，但会引入周期性的采样点漂移，` +
					`对高保真场合应换成能整除的时钟。`,
			)
		}
		if (mclkHz < bclkHz) {
			warnings.push(`MCLK ${mclkHz} Hz 低于 BCLK ${bclkHz} Hz：MCLK 至少要等于 BCLK。`)
		}
	}

	// 给了主时钟源：检查 MCLK / BCLK 的可分频性
	if (inputClockHz !== undefined && inputClockHz !== null) {
		const bc = inputClockHz / bclkHz
		const bcExact = Number.isInteger(bc)
		checks.push({
			name: '主时钟能否分出 BCLK',
			pass: bcExact && bc >= 2,
			detail: `主时钟 ${inputClockHz} / BCLK ${bclkHz} = ${bc}${bcExact ? '' : '（不是整数）'}`,
		})
		if (!bcExact || bc < 2) {
			warnings.push(
				`主时钟 ${inputClockHz} Hz 无法整数分频出 BCLK ${bclkHz} Hz（比值 ${bc}）。` +
					`换一个主时钟，或改采样率/槽位数。`,
			)
		}
		for (const r of mclkRatios) {
			const target = sampleRateHz * r
			const div = inputClockHz / target
			if (Number.isInteger(div) && div >= 1) {
				notes.push(`MCLK = ${r}×fs = ${target} Hz 可以由 ${inputClockHz} Hz 整除得到（分频 ${div}）。`)
			}
		}
	}

	return {
		sampleRateHz,
		slotBits,
		slots,
		bitsPerFrame,
		lrckHz: sampleRateHz,
		bclkHz,
		mclkHz: mclkHz ?? null,
		mclkRatio: mclkHz ? mclkHz / sampleRateHz : null,
		mclkTable: ratios,
		checks,
		warnings,
		notes,
	}
}
