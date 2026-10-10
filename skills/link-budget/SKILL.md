---
name: link-budget
description: 无线链路预算与闭合判定：FSPL、EIRP、扣减明细、余量与达标判定，可反推最大理论距离、做多频段对比。协议中立（Sub-GHz / LoRa / BLE / 2.4G 私有 / NB-IoT 都适用）。所有损耗项与灵敏度必须由你传入。
whenToUse: 需要算链路能否闭合、反推最大距离、比较频段代价，或估算某距离下的接收电平与余量时。任何"这个方案能不能通"的问题都先跑它。
---

# 链路预算与闭合

**本技能自带可执行脚本**，不要手算——扣减项累加与反解距离容易出错，而且手算时你无法保证自己没漏项。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs link_budget action=budget frequency_hz=868000000 distance_m=1000 tx_power_dbm=14 rx_sensitivity_dbm=-137
```

入参用 `key=value`；扣减项是数组，属复杂参数，写 `.json` 文件再传路径。
返回含 `checks` / `warnings` / `notes`。

## 四个动作

| action | 算什么 | 必填 |
|---|---|---|
| `budget` | 链路闭合：FSPL、EIRP、扣减明细、P_rx、余量 + 两层判定 | `frequency_hz` `distance_m` |
| `distance` | 反推最大理论距离 | `frequency_hz` `tx_power_dbm` `rx_sensitivity_dbm` |
| `fspl` | 只算该点位的路径损耗 | `frequency_hz` `distance_m` |
| `bands` | 同距离多频段 FSPL 与代价对比 | `distance_m` `frequencies_hz` |

## 核心关系

```
FSPL(dB) = 20·log10(d_m) + 20·log10(f_Hz) + 20·log10(4π/c)
         = 20·log10(d_m) + 20·log10(f_Hz) − 147.552217
P_rx     = P_tx + G_tx + G_rx − FSPL − Σ(扣减)
余量      = P_rx − 灵敏度
```

`20·log10(4π/c) = −147.552217` 就是文献里写作 −147.55 的那个常数。

## 最容易被静默搞错的两件事

**① 单位必须是 SI。** 距离传**米**、频率传**赫兹**：868 MHz 传 `868000000`，5 km 传 `5000`。
把 MHz 当 Hz 传会静默偏约 120 dB —— 工具内**不做单位猜测**，也不替你换算。

**② 扣减项必须你给全，工具不内置任何默认值。** 键名是固定的八个：

`txCableDb`（发射侧线缆/接头/滤波器）、`rxCableDb`、`fadeMarginDb`（多径/阴影/雨衰/大气）、`bodyLossDb`（体损耗/手持遮挡）、`mismatchLossDb`（由实测 S11 换算）、`polarizationLossDb`、`temperatureDriftDb`、`additionalDb`。

- **没传的项计 0，并逐项写进 `notIncluded` 与 `notes` 点名** —— 必须回头看这个列表
- **拼错的键名会被直接拒绝**，不会静默忽略。这是刻意的：静默丢弃一个拼错的键，等于凭空多出几 dB 余量，而这种错在结果里看不出来
- 线缆插损、失配、极化、温漂**必须查厂家数据或实测**；衰落余量按环境与目标可用度定（文献参考：城区蜂窝 99.9% 约 8–12 dB，室内 WLAN 10–15 dB，地面微波 99.99% 约 30–40 dB —— 是参考，不是默认值）

**灵敏度也必须取自器件手册或实测**：同一芯片不同 SF / BW / 速率可差几十 dB。不给就没有余量（`marginDb` 为 null），也没有"链路能通"的判定。
**要求余量 `required_margin_db` 同样要你给**：不给就只判"余量是否为正"，不判"是否达标"。

## 结果怎么用，以及不能怎么用

- 两层判定要分清：**余量 > 0（能闭合）** 与 **余量 ≥ 你要求的余量（达标）** 是两件事
- **FSPL 只含几何扩散**：不含地形、绕射、多径、遮挡、植被、穿墙、雨衰、大气吸收。它是路径损耗的**下限**，所以任何 `d_max` 都是**乐观上限**
- 真实可用距离必须现场拉距实测。要修正就上 ITU-R P.526 / P.833 / P.1411 这类模型
- 给了最大天线尺寸才会按 `d > 2D²/λ` 判远场；落在远场起点以内时 FSPL 不成立，结果没有物理意义
- `bands` 动作下所有扣减对所有频段用**同一个值**，而线缆插损本身随频率变 —— 做正式频段对比要按各频段分别查表

## 输出怎么读

`checks` 每项形如 `{ name, pass, detail }`；`notIncluded` 列出**未计入的扣减项**；`assumptions` 里会显式声明"未传增益按 0 dBi 计入"这类默认行为。
