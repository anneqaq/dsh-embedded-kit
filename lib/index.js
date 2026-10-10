/**
 * dsh-embedded-kit — 嵌入式固件开发工具包（Host 半边）。
 *
 * **不绑定任何芯片厂商、IDE 或工具链。** 覆盖的是"嵌入式固件工程"这一层共性能力：
 *
 *   工具
 *     fw_size        体积分析：自动识别 ELF / GNU ld map / Keil map 三种输入
 *     proto_frame    串行协议：Modbus RTU 帧构建与审查 + 通用参数化 CRC
 *     rs485_timing   半双工时序与方向切换裕量
 *     fw_build       多工具链构建：Keil / PlatformIO / CMake / make / ESP-IDF / IAR / 自定义
 *   技能
 *     embedded-code-review   代码审查清单（裸机 / RTOS 分开，覆盖多厂商多架构）
 *     protocol-review        串行通讯协议编写与审查清单
 *     fw-size-optimization   固件体积优化流程
 *
 * @module dsh-embedded-kit
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { analyzeBuffer } from './sizereport.js'
import { buildFrame, verifyFrame, parseHex, toHex, crc16Modbus, FUNCTION_NAMES } from './modbus.js'
import { CRC_PRESETS, PRESET_NAMES, computeCheck, checkBytesLE, checkBytesBE } from './crc.js'
import { analyzeTiming } from './rs485.js'
import { analyzePins, MCU_MODES, EXTERNAL_KINDS, EXTERNAL_LEVELS } from './leakage.js'
import { analyzeAdcLoad } from './adc.js'
import { computePowerBudget } from './power.js'
import { analyzeSchedule } from './sched.js'
import { parseElf } from './elf.js'
import { decodeFault } from './fault.js'
import { planNvmLayout } from './nvm.js'
import { sizeLvglBuffers } from './lvgl.js'
import { decodeLog } from './keil.js'
import { probeToolchains, runBuild, TOOLCHAIN_IDS, BACKENDS } from './build.js'
import { registerSkills, SKILL_NAMES } from './skills.js'
import { registerGate } from './gate.js'
import { analyzeI2c, I2C_MODE_IDS } from './i2c.js'
import { bestBitTiming } from './can.js'
import { describeSpiMode, estimateSpiMaxClock, spiBandwidth, analyzeI2s, SPI_MODES } from './spi.js'
import { analyzeLin, analyzeOneWire, analyzeRs232, analyzeRs422, LIN_CONSTANTS } from './lines.js'
import { parseIntelHex, checkVectors, toBuffer } from './image.js'
import { analyzeQspi, dummyCyclesNeeded, QSPI_MODES } from './qspi.js'
import { analyzeStack, usedBytesFromWatermark } from './stack.js'
import { solvePll, evaluateClockChain, uartTolerance } from './clock.js'
import { priorityGrouping, canPreempt, analyzeInterruptLatency, cyclesToUs } from './nvic.js'
import { timeoutUs, solveTimeout, analyzeWatchdog } from './watchdog.js'
import { analyzePowerTree } from './supply.js'
/* 以下工具的模块在 lib/，工具描述符在同级 integrate/。 */
import { tool as canfdTool } from '../integrate/canfd.tool.mjs'
import { tool as loraTool } from '../integrate/lora.tool.mjs'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'dsh-embedded-kit'

/**
 * 只依赖 `tools`。
 *
 * 刻意**不把 `skills` 写进 inject**：若当前 profile 未启用技能服务，
 * 声明了它会让整个插件永久 pending，连工具都用不了。技能走尽力而为路径。
 */
export const inject = ['tools']

/** 本插件注册的工具名清单（供自测与文档使用）。 */
export const TOOL_NAMES = [
	'fw_size',
	'proto_frame',
	'rs485_timing',
	'fw_build',
	'leak_pin',
	'sched_analyze',
	'power_budget',
	'adc_load',
	'fault_decode',
	'nvm_layout',
	'lvgl_mem',
	'i2c_bus',
	'can_timing',
	'spi_bus',
	'i2s_clk',
	'lin_sched',
	'onewire_timing',
	'rs232_link',
	'fw_image',
	'qspi_flash',
	'stack_depth',
	'clock_tree',
	'nvic_priority',
	'watchdog_check',
	'power_tree',
	'canfd_timing',
	'lora_airtime',
]

/**
 * 注册全部工具与技能。
 *
 * @param {object} ctx - Cordis 上下文（需带 `tools` 服务）。
 * @param {object} [config] - 插件配置。
 * @param {string} [config.uv4Path] - 覆盖 Keil UV4 可执行文件路径。
 * @param {boolean} [config.registerSkills] - 是否注册随包技能，默认 true。
 */
export function apply(ctx, config = {}) {
	ctx.tools.register(defineFwSizeTool())
	ctx.tools.register(defineProtoFrameTool())
	ctx.tools.register(defineRs485TimingTool())
	ctx.tools.register(defineFwBuildTool(config))
	ctx.tools.register(defineLeakPinTool())
	ctx.tools.register(defineSchedAnalyzeTool())
	ctx.tools.register(definePowerBudgetTool())
	ctx.tools.register(defineAdcLoadTool())
	ctx.tools.register(defineFaultDecodeTool())
	ctx.tools.register(defineNvmLayoutTool())
	ctx.tools.register(defineLvglMemTool())
	ctx.tools.register(defineI2cBusTool())
	ctx.tools.register(defineCanTimingTool())
	ctx.tools.register(defineSpiBusTool())
	ctx.tools.register(defineI2sClkTool())
	ctx.tools.register(defineLinSchedTool())
	ctx.tools.register(defineOneWireTool())
	ctx.tools.register(defineRs232Tool())
	ctx.tools.register(defineFwImageTool())
	ctx.tools.register(defineQspiFlashTool())
	ctx.tools.register(defineStackDepthTool())
	ctx.tools.register(defineClockTreeTool())
	ctx.tools.register(defineNvicPriorityTool())
	ctx.tools.register(defineWatchdogTool())
	ctx.tools.register(definePowerTreeTool())
	/* 由工具描述符装载（见 integrate/*.tool.mjs）。 */
	for (const d of [canfdTool, loraTool]) {
		ctx.tools.register(toolFromDescriptor(d))
	}

	// 两个坑，都在 cordis 4 上才暴露：
	//
	//  1) 访问未声明 `inject` 的服务会**抛错**，而不是返回 undefined
	//     （src/reflect.ts: `cannot get property "X" without inject`）。
	//     旧的裸 `Reflect.get(ctx, 'skills')` 写法会把整棵插件树搞崩。
	//
	//  2) `skills` 与 `logger` 在这个作用域里的**可达性不同** —— 实测
	//     `skills` 用子 fiber 声明依赖即可拿到（11 个技能全部注册成功），
	//     而 `logger` 无论怎么等都解析不出来。因此两者必须**分开**处理：
	//     合并成 `inject(['skills', 'logger'])` 时，正是拿不到的 logger
	//     把整个子 fiber 卡在 pending，技能也跟着注册不上。
	//
	// 顶层 `inject` 依旧只有 tools —— 服务拿不到只让子 fiber 不落地，工具不受影响。

	/**
	 * 软取服务：拿不到就当没有（自测里的假 ctx 没有注册表 mixin）。
	 *
	 * @param {object} target - 上下文或子上下文。
	 * @param {string} key - 服务名。
	 * @returns {any} 服务实例，或 undefined。
	 */
	const softGet = (target, key) => {
		try {
			return Reflect.get(target, key)
		} catch {
			return undefined
		}
	}

	/** 日志出口：优先宿主 logger，拿不到就退回 console —— 否则诊断全被静默丢掉。 */
	const logger = softGet(ctx, 'logger') ?? console

	/**
	 * 注册随包技能并汇报结果。
	 *
	 * @param {object} scope - 带 `skills` 服务的上下文。
	 */
	const registerSkillsAndReport = (scope) => {
		const skillResult = registerSkills(scope, { enabled: config.registerSkills !== false })
		if (skillResult.registered.length > 0) {
			logger.info?.('dsh-embedded-kit: 已注册技能 %s', skillResult.registered.join(', '))
		}
		for (const s of skillResult.skipped) {
			logger.warn?.('dsh-embedded-kit: 技能 %s 未注册 —— %s', s.name, s.reason)
		}
		if (!skillResult.available) {
			logger.info?.(
				'dsh-embedded-kit: 当前 profile 未启用技能服务，%d 个技能正文位于插件包 skills/ 目录，可直接阅读',
				SKILL_NAMES.length,
			)
		}
	}

	// 启动时通报本机的工具链可用性：这属于可实测的事实，值得让用户直接看到。
	const probes = probeToolchains(config)
	const available = probes.filter((p) => p.available)
	logger.info?.(
		'dsh-embedded-kit: 探测到 %d/%d 个构建工具链可用 —— %s',
		available.length,
		probes.length,
		available.length > 0 ? available.map((p) => `${p.label}(${p.exe})`).join('、') : '（无）',
	)
	if (!existsSync(config.uv4Path ?? '')) {
		const keil = probes.find((p) => p.id === 'keil')
		if (!keil.available) {
			logger.info?.('dsh-embedded-kit: %s；fw_build 的 keil 后端会报错，可在配置里指定 uv4Path', keil.hint)
		}
	}

	// 技能走作用域注入：顶层没声明 `skills`，裸访问会抛错；
	// 用子 fiber 声明依赖即可正常拿到，宿主不提供时也只是这个子 fiber 不落地。
	const inject = softGet(ctx, 'inject')
	if (typeof inject === 'function') {
		inject.call(ctx, ['skills'], registerSkillsAndReport)
	} else {
		registerSkillsAndReport(ctx)
	}

	// 会话启动门禁：在每个会话的第一步注入一段文本，把"哪些数字必须用工具算"和
	// "缺数据不许编"写进上下文。它是增强项 —— 注册失败只记日志，工具照常可用。
	registerGate(ctx, config)
		.then((result) => {
			if (result.registered) {
				logger?.info?.(
					'dsh-embedded-kit: 门禁已注册（%d 字符，每个会话首步注入一次）',
					result.contentLength,
				)
			} else {
				logger?.info?.('dsh-embedded-kit: 门禁未注册 —— %s（工具与技能不受影响）', result.reason)
			}
		})
		.catch((error) => {
			logger?.warn?.('dsh-embedded-kit: 门禁注册异常 %s', error instanceof Error ? error.message : error)
		})
}

/* ------------------------------------------------------------------ */
/* 通用格式化                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把字节数渲染成人类可读形式。
 * @param {number|null} value - 字节数。
 * @returns {string} 形如 `4096 B (4.00 KB)`；未知时返回 `未知`。
 */
function formatBytes(value) {
	if (!Number.isFinite(value)) return '未知'
	return `${value} B (${(value / 1024).toFixed(2)} KB)`
}

/**
 * 渲染预算行。
 * @param {object} b - 预算块。
 * @returns {string} 描述文本。
 */
function formatBudget(b) {
	if (b.percent === null) return '（预算已给，但用量未解析到，无法计算占用率）'
	return `预算 ${b.budget} B（${b.note}），占用 ${b.percent}%，余量 ${b.headroom} B`
}

/* ------------------------------------------------------------------ */
/* 工具 1：fw_size（三格式通用）                                        */
/* ------------------------------------------------------------------ */

/** 各格式的展示名。 */
const FORMAT_LABELS = {
	elf: 'ELF 文件',
	'keil-map': 'Keil MDK map',
	'gnu-map': 'GNU ld map',
	unknown: '未知格式',
}

/** 体积分析的渲染函数。 */
function renderSizeReport(r) {
	const lines = []
	lines.push(`固件体积报告（${FORMAT_LABELS[r.format] ?? r.format}）：${r.source}`)
	lines.push(`  架构：${r.arch}`)
	if (r.encoding) lines.push(`  解码编码：${r.encoding}`)
	lines.push('')
	lines.push(`  ROM（Flash 镜像 = Code + RO Data + RW Data）：${formatBytes(r.totals.rom)}`)
	if (r.romBudget) lines.push(`    └ ${formatBudget(r.romBudget)}`)
	lines.push(`  RAM（RW Data + ZI Data）：${formatBytes(r.totals.ram)}`)
	if (r.ramBudget) lines.push(`    └ ${formatBudget(r.ramBudget)}`)
	if (r.totals.code !== null) {
		lines.push(
			`  明细：Code ${formatBytes(r.totals.code)} / RO Data ${formatBytes(r.totals.roData)} / RW Data ${formatBytes(r.totals.rwData)} / ZI Data ${formatBytes(r.totals.ziData)}`,
		)
	}
	lines.push(`  可排序条目数：${r.objectCount}（合计 ROM ${r.sumRom} B / RAM ${r.sumRam} B）`)

	lines.push('')
	lines.push(`自洽校验：${r.crossCheck.passed === null ? '不适用' : r.crossCheck.passed ? '通过' : '不通过'}`)
	lines.push(`  ${r.crossCheck.detail}`)

	if (r.top.length > 0) {
		const granText = { symbol: '符号级（函数与对象）', object: '目标文件/输入段级', section: '段级' }
		lines.push('')
		lines.push(`体积大户（${granText[r.granularity] ?? r.granularity}，按 ROM 降序，前 ${r.top.length} 名）：`)
		r.top.forEach((c, i) => {
			lines.push(
				`  ${String(i + 1).padStart(2)}. ${c.object}  ROM ${c.rom} B  RAM ${c.ram} B` +
					`（code ${c.code} + ro ${c.roData} + rw ${c.rwData} + zi ${c.ziData}）${c.generated ? ' [链接器生成/填充]' : ''}`,
			)
		})
	}

	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `fw_size` 工具（自动识别 ELF / GNU map / Keil map）。 */
function defineFwSizeTool() {
	return defineTool({
		name: 'fw_size',
		description:
			'分析固件体积，自动识别三种输入：① ELF 文件（推荐，任意工具链与架构的最终产物，直接读节区表）；② GNU ld 的 .map（GCC/PlatformIO/ESP-IDF/Zephyr，需链接时加 -Wl,-Map=xxx.map）；③ Keil MDK 的 .map。输出 ROM（Flash 镜像）与 RAM 的实际占用、Code/RO/RW/ZI 明细、体积大户排序，可选对比预算算占用率。做体积优化前先用它量化定位。',
		parameters: {
			path: {
				type: 'string',
				required: true,
				description: 'ELF 文件、GNU ld .map 或 Keil .map 的路径。格式自动识别，无需指定。',
			},
			format: {
				type: 'string',
				enum: ['auto', 'elf', 'keil-map', 'gnu-map'],
				description: '强制指定格式；默认 auto 自动识别。识别失败时可手动指定。',
			},
			top_n: { type: 'integer', description: '返回前 N 个体积大户，默认 10。' },
			rom_budget: { type: 'integer', description: 'Flash 预算字节数；给了才计算占用率与余量。' },
			ram_budget: { type: 'integer', description: 'RAM 预算字节数；给了才计算占用率与余量。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderSizeReport(value) }],
			presentationMeta: (_args, value) => ({
				format: value.format,
				rom: value.totals.rom,
				ram: value.totals.ram,
			}),
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const buffer = await readFile(args.path)
			// map 文本跟随系统区域设置（中文 Windows 多为 GBK），复用 keil.js 的编码探测。
			const decoded = decodeLog(buffer)
			// 走与验证脚本完全相同的入口，保证"测过的就是跑的"。
			const report = analyzeBuffer(buffer, decoded, {
				format: args.format,
				topN: args.top_n,
				romBudget: args.rom_budget,
				ramBudget: args.ram_budget,
				source: args.path,
			})
			return { ...report, requestedFormat: args.format ?? 'auto' }
		},
		presentCall: (args) => ({
			card: 'generic',
			title: '分析固件体积',
			kind: 'read',
			rawInput: args.path,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 2：proto_frame（Modbus + 通用 CRC）                             */
/* ------------------------------------------------------------------ */

/** 协议工具的渲染函数。 */
function renderProtoResult(r) {
	const lines = []
	const hex16 = (n) => `0x${n.toString(16).padStart(r.width / 4, '0').toUpperCase()}`

	if (r.action === 'crc') {
		lines.push(`${r.presetLabel}`)
		lines.push(`  参数：位宽 ${r.width} / poly ${hex16(r.poly)} / init ${hex16(r.init)} / refin ${r.refin} / refout ${r.refout} / xorout ${hex16(r.xorout)}`)
		lines.push(`  载荷：${r.dataHex}（${r.length} 字节）`)
		lines.push(`  校验值 = ${hex16(r.crc)}`)
		lines.push(`  线上字节（${r.order === 'le' ? '低字节先' : '高字节先'}）：${r.crcBytesHex}`)
		lines.push(`  附上校验后的完整帧：${r.hex}`)
		return lines.join('\n')
	}

	if (r.action === 'build') {
		lines.push(`Modbus RTU 帧已构建：${r.hex}`)
		lines.push(`  从站地址 ${r.slave}，功能码 0x${r.function.toString(16).padStart(2, '0')}（${r.functionName}）`)
		lines.push(`  数据域：${r.dataHex.length > 0 ? r.dataHex : '（空）'}`)
		lines.push(`  CRC16 = 0x${r.crc.toString(16).padStart(4, '0')}，线上字节顺序为低字节先：${r.crcBytesHex}`)
		if (r.slave === 0) lines.push('  注意：地址 0 是广播，从站不会应答。')
		return lines.join('\n')
	}

	lines.push(`帧审查（${r.presetLabel}）：${r.hex}`)
	lines.push(`  长度：${r.length} 字节`)
	lines.push(`  校验：${r.valid ? '通过' : '失败'}`)
	if (r.reason) lines.push(`  原因：${r.reason}`)
	if (r.isModbus) {
		if (r.slave !== null) lines.push(`  从站地址：${r.slave}`)
		if (r.functionName) {
			lines.push(
				`  功能码：0x${r.function.toString(16).padStart(2, '0')}（${r.functionName}）${r.isException ? ' ← 异常响应（最高位置 1）' : ''}`,
			)
		}
		if (r.exceptionName) lines.push(`  异常码：${r.exceptionName}`)
	}
	lines.push(`  数据域：${r.dataHex.length > 0 ? r.dataHex : '（空）'}`)
	if (r.crcInFrame !== null) lines.push(`  校验值：帧内 ${hex16(r.crcInFrame)} / 实算 ${hex16(r.crcComputed)}`)
	return lines.join('\n')
}

/** 定义 `proto_frame` 工具。 */
function defineProtoFrameTool() {
	return defineTool({
		name: 'proto_frame',
		description:
			'串行协议帧工具，三种动作：build 构建 Modbus RTU 帧（自动追加 CRC）、verify 审查帧（校验并拆字段；Modbus 会把功能码与异常码翻译成中文）、crc 计算通用校验值。校验算法参数化（位宽/poly/init/refin/refout/xorout），内置 CRC-16/MODBUS、CRC-16/CCITT-FALSE、CRC-16/XMODEM、CRC-16/ARC、CRC-16/X-25、CRC-16/DNP、CRC-8、CRC-8/MAXIM、CRC-32 以及 sum8/sum16/xor8；也可传自定义参数算任意厂商的 CRC。',
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['build', 'verify', 'crc'],
				description: 'build 构建 Modbus RTU 帧 / verify 审查帧 / crc 计算通用校验值。',
			},
			data: {
				type: 'string',
				description: 'build 的数据域；crc 动作的载荷。十六进制串，如 "00 00 00 0A"。',
			},
			frame: { type: 'string', description: 'verify 的完整帧（含校验字节），十六进制串。' },
			slave: { type: 'integer', description: 'Modbus 从站地址 0-247（build 必填，0 为广播）。' },
			function_code: { type: 'integer', description: 'Modbus 功能码 1-127（build 必填），如 3=读保持寄存器、6=写单个寄存器。' },
			preset: {
				type: 'string',
				enum: PRESET_NAMES,
				description: `校验预设（crc 与 verify 用），默认 crc16-modbus。可选：${PRESET_NAMES.join(', ')}`,
			},
			order: {
				type: 'string',
				enum: ['le', 'be'],
				description: '校验值上线的字节顺序，le=低字节先（Modbus 等多数串行协议），be=高字节先。默认 le。',
			},
			crc_params: {
				type: 'object',
				additionalProperties: false,
				description: '自定义 CRC 参数；提供后覆盖 preset，可算任意厂商自定义 CRC。',
				properties: {
					width: { type: 'integer', required: true, description: '位宽：8 / 16 / 32。' },
					poly: { type: 'integer', required: true, description: '生成多项式（已去掉最高位），如 0x1021。' },
					init: { type: 'integer', description: '初值。' },
					xorout: { type: 'integer', description: '最终异或值。' },
					refin: { type: 'boolean', description: '输入是否按字节反射。' },
					refout: { type: 'boolean', description: '输出是否反射。' },
				},
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderProtoResult(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const presetName = args.preset ?? 'crc16-modbus'
			const order = args.order ?? 'le'

			/** 解析实际生效的校验参数：自定义优先于预设。 */
			function resolveParams() {
				if (args.crc_params) {
					return {
						params: {
							width: args.crc_params.width,
							poly: args.crc_params.poly,
							init: args.crc_params.init ?? 0,
							xorout: args.crc_params.xorout ?? 0,
							refin: args.crc_params.refin === true,
							refout: args.crc_params.refout === true,
						},
						label: '自定义参数',
					}
				}
				const preset = CRC_PRESETS[presetName]
				if (!preset) throw new Error(`未知校验预设 '${presetName}'。可用：${PRESET_NAMES.join(', ')}`)
				return { params: preset, label: preset.label }
			}

			if (args.action === 'crc') {
				if (!args.data) throw new Error('crc 动作需要 data（载荷十六进制串）')
				const bytes = parseHex(args.data)
				const { params, label } = resolveParams()
				const crc = computeCheck(bytes, params)
				const bytesOut = order === 'le' ? checkBytesLE(crc, params.width) : checkBytesBE(crc, params.width)
				return {
					action: 'crc',
					presetLabel: label,
					width: params.width,
					poly: params.poly ?? 0,
					init: params.init ?? 0,
					refin: params.refin === true,
					refout: params.refout === true,
					xorout: params.xorout ?? 0,
					order,
					length: bytes.length,
					dataHex: toHex(bytes),
					crc,
					crcBytesHex: toHex(bytesOut),
					hex: toHex([...bytes, ...bytesOut]),
				}
			}

			if (args.action === 'build') {
				if (!Number.isInteger(args.slave)) throw new Error('build 需要 slave（从站地址）')
				if (!Number.isInteger(args.function_code)) throw new Error('build 需要 function_code（功能码）')
				const data = args.data ? parseHex(args.data) : []
				const frame = buildFrame({ slave: args.slave, function: args.function_code, data })
				const crc = crc16Modbus(frame.slice(0, frame.length - 2))
				return {
					action: 'build',
					slave: args.slave,
					function: args.function_code,
					functionName: FUNCTION_NAMES[args.function_code] ?? `未知功能码 0x${args.function_code.toString(16)}`,
					dataHex: toHex(data),
					hex: toHex(frame),
					crc,
					crcBytesHex: toHex([crc & 0xff, (crc >>> 8) & 0xff]),
				}
			}

			if (args.action === 'verify') {
				if (!args.frame) throw new Error('verify 需要 frame（完整帧十六进制串）')
				const bytes = parseHex(args.frame)
				const { params, label } = resolveParams()
				const isModbus = !args.crc_params && presetName === 'crc16-modbus'

				if (isModbus) {
					// Modbus 走专门的路径：能拆地址、功能码、异常码。
					const v = verifyFrame(bytes)
					return {
						action: 'verify',
						presetLabel: label,
						width: 16,
						isModbus: true,
						length: bytes.length,
						hex: v.hex,
						valid: v.valid,
						reason: v.reason,
						slave: v.slave,
						function: v.function,
						functionName: v.functionName,
						isException: v.isException,
						exceptionName: v.exceptionName,
						dataHex: toHex(v.data),
						crcInFrame: v.crcInFrame,
						crcComputed: v.crcComputed,
					}
				}

				// 通用路径：只按给定算法校验尾部校验字节。
				const sizeBytes = params.width / 8
				if (bytes.length < sizeBytes + 1) {
					throw new Error(`帧长 ${bytes.length} 字节，不足以容纳 ${sizeBytes} 字节校验值 + 至少 1 字节数据`)
				}
				const body = bytes.slice(0, bytes.length - sizeBytes)
				const trailer = bytes.slice(bytes.length - sizeBytes)
				const inFrame = order === 'le' ? fromBytesLE(trailer) : fromBytesBE(trailer)
				const crcComputed = computeCheck(body, params)
				const valid = inFrame === crcComputed
				return {
					action: 'verify',
					presetLabel: label,
					width: params.width,
					isModbus: false,
					length: bytes.length,
					hex: toHex(bytes),
					valid,
					reason: valid
						? null
						: `校验不匹配：帧内 0x${inFrame.toString(16).toUpperCase()}，实算 0x${crcComputed.toString(16).toUpperCase()}（若只有这一处不符，常见成因是低/高字节次序颠倒）`,
					slave: null,
					functionName: null,
					isException: false,
					exceptionName: null,
					dataHex: toHex(body),
					crcInFrame: inFrame,
					crcComputed,
				}
			}

			throw new Error(`未知 action：${args.action}`)
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `协议帧：${args.action}`,
			kind: 'other',
			rawInput: args,
		}),
	})
}

/**
 * 按低字节先拼出一个整数。
 * @param {number[]} bytes - 字节数组。
 * @returns {number} 整数值。
 */
function fromBytesLE(bytes) {
	let v = 0
	for (let i = bytes.length - 1; i >= 0; i--) v = (v * 256 + bytes[i]) >>> 0
	return v
}

/**
 * 按高字节先拼出一个整数。
 * @param {number[]} bytes - 字节数组。
 * @returns {number} 整数值。
 */
function fromBytesBE(bytes) {
	let v = 0
	for (const b of bytes) v = (v * 256 + b) >>> 0
	return v
}

/* ------------------------------------------------------------------ */
/* 工具 3：rs485_timing                                                */
/* ------------------------------------------------------------------ */

/** RS-485 时序工具的渲染函数。 */
function renderTiming(r) {
	const lines = []
	lines.push(`RS-485 时序计算（波特率 ${r.baud}，${r.bitsPerChar} 位/字符）`)
	lines.push(`  位时间   ：${r.bitTimeUs} µs`)
	lines.push(`  字符时间 ：${r.charTimeUs} µs`)
	lines.push(`  发送 ${r.frameBytes} 字节耗时：${r.frameTimeUs} µs`)
	lines.push('')
	lines.push(`Modbus RTU 静默时间（${r.modbus.note}）：`)
	lines.push(`  t1.5 字符间超时 = ${r.modbus.t15Us} µs`)
	lines.push(`  t3.5 帧间静默   = ${r.modbus.t35Us} µs`)
	lines.push('')
	lines.push('方向切换窗口（DE/RE）：')
	lines.push(`  驱动使能提前量 = ${r.turnaround.driverEnableUs} µs（发首字节前 DE 至少提前这么久置起，软件责任）`)
	lines.push(`  驱动关闭保持量 = ${r.turnaround.driverDisableUs} µs`)
	lines.push(`  总线占用窗口合计 = ${r.turnaround.busOccupancyUs} µs（参考值；一帧的传输时间可远大于 t3.5，本身合法）`)
	lines.push(
		`  驱动关闭是否装得进 t3.5 帧间静默：${r.turnaround.disableFitsInSilence ? '是' : '否 —— 从站靠 ≥t3.5 的静默判定帧边界，驱动关闭太慢会吃掉静默期、把一帧撕裂成两帧'}`,
	)
	if (r.transaction) {
		lines.push('')
		lines.push(
			`整笔事务线路时间（请求 ${r.transaction.requestBytes} B + 响应 ${r.transaction.responseBytes} B）= ${r.transaction.wireTimeUs} µs`,
		)
		lines.push(`  注：${r.transaction.note}`)
	}
	if (r.pending.length > 0) {
		lines.push('')
		lines.push('以下参数未提供，未计入结果（它们来自收发器数据手册，不能凭型号猜）：')
		for (const p of r.pending) lines.push(`  - ${p}`)
	}
	lines.push('')
	lines.push('提醒：以上均为按公式算出的**设计值**，不是实测值。要断言实际裕量，请在 DE 脚与总线 A/B 上同时抓波形。')
	return lines.join('\n')
}

/** 定义 `rs485_timing` 工具。 */
function defineRs485TimingTool() {
	return defineTool({
		name: 'rs485_timing',
		description:
			'计算 RS-485 / UART 半双工时序：位与字符时间、发送耗时、Modbus RTU 的 t1.5 与 t3.5 静默时间，并在提供收发器使能/关闭时间时合成 DE/RE 方向切换窗口。适用于任意芯片与收发器。注意：输出是按公式算出的设计值，不是实测值。',
		parameters: {
			baud: { type: 'integer', required: true, description: '波特率（bit/s），如 9600、115200。' },
			data_bits: { type: 'integer', description: '数据位，默认 8。' },
			parity: {
				type: 'string',
				enum: ['none', 'even', 'odd', 'mark', 'space'],
				description: '校验方式，默认 none。',
			},
			stop_bits: { type: 'number', description: '停止位，默认 1（可填 1.5 或 2）。' },
			frame_bytes: { type: 'integer', description: '待发送帧长度（字节），默认 8。' },
			response_bytes: { type: 'integer', description: '预期响应帧长度（字节）；给了才估算整笔事务线路时间。' },
			driver_enable_ns: {
				type: 'integer',
				description: '收发器驱动使能时间 tPZH/tPZL（ns），**必须查数据手册填入**，不要猜。',
			},
			driver_disable_ns: {
				type: 'integer',
				description: '收发器驱动关闭时间 tPHZ/tPLZ（ns），**必须查数据手册填入**，不要猜。',
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderTiming(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const report = analyzeTiming({
				baud: args.baud,
				dataBits: args.data_bits,
				parity: args.parity,
				stopBits: args.stop_bits,
				frameBytes: args.frame_bytes,
				responseBytes: args.response_bytes,
				driverEnableNs: args.driver_enable_ns,
				driverDisableNs: args.driver_disable_ns,
			})
			return { baud: args.baud, ...report }
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `半双工时序 ${args.baud} bps`,
			kind: 'other',
			rawInput: args,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 总线与协议工具组（I²C / CAN / SPI / I²S / LIN / 1-Wire / RS-232）      */
/*                                                                     */
/* 这一组共享同一种输出形状（checks / warnings / notes），所以渲染只写一次。 */
/* 每个模块的常量出处都写在各自 lib/*.js 的头部注释里。                     */
/* ------------------------------------------------------------------ */

/**
 * 协议工具的通用渲染：判定 → 需要注意 → 说明。
 *
 * @param {string} title - 标题行。
 * @param {object} r - 分析结果（含 checks / warnings / notes）。
 * @param {string[]} [extraLines] - 标题后要补的具体数值行。
 * @returns {string} 渲染文本。
 */
function renderProtocolReport(title, r, extraLines = []) {
	const lines = [title]
	for (const l of extraLines) lines.push(l)
	if (Array.isArray(r.errors) && r.errors.length > 0) {
		lines.push('')
		lines.push(`错误（${r.errors.length} 项）：`)
		for (const e of r.errors) lines.push(`  [错误] ${e}`)
	}
	if (Array.isArray(r.checks) && r.checks.length > 0) {
		lines.push('')
		lines.push('判定：')
		for (const c of r.checks) lines.push(`  ${c.pass ? '[通过]' : '[不通过]'} ${c.name}：${c.detail}`)
	}
	if (Array.isArray(r.warnings) && r.warnings.length > 0) {
		lines.push('')
		lines.push('需要注意：')
		for (const w of r.warnings) lines.push(`  ! ${w}`)
	}
	if (Array.isArray(r.notes) && r.notes.length > 0) {
		lines.push('')
		for (const n of r.notes) lines.push(`  · ${n}`)
	}
	return lines.join('\n')
}

/**
 * 把 `integrate/*.tool.mjs` 的描述符装成 DSH 工具。
 *
 * 描述符形状：`{ name, title, description, parameters, execute, summaryLines? }`，
 * `execute(args)` 返回的对象**必须含 `checks` / `warnings` / `notes`**（形状同 lib/i2c.js）。
 *
 * 之所以走描述符而不是把工具定义写在本文件里：
 * 让每个模块在自己的文件里声明工具、本文件只做一次装载，避免多处改动汇聚到同一个文件。
 * 代价是多一层间接——所以描述符里的 `description` 必须自洽（它直接呈现给模型）。
 *
 * @param {object} d - 工具描述符。
 * @returns {object} `defineTool` 的返回值。
 */
function toolFromDescriptor(d) {
	if (typeof d?.name !== 'string' || typeof d.execute !== 'function') {
		throw new Error('工具描述符缺少 name 或 execute')
	}
	return defineTool({
		name: d.name,
		description: d.description,
		parameters: d.parameters ?? {},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => [
				{
					type: 'text',
					text: renderProtocolReport(
						v?.title ?? d.title ?? d.name,
						v,
						typeof d.summaryLines === 'function' ? d.summaryLines(v) : [],
					),
				},
			],
		},
		isConcurrencySafe: () => true,
		execute: (args) => d.execute(args),
		presentCall: (args) => ({ card: 'generic', title: d.name, kind: 'other', rawInput: args }),
	})
}

/** 定义 `i2c_bus` 工具。 */
function defineI2cBusTool() {
	return defineTool({
		name: 'i2c_bus',
		description:
			'算 I²C / SMBus 的上拉电阻区间与可行性：给总线总电容与模式（standard 100k / fast 400k / fast-plus 1M / high-speed），' +
			'得 Rp(min)（由灌电流决定）与 Rp(max)（由上升时间决定，可选叠加器件漏电流约束），并判定电容是否超规范上限、区间是否为空。' +
			'给了实际上拉值还能反算上升时间与最大速率。公式出自 NXP UM10204。输出是设计值，实际上升时间必须用示波器在成品板上量。',
		parameters: {
			mode: {
				type: 'string',
				required: true,
				enum: I2C_MODE_IDS,
				description: '总线模式。',
			},
			cb_pf: {
				type: 'integer',
				required: true,
				description: '总线总电容（pF），含走线、器件引脚与连接器。它是硬约束，不是"尽量小"。',
			},
			rp_ohm: { type: 'integer', description: '实际选用的上拉电阻（Ω）；给了就反算上升时间并校验。' },
			vdd_v: { type: 'number', description: '总线电源电压（V），默认 3.3。' },
			total_leak_ua: {
				type: 'number',
				description: '总线上所有器件的高电平输入漏电流之和（µA）；给了才计入"漏电流把高电平拖低"这条上限。',
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(`${v.modeLabel} — 上拉与可行性`, v, [
							`  Rp(min) = ${Math.round(v.rpMinOhm)} Ω（灌电流约束）`,
							`  Rp(max) = ${v.rpMaxOhm === null ? '—' : Math.round(v.rpMaxOhm) + ' Ω'}` +
								`（上升时间约束 ${Math.round(v.rpMaxFromTrOhm)} Ω` +
								`${v.rpMaxFromLeakOhm === null ? '' : `，漏电流约束 ${Math.round(v.rpMaxFromLeakOhm)} Ω`}）`,
							`  总线电容 ${v.cbPf} pF（该模式上限 ${v.cbMaxPf} pF）`,
							v.trActualNs === null
								? '  未给实际上拉值，未反算上升时间'
								: `  选定 ${v.rpActualOhm} Ω → 上升时间 ≈ ${v.trActualNs.toFixed(0)} ns（上限 ${v.trMaxNs} ns）`,
						]),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeI2c({
				mode: args.mode,
				cbPf: args.cb_pf,
				rpOhm: args.rp_ohm,
				vddV: args.vdd_v ?? 3.3,
				totalLeakA: args.total_leak_ua === undefined ? 0 : args.total_leak_ua * 1e-6,
			})
		},
		presentCall: (args) => ({ card: 'generic', title: `I²C 上拉 (${args.mode})`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `can_timing` 工具。 */
function defineCanTimingTool() {
	return defineTool({
		name: 'can_timing',
		description:
			'由 CAN 控制器时钟与目标波特率反算位时序：枚举能精确命中的 BRP/TSEG1/TSEG2/SJW 组合，给出采样点位置、' +
			'振荡器容差 df（Bosch/CiA 的两条约束取小值）、传播段可覆盖的最大单向延迟，以及可直接写寄存器的编程值（功能值 − 1）。' +
			'排序以采样点接近 87.5% 优先，不是单纯取容差最大。公式出自 Bosch/CiA《The Configuration of the CAN Bit Timing》。',
		parameters: {
			fclk_hz: { type: 'integer', required: true, description: 'CAN 控制器输入时钟（Hz），如 36000000。' },
			bitrate: { type: 'integer', required: true, description: '目标波特率（bit/s），如 500000。' },
			sample_point_target: {
				type: 'number',
				description: '期望采样点比例，默认 0.875（CAN 惯例）。排序的第二优先级就是离它最近。',
			},
			sample_point_min: { type: 'number', description: '采样点下限，默认 0.75。' },
			sample_point_max: { type: 'number', description: '采样点上限，默认 0.9。' },
			nbt_min: { type: 'integer', description: '总位时间下限（tq），默认 8。' },
			nbt_max: { type: 'integer', description: '总位时间上限（tq），默认 25。' },
			sjw_max: { type: 'integer', description: 'SJW 功能值上限，默认 4（经典 CAN）。' },
			top_n: { type: 'integer', description: '返回前 N 个候选，默认 5。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				if (v.candidates.length === 0) {
					return [
						{
							type: 'text',
							text: renderProtocolReport(`CAN 位时序（${v.fclk} Hz → ${v.bitrate} bit/s）`, v, [
								'  没有可用组合：该时钟在给定的 NBT 范围内凑不出这个波特率。',
							]),
						},
					]
				}
				const rows = v.candidates
					.slice(0, v.topN)
					.map(
						(c, i) =>
							`  ${i + 1}. BRP=${c.brp} NBT=${c.nbt} prop=${c.propSeg} p1=${c.phaseSeg1} p2=${c.phaseSeg2} sjw=${c.sjw}` +
							`\n     采样点 ${c.samplePointPercent.toFixed(1)}%  振荡器容差 ±${c.oscTolerancePercent.toFixed(3)}%` +
							`  误差 ${c.bitrateErrorPpm} ppm  单向延迟≤${c.maxOneWayDelayUs.toFixed(2)} µs` +
							`\n     寄存器 {BRP:${c.registers.BRP}, TSEG1:${c.registers.TSEG1}, TSEG2:${c.registers.TSEG2}, SJW:${c.registers.SJW}}`,
					)
				return [
					{
						type: 'text',
						text: renderProtocolReport(
							`CAN 位时序（${v.fclk} Hz → ${v.bitrate} bit/s，共 ${v.candidates.length} 组候选）`,
							v,
							[`  位时间 = ${v.targetProductBrpNbt} tq（BRP × NBT 的积，整数才能精确命中）`, '', ...rows],
						),
					},
				]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const r = bestBitTiming({
				fclk: args.fclk_hz,
				bitrate: args.bitrate,
				samplePointTarget: args.sample_point_target,
				samplePointMin: args.sample_point_min,
				samplePointMax: args.sample_point_max,
				nbtMin: args.nbt_min,
				nbtMax: args.nbt_max,
				sjwMax: args.sjw_max,
			})
			return { ...r, topN: args.top_n ?? 5 }
		},
		presentCall: (args) => ({ card: 'generic', title: `CAN ${args.bitrate} bps`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `spi_bus` 工具。 */
function defineSpiBusTool() {
	return defineTool({
		name: 'spi_bus',
		description:
			'SPI 三件事：① 把 CPOL/CPHA 四种模式翻译成"哪个边沿采样、哪个边沿移出"（确定定义，防最常见的配置错误）；' +
			'② 用一阶模型估最高 SCK——把主控 tV、从器件 tSU/tH 与走线偏斜串成半个周期的预算；' +
			'③ 按 SCK 与每帧位数算有效吞吐（含帧间空隙）。SPI 没有统一时序规范，tV/tSU 必须来自各自数据手册；模型结果是估计值，最终要用示波器看实际波形。',
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['mode', 'max-clock', 'bandwidth'],
				description: 'mode=解释模式；max-clock=估最高时钟；bandwidth=算吞吐。',
			},
			mode: { type: 'integer', enum: [0, 1, 2, 3], description: 'CPOL/CPHA 组合，0~3。action=mode 时必填。' },
			master_data_valid_ns: { type: 'integer', description: '主控输出数据有效时间（ns），查主控手册。' },
			slave_setup_ns: { type: 'integer', description: '从器件数据建立时间 tSU（ns），查从器件手册。' },
			slave_data_valid_ns: { type: 'integer', description: '从器件输出数据有效时间（ns），估读方向时给。' },
			master_setup_ns: { type: 'integer', description: '主控采样建立时间（ns），估读方向时给。' },
			skew_ns: { type: 'integer', description: '走线偏斜与余量（ns），默认 0；保守起见应给正值。' },
			sck_hz: { type: 'integer', description: '实际 SCK 频率（Hz）。action=bandwidth 时必填。' },
			bits_per_frame: { type: 'integer', description: '每帧位数（含命令/地址/数据）。action=bandwidth 时必填。' },
			gap_ns: { type: 'integer', description: '帧间空隙（片选拉高、软件开销），ns。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				if (v.kind === 'mode') {
					return [
						{
							type: 'text',
							text: [
								`SPI 模式 ${v.mode}`,
								`  CPOL=${v.cpol}（空闲电平 ${v.idleLevel}），CPHA=${v.cpha}`,
								`  采样边沿：${v.sampleEdge}`,
								`  移出边沿：${v.shiftEdge}`,
							].join('\n'),
						},
					]
				}
				if (v.kind === 'bandwidth') {
					return [
						{
							type: 'text',
							text: [
								`SPI 吞吐（SCK ${v.sckHz} Hz，每帧 ${v.bitsPerFrame} 位）`,
								`  帧时间 ：${v.frameTimeNs.toFixed(0)} ns`,
								`  帧率   ：${Math.round(v.framesPerSecond)} 帧/s`,
								`  等效吞吐：${Math.round(v.effectiveBitsPerSecond)} bit/s`,
								`  链路效率：${v.linkEfficiencyPercent.toFixed(1)}%（帧间空隙越低越高）`,
							].join('\n'),
						},
					]
				}
				return [
					{
						type: 'text',
						text: renderProtocolReport('SPI 最高时钟估计（一阶模型）', v, [
							`  写方向：半周期预算 ${v.writeBudgetNs} ns → 上限 ${(v.writeMaxHz / 1e6).toFixed(2)} MHz`,
							v.readMaxHz === null
								? '  读方向：未提供足够参数'
								: `  读方向：半周期预算 ${v.readBudgetNs} ns → 上限 ${(v.readMaxHz / 1e6).toFixed(2)} MHz`,
							`  取受限者：${(v.bindingMaxHz / 1e6).toFixed(2)} MHz`,
						]),
					},
				]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (args.action === 'mode') return { kind: 'mode', ...describeSpiMode(args.mode) }
			if (args.action === 'bandwidth') {
				return {
					kind: 'bandwidth',
					sckHz: args.sck_hz,
					bitsPerFrame: args.bits_per_frame,
					...spiBandwidth({ sckHz: args.sck_hz, bitsPerFrame: args.bits_per_frame, gapNs: args.gap_ns ?? 0 }),
				}
			}
			return {
				kind: 'max-clock',
				...estimateSpiMaxClock({
					masterDataValidNs: args.master_data_valid_ns,
					slaveSetupNs: args.slave_setup_ns,
					slaveDataValidNs: args.slave_data_valid_ns,
					masterSetupNs: args.master_setup_ns,
					skewNs: args.skew_ns ?? 0,
				}),
			}
		},
		presentCall: (args) => ({ card: 'generic', title: `SPI ${args.action}`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `i2s_clk` 工具。 */
function defineI2sClkTool() {
	return defineTool({
		name: 'i2s_clk',
		description:
			'算 I²S / TDM 的时钟链：由采样率、槽位数与槽数得 LRCK（=fs）与 BCLK，列出常见 MCLK 比率（128~768 × fs），' +
			'并在给出实际 MCLK 或主时钟源时检查整除性——MCLK 不是 fs 整数倍会引入周期性采样点漂移，主时钟分不出 BCLK 则根本跑不起来。全部是确定的算术关系，非估计。',
		parameters: {
			sample_rate_hz: { type: 'integer', required: true, description: '采样率（Hz），如 48000。' },
			slot_bits: { type: 'integer', required: true, description: '每槽位数，如 16 / 24 / 32。' },
			slots: { type: 'integer', description: '每帧槽数，默认 2（立体声 I²S）；TDM 填实际槽数。' },
			mclk_hz: { type: 'integer', description: '实际可提供的 MCLK（Hz）；给了就检查是否是 fs 的整数倍。' },
			input_clock_hz: { type: 'integer', description: '主时钟源（Hz）；给了就检查能否整数分频出 BCLK 与 MCLK。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(
							`I²S / TDM 时钟（fs=${v.sampleRateHz} Hz，${v.slots} 槽 × ${v.slotBits} 位）`,
							v,
							[
								`  LRCK = ${v.lrckHz} Hz`,
								`  BCLK = ${v.bclkHz} Hz（每帧 ${v.bitsPerFrame} 位）`,
								v.mclkHz === null ? '  未给实际 MCLK' : `  MCLK = ${v.mclkHz} Hz = ${v.mclkRatio} × fs`,
								'  常见 MCLK 比率：' + v.mclkTable.map((r) => `${r.ratio}×=${r.mclkHz}`).join('  '),
							],
						),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeI2s({
				sampleRateHz: args.sample_rate_hz,
				slotBits: args.slot_bits,
				slots: args.slots ?? 2,
				mclkHz: args.mclk_hz,
				inputClockHz: args.input_clock_hz,
			})
		},
		presentCall: (args) => ({ card: 'generic', title: `I²S ${args.sample_rate_hz} Hz`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `lin_sched` 工具。 */
function defineLinSchedTool() {
	return defineTool({
		name: 'lin_sched',
		description:
			'算 LIN 帧时间与调度表可行性：按 8N1（每字节 10 位）与固定 34 位帧头（break 13 + 分隔符 1 + sync 10 + PID 10）' +
			'算每帧位时间与最小槽位（规范给出的 1.4 倍调度裕量），并检查整个调度表的槽位合计是否装得进周期。常量出自 LIN 规范。',
		parameters: {
			baud: { type: 'integer', required: true, description: 'LIN 波特率（bit/s），范围 1000~20000。' },
			frames: {
				type: 'array',
				required: true,
				description:
					'帧表。每项 { name, dataBytes, checksumBytes（默认 1）, slotMs（可空） }。不给 slotMs 就按规范最小槽位计入合计。',
			},
			schedule_period_ms: { type: 'number', description: '调度表周期（ms）；给了就检查总槽位是否装得下。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(
							`LIN 调度表（${v.baud} bit/s，位时间 ${v.bitTimeUs.toFixed(3)} µs）`,
							v,
							[
								'',
								'各帧：',
								...v.frames.map(
									(f) =>
										`  ${f.name}：数据 ${f.dataBytes} B → 响应 ${f.responseBits} 位，总计 ${f.totalBits} 位 = ` +
										`${(f.frameTimeUs / 1000).toFixed(3)} ms，规范最小槽位 ${(f.minSlotUs / 1000).toFixed(3)} ms` +
										`${f.slotMs === null ? '' : `，给定槽位 ${f.slotMs} ms`}`,
								),
								v.slotSumMs === null
									? ''
									: `  槽位合计 ≈ ${v.slotSumMs.toFixed(3)} ms / 周期 ${v.schedulePeriodMs} ms`,
							].filter((x) => x !== ''),
						),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeLin({
				baud: args.baud,
				frames: args.frames,
				schedulePeriodMs: args.schedule_period_ms,
			})
		},
		presentCall: (args) => ({ card: 'generic', title: `LIN ${args.baud} bps`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `onewire_timing` 工具。 */
function defineOneWireTool() {
	return defineTool({
		name: 'onewire_timing',
		description:
			'校验 1-Wire **标准速率**的时隙窗口：时隙长度、写 1/写 0 的拉低时间、读时隙拉低时间、恢复时间，逐项对照窗口判定，' +
			'并给出复位与存在脉冲的窗口。窗口出自 Maxim/Analog DS0009 与器件手册。**Overdrive 速率的窗口窄一个量级且各器件不同，本工具不给那组数**，请查具体器件手册。',
		parameters: {
			bit_slot_us: { type: 'number', description: '时隙长度（µs），标准窗口 60~120。' },
			write1_low_us: { type: 'number', description: '写 1 的拉低时间（µs），窗口 1~15。' },
			write0_low_us: { type: 'number', description: '写 0 的拉低时间（µs），窗口 60~120。' },
			read_low_us: { type: 'number', description: '读时隙里主控拉低的时间（µs），窗口 1~15，采样须在 15 µs 内完成。' },
			recovery_us: { type: 'number', description: '时隙之间的恢复时间（µs），下限 1。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => [{ type: 'text', text: renderProtocolReport('1-Wire 标准速率时隙校验', v) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeOneWire({
				bitSlotUs: args.bit_slot_us,
				write1LowUs: args.write1_low_us,
				write0LowUs: args.write0_low_us,
				readLowUs: args.read_low_us,
				recoveryUs: args.recovery_us,
			})
		},
		presentCall: (args) => ({ card: 'generic', title: '1-Wire 时隙', kind: 'other', rawInput: args }),
	})
}

/** 定义 `rs232_link` 工具。 */
function defineRs232Tool() {
	return defineTool({
		name: 'rs232_link',
		description:
			'RS-232（V.28）与 RS-422/485（V.11）的链路电气检查。V.28 侧：驱动器输出幅度（≥±5 V）、接收器门限（±3 V）、' +
			'摆率上限、数据率上限（20 kbit/s），并按线缆电容上限 2500 pF 折算最长线长——**V.28 的长度限制来自电容，不是某个固定米数**。' +
			'V.11 侧：差分幅度下限、终端电阻匹配，并提示速率与长度互相制约（具体曲线查收发器手册）。',
		parameters: {
			standard: {
				type: 'string',
				required: true,
				enum: ['rs232', 'rs422'],
				description: 'rs232=V.28 单端；rs422=V.11 差分。',
			},
			driver_output_v: { type: 'number', description: '驱动器输出幅度（V）。' },
			driver_diff_v: { type: 'number', description: '差分输出幅度（V），rs422 用。' },
			termination_ohm: { type: 'integer', description: '终端电阻（Ω），rs422 用，惯例 120。' },
			cable_length_m: { type: 'number', description: '线缆长度（m）。' },
			cable_pf_per_m: { type: 'number', description: '线缆电容（pF/m）。给了才算最长线长。' },
			data_rate_bps: { type: 'integer', description: '数据率（bit/s）。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(
							v.standard === 'rs232' ? 'RS-232（V.28）链路检查' : 'RS-422/485（V.11）链路检查',
							v,
							v.maxLengthM === null ? [] : [`  按电容折算最长线长 ≈ ${v.maxLengthM.toFixed(0)} m`],
						),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (args.standard === 'rs422') {
				const r = analyzeRs422({
					driverDiffV: args.driver_diff_v,
					terminationOhm: args.termination_ohm,
					dataRateBps: args.data_rate_bps,
					cableLengthM: args.cable_length_m,
				})
				return { standard: 'rs422', maxLengthM: null, ...r }
			}
			const r = analyzeRs232({
				driverOutputV: args.driver_output_v,
				cableLengthM: args.cable_length_m,
				cablePfPerM: args.cable_pf_per_m,
				dataRateBps: args.data_rate_bps,
			})
			return { standard: 'rs232', ...r }
		},
		presentCall: (args) => ({ card: 'generic', title: `${args.standard} 链路`, kind: 'other', rawInput: args }),
	})
}

/* ------------------------------------------------------------------ */
/* 固件镜像 / QSPI / 栈深度（覆盖地图第 1 批）                            */
/* ------------------------------------------------------------------ */

/** 定义 `fw_image` 工具。 */
function defineFwImageTool() {
	return defineTool({
		name: 'fw_image',
		description:
			'固件镜像校验。action=hex：逐条校验 Intel HEX 记录的校验和，检测地址重叠、地址空洞、缺 EOF，给出数据字节数与地址范围；' +
			'若同时给了 Flash/RAM 范围，会把镜像头 8 字节当作向量表校验（SP 是否在 RAM 且 8 字节对齐、复位向量的 Thumb 位、目标是否在 Flash）；' +
			'再给 crc_preset 就算整镜像的 CRC。action=vectors：单独校验一组 SP/复位向量。' +
			'这两个字是上电后硬件读的第一样东西，错了不会有任何 C 层日志，只表现为"不启动"。',
		parameters: {
			action: {
				type: 'string',
				required: true,
				enum: ['hex', 'vectors'],
				description: 'hex=解析并校验 Intel HEX 文件；vectors=直接校验给定的 SP 与复位向量。',
			},
			path: { type: 'string', description: 'Intel HEX 文件路径。action=hex 时必填。' },
			crc_preset: {
				type: 'string',
				enum: PRESET_NAMES,
				description: '算整镜像 CRC 用的预设；不给就不算。常用的如 crc32、crc16-modbus、crc16-xmodem。',
			},
			flash_start: { type: 'integer', description: 'Flash/ROM 起始地址（给范围才会做向量表校验）。' },
			flash_end: { type: 'integer', description: 'Flash/ROM 结束地址（不含）。' },
			ram_start: { type: 'integer', description: 'RAM 起始地址。' },
			ram_end: { type: 'integer', description: 'RAM 结束地址（不含）。' },
			vtor: { type: 'integer', description: '向量表实际地址；应用带 Bootloader 偏移时填应用起始地址。' },
			exception_count: { type: 'integer', description: '异常数量（含系统异常），用于算 VTOR 对齐要求，默认 16。' },
			initial_sp: { type: 'integer', description: '初始栈指针（action=vectors 时必填）。' },
			reset_vector: { type: 'integer', description: '复位向量原始值（含 Thumb 位；action=vectors 时必填）。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => [{ type: 'text', text: renderProtocolReport(v.title, v, v.summaryLines ?? []) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const checks = []
			const warnings = []
			const notes = []
			const errors = []
			const summaryLines = []
			let title = '固件镜像校验'

			if (args.action === 'hex') {
				if (!args.path) throw new Error('action=hex 需要 path（Intel HEX 文件路径）')
				const text = await readFile(args.path, 'utf8')
				const r = parseIntelHex(text)
				errors.push(...r.errors)
				warnings.push(...r.warnings)
				title = `Intel HEX 校验：${args.path}`
				summaryLines.push(
					`  记录数 ${r.recordCount}，数据 ${r.dataBytes} 字节，` +
						`地址范围 ${r.minAddress === null ? '（无数据）' : `0x${r.minAddress.toString(16)}~0x${r.maxAddress.toString(16)}`}`,
				)
				if (r.startLinearAddress !== null) {
					summaryLines.push(`  起始线性地址（记录类型 05）：0x${r.startLinearAddress.toString(16)}`)
				}
				checks.push({
					name: '每条记录校验和',
					pass: r.errors.length === 0,
					detail: r.errors.length === 0 ? '全部记录按字节求和 ≡ 0 (mod 256)' : `${r.errors.length} 条记录校验失败`,
				})
				checks.push({
					name: 'EOF 记录',
					pass: r.eofSeen,
					detail: r.eofSeen ? '存在 :00000001FF' : '缺失（多数烧录器会拒绝该文件）',
				})

				// 给了范围 → 顺带做向量表校验
				if (
					args.flash_start !== undefined && args.flash_end !== undefined &&
					args.ram_start !== undefined && args.ram_end !== undefined &&
					r.minAddress !== null
				) {
					const head = toBuffer(r.bytes, r.minAddress, r.minAddress + 8)
					const sp = head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24)
					const rv = head[4] | (head[5] << 8) | (head[6] << 16) | (head[7] << 24)
					summaryLines.push(
						`  镜像头 8 字节 → 初始 SP = 0x${(sp >>> 0).toString(16).padStart(8, '0')}，` +
							`复位向量 = 0x${(rv >>> 0).toString(16).padStart(8, '0')}`,
					)
					const v = checkVectors({
						initialSp: sp >>> 0,
						resetVector: rv >>> 0,
						flashRange: { start: args.flash_start, end: args.flash_end },
						ramRange: { start: args.ram_start, end: args.ram_end },
						vtor: args.vtor,
						exceptionCount: args.exception_count,
					})
					checks.push(...v.checks)
					warnings.push(...v.warnings)
					notes.push(...v.notes)
				} else {
					notes.push('未给 flash_start/end 与 ram_start/end，跳过了向量表校验。给了范围才会校验 SP 与复位向量。')
				}

				if (args.crc_preset) {
					const preset = CRC_PRESETS[args.crc_preset]
					if (!preset) throw new Error(`未知校验预设 '${args.crc_preset}'。可用：${PRESET_NAMES.join(', ')}`)
					const buf = toBuffer(r.bytes, r.minAddress, r.maxAddress + 1)
					const crc = computeCheck(buf, preset)
					summaryLines.push(`  整镜像 ${args.crc_preset}（${preset.label}）= 0x${crc.toString(16)}`)
					notes.push(
						`CRC 覆盖 0x${r.minAddress.toString(16)}~0x${r.maxAddress.toString(16)}，` +
							`中间的空洞按 0xFF（擦除态）计入——这与烧录后芯片里的实际内容一致。`,
					)
				}
			} else {
				if (args.initial_sp === undefined || args.reset_vector === undefined) {
					throw new Error('action=vectors 需要 initial_sp 与 reset_vector')
				}
				if (args.flash_start === undefined || args.flash_end === undefined || args.ram_start === undefined || args.ram_end === undefined) {
					throw new Error('action=vectors 需要 flash_start/flash_end 与 ram_start/ram_end')
				}
				title = 'Cortex-M 向量表校验'
				const v = checkVectors({
					initialSp: args.initial_sp,
					resetVector: args.reset_vector,
					flashRange: { start: args.flash_start, end: args.flash_end },
					ramRange: { start: args.ram_start, end: args.ram_end },
					vtor: args.vtor,
					exceptionCount: args.exception_count,
				})
				checks.push(...v.checks)
				warnings.push(...v.warnings)
				notes.push(...v.notes)
			}

			return { title, errors, checks, warnings, notes, summaryLines }
		},
		presentCall: (args) => ({ card: 'generic', title: `镜像校验 (${args.action})`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `qspi_flash` 工具。 */
function defineQspiFlashTool() {
	return defineTool({
		name: 'qspi_flash',
		description:
			'QSPI/OSPI Flash 的 dummy cycle 与读带宽。核心关系：D × tCLK ≥ tV，即 dummy 下限 = ceil(tV × f)、给定 dummy 的频率上限 = D / tV。' +
			'**dummy 数是频率的函数**——手册里"读命令需要 N 个 dummy"通常带一个前提频率，换更高时钟必须重算，这是最常见的踩坑点。' +
			'还给出首次数据出现的延迟与随机读/连续读的等效吞吐（小读长时命令+地址开销占比高，这是 XIP 要开连续模式的原因）。tV 必须来自 Flash 手册。',
		parameters: {
			f_hz: { type: 'integer', required: true, description: 'SCK 频率（Hz）。' },
			access_time_ns: {
				type: 'integer',
				required: true,
				description: 'Flash 的 tV / tACC / tCLQV（ns），**必须来自 Flash 数据手册**。',
			},
			mode: {
				type: 'string',
				enum: Object.keys(QSPI_MODES),
				description: '总线宽度模式（命令-地址-数据 的 lane 数），默认 1-4-4。',
			},
			dummy_cycles: { type: 'integer', description: '控制器实际配置的 dummy 数；给了就校验是否足够。' },
			command_bits: { type: 'integer', description: '命令位数，默认 8。' },
			address_bits: { type: 'integer', description: '地址位数，默认 24。' },
			bytes_per_read: { type: 'integer', description: '一次读的字节数，默认 64。' },
			continuous: { type: 'boolean', description: '是否连续读（XIP/burst）：开销只付一次。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(
							`QSPI 读时序（${v.modeLabel}，${(v.fHz / 1e6).toFixed(3)} MHz）`,
							v,
							[
								`  tCLK = ${v.tclkNs.toFixed(3)} ns`,
								`  命令+地址开销 = ${v.overheadClocks} 个时钟`,
								`  **该频率下 dummy 下限 = ${v.dummyNeeded} 个**` +
									(v.dummyConfigured === null ? '' : `（实际配置 ${v.dummyConfigured}）`),
								`  给定 dummy 下的频率上限 = ${(v.maxFrequencyHz / 1e6).toFixed(2)} MHz`,
								`  首次数据延迟 = ${v.latencyNs.toFixed(1)} ns（${v.latencyClocks} 个时钟）`,
								`  一次读 ${v.bytesPerRead} B 耗时 ${v.perReadNs.toFixed(1)} ns → 等效 ${(v.effectiveBitsPerSecond / 1e6).toFixed(2)} Mbit/s`,
							],
						),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeQspi({
				fHz: args.f_hz,
				accessTimeNs: args.access_time_ns,
				mode: args.mode ?? '1-4-4',
				dummyCycles: args.dummy_cycles,
				commandBits: args.command_bits,
				addressBits: args.address_bits,
				bytesPerRead: args.bytes_per_read,
				continuous: args.continuous ?? false,
			})
		},
		presentCall: (args) => ({ card: 'generic', title: `QSPI ${args.f_hz} Hz`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `stack_depth` 工具。 */
function defineStackDepthTool() {
	return defineTool({
		name: 'stack_depth',
		description:
			'栈深度的**静态上界**估算：最坏调用链 = max(各链逐层帧之和)，再叠加最深的 N 层中断帧，与栈区大小比对并检查余量。' +
			'帧大小应取自编译器 -fstack-usage 产生的 .su 文件，不要用"变量字节数"。' +
			'**静态上界不等于实测用量**：函数指针、库函数（printf/浮点）、中断时机都会额外吃栈，' +
			'工具会给出填充法/水位寄存器的实测步骤。另含由水印地址反算已用字节的小工具。',
		parameters: {
			stack_size_bytes: { type: 'integer', required: true, description: '栈区大小（字节）。' },
			call_chains: {
				type: 'array',
				required: true,
				description: '调用链列表。每项 { name, framesBytes: [逐层帧大小] }。中断里调用的链也要列一条。',
			},
			isr_frames_bytes: { type: 'array', description: '各级中断处理函数的帧大小。' },
			max_isr_nesting: { type: 'integer', description: '允许的最大中断嵌套层数，默认 1（由中断优先级决定）。' },
			reserve_ratio: { type: 'number', description: '要求保留的余量比例，默认 0.3。' },
			watermark_address: {
				type: 'integer',
				description: '填充法扫到的水印边界地址；给了就反算已用/剩余字节。需同时给 stack_start。',
			},
			stack_start: { type: 'integer', description: '栈区起始地址（含），用于水印反算。' },
			grows_down: { type: 'boolean', description: '栈是否向下生长，默认 true（Cortex-M）。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				const extra = [
					`  最坏调用链：${v.worstChain.name}（${v.worstChain.frames} 层）= ${v.worstChain.bytes} B`,
					`  中断叠加：${v.isrNesting} 层 = ${v.isrBytes} B`,
					`  总计上界 = ${v.totalBytes} B / 栈区 ${v.stackSizeBytes} B（占用 ${v.utilizationPercent.toFixed(1)}%）`,
					`  余量 = ${v.marginBytes} B（要求 ≥ ${Math.round(v.reserveBytes)} B）`,
				]
				if (v.watermark) {
					extra.push(
						'',
						`  水印反算：已用 ${v.watermark.usedBytes} B，剩余 ${v.watermark.remainingBytes} B` +
							`（${v.watermark.utilizationPercent.toFixed(1)}%）`,
					)
					extra.push(...v.watermark.notes.map((n) => `  · ${n}`))
				}
				return [{ type: 'text', text: renderProtocolReport('栈深度上界估算', v, extra) }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const r = analyzeStack({
				stackSizeBytes: args.stack_size_bytes,
				callChains: args.call_chains,
				isrFramesBytes: args.isr_frames_bytes ?? [],
				maxIsrNesting: args.max_isr_nesting ?? 1,
				reserveRatio: args.reserve_ratio ?? 0.3,
			})
			let watermark = null
			if (args.watermark_address !== undefined) {
				if (args.stack_start === undefined) throw new Error('给了 watermark_address 就必须给 stack_start')
				watermark = usedBytesFromWatermark({
					stackStart: args.stack_start,
					stackSizeBytes: args.stack_size_bytes,
					growsDown: args.grows_down ?? true,
					watermarkAddress: args.watermark_address,
				})
			}
			return { ...r, watermark }
		},
		presentCall: (args) => ({ card: 'generic', title: '栈深度', kind: 'other', rawInput: args }),
	})
}

/* ------------------------------------------------------------------ */
/* 时钟树 / NVIC / 看门狗 / 电源树（覆盖地图第 2 批）                      */
/* ------------------------------------------------------------------ */

/** 定义 `clock_tree` 工具。 */
function defineClockTreeTool() {
	return defineTool({
		name: 'clock_tree',
		description:
			'时钟树三件事。action=solve：给晶振与目标频率，找出能**精确命中**的 PLL 配置（fout = fsrc / inputDiv × mul / outputDiv，整数运算），' +
			'命中不了就如实报最接近的组合与误差百分数——该误差对 UART 可忽略、对 USB/CAN/I²S 是致命的。' +
			'action=evaluate：给一条分频链，逐节点算实际频率并按你给的上限校验。action=uart：算频率误差对异步串口的容错余量（预算 0.5/每帧位数）。' +
			'VCO 区间与外设时钟上限必须来自芯片手册，本工具不内置经验值。',
		parameters: {
			action: { type: 'string', required: true, enum: ['solve', 'evaluate', 'uart'], description: '动作。' },
			source_hz: { type: 'integer', description: '晶振/时钟源频率（Hz）。solve 与 evaluate 必填。' },
			target_hz: { type: 'integer', description: '目标频率（Hz）。action=solve 必填。' },
			input_div_min: { type: 'integer', description: 'PLL 输入分频下限，默认 1。' },
			input_div_max: { type: 'integer', description: 'PLL 输入分频上限，默认 16。' },
			mul_min: { type: 'integer', description: '倍频下限，默认 2。' },
			mul_max: { type: 'integer', description: '倍频上限，默认 512。' },
			output_div_max: { type: 'integer', description: '输出分频上限，默认 16。' },
			vco_min_hz: { type: 'integer', description: 'PLL VCO 频率下限（Hz），来自芯片手册。' },
			vco_max_hz: { type: 'integer', description: 'PLL VCO 频率上限（Hz），来自芯片手册。' },
			top_n: { type: 'integer', description: 'solve 返回前 N 组，默认 5。' },
			stages: {
				type: 'array',
				description: 'evaluate 用：分频链 [{ name, kind: "div"|"mul", value }]。',
			},
			limits: { type: 'array', description: 'evaluate 用：各节点上限 [{ name, maxHz }]，来自芯片手册。' },
			actual_hz: { type: 'integer', description: 'uart 用：实际时钟频率（Hz）。' },
			nominal_hz: { type: 'integer', description: 'uart 用：标称时钟频率（Hz）。' },
			bits_per_frame: { type: 'integer', description: 'uart 用：每帧位数，默认 10。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				if (v.kind === 'solve') {
					const rows =
						v.solutions.length === 0
							? [
									'  精确命中：无',
									v.nearMiss
										? `  最接近：inputDiv=${v.nearMiss.inputDiv} mul=${v.nearMiss.mul} outputDiv=${v.nearMiss.outputDiv}` +
											` → ${v.nearMiss.outHz} Hz（误差 ${v.nearMiss.errHz} Hz）`
										: '  范围内无可行组合',
								]
							: v.solutions
									.slice(0, v.topN)
									.map(
										(s, i) =>
											`  ${i + 1}. inputDiv=${s.inputDiv} mul=${s.mul} outputDiv=${s.outputDiv}` +
											` → PLLin ${(s.pllInHz / 1e6).toFixed(3)} MHz, VCO ${(s.vcoHz / 1e6).toFixed(3)} MHz, OUT ${(s.outHz / 1e6).toFixed(3)} MHz`,
									)
					return [
						{
							type: 'text',
							text: renderProtocolReport(
								`时钟求解：${(v.sourceHz / 1e6).toFixed(3)} MHz → ${(v.targetHz / 1e6).toFixed(3)} MHz`,
								v,
								rows,
							),
						},
					]
				}
				if (v.kind === 'uart') {
					return [
						{
							type: 'text',
							text: renderProtocolReport('异步串口时钟容错', v, [
								`  本端相对误差 ${v.relativeErrorPercent.toFixed(4)}%，预算 ${v.budgetPercent.toFixed(2)}%`,
							]),
						},
					]
				}
				return [
					{
						type: 'text',
						text: renderProtocolReport(
							`时钟链逐节点（源 ${(v.sourceHz / 1e6).toFixed(3)} MHz）`,
							v,
							['', '  节点频率：', ...v.nodes.map((n) => `    ${n.name} = ${(n.hz / 1e6).toFixed(6)} MHz`)],
						),
					},
				]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (args.action === 'solve') {
				const r = solvePll({
					sourceHz: args.source_hz,
					targetHz: args.target_hz,
					inputDivMin: args.input_div_min,
					inputDivMax: args.input_div_max,
					mulMin: args.mul_min,
					mulMax: args.mul_max,
					outputDivMax: args.output_div_max,
					vcoMinHz: args.vco_min_hz,
					vcoMaxHz: args.vco_max_hz,
				})
				return { kind: 'solve', ...r, topN: args.top_n ?? 5 }
			}
			if (args.action === 'uart') {
				return {
					kind: 'uart',
					...uartTolerance({
						actualHz: args.actual_hz,
						nominalHz: args.nominal_hz,
						bitsPerFrame: args.bits_per_frame,
					}),
				}
			}
			return { kind: 'evaluate', ...evaluateClockChain({ sourceHz: args.source_hz, stages: args.stages, limits: args.limits ?? [] }) }
		},
		presentCall: (args) => ({ card: 'generic', title: `时钟 ${args.action}`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `nvic_priority` 工具。 */
function defineNvicPriorityTool() {
	return defineTool({
		name: 'nvic_priority',
		description:
			'Cortex-M 中断优先级与延迟预算。action=grouping：由已实现优先级位数（__NVIC_PRIO_BITS，查手册）与子优先级位数算出抢占级数、各级数与 8 位寄存器里的实际位位置。' +
			'action=preempt：判断两个中断能否互相抢占——**抢占位相同则彼此不能抢占，无论子优先级差多少**（最常见的误判）。' +
			'action=latency：中断延迟上界 = 最长关中断窗口 + 更高优先级 ISR 之和（保守）+ 入栈开销，可与要求值比对。',
		parameters: {
			action: { type: 'string', required: true, enum: ['grouping', 'preempt', 'latency'], description: '动作。' },
			implemented_bits: { type: 'integer', description: '已实现优先级位数（查手册，常见 2~4）。grouping 与 preempt 必填。' },
			sub_priority_bits: { type: 'integer', description: '子优先级位数。grouping 与 preempt 必填。' },
			a_priority: { type: 'integer', description: '中断 a 的**功能优先级值**（0 起，越小越高）。action=preempt 必填。' },
			b_priority: { type: 'integer', description: '中断 b 的功能优先级值。action=preempt 必填。' },
			disabled_windows_us: { type: 'array', description: 'latency 用：[{ name, us }] 各处关中断代码段。' },
			higher_priority_isrs_us: { type: 'array', description: 'latency 用：[{ name, us }] 更高优先级 ISR 的执行时间。' },
			entry_overhead_us: { type: 'number', description: '入栈+取向量开销（µs）。Cortex-M 典型 12 周期，按主频折算。' },
			requirement_us: { type: 'number', description: '业务要求的最坏响应时间（µs）；给了就判定。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				if (v.kind === 'grouping') {
					return [
						{
							type: 'text',
							text: renderProtocolReport('NVIC 优先级分组', v, [
								`  已实现 ${v.implementedBits} 位（位于 8 位寄存器的高 ${v.implementedBits} 位），低 ${8 - v.implementedBits} 位无效`,
								`  抢占 ${v.preemptBits} 位 → ${v.preemptLevels} 级；子优先级 ${v.subPriorityBits} 位 → ${v.subLevels} 级`,
							]),
						},
					]
				}
				if (v.kind === 'preempt') {
					return [
						{
							type: 'text',
							text: renderProtocolReport('中断抢占判定', v, [
								`  a：抢占级 ${v.aPreempt}，子级 ${v.aSub}`,
								`  b：抢占级 ${v.bPreempt}，子级 ${v.bSub}`,
								`  **a 能否抢占 b：${v.preempts ? '能' : '不能'}**`,
							]),
						},
					]
				}
				return [
					{
						type: 'text',
						text: renderProtocolReport('中断延迟上界', v, [
							`  最长关中断窗口：${v.longestDisabled.name} = ${v.longestDisabled.us} µs`,
							`  更高优先级 ISR 之和 = ${v.isrSum} µs；入栈开销 ${v.entryOverheadUs} µs`,
							`  **上界 = ${v.upperBoundUs.toFixed(2)} µs**`,
						]),
					},
				]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (args.action === 'grouping') {
				return { kind: 'grouping', ...priorityGrouping({ implementedBits: args.implemented_bits, subPriorityBits: args.sub_priority_bits }) }
			}
			if (args.action === 'preempt') {
				return {
					kind: 'preempt',
					...canPreempt({
						aPriority: args.a_priority,
						bPriority: args.b_priority,
						implementedBits: args.implemented_bits,
						subPriorityBits: args.sub_priority_bits,
					}),
				}
			}
			return {
				kind: 'latency',
				...analyzeInterruptLatency({
					disabledWindowsUs: args.disabled_windows_us ?? [],
					higherPriorityIsrsUs: args.higher_priority_isrs_us ?? [],
					entryOverheadUs: args.entry_overhead_us ?? 0,
					requirementUs: args.requirement_us,
				}),
			}
		},
		presentCall: (args) => ({ card: 'generic', title: `NVIC ${args.action}`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `watchdog_check` 工具。 */
function defineWatchdogTool() {
	return defineTool({
		name: 'watchdog_check',
		description:
			'看门狗超时窗口与喂狗点可行性。action=solve：由计数时钟与目标超时反算预分频与重载。action=timeout：由计数参数算超时时间（(reload+1)×prescaler/clock）。' +
			'action=check：判定**最坏**喂狗间隔是否落在允许区间——窗口型看门狗还要求喂狗不能太早（下限），喂早了同样复位。' +
			'会给上电路径检查（初始化耗时是否超过超时）。**特别提醒不要在中断里喂狗**，那会掩盖主循环卡死。',
		parameters: {
			action: { type: 'string', required: true, enum: ['solve', 'timeout', 'check'], description: '动作。' },
			clock_hz: { type: 'integer', description: '看门狗计数时钟（Hz）。solve 与 timeout 必填。' },
			target_timeout_us: { type: 'number', description: '目标超时（µs）。action=solve 必填。' },
			prescaler: { type: 'integer', description: '预分频。action=timeout 必填。' },
			reload: { type: 'integer', description: '重载值。action=timeout 必填。' },
			prescaler_max: { type: 'integer', description: '预分频上限，默认 256。' },
			reload_max: { type: 'integer', description: '重载值上限，默认 4095。' },
			timeout_us: { type: 'number', description: '看门狗超时（µs）。action=check 必填。' },
			worst_feed_interval_us: { type: 'number', description: '**最坏**（最长）喂狗间隔（µs），由最长任务/ISR 决定，判超时上限用。action=check 必填。' },
			best_feed_interval_us: { type: 'number', description: '**最快**（最短）一圈的喂狗间隔（µs）。窗口型看门狗判下限必填——喂得太早是否违规取决于最短间隔，不是最长间隔。' },
			window_lower_us: { type: 'number', description: '窗口型看门狗的最早允许喂狗时间（µs），0 表示无窗口限制。' },
			margin_ratio: { type: 'number', description: '要求的安全余量比例，默认 0.3。' },
			init_time_us: { type: 'number', description: '上电初始化耗时（µs）；给了就检查超时是否够长。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) => {
				if (v.kind === 'solve') {
					const rows =
						v.exact.length > 0
							? v.exact.slice(0, 6).map((x, i) => `  ${i + 1}. prescaler=${x.prescaler} reload=${x.reload} → ${x.timeoutUs.toFixed(1)} µs`)
							: v.near.map((x, i) => `  ${i + 1}. prescaler=${x.prescaler} reload=${x.reload} → ${x.timeoutUs.toFixed(1)} µs（误差 ${x.errorUs.toFixed(2)} µs）`)
					return [
						{
							type: 'text',
							text: renderProtocolReport(
								`看门狗超时求解（目标 ${v.targetTimeoutUs} µs @ ${v.clockHz} Hz）`,
								{ notes: v.notes, warnings: v.exact.length === 0 ? ['无精确解，下面是最接近的组合'] : [], checks: [] },
								['', v.exact.length > 0 ? `精确命中 ${v.exact.length} 组：` : '近似组合：', ...rows],
							),
						},
					]
				}
				if (v.kind === 'timeout') {
					return [{ type: 'text', text: `看门狗超时时间 = ${v.timeoutUs.toFixed(1)} µs` }]
				}
				return [
					{
						type: 'text',
						text: renderProtocolReport('看门狗可行性', v, [
							`  超时 ${v.timeoutUs} µs，最坏喂狗间隔 ${v.worstFeedIntervalUs} µs`,
							`  允许上限（留 ${(100 - (v.upperLimit / v.timeoutUs) * 100).toFixed(0)}% 余量）= ${v.upperLimit.toFixed(1)} µs`,
							`  富余 ${v.slackUs.toFixed(1)} µs`,
						]),
					},
				]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (args.action === 'timeout') {
				return { kind: 'timeout', timeoutUs: timeoutUs({ clockHz: args.clock_hz, prescaler: args.prescaler, reload: args.reload }) }
			}
			if (args.action === 'solve') {
				return {
					kind: 'solve',
					...solveTimeout({
						clockHz: args.clock_hz,
						targetTimeoutUs: args.target_timeout_us,
						prescalerMax: args.prescaler_max,
						reloadMax: args.reload_max,
					}),
				}
			}
			return {
				kind: 'check',
				...analyzeWatchdog({
					timeoutUs: args.timeout_us,
					worstFeedIntervalUs: args.worst_feed_interval_us,
					bestFeedIntervalUs: args.best_feed_interval_us,
					windowLowerUs: args.window_lower_us ?? 0,
					marginRatio: args.margin_ratio ?? 0.3,
					initTimeUs: args.init_time_us,
				}),
			}
		},
		presentCall: (args) => ({ card: 'generic', title: `看门狗 ${args.action}`, kind: 'other', rawInput: args }),
	})
}

/** 定义 `power_tree` 工具。 */
function definePowerTreeTool() {
	return defineTool({
		name: 'power_tree',
		description:
			'电源树功耗与结温。LDO：耗散 =(Vin−Vout)×Iout，效率 = Vout/Vin（**与电流无关**，压差全部变成热）；DCDC：Pin = Pout/η。' +
			'结温 Tj = Ta + Pd × Rθja，允许功耗 =(Tj_max − Ta)/Rθja。逐轨判定并在超限时报警，另给出整树输入/耗散/效率与最热的轨。' +
			'Rθja / Tj_max / η 必须来自器件手册（本工具不内置默认值）。',
		parameters: {
			ambient_c: { type: 'number', description: '环境温度（°C），默认 25。' },
			rails: {
				type: 'array',
				required: true,
				description:
					'各轨：[{ name, type: "ldo"|"dcdc", vinV, voutV, ioutA, efficiency（dcdc 必填）, rthjaCPerW, tjMaxC }]。',
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, v) =>
				[
					{
						type: 'text',
						text: renderProtocolReport(
							`电源树（环境 ${v.ambientC} °C）`,
							v,
							[
								'',
								'各轨：',
								...v.rails.map(
									(r) =>
										`  ${r.name}（${r.type.toUpperCase()}）：${r.vinV} → ${r.voutV} V @ ${r.ioutA} A` +
										`　负载 ${r.pOut.toFixed(4)} W，输入 ${r.pIn.toFixed(4)} W，**耗散 ${r.pDissipated.toFixed(4)} W**，效率 ${(r.efficiency * 100).toFixed(1)}%` +
										`${r.tjC === null ? '' : `，Tj ${r.tjC.toFixed(1)} °C`}`,
								),
								'',
								`合计：输入 ${v.totalPIn.toFixed(4)} W，耗散 ${v.totalPdissipated.toFixed(4)} W，整树效率 ${(v.overallEfficiency * 100).toFixed(1)}%`,
								v.hottestRail ? `最热的轨：${v.hottestRail.name}（${v.hottestRail.tjC.toFixed(1)} °C）` : '（未给热阻，未算结温）',
							],
						),
					},
				],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzePowerTree({ ambientC: args.ambient_c ?? 25, rails: args.rails })
		},
		presentCall: (args) => ({ card: 'generic', title: `电源树 ${args.rails?.length ?? 0} 轨`, kind: 'other', rawInput: args }),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 4：fw_build（多工具链）                                         */
/* ------------------------------------------------------------------ */

/** 多工具链构建工具的渲染函数。 */
function renderBuildResult(r) {
	const lines = []

	if (r.action === 'probe') {
		lines.push('本机构建工具链探测结果：')
		for (const t of r.toolchains) {
			const mark = t.available ? '可用' : '未找到'
			lines.push(`  [${mark}] ${t.label}（${t.id}）`)
			if (t.available) lines.push(`           ${t.exe}`)
			else if (t.hint) lines.push(`           ${t.hint}`)
			lines.push(`           实际构建是否验证过：${t.verified ? '是' : '否'}`)
		}
		lines.push('')
		lines.push('说明：以上只是**可执行文件是否探测到**，属可实测事实；')
		lines.push('     「实际构建」另需真实工程才能验证，探测到不等于构建可用。')
		return lines.join('\n')
	}

	const verdictText = {
		success: '成功（0 错误 0 警告）',
		warnings: '成功但有警告',
		failed: '失败',
		unknown: '不确定 —— 未能从输出判定结果',
	}
	lines.push(`${r.toolchainLabel} 构建${verdictText[r.verdict] ?? r.verdict}：${r.project ?? r.command}`)
	if (r.target) lines.push(`  目标：${r.target}`)
	lines.push(`  耗时 ${(r.durationMs / 1000).toFixed(1)} 秒，退出码 ${r.exitCode === null ? '无' : r.exitCode}`)
	if (r.args) lines.push(`  命令：${r.command} ${r.args.join(' ')}`)
	if (r.summary) lines.push(`  官方结论：${r.summary.errors} Error(s), ${r.summary.warnings} Warning(s)`)

	if (r.errors.length > 0) {
		lines.push('')
		lines.push(`错误（${r.errors.length} 条）：`)
		for (const e of r.errors.slice(0, 20)) lines.push(`  ${e}`)
		if (r.errors.length > 20) lines.push(`  …另有 ${r.errors.length - 20} 条`)
	}
	if (r.warnings.length > 0) {
		lines.push('')
		lines.push(`警告（${r.warnings.length} 条）：`)
		for (const w of r.warnings.slice(0, 10)) lines.push(`  ${w}`)
		if (r.warnings.length > 10) lines.push(`  …另有 ${r.warnings.length - 10} 条`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		for (const n of r.notes) lines.push(`注意：${n}`)
	}
	lines.push('')
	lines.push(
		`后端验证状态：${r.backendVerified ? '已在真实工程验证' : `**未在真实工程验证** —— ${r.backendVerifiedNote}`}`,
	)
	return lines.join('\n')
}

/**
 * 定义 `fw_build` 工具。
 * @param {object} config - 插件配置。
 * @returns {object} 工具定义。
 */
function defineFwBuildTool(config) {
	return defineTool({
		name: 'fw_build',
		timeoutMs: 600_000,
		description:
			'多工具链固件构建。action=probe 探测本机有哪些工具链可用；action=build 执行构建并解析错误与警告。toolchain 可选 keil（UV4.exe）/ platformio（pio run）/ cmake（cmake --build，覆盖面最广）/ make / idf（idf.py）/ iar（IarBuild）/ custom（自定义 argv，不经 shell）。不绑定任何厂商 IDE。',
		parameters: {
			action: {
				type: 'string',
				enum: ['probe', 'build'],
				description: 'probe 只探测工具链可用性；build 执行构建。默认 build。',
			},
			toolchain: {
				type: 'string',
				enum: TOOLCHAIN_IDS,
				description: `构建后端，默认 keil。可选：${TOOLCHAIN_IDS.join(', ')}`,
			},
			project: {
				type: 'string',
				description:
					'工程路径：keil=.uvprojx；platformio=工程目录；cmake=构建目录（含 CMakeCache.txt）；make=Makefile 所在目录；iar=.ewp。',
			},
			target: { type: 'string', description: '目标名：Keil target / make target / cmake --target。' },
			env: { type: 'string', description: 'PlatformIO 的环境名（-e）。' },
			mode: {
				type: 'string',
				enum: ['build', 'rebuild'],
				description: '仅 Keil 使用：build 增量（-b）或 rebuild 全量（-r）。默认 build。',
			},
			timeout_s: { type: 'integer', description: '构建超时秒数，默认 300。超时会强制终止子进程。' },
			uv4_path: { type: 'string', description: '覆盖 Keil UV4.exe 路径。' },
			command: { type: 'string', description: 'custom 后端的可执行文件路径。' },
			args: {
				type: 'array',
				items: { type: 'string' },
				description: 'custom 后端的参数数组（直接传给进程，不经 shell，因此无注入面）。',
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderBuildResult(value) }],
		},
		// 构建会写输出文件、且同一工程不支持并发，因此声明为不可并行。
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			const action = args.action ?? 'build'

			if (action === 'probe') {
				return { action: 'probe', toolchains: probeToolchains(config) }
			}

			if (!args.toolchain) throw new Error(`build 需要 toolchain。可用：${TOOLCHAIN_IDS.join(', ')}`)
			if (args.toolchain !== 'custom' && !args.project) {
				throw new Error(`${BACKENDS[args.toolchain].label} 后端需要 project 路径`)
			}

			const timeoutMs =
				Number.isInteger(args.timeout_s) && args.timeout_s > 0 ? args.timeout_s * 1000 : undefined

			const result = await runBuild(
				{
					toolchain: args.toolchain,
					project: args.project,
					target: args.target,
					env: args.env,
					mode: args.mode,
					command: args.command,
					args: args.args,
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					signal: exec.signal,
				},
				{ ...config, ...(args.uv4_path ? { uv4Path: args.uv4_path } : {}) },
			)
			return { action: 'build', ...result }
		},
		presentCall: (args) => ({
			card: 'terminal',
			title: `${args.action === 'probe' ? '探测工具链' : `构建 ${args.project ?? ''}`}`,
			kind: 'execute',
			rawInput: args.project ?? args.action,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 5：leak_pin（引脚漏电与电平冲突）                               */
/* ------------------------------------------------------------------ */

/** 漏电分析的渲染函数。 */
function renderLeakReport(r) {
	const lines = []
	const sevText = { high: '高', medium: '中', low: '低', none: '无' }
	lines.push(`引脚漏电与电平冲突分析：共 ${r.pinCount} 个引脚，发现 ${r.faultyCount} 个问题（最高严重度：${sevText[r.worstSeverity]}）`)
	if (r.totalEstimatedUa !== null) {
		lines.push(`已估算的漏电合计：约 ${r.totalEstimatedUa} µA`)
	}
	lines.push('')

	for (const p of r.pins) {
		if (!p.hasFault) {
			lines.push(`[无问题] ${p.pin}  （MCU ${p.mcuMode} / 外部 ${p.externalKind}@${p.externalLevel}）`)
			continue
		}
		lines.push(`[${sevText[p.severity]}] ${p.pin}  （MCU ${p.mcuMode}${p.mcu_level ? `@${p.mcu_level}` : ''} / 外部 ${p.externalKind}@${p.externalLevel}）`)
		for (const f of p.findings) {
			lines.push(`  · [${f.kind}] ${f.path}`)
		}
		lines.push(`  通路判定：${p.pathCertainty}`)
		lines.push(
			p.currentUa === null
				? `  电流估算：**未估算** —— ${p.currentBasis}`
				: `  电流估算：${p.currentUa} µA（依据：${p.currentBasis}）`,
		)
		if (p.fixes.length > 0) {
			lines.push('  修法：')
			for (const fx of p.fixes) lines.push(`    - ${fx}`)
		}
		lines.push('')
	}

	if (r.notes.length > 0) {
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `leak_pin` 工具。 */
function defineLeakPinTool() {
	return defineTool({
		name: 'leak_pin',
		description:
			'分析引脚电平冲突与漏电通路，并估算漏电流。专治一类现场极难定位的问题：休眠时某引脚持续吃几十 µA，软件无报错、示波器看不出，只有电流表看得见。最典型的是**MCU 使能内部上拉、而该脚接的通讯器件是 CMOS 推挽输出且此刻输出低** —— 电流从 VDD 经上拉电阻灌进外部低边，持续不断。同时覆盖：下拉对打高电平、推挽对推挽短路、开漏总线上误配下拉、悬空输入贯穿电流、内外上下拉分压。通路由拓扑与电平关系确定，一定给出结论；电流数值需要 vdd 与 pull_ohm（内部上下拉电阻，查数据手册），缺数据时只报通路、不算数字。',
		parameters: {
			pins: {
				type: 'array',
				required: true,
				description: '待分析的引脚列表。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						pin: { type: 'string', description: '引脚名，如 PA0 / P1.2，仅用于展示。' },
						mcu_mode: {
							type: 'string',
							required: true,
							enum: MCU_MODES,
							description: 'MCU 侧模式：input-pullup / input-pulldown / input-floating / output-pushpull / output-opendrain / af-pushpull / af-opendrain / analog / unknown。',
						},
						mcu_level: {
							type: 'string',
							enum: ['high', 'low'],
							description: 'MCU 为推挽输出时的输出电平。',
						},
						external_kind: {
							type: 'string',
							enum: EXTERNAL_KINDS,
							description: '外部器件类型：none / cmos-pushpull / open-drain / open-collector / analog / passive-to-vdd / passive-to-gnd / switch-to-gnd / switch-to-vdd。',
						},
						external_level: {
							type: 'string',
							enum: EXTERNAL_LEVELS,
							description: '外部器件当前状态：high / low / highz / unknown。开漏与开集只有 low 是主动驱动，其余视为高阻。',
						},
						vdd: { type: 'number', description: '供电电压（V），算电流必需。' },
						pull_ohm: { type: 'integer', description: 'MCU 内部上/下拉电阻（Ω）。**必须查数据手册**，不要填猜的值。' },
						external_r_ohm: { type: 'integer', description: '外部无源电阻（Ω）。' },
						series_ohm: { type: 'integer', description: '串在回路里的限流电阻（Ω）。' },
					},
				},
			},
			vdd: { type: 'number', description: '默认供电电压（V），引脚未单独给出时使用。' },
			pull_ohm: { type: 'integer', description: '默认内部上/下拉电阻（Ω），引脚未单独给出时使用。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderLeakReport(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzePins(args.pins ?? [], { vdd: args.vdd, pull_ohm: args.pull_ohm })
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `引脚漏电分析（${(args.pins ?? []).length} 脚）`,
			kind: 'other',
			rawInput: (args.pins ?? []).map((p) => p.pin ?? '?'),
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 6：sched_analyze（调度可行性）                                  */
/* ------------------------------------------------------------------ */

/** 调度分析的渲染函数。 */
function renderSchedReport(r) {
	const lines = []
	const modeText = { 'cooperative-tick': '单定时器节拍分时（前后台 / 时间片轮询）', 'isr-direct': '定时器 + 中断调度（各任务挂各自中断）' }
	const verdictText = { ok: '余量充足', tight: '偏紧', risky: '风险高', overload: '排不下' }
	lines.push(`调度可行性分析（${modeText[r.mode] ?? r.mode}）`)
	if (r.tickUs !== null && r.tickUs !== undefined) lines.push(`  节拍周期：${r.tickUs} µs；分派开销：${r.dispatchOverheadUs} µs/次`)
	lines.push(`  任务数：${r.taskCount}`)
	lines.push(`  CPU 占用率：${r.totalUtilization}（${r.totalUtilizationPercent}%）→ ${verdictText[r.verdict] ?? r.verdict}`)
	lines.push(`  周期单调充分条件界线：${r.rateMonotonicBound}`)
	lines.push('')
	lines.push('任务明细（按优先级从高到低）：')
	for (const t of r.tasks) {
		lines.push(
			`  P${t.priority} ${t.name}：周期 ${t.periodUs}µs，执行 ${t.execUs}µs，截止 ${t.deadlineUs}µs，占用 ${t.utilizationPercent}%，每秒 ${t.dispatchesPerSec} 次`,
		)
	}

	if (r.tickResolvability) {
		lines.push('')
		lines.push('节拍量化（周期能否被节拍整除）：')
		for (const t of r.tickResolvability) {
			const flag = Number.isInteger(t.ticksPerPeriodExact) ? '' : '  ← 不能整除，实际周期被量化'
			lines.push(`  ${t.name}：${t.ticksPerPeriodExact} 拍 → 实际 ${t.actualPeriodUs}µs（偏差 ${t.errorUs}µs / ${t.errorPercent}%）${flag}`)
		}
	}

	if (r.collisions) {
		const c = r.collisions
		lines.push('')
		lines.push(`节拍碰撞扫描（周期 ${c.cycleTicks} 拍 = ${c.cycleUs}µs）：`)
		lines.push(`  最重的一拍：第 ${c.peakTick} 拍需 ${c.peakLoadUs}µs，一拍预算 ${c.peakTickBudgetUs}µs → ${c.peakFitsInTick ? '跑得完' : '**跑不完**'}`)
		lines.push('  各任务最坏等待（同一拍上排在它前面的任务耗时之和）：')
		for (const w of c.worstWaitByTask) {
			lines.push(`    ${w.name}：最坏等待 ${w.worstWaitUs}µs（占其周期 ${w.jitterPercentOfPeriod}%）`)
		}
		const co = c.coincidenceCounts.filter((x) => x.tasksDueTogether > 1)
		if (co.length > 0) {
			lines.push('  同一拍并发的情况：')
			for (const x of co) lines.push(`    ${x.tasksDueTogether} 个任务同时到期：出现 ${x.ticks} 拍`)
		}
	}

	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `sched_analyze` 工具。 */
function defineSchedAnalyzeTool() {
	return defineTool({
		name: 'sched_analyze',
	description:
			'调度可行性分析，用于多定时器分时调度与"定时器+中断"调度的方案设计。输入节拍周期与各任务的周期/最坏执行时间，输出：CPU 加权占用率、每个任务的裕量、周期能否被节拍整除（量化误差）、**节拍碰撞扫描**（最重的一拍能否在一拍内跑完）、以及同一拍上各任务的最坏等待（抖动上界）。设计调度方案前先算一遍，不要写完代码才发现排不下。所有输出是静态计算值，真实抖动需实测。',
		parameters: {
			mode: {
				type: 'string',
				enum: ['cooperative-tick', 'isr-direct'],
				description: 'cooperative-tick=一个定时器打节拍、任务轮流执行（默认）；isr-direct=各任务挂各自的中断里执行。',
			},
			tick_us: { type: 'integer', description: '节拍/中断周期（µs）。cooperative-tick 必填。' },
			tasks: {
				type: 'array',
				required: true,
				description: '任务表。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', description: '任务名。' },
						period_us: { type: 'integer', required: true, description: '周期（µs）。' },
						exec_us: { type: 'number', required: true, description: '单次执行时间（µs），取最坏值。' },
						deadline_us: { type: 'integer', description: '截止时间（µs），缺省等于周期。' },
						priority: { type: 'integer', description: '优先级，数值越小越优先，缺省按数组顺序。' },
					},
				},
			},
			dispatch_overhead_us: { type: 'number', description: '每次调度切换的额外开销（µs），默认 0。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderSchedReport(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeSchedule({
				mode: args.mode,
				tick_us: args.tick_us,
				tasks: args.tasks ?? [],
				dispatch_overhead_us: args.dispatch_overhead_us,
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `调度分析（${(args.tasks ?? []).length} 任务）`,
			kind: 'other',
			rawInput: (args.tasks ?? []).map((t) => t.name ?? '?'),
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 7：power_budget（功耗预算）                                     */
/* ------------------------------------------------------------------ */

/** 功耗预算的渲染函数。 */
function renderPowerReport(r) {
	const lines = []
	const methodText = { 'duty-percent': '按占空比加权', 'absolute-duration': '按绝对时长加权' }
	lines.push(`功耗预算（${methodText[r.method] ?? r.method}）`)
	if (r.totalDurationUs !== null) lines.push(`  一轮循环总时长：${r.totalDurationUs} µs`)
	lines.push('')
	lines.push('各模式：')
	for (const m of r.modes) {
		const dur = m.durationUs === null ? '' : `，时长 ${m.durationUs}µs`
		lines.push(
			`  ${m.name}：${m.currentUa} µA × ${m.dutyPercent}%${dur} → 贡献 ${m.contributionUa} µA（占 ${m.contributionPercent}%）`,
		)
	}
	lines.push('')
	lines.push(`  运行部分平均：${r.nominalAverageUa} µA`)
	if (r.baseCurrentUa > 0) {
		lines.push(`  常驻部分（漏电 ${r.sleepLeakUa} µA + 自放电 ${r.batterySelfDischargeUa} µA）：${r.baseCurrentUa} µA`)
	}
	lines.push(`  **平均电流合计：${r.averageUa} µA（${r.averageMa} mA）**`)

	if (r.batteryLife) {
		const b = r.batteryLife
		lines.push('')
		lines.push(`电池寿命估算（${b.batteryMah} mAh × 可用系数 ${b.derating} = ${b.usableMah} mAh）：`)
		lines.push(`  ${b.hours} 小时 = ${b.days} 天 = ${b.years} 年`)
	} else {
		lines.push('')
		lines.push('未提供 battery_mah，未折算电池寿命。')
	}

	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `power_budget` 工具。 */
function definePowerBudgetTool() {
	return defineTool({
		name: 'power_budget',
	description:
			'功耗预算与电池寿命估算：把各工作模式（运行/空闲/睡眠/停机/待机）的电流按占空比或绝对时长加权成平均电流，可选折算电池寿命，并指出哪个模式对平均电流贡献最大（优化从那里下手）。可叠加常驻漏电（引脚漏电、稳压器静态电流）与电池自放电 —— 这部分不随占空比下降，是电池寿命的硬地板。所有电流值应来自数据手册典型值或实测，本工具只做加权计算、不做推测。',
		parameters: {
			modes: {
				type: 'array',
				required: true,
				description: '工作模式表。每个模式必须一致地给 duty_percent 或 duration_us/duration_ms 之一。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', description: '模式名，如 Run / Sleep / Stop / Standby。' },
						current_ua: { type: 'number', required: true, description: '该模式电流（µA），取数据手册典型值或实测值。' },
						duty_percent: { type: 'number', description: '时间占比（%）。' },
						duration_us: { type: 'number', description: '一轮循环内的绝对时长（µs）。' },
						duration_ms: { type: 'number', description: '一轮循环内的绝对时长（ms）。' },
					},
				},
			},
			sleep_leak_ua: { type: 'number', description: '常驻漏电（µA），如引脚漏电 + 稳压器静态电流。可用 leak_pin 估算引脚部分。' },
			battery_mah: { type: 'number', description: '电池容量（mAh）。给了才折算寿命。' },
			battery_derating: { type: 'number', description: '电池可用系数 0-1，默认 0.8（温度/老化/截止电压折损）。' },
			battery_self_discharge_ua: { type: 'number', description: '电池自放电（µA）。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderPowerReport(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return computePowerBudget({
				modes: args.modes ?? [],
				sleep_leak_ua: args.sleep_leak_ua,
				battery_mah: args.battery_mah,
				battery_derating: args.battery_derating,
				battery_self_discharge_ua: args.battery_self_discharge_ua,
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `功耗预算（${(args.modes ?? []).length} 模式）`,
			kind: 'other',
			rawInput: (args.modes ?? []).map((m) => m.name ?? '?'),
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 8：adc_load（ADC 输入负载与采样功耗）                            */
/* ------------------------------------------------------------------ */

/** ADC 负载分析的渲染函数。 */
function renderAdcReport(r) {
	const lines = []
	lines.push(`ADC 输入负载与采样功耗分析（Vref ${r.vRef} V，${r.resolutionBits} 位，${r.sampleRateHz} Hz，${r.channels} 通道）`)
	lines.push('')

	if (r.chargeCurrentUa !== null) {
		lines.push(`采样电荷转移电流（动态，随采样率线性增长）：${r.chargeCurrentUa} µA`)
		lines.push('  该电流只在实际采样期间产生 —— 计入**正在采样的模式**的电流，而不是休眠电流。')
	} else {
		lines.push('采样电荷转移电流：未计算（缺 c_sample_pf）')
	}

	if (r.settling) {
		const s = r.settling
		lines.push('')
		lines.push('采样建立分析：')
		if (s.maxSourceROhm !== undefined) {
			lines.push(`  源阻抗上限：${s.maxSourceROhm} Ω（已扣掉内部 R_ADC ${s.internalROhm} Ω）；采样窗口 ${s.sampleTimeNs} ns`)
		}
		if (s.sourceROhm !== undefined) {
			lines.push(`  实际源阻抗 ${s.sourceROhm} Ω，回路总阻 ${s.totalROhm} Ω，τ = ${s.tauNs} ns`)
			lines.push(`  所需建立时间 ${s.requiredSettleNs} ns，余量 ${s.marginNs} ns`)
			lines.push(`  最坏误差约 ${s.worstCaseErrorLsb} LSB`)
			lines.push(`  判定：${s.sourceWithinLimit ? '通过 —— 采样窗口内能建立到 ½ LSB 以内' : '**不通过 —— 读数会偏低且非线性**'}`)
		}
	}

	if (r.staticLoads.length > 0) {
		lines.push('')
		lines.push(`常态静态负载（休眠时也一直在）：合计 ${r.staticLoadUa} µA`)
		for (const s of r.staticLoads) {
			lines.push(`  ${s.name}：${s.description} → ${s.currentUa} µA`)
		}
	}

	if (r.totalAdcRelatedUa !== null) {
		lines.push('')
		lines.push(`ADC 相关合计：${r.totalAdcRelatedUa} µA（采样动态 + 常态静态）`)
	}

	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `adc_load` 工具。 */
function defineAdcLoadTool() {
	return defineTool({
		name: 'adc_load',
	description:
			'ADC 输入负载与采样功耗分析。算两块常被漏掉的开销：① **采样电荷转移电流** = 采样率 × 采样保持电容 × Vref × 通道数（随采样率线性增长，不在引脚漏电里、也不在运行电流里，不显式加上就低估电池消耗）；② **常态静态负载**（分压网络 V/(Rtop+Rbottom)、到地电阻、每通道输入漏电流 I_LK）。同时算**源阻抗上限**并判断采样窗口内能否建立到 ½ LSB —— 建立不足会让读数偏低且非线性，比功耗问题更致命。所需参数（C_sample / R_ADC / I_LK / 采样窗口）必须从数据手册取，本工具不做任何默认推测。',
		parameters: {
			v_ref: { type: 'number', required: true, description: '参考电压（V）。' },
			resolution_bits: { type: 'integer', required: true, description: 'ADC 分辨率（位），如 12 / 16。' },
			sample_rate_hz: { type: 'number', required: true, description: '该输入的采样率（Hz）。' },
			c_sample_pf: { type: 'number', description: '采样保持电容 C_ADC（pF），**查数据手册**。' },
			r_adc_ohm: { type: 'integer', description: '内部采样开关电阻 R_ADC（Ω），**查数据手册**。' },
			source_r_ohm: { type: 'integer', description: '外部信号源阻抗（Ω），含分压电阻并联值。' },
			sample_time_ns: { type: 'number', description: '采样窗口时长（ns），数据手册或配置值。' },
			channels: { type: 'integer', description: '参与采样的通道数，默认 1。' },
			input_leakage_ua: { type: 'number', description: '每通道输入漏电流 I_LK（µA），**查数据手册**；未使用通道也会有。' },
			dividers: {
				type: 'array',
				description: '常接在电源上的分压网络（如电池电压检测）。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', description: '名称。' },
						r_top_ohm: { type: 'integer', required: true, description: '上臂电阻（Ω）。' },
						r_bottom_ohm: { type: 'integer', required: true, description: '下臂电阻（Ω）。' },
					},
				},
			},
			grounded_loads: {
				type: 'array',
				description: '常接到地的电阻性负载（如 LED 限流、偏置电阻）。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', description: '名称。' },
						r_ohm: { type: 'integer', required: true, description: '电阻（Ω）。' },
					},
				},
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderAdcReport(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return analyzeAdcLoad({
				v_ref: args.v_ref,
				resolution_bits: args.resolution_bits,
				sample_rate_hz: args.sample_rate_hz,
				c_sample_pf: args.c_sample_pf,
				r_adc_ohm: args.r_adc_ohm,
				source_r_ohm: args.source_r_ohm,
				sample_time_ns: args.sample_time_ns,
				channels: args.channels,
				input_leakage_ua: args.input_leakage_ua,
				dividers: args.dividers ?? [],
				grounded_loads: args.grounded_loads ?? [],
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `ADC 负载 ${args.sample_rate_hz} Hz`,
			kind: 'other',
			rawInput: args.v_ref,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 9：fault_decode（Cortex-M 异常分诊）                            */
/* ------------------------------------------------------------------ */

/** 异常分诊的渲染函数。 */
function renderFault(r) {
	const lines = []
	lines.push('Cortex-M 异常分诊')
	lines.push(
		`  栈：${r.stack ?? '未知'}   返回模式：${r.mode ?? '未知'}   EXC_RETURN：${r.excReturn ?? '未提供／非法'}${r.fpuFrame ? '（含浮点扩展帧，多 104 字节）' : ''}`,
	)
	lines.push(`  PC：${r.pc ? r.pc.rendered : '未提供'}`)
	if (r.lr) lines.push(`  LR：${r.lr.rendered}`)
	if (r.mmfar) lines.push(`  MMFAR：0x${r.mmfar.value.toString(16).toUpperCase()}${r.mmfar.region ? `（${r.mmfar.region}）` : ''}`)
	if (r.bfar) lines.push(`  BFAR：0x${r.bfar.value.toString(16).toUpperCase()}${r.bfar.region ? `（${r.bfar.region}）` : ''}`)

	if (r.cfsr.bits.length > 0 || r.hfsr.bits.length > 0) {
		lines.push('')
		lines.push('置位的状态位：')
		for (const b of r.cfsr.bits) lines.push(`  CFSR.${b.kind ?? ''}.${b.name} —— ${b.desc}`)
		for (const b of r.hfsr.bits) lines.push(`  HFSR.${b.name} —— ${b.desc}`)
	}

	if (r.hypotheses.length > 0) {
		lines.push('')
		lines.push(`根因推断（最高置信度：${r.bestConfidence ?? '无'}）：`)
		for (const [i, h] of r.hypotheses.entries()) {
			lines.push(`  ${i + 1}. [${h.confidence}] ${h.cause}`)
			lines.push(`     依据：${h.evidence}`)
		}
	} else {
		lines.push('')
		lines.push('根因推断：无 —— 给出的信息不足以归因（见下方警告）。')
	}

	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `fault_decode` 工具。 */
function defineFaultDecodeTool() {
	return defineTool({
		name: 'fault_decode',
	description:
			'Cortex-M 异常（HardFault / MemManage / BusFault / UsageFault）分诊。输入故障栈帧（PC/LR/xPSR/r0-r3/r12）、EXC_RETURN、以及 CFSR/HFSR/MMFAR/BFAR，可选传 ELF 文件；输出：用的哪个栈（MSP/PSP）、是否浮点扩展帧、**PC/LR 翻译成"哪个函数 + 偏移"**（靠 ELF 符号表）、置位的故障位含义、以及按置信度排序的根因推断（除零/非对齐/INVSTATE/栈溢出/非法 PC/精确或非精确总线错误等）。单看 PC=0x08001a3c 毫无意义，翻译成 Reset_Handler + 0x2c 才能定位。',
		parameters: {
			frame: {
				type: 'object',
				additionalProperties: false,
				description: '故障栈帧（进入异常时硬件自动压栈的那 8 个值）。',
				properties: {
					r0: { type: 'integer', description: 'R0。' },
					r1: { type: 'integer', description: 'R1。' },
					r2: { type: 'integer', description: 'R2。' },
					r3: { type: 'integer', description: 'R3。' },
					r12: { type: 'integer', description: 'R12。' },
					lr: { type: 'integer', description: 'LR（返回地址）。' },
					pc: { type: 'integer', required: true, description: 'PC —— 出错时正在执行的指令地址。' },
					xpsr: { type: 'integer', description: 'xPSR（其 bit24 是 Thumb 位 T）。' },
				},
			},
			exc_return: { type: 'integer', description: 'EXC_RETURN（故障时的 LR）：0xFFFFFFF1=Handler/MSP、0xFFFFFFF9=Thread/MSP、0xFFFFFFFD=Thread/PSP；bit4=1 表示含浮点扩展帧。' },
			cfsr: { type: 'integer', description: 'CFSR（0xE000ED28）—— 分诊最关键的一个寄存器。' },
			hfsr: { type: 'integer', description: 'HFSR（0xE000ED2C）。bit30=FORCED 表示这是被升级的故障。' },
			mmfar: { type: 'integer', description: 'MMFAR（0xE000ED34），存储管理故障地址。' },
			bfar: { type: 'integer', description: 'BFAR（0xE000ED38），总线故障地址。' },
			elf_path: { type: 'string', description: 'ELF 文件路径（提供后 PC/LR 可翻译成函数名 + 偏移）。强烈建议提供。' },
			memory_regions: {
				type: 'array',
				description: '存储区域，用于判断 PC/BFAR 是否落在合法范围。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', required: true, description: '区域名，如 FLASH / RAM。' },
						start: { type: 'integer', required: true, description: '起始地址。' },
						end: { type: 'integer', required: true, description: '结束地址（不含）。' },
						kind: { type: 'string', description: 'flash / ram / peripheral。' },
					},
				},
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderFault(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (!Number.isInteger(args.frame?.pc)) throw new Error('必须提供 frame.pc（出错时的 PC）')

			// 有 ELF 就取符号表 —— 这是把裸地址变成函数名的唯一途径。
			let symbols = []
			if (typeof args.elf_path === 'string' && args.elf_path.length > 0) {
				try {
					const buffer = await readFile(args.elf_path)
					symbols = parseElf(buffer).symbols ?? []
				} catch (error) {
					// 符号表拿不到不影响分诊主体，降级为只给原始地址。
					symbols = []
				}
			}

			return decodeFault({
				frame: args.frame,
				exc_return: args.exc_return,
				cfsr: args.cfsr ?? null,
				hfsr: args.hfsr ?? null,
				mmfar: args.mmfar ?? null,
				bfar: args.bfar ?? null,
				symbols,
				memoryRegions: args.memory_regions ?? [],
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: '异常分诊',
			kind: 'other',
			rawInput: args.frame?.pc,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 10：nvm_layout（NVM 分区与磨损）                                */
/* ------------------------------------------------------------------ */

/** NVM 布局的渲染函数。 */
function renderNvm(r) {
	const lines = []
	lines.push(`NVM 分区与磨损分析（Flash 0x${r.flash.base.toString(16).toUpperCase()} + ${r.flash.size} 字节，擦除页 ${r.flash.page_size} 字节，写粒度 ${r.flash.writeGranule} 字节）`)
	lines.push(
		`  已用 ${r.usedBytes} 字节（${r.usagePercent}%），剩余 ${r.freeBytes} 字节`,
	)
	lines.push('')
	lines.push('分区：')
	for (const g of r.regions) {
		lines.push(`  ${g.name}${g.kind ? ` [${g.kind}]` : ''}：0x${g.start.toString(16).toUpperCase()} – 0x${g.end.toString(16).toUpperCase()}，${g.size} 字节 = ${g.pages} 页`)
		for (const iss of g.issues) lines.push(`      ⚠ ${iss}`)
	}
	if (r.wear.length > 0) {
		lines.push('')
		lines.push('磨损寿命：')
		for (const w of r.wear) {
			lines.push(`  ${w.region}（${w.model}）`)
			lines.push(`      每天 ${w.bytesPerDay} 字节 / ${w.pagesPerDay} 页；每页每天擦 ${w.erasesPerPagePerDay} 次`)
			lines.push(`      估算寿命：${w.years === null ? '未算（缺 erase_cycles_max）' : `${w.years} 年`}`)
		}
	}
	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `nvm_layout` 工具。 */
function defineNvmLayoutTool() {
	return defineTool({
		name: 'nvm_layout',
	description:
			'NVM（片内 Flash / 模拟 EEPROM）分区规划与擦除寿命估算。输入 Flash 起址/大小/擦除页大小与分区表，输出：各分区的地址范围与页数、**重叠检测**、擦除页与写粒度**对齐检查**、剩余空间，以及按写入频率估算的**擦除寿命（年）**。磨损模型分两种且差异可达几个数量级：page-rewrite（整页重写，每次都擦同一页）与 circular-log（环形日志，擦除均摊到所有页）—— 必须按你的实际写法定，选错会把寿命算错几千倍。',
		parameters: {
			flash: {
				type: 'object',
				additionalProperties: false,
				description: 'Flash 区域参数。',
				properties: {
					base: { type: 'integer', required: true, description: '起始地址。' },
					size: { type: 'integer', required: true, description: '总大小（字节）。' },
					page_size: { type: 'integer', required: true, description: '**擦除页大小**（字节），查数据手册 —— 擦除单位与写入单位不同。' },
					write_granule_bytes: { type: 'integer', description: '最小写入粒度（字节），有些器件只能按 4/8 字节写。' },
				},
			},
			regions: {
				type: 'array',
				description: '分区表；不写 offset 则依次紧排。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						name: { type: 'string', description: '分区名，如 boot / app / config / ota / log。' },
						offset: { type: 'integer', description: '相对 flash.base 的偏移（字节）。' },
						size: { type: 'integer', required: true, description: '大小（字节）。' },
						kind: { type: 'string', description: 'bootloader / app / config / nvm / ota / log。' },
					},
				},
			},
			erase_cycles_max: { type: 'integer', description: '擦除次数上限，**查数据手册**（常见 1 万~10 万次）。不给则不算寿命。' },
			wear: {
				type: 'array',
				description: '各分区的写入负载。',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						region: { type: 'string', description: '对应分区名。' },
						writes_per_day: { type: 'number', required: true, description: '每天写入次数。' },
						bytes_per_write: { type: 'number', required: true, description: '每次写入字节数。' },
						mode: { type: 'string', enum: ['page-rewrite', 'circular-log'], description: '写入模型，默认 page-rewrite。' },
					},
				},
			},
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderNvm(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return planNvmLayout({
				flash: args.flash,
				regions: args.regions ?? [],
				erase_cycles_max: args.erase_cycles_max ?? null,
				wear: args.wear ?? [],
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: 'NVM 分区与磨损',
			kind: 'other',
			rawInput: `${(args.regions ?? []).length} 个分区`,
		}),
	})
}

/* ------------------------------------------------------------------ */
/* 工具 11：lvgl_mem（LVGL 缓冲与带宽）                                 */
/* ------------------------------------------------------------------ */

/** LVGL 缓冲计算的渲染函数。 */
function renderLvgl(r) {
	const lines = []
	lines.push(`LVGL 显示缓冲计算（${r.hres}×${r.vres}，${r.colorDepthBits} bpp，${r.bufferMode === 'full' ? '全屏缓冲' : '局部缓冲'} × ${r.bufferCount}）`)
	lines.push(`  每像素 ${r.bytesPerPixel} 字节；整帧 ${r.fullFrameBytes} 字节（${(r.fullFrameBytes / 1024).toFixed(2)} KiB）`)
	if (r.bufferMode === 'partial') {
		lines.push(`  每块缓冲 ${r.linesPerBuffer} 行 = ${r.bufferBytes} 字节`)
	}
	lines.push(`  **绘制缓冲合计：${r.totalDrawBufferBytes} 字节（${r.totalDrawBufferKiB} KiB）**`)
	if (r.ramUsage) lines.push(`  占可用 RAM ${r.ramUsage.ramTotalBytes} 字节的 ${r.ramUsage.percentOfRam}%`)
	if (r.bandwidth) {
		lines.push('')
		lines.push(`带宽（按满屏每帧都变的上界）：${r.bandwidth.kibPerSecond} KiB/s，等效需要 SPI ${r.bandwidth.requiredSpiHz} bit/s`)
		if (r.bandwidth.utilizationPercent !== undefined) {
			lines.push(`  总线占用 ${r.bandwidth.utilizationPercent}% → ${r.bandwidth.fits ? '够用' : '**不够**'}`)
		}
	}
	if (r.warnings.length > 0) {
		lines.push('')
		lines.push('警告：')
		for (const w of r.warnings) lines.push(`  - ${w}`)
	}
	if (r.notes.length > 0) {
		lines.push('')
		lines.push('说明：')
		for (const n of r.notes) lines.push(`  - ${n}`)
	}
	return lines.join('\n')
}

/** 定义 `lvgl_mem` 工具。 */
function defineLvglMemTool() {
	return defineTool({
		name: 'lvgl_mem',
	description:
			'LVGL 显示缓冲与带宽计算：按分辨率/位深/缓冲模式（全屏或局部）与缓冲数量算出绘制缓冲占用，并算满屏刷新所需的带宽与总线占用率。同时检查几个高频配置错误：局部缓冲行数过小（会把一次重绘拆成很多次 flush 导致变慢）、全屏缓冲吃掉过半 RAM、双缓冲但驱动不支持流水。注意：LV_MEM_SIZE **无法静态计算**，必须用 lv_mem_monitor() 实测，本工具只给明确标注的经验起点。',
		parameters: {
			hres: { type: 'integer', required: true, description: '水平分辨率（像素）。' },
			vres: { type: 'integer', required: true, description: '垂直分辨率（像素）。' },
			color_depth_bits: { type: 'integer', required: true, enum: [1, 8, 16, 24, 32], description: 'LV_COLOR_DEPTH。' },
			buffer_mode: { type: 'string', enum: ['full', 'partial'], description: 'full 全屏缓冲；partial 局部缓冲（默认，资源受限 MCU 常用）。' },
			buffer_count: { type: 'integer', enum: [1, 2], description: '缓冲数量，默认 1。双缓冲需驱动支持。' },
			partial_lines: { type: 'integer', description: 'partial 模式每块缓冲的行数，默认屏高的 1/10。' },
			refresh_rate_hz: { type: 'number', description: '期望刷新率（Hz），给了才算带宽。' },
			bus_bytes_per_second: { type: 'number', description: '显示总线理论带宽（字节/秒），给了才算占用率。' },
			ram_total_bytes: { type: 'integer', description: '可用 RAM 总量（字节），给了才算占用比例。' },
		},
		output: {
			schema: { type: 'json' },
			render: (_args, value) => [{ type: 'text', text: renderLvgl(value) }],
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			return sizeLvglBuffers({
				hres: args.hres,
				vres: args.vres,
				color_depth_bits: args.color_depth_bits,
				buffer_mode: args.buffer_mode,
				buffer_count: args.buffer_count,
				partial_lines: args.partial_lines,
				refresh_rate_hz: args.refresh_rate_hz,
				bus_bytes_per_second: args.bus_bytes_per_second,
				ram_total_bytes: args.ram_total_bytes,
			})
		},
		presentCall: (args) => ({
			card: 'generic',
			title: `LVGL 缓冲 ${args.hres}×${args.vres}`,
			kind: 'other',
			rawInput: args.color_depth_bits,
		}),
	})
}
