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
本会话带一套嵌入式固件工具包（设计值计算 + 静态分析；不含任何实测能力）。

**体积与构建**
- fw_size：传 ELF / GNU ld .map / Keil .map 任一文件路径即可，格式自动识别。得 ROM(Flash 镜像) 与 RAM 占用、Code/RO/RW/ZI 明细、体积大户排序（**符号级**，不是段名）。要占用率就同时给 rom_budget / ram_budget，不给只报绝对量。做体积优化前先用它量化定位。
- fw_build：probe 只探测本机可用工具链，build 执行构建并解析错误与警告。七个后端：keil / platformio / cmake / make / idf / iar / custom。

**总线与协议**
- rs485_timing：位时间/字符时间、Modbus t1.5 与 t3.5、DE/RE 方向切换窗口。**收发器的 tPZH/tPZL/tPHZ/tPLZ 必须查数据手册填入**——不给该参数会列为 pending，不会替你猜一个值。
- proto_frame：build 造 Modbus RTU 帧、verify 审查帧（翻译功能码与异常码）、crc 算任意参数化 CRC（width/poly/init/refin/refout/xorout，12 种预设 + 自定义参数，不限于 Modbus）。数据域传十六进制串。
- i2c_bus：给总线总电容与模式（100k/400k/1M/HS），得上拉区间 Rp(min)（灌电流）与 Rp(max)（上升时间，可叠加漏电流约束），并判定电容是否超规范上限；给了实际上拉值就反算上升时间。公式出自 NXP UM10204。
- spi_bus：① 把 CPOL/CPHA 四模式翻成"哪个边沿采样、哪个边沿移出"；② 一阶模型估最高 SCK（主控 tV + 从器件 tSU + 走线偏斜）；③ 按 SCK 与每帧位数算吞吐。
- i2s_clk：由采样率、槽位数、槽数得 LRCK 与 BCLK，列出常见 MCLK 比率，并检查 MCLK 是否为 fs 整数倍、主时钟能否整数分频出 BCLK。
- can_timing：由控制器时钟与目标波特率反算 BRP/TSEG1/TSEG2/SJW（含可直接写寄存器的编程值），给采样点、振荡器容差 df、传播段可覆盖的最大单向延迟。排序以采样点接近 87.5% 优先。公式出自 Bosch/CiA。
- lin_sched：按 8N1 与固定 34 位帧头算 LIN 每帧时间与规范最小槽位（1.4 倍裕量），检查调度表槽位合计是否装得进周期。
- onewire_timing：1-Wire **标准速率**的时隙/写 1/写 0/读时隙/恢复时间窗口逐项校验。Overdrive 速率的窗口各器件不同，本工具不给那组数。
- rs232_link：V.28 侧查输出幅度、接收门限、摆率与数据率上限，并按线缆电容上限折算最长线长（**长度限制来自电容，不是固定米数**）；V.11 侧查差分幅度与终端匹配。

**功耗与模拟**
- power_budget：按模式表给 duty_percent 或 duration，得平均电流与电池寿命。待机漏电单列为"硬地板"——它不随占空比下降。
- adc_load：算 ADC 采样电荷转移电流、源阻抗上限、分压与漏电的常态负载。源阻抗超限会让读数偏低且非线性，不是标定问题。
- leak_pin：给引脚模式与外部器件类型/状态，判定漏电通路与电平冲突。电流需要 vdd 与上拉阻值；最坏情况取手册的 min 电阻。

**调度**
- sched_analyze：给模式（cooperative-tick 单定时器打节拍 / isr-direct 各任务各挂中断）与任务表，得 CPU 占用率、节拍量化误差、节拍碰撞扫描、同拍最坏等待（抖动上界）。加功能前先算，别等跑不动再回头。

**调试**
- fault_decode：给故障栈帧与存储区域，把 PC/LR 译成「函数 + 偏移」，解读 CFSR/HFSR/MMFAR/BFAR，按置信度给根因。**需要有 ELF 才能翻译符号**；没有 ELF 只能给裸地址。

**存储与显示**
- nvm_layout：给 Flash 区域、分区表、写入负载，得地址范围、重叠检测、页/写粒度对齐、剩余空间、擦除寿命。寿命按 page-rewrite 与 circular-log 两种模型分别算，两者可差几个数量级。
- lvgl_mem：算整帧字节、绘制缓冲占用、满屏刷新的带宽与总线占用率。**LV_MEM_SIZE 无法静态计算**，那部分只能用 lv_mem_monitor() 实测。

**镜像与启动**（量产前必查）
- fw_image：action=hex 逐条校验 Intel HEX 记录的校验和、地址重叠、地址空洞、缺 EOF，给出字节数与地址范围；同时给了 Flash/RAM 范围就把镜像头 8 字节当向量表校验（SP 在 RAM 且 8 字节对齐、复位向量 Thumb 位、目标在 Flash、VTOR 对齐）；再给 crc_preset 就算整镜像 CRC。action=vectors 单独校验一组 SP/复位向量。**这两个字是上电后硬件读的第一样东西，早于任何 C 代码——错了不会有日志，只表现为"不启动"。**
- qspi_flash：核心关系 D × tCLK ≥ tV，即 **dummy 下限 = ceil(tV × f)**、给定 dummy 的频率上限 = D / tV。**dummy 数是频率的函数**，手册里那句"需要 N 个 dummy"通常带前提频率，换高时钟必须重算。另给首次数据延迟与随机读/连续读的等效吞吐（小读长开销占比高，这是开 XIP 连续模式的原因）。
- stack_depth：最坏调用链 + 最深的 N 层中断帧 = 静态上界，对比栈区大小与余量。帧大小取自编译器 -fstack-usage 生成的 .su 文件。**静态上界不等于实测用量**，必须用填充法（魔数填满 + 跑完最坏工况扫水印）或栈水位寄存器复核；给了水印地址可反算已用字节。

**时钟 / 中断 / 看门狗 / 电源**
- clock_tree：solve 找出能精确命中目标频率的 PLL 组合（fout = fsrc / inputDiv × mul / outputDiv）；命中不了就如实报最接近的组合与误差百分数——该误差对 UART 可忽略、对 USB/CAN/I²S 是致命的。evaluate 逐节点算分频链频率并按你给的上限校验。uart 算时钟误差的串口容错余量（预算 0.5 / 每帧位数）。VCO 区间与外设时钟上限必须查手册。
- nvic_priority：grouping 由已实现优先级位数与子优先级位数算抢占级数与寄存器位位置；preempt 判两个中断能否互相抢占——**抢占位相同则彼此不能抢占，子优先级不产生抢占**（最常见的误判）；latency 算中断延迟上界 = 最长关中断窗口 + 更高优先级 ISR 之和 + 入栈开销。
- watchdog_check：timeout/solve 算超时时间与计数参数；check 判定**最坏**喂狗间隔是否落在允许区间（窗口型还要求不能喂太早，喂早了同样复位），并检查上电初始化耗时是否超过超时。**不要在中断里喂狗**——那会掩盖主循环卡死。
- power_tree：LDO 耗散 =(Vin−Vout)×Iout、效率 = Vout/Vin（**与电流无关**，压差全部变成热）；DCDC Pin = Pout/η；结温 Tj = Ta + Pd × Rθja，允许功耗 =(Tj_max−Ta)/Rθja。Rθja / Tj_max / η 必须查手册。

**总线与无线**
- canfd_timing：CAN FD 两段速率**分开**反算（仲裁段与数据段各自的 BRP/TSEG1/TSEG2/SJW 与寄存器编程值），算 BRS 与 CRC 界定符这两个 mixed 位的时长，给 FD 帧逐字段位数、CRC 变体（17/21 位）与固定填充位数。**FD 的 DLC 9~15 是非线性映射**（12/16/20/24/32/48/64），只有 16 种合法载荷长度——10 字节这类需求必须补齐到下一档。
- pmbus_check：SMBus 超时与时钟拉伸（tTIMEOUT 25/35 ms、tLOW:SEXT 25 ms、tLOW:MEXT 10 ms）逐项判裕量；PEC 的覆盖字节序列 + CRC-8 校验（若给逻辑分析仪抓到的字节序列可逐字节交叉校验）；LINEAR11 / LINEAR16 / DIRECT 双向换算与量化误差。
- usb_bandwidth：USB 2.0 帧/微帧预算。中断/同步给每帧字节数与总线占用占比；批量给单次事务的开销拆解（令牌/数据/握手/包间延迟）与剩余带宽能装几个事务；控制给一次完整控制传输的耗时；另有"多端点能否装进一帧"与高带宽端点校验。
- sdio_speed：SD/SDIO/eMMC 速率档（16 档）与有效吞吐——扣掉命令响应、每根 DAT 线各一份的块内开销、写方向忙等待、块间空隙与主机开销后给效率归因；识别阶段 f_OD ≤ 400 kHz 限速校验；信号完整性降档建议。
- lora_airtime：LoRa 空中时间（Semtech 公式，含 LDRO 与显式/隐式包头）与 **EU868 占空比合规**（各子频段限值、每小时/每天可用发送时长、所需静默时间）。**注意：1 s / 100 s 那组限值属 polite spectrum access 路径，与占空比二选一，不是 EU868 通用限值。**
- ble_throughput：BLE 连接吞吐（逐层开销 LL / L2CAP / ATT，DLE 27~251、MIC、T_IFS）与瓶颈归因；广播占空比与广播数据长度；连接参数合法性（间隔/延迟/超时的合法关系）；各 PHY（1M / 2M / Coded S2 / S8）对比。**理论值比实测偏高，Coded S=8 可达 1.88 倍。**
- link_budget：FSPL（20log10(d_m) + 20log10(f_Hz) − 147.55）与链路闭合：P_rx = P_tx + G_tx + G_rx − FSPL − Σ扣减，余量 = P_rx − 灵敏度；可反推最大理论距离、做多频段对比。**所有损耗项与灵敏度必须由你传入**——未给的项会列进"未计入"，不要当成 0。

工具输出一律是**设计值**；抖动、实际漏电、整机功耗、栈峰值属于**实测值**，只能由仪器给出。两者分开表述，不得混用。
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
