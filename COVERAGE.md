# dsh-embedded-kit 覆盖地图

这份文档是**判断"漏没漏"的依据**，不是功能清单。

写法要求：按**轴**构造，而不是凭记忆举例——只有从轴推导，完整性才可审计。
每一项标注覆盖状态与**该用什么形式覆盖**：

| 标记 | 含义 |
|---|---|
| ✅ | 已有工具 |
| ⚠️ | 部分覆盖（写清缺哪一块） |
| 🔧 | **工具候选**——有确定公式/窗口/预算，可算可校验 |
| 📋 | **技能候选**——是清单/方法论/决策树，不是计算 |
| ⛔ | 不适合工具化（如布局布线、认证流程），只在技能里提点 |

---

## 轴 A：接口与总线

### A1 板级串行

| 接口 | 状态 | 说明 |
|---|---|---|
| UART / USART | ⚠️ | `rs485_timing` 覆盖位/字符时间；缺 FIFO/流控/错误标志 |
| RS-232 | ✅ | `rs232_link`（V.28 幅度/门限/摆率/电容折算线长） |
| RS-422 | ✅ | `rs232_link` 的 V.11 分支 |
| RS-485 | ✅ | `rs485_timing` + `rs232_link` V.11 |
| Modbus RTU | ✅ | `proto_frame` |
| Modbus ASCII / TCP | ⛔ | 无时序可算 |
| I²C | ✅ | `i2c_bus`（上拉区间/电容/上升时间） |
| SMBus / PMBus | ✅ | `pmbus_check`（tTIMEOUT/tLOW:SEXT/tLOW:MEXT 逐项裕量、PEC 覆盖与 CRC-8 交叉校验、LINEAR11/16/DIRECT 双向换算） |
| SPI | ✅ | `spi_bus` |
| I3C | 🔧 | 速率档、SDR/HDR 模式、带内中断时序 |
| I²S | ✅ | `i2s_clk` |
| TDM | ⚠️ | `i2s_clk` 可算槽位/BCLK；缺多通道时隙映射 |
| PDM | 🔧 | 时钟与抽取滤波器的带宽/延迟 |
| S/PDIF | ⛔ | — |
| 1-Wire | ✅ | `onewire_timing`（标准速率） |
| Microwire / SSP / SCI | ⛔ | — |
| SDIO / SD / eMMC | ✅ | `sdio_speed`（16 档速率、有效吞吐与效率归因、识别阶段 400 kHz 限速、信号完整性降档） |
| MIPI I3C / RFFE | ⛔ | — |

### A2 差分与现场总线

| 接口 | 状态 | 说明 |
|---|---|---|
| CAN 2.0 | ✅ | `can_timing` |
| CAN-FD | ✅ | `canfd_timing`（两段速率分开反算、BRS/CRC 界定符 mixed 位、DLC 非线性映射、CRC17/21 与固定填充位） |
| CAN-XL | ⛔ | — |
| LIN | ✅ | `lin_sched` |
| FlexRay | 🔧 | 静态/动态段调度 |
| PROFIBUS / PROFINET | ⛔ | — |
| EtherCAT | 🔧 | 分布式时钟同步误差预算 |
| DeviceNet / CANopen | 📋 | 对象字典与心跳 |
| KNX / DALI / M-Bus / HART | 📋 | 楼宇与仪表 |
| 4–20 mA 环路 | 🔧 | 环路阻抗、回路供电余量 |

### A3 存储

| 接口 | 状态 | 说明 |
|---|---|---|
| 片内 Flash | ✅ | `nvm_layout`（分区/对齐/擦写寿命） |
| NOR Flash（直接寻址） | ⚠️ | 同上 |
| NAND Flash | 🔧 | 坏块管理、ECC 强度与位翻转率、写入放大 |
| SPI-NOR | ⚠️ | 与 `nvm_layout` 部分通用；**缺指令集时序** |
| QSPI / OSPI | ✅ | `qspi_flash`（dummy cycle 与频率的关系、读延迟、吞吐） |
| SDRAM / DDR | 🔧 | 刷新、时序参数、带宽预算 |
| NVMe / SATA | ⛔ | — |

### A4 USB

| 接口 | 状态 | 说明 |
|---|---|---|
| USB 2.0 FS / HS | ✅ | `usb_bandwidth`（帧/微帧预算、周期上限与控制保留、高带宽端点、事务开销拆解） |
| USB 3.x | ⛔ | — |
| USB-C / PD | 🔧 | 电源协商档位与电流预算 |
| CDC / HID / MSC / DFU | 📋 | 类协议要点 |

### A5 网络与无线

| 接口 | 状态 | 说明 |
|---|---|---|
| Ethernet MAC/PHY（MII/RMII） | 🔧 | 时钟模式、走线约束 |
| 10BASE-T1S 单对以太网 | 🔧 | 波特率与节点数 |
| PoE | 🔧 | 分级功率与线损 |
| Wi-Fi | 📋 | 吞吐与功耗权衡 |
| BLE | ✅ | `ble_throughput`（逐层开销吞吐与瓶颈归因、广播占空比、连接参数合法性、各 PHY 对比） |
| BT Classic / Mesh | 📋 | — |
| Zigbee / Thread / Matter | 📋 | — |
| LoRa / LoRaWAN | ✅ | `lora_airtime`（Semtech 空中时间公式、EU868 占空比合规、可用发送时长与静默时间） |
| Sub-GHz 私有 | ✅ | `link_budget` |
| NB-IoT / LTE-M | 📋 | — |
| NFC / RFID | 🔧 | 载波与场强、天线匹配 |
| GNSS | 📋 | 冷热启动定位时间 |

### A6 显示 / 摄像头 / 音频

| 接口 | 状态 | 说明 |
|---|---|---|
| LVGL 缓冲与带宽 | ✅ | `lvgl_mem` |
| RGB 并口 | 🔧 | 像素时钟与带宽 |
| 8080 / 6800 并口 | 🔧 | 读写周期与总线占用 |
| MIPI DSI / CSI | 🔧 | lane 数与像素时钟、带宽 |
| LVDS / eDP | 🔧 | 链路速率 |
| DVP 摄像头 | 🔧 | 像素时钟与 FIFO 余量 |
| HDMI | ⛔ | — |

### A7 调试 / 编程 / 固件更新

| 项 | 状态 | 说明 |
|---|---|---|
| Cortex-M 异常分诊 | ✅ | `fault_decode` |
| 其他架构异常（RISC-V / Xtensa / AVR / MSP430…） | 🔧 | 各架构的异常现场格式不同 |
| SWD / JTAG 配置 | 📋 | — |
| Bootloader 跳转与向量表校验 | ✅ | `fw_image` 的 vectors 动作（SP 在 RAM 且 8 字节对齐、复位向量 Thumb 位、VTOR 对齐） |
| 固件镜像校验 | ✅ | `fw_image` 的 hex 动作（Intel HEX 逐条校验和、重叠、空洞、EOF、整镜像 CRC） |
| OTA 与回滚 | 📋 | A/B 分区、断电安全、版本兼容 |
| ISP/IAP 协议 | 📋 | — |

---

## 轴 B：MCU 内部资源

| 项 | 状态 | 形式 |
|---|---|---|
| 时钟树 / PLL | ✅ | `clock_tree`（精确命中的 PLL 组合求解、分频链逐节点校验、串口时钟容错） |
| 晶振负载电容与起振裕量 | 🔧 | CL 计算、负阻裕量需查晶振手册 |
| 中断优先级 / 嵌套 / NVIC | ✅ | `nvic_priority`（分组、抢占判定、延迟上界） |
| DMA 通道与优先级 | 📋 | 与 CPU 争用、带宽预算可工具化 🔧 |
| Cache / MPU 一致性 | 📋 | Cortex-M7 的 DMA 与 cache 经典坑 |
| 链接脚本 / 内存分区 | ⚠️ | `nvm_layout` 覆盖 Flash 侧；**RAM 分区与栈堆未做** 🔧 |
| 栈深度 | ✅ | `stack_depth`（静态上界 + 填充法/水位寄存器实测步骤 + 水印反算） |
| 定时器 / PWM / 输入捕获 | ⚠️ | `sched_analyze` 覆盖节拍；缺 PWM 分辨率与死区 🔧 |
| ADC / DAC | ✅ | `adc_load` |
| 比较器 / 运放 | 📋 | — |
| 低功耗模式与唤醒 | ⚠️ | `power_budget` 是预算；**缺模式切换时序与唤醒延迟** 🔧 |
| 看门狗（独立/窗口） | ✅ | `watchdog_check`（超时求解、最坏喂狗间隔、窗口下限、上电路径） |
| 复位源分析 | 📋 | 与 `fault_decode` 配合 |
| 唯一 ID / OTP / 选项字节 | 📋 | — |
| 安全（读保护 / 加密 / 安全启动 / TrustZone） | 📋 | — |

---

## 轴 C：电气与物理

| 项 | 状态 | 形式 |
|---|---|---|
| 引脚漏电与电平冲突 | ✅ | `leak_pin` |
| 上拉 / 下拉 / 驱动能力 | ✅ | `i2c_bus`（I²C 侧）；其他总线未做 ⚠️ |
| 终端匹配 / 反射 | ⚠️ | `rs232_link` 只提示终端电阻值；**缺阻抗与反射计算** 🔧 |
| 共模范围 / 隔离 / 地电位差 | 🔧 | 收发器共模范围 vs 地电位差 |
| 线长 / 电容 / 阻抗 | ⚠️ | `rs232_link` 按电容折算；缺特性阻抗与传播延迟 🔧 |
| 浪涌 / ESD 保护选型 | 📋 | — |
| 时钟精度与容差 | ⚠️ | `can_timing` 给了 df；**UART/I²C/LIN 侧未做** 🔧 |
| 电源树 / LDO·DCDC 效率 / 纹波 / 上电时序 | ✅ | `power_tree`（逐轨耗散与结温、整树效率、最热轨）；纹波与上电时序仍未覆盖 ⚠️ |
| 热设计（结温 / 热阻） | ✅ | `power_tree`（Tj = Ta + Pd × Rθja、允许功耗） |
| 保护电路（过压 / 过流 / 反接） | 📋 | — |
| EMC / EMI（辐射 / 传导 / 滤波） | ⛔ | 依赖布局与实测，无法纯计算 |

---

## 轴 D：生命周期阶段

| 阶段 | 状态 | 形式 |
|---|---|---|
| 体积与资源预算 | ✅ | `fw_size` |
| 构建 | ✅ | `fw_build` |
| 功耗预算 | ✅ | `power_budget` |
| 调度可行性 | ✅ | `sched_analyze` |
| 存储与掉电安全 | ✅ | `nvm_layout` |
| 调试与故障定位 | ✅ | `fault_decode` |
| 量产：烧录 / 标定 / 序列号 / 测试工装 | 📋 | 测试覆盖率与工装节拍可工具化 🔧 |
| 失效分析 | 📋 | — |
| 器件选型约束核对 | 📋 | — |

---

## 轴 E：软件工程与运行时

| 项 | 状态 | 形式 |
|---|---|---|
| 架构与模块边界 | ✅ | 技能 `architecture-principles` |
| 代码规范 | ✅ | 技能 `code-standards` |
| 代码审查清单 | ✅ | 技能 `embedded-code-review` |
| 并发 / volatile / 原子性 | ⚠️ | 分散在技能里；**缺独立的并发审查清单** 📋 |
| RTOS：优先级反转 / 栈 / tickless | 📋 | — |
| 状态机与多定时器分时 | ✅ | 技能 `scheduling-patterns` |
| 错误处理语义 | ✅ | 技能 `architecture-principles` |
| 调试方法论 | ✅ | 技能 `debug-methodology` |
| 单元测试 / 静态分析 / CI | 📋 | — |

---

## 轴 F：合规与认证

| 项 | 形式 |
|---|---|
| EMC 预测试 | ⛔ |
| 安规与爬电/电气间隙 | 📋 |
| 功能安全 IEC 61508 / ISO 26262 | 📋 |
| 医疗 IEC 62304 | 📋 |
| 车规 AEC-Q100 | 📋 |
| 无线认证 SRRC / FCC / CE | 📋 |

---

## 统计

（"工具候选 🔧"= 尚未实现的建议项。工具总数：**27 个**。）

| 轴 | 已覆盖 | 工具候选 🔧 | 技能候选 📋 | 不适合 ⛔ |
|---|---|---|---|---|
| A 接口与总线 | 22 | 15 | 9 | 9 |
| B MCU 内部 | 6 | 4 | 6 | 0 |
| C 电气物理 | 4 | 3 | 2 | 1 |
| D 生命周期 | 6 | 1 | 3 | 0 |
| E 软件运行时 | 7（技能） | 0 | 4 | 0 |
| F 合规认证 | 0 | 0 | 4 | 6 |

