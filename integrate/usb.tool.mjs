/**
 * `usb_bandwidth` 工具描述符 —— 把 lib/usb.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**，不复制、不改写 lib/usb.js 的任何算法。
 * 所有规范出处、以及"哪些是规范常量、哪些必须实测"的分界，都留在 lib/usb.js
 * 的文件头注释里（那里逐条登记了联网核实到的 USB 2.0 条款与电气一致性条目）。
 *
 * 三个动作：
 *   bandwidth → 单端点的 (微)帧占用与吞吐
 *               periodic(中断/同步) → estimatePeriodicEndpoint
 *               bulk                → transactionBits + maxTransactionsInInterval + frameBudget
 *               control             → controlTransferBits + frameBudget
 *   fit       → 一组端点能否装进一帧 → analyzeUsbBandwidth
 *               （描述符合法性 + §5.11.3 周期上限 + 控制保留 + 批量剩余）
 *   hb        → 高带宽端点描述符自洽性 → checkHighBandwidth
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键（形状与 lib/i2c.js 一致），
 * 具体数值挂在各自的 `action` 分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/usb.tool
 */

import {
	analyzeUsbBandwidth,
	checkHighBandwidth,
	controlTransferBits,
	estimatePeriodicEndpoint,
	frameBudget,
	packetBits,
	parseWMaxPacketSize,
	transactionBits,
	INTER_PACKET_GAP_BITS,
	MAX_PACKET_SIZE,
	MIN_GAP_BITS_BY_SPEED,
	SPEC_THROUGHPUT_REFERENCE,
	TRANSFER_TYPES,
	USB_SPEEDS,
} from '../lib/usb.js'

/** 可用的动作。 */
const ACTIONS = ['bandwidth', 'fit', 'hb']

/** 速率清单，直接取自 lib。 */
const SPEED_IDS = Object.keys(USB_SPEEDS)

/** 周期性（走 estimatePeriodicEndpoint）的传输类型。 */
const PERIODIC_TYPES = new Set(['interrupt', 'isochronous'])

/** `endpoints` 数组每一项允许出现的键（camelCase，与 lib 的字段名一一对应）。 */
const ENDPOINT_KEYS = [
	'name',
	'transferType',
	'direction',
	'maxPacketBytes',
	'transactionsPerMicroframe',
	'intervalFrames',
	'intervalMicroframes',
	'wMaxPacketSizeRaw',
]

/* ------------------------------------------------------------------ */
/* 参数校验与归一化                                                     */
/* ------------------------------------------------------------------ */

/**
 * 校验并取速率 id。
 *
 * @param {unknown} speed - 入参。
 * @returns {'low'|'full'|'high'} 速率 id。
 */
function requireSpeedArg(speed) {
	if (typeof speed !== 'string' || !USB_SPEEDS[speed]) {
		throw new Error(`speed 需要 ${SPEED_IDS.join(' / ')}，收到 ${JSON.stringify(speed)}`)
	}
	return speed
}

/**
 * 校验并取传输类型。
 *
 * @param {unknown} transferType - 入参。
 * @returns {'control'|'interrupt'|'bulk'|'isochronous'} 传输类型。
 */
function requireTransferTypeArg(transferType) {
	if (typeof transferType !== 'string' || !TRANSFER_TYPES.includes(transferType)) {
		throw new Error(`transfer_type 需要 ${TRANSFER_TYPES.join(' / ')}，收到 ${JSON.stringify(transferType)}`)
	}
	return transferType
}

/**
 * 把包间延迟参数拼成 lib 要的 `gapBits`。
 *
 * lib 只在 `turnaround` 与 `hostToHost` **都**给了的时候才采用实测值，否则整体退回规范下限
 * 并在 `notes` 里点名。这里保持同一口径：只给了一个就当作没给，另外补一条 warning 说明，
 * 免得调用方以为自己给的半个值生效了。
 *
 * @param {object} args - 工具入参。
 * @param {string[]} warnings - 结果收集。
 * @returns {{turnaround: number, hostToHost: number}|undefined} lib 的 gapBits，或 undefined。
 */
function gapBitsFromArgs(args, warnings) {
	const t = args.gap_turnaround_bits
	const h = args.gap_host_to_host_bits
	if (t === undefined && h === undefined) return undefined
	if (t === undefined || h === undefined) {
		const missing = t === undefined ? 'gap_turnaround_bits' : 'gap_host_to_host_bits'
		warnings.push(
			`包间延迟必须成对给出：本次缺了 ${missing}，已按"未提供"处理，整体退回规范下限` +
				`（总线切换 ${INTER_PACKET_GAP_BITS.turnaroundMin} 位时间 / 主机连发 ` +
				`${MIN_GAP_BITS_BY_SPEED.full.hostToHost} 位时间。后者在 LS/FS 下是**反推校准值**，` +
				`不是规范原文，详见 lib/usb.js 的文件头）。`,
		)
		return undefined
	}
	return { turnaround: t, hostToHost: h }
}

/**
 * 归一化 `endpoints` 数组的一项。
 *
 * 用数组而不是嵌套 object，是为了让参数声明保持扁平；键名与 lib 的字段一一对应。
 * 出现未知键时直接报错，而不是静默忽略 —— 静默忽略会变成 `undefined` 参与算术，
 * 最后以一个看起来"算出来了"的 NaN 收场。
 *
 * @param {unknown} ep - 数组元素。
 * @param {number} index - 下标（用于报错定位）。
 * @returns {object} lib 认的端点对象。
 */
function normalizeEndpoint(ep, index) {
	if (!ep || typeof ep !== 'object' || Array.isArray(ep)) {
		throw new Error(
			`endpoints[${index}] 必须是对象，形如 ` +
				`{ transferType, direction, maxPacketBytes, transactionsPerMicroframe, intervalFrames }`,
		)
	}
	for (const key of Object.keys(ep)) {
		if (!ENDPOINT_KEYS.includes(key)) {
			throw new Error(`endpoints[${index}] 有未知键 '${key}'；允许：${ENDPOINT_KEYS.join(' / ')}`)
		}
	}
	requireTransferTypeArg(ep.transferType)

	const out = { transferType: ep.transferType }
	for (const key of ENDPOINT_KEYS) {
		if (key !== 'transferType' && ep[key] !== undefined) out[key] = ep[key]
	}
	if (out.direction !== undefined && out.direction !== 'in' && out.direction !== 'out') {
		throw new Error(`endpoints[${index}].direction 只能是 in / out`)
	}
	return out
}

/**
 * 定出单端点分析要用的包大小与每微帧事务数。
 *
 * 优先用 `wmax_packet_size_raw`（端点描述符里的原始 16 位值，bit 12..11 携带高带宽信息）；
 * 否则用 `max_packet_bytes`（缺省取该速率/类型的规范上限）与 `transactions_per_microframe`（缺省 1）。
 *
 * @param {object} args - 工具入参。
 * @param {string} speed - 速率 id。
 * @param {string} transferType - 传输类型。
 * @param {string[]} notes - 结果收集。
 * @returns {{maxPacketBytes: number, transactionsPerMicroframe: number, source: string, parsed: object|null}} 解析结果。
 */
function resolvePacketInput(args, speed, transferType, notes) {
	const spec = MAX_PACKET_SIZE[speed]?.[transferType]
	if (!spec) {
		throw new Error(`${USB_SPEEDS[speed].label} 不支持 ${transferType} 传输（规范 §5.5–§5.8）`)
	}

	if (args.wmax_packet_size_raw !== undefined) {
		const parsed = parseWMaxPacketSize(args.wmax_packet_size_raw)
		if (parsed.reservedBits !== 0) {
			notes.push(
				`wMaxPacketSize = 0x${parsed.raw.toString(16)} 的 bit 15..13 是保留位，` +
					`规范 §9.6.6 要求置 0，这里收到 ${parsed.reservedBits}。`,
			)
		}
		if (parsed.transactionsPerMicroframe === null) {
			throw new Error(
				'wMaxPacketSize 的 bit 12..11 = 11 是保留编码（规范 §9.6.6），不能出现在端点描述符里。',
			)
		}
		if (args.max_packet_bytes !== undefined || args.transactions_per_microframe !== undefined) {
			notes.push(
				'同时给了 wmax_packet_size_raw 与 max_packet_bytes / transactions_per_microframe：' +
					'以原始 16 位值为准（它才是描述符里的真实内容）。',
			)
		}
		return {
			maxPacketBytes: parsed.maxPacketBytes,
			transactionsPerMicroframe: parsed.transactionsPerMicroframe,
			source: 'wmax_packet_size_raw',
			parsed,
		}
	}

	const maxPacketBytes = args.max_packet_bytes === undefined ? spec.max : args.max_packet_bytes
	if (!Number.isFinite(maxPacketBytes) || maxPacketBytes < 1) {
		throw new Error(`max_packet_bytes 必须是 ≥ 1 的数，收到 ${JSON.stringify(args.max_packet_bytes)}`)
	}
	const tpm = args.transactions_per_microframe === undefined ? 1 : args.transactions_per_microframe
	if (!Number.isInteger(tpm) || tpm < 1 || tpm > 3) {
		throw new Error(
			`transactions_per_microframe 只能是 1 / 2 / 3（对应 wMaxPacketSize bit 12..11 = 00/01/10，规范 §9.6.6），` +
				`收到 ${JSON.stringify(args.transactions_per_microframe)}`,
		)
	}
	return { maxPacketBytes, transactionsPerMicroframe: tpm, source: 'args', parsed: null }
}

/**
 * 该速率/类型下的包大小是否合法（单项事务端点的快路径）。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {string} input.transferType - 传输类型。
 * @param {number} input.maxPacketBytes - 单包字节数。
 * @param {Array<object>} input.checks - 结果收集。
 * @param {string[]} input.warnings - 结果收集。
 * @returns {object} 该速率/类型的包大小规范。
 */
function checkPacketSize({ speed, transferType, maxPacketBytes, checks, warnings }) {
	const spec = MAX_PACKET_SIZE[speed]?.[transferType]
	const ok = maxPacketBytes >= spec.min && maxPacketBytes <= spec.max
	checks.push({
		name: '最大包大小',
		pass: ok,
		detail: `${USB_SPEEDS[speed].label} ${transferType} 允许 ${spec.min}..${spec.max} 字节，给定 ${maxPacketBytes}`,
	})
	if (!ok) {
		warnings.push(
			`${transferType} 端点在 ${USB_SPEEDS[speed].label} 下的单包大小必须是 ${spec.min}..${spec.max} 字节，` +
				`${maxPacketBytes} 不合法（规范 §5.5–§5.8 / §9.6.6）。`,
		)
	}
	if (spec.allowed && !spec.allowed.includes(maxPacketBytes)) {
		warnings.push(`${USB_SPEEDS[speed].label} 的 ${transferType} 端点单包大小只允许 ${spec.allowed.join('/')} 字节。`)
	}
	return spec
}

/** `frameBudget.unit` 的中文标签。 */
const unitLabelOf = (budget) => (budget.unit === 'frame' ? '帧' : '微帧')

/* ------------------------------------------------------------------ */
/* 动作 1：bandwidth（单端点吞吐）                                       */
/* ------------------------------------------------------------------ */

/**
 * 周期性端点（中断 / 同步）的占用与吞吐。
 *
 * @param {object} ctx - 上下文。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function bandwidthPeriodic(ctx) {
	const { speed, transferType, direction, maxPacketBytes, effectiveTpm, args, gapBits, checks, warnings, notes } = ctx
	const budget = frameBudget(speed)
	const unitLabel = unitLabelOf(budget)

	const est = estimatePeriodicEndpoint({
		speed,
		transferType,
		direction,
		maxPacketBytes,
		transactionsPerMicroframe: effectiveTpm,
		intervalFrames: args.interval_frames ?? 1,
		intervalMicroframes: args.interval_microframes,
		gapBits,
		notes,
	})

	const ok = est.shareOfMicroframe <= budget.periodicMaxRatio
	checks.push({
		name: '周期带宽占比',
		pass: ok,
		detail:
			`占用 ${est.busTimeUsPerMicroframe.toFixed(3)} µs/${unitLabel} = ${unitLabel}的 ` +
			`${(est.shareOfMicroframe * 100).toFixed(2)}%，上限 ${(budget.periodicMaxRatio * 100).toFixed(0)}% ` +
			`（${budget.periodicLimitUs.toFixed(2)} µs，规范 §5.11.3）`,
	})
	if (!ok) {
		warnings.push(
			`该端点单靠自身就占掉 ${unitLabel}的 ${(est.shareOfMicroframe * 100).toFixed(2)}%，` +
				`超过周期上限 ${(budget.periodicMaxRatio * 100).toFixed(0)}%（${budget.periodicLimitUs.toFixed(2)} µs）。` +
				`主机不会接受这个配置：减小单包大小、拉长服务间隔，或减少每微帧事务数。`,
		)
	}
	notes.push(
		`服务间隔 ${est.intervalMicroframes} 微帧（${est.intervalFrames} 帧），每帧被服务 ` +
			`${est.occurrencesPerFrame} 次；单次服务 ${est.busTimeUsPerOccurrence.toFixed(3)} µs。`,
	)

	return {
		kind: 'periodic',
		transferType,
		direction,
		maxPacketBytes,
		transactionsPerMicroframe: effectiveTpm,
		...est,
		budget,
		checks,
		warnings,
		notes,
	}
}

/**
 * 批量端点的剩余带宽与吞吐。
 *
 * 口径与 `fitEndpointsInFrame` 保持一致：批量**不保留**任何带宽，只能用
 * `(微)帧 − 周期已用 − 控制保留 − SOF` 的剩余。单端点评估时周期流量按 0 计（已在 notes 声明）。
 *
 * @param {object} ctx - 上下文。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function bandwidthBulk(ctx) {
	const { speed, direction, maxPacketBytes, effectiveTpm, args, gapBits, checks, warnings, notes } = ctx
	const budget = frameBudget(speed)
	const speedSpec = USB_SPEEDS[speed]
	const unitLabel = unitLabelOf(budget)

	const includeSof = args.include_sof !== false
	const sofBits = includeSof ? packetBits({ speed, kind: 'sof' }) : 0
	const sofUs = (sofBits * (1e9 / speedSpec.bitRateHz)) / 1000

	const tx = transactionBits({ speed, transferType: 'bulk', direction, payloadBytes: maxPacketBytes, gapBits, notes })

	// 一个 (微)帧里装得下多少次该事务：`busTimeNs` 是 ns，所以可用时间要换算成 ns 再除。
	// （lib 的 `maxTransactionsInInterval` 把 µs 的预算直接除以 ns 的事务时间，单位对不上、
	//   结果恒为 0，因此这里不走它；除法的口径与 probe/usb.probe.mjs 的基准完全一致。）
	const countIn = (availableUsValue) => Math.floor((availableUsValue * 1000) / tx.busTimeNs)

	// 只扣 SOF：这一段是"规范第 5 章参考表"的口径，用来对照模型有没有走偏。
	const fullUnitUs = budget.unitUs - sofUs
	const referenceTransactionsPerUnit = countIn(fullUnitUs)
	// 再扣控制保留：这才是批量实际能拿到的量。
	const availableUs = Math.max(0, budget.unitUs - budget.controlReservedUs - sofUs)
	const transactionsPerUnit = countIn(availableUs)
	const usedUsPerUnit = (transactionsPerUnit * tx.busTimeNs) / 1000

	const unitsPerFrame = speedSpec.microframesPerFrame
	const bytesPerFrame = transactionsPerUnit * maxPacketBytes * unitsPerFrame
	const bytesPerSecond = (bytesPerFrame * 1e6) / speedSpec.frameUs

	const ok = transactionsPerUnit > 0
	checks.push({
		name: '批量剩余带宽',
		pass: ok,
		detail:
			`可用 ${availableUs.toFixed(2)} µs/${unitLabel}（周期流量按 0 计，已扣控制保留 ` +
			`${budget.controlReservedUs.toFixed(2)} µs + SOF ${sofUs.toFixed(3)} µs）→ ` +
			`装得下 ${transactionsPerUnit} 个 ${maxPacketBytes} 字节事务，合 ${bytesPerFrame} B/帧`,
	})
	if (!ok) {
		warnings.push(
			`批量端点拿不到任何 ${unitLabel}时间：控制保留 ${budget.controlReservedUs.toFixed(2)} µs 加上 SOF ` +
				`${sofUs.toFixed(3)} µs 已占满 ${budget.unitUs} µs。批量端点会长期抢不到总线，表现为极低吞吐或超时。`,
		)
	}

	const ref = SPEC_THROUGHPUT_REFERENCE[speed].bulk
	notes.push(
		`单端点口径：周期流量按 0 计。满 ${unitLabel}（只扣 SOF）能装 ${referenceTransactionsPerUnit} 个事务` +
			`（${((maxPacketBytes * referenceTransactionsPerUnit * unitsPerFrame * 1e6) / speedSpec.frameUs / 1e6).toFixed(3)} MB/s，` +
			`规范第 5 章参考表为 ${ref.transactionsPerFrame} 个 / ${ref.bytesPerMs} B/ms）；扣掉控制保留后剩 ` +
			`${transactionsPerUnit} 个 —— 差出来的那部分就是规范留给控制传输的。` +
			`真实总线上若同时挂着周期端点，就还要再减去周期占用。`,
	)
	notes.push(
		'这是在"每次事务都发满、不 NAK、不重传"前提下的**理论设计上限**；主控调度、Hub 层级与总线竞争都会拉低它，必须实测。',
	)

	return {
		kind: 'bulk',
		transferType: 'bulk',
		direction,
		maxPacketBytes,
		transactionsPerMicroframe: effectiveTpm,
		transaction: tx,
		sofUs,
		controlReservedUs: budget.controlReservedUs,
		fullUnitUs,
		availableUs,
		referenceTransactionsPerUnit,
		transactionsPerUnit,
		usedUsPerUnit,
		spareUsPerUnit: availableUs - usedUsPerUnit,
		bytesPerFrame,
		bytesPerSecond,
		budget,
		checks,
		warnings,
		notes,
	}
}

/**
 * 控制端点的单次传输耗时与保留量占用。
 *
 * @param {object} ctx - 上下文。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function bandwidthControl(ctx) {
	const { speed, direction, maxPacketBytes, effectiveTpm, args, gapBits, checks, warnings, notes } = ctx
	const budget = frameBudget(speed)
	const speedSpec = USB_SPEEDS[speed]

	const dataBytes = args.data_bytes ?? 0
	const ctrl = controlTransferBits({
		speed,
		dataBytes,
		maxPacketBytes,
		dataDirection: direction,
		gapBits,
		notes,
	})

	const reservedPerFrameUs = budget.controlReservedUs * speedSpec.microframesPerFrame
	const transferUs = ctrl.busTimeNs / 1000
	const transfersPerFrame = Math.floor((reservedPerFrameUs * 1000) / ctrl.busTimeNs)
	const ok = transferUs <= reservedPerFrameUs
	checks.push({
		name: '控制保留',
		pass: ok,
		detail:
			`一次控制传输 ${transferUs.toFixed(3)} µs ≤ 每帧控制保留 ${reservedPerFrameUs.toFixed(2)} µs` +
			`（${(budget.controlReservedRatio * 100).toFixed(0)}% × ${budget.unitUs} µs × ${speedSpec.microframesPerFrame} 微帧/帧）`,
	})
	if (!ok) {
		warnings.push(
			`单次控制传输就要 ${transferUs.toFixed(3)} µs，超过每帧为控制保留的 ${reservedPerFrameUs.toFixed(2)} µs` +
				`（规范 §5.11.3）。控制请求的延迟会变得不可控；减小控制端点的最大包大小或缩短数据阶段。`,
		)
	}
	notes.push(
		`控制传输 = 建立阶段（8 字节 OUT）+ ${dataBytes > 0 ? `数据阶段 ${dataBytes} 字节` : '无数据阶段'} + ` +
			`状态阶段，共 ${ctrl.transactionCount} 次事务，合计 ${ctrl.totalBits} 位。` +
			`按保留量算每帧约 ${transfersPerFrame} 次；规范允许主机把周期传输未用满的时间挪给控制传输，` +
			`所以实际能发的次数通常更多，但延迟随周期流量变满而恶化。`,
	)
	const ref = SPEC_THROUGHPUT_REFERENCE[speed]?.control
	if (ref) {
		notes.push(
			`注意：规范第 5 章参考表给 ${speed === 'high' ? 'HS' : 'FS'} 控制是 ${ref.transactionsPerFrame} 事务/微帧` +
				`（${ref.bytesPerMs} B/ms），那是另一套口径（按完整控制传输计，且受主机调度策略影响），` +
				`位级模型复现不出它，本工具也不假装能复现，仅作参考值列出。`,
		)
	}

	return {
		kind: 'control',
		transferType: 'control',
		direction,
		maxPacketBytes,
		transactionsPerMicroframe: effectiveTpm,
		dataBytes,
		controlTransfer: ctrl,
		transferUs,
		controlReservedUs: budget.controlReservedUs,
		reservedPerFrameUs,
		transfersPerFrame,
		bytesPerSecond: (transfersPerFrame * dataBytes * 1e6) / speedSpec.frameUs,
		budget,
		checks,
		warnings,
		notes,
	}
}

/**
 * 单端点吞吐分析。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runBandwidth(args) {
	const speed = requireSpeedArg(args.speed)
	const transferType = requireTransferTypeArg(args.transfer_type)
	const direction = args.direction ?? 'in'
	if (direction !== 'in' && direction !== 'out') throw new Error(`direction 只能是 in / out，收到 ${JSON.stringify(args.direction)}`)

	const checks = []
	const warnings = []
	const notes = []

	const gapBits = gapBitsFromArgs(args, warnings)
	const { maxPacketBytes, transactionsPerMicroframe, source, parsed } = resolvePacketInput(
		args,
		speed,
		transferType,
		notes,
	)

	// 每微帧多事务只对 HS 的中断/同步有效；其余组合一律按 1 次事务算（与 fitEndpointsInFrame 同口径）。
	const tpmSupported = speed === 'high' && PERIODIC_TYPES.has(transferType)
	const effectiveTpm = tpmSupported ? transactionsPerMicroframe : 1

	if (transactionsPerMicroframe > 1 && tpmSupported) {
		// 走 lib 的高带宽校验：一次性给出包大小、取值集合、适用范围、单微帧上限四条判定。
		const hb = checkHighBandwidth({
			speed,
			transferType,
			maxPacketBytes,
			additionalTransactions: transactionsPerMicroframe - 1,
		})
		checks.push(...hb.checks)
		warnings.push(...hb.warnings)
		notes.push(...hb.notes)
	} else {
		checkPacketSize({ speed, transferType, maxPacketBytes, checks, warnings })
		if (transactionsPerMicroframe > 1) {
			notes.push(
				`给了 transactions_per_microframe = ${transactionsPerMicroframe}，但高带宽端点只适用于高速的中断与同步` +
					`（规范 §9.6.6）：本次已按 1 次事务计算，合法性告警见上。`,
			)
		}
	}

	const ctx = { speed, transferType, direction, maxPacketBytes, effectiveTpm, args, gapBits, checks, warnings, notes }

	let body
	if (PERIODIC_TYPES.has(transferType)) body = bandwidthPeriodic(ctx)
	else if (transferType === 'bulk') body = bandwidthBulk(ctx)
	else body = bandwidthControl(ctx)

	return {
		action: 'bandwidth',
		speed,
		speedLabel: USB_SPEEDS[speed].label,
		packetSource: source,
		parsedWMaxPacketSize: parsed,
		checks,
		warnings,
		notes,
		...body,
	}
}

/* ------------------------------------------------------------------ */
/* 动作 2：fit（多端点能否装进一帧）                                     */
/* ------------------------------------------------------------------ */

/**
 * 一组端点能否装进一个 (微)帧。
 *
 * 直接走 lib 的统一入口 `analyzeUsbBandwidth`：它先逐端点校验描述符合法性
 * （含包大小取值集合与高带宽适用范围），再按 §5.11.3 判定周期上限、控制保留与批量剩余。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runFit(args) {
	const speed = requireSpeedArg(args.speed)
	const rawEndpoints = args.endpoints
	if (!Array.isArray(rawEndpoints)) {
		throw new Error(
			'action=fit 需要 endpoints 数组，每项形如 ' +
				`{ transferType, direction, maxPacketBytes, transactionsPerMicroframe, intervalFrames }；收到 ${JSON.stringify(rawEndpoints)}`,
		)
	}
	const endpoints = rawEndpoints.map(normalizeEndpoint)

	const extraWarnings = []
	const gapBits = gapBitsFromArgs(args, extraWarnings)

	const r = analyzeUsbBandwidth({
		speed,
		endpoints,
		gapBits,
		includeSof: args.include_sof !== false,
		controlBytesPerFrame: args.control_bytes_per_frame ?? 0,
		controlMaxPacketBytes: args.control_max_packet_bytes,
	})

	const warnings = [...r.warnings, ...extraWarnings]

	if (endpoints.length === 0) {
		r.notes.push('endpoints 为空：只报该速率的帧预算与"无周期流量"时的批量剩余量，没有可判定的端点组合。')
	}

	return { action: 'fit', endpointCount: endpoints.length, ...r, warnings }
}

/* ------------------------------------------------------------------ */
/* 动作 3：hb（高带宽端点描述符自洽性）                                   */
/* ------------------------------------------------------------------ */

/**
 * 高带宽端点（wMaxPacketSize bit 12..11）描述符自洽性校验。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runHb(args) {
	const speed = requireSpeedArg(args.speed)
	const transferType = requireTransferTypeArg(args.transfer_type)

	const notes = []
	const { maxPacketBytes, transactionsPerMicroframe, source, parsed } = resolvePacketInput(
		args,
		speed,
		transferType,
		notes,
	)

	const r = checkHighBandwidth({
		speed,
		transferType,
		maxPacketBytes,
		additionalTransactions: transactionsPerMicroframe - 1,
	})

	r.notes.push(
		'本动作只做**描述符合法性**判定（单包大小、取值集合、高带宽适用范围、单微帧字节上限），' +
			'不含时间预算；单端点的总线占用用 action=bandwidth，一组端点能否装进一帧用 action=fit。',
	)

	return {
		action: 'hb',
		speed,
		speedLabel: USB_SPEEDS[speed].label,
		transferType,
		packetSource: source,
		parsedWMaxPacketSize: parsed,
		...r,
		notes: [...notes, ...r.notes],
	}
}

/* ------------------------------------------------------------------ */
/* 同步分派器                                                          */
/* ------------------------------------------------------------------ */

/**
 * 按 action 分派到对应分支，**同步**返回结果。
 *
 * `execute` 走的也是这条路径，导出它是为了让自测能在不 await 的前提下覆盖全部分支
 * （宿主给的 `test` 是同步签名）。
 *
 * @param {object} args - 工具入参（键名与 parameters 一致）。
 * @returns {object} 必含 checks / warnings / notes 的结果。
 */
export function dispatch(args = {}) {
	const action = args.action ?? 'bandwidth'
	if (action === 'bandwidth') return runBandwidth(args)
	if (action === 'fit') return runFit(args)
	if (action === 'hb') return runHb(args)
	throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
}

/* ------------------------------------------------------------------ */
/* 展示行                                                              */
/* ------------------------------------------------------------------ */

/**
 * bandwidth 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function bandwidthLines(v) {
	const unitLabel = unitLabelOf(v.budget)
	if (v.kind === 'periodic') {
		return [
			`  ${v.transferType} ${v.direction.toUpperCase()}：${v.maxPacketBytes} B × ${v.transactionsPerMicroframe} 事务/微帧，` +
				`服务间隔 ${v.intervalMicroframes} 微帧（${v.intervalFrames} 帧），每帧服务 ${v.occurrencesPerFrame} 次`,
			`  吞吐 ${v.bytesPerFrame} B/帧 = ${(v.bytesPerSecond / 1e6).toFixed(3)} MB/s；` +
				`总线占用 ${v.busTimeUsPerMicroframe.toFixed(3)} µs/${unitLabel} = ${unitLabel}的 ${(v.shareOfMicroframe * 100).toFixed(2)}%` +
				`（上限 ${(v.budget.periodicMaxRatio * 100).toFixed(0)}%）`,
		]
	}
	if (v.kind === 'bulk') {
		return [
			`  单事务 ${v.maxPacketBytes} B（${v.direction.toUpperCase()}）：令牌 ${v.transaction.tokenBits} + 数据 ${v.transaction.dataBits} + ` +
				`握手 ${v.transaction.handshakeBits} + 包间 ${v.transaction.gapBits} = ${v.transaction.totalBits} 位 → ` +
				`${(v.transaction.busTimeNs / 1000).toFixed(2)} µs，有效载荷占 ${(v.transaction.payloadRatio * 100).toFixed(1)}%`,
			`  满 ${unitLabel}（只扣 SOF）装 ${v.referenceTransactionsPerUnit} 个事务（规范第 5 章基准口径）；` +
				`扣掉控制保留 ${v.controlReservedUs.toFixed(2)} µs 后剩 ${v.availableUs.toFixed(2)} µs → ` +
				`${v.transactionsPerUnit} 个事务 = ${v.bytesPerFrame} B/帧 = ${(v.bytesPerSecond / 1e6).toFixed(3)} MB/s`,
		]
	}
	return [
		`  控制传输（建立阶段 8 B + ${v.dataBytes > 0 ? `数据阶段 ${v.dataBytes} B` : '无数据阶段'} + 状态阶段）：` +
			`${v.controlTransfer.transactionCount} 次事务，${v.controlTransfer.totalBits} 位 = ${v.transferUs.toFixed(3)} µs`,
		`  每帧控制保留 ${v.reservedPerFrameUs.toFixed(2)} µs → 约 ${v.transfersPerFrame} 次/帧` +
			`${v.dataBytes > 0 ? `（数据阶段每次 ${v.dataBytes} B，合 ${(v.bytesPerSecond / 1e6).toFixed(3)} MB/s）` : ''}`,
	]
}

/**
 * fit 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function fitLines(v) {
	const unitLabel = v.unitUs === 125 ? '微帧' : '帧'
	const lines = [
		`  端点 ${v.endpointCount} 个；周期峰值 ${v.periodicUsedUs.toFixed(2)} µs/${unitLabel}，` +
			`上限 ${v.periodicLimitUs.toFixed(2)} µs（${(v.periodicMaxRatio * 100).toFixed(0)}%）`,
		`  控制保留 ${v.controlReservedUs.toFixed(2)} µs，SOF ${v.sofUs.toFixed(3)} µs；` +
			`批量剩余 ${v.bulkAvailableUs.toFixed(2)} µs = ${unitLabel}的 ${(v.bulkAvailableRatio * 100).toFixed(1)}%` +
			`（≈ ${v.bulkTransactionsPerUnit} 个事务）`,
		`  判定：${v.fits ? '装得下' : '装不下'}`,
	]
	for (const ep of v.endpoints ?? []) {
		lines.push(
			`    · ${ep.name}：${ep.transferType} ${ep.direction.toUpperCase()} ${ep.maxPacketBytes} B × ` +
				`${ep.transactionsPerMicroframe} 事务，峰值微帧 ${ep.peakSlotUs.toFixed(3)} µs（${ep.slotAccounting} 口径），` +
				`${(ep.bytesPerSecond / 1e6).toFixed(3)} MB/s`,
		)
	}
	return lines
}

/**
 * hb 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function hbLines(v) {
	const pass = v.checks.every((c) => c.pass)
	return [
		`  ${v.speedLabel} ${v.transferType}：单包 ${v.maxPacketBytes} B × ${v.transactionsPerMicroframe} 事务/微帧 = ` +
			`${v.bytesPerMicroframe} B/微帧（上限 3072，规范 §9.6.6）`,
		`  描述符判定：${pass ? '自洽' : '不合法 —— 见下方不通过的判定项与告警'}`,
	]
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
	name: 'usb_bandwidth',
	title: 'USB 2.0 带宽与端点预算（帧/微帧、周期上限与控制保留、高带宽端点、吞吐估算）',
	description:
		'USB 2.0 的 (微)帧带宽预算与端点吞吐估算（口径：USB 2.0 规范 §5.11.3 Bus Time Rationing、§5.5–§5.8 / §9.6.6 包大小与 wMaxPacketSize、' +
		'§7.1.18.2 包间延迟，交叉核对 USB-IF 电气一致性 EL_22 / EL_23 / EL_55、Microsoft Learn 同步传输文档、Chalmers 讲义第 5 章吞吐表）。' +
		'三种动作：' +
		'① action=bandwidth：**单端点**吞吐与 (微)帧占用。中断/同步端点给出每帧字节数与总线占用占比（含服务间隔换算、每微帧多事务）；' +
		'批量端点给出单次事务的开销拆解（令牌/数据/握手/包间延迟各占多少位）与剩余带宽能装下几个事务；控制端点给出一次完整控制传输的耗时与保留量占用；' +
		'② action=fit：**一组端点能否装进一个 (微)帧**。逐端点校验描述符合法性，再按 §5.11.3 判定中断+同步合计是否超过上限（FS 90% / HS 80%）、' +
		'控制保留（FS 10% / HS 20%）是否还放得下、批量还剩多少，并给出每个端点落在哪个微帧的峰值占用；' +
		'③ action=hb：**高速高带宽端点**（wMaxPacketSize bit 12..11 = 每微帧额外事务数）的描述符自洽性判定 —— 单包大小范围与取值集合、' +
		'高带宽是否只用在 HS 的中断/同步上、单微帧是否超过 3 × 1024 = 3072 字节上限。' +
		'返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 里每项形如 { name, pass, detail }）。' +
		'硬约束（请如实对待）：' +
		'（1）**包间延迟 gapBits 本工具不内置任何"实测值"**：规范只给区间（总线切换 ≥8 位时间 / 主机连发 ≥88 位时间，上限均 192），实际值随主控、Hub、线缆变化。' +
		`其中 LS/FS 的"主机连发 ${MIN_GAP_BITS_BY_SPEED.full.hostToHost} 位时间"是**反推校准值**（取 8 时位级模型恰好复现规范第 5 章"FS 批量 19 个事务/帧"，取 88 则只有 17），**不是规范原文**；` +
		'不传 gap_turnaround_bits + gap_host_to_host_bits 就退回规范下限，并在 notes 里点名"这是设计上限，量产前必须用分析仪实测替换"；' +
		'（2）所有吞吐数字都是**理论设计上限**（假定事务发满、不 NAK、不重传）。真实吞吐必须在目标主机上实测，主控调度实现、Hub 层级与总线竞争都会显著拉低它；' +
		'（3）**本模块不做低速设备经高速 Hub 的"分裂事务"（SSPLIT/CSPLIT）建模**，所以 LS 设备挂 Hub 的场景会**高估**可用带宽，必须按 Hub 手册另行核算；' +
		'（4）HS 的 bInterval 是 2^(bInterval−1) 个微帧（1..16），LS/FS 的 bInterval 就是帧数（1..255），本工具按 §9.6.6 换算，不要直接拿寄存器值当间隔用。',
	parameters: {
		action: {
			type: 'string',
			required: true,
			enum: ACTIONS,
			description:
				'bandwidth=单端点吞吐与 (微)帧占用（需 speed + transfer_type）；' +
				'fit=一组端点能否装进一个 (微)帧（需 speed + endpoints）；' +
				'hb=高带宽端点描述符自洽性（需 speed + transfer_type）。默认 bandwidth。',
		},
		speed: {
			type: 'string',
			required: true,
			enum: SPEED_IDS,
			description: '总线速率：low（1.5 Mb/s，帧 1 ms）/ full（12 Mb/s，帧 1 ms）/ high（480 Mb/s，微帧 125 µs，8 个微帧一帧）。',
		},
		transfer_type: {
			type: 'string',
			enum: TRANSFER_TYPES,
			description:
				'传输类型：control / interrupt / bulk / isochronous。action=bandwidth 与 action=hb 必填。' +
				'注意低速不支持批量与同步（规范 §5.5–§5.8），传了会直接报错。',
		},
		direction: {
			type: 'string',
			enum: ['in', 'out'],
			description:
				'端点方向，默认 in。它影响包间延迟的构成：OUT 是"令牌→数据"主机连发 + "数据→握手"总线切换，IN 是两处总线切换；' +
				'同步事务没有握手阶段（规范 §8.5）。',
		},
		max_packet_bytes: {
			type: 'integer',
			description:
				'单个物理包的最大字节数（端点描述符 wMaxPacketSize 的 bit 10..0）。不传则取该速率/类型的规范上限' +
				'（FS 控制/批量 64、FS 同步 1023、HS 控制 64、HS 批量 512、HS 中断/同步 1024）。给了 wmax_packet_size_raw 时以它为准。',
		},
		transactions_per_microframe: {
			type: 'integer',
			description:
				'每微帧的事务数：1 / 2 / 3（对应 wMaxPacketSize bit 12..11 = 00/01/10），默认 1。' +
				'**只有高速的中断与同步端点能大于 1**（规范 §9.6.6），其余组合会被按 1 次计算并告警。',
		},
		wmax_packet_size_raw: {
			type: 'integer',
			description:
				'端点描述符里 wMaxPacketSize 的原始 16 位值（0..65535）。给了它就直接解析 bit 10..0（单包字节）与 bit 12..11（每微帧额外事务数），' +
				'并优先于 max_packet_bytes / transactions_per_microframe —— 它才是描述符里的真实内容。bit 12..11 = 11 是保留编码，传入会报错。',
		},
		interval_frames: {
			type: 'number',
			description:
				'服务间隔（帧）。HS 下若不传 interval_microframes，则由它乘 8 换算成微帧（即 bInterval 为帧数时的口径）；' +
				'FS/LS 下就是 bInterval 本身（1..255）。默认 1，即每个 (微)帧都被服务。',
		},
		interval_microframes: {
			type: 'integer',
			description:
				'HS 的服务间隔（微帧数），优先于 interval_frames。由 bInterval 换算：HS 为 2^(bInterval−1) 个微帧（bInterval 1..16，规范 §9.6.6）。',
		},
		data_bytes: {
			type: 'integer',
			description: '仅 action=bandwidth 且 transfer_type=control 有效：控制传输数据阶段的字节数，默认 0（无数据阶段的请求，如 GET_STATUS）。',
		},
		endpoints: {
			type: 'array',
			description:
				'仅 action=fit 有效：端点清单，每项形如 ' +
				'{ transferType, direction, maxPacketBytes, transactionsPerMicroframe, intervalFrames }，' +
				'可选 name（展示用）、intervalMicroframes（HS 优先于 intervalFrames）、wMaxPacketSizeRaw（原始 16 位值，优先于前两者）。' +
				'键名必须是这些 camelCase 名，出现未知键会报错（避免拼错后静默变成 undefined 参与算术）。' +
				'批量与控制端点可以一起传入：它们不参与周期上限判定，只做描述符合法性校验，并计入批量剩余量的参考。',
		},
		include_sof: {
			type: 'boolean',
			description:
				'是否扣除每个 (微)帧的 SOF 占用，默认 true。FS 的 SOF 为 35 位 ≈ 2.917 µs/帧；HS 每帧 8 个 SOF 共 768 位 ≈ 1.6 µs/帧' +
				'（HS 的 SOF EOP 为 40 位，电气一致性 EL_55）。',
		},
		control_bytes_per_frame: {
			type: 'integer',
			description:
				'仅 action=fit 有效：该帧内预计的控制流量（字节），默认 0（不评估）。给了它就必须同时给 control_max_packet_bytes，' +
				'否则无法换算成时间。控制流量超出保留量时只记 notes（规范允许主机把周期未用满的时间挪给控制传输），不一定算硬失败。',
		},
		control_max_packet_bytes: {
			type: 'integer',
			description: '仅 action=fit 且给了 control_bytes_per_frame 时有效：控制流量换算用的包大小（FS 取 8/16/32/64，HS 固定 64）。',
		},
		gap_turnaround_bits: {
			type: 'integer',
			description:
				`总线切换包间延迟（位时间）——设备/主机收到包之后再发的那一段（电气一致性 EL_22）。**必须与 gap_host_to_host_bits 成对给出**，` +
				`只给一个会被当作没给。规范区间为 ${INTER_PACKET_GAP_BITS.turnaroundMin}..${INTER_PACKET_GAP_BITS.max} 位时间，` +
				`实际值随主控与 Hub 变化，**必须用 USB 分析仪实测**（测 SOF↔令牌、数据包之间的真实间隔）。`,
		},
		gap_host_to_host_bits: {
			type: 'integer',
			description:
				`主机连着发两个包的包间延迟（位时间，电气一致性 EL_23）。**必须与 gap_turnaround_bits 成对给出**。` +
				`HS 的规范下限是 ${INTER_PACKET_GAP_BITS.hostToHostMin} 位时间；**LS/FS 规范未给出对应数字**，` +
				`lib 内置的 ${MIN_GAP_BITS_BY_SPEED.full.hostToHost} 是**反推校准值**（不是规范原文），量产前必须用分析仪实测替换。上限均为 ${INTER_PACKET_GAP_BITS.max} 位时间。`,
		},
	},
	/**
	 * 按 action 分派到 lib/usb.js 的对应函数。
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
		if (v.action === 'bandwidth') return bandwidthLines(v)
		if (v.action === 'fit') return fitLines(v)
		if (v.action === 'hb') return hbLines(v)
		return []
	},
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测使用：lib 里被本工具用到的函数与常量，便于确认映射完整。 */
export const MAPPED_SYMBOLS = {
	bandwidth: [estimatePeriodicEndpoint, transactionBits, controlTransferBits],
	fit: [analyzeUsbBandwidth],
	hb: [checkHighBandwidth],
	helpers: [frameBudget, packetBits, parseWMaxPacketSize],
	constants: [MAX_PACKET_SIZE, INTER_PACKET_GAP_BITS, MIN_GAP_BITS_BY_SPEED, SPEC_THROUGHPUT_REFERENCE, USB_SPEEDS],
}

/**
 * 本工具**刻意没有用**的 lib 导出。
 *
 * `maxTransactionsInInterval` 把 µs 口径的 `availableUs` 直接除以 ns 口径的
 * `totalBits × (1e9 / bitRateHz)`，单位对不上，`maxTransactions` 恒为 0；
 * 本工具改用等价的 `floor(availableUs × 1000 / busTimeNs)`（口径与 probe 的基准一致）。
 * 这是 lib 的既有行为，本文件**不改动它**，只在此登记，免得后来人以为漏用了。
 */
export const UNUSED_BY_DESIGN = { maxTransactionsInInterval: '单位不匹配（µs ÷ ns），结果恒为 0；改用等价的 ns 口径除法' }
