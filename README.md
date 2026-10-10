# dsh-embedded-kit

嵌入式固件开发工具包 —— DeepSeek Harness（dsh）本地插件，**host 半边**。

给 DSH 补上真正能动手的嵌入式能力：**量化固件体积、构建与审查协议帧、算总线时序与电气预算、
算时钟树 / 中断延迟 / 看门狗 / 电源树、校验固件镜像与栈深度、估算无线链路**，
外加十一份写进上下文的审查清单技能。

**芯片中立、工具链中立、IDE 中立。** 不预设你用的是哪家 MCU、哪个 IDE 或哪套编译器 ——
体积分析吃 ELF / GNU ld map / Keil map 三种输入，构建支持七种后端。

所有工具都遵守同一条纪律：**区分「按公式或链接器输出算出的值」与「实测值」，并明确标注未测项**。
拿不到的数据就标成 `pending`，绝不编一个看起来合理的数字。

---

## 装了什么

### 工具（模型可调，共 32 个）

#### 体积与构建

| 工具 | 作用 | 关键点 |
|---|---|---|
| `fw_size` | 体积分析。**自动识别三种输入**：ELF 文件 / GNU ld `.map` / Keil MDK `.map`。输出 ROM（Flash 镜像）与 RAM 占用、Code/RO/RW/ZI 明细、体积大户排序；给了预算才算占用率与余量 | 每种格式各用**自己的自洽校验**；排序粒度为**符号级**（不是段名），已与官方 `arm-none-eabi-size` / `nm` 交叉验证 |
| `fw_build` | 多工具链构建。`probe` 探测本机可用工具链；`build` 执行构建并解析错误警告 | 七后端：keil / platformio / cmake / make / idf / iar / custom。**可执行文件探测与实际构建分开报告** |

#### 总线与协议

| 工具 | 作用 | 关键点 |
|---|---|---|
| `proto_frame` | 协议帧。`build` 构建 Modbus RTU 帧 / `verify` 审查帧（Modbus 会翻译功能码与异常码）/ `crc` 算**通用参数化 CRC** | CRC 引擎参数化（width/poly/init/refin/refout/xorout），内置 12 种预设 + 可传自定义参数，不限于 Modbus |
| `rs485_timing` | 位与字符时间、发送耗时、Modbus 的 t1.5 / t3.5、DE/RE 方向切换窗口 | 收发器参数**必须查数据手册**，未给则列入 `pending` 且按 0 计入 |
| `i2c_bus` | I²C / SMBus 上拉电阻区间与可行性：`Rp(min)`（灌电流）与 `Rp(max)`（上升时间，可叠加漏电流约束），并判定总线电容是否超规范上限、区间是否为空 | `Rp(min)=(VDD−VOL)/IOL`、`tr=0.8473×Rp×Cb`；**总线电容是硬约束不是"尽量小"**；给了实际上拉值反算上升时间。公式出自 NXP UM10204 |
| `spi_bus` | SPI 模式边沿语义 + 一阶模型估最高 SCK + 吞吐预算 | 把 CPOL/CPHA 翻成"哪个边沿采样、哪个边沿移出"是**确定的定义**（非估计）；`tV/tSU` 必须查各自手册，最高时钟只是一阶估计，最终看波形 |
| `i2s_clk` | I²S / TDM 的 LRCK / BCLK / MCLK 整除性 | 全是确定算术；**MCLK 不是 fs 整数倍会引入周期性采样点漂移，主时钟分不出 BCLK 则根本跑不起来** |
| `can_timing` | CAN 位时序反算（BRP / TSEG1 / TSEG2 / SJW + 寄存器编程值=功能值−1） | 一并给出采样点、振荡器容差 df（Bosch/CiA 两条约束取小）、传播段可覆盖的最大单向延迟；排序以采样点接近 **87.5%** 优先，不是单纯取容差最大 |
| `lin_sched` | LIN 帧时间与调度表可行性 | 固定 34 位帧头（break 13 + 分隔符 1 + sync 10 + PID 10）；规范最小槽位 = 帧时间 **×1.4 裕量**；判定槽位合计是否装得进周期。常量出自 LIN 规范 |
| `onewire_timing` | 1-Wire **标准速率**时隙窗口校验（时隙/写 1/写 0/读时隙/恢复时间逐项） | Overdrive 速率窗口**窄一个量级且各器件不同，本工具不给那组数**，请查具体器件手册。窗口出自 Maxim DS0009 |
| `rs232_link` | RS-232(V.28) 输出幅度/门限/摆率 + 按电容折算线长；RS-422(V.11) 差分与终端匹配 | **V.28 的长度限制来自线缆电容（上限 2500 pF），不是某个固定米数**；V.11 侧查差分幅度下限与终端电阻匹配 |

#### 镜像与启动（量产前必查）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `fw_image` | Intel HEX 逐条校验和 / 地址重叠 / 空洞 / 缺 EOF；顺带（给 Flash+RAM 范围）做 Cortex-M 向量表校验；给 `crc_preset` 再算整镜像 CRC。`action=vectors` 单独校验一组 SP/复位向量 | 向量表：SP 在 RAM 且 **8 字节对齐**、复位向量 **Thumb 位**、目标在 Flash、**VTOR 按异常数对齐**。**这两个字是上电后硬件读的第一样东西，早于任何 C 代码——错了不会有日志，只表现为"不启动"** |
| `qspi_flash` | QSPI / OSPI dummy cycle 与频率的关系、读延迟与吞吐 | `D×tCLK ≥ tV`，即 **dummy 下限 = ceil(tV×f)**、给定 dummy 的频率上限 = D/tV；**dummy 数是频率的函数**，手册里"需要 N 个 dummy"通常带前提频率，换高时钟必须重算 |
| `stack_depth` | 栈深度**静态上界**（最坏调用链 + 最深 N 层中断帧）+ 填充法实测步骤 + 水印反算 | 帧大小取自编译器 `-fstack-usage` 的 `.su`；**静态上界≠实测用量**，函数指针/库函数/中断时机都会额外吃栈，必须用填充法或水位寄存器复核 |

#### 存储与显示

| 工具 | 作用 | 关键点 |
|---|---|---|
| `nvm_layout` | NVM/Flash 分区规划：地址范围、**重叠检测**、页与写粒度**对齐检查**、剩余空间、**擦除寿命（年）** | 磨损模型分 `page-rewrite` 与 `circular-log`，两者寿命差可达**几个数量级**（8 页环形日志≈8 倍耐久） |
| `lvgl_mem` | LVGL 显示缓冲与带宽：整帧字节、绘制缓冲占用、满屏刷新的带宽与总线占用率 | `LV_MEM_SIZE` **无法静态计算**，工具明确说明必须用 `lv_mem_monitor()` 实测 |

#### 调度与调试

| 工具 | 作用 | 关键点 |
|---|---|---|
| `sched_analyze` | 调度可行性：CPU 占用率、节拍量化误差、**节拍碰撞扫描**、同拍最坏等待（抖动上界） | 最重一拍能否在一拍内跑完 —— 节拍驱动的生死线 |
| `fault_decode` | Cortex-M 异常分诊：栈/模式判定、**PC/LR 翻译成「函数 + 偏移」**、CFSR/HFSR/MMFAR/BFAR 解读、按置信度排序的根因推断 | 需要 ELF 提供符号表；单看 `PC=0x08001a3c` 无意义，译成 `Reset_Handler + 0x2c` 才能定位 |

#### 功耗与模拟

| 工具 | 作用 | 关键点 |
|---|---|---|
| `power_budget` | 各模式电流加权 → 平均电流与电池寿命 | 常驻漏电单列（"硬地板"，不随占空比下降） |
| `adc_load` | ADC 采样电荷转移电流 + 源阻抗上限 + 分压/漏电常态负载 | `I = f × C_ADC × Vref × 通道数`，随采样率线性增长；源阻抗超限会让**读数偏低而非线性** |
| `leak_pin` | 引脚漏电与电平冲突判定 + 电流估算 | 通路由拓扑**确定**；电流需 `vdd` + `pull_ohm`；**取手册的 min 电阻算最坏情况** |

#### 时钟 / 中断 / 看门狗 / 电源

| 工具 | 作用 | 关键点 |
|---|---|---|
| `clock_tree` | PLL **精确命中**的组合求解 + 分频链逐节点校验 + 串口时钟容错预算 | `fout = fsrc/inputDiv×mul/outputDiv`（整数运算）；命中不了就如实报最接近组合与误差——**该误差对 UART 可忽略、对 USB/CAN/I²S 是致命的**；VCO 区间与外设时钟上限必须查手册 |
| `nvic_priority` | NVIC 优先级分组、抢占判定、中断延迟上界 | **抢占位相同则彼此不能抢占，子优先级不产生抢占**（最常见的误判）；延迟上界 = 最长关中断窗口 + 更高优先级 ISR 之和 + 入栈开销 |
| `watchdog_check` | 看门狗超时求解、最坏喂狗间隔区间判定、上电路径检查 | 窗口型还要求**不能喂太早**（喂早了同样复位）；判据是**最坏**喂狗间隔而非平均；**不要在中断里喂狗**——那会掩盖主循环卡死 |
| `power_tree` | LDO/DCDC 逐轨耗散与结温、整树效率、最热轨 | LDO 效率 = Vout/Vin **与电流无关**，压差全变成热（12 V→3.3 V @100 mA 就有 0.87 W）；`Tj=Ta+Pd×Rθja`；`Rθja / Tj_max / η` 必须查手册 |

#### 高速总线与无线

| 工具 | 作用 | 关键点 |
|---|---|---|
| `canfd_timing` | CAN FD 两段速率**分开**反算、BRS/CRC 界定符 mixed 位、DLC 非线性映射、CRC17/21 与固定填充位 | **FD 的 DLC 9~15 是非线性映射**（12/16/20/24/32/48/64），只有 16 种合法载荷长度，10 字节这类需求**必须补齐到下一档**；数据段 >1 Mbit/s 必须使能 TDC 且 BRPD 应为 1 或 2 |
| `pmbus_check` | SMBus 超时与时钟拉伸判定、PEC 覆盖与 CRC-8 交叉校验、LINEAR11/16/DIRECT 双向换算 | 25 ms 是**误触发阈值**、35 ms 是**清除期限**（25~35 ms 灰区最危险）；PEC 覆盖里**读事务的地址字节出现两次**，漏掉第二个是"一直对不上"的头号原因；m/b/R 与指数必须查器件手册 |
| `usb_bandwidth` | USB 2.0 帧/微帧预算、周期上限与控制保留、高带宽端点、事务开销拆解 | 周期传输上限 FS 90% / HS 80%，控制保留 FS 10% / HS 20%，**批量不保留任何带宽**；包间延迟无内置实测值，退回规范下限并在 notes 里点名 |
| `sdio_speed` | SD / SDIO / eMMC 速率档（16 档）、有效吞吐与效率归因、识别阶段限速、降档建议 | 每块固定 18 个时钟的令牌开销**每根 DAT 线各一份、与位宽无关**（位宽翻 4 倍 ≠ 吞吐翻 4 倍）；识别阶段 `f_OD ≤ 400 kHz`；偏斜/负载上限不给就**不判定** |
| `lora_airtime` | LoRa 空中时间（Semtech 公式）+ **EU868 占空比合规**、可用发送时长与静默时间 | LDRO 在符号时长 >16 ms 时强制且收发两端必须一致（漏置位时**算出的空时偏小**）；占空比按射频实际在线时间统计，`extra_overhead_sec` 无默认值；**1 s / 100 s 那组限值属 polite spectrum access 路径，与占空比二选一，不是 EU868 通用限值** |
| `ble_throughput` | BLE 逐层开销吞吐与瓶颈归因、广播占空比、连接参数合法性、各 PHY 对比 | 一条数据依次啃掉 ATT 3 + L2CAP 4 + LL 头 2 + MIC 4 + CRC 3 + 前导/AA + 两个 T_IFS；`encrypted / legacy / channel_count` 无默认值，缺则直接报错；**理论值比实测偏高，Coded S=8 的包时间是 1M 的 1.88 倍** |
| `link_budget` | 自由空间路径损耗与链路闭合、最大理论距离、多频段对比 | `FSPL = 20log10(d_m) + 20log10(f_Hz) − 147.55`（常数即 `20log10(4π/c)`）；**所有损耗项与灵敏度必须由你传入**，未给的项列入"未计入"，绝不替你填；只含几何扩散，`d_max` 是**乐观上限** |

### 技能（写进上下文，`/` 可调，共 11 个）

| 技能 | 内容 |
|---|---|
| `embedded-code-review` | 代码审查清单。裸机与 RTOS 分开；**并附 ARM / AArch64 / RISC-V / Xtensa / AVR / PIC / 8051 / MSP430 的厂商与架构差异对照**，明确要求不预设芯片型号 |
| `scheduling-patterns` | 状态机（显式/表驱动）+ 多定时器分时（相位错开、节拍碰撞）+ 定时器+中断调度 + 何时该上 RTOS 的判据 |
| `low-power-and-leakage` | 功耗预算、低功耗模式与唤醒源、**漏电分类排查**（含 CMOS 输出配内部上拉的原理图级讲解与二分法诊断）、**数据手册必查电气参数**（R_PU / I_LK / C_ADC / R_ADC）、休眠前引脚复核清单 |
| `code-standards` | 嵌入式 C 代码规范 R1~R10，全部写成**可判定**条款，可直接固定为项目基准 |
| `fault-diagnosis` | HardFault 分诊方法论：异常升级链、**现场保存流程**（`tst lr,#4` 判栈 + NOINIT 段）、按证据强度的分诊决策树、栈溢出判别、看门狗复位与硬故障的区分 |
| `debug-methodology` | 调试方法论：二分定位、**不用 printf 测时序**（GPIO 翻转 / DWT / 逻辑分析仪）、日志分级与可持久化、故障注入、断点的类型与限制、「改了就没了」的处理 |
| `nvm-storage` | NVM 设计：Flash 物理约束、掉电安全的三级阶梯（单份/双备份+序号/日志式追加）、CRC 与版本迁移、分区布局参考、故障对照表 |
| `lvgl-patterns` | LVGL 使用模式：缓冲配置取舍、主循环与 RTOS 两种正确接法、`LV_MEM_SIZE` 实测而非猜、**中文字库是体积头号杀手**、花屏/撕裂/卡死成因对照 |
| `architecture-principles` | 架构原则：依赖方向、模块边界（禁跨模块读写全局）、**状态单写者**、三层错误传播语义、编译期 vs 运行期配置、可观测性、资源受限下的取舍、10 条评审清单 |
| `protocol-review` | 串行通讯协议编写与审查。帧设计、CRC 三个经典坑、超时重试、RS-485 半双工方向切换、Modbus RTU 要点 |
| `fw-size-optimization` | 体积优化流程。先量后改，四层削减，每步复测并保留 ≥20% 余量；含 IAR / ESP-IDF / 裸 GCC 的手段对照 |

---

## 安装

### 方式一：本地挂载（免安装、免发布）

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-embedded-kit
      name: /你的仓库绝对路径/dsh-embedded-kit/lib/index.js
```

`name` 必须是**绝对路径**（相对路径会静默解析失败，且不报错）。改完重启 dsh 生效。

> 若已有其他 `insert` 块，把这一条加到同一个数组里，不要写两个顶层 `- insert:`。

### 方式二：作为 npm 包安装（**推荐** —— 本包自带 bundle patch）

本包随包发布 `cordis.patch.yml`，并在 `package.json` 里声明了 `dsh.bundle.patch`。
因此装进 profile 后**自动应用**，你不需要手写任何路径：

```bash
dsh plugin --profile <profile> add dsh-embedded-kit
```

之后用 `dsh --profile <profile> --dump-config` 核对是否进树。

> `cordis.patch.yml` 里的 `name` 写的是**包名**而不是绝对路径，所以装完即生效 ——
> 不需要用户手写绝对路径。

### 会话启动门禁（pre-step gate）

本插件挂在 `ctx.on('agent/pre-step')` 上，在**每个会话的第一步**注入一段门禁文本，内容包括

- 一张「要回答什么问题 → 用哪个工具」的对照表（32 个工具全覆盖）
- 三条硬约束：**缺数据不许编** / **区分设计值与实测值** / **引用手册章节号前先确认它存在**

目的是让模型**先算再说**，而不是凭印象口算。

两处刻意的设计取舍：
1. **去重方式**：用按会话对象索引的 `WeakSet`，不依赖未公开的会话事件 schema ——
   行为更可预测。代价：同一会话在新进程里 resume 会再注入一次（无害）。
2. **失败降级**：`createUserMessage` 走动态导入，拿不到就**只记日志、不注入**，
   **绝不因为一个可选依赖缺失而让整个插件挂载失败**（本包既有原则）。

可用配置关掉或替换：

```yaml
config:
  gateEnabled: false          # 关闭门禁
  gateContent: "自定义文本"    # 替换默认门禁文本
```

> **诚实标注**：门禁的**处理函数契约**（追加消息、按会话去重、reject 透传）与
> **消息形状**（`text` 内容块 + `source.plugin`）已在自测中用假 ctx 验证；
> 但**"在真实 dsh 会话里是否被正确消费"未验证** —— 本包尚未挂进 profile。
> 若挂载后门禁没出现，可先 `gateEnabled: false` 关掉，不影响 32 个工具与 11 个技能。

### 前置依赖

**运行（生产）**：插件的裸导入（`@deepseek-ai/dsh-tools`）由 Node 从插件目录向上查找解析，
因此**插件放在 `my-DSH/plugins/` 下即可命中 `my-DSH/node_modules/@deepseek-ai/`**。

**自测/CI（开发）**：`npm install` 会按 devDependencies 装入 `vendor/` 下的本地 stub
（`file:./vendor/dsh-tools`、`file:./vendor/dsh-llm`），无需真实 dsh 环境。

---

## 配置（可选）

```yaml
- insert:
    - id: dsh-embedded-kit
      name: <绝对路径>/lib/index.js
      config:
        uv4Path: C:\Keil_v5\UV4\UV4.exe   # 仅 keil 后端需要，其他后端无关
        registerSkills: true               # 是否注册随包技能，默认 true
```

`uv4Path` 解析优先级：显式配置 → 环境变量 `KEIL_UV4` → 默认 `C:\Keil_v5\UV4\UV4.exe`。

### 关于技能服务的取舍（重要）

本插件的 `inject` **只声明 `['tools']`**，技能走**尽力而为**路径：
Cordis 的 `inject` 是硬依赖，一旦声明 `skills` 而当前 profile 没有该服务，
**整个插件会永久 pending，连工具都用不了**。拿不到 `ctx.skills` 时只记日志，工具照常注册。

---

## 验证（已测量）

三个脚本全部通过。**总计 332 项自测 + 0 失败的多格式验证**。

### 自测：332 项全通过

```bash
npm install        # 首次需要：装 vendor/ 下的 @deepseek-ai/dsh-tools / dsh-llm 本地 stub
node selftest.mjs
```

> stub 只提供最小形状（`defineTool` / `createUserMessage`），让自测在**未挂进 dsh profile
> 的干净 checkout（含 CI）**上也能跑；生产安装（`dsh plugin add`）不装 devDependencies，
> 裸导入由宿主 profile 的 node_modules 提供真实实现，与本 stub 无关。

不依赖 DSH 进程。其中最关键的几条：
- **`apply()` 真的被调用**（假 ctx）→ 32 个工具的 `defineTool` schema 合法性被真实验证
- **`import '@deepseek-ai/dsh-tools'` 真的执行** → 裸导入解析路径被真实验证
- **`fw_size` 对同一文件按 ELF 与按 Keil map 各跑一次** → 自动识别与格式切换被真实验证

### 多格式 / 多架构验证：0 失败

```bash
node tools/verify-size.mjs
```

`testdata/smoke/` 里有一份最小固件（源码 + 链接脚本都在包内，可复现），
被**两套工具链**（ARM Cortex-M0 与 RISC-V RV32）编译链接成 ELF 与 GNU ld map。

**最强判据是跨格式互证**：同一份固件，读 ELF（读节区头）与读 map（读链接脚本输出）
是两个完全独立的解析器，它们必须给出一致的数字。实测结果：

| 架构 | 来源 | ROM | RAM | Code | RO | RW | ZI |
|---|---|---|---|---|---|---|---|
| ARM Cortex-M0 | ELF | 116 | 584 | 48 | 64 | 4 | 580 |
| ARM Cortex-M0 | GNU map | **116** | **584** | **48** | **64** | **4** | **580** |
| RISC-V RV32 | ELF | 130 | 584 | 62 | 64 | 4 | 580 |
| RISC-V RV32 | GNU map | **130** | **584** | **62** | **64** | **4** | **580** |

四项明细**逐字节相同**。同时验证：数据部分（RO/RW/ZI）与架构无关，代码长度随 ISA 变化 ——
证明解析器真的读到了各自的目标码，而不是照抄某个固定数。

期望值不是从解析器输出抄的，而是**由源码与链接脚本独立推算**：
`.rodata` 16×2 + `.isr_vector` 8×4 = 64；`g_counter` = 4；`.bss` 68 + 堆栈预留 0x200 = 580。

### Keil map 样本验证

```bash
node tools/verify-real-map.mjs
```

`testdata/sample-keil.map` 含小计行、备注行与聚合视图，逐项求和与 Keil 自己打印的
`Total RO / RW / ROM Size` 行一致（实测 RO=964 / RW=1156 / ROM=1008，8 个目标文件）。

自备 `.map` 可直接传路径：`node tools/verify-real-map.mjs <map1> [map2] ...`。

### CRC 标准测试向量：9/9 通过

对 ASCII `"123456789"` 的公开公认 check value（CRC 社区标准基准）：

| 预设 | check value |
|---|---|
| crc16-modbus | 0x4B37 |
| crc16-ccitt-false | 0x29B1 |
| crc16-xmodem | 0x31C3 |
| crc16-arc | 0xBB3D |
| crc16-x25 | 0x906E |
| crc16-dnp | 0xEA82 |
| crc8 | 0xF4 |
| crc8-maxim | 0xA1 |
| crc32 | 0xCBF43926 |

### 为什么解析器要内置自洽校验

解析器的正确性靠两条：**自洽校验**（逐项求和 vs Keil 自己打印的汇总行）与**跨格式互证**
（同一份固件分别读 ELF 与读 GNU ld map，两条独立代码路径必须给出一致的数字）。

单一来源的解析器可以安静地错得很离谱，而使用者拿它做优化决策 —— 所以这两条校验
不是可选项，是解析器的一部分。

---

## 能担保什么 / 不能担保什么

**先说结论：不能笼统地说"保证可靠"。** 按证据强度分成四档，请按档采信。

### 第一档：经**外部独立工具**交叉验证（可以担保）

`fw_size` 对 ELF 的解析结果，已与官方工具的输出**逐项比对一致**：

| 验证项 | 外部真值来源 | 结果 |
|---|---|---|
| 各节区尺寸 | `arm-none-eabi-size -A -d` | 逐节区一致（.isr_vector 32 / .text 48 / .rodata 32 / .data 4 / .bss 68 / ._user_heap_stack 512） |
| 非分配节区排除 | 同上（.comment 126 / .ARM.attributes 49） | 正确排除，未计入运行时占用 |
| 符号级体积排序 | `arm-none-eabi-nm --print-size --size-sort` | 符号名与尺寸**完全一致**（g_rx_buf 64 / Reset_Handler 48 / g_crc_table 32 / g_vectors 32 / g_counter 4 / g_overruns 4） |
| Keil map 总量 | Keil 自己打印的 `Total RO/RW/ROM Size` 行 | 包内样本逐字节吻合（RO 964 / RW 1156 / ROM 1008） |
| CRC 算法 | CRC 社区公认 check value（对 `"123456789"`） | 9/9 通过 |

这三条是最硬的：**两个官方工具 + Keil 自己的汇总行**都印证了同一批数字。

### 第二档：靠**两种独立解析器互证**（可以担保）

同一份固件读 ELF（解析节区头）与读 GNU ld map（解析链接脚本输出）是**两条完全独立的代码路径**。
ARM Cortex-M0 与 RISC-V RV32 两套工具链的实测结果：`code/ro/rw/zi` **四项明细逐字节相同**。

单靠 map 自身的校验发现不了这类错误（段名换行漏解析、`.bss` 的 load address 误判、未分配段误计入等）—— 必须与 ELF 侧的结果互证。

### 第三档：**未验证**（不计入能力）

| 项 | 为什么没验证 |
|---|---|
| `fw_build` 的**七种后端实际构建** | 命令按官方文档构造，但**没有一个后端在真实工程上跑过**。工具输出里如实标注 `backendVerified: false` |
| LTO / `--gc-sections` / `-ffunction-sections` 产出的 ELF | 未测。这类产物会出现 `.gnu.lto_*` 等特殊节区，分类可能需调整 |
| armlink6 的 scatter 文件 / overlay / `--datacompressor` | 未测。这些会改变段结构与总量语义 |
| 多镜像工程（Boot + App 各有独立 map） | 未测。逐项求和会跨镜像累加，需分别分析 |
| 带外部存储资源的工程（外部 Flash 字模、资产） | **不在 ELF/map 里**，工具看不到，总量会低估 |
| Xtensa（ESP32）链接 | 验证用最小链接脚本放不下 Xtensa 的常量池，两个架构（ARM / RISC-V）验证了，**Xtensa 没验证** |
| 在真实 DSH 会话里跑通 | 本包按"先只交付目录"交付，未挂进 profile、未启动 dsh 实测 |

### 第四档：**已知的口径限制**（不是 bug，但会影响你怎么用）

1. **"体积大户"的粒度因格式而异**，工具会明确标出当前是哪一档：

   | 输入 | 排序粒度 | 你能拿它做什么 |
   |---|---|---|
   | ELF（有符号表） | **符号级**（函数与对象） | 直接定位"哪个函数最大"，可操作 |
   | GNU ld map | 逐输入段（含目标文件） | 定位"哪个 .o 的哪个段最大" |
   | Keil map | 逐目标文件 | 定位"哪个 .o 最大" |
   | ELF（被 strip 无符号表） | 段级 | 只能看段总量，**可操作性差** —— 会明确提示 |

2. **符号求和 ≠ 段合计**，差额是对齐填充与无符号区域（典型如堆栈预留 512 字节没有对应符号）。
   工具会把这个差额解释清楚，不当作错误。

3. **`fw_size` 算的是"镜像"，不是"你产品的 Flash 占用总量"**。链接器预留、外部资源、
   文件系统、双备份区都不在里面。要报给客户的总量必须另行核算。

4. **它不告诉你"该不该优化"**。它只给出量化事实；判断"这个体积是否合理"需要结合功能需求，
   这是你的决定，不是工具的结论。

### 一句话

**数字本身可以担保**（外部工具 + 双解析器互证）；**"未验证的功能"与"口径限制"已列全**，
按第三、四档采信即可。任何工具都不可能给你"保证没问题"—— 能给你的是"说清楚哪里验过、哪里没验"。

---

## 文件结构

```
dsh-embedded-kit/
├── package.json
├── lib/                        # 工具与算法模块（38 个文件）
│   ├── index.js          # 插件入口：name / inject / apply，注册 32 工具 + 11 技能
│   ├── gate.js           # 会话启动门禁（pre-step 注入）
│   ├── skills.js         # SKILL.md 加载与 ctx.skills 注册
│   # 体积与构建
│   ├── sizereport.js     # 体积统一层：格式识别 + 归一 + 各自的自洽校验策略
│   ├── elf.js            # ELF 节区 + 符号表解析（最通用：任意工具链、任意架构）
│   ├── gnumap.js         # GNU ld map 解析（GCC 系全家）
│   ├── mapfile.js        # Keil MDK map 解析（armlink / armlink6）
│   ├── build.js          # 七种构建后端 + 通用日志解析
│   ├── proctree.js       # 子进程树终止（Windows taskkill /T /F；POSIX 进程组杀）
│   ├── keil.js           # Keil 构建日志解析 + 多编码探测（GBK / UTF-8）
│   # 总线与协议
│   ├── crc.js            # 通用参数化 CRC 引擎 + 12 种预设
│   ├── modbus.js         # Modbus RTU 帧构建与审查
│   ├── rs485.js          # 半双工时序与方向切换
│   ├── i2c.js            # I²C/SMBus 上拉区间与上升时间（NXP UM10204）
│   ├── spi.js            # SPI 模式语义 + 最高时钟一阶模型 + I²S/TDM 整除性
│   ├── can.js            # CAN 位时序反算与振荡器容差（Bosch/CiA）
│   ├── lines.js          # LIN / 1-Wire / RS-232·422 线路级时序与电气
│   # 镜像、存储与栈
│   ├── image.js          # Intel HEX 校验 + Cortex-M 向量表校验
│   ├── qspi.js           # QSPI dummy cycle 与读带宽
│   ├── stack.js          # 栈深度静态上界 + 水印反算
│   ├── nvm.js            # NVM 分区与擦除寿命
│   # 时钟、中断、看门狗、电源
│   ├── clock.js          # PLL 求解与分频链校验
│   ├── nvic.js           # NVIC 分组、抢占判定、延迟上界
│   ├── watchdog.js       # 看门狗超时求解与喂狗窗口判定
│   ├── supply.js         # 电源树耗散与结温
│   ├── power.js          # 功耗预算与电池寿命
│   ├── adc.js            # ADC 采样负载与源阻抗上限
│   ├── leakage.js        # 引脚漏电与电平冲突（含上下拉 min/typ 范围）
│   # 调度、调试、显示
│   ├── sched.js          # 调度可行性、节拍碰撞、抖动上界
│   ├── fault.js          # Cortex-M 异常分诊 + 符号化地址翻译
│   ├── lvgl.js           # LVGL 缓冲与带宽
│   # 高速总线与无线
│   ├── canfd.js          # CAN FD 两段位时序 / BRS 切换 / DLC / CRC 场
│   ├── pmbus.js          # SMBus/PMBus 超时拉伸 / PEC / 数据格式换算
│   ├── usb.js            # USB 2.0 帧与微帧带宽预算
│   ├── sdio.js           # SD/SDIO/eMMC 速率档与有效吞吐
│   ├── lora.js           # LoRa 空中时间与 EU868 占空比合规
│   ├── ble.js            # BLE 逐层吞吐 / 广播占空比 / 连接参数
│   └── linkbudget.js     # 自由空间路径损耗与链路闭合
├── integrate/            # 工具描述符 + 用例（*.tool.mjs / *.cases.mjs）
├── probe/                # 模块自校验探针（*.probe.mjs）
├── cordis.patch.yml      # 随包 bundle patch（装完即生效，无需手写路径）
├── skills/               # 技能正文（单一真源，改这里即可；共 11 个）
├── testdata/
│   ├── sample-keil.map            # 含小计行/备注行/聚合视图的 Keil 样本
│   └── smoke/                     # 最小固件：firmware.c + link.ld + 编译产物
│       ├── arm-cm0.elf / .map     # ARM Cortex-M0 真实产物
│       └── riscv.elf  / .map      # RISC-V RV32 真实产物
├── tools/
│   ├── verify-size.mjs            # 多格式多架构验证（含跨格式互证）
│   └── verify-real-map.mjs        # 真实 Keil 工程验证
└── selftest.mjs                   # 332 项自测（不依赖 DSH）
```

`testdata/smoke/` 的产物可自行重建（源码与链接脚本都在，两套工具链任一可用即可）。

---
