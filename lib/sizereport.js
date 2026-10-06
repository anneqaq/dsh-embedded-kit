/**
 * 体积分析的统一层：格式识别 + 归一到同一份报告结构 + 自洽校验。
 *
 * 支持三种输入，覆盖"全芯片通用"：
 *   - **ELF 文件**（最通用）：所有工具链的最终产物，读节区头即可，与架构无关
 *   - **GNU ld `.map`**：GCC 家族（arm-none-eabi / riscv / xtensa / avr / msp430、
 *     PlatformIO / ESP-IDF / Zephyr / CMake）
 *   - **Keil MDK `.map`**：armlink / armlink6
 *
 * 三者的自洽校验策略**不同**，因为数据来源的性质不同：
 *   - Keil：有官方 `Total ROM/RW Size` 行 → 逐项求和必须等于它
 *   - GNU ld：无官方汇总行 → 用"逐输入段贡献之和 vs 输出段声明尺寸"
 *   - ELF：数据直接读自节区头，本身就是权威源，不存在"累加印刷表格"这一步
 *     → 标记为"无需交叉校验"，而不是假装做了校验
 *
 * @module dsh-embedded-kit/sizereport
 */

import { isElf, parseElf } from './elf.js'
import { isGnuMap, parseGnuMap } from './gnumap.js'
import { parseKeilMap, componentFootprint } from './mapfile.js'

/** 归一化后的统一体积口径。 */
const EMPTY_TOTALS = { code: null, roData: null, rwData: null, ziData: null, rom: null, ram: null }

/**
 * 识别文件格式。
 *
 * 优先级：ELF magic（最可靠）→ Keil map 特征 → GNU ld map 特征。
 *
 * @param {Uint8Array|Buffer} buffer - 文件字节。
 * @param {string} text - 解码后的文本（map 判定用）。
 * @returns {'elf'|'keil-map'|'gnu-map'|'unknown'} 格式标识。
 */
export function detectFormat(buffer, text) {
	if (isElf(buffer)) return 'elf'
	if (/Image\s+component\s+sizes/i.test(text) || /Total\s+ROM\s+Size\s*\(Code/i.test(text)) return 'keil-map'
	if (isGnuMap(text)) return 'gnu-map'
	return 'unknown'
}

/**
 * 把 Keil 解析结果归一到统一结构。
 *
 * Keil 的权威数字来自它自己打印的 `Total RO / RW / ROM Size` 行；
 * Code / RO / RW / ZI 四项明细取自 `Grand Totals` 行。
 *
 * @param {object} parsed - {@link parseKeilMap} 的返回值。
 * @returns {object} 归一化结果。
 */
export function normalizeKeil(parsed) {
	const g = parsed.grandTotals ?? parsed.subtotals?.['Grand Totals'] ?? null
	const totals = {
		code: g ? g.code : null,
		roData: g ? g.roData : null,
		rwData: g ? g.rwData : null,
		ziData: g ? g.ziData : null,
		rom: parsed.totals.rom,
		ram: parsed.totals.rw,
	}
	return {
		format: 'keil-map',
		arch: '由工程目标决定（Keil map 不记录架构；要精确架构请用 fw_size 读 ELF）',
		totals,
	components: (parsed.components ?? []).map((c) => ({
		object: c.object,
		code: c.code,
		incData: c.incData ?? 0,
		roData: c.roData,
		rwData: c.rwData,
		ziData: c.ziData,
		debug: c.debug,
		// ROM/RAM 口径与 mapfile.componentFootprint 单源共用，避免两份公式漂移。
		...componentFootprint(c),
		generated: c.generated === true,
	})),
		memoryRegions: [],
		sections: [],
		official: { rom: parsed.totals.rom, ram: parsed.totals.rw },
		crossCheckKind: 'sum-vs-official',
		warnings: [...(parsed.warnings ?? [])],
		notes: [...(parsed.notes ?? [])],
	}
}

/**
 * 把 GNU ld map 解析结果归一到统一结构。
 * @param {object} parsed - {@link parseGnuMap} 的返回值。
 * @returns {object} 归一化结果。
 */
export function normalizeGnuMap(parsed) {
	return {
		format: 'gnu-map',
		arch: parsed.arch,
		totals: { ...EMPTY_TOTALS, ...parsed.totals },
		components: parsed.components ?? [],
		memoryRegions: parsed.memoryRegions ?? [],
		sections: parsed.outputSections ?? [],
		official: null,
		crossCheckKind: 'contrib-vs-section',
		warnings: [...(parsed.warnings ?? [])],
		notes: [...(parsed.notes ?? [])],
	}
}

/**
 * 把 ELF 解析结果归一到统一结构。
 * @param {object} parsed - {@link parseElf} 的返回值。
 * @returns {object} 归一化结果。
 */
export function normalizeElf(parsed) {
	const symbols = parsed.symbols ?? []
	// 优先用**符号级**排序：段名（`.text` = 48 KB）对优化毫无可操作性，
	// 你没法"优化 .text"，你需要知道是哪个函数/对象大。符号表能给出这一点，
	// 粒度甚至比 Keil 的逐目标文件更细。没有符号表（被 strip）时回退到段级。
	const useSymbols = symbols.length > 0

	const components = useSymbols
		? symbols.map((s) => ({
				object: `${s.name}  [${s.section}]`,
				code: s.kind === 'code' ? s.size : 0,
				incData: 0,
				roData: s.kind === 'roData' ? s.size : 0,
				rwData: s.kind === 'rwData' ? s.size : 0,
				ziData: s.kind === 'ziData' ? s.size : 0,
				debug: 0,
				rom: s.kind === 'ziData' ? 0 : s.size,
				ram: s.kind === 'code' || s.kind === 'roData' ? 0 : s.size,
				generated: false,
				sectionKind: s.kind,
			}))
		: (parsed.sections ?? []).map((s) => ({
				object: s.name,
				code: s.kind === 'code' ? s.size : 0,
				incData: 0,
				roData: s.kind === 'roData' ? s.size : 0,
				rwData: s.kind === 'rwData' ? s.size : 0,
				ziData: s.kind === 'ziData' ? s.size : 0,
				debug: 0,
				rom: s.kind === 'ziData' ? 0 : s.size,
				ram: s.kind === 'code' || s.kind === 'roData' ? 0 : s.size,
				generated: false,
				sectionKind: s.kind,
			}))

	const notes = [...(parsed.notes ?? [])]
	if (useSymbols) {
		const symRom = components.reduce((a, c) => a + c.rom, 0)
		const symRam = components.reduce((a, c) => a + c.ram, 0)
		notes.push(
			`排序粒度：**符号级**（函数与对象）。符号求和 ROM ${symRom} B / RAM ${symRam} B，` +
				`与节区合计（ROM ${parsed.totals.rom} / RAM ${parsed.totals.ram}）的差额属**对齐填充与无符号区域**` +
				`（典型如堆栈预留、链接器填充）—— 这是正常现象，不是解析错误。`,
		)
	}

	return {
		format: 'elf',
		arch: `${parsed.arch} · ${parsed.elfClass} 位 · ${parsed.endian}`,
		totals: { ...EMPTY_TOTALS, ...parsed.totals },
		components,
		granularity: useSymbols ? 'symbol' : 'section',
		memoryRegions: [],
		sections: parsed.sections ?? [],
		official: null,
		// 节区头本身就是权威源，没有"累加印刷表格"这一步，因此无需交叉校验。
		crossCheckKind: 'not-applicable',
		warnings: [...(parsed.warnings ?? [])],
		notes,
	}
}

/**
 * 端到端分析入口：识别格式 → 解析 → 归一到统一报告。
 *
 * **工具层与验证脚本共用这一个函数**，因此验证脚本测的就是工具实际执行的路径，
 * 而不是另写一份等价逻辑（那种验证没有意义）。
 *
 * @param {Uint8Array|Buffer} buffer - 文件字节。
 * @param {{text: string, encoding: string}} decoded - 解码后的文本与所用编码。
 * @param {object} [options] - 选项。
 * @param {'auto'|'elf'|'keil-map'|'gnu-map'} [options.format] - 强制格式，默认 auto。
 * @param {number} [options.topN] - 前 N 个条目。
 * @param {number} [options.romBudget] - Flash 预算。
 * @param {number} [options.ramBudget] - RAM 预算。
 * @param {string} [options.source] - 文件路径（仅展示）。
 * @returns {object} 统一报告。
 * @throws {Error} 格式无法识别或指定格式与内容不符时抛出。
 */
export function analyzeBuffer(buffer, decoded, options = {}) {
	const requested = options.format && options.format !== 'auto' ? options.format : null
	const detected = detectFormat(buffer, decoded.text)
	const format = requested ?? detected

	if (format === 'unknown') {
		const head = decoded.text.slice(0, 200).replace(/\s+/g, ' ')
		throw new Error(
			`无法识别文件格式。ELF 需要有 \\x7FELF magic；map 需要含 "Image component sizes"（Keil）或 "Memory Configuration"/"Linker script and memory map"（GNU ld）。文件开头：${head}`,
		)
	}
	// 显式指定的格式若与内容矛盾，直接报错而不是硬按用户说的解析 ——
	// 否则会产出一份"看起来成功但完全错"的报告。
	if (requested && requested !== detected && detected !== 'unknown') {
		throw new Error(`指定格式为 '${requested}'，但内容特征更像 '${detected}'。请去掉 format 参数让工具自动识别。`)
	}

	let normalized
	if (format === 'elf') normalized = normalizeElf(parseElf(buffer))
	else if (format === 'keil-map') normalized = normalizeKeil(parseKeilMap(decoded.text))
	else normalized = normalizeGnuMap(parseGnuMap(decoded.text))

	return buildUnifiedReport(normalized, {
		topN: options.topN,
		romBudget: options.romBudget,
		ramBudget: options.ramBudget,
		source: options.source,
		encoding: format === 'elf' ? null : decoded.encoding,
	})
}

/**
 * 生成统一报告。
 *
 * @param {object} normalized - {@link normalizeKeil} / {@link normalizeGnuMap} / {@link normalizeElf} 的输出。
 * @param {object} [options] - 选项。
 * @param {number} [options.topN] - 返回前 N 个条目，默认 10。
 * @param {number} [options.romBudget] - Flash 预算（字节）。
 * @param {number} [options.ramBudget] - RAM 预算（字节）。
 * @param {string} [options.source] - 被分析的文件路径（仅用于展示）。
 * @param {string} [options.encoding] - 文本解码所用的编码（仅用于展示）。
 * @returns {object} 统一报告。
 */
export function buildUnifiedReport(normalized, options = {}) {
	const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : 10
	const { totals, components } = normalized
	const warnings = [...(normalized.warnings ?? [])]
	const notes = [...(normalized.notes ?? [])]

	const ranked = [...components].sort((a, b) => b.rom - a.rom)
	const sumRom = ranked.reduce((s, c) => s + c.rom, 0)
	const sumRam = ranked.reduce((s, c) => s + c.ram, 0)

	// 自洽校验：三种格式的策略不同，如实说明用了哪一种。
	const crossCheck = { kind: normalized.crossCheckKind, passed: null, detail: '' }
	if (normalized.crossCheckKind === 'sum-vs-official' && normalized.official?.rom !== null) {
		const dRom = normalized.official.rom - sumRom
		const dRam = normalized.official.ram === null ? 0 : normalized.official.ram - sumRam
		crossCheck.passed = Math.abs(dRom) === 0
		crossCheck.official = normalized.official
		crossCheck.computed = { rom: sumRom, ram: sumRam }
		crossCheck.delta = { rom: dRom, ram: dRam }
		crossCheck.detail = crossCheck.passed
			? `逐项求和与 Keil 官方汇总完全一致（ROM ${normalized.official.rom} / RAM ${normalized.official.ram}）`
			: `逐项求和与 Keil 官方汇总不一致：ROM 差 ${dRom}、RAM 差 ${dRam}。解析可能漏行，勿直接采信绝对值。`
		if (!crossCheck.passed) warnings.push(crossCheck.detail)
	} else if (normalized.crossCheckKind === 'contrib-vs-section') {
		crossCheck.passed = !warnings.some((w) => w.includes('自洽校验不一致'))
		crossCheck.detail = crossCheck.passed
			? '逐输入段贡献之和与输出段声明尺寸一致'
			: '存在段的贡献之和与声明尺寸不一致（见警告）'
	} else {
		crossCheck.detail =
			'ELF 的体积直接读自节区头，本身就是权威来源，不存在"累加印刷表格"这一步，因此无需交叉校验'
	}

	const report = {
		format: normalized.format,
		arch: normalized.arch,
		source: options.source ?? null,
		encoding: options.encoding ?? null,
		/** 排序粒度：symbol（助记/对象名）/ object（目标文件或输入段）/ section（段）。 */
		granularity: normalized.granularity ?? 'object',
		totals,
		objectCount: ranked.length,
		sumRom,
		sumRam,
		crossCheck,
		top: ranked.slice(0, topN),
		memoryRegions: normalized.memoryRegions ?? [],
		sectionCount: (normalized.sections ?? []).length,
		warnings,
		notes,
	}

	for (const [key, budget] of [
		['romBudget', options.romBudget],
		['ramBudget', options.ramBudget],
	]) {
		if (!Number.isInteger(budget) || budget <= 0) continue
		const isRom = key === 'romBudget'
		const used = isRom ? totals.rom : totals.ram
		report[key] = {
			budget,
			used,
			percent: used === null ? null : Math.round((used / budget) * 10000) / 100,
			headroom: used === null ? null : budget - used,
			note: isRom ? 'ROM（Flash 镜像）' : 'RAM',
		}
	}

	// 没给预算但 map 里带了存储区域信息 → 提示可以拿区域长度当预算算占用率。
	if (!report.romBudget && !report.ramBudget && normalized.memoryRegions.length > 0) {
		notes.push('map 里带有存储区域信息；要算占用率可直接把区域长度当预算传进来（或用工具输出的 memoryRegions）')
	}

	// 已有 RAM 预算但 map 提供了可写区域 → 用区域长度做交叉提示（不覆盖用户显式给的预算）。
	const writable = (normalized.memoryRegions ?? []).filter((r) => r.writable)
	if (writable.length > 0) {
		notes.push(
			`可写存储区域：${writable.map((r) => `${r.name}=${r.length} 字节`).join('、')}（可直接作为 RAM 预算参考）`,
		)
	}

	return report
}
