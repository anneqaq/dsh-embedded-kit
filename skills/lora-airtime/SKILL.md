---
name: lora-airtime
description: LoRa 空中时间（Semtech 公式，含 LDRO 与显式/隐式包头）与 EU868 占空比合规：各子频段限值、每小时/每天可用发送时长、所需静默时间，以及各 SF 对比。含 polite spectrum access 与占空比是两条互斥路径这个最常被搞错的点。
whenToUse: 需要算某个 SF/BW/载荷的空中时间、判发送周期是否超出 EU868 占空比、估每天能发多少包、或选 SF 做取舍时。
---

# LoRa 空中时间与 EU868 占空比

**本技能自带可执行脚本**，不要手算——公式有多层 `ceil` 与条件分支（LDRO、显式头），手算必错。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs lora_airtime action=airtime sf=12 bw_hz=125000 coding_rate=4/5 preamble_symbols=8 payload_bytes=20 crc=true implicit_header=false
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs lora_airtime action=duty sf=12 bw_hz=125000 coding_rate=4/5 preamble_symbols=8 payload_bytes=20 crc=true implicit_header=false subband=k target_period_sec=600
```

入参用 `key=value`；零参数会让工具报缺参。返回含 `checks` / `warnings` / `notes`。

## 三个动作与必填参数

| action | 算什么 | 必填 |
|---|---|---|
| `airtime` | 单次空中时间：Ts、前导时长、payload 符号数与时长、总空时、总符号数、标称比特率与有效吞吐 | `sf` `bw_hz` `coding_rate` `preamble_symbols` `payload_bytes` `crc` `implicit_header` |
| `duty` | 占空比合规：子频段上限、观察窗内可累计发射秒数、每小时/每天允许包数、最小周期、发完须静默多久 | 同上 + `subband`（或 `subband_override`） |
| `compare` | 逐 SF 列出 Ts、LDRO 实际值与手册要求、payload 符号数、空时（给了子频段还折算每小时包数与最小周期） | 同 `airtime`，用 `sf_list` 代替 `sf` |

## 五个必须显式给的参数（都没有默认值）

- `preamble_symbols`：**LoRaWAN 用 8、Meshtastic 用 16**，它直接改变空中时间
- `crc` / `implicit_header`：改变公式分子里的 `+16` 与 `−20`
- `bw_hz`：**按公式口径必须是 Hz 而不是 kHz**（125 kHz 传 `125000`）
- `ldro`：默认 `auto` 按 Semtech 规则判（符号时长 > 16 ms 强制打开，125 kHz 下即 SF11/SF12）

> **LDRO 收发两端必须一致，否则收不到**。置错时算出的空中时间会偏小 —— 这是最坑的地方。

## EU868 合规：两条互斥路径，不是叠加约束

**`duty-cycle` 与 `polite-spectrum-access` 是二选一的两条合规路径**（EN 300 220-2 §4.4.3.1）：

- 走**占空比**路径：按子频段的占空比上限判
- 走 **polite spectrum access** 路径：按 Table 16 的「单次发射 ≤ 1 s / 对话或轮询序列 ≤ 4 s / 每 200 kHz 每小时累计 ≤ 100 s / 同频点静默 ≥ 100 ms」判，此时**不再受占空比约束**

> **`1 s` / `100 s` 那组限值只在走 polite spectrum access 时才适用，不是 EU868 的通用单次发射上限。** 把它当成通用限值是最常见的误读。

其他要点：

- **占空比统计的是射频实际在线时间，不是公式 ToA**。`extra_overhead_sec` 用来叠加 TX 起振 / PLL 锁定 / PA ramp / SPI 传输 —— **它没有默认值**，不传按 0 计并在 `notes` 里说明（即结果是乐观的）
- **Ton / Toff 不替 868 的 LoRa 子频段编造**：ETSI 对 K/L/M/N/O/P/Q 各段没有规定 Ton/Toff，本实现一律给 `null` 并跳过该判定。要判这条只能由你显式传入所在国家 NRI 的数值
- **不给子频段就不判占空比**（不会替你假设一个默认区域）
- **网络策略与频谱法规分开报**：LoRaWAN 三个强制信道与 TTN Fair Use Policy（30 s/天/节点上行）是网络方策略，与 ETSI 法规是两把尺子，可以各自独立地把方案枪毙

## 输出怎么用，不能怎么用

- 全部是**设计值 / 公式口径的理论值**，不含 TX 起振与真实硬件开销，**不能替代法规符合性测试报告**（占空比须按 §5.4.3 实测）
- 灵敏度、发射功率上限、天线增益必须来自具体器件手册与实测，本实现不内置
- `subband_override` 可以整体覆盖法规参数（频率范围 / e.r.p. / 占空比 / Ton-Toff），判某国 NRI 或私有网络时走它，而不是指望内置值

## 输出怎么读

`checks` 每项形如 `{ name, pass, detail }`；`warnings` 会点名"未给 extra_overhead_sec 所以结果是乐观值"这类口径问题。
