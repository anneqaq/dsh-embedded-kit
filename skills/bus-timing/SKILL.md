---
name: bus-timing
description: 总线与线路的时序、电气与协议判定：I²C 上拉区间、SPI 模式与最高时钟、I²S 时钟整除、RS-485/UART 与 Modbus 静默时间、RS-232/422 电气与线长、LIN 调度表、1-Wire 时隙、QSPI dummy cycle。含每项"哪些参数必须查手册/实测"。
whenToUse: 需要算某条总线的时序预算、判上拉电阻或线长是否可行、检查时钟整除性、或核对 1-Wire/LIN 这类固定窗口时。涉及"这条总线能不能跑""采样点对不对""上拉取多少"的问题都用本技能。
---

# 总线时序与线路电气

**本技能自带可执行脚本**，不要手算——这些量大多是多步算术，且极易漏掉手册前提。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs i2c_bus mode=standard cb_pf=200 vdd_v=3.3
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs spi_bus action=mode mode=0
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs rs485_timing baud=115200
```

入参用 `key=value`；参数复杂时写 `.json` 文件再传路径。零参数会让工具自己报缺哪些必填项。

## 八个工具

| 工具名 | 算什么 |
|---|---|
| `i2c_bus` | 上拉区间 `Rp(min)`（灌电流）与 `Rp(max)`（上升时间，可叠加漏电流），判电容是否超规范、区间是否为空 |
| `spi_bus` | CPOL/CPHA 四模式语义、一阶模型估最高 SCK、按帧位数算吞吐 |
| `i2s_clk` | LRCK / BCLK / MCLK 整除性，常见 MCLK 比率 |
| `rs485_timing` | 位/字符时间、发送耗时、Modbus `t1.5` / `t3.5`、DE/RE 方向切换窗口 |
| `rs232_link` | V.28 幅度/门限/摆率/数据率上限 + 按电容折算线长；V.11 差分幅度与终端匹配 |
| `lin_sched` | 每帧位时间、规范最小槽位（×1.4 裕量）、调度表能否装进周期 |
| `onewire_timing` | 标准速率时隙窗口逐项校验（时隙 / 写 1 / 写 0 / 读时隙 / 恢复时间） |
| `qspi_flash` | dummy cycle 与频率的关系、首次数据延迟、随机读/连续读等效吞吐 |

## 必须查手册或实测的参数（脚本不会替你猜）

| 工具 | 必须你给 |
|---|---|
| `rs485_timing` | 收发器 `tPZH` / `tPZL` / `tPHZ` / `tPLZ` —— **不给就列为 pending，不猜** |
| `spi_bus` | 主控 `tV`、从器件 `tSU`/`tH`（各自手册）；最高时钟只是**一阶估计**，最终看示波器波形 |
| `i2c_bus` | 总线总电容（含走线、器件引脚、连接器）；实际上升时间必须用示波器在成品板上量 |
| `rs232_link` | 线缆电容（pF/m）；V.11 的终端电阻与实际差分幅度 |
| `qspi_flash` | Flash 的 `tV`/`tACC`（**必须来自 Flash 手册**） |
| `lin_sched` | 调度表周期与各帧数据长度 |

## 关键结论（容易记错的地方）

- **I²C 上拉**：`Rp(min) = (VDD − VOL) / IOL`、`tr = 0.8473 × Rp × Cb`（NXP UM10204）。**总线电容是硬约束，不是"尽量小"** —— 超规范上限时区间可能直接为空
- **SPI 没有统一时序规范**：模式语义是**确定的定义**（哪个边沿采样、哪个边沿移出），但最高时钟是估计值，`tV`/`tSU` 必须各自查手册
- **I²S 的 MCLK 不是 `fs` 整数倍**会引入周期性采样点漂移；主时钟分不出 BCLK 则根本跑不起来
- **RS-232(V.28) 的长度限制来自线缆电容（上限 2500 pF），不是某个固定米数**；V.11(RS-422/485) 是差分，查幅度下限与终端匹配
- **LIN 帧头固定 34 位**（break 13 + 分隔符 1 + sync 10 + PID 10），每字节按 8N1 计 10 位；规范最小槽位 = 帧时间 × **1.4** 裕量
- **1-Wire 只给标准速率的窗口**（时隙 60~120 µs、写 1 / 读时隙拉低 1~15 µs、恢复 ≥ 1 µs）。**Overdrive 速率窗口窄一个量级且各器件不同，本实现不给那组数** —— 查具体器件手册
- **QSPI 的 dummy 数是频率的函数**：`D × tCLK ≥ tV`，即 dummy 下限 = `ceil(tV × f)`。手册里那句"需要 N 个 dummy"通常带一个前提频率，**换高时钟必须重算**

## 输出怎么读

`checks` 每项形如 `{ name, pass, detail }`；**`pass: null` + `skipped: true` 是"没数据、该项被跳过"，不是通过**。
输出一律是**设计值**：实际上升时间、抖动、位宽必须用示波器/逻辑分析仪实测。
