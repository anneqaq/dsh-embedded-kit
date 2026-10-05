/**
 * `sdio_speed` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './sdio.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖三类东西：
 *   ① lib/sdio.js 里**联网核实过的规范基准向量**——命令令牌 48 位、响应 48/136 位、
 *      数据包每线 18 时钟、识别阶段 f_OD ≤ 400 kHz、各档"时钟 × 位宽 × 沿数 ÷ 8"；
 *   ② probe/sdio.probe.mjs 里跑过的真实基准——SDR50 512 B 效率 71.2%、4 KB 效率 95.2%、
 *      HS400 400 MB/s 峰值、位宽 ×4 ≠ 吞吐 ×4、大块少事务优于多块小事务；
 *   ③ 工具描述符的形状，以及负向用例（缺参数/非法配置必须报错点名，缺手册限值不许臆造阈值）。
 *
 * 用例全部是**同步**的，走 integrate/sdio.tool.mjs 导出的 `dispatch`（execute 的同步内核），
 * 这样不依赖宿主 test 实现是否 await。用例只读，不修改 lib 中任何东西。
 *
 * @module dsh-embedded-kit/integrate/sdio.cases
 */

import {
	checkInitializationClock,
	commandPhaseClocks,
	dataPacketClocksPerBlock,
	effectiveThroughput,
	getBusMode,
	peakThroughput,
	assessSignalIntegrity,
	suggestDowngrade,
	COMMAND_TOKEN_BITS,
	DATA_PACKET_OVERHEAD_CLOCKS,
	INITIALIZATION_CLOCK_MAX_HZ,
	RESPONSE_BITS,
	SD_BUS_MODES,
	SD_BUS_MODE_IDS,
	SD_BUS_MODE_ORDER,
} from '../lib/sdio.js'

import { dispatch, tool, PARAM_NAMES, TOOL_ACTIONS } from './sdio.tool.mjs'

/** 探针里用过的板级实测示例值（**演示值**，换成你板子的实测数才有意义）。 */
const BOARD = { hostOverheadNs: 3000, interBlockGapNs: 300 }

/** SDR50 4 位 @ 100 MHz 单块读的公共参数（直接调 lib，camelCase）。 */
const SDR50_BASE = { mode: 'sdr50', clockHz: 100e6, busWidth: 4, direction: 'read', responseType: 'R1' }

/** 同上，但走工具描述符时的入参（工具的对外参数是 snake_case）。 */
const SDR50_ARGS = {
	action: 'throughput',
	mode: 'sdr50',
	clock_hz: 100e6,
	bus_width: 4,
	block_bytes: 512,
	direction: 'read',
	response_type: 'R1',
	host_overhead_ns: BOARD.hostOverheadNs,
	inter_block_gap_ns: BOARD.interBlockGapNs,
}

/**
 * 浮点近似断言。
 *
 * @param {number} actual - 实际值。
 * @param {number} expected - 期望值。
 * @param {number} tol - 容差。
 * @param {string} msg - 断言说明。
 */
function near(actual, expected, tol, msg) {
	assert.ok(Math.abs(actual - expected) <= tol, `${msg}：期望 ${expected} ±${tol}，实际 ${actual}`)
}

/** 供 register 内部各用例复用。 */
let assert

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert: nodeAssert }) {
	assert = nodeAssert

	/* ── ① 规范基准向量 ─────────────────────────────────────────── */

	test('规范基准：命令令牌 48 位、R1/R3/R6 48 位、R2 136 位', () => {
		assert.equal(COMMAND_TOKEN_BITS, 48)
		assert.equal(RESPONSE_BITS.R1, 48)
		assert.equal(RESPONSE_BITS.R1b, 48)
		assert.equal(RESPONSE_BITS.R3, 48)
		assert.equal(RESPONSE_BITS.R6, 48)
		assert.equal(RESPONSE_BITS.R2, 136)
		// 结构自洽：1 起始 + 1 传输位 + 6 命令号 + 32 参数 + 7 CRC7 + 1 结束 = 48
		assert.equal(commandPhaseClocks('R1').totalClocks, 96)
		// R2 比 R1 长 88 位（CMD2/CMD9 的 CID/CSD）
		assert.equal(commandPhaseClocks('R2').totalClocks - commandPhaseClocks('R1').totalClocks, 88)
	})

	test('规范基准：数据包每线开销 18 时钟 = 1 起始 + 16 CRC16 + 1 结束，且与位宽无关', () => {
		// 【标注保留】这个 18 是**由规范的数据包令牌/包结构推出的**：
		//   “Start and end bits, as well as the CRC bits, are transmitted for every one of
		//    the DAT lines.” —— 每根 DATA 线各自带起始位 + CRC16 + 结束位，
		//   故 1 + 16 + 1 = 18 个时钟，且**与位宽无关**（4 根线并行发，仍占 18 个时钟）。
		//   规范正文**并未逐字给出"18"这个整数**，别把 18 当成规范原文引用。
		assert.equal(DATA_PACKET_OVERHEAD_CLOCKS, 18)
		assert.equal(DATA_PACKET_OVERHEAD_CLOCKS, 1 + 16 + 1)
		// 位宽只影响净荷部分：4 位 @ 512 B = 1024 + 18 = 1042 个时钟
		assert.equal(dataPacketClocksPerBlock(512, 4), 1042)
		assert.equal(dataPacketClocksPerBlock(4096, 4), 8210)
		// 任意两个位宽的差，恰好等于净荷时钟之差（证明开销那一项不随位宽变）
		for (const [a, b] of [
			[1, 4],
			[4, 8],
			[1, 8],
		]) {
			assert.equal(
				dataPacketClocksPerBlock(512, a) - dataPacketClocksPerBlock(512, b),
				(512 * 8) / a - (512 * 8) / b,
				`${a} 位与 ${b} 位的差应只剩净荷项`,
			)
		}
	})

	test('规范基准：识别阶段上限 f_OD = 400 kHz；R2 单条在 f_OD 下需 460 µs', () => {
		assert.equal(INITIALIZATION_CLOCK_MAX_HZ, 400_000)
		assert.equal(INITIALIZATION_CLOCK_MAX_HZ, 400e3)
		near(((COMMAND_TOKEN_BITS + RESPONSE_BITS.R2) / 400e3) * 1e6, 460, 1e-6, '识别阶段 R2 单条命令的代价')
		// 识别阶段 400 kHz 恰好踩在上限上 → 通过；25 MHz 超速 → 不通过
		assert.equal(checkInitializationClock({ clockHz: 400e3 }).checks[0].pass, true)
		assert.equal(checkInitializationClock({ clockHz: 25e6 }).checks[0].pass, false)
		// 超速时要说明"有的卡能认、有的卡认不到"这类偶发现象
		assert.ok(checkInitializationClock({ clockHz: 25e6 }).warnings[0].includes('偶发'))
	})

	test('档位表自洽：16 档逐档"时钟 × 最大位宽 × 沿数 ÷ 8" == 规范速率；HS400 = 400 MB/s', () => {
		assert.equal(SD_BUS_MODE_IDS.length, 16)
		assert.equal(SD_BUS_MODE_ORDER.length, 16)
		for (const id of SD_BUS_MODE_IDS) {
			const m = SD_BUS_MODES[id]
			const arithmetic = (m.clockMaxHz * Math.max(...m.busWidths) * m.edgesPerClock) / 8 / 1e6
			near(arithmetic, m.maxBusMBps, 1e-6, `${id} 的规范速率与算术口径应对得上`)
		}
		assert.equal(SD_BUS_MODES.hs400.maxBusMBps, 400)
		assert.equal(peakThroughput({ clockHz: 200e6, busWidth: 8, edgesPerClock: 2 }).bytesPerSecond / 1e6, 400)
		assert.equal(SD_BUS_MODES.sdr50.maxBusMBps, 50)
		near(peakThroughput({ clockHz: 100e6, busWidth: 4 }).bytesPerSecond / 1e6, 50, 1e-9, 'SDR50 峰值')
		// HS400 只支持 8 位（规范硬约束）
		assert.deepEqual(SD_BUS_MODES.hs400.busWidths, [8])
		assert.equal(SD_BUS_MODES.hs400.requiresDataStrobe, true)
	})

	test('SDIO Low Speed：算术口径 0.05 MB/s，与流传的 200 KB/s 差 4 倍（标注保留）', () => {
		// 【标注保留】广为流传的一张 SDIO 表把 Low Speed 写成 "400 kHz / 200 KB/s"，
		//   这与 400 kHz × 1 位 = 400 kbit/s = 50 KB/s 算不出来；规范（Part E1）里
		//   只有"卡须支持 0~400 kHz"与 CIS 元组 "≥400 Kb/Sec" 这个下限，
		//   并没有 200 KB/s 这个峰值。本模块一律取"时钟 × 位宽 ÷ 8"的算术口径。
		const low = SD_BUS_MODES['sdio-low-speed']
		assert.equal(low.clockMaxHz, 400e3)
		assert.deepEqual(low.busWidths, [1])
		assert.equal(low.maxBusMBps, 0.05)
		const peak = peakThroughput({ clockHz: 400e3, busWidth: 1, edgesPerClock: 1 })
		assert.equal(peak.bitsPerSecond, 400e3)
		assert.equal(peak.bytesPerSecond, 50_000) // = 50 KB/s
		near(peak.bytesPerSecond / 1e6, low.maxBusMBps, 1e-12, '表中 0.05 MB/s 就是该算术口径')
		// 流传值 200 KB/s 与算术值差 4 倍
		assert.equal(200_000 / peak.bytesPerSecond, 4)
		// lib 的 note 里已经把这条差异写清楚了（对外必须可见）
		assert.ok(low.note.includes('200 KB/s'))
	})

	/* ── ② probe 里跑过的真实基准 ────────────────────────────────── */

	test('基准（probe）：SDR50 4 位 100 MHz / 512 B 效率 71.2%、4 KB 效率 95.2%', () => {
		const a512 = effectiveThroughput({ ...SDR50_BASE, blockBytes: 512, blocks: 1, ...BOARD })
		const a4k = effectiveThroughput({ ...SDR50_BASE, blockBytes: 4096, blocks: 1, ...BOARD })

		near(a512.efficiencyPercent, 71.2, 0.05, 'SDR50 512 B 效率')
		near(a512.effectiveBytesPerSecond / 1e6, 35.605, 0.001, 'SDR50 512 B 有效吞吐')
		near(a4k.efficiencyPercent, 95.2, 0.05, 'SDR50 4 KB 效率')
		near(a4k.effectiveBytesPerSecond / 1e6, 47.595, 0.001, 'SDR50 4 KB 有效吞吐')

		// 时间账：960 ns 命令 + 10420 ns 数据 + 3000 ns 主机 = 14380 ns
		near(a512.totalNs, 14_380, 1e-6, '512 B 事务总时间')
		near(a512.cmdNs, 960, 1e-6, '命令/响应阶段时间')
		assert.equal(a512.peakBytesPerSecond / 1e6, 50)
		// 512 B 跌破 80% → 命中开销归因告警；4 KB 不触发
		assert.ok(a512.warnings.some((w) => w.includes('有效效率只有')))
		assert.ok(!a4k.warnings.some((w) => w.includes('有效效率只有')))
	})

	test('基准（probe）：eMMC HS400 8 位 200 MHz 双沿 = 400 MB/s 峰值（有效吞吐受固定开销限制）', () => {
		const mmc = { busWidth: 8, clockHz: 200e6, direction: 'read', responseType: 'R1', blockBytes: 4096, blocks: 1, ...BOARD }
		const hs200 = effectiveThroughput({ ...mmc, mode: 'hs200' })
		const hs400 = effectiveThroughput({ ...mmc, mode: 'hs400' })

		assert.equal(hs400.peakBytesPerSecond / 1e6, 400)
		assert.equal(hs200.peakBytesPerSecond / 1e6, 200)
		near(hs400.effectiveBytesPerSecond / 1e6, 297.566, 0.001, 'HS400 4 KB 有效吞吐')
		near(hs400.efficiencyPercent, 74.4, 0.05, 'HS400 4 KB 效率')
		// 峰值翻倍，但固定开销（3 µs 主机 + 命令）吃掉差额 → 有效吞吐提升不到 2 倍
		assert.ok(hs400.effectiveBytesPerSecond > hs200.effectiveBytesPerSecond)
		assert.ok(hs400.effectiveBytesPerSecond / hs200.effectiveBytesPerSecond < 2)
		assert.ok(hs200.notes.some((n) => n.includes('tuning')))
		assert.ok(hs400.notes.some((n) => n.includes('Data Strobe')))
	})

	test('位宽 ×4 不等于吞吐 ×4（命令与每线 18 时钟开销不随位宽摊薄）', () => {
		const hs = { mode: 'sd-high-speed', clockHz: 50e6, direction: 'read', responseType: 'R1', ...BOARD }
		const w1 = effectiveThroughput({ ...hs, busWidth: 1, blockBytes: 512, blocks: 1 })
		const w4 = effectiveThroughput({ ...hs, busWidth: 4, blockBytes: 512, blocks: 1 })
		// 理论峰值严格 ×4
		assert.equal(w4.peakBytesPerSecond / w1.peakBytesPerSecond, 4)
		// 有效吞吐只有约 3.39×：差的这一截来自命令/主机开销与每线 18 时钟的 CRC 开销
		const ratio = w4.effectiveBytesPerSecond / w1.effectiveBytesPerSecond
		near(ratio, 3.385, 0.005, '4 位相对 1 位的有效吞吐比值')
		assert.ok(ratio < 4, `有效吞吐比值应小于 4×，实际 ${ratio}`)
	})

	test('"大块少事务"优于"多块小事务"：1 × 4 KB 仍胜过 8 × 512 B（即使块间空隙清零）', () => {
		const b4k = effectiveThroughput({ ...SDR50_BASE, blockBytes: 4096, blocks: 1, ...BOARD })
		const multi8Gap = effectiveThroughput({ ...SDR50_BASE, blockBytes: 512, blocks: 8, ...BOARD })
		const multi8NoGap = effectiveThroughput({ ...SDR50_BASE, blockBytes: 512, blocks: 8, hostOverheadNs: 3000, interBlockGapNs: 0 })

		// 块间空隙越大，多块方案越吃亏
		assert.ok(multi8Gap.effectiveBytesPerSecond < multi8NoGap.effectiveBytesPerSecond)
		// 但即便把空隙清零，1 × 4 KB 仍略优：每块固定 18 个时钟开销，8 块付 8 次
		assert.ok(b4k.effectiveBytesPerSecond > multi8NoGap.effectiveBytesPerSecond)
		assert.equal(8 * DATA_PACKET_OVERHEAD_CLOCKS, 144)
		assert.equal(multi8NoGap.gapTotalNs, 0)
		near(multi8NoGap.effectiveBytesPerSecond / 1e6, 46.908, 0.001, '8 × 512 B（空隙按 0）')
	})

	/* ── ③ 工具描述符形状 ───────────────────────────────────────── */

	test('工具形状：name=sdio_speed、参数 ≤ 20 个且都有中文描述、四动作齐备', () => {
		assert.equal(tool.name, 'sdio_speed')
		assert.equal(typeof tool.title, 'string')
		assert.ok(tool.title.length > 0)
		assert.equal(typeof tool.description, 'string')
		assert.ok(tool.description.length > 200, 'description 应说清做什么/要什么输入/给什么输出/硬约束')
		assert.equal(typeof tool.execute, 'function')
		assert.equal(typeof tool.summaryLines, 'function')

		// 参数数量硬约束
		assert.ok(PARAM_NAMES.length <= 20, `参数不得超过 20 个，实际 ${PARAM_NAMES.length}`)
		for (const name of PARAM_NAMES) {
			const p = tool.parameters[name]
			assert.ok(typeof p.type === 'string', `${name} 缺少 type`)
			assert.ok(typeof p.description === 'string' && p.description.length > 0, `${name} 缺少中文说明`)
			assert.ok(/[\u4e00-\u9fff]/.test(p.description), `${name} 的说明应为中文`)
		}
		// action 的 enum 与实现的动作表一致，且四个建议动作都在
		assert.deepEqual(tool.parameters.action.enum, TOOL_ACTIONS)
		assert.deepEqual(TOOL_ACTIONS.slice().sort(), ['init', 'modes', 'si', 'throughput'])
		assert.equal(tool.parameters.action.required, true)
	})

	test('工具形状：四个动作都返回 { checks, warnings, notes }，且 summaryLines 出具体数值行', () => {
		const branches = [
			dispatch({ ...SDR50_ARGS }),
			dispatch({ action: 'modes' }),
			dispatch({ action: 'init', clock_hz: 400e3 }),
			dispatch({ action: 'si', mode: 'sdr104' }),
		]
		for (const v of branches) {
			assert.ok(Array.isArray(v.checks), `${v.action} 的 checks 应为数组`)
			assert.ok(Array.isArray(v.warnings), `${v.action} 的 warnings 应为数组`)
			assert.ok(Array.isArray(v.notes), `${v.action} 的 notes 应为数组`)
			const lines = tool.summaryLines(v)
			assert.ok(Array.isArray(lines) && lines.length > 0, `${v.action} 应渲染出具体数值行`)
			assert.ok(lines.every((l) => typeof l === 'string'), `${v.action} 的数值行应全是字符串`)
		}
		// throughput 的数值行里要有峰值/有效吞吐/效率这几个关键数
		const tp = tool.summaryLines(dispatch({ ...SDR50_ARGS }))
		const text = tp.join('\n')
		assert.ok(text.includes('理论峰值'))
		assert.ok(text.includes('有效吞吐'))
		assert.ok(text.includes('71.2%'))
		// 未识别的 action / 非对象一律返回空数组，不抛错
		assert.deepEqual(tool.summaryLines({ action: 'nope' }), [])
		assert.deepEqual(tool.summaryLines(null), [])
	})

	test('modes 动作：按能力从低到高列出 16 档，并单独告警 SDIO 低速率表与算术对不上', () => {
		const all = dispatch({ action: 'modes' })
		assert.equal(all.count, 16)
		assert.equal(all.packetOverheadClocks, DATA_PACKET_OVERHEAD_CLOCKS)
		assert.equal(all.commandTokenBits, COMMAND_TOKEN_BITS)
		assert.deepEqual(all.modes.map((m) => m.id), SD_BUS_MODE_ORDER)
		assert.ok(all.modes.every((m) => m.selfConsistent))
		assert.equal(all.checks[0].pass, true)

		// 低速率表的差异必须单列一条 warning（对外可见，不是埋在 note 里）
		assert.ok(
			all.warnings.some((w) => w.includes('200 KB/s')),
			`应告警流传表的 200 KB/s 与算术对不上：${all.warnings.join(' | ')}`,
		)
		// 18 时钟的"由规范图形推出、正文未逐字给出"这一标注必须保留在输出里
		assert.ok(all.notes.some((n) => n.includes('未逐字写出')))
		// 各档自带的 note（1.8 V / tuning / Data Strobe 等）也要带出来
		assert.ok(all.notes.some((n) => n.includes('tuning')))

		// 按家族过滤
		assert.equal(dispatch({ action: 'modes', family: 'sdio' }).count, 3)
		assert.equal(dispatch({ action: 'modes', family: 'emmc' }).count, 6)
		assert.equal(dispatch({ action: 'modes', family: 'sd' }).count, 7)
		// 只看一档
		const one = dispatch({ action: 'modes', mode: 'hs400' })
		assert.equal(one.count, 1)
		assert.equal(one.modes[0].maxBusMBps, 400)
		// SDIO 低速率档不在 sd 家族里 → 不出现那条告警
		assert.ok(!dispatch({ action: 'modes', family: 'sd' }).warnings.some((w) => w.includes('200 KB/s')))
	})

	test('si 动作：给了手册限值才判定，超限时按同家族给降档建议', () => {
		const r = dispatch({
			action: 'si',
			mode: 'sdr104',
			bus_width: 4,
			propagation_ps_per_mm: 6.6,
			trace_mismatch_mm: 5,
			max_skew_ps: 30,
			load_pf: 25,
			max_load_pf: 20,
		})
		near(r.skewPs, 33, 1e-6, '组内偏斜 = 5 mm × 6.6 ps/mm')
		assert.equal(r.checks[0].pass, false)
		assert.equal(r.checks[1].pass, false)
		assert.equal(r.suggestedDowngrade, 'sdr50')
		assert.ok(r.notes.some((n) => n.includes('降档建议')))
		// 降档绝不跨家族
		assert.equal(SD_BUS_MODES[suggestDowngrade('sdr104')].family, 'sd')
		// 余量充足时全部通过
		const good = dispatch({
			action: 'si',
			mode: 'sdr50',
			bus_width: 4,
			propagation_ps_per_mm: 6.6,
			trace_mismatch_mm: 1,
			max_skew_ps: 50,
			load_pf: 15,
			max_load_pf: 20,
		})
		assert.ok(good.checks.every((c) => c.pass))
		assert.equal(good.warnings.length, 0)
		assert.equal(good.suggestedDowngrade, null)
	})

	/* ── ④ 负向用例 ─────────────────────────────────────────────── */

	test('负向：HS400 配 4 位总线被判不合法并告警（规范只支持 8 位）', () => {
		const mmc = { busWidth: 4, clockHz: 200e6, direction: 'read', responseType: 'R1', blockBytes: 4096, blocks: 1, ...BOARD }
		const r = effectiveThroughput({ ...mmc, mode: 'hs400' })
		assert.equal(r.checks[0].pass, false)
		assert.equal(r.checks[0].name, '总线位宽在该档允许范围内')
		assert.ok(r.warnings.length > 0)
		// 走工具同一条路径
		const viaTool = dispatch({ action: 'throughput', mode: 'hs400', clock_hz: 200e6, bus_width: 4, block_bytes: 4096 })
		assert.equal(viaTool.checks[0].pass, false)
	})

	test('负向：SDR50 跑 200 MHz 被判超规范上限并告警', () => {
		const r = effectiveThroughput({ ...SDR50_BASE, blockBytes: 512, blocks: 1, clockHz: 200e6 })
		assert.equal(r.checks[1].pass, false)
		assert.equal(r.checks[1].name, '时钟不超过该档规范上限')
		assert.ok(r.warnings.some((w) => w.includes('超过')))
	})

	test('负向：不传板级实测开销时不编数字，明确标注结果是"乐观上界"', () => {
		const r = dispatch({ ...SDR50_ARGS, host_overhead_ns: undefined, inter_block_gap_ns: undefined })
		// 三项板级参数都按 0 计（没有默认值可补）
		assert.equal(r.busyTotalNs, 0)
		assert.equal(r.gapTotalNs, 0)
		assert.equal(r.hostOverheadNs, 0)
		assert.ok(r.notes.some((n) => n.includes('未提供 busy_wait_ns')))
		assert.ok(r.notes.some((n) => n.includes('未提供 host_overhead_ns')))
		assert.ok(r.notes.some((n) => n.includes('乐观上界')))
		// 未给识别时钟要提醒，而不是假装检查过
		assert.ok(r.notes.some((n) => n.includes('identification_clock_hz')))
		// 给了识别时钟就真的带出识别阶段判定
		const withInit = dispatch({ ...SDR50_ARGS, block_bytes: 4096, identification_clock_hz: 25e6 })
		assert.ok(withInit.identification !== null)
		assert.ok(withInit.warnings.some((w) => w.includes('超过 f_OD 上限')))
	})

	test('负向：信号完整性不给手册限值时不做判定（0 条 checks，不臆造阈值）', () => {
		const r = dispatch({ action: 'si', mode: 'sdr104', bus_width: 4 })
		assert.equal(r.checks.length, 0, '不给限值就不该产生任何判定')
		assert.equal(r.warnings.length, 0)
		assert.ok(r.notes.some((n) => n.includes('不做偏斜判定')))
		assert.ok(r.notes.some((n) => n.includes('不做负载判定')))
		assert.equal(r.suggestedDowngrade, null)
		// 只给上限、不给长度差/传播延迟 → 仍然不判定，并点名缺什么（直接调 lib 用 camelCase）
		const halfGiven = assessSignalIntegrity({ mode: 'sdr104', busWidth: 4, maxSkewPs: 30, maxLoadPf: 20 })
		assert.equal(halfGiven.checks.length, 0)
		assert.ok(halfGiven.notes.some((n) => n.includes('无法把长度差换算成偏斜')))
		assert.ok(halfGiven.notes.some((n) => n.includes('无法判定')))
	})

	test('负向：缺必填参数 / 未知档位 / 非法沿数 / 未知响应类型 / 未知 action 一律报错点名', () => {
		// 工具层的必填检查
		assert.throws(() => dispatch({ action: 'throughput', clock_hz: 100e6, bus_width: 4, block_bytes: 512 }), /需要 mode/)
		assert.throws(() => dispatch({ action: 'throughput', mode: 'sdr50', bus_width: 4, block_bytes: 512 }), /需要 clock_hz/)
		assert.throws(() => dispatch({ action: 'throughput', mode: 'sdr50', clock_hz: 100e6, block_bytes: 512 }), /需要 bus_width/)
		assert.throws(() => dispatch({ action: 'throughput', mode: 'sdr50', clock_hz: 100e6, bus_width: 4 }), /需要 block_bytes/)
		assert.throws(() => dispatch({ action: 'init' }), /需要 clock_hz/)
		assert.throws(() => dispatch({ action: 'si' }), /需要 mode/)
		assert.throws(() => dispatch({ action: 'modes', family: 'nand' }), /family/)
		assert.throws(() => dispatch({ action: 'init', clock_hz: 400e3, phase: 'fast' }), /phase/)
		assert.throws(() => dispatch({ action: 'sdio-super-speed' }), /未知 action/)

		// lib 层的硬报错：不静默兜底
		assert.throws(() => getBusMode('sd-ultra-9000'), /未知的总线速度档/)
		assert.throws(() => peakThroughput({ clockHz: 100e6, busWidth: 4, edgesPerClock: 3 }), /单沿/)
		assert.throws(() => commandPhaseClocks('R99'), /未知的响应类型/)
		assert.throws(() => dataPacketClocksPerBlock(512, 0), /正数/)
		assert.throws(
			() => effectiveThroughput({ mode: 'sdr50', clockHz: 100e6, busWidth: 4, blockBytes: 512, blocks: 0 }),
			/blocks/,
		)
	})
}
