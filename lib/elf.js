/**
 * ELF 体积解析（纯 JS，无外部依赖）。
 *
 * **这是"芯片通用"的关键**：几乎所有嵌入式工具链的最终产物都是 ELF ——
 * arm-none-eabi-gcc、riscv64-unknown-elf-gcc、xtensa-esp-elf-gcc、
 * avr-gcc、msp430-gcc、IAR、Keil AC6 都能产出 ELF。
 * 直接读 ELF 的节区表，就不需要为每家工具链写一份 `.map` 解析器。
 *
 * 分类规则（按节区头的标志位，与工具链无关）：
 *   - 未置 `SHF_ALLOC` → 不占运行时空间（调试信息、符号表），跳过
 *   - 置 `SHF_EXECINSTR` → Code（.text / .init / .fini）
 *   - 置 `SHF_WRITE` 且 `SHT_NOBITS` → ZI Data（.bss：只占 RAM，不占 Flash）
 *   - 置 `SHF_WRITE` 且非 NOBITS → RW Data（.data：初值占 Flash，运行占 RAM）
 *   - 既不可写也不可执行且已分配 → RO Data（.rodata / .isr_vector / .ARM.exidx）
 *
 * 与 Keil 口径一致：
 *   ROM（Flash 镜像）= Code + RO Data + RW Data
 *   RAM            = RW Data + ZI Data
 *
 * 与 Keil 口径的一个已知差异：Keil 的 `Debug` 列**不计入** ROM；ELF 里调试信息
 * 通常位于未分配节区（`.debug_*` 无 `SHF_ALLOC`），因此同样不计入 —— 两边一致。
 *
 * @module dsh-embedded-kit/elf
 */

/** ELF magic：`\x7FELF`。 */
export const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46]

/** 节区类型。 */
const SHT_NOBITS = 8
const SHT_NULL = 0

/** 节区标志位。 */
const SHF_WRITE = 0x1
const SHF_ALLOC = 0x2
const SHF_EXECINSTR = 0x4

/**
 * `e_machine` → 架构名。
 *
 * 覆盖嵌入式常见架构；未收录的回落成十六进制，**不做猜测**。
 * 参考 ELF 标准的 EM_* 常量（架构无关的 ABI 编号）。
 */
const MACHINES = {
	0: '未指定',
	2: 'SPARC',
	3: 'Intel 80386',
	4: 'Motorola 68000',
	8: 'MIPS',
	20: 'PowerPC',
	21: 'PowerPC64',
	22: 'IBM S/390',
	40: 'ARM（32 位）',
	42: 'SuperH',
	45: 'ARC',
	62: 'x86-64',
	83: 'AVR',
	93: 'ARC Compact',
	94: 'Xtensa（ESP32 系）',
	105: 'MSP430',
	113: 'Altera Nios II',
	140: 'TI TMS320C6000',
	183: 'ARM AArch64（64 位）',
	243: 'RISC-V',
	247: 'eBPF',
}

/** 判断缓冲区是否是 ELF。 */
export function isElf(buffer) {
	if (buffer.length < 16) return false
	return ELF_MAGIC.every((b, i) => buffer[i] === b)
}

/**
 * 解析 ELF 的节区表并归类体积。
 *
 * 同时支持 32/64 位与小端/大端（由 `e_ident` 决定），
 * 因此 ARM、RISC-V、Xtensa、AVR、MSP430 等架构一视同仁。
 *
 * @param {Buffer|Uint8Array} buffer - ELF 文件内容。
 * @returns {{format: 'elf', arch: string, elfClass: number, endian: string,
 *            sections: Array<{name: string, kind: string, size: number, addr: number, type: number, flags: number}>,
 *            totals: {code: number, roData: number, rwData: number, ziData: number, rom: number, ram: number},
 *            skippedNonAlloc: number,
 *            warnings: string[], notes: string[]}}
 *   归一化的体积结果。
 * @throws {Error} 不是合法 ELF 或结构越界时抛出（属调用方输入错误）。
 */
export function parseElf(buffer) {
	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
	const warnings = []
	const notes = []

	if (!isElf(bytes)) throw new Error('不是 ELF 文件（magic 不匹配 \\x7FELF）')
	// 头长校验必须按实际位宽：32 位 ELF 头 52 字节，64 位头 64 字节（读到 0x3e+2）。
	// 早先只按 52 字节查，52~63 字节且声明 64 位的截断文件会在字段读取处抛裸 RangeError。
	if (bytes.length < 52) throw new Error(`文件过短（${bytes.length} 字节），不足以容纳 ELF 头`)
	const eiClass = bytes[4] // 1 = 32 位, 2 = 64 位
	if (eiClass === 2 && bytes.length < 64) {
		throw new Error(`64 位 ELF 文件过短（${bytes.length} 字节，64 位 ELF 头至少 64 字节）—— 文件可能被截断`)
	}
	const eiData = bytes[5] // 1 = 小端, 2 = 大端
	if (eiClass !== 1 && eiClass !== 2) throw new Error(`未知 ELF 位宽（EI_CLASS=${eiClass}）`)
	if (eiData !== 1 && eiData !== 2) throw new Error(`未知 ELF 字节序（EI_DATA=${eiData}）`)

	const is64 = eiClass === 2
	const le = eiData === 1
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

	const readU16 = (off) => view.getUint16(off, le)
	const readU32 = (off) => view.getUint32(off, le)
	const readU64 = (off) => Number(view.getBigUint64(off, le))

	const eMachine = readU16(18)
	// 32 位头的字段偏移；64 位头在这些字段上偏移不同。
	const shoff = is64 ? readU64(0x28) : readU32(0x20)
	const shentsize = is64 ? readU16(0x3a) : readU16(0x2e)
	const shnum = is64 ? readU16(0x3c) : readU16(0x30)
	const shstrndx = is64 ? readU16(0x3e) : readU16(0x32)

	const minEnt = is64 ? 64 : 40
	if (shentsize < minEnt) {
		throw new Error(`节区头尺寸异常（e_shentsize=${shentsize}，${is64 ? 64 : 40} 位 ELF 至少 ${minEnt}）`)
	}
	if (shnum === 0) {
		warnings.push('节区数为 0（可能被 strip 掉了节区表），无法按节区统计体积')
		return {
			format: 'elf',
			arch: machineName(eMachine),
			elfClass: is64 ? 64 : 32,
			endian: le ? '小端' : '大端',
			sections: [],
			totals: { code: 0, roData: 0, rwData: 0, ziData: 0, rom: 0, ram: 0 },
			skippedNonAlloc: 0,
			warnings,
			notes,
		}
	}
	if (shoff + shnum * shentsize > bytes.length) {
		throw new Error(
			`节区表越界：e_shoff=${shoff} + ${shnum}×${shentsize} > 文件长度 ${bytes.length}（文件可能被截断）`,
		)
	}

	/** 读取一个节区头。 */
	function readSectionHeader(index) {
		const off = shoff + index * shentsize
		if (is64) {
			return {
				name: readU32(off),
				type: readU32(off + 4),
				flags: readU64(off + 8),
				addr: readU64(off + 16),
				offset: readU64(off + 24),
				size: readU64(off + 32),
				// sh_link 指向关联节区（符号表 → 字符串表），漏掉它就拿不到符号名。
				link: readU32(off + 40),
				entsize: readU64(off + 56),
			}
		}
		return {
			name: readU32(off),
			type: readU32(off + 4),
			flags: readU32(off + 8),
			addr: readU32(off + 12),
			offset: readU32(off + 16),
			size: readU32(off + 20),
			link: readU32(off + 24),
			entsize: readU32(off + 36),
		}
	}

	/** 读取节区名字符串表中的一个名字。 */
	function readName(strtabOff, strtabSize, nameOff) {
		if (strtabOff === 0 || nameOff >= strtabSize) return ''
		const start = strtabOff + nameOff
		let end = start
		const limit = Math.min(strtabOff + strtabSize, bytes.length)
		while (end < limit && bytes[end] !== 0) end++
		return new TextDecoder('utf-8').decode(bytes.subarray(start, end))
	}

	// 先定位节区名字符串表。
	let strtab = { offset: 0, size: 0 }
	if (shstrndx > 0 && shstrndx < shnum) {
		const sh = readSectionHeader(shstrndx)
		strtab = { offset: sh.offset, size: sh.size }
	} else {
		warnings.push('缺少节区名字符串表（e_shstrndx 无效），节区名将显示为编号')
	}

	const sections = []
	const totals = { code: 0, roData: 0, rwData: 0, ziData: 0, rom: 0, ram: 0 }
	let skippedNonAlloc = 0
	let sawAlloc = false

	for (let i = 0; i < shnum; i++) {
		const sh = readSectionHeader(i)
		if (sh.type === SHT_NULL) continue

		// **关键判据**：未分配（SHF_ALLOC 未置）的节区不进运行时镜像。
		// 调试信息、符号表、字符串表都在这里，正好对应 Keil 的 Debug 列不计入 ROM。
		if ((sh.flags & SHF_ALLOC) === 0) {
			skippedNonAlloc++
			continue
		}
		sawAlloc = true

		const name = readName(strtab.offset, strtab.size, sh.name) || `<section #${i}>`

		/** @type {'code'|'roData'|'rwData'|'ziData'} */
		let kind
		if ((sh.flags & SHF_EXECINSTR) !== 0) kind = 'code'
		else if ((sh.flags & SHF_WRITE) !== 0) kind = sh.type === SHT_NOBITS ? 'ziData' : 'rwData'
		else kind = 'roData'

		sections.push({ name, kind, size: sh.size, addr: sh.addr, type: sh.type, flags: sh.flags, index: i })
		totals[kind] += sh.size
	}

	if (!sawAlloc) {
		warnings.push('没有任何已分配（SHF_ALLOC）节区，可能是重定位目标文件（.o）而非可执行文件')
	}

	// ---- 符号表：给出**符号级**体积排序 ----
	//
	// 为什么必须做这一步：只报段名（`.text` = 48 KB）对真实工程毫无可操作性 ——
	// 你没法"优化 .text"，你需要知道是哪个函数/哪个对象占了体积。
	// Keil map 给的是逐目标文件、GNU ld map 给的是逐输入段，ELF 要通过符号表才能给出
	// 同等可操作的信息，而且粒度更细（符号级优于文件级）。
	//
	// 只取 STT_OBJECT / STT_FUNC 且 size > 0 的已定义符号 —— 与 `nm --size-sort` 的口径一致，
	// 因此可以直接用官方 nm 的输出做交叉验证。
	const STT_OBJECT = 1
	const STT_FUNC = 2
	const SHT_SYMTAB = 2
	/** @type {Array<{name: string, size: number, kind: string, section: string, addr: number}>} */
	const symbols = []
	/** 节区 index → 节区对象（符号查找用 Map，避免 O(symbols × sections)）。 */
	const sectionByIndex = new Map(sections.map((s) => [s.index, s]))

	let symtabHeader = null
	for (let i = 0; i < shnum; i++) {
		const sh = readSectionHeader(i)
		if (sh.type === SHT_SYMTAB) {
			symtabHeader = sh
			break
		}
	}

	if (symtabHeader === null) {
		notes.push('ELF 没有符号表（可能被 strip），无法给出符号级体积排序；改用节区级排序')
	} else {
		// sh_link 必须先做边界校验：畸形/截断的 ELF 里它可能指向任意大 index，
		// 不查会在 readSectionHeader 内抛裸 RangeError 而不是可读的报错。
		if (symtabHeader.link >= shnum) {
			warnings.push(
				`符号表的 sh_link=${symtabHeader.link} 越界（节区总数 ${shnum}）—— 文件可能损坏，跳过符号级统计`,
			)
		} else {
		const strtabSh = readSectionHeader(symtabHeader.link)
		// 优先用节区头声明的条目尺寸（sh_entsize），它才是权威值；
		// 只有在它不合理时才回退到 ELF32/64 的标准尺寸。
		const standardSize = is64 ? 24 : 16
		const entSize =
			Number.isInteger(symtabHeader.entsize) && symtabHeader.entsize >= standardSize
				? symtabHeader.entsize
				: standardSize
		const count = Math.floor(symtabHeader.size / entSize)
		for (let i = 0; i < count; i++) {
			const off = symtabHeader.offset + i * entSize
			if (off + entSize > bytes.length) break
			const stName = readU32(off)
			const stInfo = bytes[off + (is64 ? 4 : 12)]
			const stShndx = is64 ? readU16(off + 6) : readU16(off + 14)
			const stSize = is64 ? readU64(off + 16) : readU32(off + 8)
			const stValue = is64 ? readU64(off + 8) : readU32(off + 4)

			const type = stInfo & 0xf
			if (type !== STT_OBJECT && type !== STT_FUNC) continue // 与 nm 默认输出口径一致
			if (stSize === 0) continue
			if (stShndx === 0 || stShndx >= shnum) continue // SHN_UNDEF / 越界

			// Map 索引代替逐符号线性扫描（大固件数万符号 × 数千节区是平方级开销）。
			const sec = sectionByIndex.get(stShndx)
			if (sec === undefined) continue // 位于非分配节区，不计入

			const symName = readName(strtabSh.offset, strtabSh.size, stName)
			if (symName.length === 0) continue

			symbols.push({ name: symName, size: stSize, kind: sec.kind, section: sec.name, addr: stValue })
		}
		symbols.sort((a, b) => b.size - a.size)
		notes.push(
			`解析到 ${symbols.length} 个有体积的符号（函数与对象），按大小降序 —— 这是**符号级**排序，比节区级可操作`,
		)
		}
	}

	totals.rom = totals.code + totals.roData + totals.rwData
	totals.ram = totals.rwData + totals.ziData

	notes.push(
		`按节区标志位分类：Code=${totals.code} / RO=${totals.roData} / RW=${totals.rwData} / ZI=${totals.ziData}（跳过 ${skippedNonAlloc} 个未分配节区）`,
	)
	if (sections.some((s) => s.kind === 'ziData' && /tls/i.test(s.name))) {
		warnings.push('检测到 TLS（线程局部存储）节区，其 RAM 占用可能在启动时动态分配，静态统计会偏低')
	}

	return {
		format: 'elf',
		arch: machineName(eMachine),
		elfClass: is64 ? 64 : 32,
		endian: le ? '小端' : '大端',
		sections: sections.sort((a, b) => b.size - a.size),
		symbols,
		totals,
		skippedNonAlloc,
		warnings,
		notes,
	}
}

/**
 * `e_machine` → 可读架构名；未收录的回落成十六进制而非猜测。
 * @param {number} eMachine - ELF 的 e_machine 字段。
 * @returns {string} 架构名或 `未知架构（EM=0xNN）`。
 */
function machineName(eMachine) {
	return MACHINES[eMachine] ?? `未知架构（EM=0x${eMachine.toString(16)}）`
}
