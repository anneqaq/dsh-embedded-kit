/**
 * 会话启动门禁（pre-step gate）。
 *
 * 设计意图：
 * 与其等模型自己想起来用工具，不如在**每个会话的第一步**注入一段门禁文本，
 * 把"什么样的数字必须用工具算"和"缺数据不许编"直接写进上下文。
 *
 * 为什么挂在 `agent/pre-step` 而不是 session-start：后者的注入落在 agent 的 inbox 里，
 * 而 inbox 可能被"空白会话切 preset（agentPreset.select → recompose）"清掉；pre-step
 * 的决定是**持久路径**，门禁随第一步的决定写入会话历史，之后每一步与 resume 都会跳过它。
 *
 * 两处刻意的设计取舍：
 *   1. 去重不用扫会话历史事件，改用按会话对象索引的 `WeakSet` —— 少依赖一个未公开的
 *      会话事件 schema，行为更可预测。代价：同一会话在新进程里 resume 会再注入一次（无害）。
 *   2. `createUserMessage` 走**动态导入 + 失败降级**：拿不到就不注入门禁、只记一条日志，
 *      **绝不因为一个可选依赖缺失而让整个插件挂载失败**（本包的既有原则）。
 *
 * @module dsh-embedded-kit/gate
 */

/** 门禁消息里标记来源用的插件 id（与 Cordis 插件名一致）。 */
export const GATE_PLUGIN_ID = 'dsh-embedded-kit'

/**
 * 默认门禁文本。可通过配置 `gateContent` 覆盖。
 *
 * 这段文本的定位是**整个工具包的使用说明**：让模型在会话开头就知道这套工具覆盖什么、
 * 每个工具要什么输入、给什么输出、以及各自的硬约束（哪里必须查手册、哪里必须实测）。
 *
 * 写作要求（前几版都栽在这里）：
 *   1. **讲工具，不讲道理。** 这里不是放"嵌入式通用原则"的地方——那些该在技能里。
 *      每写一行都问：这行是不是在描述某个工具的能力/输入/输出/限制？
 *   2. **每条都必须可核。** 输入字段名、输出项、限制，全部对齐 lib/index.js 里的
 *      `defineTool` 定义，不凭印象写。
 *   3. **硬约束要单独点出来。** 比如 rs485_timing 的收发器参数必须来自数据手册、
 *      lvgl_mem 的 LV_MEM_SIZE 无法静态计算——这些是模型最容易自作主张的地方。
 */
export const DEFAULT_GATE_CONTENT = `<EMBEDDED_KIT_GATE>
本会话带一套嵌入式固件工具包（**只出设计值，不含任何实测能力**）。

**本会话注册的 8 个工具**
- fw_size：体积分析。传 ELF / GNU ld .map / Keil .map 任一，格式自动识别；给预算才算占用率。
- fw_build：probe 探测本机工具链，build 执行构建并解析错误与警告。七个后端。
- fw_image：Intel HEX 校验和/重叠/空洞/缺 EOF + 向量表校验（SP 对齐、Thumb 位、VTOR）+ 整镜像 CRC。
- fault_decode：故障栈帧 + CFSR/HFSR/MMFAR/BFAR 分诊。**有 ELF 才能把 PC/LR 译成函数 + 偏移**。
- proto_frame：Modbus RTU 帧 build / verify + 参数化 CRC（12 预设 + 自定义参数）。
- can_timing：CAN 位时序反算（BRP/TSEG/SJW + 采样点 + 振荡器容差），采样点优先贴近 87.5%。
- canfd_timing：CAN FD 两段速率**分开**反算；**DLC 9~15 是非线性映射**，只有 16 种合法载荷长度。
- clock_tree：PLL 精确命中求解 / 分频链逐节点校验 / 串口容错余量；命中不了如实报误差百分数。

**其余嵌入式能力已改为按需加载的技能**（不占常驻上下文）：总线时序（I²C/SPI/I²S/RS-485/RS-232/LIN/1-Wire/QSPI）、
功耗与电源树、引脚漏电、ADC 采样负载、NVM 寿命、LVGL 缓冲、栈深度、调度可行性、
BLE/LoRa/USB/SD/PMBus、链路预算等。需要时加载对应技能正文 —— 正文里带**可执行脚本**的用法：
\`node <插件根>/skills/_shared/run-tool.mjs <工具名> key=value …\`

**三条硬约束**
1. **缺数据不许编**：数据手册里的参数、器件系数、实测值拿不到就标 pending，不要填一个"看起来合理"的数。
2. **区分设计值与实测值**：工具算出来的是设计值；抖动、漏电、整机功耗、栈峰值只能由仪器给出。
3. **引用手册章节号前先确认它存在。**
</EMBEDDED_KIT_GATE>`

/**
 * 造一个门禁消息。
 * @param {(spec: object) => object} createUserMessage - `@deepseek-ai/dsh-session` 的导出。
 * @param {string} text - 门禁文本。
 * @returns {object} 会话消息。
 */
export function buildGateMessage(createUserMessage, text) {
	return createUserMessage({
		content: [{ type: 'text', text }],
		// 会话格式 v4 要求 `source.kind` 是 producer 自己的标识，并**明令禁止**通配的
		// `plugin`（`dsh-session-format-v3-to-v4` 收到它即抛 SessionFormatError）。
		// 外部插件的 producer kind 形式为 `plugin:<包名>`，故直接用该形式；
		// v4 形状里没有独立的 `plugin` 字段，也不再另置。
		source: { kind: `plugin:${GATE_PLUGIN_ID}` },
	})
}

/**
 * 造 pre-step 处理函数。
 *
 * 单独抽出来是为了**可以脱离 dsh 运行时做自测** —— 用假的 `next()` 与假的 agent
 * 就能验证契约（返回形状、去重、reject 透传）。
 *
 * @param {object} deps - 依赖。
 * @param {() => object} deps.makeMessage - 造门禁消息的函数。
 * @returns {(ctx: {agent?: object}, next: () => Promise<object>) => Promise<object>} 处理函数。
 */
export function createGateHandler({ makeMessage }) {
	/** 按会话对象索引，保证一个会话只注入一次。 */
	const gatedSessions = new WeakSet()

	return async function gateHandler(context, next) {
		const decision = await next()
		// 被拒绝的步骤原样透传，不要往里面塞东西。
		if (decision === null || typeof decision !== 'object' || decision.kind === 'reject') return decision

		const session = context?.agent?.session
		if (session !== undefined && session !== null) {
			if (gatedSessions.has(session)) return decision
			gatedSessions.add(session)
		}

		const existing = Array.isArray(decision.messages) ? decision.messages : []
		return { kind: decision.kind ?? 'enter', messages: [...existing, makeMessage()] }
	}
}

/**
 * 注册门禁。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [config] - 插件配置。
 * @param {boolean} [config.gateEnabled] - 是否启用门禁，默认 true。
 * @param {string} [config.gateContent] - 覆盖默认门禁文本。
 * @returns {Promise<{registered: boolean, reason: string|null, contentLength: number|null}>} 注册结果。
 */
export async function registerGate(ctx, config = {}) {
	if (config.gateEnabled === false) return { registered: false, reason: '配置里关闭了门禁', contentLength: null }

	let createUserMessage
	try {
		// `createUserMessage` 由 `@deepseek-ai/dsh-llm` 导出（**不是** `dsh-session`）——
		// 动态导入 + 降级：门禁是增强项，缺了它工具照常可用。
		;({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
	} catch (error) {
		return {
			registered: false,
			reason: `无法导入 @deepseek-ai/dsh-llm（${error instanceof Error ? error.message : String(error)}）`,
			contentLength: null,
		}
	}
	if (typeof createUserMessage !== 'function') {
		return { registered: false, reason: '@deepseek-ai/dsh-llm 未导出 createUserMessage', contentLength: null }
	}

	const content =
		typeof config.gateContent === 'string' && config.gateContent.trim().length > 0
			? config.gateContent
			: DEFAULT_GATE_CONTENT
	const makeMessage = () => buildGateMessage(createUserMessage, content)

	ctx.on('agent/pre-step', createGateHandler({ makeMessage }))
	return { registered: true, reason: null, contentLength: content.length }
}
