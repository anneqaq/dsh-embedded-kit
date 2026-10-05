/**
 * `sdio_speed` 工具描述符 —— 把 lib/sdio.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**，不复制、不改写 lib/sdio.js 的任何算法与常量。
 * 所有规范常量、判定逻辑与出处都留在 lib/sdio.js（其文件头登记了联网核实到的
 * SD Part 1 / Part E1 / JEDEC JESD84 出处）。
 *
 * 四个动作对应 lib 里的四组函数：
 *   throughput → analyzeSdio（= effectiveThroughput + 可选的识别阶段限速检查）
 *   modes      → SD_BUS_MODES / SD_BUS_MODE_ORDER（档位表 + 逐档算术自洽核验）
 *   init       → checkInitializationClock（识别阶段 f_OD ≤ 400 kHz）
 *   si         → assessSignalIntegrity（偏斜/负载判据 + 同家族降档建议）
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键，形状与 lib/i2c.js 一致，
 * 具体数值挂在各自动作的分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/sdio.tool
 */

import {
	analyzeSdio,
	assessSignalIntegrity,
	checkInitializationClock,
	dataPacketClocksPerBlock,
	getBusMode,
	COMMAND_TOKEN_BITS,
	DATA_PACKET_OVERHEAD_CLOCKS,
	INITIALIZATION_CLOCK_MAX_HZ,
	RESPONSE_BITS,
	SD_BUS_MODES,
	SD_BUS_MODE_IDS,
	SD_BUS_MODE_ORDER,
} from '../lib/sdio.js'

/** 可用的动作。 */
const ACTIONS = ['throughput', 'modes', 'init', 'si']

/** 可用的家族。 */
const FAMILIES = ['sd', 'sdio', 'emmc']

/** 采样方式说明文案。 */
const EDGE_LABEL = { 1: '单沿', 2: '双沿' }

/**
 * 字节率格式化。
 *
 * @param {number} bytesPerSecond - 字节/秒。
 * @returns {string} 形如 `35.605 MB/s`。
 */
function mbps(bytesPerSecond) {
	return `${(bytesPerSecond / 1e6).toFixed(3)} MB/s`
}

/**
 * 按显示宽度右填充（CJK 算 2 列），仅用于让 summaryLines 的表格列对齐。
 *
 * @param {string} s - 文本。
 * @param {number} width - 目标显示宽度。
 * @returns {string} 补齐后的文本。
 */
function padRight(s, width) {
	let w = 0
	for (const ch of s) w += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1
	return s + ' '.repeat(Math.max(1, width - w))
}

/* ------------------------------------------------------------------ */
/* 动作 1：throughput（有效吞吐）                                       */
/* ------------------------------------------------------------------ */

/**
 * 有效吞吐：走 lib 的总入口 analyzeSdio，顺带做（可选的）识别阶段限速检查。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runThroughput(args) {
	if (!args.mode) {
		throw new Error(`action=throughput 需要 mode（速度档 id）。可用：${SD_BUS_MODE_IDS.join(' / ')}`)
	}
	if (args.clock_hz === undefined) {
		throw new Error('action=throughput 需要 clock_hz（实际总线时钟，来自你的分频配置，不是档位上限）')
	}
	if (args.bus_width === undefined) {
		throw new Error('action=throughput 需要 bus_width（1 / 4 / 8）')
	}
	if (args.block_bytes === undefined) {
		throw new Error('action=throughput 需要 block_bytes（SD/eMMC 常见 512 或 4096）')
	}

	// 板级实测参数一律原样透传：undefined 会被 lib 记为"按 0 计 + 乐观上界告警"，
	// 这里**不补默认值** —— 替调用方猜一个"典型值"正是本模块要防的事。
	const r = analyzeSdio({
		mode: args.mode,
		clockHz: args.clock_hz,
		busWidth: args.bus_width,
		blockBytes: args.block_bytes,
		responseType: args.response_type ?? 'R1',
		blocks: args.blocks ?? 1,
		direction: args.direction ?? 'read',
		busyWaitNs: args.busy_wait_ns,
		interBlockGapNs: args.inter_block_gap_ns,
		hostOverheadNs: args.host_overhead_ns,
		identificationClockHz: args.identification_clock_hz,
	})
	return { action: 'throughput', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 2：modes（列出速率档）                                          */
/* ------------------------------------------------------------------ */

/**
 * 列出各速度档，并逐档核对规范速度与"时钟 × 位宽 × 沿数 ÷ 8"是否自洽。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runModes(args) {
	const family = args.family ?? null
	if (family !== null && !FAMILIES.includes(family)) {
		throw new Error(`family 只能是 ${FAMILIES.join(' / ')}，收到 '${family}'`)
	}

	// 给了 mode 就只看这一档（未知档位由 lib 的 getBusMode 抛错点名）；
	// 否则按 lib 的 SD_BUS_MODE_ORDER（能力从低到高）列出，可选按家族过滤。
	const ids =
		args.mode !== undefined
			? [getBusMode(args.mode).id]
			: SD_BUS_MODE_ORDER.filter((id) => family === null || SD_BUS_MODES[id].family === family)

	const modes = ids.map((id) => {
		const m = SD_BUS_MODES[id]
		const maxWidth = Math.max(...m.busWidths)
		const arithmeticMBps = (m.clockMaxHz * maxWidth * m.edgesPerClock) / 8 / 1e6
		return {
			id: m.id,
			label: m.label,
			family: m.family,
			clockMaxHz: m.clockMaxHz,
			busWidths: m.busWidths.slice(),
			maxWidth,
			edgesPerClock: m.edgesPerClock,
			signalingV: m.signalingV,
			maxBusMBps: m.maxBusMBps,
			arithmeticMBps,
			selfConsistent: Math.abs(arithmeticMBps - m.maxBusMBps) < 1e-6,
			requires1v8: m.requires1v8,
			requiresTuning: m.requiresTuning,
			requiresDataStrobe: m.requiresDataStrobe,
			note: m.note ?? null,
			source: m.source,
		}
	})

	const checks = []
	const warnings = []
	const notes = []

	const bad = modes.filter((m) => !m.selfConsistent)
	checks.push({
		name: '各档"时钟 × 位宽 × 沿数 ÷ 8"与规范表速度自洽',
		pass: bad.length === 0,
		detail:
			bad.length === 0
				? `${modes.length} 档全部自洽（速度列一律按最大位宽算的算术口径）`
				: `${bad.length} 档对不上：${bad
						.map((m) => `${m.id}（算术 ${m.arithmeticMBps} vs 表中 ${m.maxBusMBps} MB/s）`)
						.join('；')}`,
	})
	if (bad.length > 0) {
		warnings.push(
			`以下档位的规范速度与"时钟 × 位宽 × 沿数 ÷ 8"对不上：${bad.map((m) => m.id).join('、')}。` +
				'以规范原文为准，别照算术口径去估需求。',
		)
	}

	// 低速率档：流传的那张表与算术对不上，单独点名。
	const low = modes.find((m) => m.id === 'sdio-low-speed')
	if (low) {
		warnings.push(
			'SDIO Low Speed：规范只给了 f ≤ 400 kHz 与 CIS 里 "≥400 Kb/Sec" 这个下限。' +
				`按 400 kHz × 1 位算峰值 = 400 kbit/s = 50 KB/s（表中 ${low.maxBusMBps} MB/s 就是这个算术口径）。` +
				'**常见资料把这一档写成 200 KB/s，与 400 kHz 单线对不上（差 4 倍），勿直接引用。**',
		)
	}

	notes.push(
		'速度列口径：一律"时钟 × 最大位宽 × 沿数 ÷ 8"，逐档来源见 source 字段。' +
			'规范原文有时只给 bit/s（如 SDIO Full Speed "over 100 Mb/second"），折算成本工具这一列是人做的算术，不是规范原表里现成的一列。',
	)
	notes.push(
		`每块在 DAT 线上固定多出 ${DATA_PACKET_OVERHEAD_CLOCKS} 个时钟` +
			`（1 起始 + 16 CRC16 + 1 结束；规范明确"每根 DAT 线各自带起始/CRC/结束"，所以**与位宽无关**）。` +
			`这个 ${DATA_PACKET_OVERHEAD_CLOCKS} 是由规范的数据包令牌/包结构推出的，` +
			'**规范正文并未逐字写出"18"这个整数**，改档位也不会改变它。',
	)
	for (const m of modes) {
		if (m.note) notes.push(`${m.id}：${m.note}`)
	}

	return {
		action: 'modes',
		family,
		mode: args.mode ?? null,
		count: modes.length,
		initClockMaxHz: INITIALIZATION_CLOCK_MAX_HZ,
		commandTokenBits: COMMAND_TOKEN_BITS,
		responseBits: { ...RESPONSE_BITS },
		packetOverheadClocks: DATA_PACKET_OVERHEAD_CLOCKS,
		modes,
		checks,
		warnings,
		notes,
	}
}

/* ------------------------------------------------------------------ */
/* 动作 3：init（识别阶段时钟校验）                                      */
/* ------------------------------------------------------------------ */

/**
 * 识别阶段（或传输阶段）的时钟校验。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runInit(args) {
	if (args.clock_hz === undefined) {
		throw new Error('action=init 需要 clock_hz（该阶段实际使用的时钟）')
	}
	const phase = args.phase ?? 'identification'
	if (phase !== 'identification' && phase !== 'transfer') {
		throw new Error(`phase 只能是 identification（默认）或 transfer，收到 '${phase}'`)
	}
	return { action: 'init', ...checkInitializationClock({ clockHz: args.clock_hz, phase }) }
}

/* ------------------------------------------------------------------ */
/* 动作 4：si（信号完整性降速建议）                                      */
/* ------------------------------------------------------------------ */

/**
 * 信号完整性判据与降档建议。所有限值都来自调用方，本工具不内置阈值。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runSi(args) {
	if (!args.mode) {
		throw new Error(`action=si 需要 mode（速度档 id）。可用：${SD_BUS_MODE_IDS.join(' / ')}`)
	}
	return {
		action: 'si',
		...assessSignalIntegrity({
			mode: args.mode,
			busWidth: args.bus_width,
			propagationPsPerMm: args.propagation_ps_per_mm,
			traceMismatchMm: args.trace_mismatch_mm,
			maxSkewPs: args.max_skew_ps,
			loadPf: args.load_pf,
			maxLoadPf: args.max_load_pf,
		}),
	}
}

/* ------------------------------------------------------------------ */
/* 分派                                                                */
/* ------------------------------------------------------------------ */

/** 动作 → 实现。 */
const RUNNERS = {
	throughput: runThroughput,
	modes: runModes,
	init: runInit,
	si: runSi,
}

/**
 * 同步分派。`execute` 只是它的 async 外壳。
 *
 * 单独导出是为了让自测能在**同步**用例里覆盖每个动作分支（含未知 action 的报错），
 * 而不必依赖宿主 test 实现是否 await 返回的 Promise。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 * @throws {Error} action 未知时抛出。
 */
export function dispatch(args) {
	const action = args.action ?? 'throughput'
	const runner = RUNNERS[action]
	if (!runner) throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
	return runner(args)
}

/* ------------------------------------------------------------------ */
/* summaryLines：各动作的具体数值行                                      */
/* ------------------------------------------------------------------ */

/**
 * throughput 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function throughputLines(v) {
	const lines = []
	lines.push(
		`  ${v.modeLabel}（${v.mode}，${v.signalingV} V，${v.busWidth} 位，` +
			`${EDGE_LABEL[v.edgesPerClock] ?? v.edgesPerClock}，${v.direction === 'write' ? '写' : '读'}）` +
			`  块 ${v.blockBytes} B × ${v.blocks} 块  ${v.responseType}(${v.responseBits} 位)`,
	)
	lines.push(`  理论峰值（裸线速率）${mbps(v.peakBytesPerSecond)}`)
	lines.push(`  有效吞吐 ${mbps(v.effectiveBytesPerSecond)}   效率 ${v.efficiencyPercent.toFixed(1)}%`)
	lines.push(
		`  时间账 ${(v.totalNs / 1000).toFixed(2)} µs = 命令 ${(v.cmdNs / 1000).toFixed(2)}` +
			` + 数据 ${(v.dataNs / 1000).toFixed(2)} + 忙等 ${(v.busyTotalNs / 1000).toFixed(2)}` +
			` + 块间 ${(v.gapTotalNs / 1000).toFixed(2)} + 主机 ${(v.hostOverheadNs / 1000).toFixed(2)} µs`,
	)
	lines.push(`  命令/响应占本次事务时间 ${v.cmdSharePercent.toFixed(1)}%`)
	lines.push(
		`  每块 DAT 线开销 ${DATA_PACKET_OVERHEAD_CLOCKS} 时钟（每根线各一份，与位宽无关）：` +
			`本例 ${v.blocks} 块共 ${(dataPacketClocksPerBlock(v.blockBytes, v.busWidth) * v.blocks).toFixed(0)} 个数据时钟，` +
			`承载 ${v.blockBytes * v.blocks} B 净荷`,
	)
	if (v.identification) {
		const c = v.identification.checks[0]
		lines.push(
			`  识别阶段 f_OD = ${(v.identification.clockHz / 1000).toFixed(1)} kHz → ${c.pass ? '通过' : '不通过'}（${c.detail}）`,
		)
	}
	return lines
}

/**
 * modes 的档位表行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function modesLines(v) {
	const lines = [
		'  ' +
			padRight('档位 id', 22) +
			padRight('时钟上限', 16) +
			padRight('位宽', 8) +
			padRight('采样', 7) +
			padRight('信令', 8) +
			'规范速率',
	]
	for (const m of v.modes) {
		lines.push(
			'  ' +
				padRight(m.id, 22) +
				padRight(`${(m.clockMaxHz / 1e6).toFixed(3)} MHz`, 16) +
				padRight(`${m.busWidths.join('/')} 位`, 8) +
				padRight(EDGE_LABEL[m.edgesPerClock] ?? `${m.edgesPerClock} 沿`, 7) +
				padRight(`${m.signalingV} V`, 8) +
				`${m.maxBusMBps} MB/s`,
		)
	}
	return lines
}

/**
 * init 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function initLines(v) {
	return [
		`  阶段：${v.phase === 'identification' ? '识别阶段（Card Identification Mode）' : '传输阶段（Data Transfer Mode）'}`,
		`  实际时钟 ${(v.clockHz / 1000).toFixed(1)} kHz（f_OD 上限 ${(v.initClockMaxHz / 1000).toFixed(0)} kHz）`,
	]
}

/**
 * si 的具体数值行。未给限值的地方如实写"未给"，不补数字。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function siLines(v) {
	const has = (x) => x !== null && x !== undefined
	return [
		has(v.skewPs)
			? `  组内偏斜 ${v.skewPs.toFixed(1)} ps（手册上限 ${has(v.maxSkewPs) ? `${v.maxSkewPs} ps` : '未给'}）`
			: '  组内偏斜：未换算（缺 propagation_ps_per_mm 或 trace_mismatch_mm）',
		has(v.loadPf)
			? `  负载电容 ${v.loadPf} pF（手册上限 ${has(v.maxLoadPf) ? `${v.maxLoadPf} pF` : '未给'}）`
			: '  负载电容：未给实测/估算值',
		v.suggestedDowngrade
			? `  降档建议：先退到 ${v.suggestedDowngrade}（${SD_BUS_MODES[v.suggestedDowngrade].label}）复测`
			: '  降档建议：无（没有判定出超限项，或本来就已是最低档）',
	]
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
	name: 'sdio_speed',
	title: 'SD / SDIO / eMMC 总线速率档与有效吞吐（令牌开销 / 识别限速 / 降档建议）',
	description:
		'SD / SDIO / eMMC 的总线速率档、实际吞吐与降速判据（口径：SD Association《SD Specifications Part 1 Physical Layer Simplified Specification》3.01/4.10/7.10、《Part E1 SDIO Simplified Specification》2.1、JEDEC JESD84 Bus Speed Mode 表）。' +
		'四种动作：' +
		'① action=throughput（有效吞吐）：给速度档 + 实际时钟 + 位宽 + 块大小（可选 blocks / direction / response_type / R1~R7），算出理论峰值，再扣掉命令与响应（CMD 线 1 位/时钟）、块内每根 DAT 线各一份的起始/CRC16/结束开销、写方向 DAT0 忙等待、块间空隙、主机每事务开销，得到有效吞吐与效率并给出开销占比归因；另给了 identification_clock_hz 就附带做识别阶段限速检查。' +
		'② action=modes（列出速率档）：按能力从低到高列出各档的时钟上限/允许位宽/单双沿/信令电压/规范总线速率与出处，并逐档核对"时钟 × 最大位宽 × 沿数 ÷ 8"与规范表是否自洽（可选 family=sd|sdio|emmc 过滤，或给 mode 只看一档）。' +
		'③ action=init（识别阶段时钟校验）：按规范 f_OD ≤ 400 kHz 判定识别阶段是否超速（phase=transfer 则反向判定是否忘了提速）。' +
		'④ action=si（信号完整性降速建议）：在调用方给出的组内偏斜上限与负载电容上限**之内**做比较，超限时按同家族退一档给建议。' +
		'返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 每项形如 { name, pass, detail }）。' +
		'硬约束（请如实对待）：' +
		'（1）**命令/响应往返延迟、写方向 DAT0 忙等待、块间空隙、主机每事务开销一律不内置默认值**——不传就按 0 计入并在 notes 里明确标注结果是**乐观上界**（真实值只会更低），绝不替你猜一个"典型值"；' +
		'（2）偏斜上限 max_skew_ps 与负载上限 max_load_pf 必须来自你的 SoC / 存储器手册，**不给就不判定**（返回 0 条 checks），本工具不臆造阈值；' +
		'（3）每块固定带 18 个时钟的起始位 + CRC16 + 结束位开销（每根 DAT 线各一份，**与位宽无关**），这是"位宽翻 4 倍不等于吞吐翻 4 倍"的根源之一；该 18 系由规范的数据包令牌/包结构推出，**规范正文未逐字写出"18"**；' +
		'（4）输出全部是**设计值**：不含控制器分频取整、FIFO 停顿、卡内部读写延迟与重传，真机吞吐必须用逻辑分析仪/总线分析仪实测对齐；' +
		'（5）常见资料里那张 SDIO 低速率表把 Low Speed 写成 200 KB/s，与 400 kHz × 1 位 = 50 KB/s 的算术对不上，本模块一律取"时钟 × 位宽 ÷ 8"口径并单独加告警。',
	parameters: {
		action: {
			type: 'string',
			required: true,
			enum: ACTIONS,
			description:
				'throughput=有效吞吐（需 mode + clock_hz + bus_width + block_bytes）；' +
				'modes=列出速率档与逐档算术自洽核验；init=识别阶段时钟校验（需 clock_hz）；' +
				'si=信号完整性降速建议（需 mode，限值可选）。',
		},
		mode: {
			type: 'string',
			enum: SD_BUS_MODE_IDS,
			description:
				'速度档 id。throughput / si 必填；modes 给了就只看这一档。' +
				'含 SD 家族（sd-default-speed / sd-high-speed / sdr12 / sdr25 / sdr50 / sdr104 / ddr50）、' +
				'SDIO 家族（sdio-low-speed / sdio-full-speed / sdio-high-speed）、' +
				'eMMC 家族（emmc-legacy / emmc-high-speed-sdr / emmc-high-speed-ddr / hs200 / hs400 / hs400es）。',
		},
		clock_hz: {
			type: 'integer',
			description:
				'实际总线时钟（Hz），来自你的分频配置——**不是档位上限**。超过该档规范上限会被判不通过并告警。throughput / init 必填。',
		},
		bus_width: {
			type: 'integer',
			enum: [1, 4, 8],
			description: '总线位宽。超出该档规范允许范围会被判不通过并告警（如 HS400 只支持 8 位）。throughput 必填，si 可选。',
		},
		block_bytes: {
			type: 'integer',
			description: '块大小（字节），SD/eMMC 常见 512 或 4096。throughput 必填。',
		},
		blocks: {
			type: 'integer',
			description:
				'单次事务的块数，默认 1（单块命令）。多块只付一次命令开销，但每块仍各付 18 个时钟的起始/CRC/结束开销，块间空隙按 (blocks − 1) 计。',
		},
		direction: {
			type: 'string',
			enum: ['read', 'write'],
			description:
				'方向，默认 read。write 会提示 DAT0 忙等待是最容易被低估的一项（卡内部写 NAND 的时长随内容/磨损/温度变化，必须实测）。',
		},
		response_type: {
			type: 'string',
			enum: Object.keys(RESPONSE_BITS),
			description:
				`响应类型，默认 R1。R2 = 136 位（CMD2/CMD9 的 CID/CSD），R1/R1b/R3/R4/R5/R6/R7 = 48 位。`,
		},
		busy_wait_ns: {
			type: 'integer',
			description:
				'**每块**的忙等待（ns）。**必须实测**（写方向尤其重要），本工具不内置默认值；不传按 0 计并告警"乐观上界"。',
		},
		inter_block_gap_ns: {
			type: 'integer',
			description: '**相邻块之间**的空隙（ns）。**必须实测**，不传按 0 计并告警；单块（blocks=1）时为 0 处，不影响结果。',
		},
		host_overhead_ns: {
			type: 'integer',
			description:
				'**每事务一次**的主机/DMA 开销（ns）。**必须实测**，不传按 0 计并告警。小块高频事务时它主导效率，总线越快它的相对占比越大。',
		},
		identification_clock_hz: {
			type: 'integer',
			description: '识别阶段实际使用的时钟（Hz）。给了就在 throughput 里附带做 f_OD ≤ 400 kHz 检查；不给则只出提醒。',
		},
		phase: {
			type: 'string',
			enum: ['identification', 'transfer'],
			description:
				'仅 action=init 有效：identification（默认）判定 ≤ 400 kHz；transfer 判定是否已脱离识别限速（忘了提速会让吞吐低一到两个数量级）。',
		},
		propagation_ps_per_mm: {
			type: 'number',
			description: '走线单位传播延迟（ps/mm），板级参数。**必传才做偏斜换算**（与 trace_mismatch_mm 配对）。仅 action=si 有效。',
		},
		trace_mismatch_mm: {
			type: 'number',
			description: '组内（CLK/CMD/DAT）最大长度差（mm），实测或设计值。偏斜 = 长度差 × 单位传播延迟。仅 action=si 有效。',
		},
		max_skew_ps: {
			type: 'number',
			description:
				'主控手册给出的组内偏斜上限（ps）。**必须查 SoC 手册填入，本工具不内置阈值**；不给就不做偏斜判定。仅 action=si 有效。',
		},
		load_pf: {
			type: 'number',
			description: '该组信号总负载电容（pF），含走线、卡座、ESD 器件与卡本身。仅 action=si 有效。',
		},
		max_load_pf: {
			type: 'number',
			description: '器件手册给出的负载上限（pF）。**必须查手册填入，本工具不内置阈值**；不给就不做负载判定。仅 action=si 有效。',
		},
		family: {
			type: 'string',
			enum: FAMILIES,
			description: '仅 action=modes 有效：只列该家族的档位。不传则列出全部。',
		},
	},
	/**
	 * 按 action 分派到 lib/sdio.js 的对应函数。
	 *
	 * @param {object} args - 模型传入的参数。
	 * @returns {Promise<object>} 含 checks / warnings / notes 的结果。
	 */
	async execute(args) {
		return dispatch(args)
	},
	/**
	 * 供渲染层展示的具体数值行。
	 *
	 * @param {object} v - execute 的返回值。
	 * @returns {string[]} 文本行。
	 */
	summaryLines(v) {
		if (!v || typeof v !== 'object') return []
		if (v.action === 'throughput') return throughputLines(v)
		if (v.action === 'modes') return modesLines(v)
		if (v.action === 'init') return initLines(v)
		if (v.action === 'si') return siLines(v)
		return []
	},
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测与文档使用：本工具支持的动作。 */
export const TOOL_ACTIONS = ACTIONS

/** 供自测使用：lib 里被本工具用到的函数，便于确认映射完整。 */
export const MAPPED_FUNCTIONS = {
	throughput: [analyzeSdio],
	modes: [getBusMode],
	init: [checkInitializationClock],
	si: [assessSignalIntegrity],
	helpers: [dataPacketClocksPerBlock],
}
