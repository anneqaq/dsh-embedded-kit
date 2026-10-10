/**
 * `canfd_timing` 工具描述符 —— 把 lib/canfd.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**，不复制、不改写 lib/canfd.js 的任何算法。
 * 所有判定、公式与出处都留在 lib/canfd.js（其文件头登记了联网核实到的规范出处）。
 *
 * 三个动作对应 lib 里的三组函数：
 *   bit-timing → analyzeCanFdBitTiming（两段位时序反算 + BRS 切换 + TDC 判定）
 *   frame      → frameLayout / estimateFrameTime（帧结构；给了两段速率再算整帧时长）
 *   dlc        → analyzeDlc / bytesToDlc（DLC 与数据场字节数互查）
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键，形状与 lib/i2c.js 一致，
 * 具体数值挂在各自的 `action` 分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/canfd.tool
 */

import {
	analyzeCanFdBitTiming,
	analyzeDlc,
	bytesToDlc,
	CANFD_DLC_TO_BYTES,
	CRC17_MAX_PAYLOAD_BYTES,
	crcVariantForBytes,
	dlcToBytes,
	dynamicStuffBitsWorstCase,
	estimateFrameTime,
	fixedStuffBits,
	frameLayout,
} from '../lib/canfd.js'

/** 可用的动作。 */
const ACTIONS = ['bit-timing', 'frame', 'dlc']

/** `limits` 数组里允许出现的键（即 lib 认的控制器寄存器范围字段）。 */
const LIMIT_KEYS = ['brpMin', 'brpMax', 'tseg1TqMax', 'tseg2TqMax', 'sjwTqMax', 'nbtMin', 'nbtMax']

/**
 * 把 `[{ name, value }]` 形式的结构化参数转成 lib 要的对象。
 *
 * 用数组而不是嵌套对象，是为了让参数声明保持扁平；键名与 lib 的 limits 字段一一对应。
 *
 * @param {Array<{name:string, value:number}>|undefined} rows - 输入数组。
 * @returns {object|undefined} 形如 `{ brpMax: 1024, ... }`；未提供或为空时返回 undefined。
 */
function limitsFromArray(rows) {
	if (!Array.isArray(rows) || rows.length === 0) return undefined
	/** @type {Record<string, number>} */
	const out = {}
	for (const row of rows) {
		if (!row || typeof row.name !== 'string') {
			throw new Error('limits 每项必须是 { name, value } 形式')
		}
		if (!LIMIT_KEYS.includes(row.name)) {
			throw new Error(`limits 的 name 只能是 ${LIMIT_KEYS.join(' / ')}，收到 '${row.name}'`)
		}
		if (!Number.isFinite(row.value)) {
			throw new Error(`limits 里 ${row.name} 需要数值型的 value`)
		}
		out[row.name] = row.value
	}
	return out
}

/**
 * 解析 `dlc` / `data_bytes` 二选一，得到 DLC 值。
 *
 * @param {object} args - 工具入参。
 * @returns {number} DLC 值 0~15。
 */
function resolveDlc(args) {
	if (Number.isInteger(args.dlc)) return args.dlc
	if (Number.isInteger(args.data_bytes)) return bytesToDlc(args.data_bytes, { fd: true }).dlc
	throw new Error('需要 dlc（0~15）或 data_bytes（数据场字节数）二者之一')
}

/* ------------------------------------------------------------------ */
/* 动作 1：bit-timing                                                  */
/* ------------------------------------------------------------------ */

/**
 * 两段位时序反算。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runBitTiming(args) {
	// 只有显式给了 tdc_enabled 才构造 tdc；否则传 undefined，让 lib 在 notes 里点名"未提供 tdc"。
	const tdc =
		args.tdc_enabled === undefined
			? undefined
			: {
					enabled: args.tdc_enabled === true,
					dataBrp: args.tdc_data_brp,
					sspOffsetTq: args.ssp_offset_tq,
				}

	const r = analyzeCanFdBitTiming({
		clockHz: args.clock_hz,
		arbitrationBitrate: args.arbitration_bitrate,
		dataBitrate: args.data_bitrate,
		arbitrationSamplePoint: args.arbitration_sample_point,
		dataSamplePoint: args.data_sample_point,
		tdc,
		limits: limitsFromArray(args.limits),
		maxCandidates: args.max_candidates ?? 8,
	})
	return { action: 'bit-timing', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 2：frame                                                       */
/* ------------------------------------------------------------------ */

/**
 * 帧结构与（可选）整帧时长。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runFrame(args) {
	if (args.fd === false) {
		throw new Error(
			'action=frame 只描述 CAN FD 帧结构（CRC 场 / stuff count / 固定填充位都是 FD 特有的），不支持 fd=false。' +
				'只看经典 CAN 的 DLC 映射请用 action=dlc + fd=false。',
		)
	}
	const dlc = resolveDlc(args)
	const options = {
		extended: args.extended === true,
		dynamicStuffBits: args.dynamic_stuff_bits ?? 0,
	}

	// 两段速率与采样点齐了才算整帧时长；否则只给帧结构（位数不受波特率影响）。
	const hasTiming =
		args.arbitration_bitrate !== undefined &&
		args.data_bitrate !== undefined &&
		args.arbitration_sample_point !== undefined &&
		args.data_sample_point !== undefined

	if (hasTiming) {
		return {
			action: 'frame',
			kind: 'frame-time',
			...estimateFrameTime({
				dlc,
				arbitrationBitrate: args.arbitration_bitrate,
				dataBitrate: args.data_bitrate,
				arbitrationSamplePoint: args.arbitration_sample_point,
				dataSamplePoint: args.data_sample_point,
				options,
			}),
		}
	}

	return { action: 'frame', kind: 'layout', ...frameLayout({ dlc, options }) }
}

/* ------------------------------------------------------------------ */
/* 动作 3：dlc                                                         */
/* ------------------------------------------------------------------ */

/**
 * DLC ↔ 数据场字节数。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runDlc(args) {
	const fd = args.fd !== false

	if (Number.isInteger(args.dlc)) {
		const r = analyzeDlc({ dlc: args.dlc, options: { fd } })
		if (!fd) {
			r.notes.push(
				'fd=false 时 CRC 变体与固定填充位仍按 FD 的口径给出——本模块的 CRC 分界（17/21）只覆盖 FD。' +
					'经典 CAN 帧用 CRC15，且其 CRC 场没有 stuff count、也没有固定填充位。',
			)
		}
		return { action: 'dlc', kind: 'dlc-to-bytes', ...r }
	}

	if (Number.isInteger(args.data_bytes)) {
		return runBytesToDlc(args, fd)
	}

	throw new Error('action=dlc 需要 dlc（DLC→字节，0~15）或 data_bytes（字节→DLC）二者之一')
}

/**
 * 字节数 → DLC（lib 的 bytesToDlc 不带 checks/warnings/notes，这里补齐三键）。
 *
 * @param {object} args - 工具入参。
 * @param {boolean} fd - 是否按 CAN FD 映射。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runBytesToDlc(args, fd) {
	const r = bytesToDlc(args.data_bytes, { fd })
	const checks = [
		{
			name: '需求字节数能否被 DLC 精确编码',
			pass: r.exact,
			detail: r.exact
				? `${r.byteLength} 字节恰好命中 DLC ${r.dlc}（数据场 ${r.encodedBytes} 字节）`
				: `${r.byteLength} 字节在 ${fd ? 'CAN FD' : '经典 CAN'} 里没有对应编码，顶到 DLC ${r.dlc}` +
					`（数据场 ${r.encodedBytes} 字节），需自行填充 ${r.paddingBytes} 字节`,
		},
	]
	const warnings = []
	const notes = []

	if (!r.exact) {
		warnings.push(
			`${r.byteLength} 字节不是 ${fd ? 'CAN FD' : '经典 CAN'} 的合法载荷长度：实际会按 ${r.encodedBytes} 字节发送，` +
				`多出的 ${r.paddingBytes} 字节内容必须与对端约定（常见填 0 或 0xFF），否则对端解出的长度与你的语义会对不上。`,
		)
	}
	notes.push(
		fd
			? `CAN FD 只有 16 种合法载荷长度：${CANFD_DLC_TO_BYTES.join(' / ')} 字节；9~11、13~15、17~19… 都无编码，必须补齐到下一档。`
			: '经典 CAN 的 DLC 0~8 直映 0~8 字节，DLC 9~15 编码合法但数据场固定按 8 字节处理。',
	)
	notes.push('DLC 只描述数据场长度，与整帧位数无关；算整帧请用 action=frame。')

	const crc = fd ? crcVariantForBytes(r.encodedBytes) : null
	if (crc) {
		notes.push(
			`按实际发送的 ${r.encodedBytes} 字节算：CRC 变体 ${crc.id.toUpperCase()}（${crc.bits} 位），` +
				`CRC 场固定填充位 ${fixedStuffBits(crc.bits).count} 个。分界是数据场 ≤ ${CRC17_MAX_PAYLOAD_BYTES} 字节用 CRC17、> ${CRC17_MAX_PAYLOAD_BYTES} 字节用 CRC21。`,
		)
	}

	return {
		action: 'dlc',
		kind: 'bytes-to-dlc',
		requestedBytes: r.byteLength,
		dlc: r.dlc,
		dataBytes: r.encodedBytes,
		payloadBits: r.encodedBytes * 8,
		paddingBytes: r.paddingBytes,
		exact: r.exact,
		fd: r.fd,
		crc,
		fixedStuffBits: crc ? fixedStuffBits(crc.bits) : null,
		checks,
		warnings,
		notes,
	}
}

/* ------------------------------------------------------------------ */
/* 展示行                                                              */
/* ------------------------------------------------------------------ */

/**
 * 渲染一段位时序的最优候选。
 *
 * @param {string} name - 段名。
 * @param {object} seg - 结果里的 arbitration / data 块。
 * @returns {string} 一行文本。
 */
function segmentLine(name, seg) {
	if (!seg.best) {
		return `  ${name}：无可用候选 —— 该时钟在给定 limits 下配不出 ${seg.bitrate} bit/s`
	}
	const b = seg.best
	return (
		`  ${name}（${seg.bitrate} bit/s，采样点目标 ${(seg.samplePointTarget * 100).toFixed(3)}%）：` +
		`BRP=${b.brp} NBT=${b.nbt} tq=${b.tqNs.toFixed(2)} ns，Prop=${b.propSeg} PS1=${b.phaseSeg1} PS2=${b.phaseSeg2}，` +
		`实际采样点 ${b.samplePointPercent.toFixed(3)}%，波特率误差 ${b.bitrateErrorPpm} ppm，候选 ${seg.totalCandidates} 组；` +
		`寄存器 {BRP:${b.registers.BRP}, TSEG1:${b.registers.TSEG1}, TSEG2:${b.registers.TSEG2}, SJW:${b.registers.SJW}}`
	)
}

/**
 * bit-timing 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function bitTimingLines(v) {
	const lines = [
		`  控制器时钟 ${v.clockHz} Hz（${(v.clockHz / 1e6).toFixed(3)} MHz）；数据段 / 仲裁段 = ${(v.dataBitrate / v.arbitrationBitrate).toFixed(3)}×`,
		segmentLine('仲裁段', v.arbitration),
		segmentLine('数据段', v.data),
	]
	if (v.brsSwitch) {
		const s = v.brsSwitch
		lines.push(
			`  BRS 位（mixed，仲裁→数据）= ${s.brsBitNs} ns；CRC 界定符位（mixed，数据→仲裁）= ${s.crcDelimiterBitNs} ns` +
				`（纯仲裁位 ${s.arbitrationBitTimeNs.toFixed(1)} ns / 纯数据位 ${s.dataBitTimeNs.toFixed(1)} ns）`,
		)
	}
	lines.push(`  TDC 配置：${v.tdcProvided ? '已提供（纳入判定）' : '未提供 —— 未做发送延迟补偿判定'}`)
	return lines
}

/**
 * frame 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function frameLines(v) {
	const lines = [
		`  DLC ${v.dlc}（${v.extended ? '扩展格式 29 位 ID' : '标准格式 11 位 ID'}）→ 数据场 ${v.dataBytes} 字节 = ${v.dataBytes * 8} 位；` +
			`${v.crc.id.toUpperCase()}（${v.crc.bits} 位），CRC 场固定填充位 ${v.fixedStuffBits.count} 个`,
		`  理想整帧 ${v.totals.idealTotalBits} 位（固定开销 ${v.totals.idealTotalBits - v.dataBytes * 8} 位，不含动态填充位）：` +
			`仲裁段速率 ${v.totals.bitsByRate.arbitration} 位 / 数据段速率 ${v.totals.bitsByRate.data} 位 / mixed ${v.totals.bitsByRate.mixed} 位`,
		`  动态填充区 ${v.totals.stuffingRegionBits} 位，最坏填充 ${v.totals.worstCaseStuffBits} 个（本次按 ${v.totals.dynamicStuffBits} 个计入）`,
	]
	if (v.kind === 'frame-time' && Number.isFinite(v.durationNs)) {
		lines.push(
			`  整帧估算 ${v.durationNs.toFixed(1)} ns（${v.durationUs.toFixed(3)} µs）≈ ${(v.estimatedFramesPerSecond / 1000).toFixed(1)} k 帧/秒` +
				`（含 BRS ${v.brsBitNs} ns + CRC 界定符 ${v.crcDelimiterBitNs} ns）`,
		)
	} else {
		lines.push('  未给两段波特率与采样点，只做帧结构，未算整帧时长。')
	}
	return lines
}

/**
 * dlc 的展示行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function dlcLines(v) {
	if (v.kind === 'bytes-to-dlc') {
		const lines = [
			`  需要 ${v.requestedBytes} 字节 → DLC ${v.dlc}（数据场 ${v.dataBytes} 字节` +
				`${v.exact ? '，精确命中' : `，需填充 ${v.paddingBytes} 字节`}）`,
			`  ${v.fd ? 'CAN FD' : '经典 CAN'} 合法载荷长度：${v.fd ? CANFD_DLC_TO_BYTES.join(' / ') : '0 / 1 / … / 8（DLC 9~15 仍按 8 字节）'}`,
		]
		if (v.crc) {
			lines.push(
				`  CRC 变体 ${v.crc.id.toUpperCase()}（${v.crc.bits} 位）；CRC 场 = 4 + ${v.crc.bits} = ${v.fixedStuffBits.crcFieldBits} 位 → 固定填充位 ${v.fixedStuffBits.count} 个`,
			)
		}
		return lines
	}
	return [
		`  DLC ${v.dlc}（${v.fd ? 'CAN FD' : '经典 CAN'}）→ 数据场 ${v.dataBytes} 字节 = ${v.payloadBits} 位` +
			`${v.fd && v.isExtendedLengthCode ? '（FD 的 DLC 9~15 是非线性映射档）' : ''}`,
		v.fd
			? `  CRC 变体 ${v.crc.id.toUpperCase()}（${v.crc.bits} 位，数据场 ${v.dataBytes} 字节 ${v.dataBytes <= CRC17_MAX_PAYLOAD_BYTES ? '≤' : '>'} 16 字节）；` +
				`CRC 场 = 4 + ${v.crc.bits} = ${v.fixedStuffBits.crcFieldBits} 位 → 固定填充位 ${v.fixedStuffBits.count} 个（插在第 ${v.fixedStuffBits.positionsAfter.join('、')} 位之后）`
			: '  经典 CAN 帧用 CRC15（15 位，多项式 0xC599），其 CRC 场没有 stuff count、也没有固定填充位。',
	]
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
	name: 'canfd_timing',
	title: 'CAN FD 位时序与帧结构（两段速率 / BRS 切换 / DLC / CRC 场）',
	description:
		'CAN FD 位时序、帧结构与 DLC 换算（ISO 11898-1:2015 / Bosch V1.0 / CiA Rec.6）。三个动作：' +
		'bit-timing 两段速率**分别**反算 BRP/TSEG1/TSEG2/SJW 并算 BRS 与 CRC 界定符两个 mixed 位时长；' +
		'frame 给逐字段位数、速率段、CRC 变体与固定填充位；dlc 做 DLC 与字节数互查（**9~15 是非线性映射**，只有 16 种合法载荷长度）。' +
		'**采样点目标、寄存器范围 limits、TDC 配置都无内置默认值**，缺哪项就点名。数据段 > 1 Mbit/s 必须使能 TDC 且 BRPD 为 1 或 2。' +
		'相位裕量口径与实测要求见 bus-timing 技能。',
	parameters: {
		action: {
			type: 'string',
			required: true,
			enum: ACTIONS,
			description: 'bit-timing=两段位时序反算 + BRS 切换 + TDC 判定；frame=帧结构；dlc=DLC 与字节数互查。',
		},
		clock_hz: {
			type: 'integer',
			description: 'CAN 控制器输入时钟（Hz），如 40000000、80000000。action=bit-timing 必填，必须来自芯片手册/时钟树实测。',
		},
		arbitration_bitrate: {
			type: 'integer',
			description: '仲裁段波特率（bit/s），如 500000。action=bit-timing 必填；action=frame 给了它才估算整帧时长。',
		},
		data_bitrate: {
			type: 'integer',
			description: '数据段波特率（bit/s），如 2000000。必须高于仲裁段，否则 BRS 切换没有收益（会报警）。',
		},
		arbitration_sample_point: {
			type: 'number',
			description: '仲裁段采样点目标（0~1 比例，如 0.8 表示 80%）。**必填无默认值**：全网节点必须一致的公共约定。',
		},
		data_sample_point: {
			type: 'number',
			description: '数据段采样点目标（0~1 比例）。**必填无默认值**，必须用实测 A1/A2 论证，不是照搬仲裁段。',
		},
		dlc: { type: 'integer', description: 'DLC 值 0~15（4 位字段）。action=frame / action=dlc 与 data_bytes 二选一。' },
		data_bytes: {
			type: 'integer',
			description:
				'数据场字节数。与 dlc 二选一：给了它，本工具反查能装下它的 DLC 并报出需填充的字节数（FD 只有 16 种合法长度）。',
		},
		fd: {
			type: 'boolean',
			description: '仅 action=dlc 有效：true（默认）按 FD 映射，false 按经典 CAN（DLC 9~15 一律 8 字节）。action=frame 固定按 FD，传 false 报错。',
		},
		extended: { type: 'boolean', description: '是否扩展格式（29 位标识符，FEFF）。默认 false（标准格式，11 位 ID）。仅 action=frame 有效。' },
		dynamic_stuff_bits: {
			type: 'integer',
			description: 'action=frame 计入的动态填充位个数，默认 0。最坏值 = floor((动态填充区位数 − 1) / 4)；超过最坏值会报警。',
		},
		limits: {
			type: 'array',
			description:
				'控制器位时序寄存器范围，每项 { name, value }，name 取 brpMin / brpMax / tseg1TqMax / tseg2TqMax / sjwTqMax / nbtMin / nbtMax。' +
				'**必须查芯片手册**；不给就只按"能整除"枚举，结果可能超出芯片可写范围。',
		},
		tdc_enabled: {
			type: 'boolean',
			description: '是否使能 TDC。给了才做 TDC 判定；数据段 > 1 Mbit/s 时必须为 true（CiA Rec.6）。',
		},
		tdc_data_brp: { type: 'integer', description: 'TDC 使能时数据段 BRP 功能值；不为 1 或 2 时会报警（CiA Rec.6 引 ISO 11898-1:2015）。' },
		ssp_offset_tq: {
			type: 'integer',
			description: '二次采样点 SSP offset（最小时间量子数）。规范要求配置范围至少 0~63，超过 63 会报警。必须按实测的收发器环路延迟设置。',
		},
		max_candidates: { type: 'integer', description: '每段最多返回多少组候选（仅控制输出体积，非硬件参数），默认 8。仅 action=bit-timing 有效。' },
	},
	/**
	 * 按 action 分派到 lib/canfd.js 的对应函数。
	 *
	 * @param {object} args - 模型传入的参数。
	 * @returns {Promise<object>} 含 checks / warnings / notes 的结果。
	 */
	async execute(args) {
		const action = args.action ?? 'bit-timing'
		if (action === 'bit-timing') return runBitTiming(args)
		if (action === 'frame') return runFrame(args)
		if (action === 'dlc') return runDlc(args)
		throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
	},
	/**
	 * 供渲染层展示的具体数值行。
	 *
	 * @param {object} v - execute 的返回值。
	 * @returns {string[]} 文本行。
	 */
	summaryLines(v) {
		if (!v || typeof v !== 'object') return []
		if (v.action === 'bit-timing') return bitTimingLines(v)
		if (v.action === 'frame') return frameLines(v)
		if (v.action === 'dlc') return dlcLines(v)
		return []
	},
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测使用：lib 里被本工具用到的函数，便于确认映射完整。 */
export const MAPPED_FUNCTIONS = {
	bitTiming: [analyzeCanFdBitTiming],
	frame: [frameLayout, estimateFrameTime],
	dlc: [analyzeDlc, bytesToDlc],
	helpers: [dlcToBytes, crcVariantForBytes, fixedStuffBits, dynamicStuffBitsWorstCase],
}
