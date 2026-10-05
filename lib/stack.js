/**
 * 栈深度：静态上界估算与实测方法。
 *
 * **这个模块只算"上界"，不算"实际用量"。** 原因写在下面的注意事项里：
 * 真实峰值栈用量取决于运行时路径（中断时机、函数指针、库函数内部帧），
 * 静态算不出来的部分必须用填充法或水位寄存器实测。工具的价值在于
 * ① 给出一个可核对的上界，② 把实测步骤说清楚，避免用"看起来够大"的栈开跑。
 *
 * 静态上界的构成：
 *   最坏调用链 = max over chains( Σ 各层帧大小 )
 *   中断叠加   = 最深的 N 层中断帧之和（N = 允许的最大嵌套数）
 *   总计       = 最坏调用链 + 中断叠加
 *
 * 注意：ARM 要求 SP 8 字节对齐，所以小的帧实际会占更多——调用方给帧大小时
 * 请用手册/编译器输出（`-fstack-usage` 产生的 .su 文件）里的实际值，不要用"变量字节数"。
 *
 * @module dsh-embedded-kit/stack
 */

/**
 * 静态上界估算。
 *
 * @param {object} input - 输入。
 * @param {number} input.stackSizeBytes - 栈区大小（字节）。
 * @param {Array<{name:string, framesBytes:number[]}>} input.callChains - 各条调用链及其逐层帧大小。
 * @param {number[]} [input.isrFramesBytes] - 各级中断处理函数的帧大小。
 * @param {number} [input.maxIsrNesting] - 允许的最大中断嵌套层数，默认 1。
 * @param {number} [input.reserveRatio] - 要求保留的余量比例，默认 0.3。
 * @returns {object} 上界、余量与判定。
 */
export function analyzeStack({
	stackSizeBytes,
	callChains,
	isrFramesBytes = [],
	maxIsrNesting = 1,
	reserveRatio = 0.3,
}) {
	if (!(stackSizeBytes > 0)) throw new Error('stack_size_bytes 必须为正数')
	if (!Array.isArray(callChains) || callChains.length === 0) throw new Error('call_chains 至少给一条')

	const checks = []
	const warnings = []
	const notes = []

	const chains = callChains.map((c) => {
		const total = c.framesBytes.reduce((a, b) => a + b, 0)
		return { name: c.name, frames: c.framesBytes.length, bytes: total }
	})
	const worst = chains.reduce((a, b) => (b.bytes > a.bytes ? b : a))

	const nesting = Math.max(0, Math.min(maxIsrNesting, isrFramesBytes.length))
	const isrTotal = [...isrFramesBytes]
		.sort((a, b) => b - a)
		.slice(0, nesting)
		.reduce((a, b) => a + b, 0)

	const totalBytes = worst.bytes + isrTotal
	const reserveBytes = stackSizeBytes * reserveRatio
	const marginBytes = stackSizeBytes - totalBytes
	const fits = marginBytes > 0
	const hasReserve = marginBytes >= reserveBytes
	const utilizationPercent = (totalBytes / stackSizeBytes) * 100

	checks.push({
		name: '上界是否装得下',
		pass: fits,
		detail: `总计 ${totalBytes} B vs 栈区 ${stackSizeBytes} B（占用 ${utilizationPercent.toFixed(1)}%）`,
	})
	checks.push({
		name: `是否保留 ${(reserveRatio * 100).toFixed(0)}% 余量`,
		pass: hasReserve,
		detail: `余量 ${marginBytes} B，要求 ≥ ${Math.round(reserveBytes)} B`,
	})

	if (!fits) {
		warnings.push(
			`静态上界 ${totalBytes} B 已经超过栈区 ${stackSizeBytes} B。` +
				`注意这还只是"你列出的帧"之和——实际只会更大。`,
		)
	} else if (!hasReserve) {
		warnings.push(
			`余量只剩 ${marginBytes} B（${(100 - utilizationPercent).toFixed(1)}%），低于 ${(reserveRatio * 100).toFixed(0)}%。` +
				`未列出的帧（库函数、函数指针、编译器插入）会吃掉这部分。`,
		)
	}

	// 中断叠加的提示
	if (nesting === 0) {
		notes.push('未计入中断叠加（max_isr_nesting=0 或未给中断帧）。中断会叠在最坏调用链之上，不能漏。')
	} else {
		notes.push(
			`中断叠加按最深的 ${nesting} 层算，共 ${isrTotal} B（取最大的 ${nesting} 个帧之和）。` +
				`嵌套层数由**中断优先级**决定，不是由"会不会同时来"决定——复核时看 NVIC 优先级配置。`,
		)
	}
	if (isrFramesBytes.length > nesting) {
		notes.push(`给了 ${isrFramesBytes.length} 个中断帧，但只按 ${nesting} 层叠加；其余视为不会与最坏链同时发生。`)
	}

	notes.push(
		'**哪些帧容易漏**：printf/浮点格式化（几百字节到 1 KB 级）、浮点运算的保存区、' +
			'memcpy/memset 的库实现、函数指针调用（静态分析看不到目标）、递归。' +
			'编译器加 `-fstack-usage` 会为每个函数输出 .su 文件，帧大小应以它为准。',
	)
	notes.push(
		'ARM 要求 SP 8 字节对齐：标称 20 字节的帧实际可能占 24 字节。上面的数只要来自 .su 就已经是按对齐算的。',
	)
	notes.push(
		'**静态上界不等于实测用量。** 必须实测：启动时用魔数（如 0xA5A5A5A5）把整个栈区填满，' +
			'跑完最坏工况后扫描未被覆盖的水印边界，剩余连续魔数长度即真实余量。' +
			'若芯片有栈水位寄存器（如某些 Cortex-M 的 MSPLIM/PSPLIM 或厂商扩展），直接读它更省事。' +
			'中断叠加的那部分尤其要实测——静态只能给个上界。',
	)
	if (Array.isArray(callChains) && callChains.length === 1) {
		notes.push('只给了一条调用链：中断路径可能与它不是同一条，建议把中断里调用的函数链也作为一条链列出来。')
	}

	return {
		chains,
		worstChain: worst,
		isrNesting: nesting,
		isrBytes: isrTotal,
		totalBytes,
		stackSizeBytes,
		marginBytes,
		reserveBytes,
		utilizationPercent,
		checks,
		warnings,
		notes,
	}
}

/**
 * 由填充法的水印地址反算已用字节数。
 *
 * @param {object} input - 输入。
 * @param {number} input.stackStart - 栈区起始地址（含）。
 * @param {number} input.stackSizeBytes - 栈区大小。
 * @param {boolean} [input.growsDown] - 向下生长（Cortex-M 默认 true）。
 * @param {number} input.watermarkAddress - 扫到的"最后一个未被覆盖的魔数"地址。
 * @returns {object} 已用与剩余。
 */
export function usedBytesFromWatermark({ stackStart, stackSizeBytes, growsDown = true, watermarkAddress }) {
	if (!(stackSizeBytes > 0)) throw new Error('stack_size_bytes 必须为正数')
	if (!Number.isInteger(watermarkAddress) || watermarkAddress < stackStart || watermarkAddress >= stackStart + stackSizeBytes) {
		throw new Error('watermark_address 必须落在栈区范围内')
	}
	const used = growsDown
		? stackStart + stackSizeBytes - watermarkAddress
		: watermarkAddress - stackStart
	const notes = [
		'填 0xA5A5A5A5 后扫水印的注意事项：① 必须在**最坏工况跑完之后**扫；' +
			'② DMA 或其他总线主设备往栈区写会污染水印；③ 若编译器把栈区初始化成全 0，' +
			'填充要在 C 运行时初始化之后、进 main 之前做（用启动文件钩子或 NOINIT 段自行填）。',
	]
	return {
		usedBytes: used,
		remainingBytes: stackSizeBytes - used,
		utilizationPercent: (used / stackSizeBytes) * 100,
		notes,
	}
}
