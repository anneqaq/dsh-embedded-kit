/**
 * 固件镜像校验：Intel HEX 解析与校验、Cortex-M 向量表校验、镜像范围 CRC。
 *
 * 这一块全是**确定的格式与约束**，没有估计成分：
 *
 * Intel HEX（每条记录）：
 *   :LLAAAATT[DD...]CC
 *   LL=字节数  AAAA=16 位地址  TT=记录类型  00 数据 / 01 结束 / 02 扩展段 / 04 扩展线性 / 05 起始线性
 *   CC=校验和，取"从 LL 到最后一个数据字节之和"的二进制补码 → 加上 CC 后整条记录按字节求和 ≡ 0 (mod 256)
 *
 * Cortex-M 向量表（前两个字）：
 *   word[0] = 初始栈指针（MSP）→ 必须落在 RAM 内，且按 8 字节对齐（ARM 要求 SP 8 字节对齐）
 *   word[1] = 复位向量 → bit0 必须是 1（Thumb 态），去掉 bit0 后的目标地址必须落在 Flash/ROM 内
 *   向量表本身：VTOR 要求按"异常数量向上取到 2 的幂"对齐，最小 128 字节；
 *   应用不在 Flash 起始处时，VTOR 必须相应搬移，否则中断会跳到错误位置。
 *
 * @module dsh-embedded-kit/image
 */

/** Intel HEX 记录类型。 */
export const HEX_RECORD_TYPES = {
	0x00: 'data',
	0x01: 'eof',
	0x02: 'extended-segment-address',
	0x03: 'start-segment-address',
	0x04: 'extended-linear-address',
	0x05: 'start-linear-address',
}

/**
 * 解析并校验 Intel HEX 文本。
 *
 * @param {string} text - 文件全文。
 * @returns {object} 记录统计、地址范围、错误与警告。
 */
export function parseIntelHex(text) {
	const errors = []
	const warnings = []
	const records = []
	/** @type {Map<number, number>} 地址 → 数据字节 */
	const bytes = new Map()
	/** @type {Array<{start:number,end:number}>} */
	const spans = []
	let extendedLinear = 0
	let extendedSegment = 0
	let eofSeen = false
	let startLinearAddress = null
	let lineNo = 0

	for (const rawLine of text.split(/\r?\n/)) {
		lineNo += 1
		const line = rawLine.trim()
		if (line.length === 0) continue
		if (!line.startsWith(':')) {
			// 有些工具链会在 HEX 前后写注释，只警告不判错
			warnings.push(`第 ${lineNo} 行不是以 ':' 开头，已跳过：${line.slice(0, 40)}`)
			continue
		}
		const hex = line.slice(1)
		if (hex.length % 2 !== 0) {
			errors.push(`第 ${lineNo} 行十六进制字符数为奇数：${line.slice(0, 40)}`)
			continue
		}
		if (!/^[0-9A-Fa-f]*$/.test(hex)) {
			errors.push(`第 ${lineNo} 行含非十六进制字符：${line.slice(0, 40)}`)
			continue
		}

		const body = []
		for (let i = 0; i < hex.length; i += 2) body.push(parseInt(hex.slice(i, i + 2), 16))

		if (body.length < 5) {
			errors.push(`第 ${lineNo} 行长度不足 5 字节（至少需要 LL/AAAA/TT/CC）：${line}`)
			continue
		}

		const sum = body.reduce((a, b) => a + b, 0) & 0xff
		if (sum !== 0) {
			errors.push(
				`第 ${lineNo} 行校验和错误：按字节求和 = 0x${sum.toString(16).padStart(2, '0')}，应为 0x00。` +
					`该记录已损坏，镜像不可信。`,
			)
			continue
		}

		const count = body[0]
		const address = (body[1] << 8) | body[2]
		const type = body[3]
		const data = body.slice(4, 4 + count)
		if (body.length !== 5 + count) {
			// 记录体比 "LL+AAAA+TT+数据+CC" 长或短都不可信（短的情况 data.length 也会不足，一并在这里报）
			errors.push(
				`第 ${lineNo} 行长度与 LL 不一致：LL=0x${count.toString(16)} 要求记录体 ${5 + count} 字节，实际 ${body.length} 字节`,
			)
			continue
		}
		if (data.length !== count) {
			errors.push(`第 ${lineNo} 行 LL=0x${count.toString(16)} 但实际只有 ${data.length} 个数据字节`)
			continue
		}
		// 特殊记录类型的数据长度是格式规定的，不匹配说明文件损坏（此前会静默按 undefined 参与运算）
		if ((type === 0x02 || type === 0x04) && count !== 2) {
			errors.push(`第 ${lineNo} 行记录类型 0x0${type} 要求恰好 2 个数据字节，实际 ${count} 个`)
			continue
		}
		if (type === 0x05 && count !== 4) {
			errors.push(`第 ${lineNo} 行记录类型 0x05 要求恰好 4 个数据字节，实际 ${count} 个`)
			continue
		}
		if (type === 0x01 && count !== 0) {
			errors.push(`第 ${lineNo} 行 EOF 记录不应携带数据，实际 ${count} 字节`)
			continue
		}

		if (eofSeen) {
			warnings.push(`第 ${lineNo} 行出现在 EOF 记录之后，多数烧录器会忽略它`)
		}

		records.push({ line: lineNo, type, address, count })

		switch (type) {
			case 0x00: {
				const base = extendedLinear + extendedSegment
				const start = base + address
				for (let i = 0; i < data.length; i += 1) {
					const addr = start + i
					if (bytes.has(addr)) {
						errors.push(`第 ${lineNo} 行的地址 0x${addr.toString(16)} 与前面的数据重叠`)
					}
					bytes.set(addr, data[i])
				}
				spans.push({ start, end: start + data.length })
				break
			}
			case 0x01:
				eofSeen = true
				break
			case 0x02:
				extendedSegment = ((data[0] << 8) | data[1]) * 16
				extendedLinear = 0
				break
			case 0x04:
				extendedLinear = ((data[0] << 8) | data[1]) * 0x10000
				extendedSegment = 0
				break
			case 0x05:
				startLinearAddress = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0
				break
			case 0x03:
				break
			default:
				errors.push(`第 ${lineNo} 行的记录类型 0x${type.toString(16)} 未定义`)
		}
	}

	if (!eofSeen) errors.push('缺少 EOF 记录（:00000001FF）。多数烧录器会拒绝这个文件。')

	// 地址空洞检测：在最小与最大地址之间找出未覆盖的区间
	const warningsGaps = []
	if (bytes.size > 0) {
		spans.sort((a, b) => a.start - b.start)
		let cursor = spans[0].start
		for (const s of spans) {
			if (s.start > cursor) warningsGaps.push({ start: cursor, end: s.start })
			if (s.end > cursor) cursor = s.end
		}
		if (warningsGaps.length > 0) {
			warnings.push(
				`镜像内有 ${warningsGaps.length} 处地址空洞（未写入的区间），烧录后可能是 0xFF：` +
					warningsGaps
						.slice(0, 5)
						.map((g) => `0x${g.start.toString(16)}~0x${(g.end - 1).toString(16)}`)
						.join('、') +
					(warningsGaps.length > 5 ? ' 等' : ''),
			)
		}
	}

	// 最小/最大地址：写入时逐个比较。不要用 Math.min(...keys) —— spread 参数受
	// 调用栈上限约束（约 10^5），128KB 以上固件的 HEX 会直接 RangeError。
	let minAddress = null
	let maxAddress = null
	for (const addr of bytes.keys()) {
		if (minAddress === null || addr < minAddress) minAddress = addr
		if (maxAddress === null || addr > maxAddress) maxAddress = addr
	}

	return {
		records,
		recordCount: records.length,
		dataBytes: bytes.size,
		minAddress,
		maxAddress,
		eofSeen,
		startLinearAddress,
		gaps: warningsGaps,
		bytes,
		errors,
		warnings,
	}
}

/**
 * 校验 Cortex-M 向量表。
 *
 * @param {object} input - 输入。
 * @param {number} input.initialSp - 向量表第 0 个字（初始 MSP）。
 * @param {number} input.resetVector - 向量表第 1 个字（复位向量）。
 * @param {{start:number,end:number}} input.flashRange - Flash/ROM 地址范围（含 start，不含 end）。
 * @param {{start:number,end:number}} input.ramRange - RAM 地址范围。
 * @param {number} [input.vtor] - 向量表实际地址（应用不在 Flash 起始处时应等于应用起始地址）。
 * @param {number} [input.exceptionCount] - 异常数量（含系统异常），用于算 VTOR 对齐要求。
 * @returns {object} 判定与说明。
 */
export function checkVectors({ initialSp, resetVector, flashRange, ramRange, vtor, exceptionCount }) {
	const checks = []
	const warnings = []
	const notes = []

	// MSP：落在 RAM 内 + 8 字节对齐
	const spInRam = initialSp >= ramRange.start && initialSp < ramRange.end
	const spAligned = initialSp % 8 === 0
	checks.push({
		name: '初始栈指针落在 RAM 内',
		pass: spInRam,
		detail: `MSP = 0x${initialSp.toString(16).padStart(8, '0')}，RAM 范围 0x${ramRange.start.toString(16)}~0x${(ramRange.end - 1).toString(16)}`,
	})
	checks.push({
		name: '初始栈指针 8 字节对齐',
		pass: spAligned,
		detail: `MSP = 0x${initialSp.toString(16)}，${spAligned ? '对齐' : '未对齐'}（ARM 要求 SP 8 字节对齐）`,
	})
	if (!spInRam) {
		warnings.push('初始 MSP 不在 RAM 内：上电后第一条压栈就会写坏存储器，表现为"启动即 HardFault"。')
	}
	if (!spAligned) {
		warnings.push('初始 MSP 未 8 字节对齐：会触发用法异常（UNALIGNED），或只在用到浮点/64 位访问时才炸。')
	}

	// 复位向量：bit0 必须是 1，目标落在 Flash 内
	const thumbBit = (resetVector & 1) === 1
	const target = resetVector & ~1
	const targetInFlash = target >= flashRange.start && target < flashRange.end
	checks.push({
		name: '复位向量 Thumb 位为 1',
		pass: thumbBit,
		detail: `0x${resetVector.toString(16).padStart(8, '0')} 的 bit0 = ${resetVector & 1}`,
	})
	checks.push({
		name: '复位目标落在 Flash 内',
		pass: targetInFlash,
		detail: `去掉 bit0 后 = 0x${target.toString(16)}，Flash 范围 0x${flashRange.start.toString(16)}~0x${(flashRange.end - 1).toString(16)}`,
	})
	if (!thumbBit) {
		warnings.push(
			'复位向量 bit0 为 0：内核会进入 ARM 态。Cortex-M 只支持 Thumb，' +
				'结果是锁死（lockup）——看起来像"完全没启动"。',
		)
	}
	if (!targetInFlash) {
		warnings.push('复位向量目标不在 Flash 内：可能是链接地址与烧录地址不一致，或取错了偏移。')
	}

	// VTOR 对齐
	if (vtor !== undefined) {
		const minAlign = Math.max(128, nextPowerOfTwo((exceptionCount ?? 16) * 4))
		const aligned = vtor % minAlign === 0
		checks.push({
			name: 'VTOR 对齐',
			pass: aligned,
			detail: `VTOR = 0x${vtor.toString(16)}，要求按 ${minAlign} 字节对齐（异常数 ${exceptionCount ?? 16} → 向上取 2 的幂，最小 128）`,
		})
		if (!aligned) {
			warnings.push(
				`VTOR 0x${vtor.toString(16)} 未按 ${minAlign} 字节对齐：` +
					`中断会被取到错误的向量。带 Bootloader 时这一项最容易漏。`,
			)
		}
		if (vtor !== flashRange.start) {
			notes.push(
				`VTOR(0x${vtor.toString(16)}) 不等于 Flash 起始(0x${flashRange.start.toString(16)})：` +
					`说明是带 Bootloader 的应用。**跳转前必须把 VTOR 改到应用起始处**，否则中断向量仍指向 Bootloader。`,
			)
		}
	}

	notes.push(
		'向量表里这两个字是硬件上电后**第一件读的东西**，先于任何 C 代码。' +
			'所以它们的错误不会进 main，也不会留下 C 层日志，只表现为"不启动"或"启动即挂"。',
	)

	return { checks, warnings, notes }
}

/**
 * 向上取到 2 的幂。
 *
 * @param {number} n - 输入。
 * @returns {number} 不小于 n 的最小 2 的幂。
 */
export function nextPowerOfTwo(n) {
	let p = 1
	while (p < n) p *= 2
	return p
}

/**
 * 把解析出的字节映射转成连续缓冲区（空洞填 0xFF，与擦除态一致）。
 *
 * @param {Map<number, number>} bytes - 地址 → 字节。
 * @param {number} start - 起始地址（含）。
 * @param {number} end - 结束地址（不含）。
 * @returns {Uint8Array} 缓冲区。
 */
export function toBuffer(bytes, start, end) {
	const buf = new Uint8Array(Math.max(0, end - start)).fill(0xff)
	for (let a = start; a < end; a += 1) {
		const v = bytes.get(a)
		if (v !== undefined) buf[a - start] = v
	}
	return buf
}
