/**
 * Keil MDK `.map` 解析：把链接器映射文件变成结构化的体积账。
 *
 * 只做纯函数解析，不碰文件系统 —— 读写由调用方（工具层）负责，
 * 便于单元自测。
 *
 * Keil 的 .map 里有两块对我们有用的信息：
 *   1. 末尾的汇总行：`Total RO Size` / `Total RW Size` / `Total ROM Size`
 *   2. 各目标文件的成分表（Image component sizes），给出每个 .o 的
 *      Code(含 data) / RO Data / RW Data / ZI Data / Debug
 *
 * @module dsh-embedded-kit/mapfile
 */

/**
 * 一个目标文件的体积成分。
 * @typedef {object} MapComponent
 * @property {string} object 目标文件名（可能含路径）。
 * @property {number} code   Code（已含 data）。
 * @property {number} incData 包含在 code 内的 data 部分（**不额外相加**）。
 * @property {number} roData 只读数据。
 * @property {number} rwData 已初始化可读写数据。
 * @property {number} ziData 零初始化数据（.bss）。
 * @property {number} debug  调试信息。
 */

/** 汇总行里的一个体积条目。 */
const TOTAL_PATTERNS = [
	{ key: 'ro', re: /^\s*Total\s+RO\s+Size\s*\(Code\s*\+\s*RO\s+Data\)\s+(\d+)/i },
	{ key: 'rw', re: /^\s*Total\s+RW\s+Size\s*\(RW\s+Data\s*\+\s*ZI\s+Data\)\s+(\d+)/i },
	{ key: 'rom', re: /^\s*Total\s+ROM\s+Size\s*\(Code\s*\+\s*RO\s+Data\s*\+\s*RW\s+Data\)\s+(\d+)/i },
]

/**
 * 本解析器要处理的真实表结构（实测自 `Car_Encoder.map`，非推测）：
 *
 * ```
 *   Image component sizes
 *   Code (inc. data) RO Data RW Data ZI Data Debug  Object Name   ← 表 1：真实目标文件
 *     ...（真正的 .o 行）...
 *     Object Totals
 *       0  0 32 0 0 0  (incl. Generated)     ← 链接器生成代码，计入合计
 *      12  0  0 0 0 0  (incl. Padding)       ← 对齐填充，计入合计
 *   Code (inc. data) ... Debug  Library Member Name                 ← 表 2：库成员，逐项
 *     ...（entry.o / uldiv.o 等）...
 *     Library Totals
 *   Code (inc. data) ... Debug  Library Name                        ← 表 3：同一批库的聚合视图
 *     mc_w.l
 *     Library Totals                                                  ← 与表 2 合计重复！
 *   Code (inc. data) ... Debug                                      ← 无名字列，只剩合计
 *     Grand Totals / ELF Image Totals / ROM Totals
 * ```
 *
 * 三条处理规则（缺任何一条都会让逐项求和与 Keil 汇总对不上）：
 *   1. 目标名以 `(` 开头 → 链接器生成/填充行，**计入求和**但打 `generated` 标记
 *   2. 表 3（`Library Name`）→ 聚合视图，与表 2 逐项重复，**排除**
 *   3. 目标名以 `Totals` 结尾 → 小计/合计行，**排除**并另存
 *
 * 实测验证（三份真实工程：Car_Encoder / Timr / OLED）：
 * 按上述规则处理后，逐项求和与 Keil 自己的 `Total RO / RW / ROM Size` 行完全一致。
 * 这组规则的每一条都是被真实数据逼出来的 —— 最初漏掉规则 1 与 2 时误差达 8000+ 字节。
 */

/** 目标文件成分表的表头标记。 */
const COMPONENT_HEADER = /Image component sizes/i
/** 小计/合计行的判定：目标名以 `Totals` 结尾。 */
const TOTALS_ROW = /Totals\s*$/i
/** 备注行的判定：名字以 `(` 开头，如 `(incl. Generated)`。 */
const NOTE_ROW = /^\(/
/** 需要的几个权威合计行的名字。 */
const TOTALS_OF_INTEREST = ['Object Totals', 'Grand Totals', 'ROM Totals']

/**
 * 判定一行是否是列头，并返回它所属的子表类型。
 * @param {string} line - 待判定的行。
 * @returns {'object'|'library-member'|'library'|'summary'|null} 子表类型；非列头返回 null。
 */
function classifyColumnHeader(line) {
	if (/Library Member Name\s*$/i.test(line)) return 'library-member'
	if (/Object Name\s*$/i.test(line)) return 'object'
	if (/Library Name\s*$/i.test(line)) return 'library'
	// 无名字列的列头（尾部只剩 Debug），其后只跟合计行。
	if (/Code\s*\(inc\.\s*data\)/i.test(line) && /Debug\s*$/i.test(line)) return 'summary'
	return null
}
/**
 * 六个数字 + 目标名 —— Keil MDK 现行的 **六列**格式。
 *
 * 列序经真实 `.map` 反解验证（见本文件顶部注释的推导）：
 * `Code | inc. data | RO Data | RW Data | ZI Data | Debug`
 *
 * 注意第 2 列 `inc. data` 是 **code 内部的细分**，不是独立占用，
 * 计算总量时**绝不能相加** —— 这是最容易把总量算大的地方。
 */
const ROW_6 = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/
/** 五个数字 + 目标名 —— 旧版 Keil 的格式：`Code | RO | RW | ZI | Debug`。 */
const ROW_5 = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S.*?)\s*$/

/** 把一行正则匹配结果转成成分对象。 */
function toComponent(m, isSixColumn) {
	if (isSixColumn) {
		return {
			code: Number(m[1]),
			incData: Number(m[2]),
			roData: Number(m[3]),
			rwData: Number(m[4]),
			ziData: Number(m[5]),
			debug: Number(m[6]),
			object: m[7].trim(),
		}
	}
	return {
		code: Number(m[1]),
		incData: 0,
		roData: Number(m[2]),
		rwData: Number(m[3]),
		ziData: Number(m[4]),
		debug: Number(m[5]),
		object: m[6].trim(),
	}
}

/**
 * 解析 Keil MDK 的 `.map` 文本。
 *
 * 容错策略：任何一块解析不到都不抛错，只在 `warnings` 里记一笔 ——
 * 不同 Keil 版本、不同链接器（armlink / armlink6）的输出格式有差异，
 * 拿不到成分表时汇总行通常仍然可用。
 *
 * @param {string} text - `.map` 文件的完整文本。
 * @returns {{totals: {ro: number|null, rw: number|null, rom: number|null},
 *            components: MapComponent[],
 *            grandTotals: MapComponent|null,
 *            subtotals: Record<string, MapComponent>,
 *            layout: string,
 *            warnings: string[],
 *            notes: string[]}}
 *   汇总字节数、各目标文件成分、合计行、列格式、以及警告与信息。
 */
export function parseKeilMap(text) {
	const warnings = []
	/** 正常行为的信息（例如跳过了备注行），不是异常，因此与 warnings 分开。 */
	const notes = []
	/** @type {{ro: number|null, rw: number|null, rom: number|null}} */
	const totals = { ro: null, rw: null, rom: null }
	/** @type {MapComponent[]} */
	const components = []
	/** @type {MapComponent|null} */
	let grandTotals = null

	if (typeof text !== 'string' || text.length === 0) {
		warnings.push('map 文本为空')
		return { totals, components, grandTotals: null, subtotals: {}, layout: 'unknown', warnings, notes }
	}

	const lines = text.split(/\r?\n/)

	for (const line of lines) {
		for (const { key, re } of TOTAL_PATTERNS) {
			const m = re.exec(line)
			if (m) totals[key] = Number(m[1])
		}
	}

	// 成分表：只在 Image component sizes 之后收集。表内嵌套三张子表 + 备注行，
	// 按 classifyColumnHeader 切分上下文，按下面三条规则排除非目标文件行。
	let inTable = false
	/** @type {'object'|'library-member'|'library'|'summary'|null} */
	let sectionKind = null
	let sixColumnRows = 0
	let fiveColumnRows = 0
	let generatedRows = 0
	let skippedAggregateSection = 0
	/** @type {Record<string, object>} */
	const subtotals = {}

	for (const line of lines) {
		if (!inTable) {
			if (COMPONENT_HEADER.test(line)) inTable = true
			continue
		}

		const headerKind = classifyColumnHeader(line)
		if (headerKind !== null) {
			sectionKind = headerKind
			continue
		}

		const m6 = ROW_6.exec(line)
		const m5 = m6 ? null : ROW_5.exec(line)
		const m = m6 ?? m5
		if (!m) continue

		const component = toComponent(m, m6 !== null)
		const rowName = component.object

		if (TOTALS_ROW.test(rowName)) {
			// 规则 3：小计/合计行，绝不并入目标文件清单。
			if (TOTALS_OF_INTEREST.includes(rowName)) subtotals[rowName] = component
			if (rowName === 'Grand Totals') grandTotals = component
			continue
		}

		if (NOTE_ROW.test(rowName)) {
			// `(incl. ...)` 行：名字说明它是**计入合计的**额外占用
			// （实测 `(incl. Generated)` 是链接器生成代码、`(incl. Padding)` 是对齐填充）。
			// 它们没有对应源文件，但确实占 Flash/RAM，因此**必须计入求和**，
			// 否则逐项求和永远比 Keil 汇总少一截（实测差 44 字节）。
			// 只打标区分，供上层把它们和源文件分开说明。
			component.generated = true
			generatedRows++
			if (m6) sixColumnRows++
			else fiveColumnRows++
			components.push(component)
			continue
		}

		if (sectionKind === 'library') {
			// 规则 2：`Library Name` 是聚合视图，与 `Library Member Name` 逐项表重复。
			skippedAggregateSection++
			continue
		}

		if (m6) sixColumnRows++
		else fiveColumnRows++
		components.push(component)
	}

	if (generatedRows > 0) {
		notes.push(
			`计入 ${generatedRows} 行 \`(incl. ...)\` 链接器生成/填充字节（无对应源文件，但确实占用 Flash/RAM）`,
		)
	}
	if (skippedAggregateSection > 0) {
		notes.push(`跳过 ${skippedAggregateSection} 行 \`Library Name\` 聚合视图（与库成员逐项表重复）`)
	}

	const layout =
		sixColumnRows > 0 && fiveColumnRows > 0
			? 'mixed'
			: sixColumnRows > 0
				? 'six-column'
				: fiveColumnRows > 0
					? 'five-column'
					: 'unknown'
	if (layout === 'mixed') {
		warnings.push(
			`成分表里同时出现了 ${sixColumnRows} 行六列与 ${fiveColumnRows} 行五列格式，列语义可能不可靠`,
		)
	}

	if (components.length === 0) {
		warnings.push('未能解析出 Image component sizes 表（map 可能被裁剪，或该链接器版本用了未知格式）')
	}
	if (totals.ro === null && totals.rw === null && totals.rom === null) {
		warnings.push('未找到 Total RO/RW/ROM Size 汇总行')
	}

	return { totals, components, grandTotals, subtotals, layout, warnings, notes }
}

/**
 * 计算单个目标文件占用的 ROM 与 RAM。
 *
 * ROM（Flash 镜像） = Code + RO Data + RW Data
 *   注意 RW Data 的初值要存进 Flash，所以它同时计入 ROM。
 * RAM = RW Data + ZI Data
 *
 * @param {MapComponent} c - 一个成分条目。
 * @returns {{rom: number, ram: number}} 该条目的 ROM 与 RAM 字节数。
 */
export function componentFootprint(c) {
	return {
		rom: c.code + c.roData + c.rwData,
		ram: c.rwData + c.ziData,
	}
}

/**
 * 把解析结果整理成可供工具层渲染的报告。
 *
 * @param {{totals: object, components: MapComponent[], warnings: string[]}} parsed
 *   {@link parseKeilMap} 的返回值。
 * @param {object} [options] - 分析选项。
 * @param {number} [options.topN] - 返回前 N 个体积大户，默认 10。
 * @param {number} [options.romBudget] - Flash 预算（字节），给了才计算占比。
 * @param {number} [options.ramBudget] - RAM 预算（字节），给了才计算占比。
 * @returns {object} 结构化报告；`ranked` 按 ROM 降序。
 */
export function buildSizeReport(parsed, options = {}) {
	const topN = Number.isInteger(options.topN) && options.topN > 0 ? options.topN : 10
	const { totals, components, warnings } = parsed
	const notes = parsed.notes ?? []

	const ranked = components
		.map((c) => {
			const fp = componentFootprint(c)
			return {
				object: c.object,
				code: c.code,
				incData: c.incData,
				roData: c.roData,
				rwData: c.rwData,
				ziData: c.ziData,
				debug: c.debug,
				rom: fp.rom,
				ram: fp.ram,
				generated: c.generated === true,
			}
		})
		.sort((a, b) => b.rom - a.rom)

	// 各目标文件相加得到的合计，用来与 Keil 自己的汇总行交叉验证：
	// 数字对不上就说明解析漏了行，必须如实标出来，不能默默采信。
	const sumRom = ranked.reduce((s, c) => s + c.rom, 0)
	const sumRam = ranked.reduce((s, c) => s + c.ram, 0)

	const report = {
		totals,
		layout: parsed.layout,
		objectCount: ranked.length,
		sumRom,
		sumRam,
		top: ranked.slice(0, topN),
		ranked,
		warnings: [...warnings],
		notes: [...notes],
	}

	if (Number.isInteger(options.romBudget) && options.romBudget > 0) {
		report.romBudget = {
			budget: options.romBudget,
			used: totals.rom,
			percent: totals.rom === null ? null : round2((totals.rom / options.romBudget) * 100),
			headroom: totals.rom === null ? null : options.romBudget - totals.rom,
		}
	}
	if (Number.isInteger(options.ramBudget) && options.ramBudget > 0) {
		report.ramBudget = {
			budget: options.ramBudget,
			used: totals.rw,
			percent: totals.rw === null ? null : round2((totals.rw / options.ramBudget) * 100),
			headroom: totals.rw === null ? null : options.ramBudget - totals.rw,
		}
	}

	// 交叉验证：Keil 汇总的 ROM 与逐项求和应当一致。
	if (totals.rom !== null && ranked.length > 0) {
		const delta = totals.rom - sumRom
		if (Math.abs(delta) > 0) {
			report.warnings.push(
				`交叉验证不一致：Keil 汇总 ROM=${totals.rom}，逐项求和=${sumRom}（差 ${delta}）。解析可能漏行，请勿直接采信绝对值。`,
			)
		}
	}

	return report
}

/**
 * 保留两位小数。
 * @param {number} value - 原值。
 * @returns {number} 四舍五入到两位小数的结果。
 */
function round2(value) {
	return Math.round(value * 100) / 100
}
