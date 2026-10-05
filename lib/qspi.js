/**
 * QSPI / OSPI Flash 的 dummy cycle 与读带宽。
 *
 * 模型（这一条是**确定的时序关系**，不是估计）：
 *   控制器在地址阶段之后插入 D 个 dummy 时钟，第一个数据位在第 D 个 dummy 时钟后被采样。
 *   要让数据已经有效，必须满足：
 *
 *       D × tCLK ≥ tAccess      →      D ≥ tAccess × f        （dummy 下限）
 *                               →      f ≤ D / tAccess       （给定 dummy 时的频率上限）
 *
 * **关于 tAccess 必须给哪个量**（这里最容易搞错，说清楚）：
 *   它必须是"**从最后一个地址位的时钟沿，到数据在数据线上有效**"的**总**时间。
 *   不同手册叫法不同：
 *     - 直接给了读取命令的总访问时间（常叫 tACC / tACCESS）→ 直接用；
 *     - 只给了"时钟到输出有效"（tV / tCLQV）→ 那是纯输出级延迟，**不包含命令/地址解码的
 *       内部访问时间**，单独用它会算出偏小的 dummy；
 *     - 只给了一张"频率 → 建议 dummy 数"的表 → **直接用那张表**，不要反推 tAccess。
 *
 * **关键结论**：dummy 数量是频率的函数，不是常数。手册里"读命令需要 N 个 dummy"
 * 那句通常带一个前提频率——换更高的时钟就必须重算，这是最常见的踩坑点。
 *
 * @module dsh-embedded-kit/qspi
 */

/** 读命令的总线宽度模式（命令/地址/数据各自的 lane 数）。 */
export const QSPI_MODES = {
	'1-1-1': { command: 1, address: 1, data: 1, label: '标准 SPI（1-1-1）' },
	'1-1-2': { command: 1, address: 1, data: 2, label: 'Dual Output（1-1-2）' },
	'1-1-4': { command: 1, address: 1, data: 4, label: 'Quad Output（1-1-4）' },
	'1-4-4': { command: 1, address: 4, data: 4, label: 'Quad IO（1-4-4）' },
	'4-4-4': { command: 4, address: 4, data: 4, label: '全 Quad（4-4-4）' },
	'1-8-8': { command: 1, address: 8, data: 8, label: 'Octal（1-8-8）' },
}

/**
 * 该类命令的固定开销时钟数（命令 + 地址，按各自 lane 数折算）。
 *
 * @param {object} input - 输入。
 * @param {string} input.mode - 模式 id。
 * @param {number} [input.commandBits] - 命令位数，默认 8。
 * @param {number} [input.addressBits] - 地址位数，默认 24。
 * @returns {number} 开销时钟数（向上取整）。
 */
export function overheadClocks({ mode, commandBits = 8, addressBits = 24 }) {
	const m = QSPI_MODES[mode]
	if (!m) throw new Error(`未知的 QSPI 模式：${mode}（可用：${Object.keys(QSPI_MODES).join(' / ')}）`)
	return Math.ceil(commandBits / m.command) + Math.ceil(addressBits / m.address)
}

/**
 * 由访问时间与时钟算 dummy 下限。
 *
 * @param {number} accessTimeNs - Flash 的 tV / tACC（ns），来自数据手册。
 * @param {number} fHz - SCK 频率（Hz）。
 * @returns {number} 需要的 dummy 时钟数（向上取整）。
 */
export function dummyCyclesNeeded(accessTimeNs, fHz) {
	return Math.ceil((accessTimeNs * fHz) / 1e9)
}

/**
 * 由 dummy 数与访问时间算频率上限。
 *
 * @param {number} dummyCycles - 控制器配置的 dummy 数。
 * @param {number} accessTimeNs - Flash 的 tV / tACC（ns）。
 * @returns {number} 频率上限（Hz）。
 */
export function maxFrequencyForDummy(dummyCycles, accessTimeNs) {
	return (dummyCycles * 1e9) / accessTimeNs
}

/**
 * 完整分析一次 QSPI 读。
 *
 * @param {object} input - 输入。
 * @param {number} input.fHz - SCK 频率（Hz）。
 * @param {number} input.accessTimeNs - Flash 的 tV / tACC（ns），必须来自数据手册。
 * @param {string} input.mode - 总线宽度模式。
 * @param {number} [input.dummyCycles] - 控制器实际配置的 dummy 数；给了就校验够不够。
 * @param {number} [input.commandBits] - 命令位数，默认 8。
 * @param {number} [input.addressBits] - 地址位数，默认 24。
 * @param {number} [input.bytesPerRead] - 一次读的字节数，默认 64。
 * @param {boolean} [input.continuous] - 是否连续读（XIP / burst）；连续读时开销只付一次。
 * @returns {object} dummy 需求、延迟、带宽与判定。
 */
export function analyzeQspi({
	fHz,
	accessTimeNs,
	mode,
	dummyCycles,
	commandBits = 8,
	addressBits = 24,
	bytesPerRead = 64,
	continuous = false,
}) {
	if (!(fHz > 0)) throw new Error('f_hz 必须为正数')
	if (!(accessTimeNs > 0)) {
		throw new Error('access_time_ns 必须为正数，且必须来自 Flash 数据手册（本工具不给默认值）')
	}
	const m = QSPI_MODES[mode]
	if (!m) throw new Error(`未知的 QSPI 模式：${mode}`)

	const checks = []
	const warnings = []
	const notes = []

	const tclkNs = 1e9 / fHz
	const overhead = overheadClocks({ mode, commandBits, addressBits })
	const needed = dummyCyclesNeeded(accessTimeNs, fHz)
	const maxF = maxFrequencyForDummy(dummyCycles ?? needed, accessTimeNs)

	notes.push(`模式 ${m.label}：命令 ${m.command} lane、地址 ${m.address} lane、数据 ${m.data} lane。`)
	notes.push(`tCLK = 1/${fHz} s = ${tclkNs.toFixed(3)} ns；命令+地址开销 = ${overhead} 个时钟。`)
	notes.push(
		`dummy 下限 = ceil(tV × f) = ceil(${accessTimeNs} ns × ${(fHz / 1e6).toFixed(3)} MHz) = ${needed} 个时钟。` +
			`**dummy 是频率的函数**——手册给的那个数只对某个前提频率成立。`,
	)

	if (dummyCycles !== undefined && dummyCycles !== null) {
		const pass = dummyCycles >= needed
		checks.push({
			name: 'dummy 数是否足够',
			pass,
			detail: `配置 ${dummyCycles} 个，该频率下需要 ${needed} 个（tV=${accessTimeNs} ns @ ${(fHz / 1e6).toFixed(3)} MHz）`,
		})
		if (!pass) {
			warnings.push(
				`dummy 配置偏少：${dummyCycles} < ${needed}。数据在第 ${dummyCycles} 个时钟后被采样，` +
					`而 Flash 要到 ${tclkNs * needed} ns 才给出有效数据 → **读到的是上一位的残留**，` +
					`典型表现是"低频能读、提频后数据错位但不报错"。`,
			)
		}
		checks.push({
			name: '该 dummy 下的频率上限',
			pass: fHz <= maxF,
			detail: `${dummyCycles} 个 dummy 时上限 ${(maxF / 1e6).toFixed(2)} MHz，当前 ${(fHz / 1e6).toFixed(2)} MHz`,
		})
	} else {
		notes.push(`未给实际 dummy 配置；该频率下建议至少 ${needed} 个。`)
		checks.push({
			name: 'dummy 需求',
			pass: true,
			detail: `需要 ≥ ${needed} 个时钟（未提供实际配置，未做判定）`,
		})
	}

	// 随机读延迟与连续读带宽
	const latencyClocks = overhead + (dummyCycles ?? needed)
	const latencyNs = latencyClocks * tclkNs
	const dataClocks = Math.ceil((bytesPerRead * 8) / m.data)
	const firstByteNs = latencyNs
	const perReadNs = continuous ? (dataClocks * tclkNs) : (latencyClocks + dataClocks) * tclkNs
	const effectiveBitsPerSecond = continuous
		? fHz * m.data
		: (bytesPerRead * 8) / (perReadNs / 1e9)

	notes.push(
		`随机读一次 ${bytesPerRead} B：首次数据出现在 ${firstByteNs.toFixed(1)} ns（${latencyClocks} 个时钟），` +
			`整笔 ${perReadNs.toFixed(1)} ns。`,
	)
	notes.push(
		`${continuous ? '连续读（XIP / burst）' : '单次读'}下的等效吞吐 ≈ ${(effectiveBitsPerSecond / 1e6).toFixed(2)} Mbit/s` +
			`（理论峰值 ${((fHz * m.data) / 1e6).toFixed(2)} Mbit/s）。` +
			`${continuous ? '' : '每次读都要重付命令+地址+dummy 的开销，所以小读长的效率很低——这也是 XIP 要开连续模式的原因。'}`,
	)
	if (!continuous && bytesPerRead < 16) {
		warnings.push(
			`单次只读 ${bytesPerRead} B 时开销占比很高（${latencyClocks} 个时钟开销 vs ${dataClocks} 个数据时钟）。` +
				`考虑加大读长或开连续/XIP 模式。`,
		)
	}

	notes.push('这些是时序设计值。Flash 的 tV 有批次与温度差异，量产前应把时钟与 dummy 余量用示波器在高温角复核。')

	return {
		mode,
		modeLabel: m.label,
		fHz,
		tclkNs,
		overheadClocks: overhead,
		dummyNeeded: needed,
		dummyConfigured: dummyCycles ?? null,
		maxFrequencyHz: maxF,
		latencyClocks,
		latencyNs,
		firstByteNs,
		bytesPerRead,
		perReadNs,
		effectiveBitsPerSecond,
		peakBitsPerSecond: fHz * m.data,
		checks,
		warnings,
		notes,
	}
}
