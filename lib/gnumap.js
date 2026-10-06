/**
 * GNU ld `.map` 解析（`-Wl,-Map=out.map` 产出）。
 *
 * 覆盖面：arm-none-eabi-gcc、riscv*-elf-gcc、xtensa-esp-elf-gcc、avr-gcc、
 * msp430-gcc，以及 PlatformIO / ESP-IDF / Zephyr / CMake 的 GCC 工具链
 * —— 只要链接器是 GNU ld（或兼容的 ld.lld），格式就一致。
 *
 * ## 本文件的规则全部由真实 map 反解得出，不是推测
 *
 * 用于反解的真实产物：`testdata/smoke/` 下由本插件自己编译链接的
 * ARM Cortex-M0 与 RISC-V RV32 固件（源码与链接脚本都在包内，可复现）。
 * 判据是**同一份固件读 ELF 与读 map 必须给出相同的 ROM/RAM**
 * —— 两个独立解析器互证，任一方错了就会露馅。
 *
 * 三条从真实数据里逼出来的规则（每一条都对应一个曾经的错解）：
 *
 * 1. **段名可能单独占一行**。ld 对某些段（如纯预留的 `._user_heap_stack`、
 *    或 `.ARM.attributes`）会打印成
 *    ```
 *    ._user_heap_stack
 *                    0x20000048      0x200 load address 0x08000074
 *    ```
 *    名字在上一行、地址尺寸在下一行。只认单行格式会**整段漏掉**（实测丢 512 字节 RAM）。
 *
 * 2. **不能靠"有没有 load address"判断是否为 ZI**。ld 会给 `.bss` 也打
 *    `load address`（实测 `.bss ... load address 0x08000074`），因为那只是它内部的
 *    装载指针快照。真正可靠的是**装载地址是否推进**：`.bss` 与紧随其后的
 *    `._user_heap_stack` 的 load address **完全相同**，说明二者都没消耗 Flash。
 *    靠"有 load address"判断会把 `.bss` 误算进 ROM（实测虚增 68 字节）。
 *
 * 3. **必须排除不属于任何 MEMORY 区域的段**。`.comment` / `.ARM.attributes` /
 *    `.debug_*` 的 VMA 是 0x0，不在 Flash 也不在 RAM，它们不烧进芯片。
 *    不排除会虚增 RO Data（实测虚增 126 字节）。
 *
 * @module dsh-embedded-kit/gnumap
 */

/** 判定为 Code 段的名字（只用于 Code / RO Data 的细分，不影响 ROM 总量）。 */
const CODE_SECTION = /^\.(text|init|fini|plt|glue|itcm|vectors)\b/i

/** 内存区域配置表头。 */
const MEM_CONFIG_HEADER = /Memory\s+Configuration/i
/** 内存映射表头。 */
const MEM_MAP_HEADER = /Linker\s+script\s+and\s+memory\s+map/i

/** 输出段（单行形式）：`name 0xVMA 0xSIZE [load address 0xLMA]`。 */
const OUTPUT_SECTION = /^([^\s]+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)(?:\s+load\s+address\s+0x([0-9a-f]+))?/i
/** 只有段名的一行（换行形式的段头）。 */
const SECTION_NAME_ONLY = /^([.\w][^\s]*)\s*$/
/** 换行形式的段头的第二行：缩进的 `0xVMA 0xSIZE [load address 0xLMA]`。 */
const WRAPPED_ADDR_LINE = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)(?:\s+load\s+address\s+0x([0-9a-f]+))?/i
/** 输入段贡献行：有缩进，`name 0xADDR [0xSIZE] path`。 */
const INPUT_SECTION = /^\s+([^\s]+)\s+0x([0-9a-f]+)(?:\s+0x([0-9a-f]+))?\s+(\S.*)$/i

/**
 * 判断文本是否像 GNU ld 的 map。
 * @param {string} text - 文件文本。
 * @returns {boolean} 是否是 GNU ld map。
 */
export function isGnuMap(text) {
	return MEM_MAP_HEADER.test(text) || MEM_CONFIG_HEADER.test(text)
}

/**
 * 解析 GNU ld 的 `.map` 文本。
 *
 * @param {string} text - map 文件文本。
 * @returns {{format: 'gnu-map', arch: string, memoryRegions: Array<object>,
 *            outputSections: Array<object>, components: Array<object>,
 *            totals: {code: number, roData: number, rwData: number, ziData: number, rom: number, ram: number},
 *            warnings: string[], notes: string[]}}
 *   归一化结果。`components` 按 ROM 贡献降序。
 */
export function parseGnuMap(text) {
	const warnings = []
	const notes = []
	const lines = text.split(/\r?\n/)

	const memoryRegions = parseMemoryConfiguration(lines, notes)
	const { sections, droppedOutsideRegions, lastSectionRamVmaFlagged } = parseMemoryMap(lines, memoryRegions)

	if (lastSectionRamVmaFlagged) {
		warnings.push(
			'最后一个输出段的 VMA 在 RAM 而 LMA 在 Flash（典型是 .data 排在 map 末尾）：装载推进判据对它失效，ROM 可能被**少算**。若 map 被截断请提供完整文件；若链接脚本确实把 .data 放最后，请以 ELF 或 Flash 装载总量交叉核对。',
		)
	}

	if (memoryRegions.length === 0) {
		warnings.push(
			'未找到 `Memory Configuration` 段，无法按区域可写性判定 ROM/RAM。请保留 -Map 生成完整 map，且不要裁剪其头部。',
		)
	} else if (!memoryRegions.some((r) => r.writable)) {
		warnings.push('内存区域里没有任何可写区域（属性无 w），RAM 统计将不可靠')
	}
	if (droppedOutsideRegions > 0) {
		notes.push(
			`排除 ${droppedOutsideRegions} 个不属于任何 MEMORY 区域的段（如 .comment / .ARM.attributes / .debug_*，不烧进芯片、不占 RAM）`,
		)
	}

	// 自洽校验：逐输入段贡献之和 vs 输出段声明尺寸。
	for (const s of sections) {
		if (s.size > 0 && s.contribSum > 0 && s.contribSum !== s.size) {
			warnings.push(
				`段 ${s.name} 自洽校验不一致：声明尺寸 ${s.size}，逐项贡献之和 ${s.contribSum}（差 ${s.size - s.contribSum}）。解析可能漏行，勿直接采信绝对值。`,
			)
		}
	}

	const totals = { code: 0, roData: 0, rwData: 0, ziData: 0, rom: 0, ram: 0 }
	const components = []

	for (const s of sections) {
		if (s.contributesRom) totals.rom += s.size
		if (s.vmaInRam) totals.ram += s.size

		/** @type {'code'|'roData'|'rwData'|'ziData'} */
		let kind
		if (!s.vmaInRam) kind = CODE_SECTION.test(s.name) ? 'code' : 'roData'
		else kind = s.contributesRom ? 'rwData' : 'ziData'
		totals[kind] += s.size

		// 输入段贡献的归类比照其父段。
		for (const c of s.contributions) {
			components.push({ ...c, kind, rom: s.contributesRom ? c.size : 0, ram: s.vmaInRam ? c.size : 0 })
		}
	}

	if (sections.length === 0) warnings.push('未解析出任何输出段，map 可能不完整')
	const contribTotal = components.reduce((a, c) => a + c.size, 0)
	if (contribTotal === 0) warnings.push('未解析出任何输入段贡献行，逐项排序将为空')
	else notes.push(`解析到 ${sections.length} 个输出段、${components.length} 个输入段贡献（贡献合计 ${contribTotal} 字节）`)

	if (memoryRegions.length > 0) {
		notes.push(
			`内存区域：${memoryRegions.map((r) => `${r.name}(0x${r.origin.toString(16)}/${r.length} 字节/${r.attrs || '无属性'})`).join('、')}`,
		)
	}

	return {
		format: 'gnu-map',
		arch: detectArch(text),
		memoryRegions,
		outputSections: sections,
		components: components.sort((a, b) => b.rom - a.rom),
		totals,
		warnings,
		notes,
	}
}

/**
 * 解析 `Memory Configuration` 段。
 *
 * 格式：
 * ```
 * Name             Origin             Length             Attributes
 * FLASH            0x08000000         0x00004000         xr
 * RAM              0x20000000         0x00001000         xrw
 * *default*        0x00000000         0xffffffff
 * ```
 *
 * @param {string[]} lines - 全部行。
 * @param {string[]} notes - 信息收集数组。
 * @returns {Array<{name: string, origin: number, length: number, attrs: string, writable: boolean}>} 内存区域。
 */
function parseMemoryConfiguration(lines, notes) {
	const regions = []
	let i = lines.findIndex((l) => MEM_CONFIG_HEADER.test(l))
	if (i < 0) return regions

	i++
	while (i < lines.length && (lines[i].trim() === '' || /^-{3,}/.test(lines[i].trim()) || /^Name\s+Origin/i.test(lines[i]))) i++

	for (; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() === '' || /^-{3,}/.test(line.trim())) break
		const m = /^\s*(\S+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s*(\S*)/i.exec(line)
		if (!m) continue
		const name = m[1]
		if (name === '*default*') continue // 通配默认区域，不是真实存储
		const attrs = m[4] ?? ''
		regions.push({
			name,
			origin: Number.parseInt(m[2], 16),
			length: Number.parseInt(m[3], 16),
			attrs,
			// `!` 前缀表示排除该属性；只认明确含 w 且不含 !w 的可写区域。
			writable: attrs.includes('w') && !attrs.includes('!w'),
		})
	}
	if (regions.length > 0) notes.push(`解析到 ${regions.length} 个内存区域`)
	return regions
}

/**
 * 解析 `Linker script and memory map` 段。
 *
 * 分两步：先按行的真实形态收集输出段与它们的输入段贡献（含换行形式），
 * 再做区域归属、装载推进判定与分类 —— 后者必须等所有段都收齐才能算。
 *
 * @param {string[]} lines - 全部行。
 * @param {Array<object>} regions - 内存区域。
 * @returns {{sections: Array<object>, droppedOutsideRegions: number}} 保留下来的输出段与被排除的段数。
 */
function parseMemoryMap(lines, regions) {
	const start = lines.findIndex((l) => MEM_MAP_HEADER.test(l))
	if (start < 0) return { sections: [], droppedOutsideRegions: 0, lastSectionRamVmaFlagged: false }

	/** @type {Array<object>} */
	const raw = []
	let pendingName = null

	/**
	 * 造一个输出段对象。
	 * @param {string} name - 段名。
	 * @param {number} addr - VMA。
	 * @param {number} size - 尺寸。
	 * @param {number|null} loadAddr - LMA，未显式给出则为 null。
	 * @returns {object} 段对象。
	 */
	function makeSection(name, addr, size, loadAddr) {
		return {
			name,
			addr,
			size,
			loadAddr,
			lma: loadAddr === null ? addr : loadAddr,
			contribSum: 0,
			contributions: [],
			vmaInRam: false,
			contributesRom: false,
		}
	}

	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i]
		if (line.trim() === '') continue

		if (!/^\s/.test(line)) {
			// 单行形式：`name 0xVMA 0xSIZE [load address 0xLMA]`
			const m = OUTPUT_SECTION.exec(line)
			if (m) {
				raw.push(
					makeSection(
						m[1],
						Number.parseInt(m[2], 16),
						Number.parseInt(m[3], 16),
						m[4] === undefined ? null : Number.parseInt(m[4], 16),
					),
				)
				pendingName = null
				continue
			}
			// 只有段名的一行 → 记下来，等下一行给出地址与尺寸。
			const nameOnly = SECTION_NAME_ONLY.exec(line)
			if (nameOnly) {
				pendingName = nameOnly[1]
				continue
			}
			// 其他无缩进行（如 `LOAD xxx.o`）不影响段解析。
			continue
		}

		// 换行形式段头的第二行：紧跟在「只有段名」的下一行。
		if (pendingName !== null) {
			const w = WRAPPED_ADDR_LINE.exec(line)
			if (w) {
				raw.push(
					makeSection(
						pendingName,
						Number.parseInt(w[1], 16),
						Number.parseInt(w[2], 16),
						w[3] === undefined ? null : Number.parseInt(w[3], 16),
					),
				)
				pendingName = null
				continue
			}
			pendingName = null
		}

		// 输入段贡献。符号/赋值行以 0x 开头，先排除。
		if (/^\s+0x/i.test(line)) continue
		const m = INPUT_SECTION.exec(line)
		if (!m) continue

		const size = m[3] === undefined ? 0 : Number.parseInt(m[3], 16)
		const path = m[4].trim()
		// 只保留带文件路径的贡献行；纯符号定义行没有路径特征。
		if (size === 0 || !/[\\/]|\.(o|a|obj|lib|elf)$/i.test(path)) continue

		const parent = raw[raw.length - 1]
		if (!parent) continue
		parent.contributions.push({
			object: `${m[1]}  ←  ${basename(path)}`,
			section: m[1],
			parent: parent.name,
			size,
			code: 0,
			incData: 0,
			roData: 0,
			rwData: 0,
			ziData: 0,
			debug: 0,
			rom: 0,
			ram: 0,
			generated: false,
		})
		parent.contribSum += size
	}

	// 规则 3：排除不属于任何 MEMORY 区域的段（VMA 与 LMA 都不在任何区域内）。
	const kept = []
	let droppedOutsideRegions = 0
	for (const s of raw) {
		const vmaRegion = regionOf(regions, s.addr)
		const lmaRegion = regionOf(regions, s.lma)
		if (vmaRegion === null && lmaRegion === null) {
			droppedOutsideRegions++
			continue
		}
		s.vmaInRam = vmaRegion !== null && vmaRegion.writable
		s.vmaRegion = vmaRegion ? vmaRegion.name : null
		s.lmaInFlash = lmaRegion !== null && !lmaRegion.writable
		kept.push(s)
	}

	// 规则 2：用「装载地址是否推进」判断该段是否真的消耗了 Flash/ROM。
	// 紧随其后的段若 LMA 仍在原地，说明本段并未占用装载空间（典型是 .bss / 纯预留段）。
	let lastSectionRamVmaFlagged = false
	for (let i = 0; i < kept.length; i++) {
		const s = kept[i]
		const next = kept[i + 1]
		let consumesLoad
		if (next) {
			consumesLoad = next.lma >= s.lma + s.size
		} else {
			// 最后一段没有后继可比：只在它本身位于非可写区域时才认定消耗装载空间。
			// 若它是 VMA 在 RAM 的段（典型 .data：LMA 在 Flash、VMA 在 RAM），判据失效 ——
			// map 被截断或 .bss 恰好排在 .data 之后被吃掉时，ROM 会被静默少算，必须显式警告。
			consumesLoad = s.size > 0 && !s.vmaInRam
			if (s.size > 0 && s.vmaInRam && s.lmaInFlash) lastSectionRamVmaFlagged = true
		}

		s.contributesRom = consumesLoad && s.lmaInFlash
	}

	return { sections: kept, droppedOutsideRegions, lastSectionRamVmaFlagged }
}

/**
 * 找出包含给定地址的内存区域。
 * @param {Array<object>} regions - 内存区域。
 * @param {number} addr - 目标地址。
 * @returns {object|null} 命中的区域，或 null。
 */
function regionOf(regions, addr) {
	for (const r of regions) {
		if (addr >= r.origin && addr < r.origin + r.length) return r
	}
	return null
}

/**
 * 取路径最后一段，兼容 Windows 与 POSIX 分隔符。
 * @param {string} p - 路径。
 * @returns {string} 文件名。
 */
function basename(p) {
	return p.split(/[\\/]/).pop() ?? p
}

/**
 * 从 map 文本里尽力推断目标架构（GNU ld 不写架构字段，只能靠路径特征）。
 * 推不出来就返回 `未知`，**不猜**。
 * @param {string} text - map 文本。
 * @returns {string} 架构名。
 */
function detectArch(text) {
	const hints = [
		[/arm-none-eabi|arm-eabi|cortex-m|\bthumb\b/i, 'ARM（由工具链路径推断）'],
		[/riscv/i, 'RISC-V（由工具链路径推断）'],
		[/xtensa|esp32|esp-idf/i, 'Xtensa / ESP（由工具链路径推断）'],
		[/avr/i, 'AVR（由工具链路径推断）'],
		[/msp430/i, 'MSP430（由工具链路径推断）'],
	]
	for (const [re, name] of hints) if (re.test(text)) return name
	return '未知（GNU ld 在 map 里不记录架构；要精确架构请用 fw_size 直接读 ELF）'
}
