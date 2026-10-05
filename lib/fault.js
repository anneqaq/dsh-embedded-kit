/**
 * Cortex-M 异常分诊（纯函数）。
 *
 * 把故障栈里那堆十六进制变成**可执行的结论**：这是哪个栈、是精确还是非精确故障、
 * 根因属于哪一类、以及 **PC 落在哪个函数第几字节**。
 *
 * 最后一条是关键 —— 单看 `PC = 0x08001a3c` 毫无意义，翻译成
 * `Reset_Handler + 0x2c`（即 xx.c 里那个函数的偏移）才能定位。
 * 符号表由 {@link parseElf} 提供，因此这里只做算术查表，不重新解析 ELF。
 *
 * 覆盖的常见成因：除零、非对齐访问、非法状态（跳到非 Thumb 地址）、
 * 无效 PC、访问未映射地址、栈溢出、缺协处理器、以及"升级到 HardFault"的原因链。
 *
 * @module dsh-embedded-kit/fault
 */

/** CFSR 可配置故障状态位的含义（0xE000ED28）。 */
const CFSR_BITS = [
	{ bit: 0, name: 'IACCVIOL', kind: 'MMFSR', desc: '取指时违反访问权限（执行了不可执行的地址，常见于跳转到数据区）' },
	{ bit: 1, name: 'DACCVIOL', kind: 'MMFSR', desc: '取数时违反访问权限（MPU 拒绝，或写了只读区）' },
	{ bit: 3, name: 'MUNSTKERR', kind: 'MMFSR', desc: '异常返回时出栈失败（栈指针被破坏）' },
	{ bit: 4, name: 'MSTKERR', kind: 'MMFSR', desc: '异常入栈失败 —— **栈溢出/栈指针非法**的典型标志' },
	{ bit: 5, name: 'MLSPERR', kind: 'MMFSR', desc: '浮点惰性保存时出错（仅带 FPU 的 M4F/M7）' },
	{ bit: 7, name: 'MMARVALID', kind: 'MMFSR', desc: 'MMFAR 中的地址有效' },
	{ bit: 8, name: 'IBUSERR', kind: 'BFSR', desc: '取指总线错误（跳到了无存储器区域）' },
	{ bit: 9, name: 'PRECISERR', kind: 'BFSR', desc: '精确总线错误 —— **BFAR 给出出错的地址，最好定位**' },
	{ bit: 10, name: 'IMPRECISERR', kind: 'BFSR', desc: '非精确总线错误（写缓冲延迟上报，PC 可能已后移；根因在这条指令之前）' },
	{ bit: 11, name: 'UNSTKERR', kind: 'BFSR', desc: '异常返回时总线错误' },
	{ bit: 12, name: 'STKERR', kind: 'BFSR', desc: '异常入栈时总线错误' },
	{ bit: 13, name: 'LSPERR', kind: 'BFSR', desc: '浮点惰性保存总线错误' },
	{ bit: 15, name: 'BFARVALID', kind: 'BFSR', desc: 'BFAR 中的地址有效' },
	{ bit: 16, name: 'UNDEFINSTR', kind: 'UFSR', desc: '未定义指令 —— 常见于 PC 跑飞到了数据区' },
	{ bit: 17, name: 'INVSTATE', kind: 'UFSR', desc: '非法状态 —— **跳到了非 Thumb 地址**（函数指针丢了最低位，或调用了数据）' },
	{ bit: 18, name: 'INVPC', kind: 'UFSR', desc: '非法 PC（EXC_RETURN 或跳转目标非法）' },
	{ bit: 19, name: 'NOCP', kind: 'UFSR', desc: '缺协处理器 —— 在没有 FPU 的核上执行了浮点指令' },
	{ bit: 24, name: 'UNALIGNED', kind: 'UFSR', desc: '非对齐访问 —— Cortex-M0/M0+ 对此**直接硬错误**' },
	{ bit: 25, name: 'DIVBYZERO', kind: 'UFSR', desc: '除零（仅当 SCB->CCR 打开了除零陷阱）' },
]

/** HFSR 的位含义（0xE000ED2C）。 */
const HFSR_BITS = [
	{ bit: 1, name: 'VECTTBL', desc: '取向量表时总线错误（向量表地址配置错、或表被擦掉）' },
	{ bit: 30, name: 'FORCED', desc: '**被升级的故障** —— 本来是 Usage/Bus/Memory 故障，因为未被使能或优先级不足被拉成 HardFault。此时 CFSR 才是根因所在' },
	{ bit: 31, name: 'DEBUGEVT', desc: '调试事件导致的硬故障' },
]

/**
 * Cortex-M 的 6 个**标准 EXC_RETURN 值**。
 *
 * 刻意用「精确值查表」而不是位运算推断：标准帧（0xF1/F9/FD）与扩展帧（0xE1/E9/ED）
 * 之间差的正是 bit4，而我对该位的极性**没有把握**（不同文档表述容易读反）。
 * 遇到这种"记不准"的地方，正确做法是按**文档给出的标准值集合**匹配，
 * 匹配不上就说"不是标准 EXC_RETURN"，**不去猜**。
 *
 * 扩展帧（带 FP）比标准帧多压 104 字节（S0–S15 + FPSCR + 对齐字），
 * 取栈帧时若少算这个偏移，读到的全是错位数据 —— 所以这个判断必须准。
 */
const EXC_RETURN_TABLE = new Map([
	[0xfffffff1, { mode: 'Handler', stack: 'MSP', fpuFrame: false }],
	[0xfffffff9, { mode: 'Thread', stack: 'MSP', fpuFrame: false }],
	[0xfffffffd, { mode: 'Thread', stack: 'PSP', fpuFrame: false }],
	[0xffffffe1, { mode: 'Handler', stack: 'MSP', fpuFrame: true }],
	[0xffffffe9, { mode: 'Thread', stack: 'MSP', fpuFrame: true }],
	[0xffffffed, { mode: 'Thread', stack: 'PSP', fpuFrame: true }],
])

/**
 * 解析 EXC_RETURN（按标准值表精确匹配）。
 *
 * @param {number} value - EXC_RETURN（故障时的 LR 值）。
 * @returns {{valid: boolean, mode: string|null, stack: string|null, fpuFrame: boolean, raw: string}} 解析结果。
 */
export function decodeExcReturn(value) {
	const v = value >>> 0
	const hit = EXC_RETURN_TABLE.get(v)
	return {
		valid: hit !== undefined,
		mode: hit?.mode ?? null,
		stack: hit?.stack ?? null,
		fpuFrame: hit?.fpuFrame ?? false,
		raw: `0x${v.toString(16).toUpperCase().padStart(8, '0')}`,
	}
}

/**
 * 解一个 32 位故障状态寄存器为位清单。
 * @param {number|null} value - 寄存器值。
 * @param {Array<{bit: number, name: string, kind?: string, desc: string}>} table - 位表。
 * @param {number} baseBit - 位偏移（CFSR 的 BFSR/UFSR 需要）。
 * @returns {Array<{name: string, kind: string|null, bit: number, desc: string}>} 置位的位。
 */
function decodeStatus(value, table, baseBit = 0) {
	if (!Number.isInteger(value)) return []
	const bits = []
	for (const b of table) {
		if (((value >>> b.bit) & 1) === 1) {
			bits.push({ name: b.name, kind: b.kind ?? null, bit: b.bit, desc: b.desc })
		}
	}
	void baseBit
	return bits
}

/**
 * 在符号表里查一个地址。
 *
 * 取**地址范围覆盖该地址**的最合适符号：优先精确落在 `[addr, addr+size)` 内且 size 最小的
 * （更具体的那个）；找不到就用 `addr` 不超过目标的**最大地址**符号，报偏移量。
 *
 * @param {Array<{name: string, size: number, addr: number, kind: string}>} symbols - 符号表。
 * @param {number} address - 目标地址（Thumb 位会被自动清掉）。
 * @returns {{name: string, symbolAddr: number, offset: number, size: number, kind: string, exact: boolean}|null}
 *   命中信息，或 null。
 */
export function lookupSymbol(symbols, address) {
	if (!Array.isArray(symbols) || symbols.length === 0) return null
	// Thumb 地址最低位是 1，符号地址是偶地址 —— 查表前必须清掉。
	const target = (address & ~1) >>> 0

	let best = null
	for (const s of symbols) {
		const start = s.addr >>> 0
		const size = Number.isInteger(s.size) && s.size > 0 ? s.size : 0
		if (size > 0 && target >= start && target < start + size) {
			// 落在某个符号体内：取范围最小的那个（最具体）。
			if (best === null || size < best.size) {
				best = { ...s, symbolAddr: start, offset: target - start, exact: true }
			}
		}
	}
	if (best !== null) return { name: best.name, symbolAddr: best.symbolAddr, offset: best.offset, size: best.size, kind: best.kind, exact: true }

	// 回退：取不超过目标的最大地址符号（多为只带起始地址、size 为 0 的符号）。
	let nearest = null
	for (const s of symbols) {
		const start = s.addr >>> 0
		if (start <= target && (nearest === null || start > nearest.symbolAddr)) {
			nearest = { ...s, symbolAddr: start, offset: target - start, exact: false }
		}
	}
	if (nearest === null) return null
	return { name: nearest.name, symbolAddr: nearest.symbolAddr, offset: nearest.offset, size: nearest.size ?? 0, kind: nearest.kind ?? 'unknown', exact: false }
}

/**
 * 诊断一次 Cortex-M 异常。
 *
 * @param {object} spec - 输入。
 * @param {object} [spec.frame] - 故障栈帧。字段为 `r0..r3`、`r12`、`lr`、`pc`、`xpsr`（十六进制数值）。
 * @param {number} [spec.exc_return] - 故障时的 LR 值（EXC_RETURN）；不给则用 `frame.lr` 推断。
 * @param {number} [spec.cfsr] - 可配置故障状态寄存器（0xE000ED28）。
 * @param {number} [spec.hfsr] - 硬故障状态寄存器（0xE000ED2C）。
 * @param {number} [spec.mmfar] - 存储管理故障地址（0xE000ED34）。
 * @param {number} [spec.bfar] - 总线故障地址（0xE000ED38）。
 * @param {Array<{name: string, size: number, addr: number, kind: string}>} [spec.symbols] - 符号表（来自 `parseElf`）。
 * @param {Array<{name: string, start: number, end: number, kind?: string}>} [spec.memoryRegions]
 *   存储区域，用于判断地址是否合法（如 FLASH / RAM）。
 * @returns {object} 分诊报告。
 */
export function decodeFault(spec) {
	const { frame = {}, exc_return, cfsr = null, hfsr = null, mmfar = null, bfar = null, symbols = [], memoryRegions = [] } = spec

	const notes = []
	const warnings = []
	/** @type {Array<{kind: string, cause: string, confidence: string, evidence: string}>} */
	const hypotheses = []

	// ---- 1. 栈与模式 ----
	const excValue = Number.isInteger(exc_return) ? exc_return >>> 0 : Number.isInteger(frame.lr) ? frame.lr >>> 0 : null
	const exc = excValue === null ? null : decodeExcReturn(excValue)
	const isExcReturn = exc !== null && exc.valid
	if (excValue !== null && !isExcReturn) {
		notes.push(
			`栈帧里的 LR = 0x${excValue.toString(16).toUpperCase()} 不是合法的 EXC_RETURN（应为 0xFFFFFFF1/F9/FD 或带 FPU 位 0xE1/E9/ED）—— 这说明**栈帧可能已被破坏**，或你给的不是异常入栈后的帧。`,
		)
	}
	if (exc !== null && exc.fpuFrame) {
		notes.push('EXC_RETURN 的 bit4 = 1：异常帧包含**浮点扩展上下文**（S0–S15 + FPSCR + 对齐字），比基本帧多 104 字节。取栈帧时若少算了这些偏移，读到的就是错位数据。')
	}

	// ---- 2. 状态寄存器解码 ----
	const cfsrBits = decodeStatus(cfsr, CFSR_BITS)
	const hfsrBits = decodeStatus(hfsr, HFSR_BITS)
	const hasStatus = cfsr !== null || hfsr !== null

	if (hfsrBits.some((b) => b.name === 'FORCED')) {
		notes.push('HFSR.FORCED = 1：这是一次**被升级的故障**（Usage/Bus/Memory 故障因未使能或优先级不足被拉成 HardFault）。根因看 CFSR，不要只看 HardFault 本身。')
	}

	// ---- 3. PC / LR 符号化 ----
	const pc = Number.isInteger(frame.pc) ? frame.pc >>> 0 : null
	const stackedLr = Number.isInteger(frame.lr) ? frame.lr >>> 0 : null
	const pcSymbol = pc === null ? null : lookupSymbol(symbols, pc)
	const lrValue = stackedLr !== null && !isExcReturn ? stackedLr : null
	const lrSymbol = lrValue === null ? null : lookupSymbol(symbols, lrValue)

	/**
	 * 把地址渲染成「符号 + 偏移」。
	 * @param {number} address - 地址。
	 * @param {object|null} hit - 符号命中。
	 * @returns {string} 文本。
	 */
	function renderAddr(address, hit) {
		const hex = `0x${address.toString(16).toUpperCase().padStart(8, '0')}`
		if (hit === null) return symbols.length === 0 ? `${hex}（未提供符号表，无法定位）` : `${hex}（符号表中无匹配，可能是跳转到了非法地址）`
		if (hit.exact) return `${hex} → ${hit.name} + 0x${hit.offset.toString(16)}`
		return `${hex} → ${hit.name} 之后 + 0x${hit.offset.toString(16)}（该符号无尺寸信息，归属为**推断**）`
	}

	// ---- 4. 地址合法性 ----
	/**
	 * 查地址落在哪个区域。
	 * @param {number} address - 地址。
	 * @returns {object|null} 区域。
	 */
	function regionOf(address) {
		for (const r of memoryRegions) {
			if (address >= r.start && address < r.end) return r
		}
		return null
	}

	if (pc !== null) {
		if (pc === 0 || pc >= 0xfffffff0) {
			hypotheses.push({
				kind: 'invalid-pc',
				cause: 'PC 是 0 或接近 0xFFFFFFF0 —— 跳到了未初始化/全 1 的函数指针，或对空指针调用了函数',
				confidence: '高',
				evidence: `PC = 0x${pc.toString(16).toUpperCase()}`,
			})
		}
		if (memoryRegions.length > 0) {
			const reg = regionOf(pc & ~1)
			if (reg === null) {
				hypotheses.push({
					kind: 'pc-outside-known-regions',
					cause: 'PC 不落在任何已知存储区域内 —— 程序跑飞（缓冲区溢出改写返回地址、函数指针被写坏）',
					confidence: '高',
					evidence: `PC 不在 ${memoryRegions.map((r) => r.name).join('/')} 范围内`,
				})
			} else if (reg.kind === 'ram') {
				hypotheses.push({
					kind: 'pc-in-ram',
					cause: 'PC 落在**RAM** 内 —— 正常代码不应在 RAM 执行（除非有意做 RAM 函数）。通常是栈/缓冲溢出覆盖了返回地址',
					confidence: '高',
					evidence: `PC ∈ ${reg.name}`,
				})
			}
		}
	}

	// ---- 5. xPSR 的 T 位 ----
	const xpsr = Number.isInteger(frame.xpsr) ? frame.xpsr >>> 0 : null
	if (xpsr !== null && ((xpsr >>> 24) & 1) === 0) {
		hypotheses.push({
			kind: 'thumb-bit-clear',
			cause: 'xPSR.T = 0（Thumb 位被清）—— 典型的 **INVSTATE**：用 `bx`/函数指针跳到了偶地址。Cortex-M 只跑 Thumb，函数指针必须保留最低位 1',
			confidence: '高',
			evidence: `xPSR = 0x${xpsr.toString(16).toUpperCase()}，bit24 = 0`,
		})
	}

	// ---- 6. 由状态位推根因 ----
	/**
	 * 登记一条由状态位推出的根因。
	 * @param {string} kind - 类别。
	 * @param {string} cause - 成因。
	 * @param {string} confidence - 置信度。
	 * @param {string} evidence - 证据。
	 */
	function addFromBit(kind, cause, confidence, evidence) {
		hypotheses.push({ kind, cause, confidence, evidence })
	}

	for (const b of cfsrBits) {
		switch (b.name) {
			case 'DIVBYZERO':
				addFromBit('div-by-zero', '整数除零（SCB->CCR 打开了 DIV_0_TRP）', '高', 'CFSR.UFSR.DIVBYZERO')
				break
			case 'UNALIGNED':
				addFromBit('unaligned', '非对齐访问。Cortex-M0/M0+ 一律硬错误；M3/M4 对多字节访问通常容忍，但访问设备内存仍会出错。检查 `uint8_t*` 转 `uint32_t*` 的解引用与 `__packed` 结构体', '高', 'CFSR.UFSR.UNALIGNED')
				break
			case 'INVSTATE':
				addFromBit('invstate', '非法状态：跳到非 Thumb 地址', '高', 'CFSR.UFSR.INVSTATE')
				break
			case 'UNDEFINSTR':
				addFromBit('undef-instr', '未定义指令 —— PC 跑飞到了数据区，或工具链/内核指令集不匹配', '高', 'CFSR.UFSR.UNDEFINSTR')
				break
			case 'NOCP':
				addFromBit('nocp', '执行了浮点指令但没有 FPU（或 FPU 未使能）。确认编译选项的目标核带 FPU', '高', 'CFSR.UFSR.NOCP')
				break
			case 'MSTKERR':
			case 'STKERR':
				addFromBit('stack-overflow', '**异常入栈失败 —— 首要怀疑栈溢出或栈指针被写成非法值**。检查最大栈深（栈区魔数扫描/RTOS 水位 API）与栈指针初值', '高', `CFSR.${b.kind}.${b.name}`)
				break
			case 'PRECISERR':
				addFromBit('precise-bus', `精确总线错误，出错地址见 BFAR${Number.isInteger(bfar) ? `（0x${bfar.toString(16).toUpperCase()}）` : '（本次未提供 BFAR）'}：访问了未映射或未使能时钟的外设`, Number.isInteger(bfar) ? '高' : '中', 'CFSR.BFSR.PRECISERR')
				break
			case 'IMPRECISERR':
				addFromBit('imprecise-bus', '**非精确**总线错误：写缓冲延迟上报，PC 指向的指令**不是**根因所在（根因在它之前若干条）。排查要往前看，或打开写缓冲禁用/加内存屏障', '中', 'CFSR.BFSR.IMPRECISERR')
				break
			case 'IACCVIOL':
				addFromBit('exec-violation', '取指违反访问权限 —— 执行了不可执行的地址（MPU 区或数据区）', '高', 'CFSR.MMFSR.IACCVIOL')
				break
			case 'DACCVIOL':
				addFromBit('data-violation', '取数违反访问权限 —— 写了只读区，或触到 MPU 保护边界', '高', 'CFSR.MMFSR.DACCVIOL')
				break
			default:
				break
		}
	}

	if (!hasStatus && hypotheses.length === 0 && pc === null) {
		warnings.push(
			'既没有给状态寄存器（cfsr/hfsr），也没有给栈帧寄存器 —— 无法分诊。至少需要故障栈里的 PC/LR/xPSR；若能同时读 CFSR/HFSR 与 MMFAR/BFAR，结论会精确得多。',
		)
	}
	if (!isExcReturn && hasStatus) {
		notes.push('未提供合法的 EXC_RETURN，因此**无法判断用的是 MSP 还是 PSP** —— 若故障发生在任务上下文（FreeRTOS），栈帧在 PSP 上，取错栈会读到无意义数据。')
	}
	if (symbols.length === 0) {
		warnings.push('未提供符号表，PC/LR 只能给原始地址，无法定位到函数。传入 ELF 文件即可自动带上符号表。')
	}

	// ---- 7. 置信度汇总 ----
	const bestConfidence = hypotheses.some((h) => h.confidence === '高')
		? '高'
		: hypotheses.length > 0
			? '中'
			: null

	notes.push(
		'**读取故障栈的前提**：Cortex-M 在进入异常时会把 r0–r3、r12、LR、PC、xPSR 依次压栈（带 FPU 且用了浮点时还会多压 104 字节）。因此你看到的那 8 个（或 26 个）值就是当时的现场。若是 FreeRTOS 任务里出错，帧在 **PSP** 上；读 MSP 会读到内核栈，是空的或不相干的。',
	)
	notes.push(
		'本工具只依据**你给的寄存器值与符号表**做推断，不读取芯片。要拿到 CFSR/HFSR/MMFAR/BFAR 与栈帧，需要在 HardFault 处理函数里先保存现场再打印 —— 那是 `fault-diagnosis` 技能里的流程。',
	)

	return {
		stack: exc === null ? null : exc.stack,
		mode: exc === null ? null : exc.mode,
		excReturn: exc === null ? null : exc.raw,
		fpuFrame: exc === null ? false : exc.fpuFrame,
		excReturnValid: isExcReturn,
		pc: pc === null ? null : { value: `0x${pc.toString(16).toUpperCase().padStart(8, '0')}`, symbol: pcSymbol, rendered: renderAddr(pc, pcSymbol) },
		lr: lrValue === null ? null : { value: `0x${lrValue.toString(16).toUpperCase().padStart(8, '0')}`, symbol: lrSymbol, rendered: renderAddr(lrValue, lrSymbol) },
		cfsr: { value: cfsr, bits: cfsrBits },
		hfsr: { value: hfsr, bits: hfsrBits },
		mmfar: mmfar === null ? null : { value: mmfar, region: regionOf(mmfar)?.name ?? null },
		bfar: bfar === null ? null : { value: bfar, region: regionOf(bfar)?.name ?? null },
		hypotheses,
		bestConfidence,
		warnings,
		notes,
	}
}
