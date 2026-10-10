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

### 工具（模型可调，共 8 个）

只保留两类：**模型物理上做不到的**（解析 ELF / map / Intel HEX、执行构建、用 ELF 符号表翻译地址）与**高频且错一位就翻盘的**（CRC、位时序枚举、PLL 搜索）。

> **实测**：这 8 个工具的模型可见 schema 合计 **11,170 字符**；重构前 32 个工具是 **62,009 字符**
> （两者同口径，均取模型实际收到的 `{name, description, parameters}` 序列化形式），**-82%**。
> 被移出去的能力一个都没丢：实现仍在 `lib/` 与 `integrate/` 下，经 `skills/_shared/run-tool.mjs`
> 按工具名调用，参数校验与数值与工具时代逐字节一致。

#### 体积与构建

| 工具 | 作用 | 关键点 |
|---|---|---|
| `fw_size` | 体积分析。**自动识别三种输入**：ELF 文件 / GNU ld `.map` / Keil MDK `.map`。输出 ROM（Flash 镜像）与 RAM 占用、Code/RO/RW/ZI 明细、体积大户排序；给了预算才算占用率与余量 | 每种格式各用**自己的自洽校验**；排序粒度为**符号级**（不是段名），已与官方 `arm-none-eabi-size` / `nm` 交叉验证 |
| `fw_build` | 多工具链构建。`probe` 探测本机可用工具链；`build` 执行构建并解析错误警告 | 七后端：keil / platformio / cmake / make / idf / iar / custom。**可执行文件探测与实际构建分开报告** |

#### 总线与协议

| 工具 | 作用 | 关键点 |
|---|---|---|
| `proto_frame` | 协议帧。`build` 构建 Modbus RTU 帧 / `verify` 审查帧（Modbus 会翻译功能码与异常码）/ `crc` 算**通用参数化 CRC** | CRC 引擎参数化（width/poly/init/refin/refout/xorout），内置 12 种预设 + 可传自定义参数，不限于 Modbus |
| `can_timing` | CAN 位时序反算（BRP / TSEG1 / TSEG2 / SJW + 寄存器编程值=功能值−1） | 一并给出采样点、振荡器容差 df（Bosch/CiA 两条约束取小）、传播段可覆盖的最大单向延迟；排序以采样点接近 **87.5%** 优先，不是单纯取容差最大 |
| `canfd_timing` | CAN FD 两段速率**分开**反算、BRS/CRC 界定符 mixed 位、DLC 非线性映射、CRC17/21 与固定填充位 | **FD 的 DLC 9~15 是非线性映射**（12/16/20/24/32/48/64），只有 16 种合法载荷长度，10 字节这类需求**必须补齐到下一档**；数据段 >1 Mbit/s 必须使能 TDC 且 BRPD 应为 1 或 2 |

#### 时钟

| 工具 | 作用 | 关键点 |
|---|---|---|
| `clock_tree` | PLL **精确命中**的组合求解 + 分频链逐节点校验 + 串口时钟容错预算 | `fout = fsrc/inputDiv×mul/outputDiv`（整数运算）；命中不了就如实报最接近组合与误差——**该误差对 UART 可忽略、对 USB/CAN/I²S 是致命的**；VCO 区间与外设时钟上限必须查手册 |

#### 镜像与启动（量产前必查）

| 工具 | 作用 | 关键点 |
|---|---|---|
| `fw_image` | Intel HEX 逐条校验和 / 地址重叠 / 空洞 / 缺 EOF；顺带（给 Flash+RAM 范围）做 Cortex-M 向量表校验；给 `crc_preset` 再算整镜像 CRC。`action=vectors` 单独校验一组 SP/复位向量 | 向量表：SP 在 RAM 且 **8 字节对齐**、复位向量 **Thumb 位**、目标在 Flash、**VTOR 按异常数对齐**。**这两个字是上电后硬件读的第一样东西，早于任何 C 代码——错了不会有日志，只表现为"不启动"** |

#### 调试

| 工具 | 作用 | 关键点 |
|---|---|---|
| `fault_decode` | Cortex-M 异常分诊：栈/模式判定、**PC/LR 翻译成「函数 + 偏移」**、CFSR/HFSR/MMFAR/BFAR 解读、按置信度排序的根因推断 | 需要 ELF 提供符号表；单看 `PC=0x08001a3c` 无意义，译成 `Reset_Handler + 0x2c` 才能定位 |

> **其余 17 项能力已改为按需加载的技能**，不再占用每轮上下文：总线时序（I²C / SPI / I²S / RS-485 / RS-232 / LIN / 1-Wire / QSPI）、功耗与电源树、引脚漏电、ADC 采样负载、NVM 寿命、LVGL 缓冲、栈深度、调度可行性、BLE / LoRa / USB / SD / PMBus、链路预算。
> 见下节技能表 —— 每个技能正文里带**可执行脚本**的用法：`node <插件根>/skills/_shared/run-tool.mjs <工具名> key=value …`

### 技能（写进上下文，`/` 可调，共 21 个）

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
| `ble-throughput` | BLE 吞吐 / 广播占空比 / 连接参数合法性与各 PHY 对比。**含随附脚本**（`skills/_shared/run-tool.mjs`），数值由脚本算，不靠心算；含 2120 vs 2128 µs 的已知差异与理论值偏乐观的实测倍率 |
| `pmbus-check` | PMBus/SMBus 命令层：超时与时钟拉伸的实测裕量、PEC 覆盖与 CRC-8 交叉校验、LINEAR11/16/DIRECT 换算。含 25/35 ms 灰区、读事务地址字节出现两次这两个头号坑；`skills/_shared/run-tool.mjs pmbus_check …` |
| `link-budget` | 链路预算与闭合：FSPL、扣减明细、余量与达标判定、反推距离、多频段对比。**八个扣减键名与"未计入"清单**、单位必须 SI、拼错的键会被拒绝；`skills/_shared/run-tool.mjs link_budget …` |
| `usb-bandwidth` | USB 2.0 帧/微帧预算、周期上限与控制保留、高带宽端点、事务开销拆解。含包间延迟无内置实测值、HS 的 bInterval 是 2^(n−1) 微帧、不做 SPLIT 建模会高估；`skills/_shared/run-tool.mjs usb_bandwidth …` |
| `sdio-speed` | SD/SDIO/eMMC 速率档与有效吞吐、识别阶段限速、降档建议。含每块 18 时钟开销**每根 DAT 线各一份**、四项开销不传即按 0 计（乐观上界）、偏斜/负载上限不给就不判定；`skills/_shared/run-tool.mjs sdio_speed …` |
| `power-and-io` | 功耗预算与电池寿命、电源树耗散与结温、引脚漏电通路与电平冲突、ADC 采样负载与源阻抗上限。含**待机漏电是硬地板**、LDO 效率与电流无关、最坏情况取手册 min 电阻、源阻抗超限会让读数偏低而非线性；`skills/_shared/run-tool.mjs power_budget \| power_tree \| leak_pin \| adc_load …` |
| `bus-timing` | 总线与线路时序电气：I²C 上拉区间、SPI 模式与最高时钟、I²S 时钟整除、RS-485/UART 与 Modbus 静默时间、RS-232/422 电气与线长、LIN 调度表、1-Wire 时隙、QSPI dummy cycle。含每项"必须查手册/实测"的参数清单；`run-tool.mjs i2c_bus \| spi_bus \| i2s_clk \| rs485_timing \| rs232_link \| lin_sched \| onewire_timing \| qspi_flash …` |
| `mcu-core` | NVIC 优先级分组与中断延迟上界、看门狗超时窗口与喂狗可行性、调度可行性、栈深度静态上界。含**抢占位相同则不能抢占**、窗口型喂太早同样复位、**静态上界≠实测用量**；`run-tool.mjs nvic_priority \| watchdog_check \| sched_analyze \| stack_depth …` |
| `storage-and-display` | NVM 分区规划与擦除寿命、LVGL 缓冲与带宽。含**磨损模型选错寿命差几个数量级**、`LV_MEM_SIZE` 无法静态计算必须 `lv_mem_monitor()` 实测；`run-tool.mjs nvm_layout \| lvgl_mem …` |
| `lora-airtime` | LoRa 空中时间（Semtech 公式 + LDRO + 显式/隐式头）与 EU868 占空比合规、各 SF 对比。含 **LDRO 收发两端必须一致**、**1 s / 100 s 属 polite spectrum access 路径与占空比二选一**、Ton/Toff 不替 868 子频段编造；`run-tool.mjs lora_airtime …` |

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

- 一张「要回答什么问题 → 用哪个工具」的对照表（8 个工具全覆盖）
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

> **已挂载实测**（dsh 0.2.0-rc.2 + 本包 0.2.0）：门禁文本正常注入会话首步，
> 8 个工具全部注册（抽查 `proto_frame`，返回的 Modbus RTU 帧与 CRC 正确），
> 21 个技能进入会话技能目录。
>
> `source.kind` 必须是 producer 自己的标识（`plugin:<包名>`）——v4 明确禁止通配的
> `plugin` kind，传它会在会话持久化时抛 `SessionFormatError`。
> 若门禁没出现，可先 `gateEnabled: false` 关掉，不影响 8 个工具与 21 个技能。

### 前置依赖

**运行（生产）**：插件的裸导入（`@deepseek-ai/dsh-tools`）由 Node 从插件目录向上查找解析，
因此**插件放在 `my-DSH/plugins/` 下即可命中 `my-DSH/node_modules/@deepseek-ai/`**。

**自测/CI（开发）**：`npm install` 会按 devDependencies 装入 `vendor/` 下的本地 stub
（`file:./vendor/dsh-tools`、`file:./vendor/dsh-llm`），无需真实 dsh 环境。

**兼容性判定（不满足会被静默跳过，务必看这条）**：dsh 在装载 profile 前逐个检查插件的
`@deepseek-ai/dsh*` peerDependencies，用
`semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定；不满足就把
**整行 bundle 跳过**，只在启动日志留一句 `skipping profile bundle` —— 表现为
"装上了但没生效"，且不报错。所以 peer 范围必须覆盖你实际运行的 dsh 版本。
本包声明 `>=0.1.6-alpha.1 <0.3.0`。宿主升出该范围时，要么同步放宽范围，
要么在 profile 目录写 `compatibility.json` 授予精确版本豁免：
`{"dsh-embedded-kit@<包版本>": ["<dsh 版本>"]}` —— 它按**精确版本对**生效，
宿主升级后需重新授权。

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

三个脚本全部通过。**总计 342 项自测 + 0 失败的多格式验证**。

### 自测：342 项全通过

```bash
npm install        # 首次需要：装 vendor/ 下的 @deepseek-ai/dsh-tools / dsh-llm 本地 stub
node selftest.mjs
```

> stub 只提供最小形状（`defineTool` / `createUserMessage`），让自测在**未挂进 dsh profile
> 的干净 checkout（含 CI）**上也能跑；生产安装（`dsh plugin add`）不装 devDependencies，
> 裸导入由宿主 profile 的 node_modules 提供真实实现，与本 stub 无关。

不依赖 DSH 进程。其中最关键的几条：
- **`apply()` 真的被调用**（假 ctx）→ 8 个工具的 `defineTool` schema 合法性被真实验证
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
│   ├── index.js          # 插件入口：name / inject / apply，注册 8 工具 + 21 技能
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
└── selftest.mjs                   # 342 项自测（不依赖 DSH）
```

`testdata/smoke/` 的产物可自行重建（源码与链接脚本都在，两套工具链任一可用即可）。

---
