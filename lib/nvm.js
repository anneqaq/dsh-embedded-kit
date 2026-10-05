/**
 * NVM（片内 Flash / 模拟 EEPROM）分区与磨损分析（纯函数）。
 *
 * 回答三件事：
 *   1. 分区**能不能放下**、有没有**重叠**、是否**满足擦除页与写粒度对齐**
 *   2. 按你的写入频率，**擦除寿命还剩多少年**
 *   3. 磨损是否被**均匀分摊**（这是"存储器用了半年就坏"的常见根因）
 *
 * 磨损模型刻意分成两种，因为它们的寿命差几个数量级，混用会给出错得很离谱的结论：
 *   - `page-rewrite`（整页重写，配置区常见）：每次都擦同一页 → 寿命 = 上限 ÷ (每天写入次数)
 *   - `circular-log`（环形日志）：写满一页才擦最旧一页，擦除均摊到所有页
 *     → 寿命 = 上限 × 页数 ÷ (每天写入页数)
 *
 * @module dsh-embedded-kit/nvm
 */

/**
 * 规划 NVM 布局并估算磨损寿命。
 *
 * @param {object} spec - 输入。
 * @param {object} spec.flash - Flash 区域。
 * @param {number} spec.flash.base - 起始地址。
 * @param {number} spec.flash.size - 总大小（字节）。
 * @param {number} spec.flash.page_size - **擦除页大小**（字节）。注意擦除单位与写入单位不同。
 * @param {number} [spec.flash.write_granule_bytes] - 最小写入粒度（字节），默认 1。
 * @param {Array<{name?: string, offset?: number, size: number, kind?: string}>} [spec.regions]
 *   分区表。`offset` 为相对 `flash.base` 的偏移（默认从 0 依次紧排）。
 * @param {number} [spec.erase_cycles_max] - 该器件的擦除次数上限（数据手册给出）。
 * @param {Array<{region?: string, writes_per_day: number, bytes_per_write: number, mode?: 'page-rewrite'|'circular-log'}>} [spec.wear]
 *   各分区的写入负载。
 * @returns {object} 报告。
 * @throws {Error} 必填项缺失或非法时抛出。
 */
export function planNvmLayout(spec) {
	const { flash, regions = [], erase_cycles_max = null, wear = [] } = spec

	if (!flash || !Number.isFinite(flash.base) || flash.base < 0) throw new Error('flash.base 必须是非负整数')
	if (!Number.isFinite(flash.size) || flash.size <= 0) throw new Error('flash.size 必须是正数')
	if (!Number.isFinite(flash.page_size) || flash.page_size <= 0) throw new Error('flash.page_size 必须是正数（查数据手册）')
	const writeGranule = Number.isFinite(flash.write_granule_bytes) ? flash.write_granule_bytes : 1

	const warnings = []
	const notes = []
	const rows = []
	let cursor = 0

	for (const [i, r] of regions.entries()) {
		const name = r.name ?? `region${i + 1}`
		if (!Number.isFinite(r.size) || r.size <= 0) throw new Error(`${name}: size 必须是正数`)
		const offset = Number.isFinite(r.offset) ? r.offset : cursor
		cursor = offset + r.size

		const issues = []
		if (offset % flash.page_size !== 0) issues.push(`起始偏移 ${offset} 不是擦除页 ${flash.page_size} 的整数倍（区域内一旦要擦除就会连带擦掉前一区的尾部）`)
		if (r.size % flash.page_size !== 0) issues.push(`大小 ${r.size} 不是擦除页 ${flash.page_size} 的整数倍（尾页浪费 ${flash.page_size - (r.size % flash.page_size)} 字节）`)
		if (r.size % writeGranule !== 0) issues.push(`大小 ${r.size} 不是写粒度 ${writeGranule} 的整数倍`)

		rows.push({
			name,
			kind: r.kind ?? null,
			offset,
			start: flash.base + offset,
			end: flash.base + offset + r.size,
			size: r.size,
			pages: Math.floor(r.size / flash.page_size),
			issues,
		})
	}

	// 重叠检测：任意两个区间相交都是配置错误。
	for (let i = 0; i < rows.length; i++) {
		for (let j = i + 1; j < rows.length; j++) {
			const a = rows[i]
			const b = rows[j]
			if (a.start < b.end && b.start < a.end) {
				warnings.push(`分区重叠：${a.name} [0x${a.start.toString(16)}..0x${a.end.toString(16)}) 与 ${b.name} 相交 —— 必须修掉，否则一边写会破坏另一边`)
			}
		}
	}

	const used = rows.reduce((m, r) => Math.max(m, r.offset + r.size), 0)
	const free = flash.size - used
	if (used > flash.size) {
		warnings.push(`分区总占用 ${used} 字节超过 Flash 总大小 ${flash.size} 字节 —— 放不下`)
	} else if (free < flash.page_size) {
		warnings.push(`剩余空间仅 ${free} 字节（不足一页 ${flash.page_size}）—— 无余量，日后加功能或加配置冗余都会立刻撞墙`)
	}
	if (rows.length > 0 && !rows.some((r) => r.kind === 'bootloader')) {
		notes.push('分区表里没有标记 bootloader 区。若器件需要升级能力，Boot 区与 App 区必须分别对齐到擦除页边界，且升级时通常需要一份独立的 OTA 暂存区。')
	}
	if (rows.length > 0 && !rows.some((r) => r.kind === 'config' || r.kind === 'nvm')) {
		notes.push('分区表里没有配置/NVM 区。若需要保存参数，建议给它**至少两页**做双备份或环形日志，否则掉电时必然丢数据。')
	}

	// ---- 磨损寿命 ----
	const wearRows = []
	for (const [i, w] of wear.entries()) {
		const target = Number.isFinite(w.region) ? null : rows[i] ?? null
		const region = typeof w.region === 'string' ? rows.find((r) => r.name === w.region) ?? null : target
		const label = region?.name ?? w.region ?? `wear${i + 1}`
		if (region === null) {
			warnings.push(`磨损项「${label}」没有对应到任何分区，已跳过`)
			continue
		}
		if (!Number.isFinite(w.writes_per_day) || w.writes_per_day <= 0) continue
		if (!Number.isFinite(w.bytes_per_write) || w.bytes_per_write <= 0) continue

		const mode = w.mode ?? 'page-rewrite'
		const bytesPerDay = w.writes_per_day * w.bytes_per_write
		const pagesPerDay = bytesPerDay / flash.page_size
		const pages = Math.max(1, region.pages)

		let erasesPerPagePerDay
		let modelText
		if (mode === 'circular-log') {
			erasesPerPagePerDay = pagesPerDay / pages
			modelText = `环形日志：每天写 ${round2(pagesPerDay)} 页，擦除均摊到 ${pages} 页`
		} else {
			erasesPerPagePerDay = w.writes_per_day
			modelText = `整页重写：每次保存都擦同一页`
		}

		const years =
			erase_cycles_max === null || erasesPerPagePerDay <= 0
				? null
				: erase_cycles_max / erasesPerPagePerDay / 365

		wearRows.push({
			region: region.name,
			mode,
			model: modelText,
			bytesPerDay,
			pagesPerDay: round2(pagesPerDay),
			pagesAvailable: pages,
			erasesPerPagePerDay: round4(erasesPerPagePerDay),
			years: years === null ? null : round2(years),
		})

		if (erase_cycles_max === null) {
			notes.push(`「${region.name}」未提供 erase_cycles_max（数据手册给出），因此没算寿命。`)
		} else if (years !== null && years < 10) {
			warnings.push(
				`「${region.name}」按当前写入负载估算寿命仅 **${round2(years)} 年**（${modelText}）。改进方向：改环形日志分摊擦除、加 RAM 缓存合并写、降低保存频率、或换用外部 FRAM/EEPROM。`,
			)
		}
		if (mode === 'page-rewrite' && pages > 1) {
			notes.push(`「${region.name}」有 ${pages} 页却用整页重写模型 —— 若改成环形日志，寿命可放大到约 ${pages} 倍。`)
		}
	}

	if (erase_cycles_max === null && wearRows.length > 0) {
		notes.push('擦除次数上限务必取自数据手册，不要用别的型号或"经验值"代替 —— 它直接线性决定寿命。')
	}
	notes.push(
		'提醒：以上是**按你给的写入频率推算的寿命**，不是实测。真实寿命还受温度（高温显著加速氧化层退化）、写入时的电压裕度、以及是否在写过程中掉电影响。',
	)

	return {
		flash: { ...flash, writeGranule },
		regions: rows,
		usedBytes: used,
		freeBytes: free,
		usagePercent: flash.size > 0 ? round2((used / flash.size) * 100) : null,
		wear: wearRows,
		warnings,
		notes,
	}
}

/**
 * 保留两位小数。
 * @param {number} v - 原值。
 * @returns {number} 结果。
 */
function round2(v) {
	return Math.round(v * 100) / 100
}

/**
 * 保留四位小数。
 * @param {number} v - 原值。
 * @returns {number} 结果。
 */
function round4(v) {
	return Math.round(v * 10000) / 10000
}
