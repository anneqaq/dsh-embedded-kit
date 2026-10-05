/**
 * LVGL 显示缓冲与带宽计算（纯函数）。
 *
 * LVGL 的显存配置是**移植时最容易配错、且配错后表现为"花屏/撕裂/卡顿/内存不足"**的一环。
 * 这里把可算的部分算清楚：像素格式字节数、全屏帧大小、按缓冲模式与缓冲数量得到的绘制缓冲大小、
 * 以及一次全屏刷新要搬多少字节（决定了总线/刷新率是否够）。
 *
 * **诚实边界**：`LV_MEM_SIZE`（LVGL 自己的堆）**算不出来** —— 它取决于你创建了多少对象、
 * 每个对象的样式与文本长度，只有运行时 `lv_mem_monitor()` 能给出真实值。
 * 本模块只给一个**明确标注为经验起点**的量级参考，并说明必须实测。
 *
 * @module dsh-embedded-kit/lvgl
 */

/**
 * 计算 LVGL 显示缓冲需求。
 *
 * @param {object} spec - 输入。
 * @param {number} spec.hres - 水平分辨率（像素）。
 * @param {number} spec.vres - 垂直分辨率（像素）。
 * @param {number} spec.color_depth_bits - 像素位深：1 / 8 / 16 / 24 / 32。
 * @param {'full'|'partial'} [spec.buffer_mode] - `full` 全屏缓冲；`partial` 局部缓冲（默认）。
 * @param {1|2} [spec.buffer_count] - 缓冲数量，默认 1。双缓冲需要驱动支持两块缓冲。
 * @param {number} [spec.partial_lines] - `partial` 模式下每块缓冲的行数（默认全屏的 1/10）。
 * @param {number} [spec.refresh_rate_hz] - 期望刷新率（Hz），给了才算每秒带宽。
 * @param {number} [spec.bus_bytes_per_second] - 显示总线的理论带宽（字节/秒），给了才算带宽占用率。
 * @param {number} [spec.ram_total_bytes] - 可用 RAM 总量（字节），给了才算占用比例。
 * @returns {object} 计算报告。
 * @throws {Error} 参数非法时抛出。
 */
export function sizeLvglBuffers(spec) {
	const {
		hres,
		vres,
		color_depth_bits,
		buffer_mode = 'partial',
		buffer_count = 1,
		partial_lines = null,
		refresh_rate_hz = null,
		bus_bytes_per_second = null,
		ram_total_bytes = null,
	} = spec

	for (const [k, v] of [
		['hres', hres],
		['vres', vres],
	]) {
		if (!Number.isFinite(v) || v <= 0) throw new Error(`${k} 必须是正数`)
	}
	if (![1, 8, 16, 24, 32].includes(color_depth_bits)) {
		throw new Error('color_depth_bits 只支持 1 / 8 / 16 / 24 / 32（LV_COLOR_DEPTH）')
	}
	if (buffer_count !== 1 && buffer_count !== 2) throw new Error('buffer_count 只能是 1 或 2')

	const warnings = []
	const notes = []

	// 位深不足 8 位时按「整字节装多个像素」算：LVGL 的 1 位是单色，按位打包。
	const bytesPerPixel = color_depth_bits >= 8 ? color_depth_bits / 8 : 1 / 8
	const fullFrameBytes = Math.ceil(hres * vres * bytesPerPixel)

	let linesPerBuffer
	let bufferBytes
	if (buffer_mode === 'full') {
		linesPerBuffer = vres
		bufferBytes = fullFrameBytes
	} else {
		const defaultLines = Math.max(1, Math.floor(vres / 10))
		linesPerBuffer = Number.isFinite(partial_lines) && partial_lines > 0 ? Math.floor(partial_lines) : defaultLines
		bufferBytes = Math.ceil(hres * linesPerBuffer * bytesPerPixel)
	}

	const totalDrawBufferBytes = bufferBytes * buffer_count

	// ---- 带宽 ----
	let bandwidth = null
	if (Number.isFinite(refresh_rate_hz) && refresh_rate_hz > 0) {
		// 最坏情况：每帧全屏都变。LVGL 实际只重绘脏区，所以这是上界。
		const bytesPerSecond = fullFrameBytes * refresh_rate_hz
		bandwidth = {
			refreshRateHz: refresh_rate_hz,
			bytesPerSecond,
			kibPerSecond: round2(bytesPerSecond / 1024),
			// SPI 的有效吞吐要扣掉命令/地址/时序开销，这里按位只说数据位。
			requiredSpiHz: Math.round(bytesPerSecond * 8),
		}
		if (Number.isFinite(bus_bytes_per_second) && bus_bytes_per_second > 0) {
			const ratio = bytesPerSecond / bus_bytes_per_second
			bandwidth.utilizationPercent = round2(ratio * 100)
			bandwidth.fits = ratio <= 1
			if (ratio > 1) {
				warnings.push(
					`带宽不够：满屏刷新需要 ${bandwidth.kibPerSecond} KiB/s，而总线只有 ${round2(bus_bytes_per_second / 1024)} KiB/s（占用 ${bandwidth.utilizationPercent}%）。` +
						`修法：降低刷新率、用局部刷新（LVGL 只重绘脏区，实际远低于此上界）、减小分辨率/位深、或改用并口/RGB/MIPI 一类更高带宽的接口。`,
				)
			} else if (ratio > 0.7) {
				notes.push(`带宽占用 ${bandwidth.utilizationPercent}% —— 这已是**满屏每帧都变**的上界，且没算 SPI 命令开销与 DMA 抢占；实际留余量很小。`)
			}
		}
	}

	// ---- 缓冲模式建议 ----
	if (buffer_mode === 'full') {
		notes.push('全屏缓冲：LVGL 可以直接把整帧交给驱动，撕裂最少，但需要一整帧的 RAM。')
		if (ram_total_bytes !== null && fullFrameBytes * buffer_count > ram_total_bytes * 0.5) {
			warnings.push(
				`全屏${buffer_count === 2 ? '双' : '单'}缓冲需 ${fullFrameBytes * buffer_count} 字节，超过可用 RAM ${ram_total_bytes} 字节的 50% —— 对资源受限的 MCU 通常不可接受，建议改局部缓冲（buffer_mode: partial）。`,
			)
		}
	} else {
		notes.push(
			`局部缓冲 ${buffer_count} 块 × ${linesPerBuffer} 行 = ${totalDrawBufferBytes} 字节。这是资源受限 MCU 的常规做法：LVGL 只重绘脏区，每块缓冲只覆盖若干行。`,
		)
		if (partial_lines !== null && partial_lines > 0 && partial_lines < vres / 20) {
			warnings.push(
				`每块缓冲只有 ${linesPerBuffer} 行（不足屏高的 5%）—— 缓冲太小会让 LVGL 把一次重绘拆成很多次 flush，驱动中断/DMA 启动开销占比升高，**表现为刷新变慢**。通常取屏高的 1/10 是比较好的起点。`,
			)
		}
	}
	if (buffer_count === 2) {
		notes.push(
			'双缓冲：驱动必须在**前一块还在传输时**就能拿到后一块（DMA 传输 + `lv_disp_flush_ready` 回调配对）。若驱动只支持"传完再回调"，双缓冲不会带来收益，反而多占一倍 RAM。',
		)
	}

	// ---- LV_MEM_SIZE：算不出来，只能给量级起点 ----
	notes.push(
		'**LV_MEM_SIZE 无法静态计算** —— 它取决于运行时创建的对象数量、每个对象的样式与文本长度。' +
			'必须用 `lv_mem_monitor()` 读实际峰值（`max_used`）后按 1.3~1.5 倍留余量设定。' +
			'下面给的是**经验起点（非计算值，不可当结论）**：简单单屏界面约 8~16 KB；多页面 + 列表 + 中文字库约 32~64 KB；复杂仪表盘到 100 KB 以上也常见。',
	)
	notes.push(
		'另一个高频坑：**中文字库会把 Flash 吃掉一大块**。一个字号的完整中文字库动辄几百 KB，务必按需裁剪（只取用到的字符集），否则体积问题会先于内存问题爆发。',
	)

	let ramUsage = null
	if (Number.isFinite(ram_total_bytes) && ram_total_bytes > 0) {
		ramUsage = {
			ramTotalBytes: ram_total_bytes,
			drawBufferBytes: totalDrawBufferBytes,
			percentOfRam: round2((totalDrawBufferBytes / ram_total_bytes) * 100),
		}
	}

	return {
		hres,
		vres,
		colorDepthBits: color_depth_bits,
		bytesPerPixel,
		fullFrameBytes,
		bufferMode: buffer_mode,
		bufferCount: buffer_count,
		linesPerBuffer,
		bufferBytes,
		totalDrawBufferBytes,
		totalDrawBufferKiB: round2(totalDrawBufferBytes / 1024),
		bandwidth,
		ramUsage,
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
