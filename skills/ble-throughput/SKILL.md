---
name: ble-throughput
description: BLE 连接吞吐、广播占空比与连接参数的规范判定。算逐层开销（LL/L2CAP/ATT）、单包与往返周期、每事件包数与瓶颈归因，判 CI/延迟/超时的合法区间与不等式，算广播事件占空比与 AUX 链，并对比 1M/2M/Coded S2/S8 各 PHY。含随附脚本可直接跑。
whenToUse: 需要算 BLE 吞吐上限、判断连接参数是否合法、估广播占空比、或在各 PHY 之间做取舍时。只要涉及"这组参数能不能跑""实际能到多少 kbps"就用本技能，不要凭印象估。
---

# BLE 吞吐 / 广播 / 连接参数

**本技能自带可执行脚本**，不要手算——公式有多层取整与条件分支，手算必错。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs ble_throughput action=phy encrypted=false
```

入参用 **`key=value`**（首选）。PowerShell 会吃掉命令行里的双引号，所以**不要**直接传 JSON 字符串；参数复杂（嵌套数组/对象）时把 JSON 写进文件再传路径：

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs ble_throughput args.json
```

脚本接受一个参数对象，返回该动作的完整结果（含 `checks` / `warnings` / `notes`）。
脚本本身不复制算法，它直接调用插件里那个已测过的实现，所以数值与工具时代完全一致。

## 四个动作与各自的必填参数

| action | 算什么 | **必填**（没有默认值，缺了直接报错） |
|---|---|---|
| `throughput` | 逐层开销 → 单包时间 → 每事件包数 → LL/L2CAP/ATT 三层吞吐与瓶颈归因 | `phy` `data_len_octets` `encrypted` `conn_interval_ms` |
| `conn-params` | 区间/步进/超时不等式判定 + 最大合法 latency 反解 | `conn_interval_ms` `latency` `supervision_timeout_ms` |
| `adv` | 广播包时间、事件内包起始间隔、advDelay 两端点占空比、AUX 链 | `phy` `adv_interval_ms` `legacy` `channel_count` `adv_data_octets` |
| `phy` | 各 PHY 的包时间 / 空包时间 / 往返周期 / 应用层连续流上限 | `encrypted` |

**三个刻意不设默认值的参数**，因为它们各自改变结果的结构：

- `encrypted` —— 加密连接的数据包多 4 octets MIC（空包 ACK 不带）。没有默认值，必须显式给。
- `legacy` —— legacy 单包 host 数据 ≤ 31 octets；扩展广播每包 ≤ 254、总量 ≤ 1650。两者上限完全不同。
- `channel_count` —— 主广播信道数直接乘进占空比（数据速率只算一份）。

## 必须由你传入、脚本不会替你猜的

- `max_packets_per_event` / `max_event_length_us`：**协议栈设计值**（TX buffer 数与队列深度决定），各栈不同。不给就只按连接间隔算上限，结果会明显偏乐观。
- `att_mtu_octets`：协商到的 ATT_MTU，默认值 23 只是规范默认，实际必须实测。
- DLE 251 不一定协商得到；重传率、RSSI、信道环境都要实测。

## 关键结论（容易记错的地方）

- **MaxTxTime 取 2120 µs，不是规范原文的 2128 µs。** 两者差 8 µs，恰好是 1M PHY 一个前导码 octet；本实现取 2120（有 HCI `MaxTxTime` 0x0848 与 SIG 博客双重支撑），2128 作为已知差异记录，需人工复核。
- **T_IFS = 150 µs**，往返周期里要算两次（发 + 收空包 ACK）。
- **理论值是上界，不是预测值**：假设每个连接事件发满、零丢包、对端秒回空包 ACK、每包装满。实测对照：1M PHY 大间隔约达理论 97%；**Coded S=8 只有约 53%（理论值的 1/1.88）**；2M + 7.5 ms 约 1/1.24。
- **实测低于理论时，绝大多数卡在"每事件实际发几个包"这一层**，不是包时间公式。用嗅探器数 More Data 位，或查 SDK。
- **Coded S=8 的应用层上限 ≈ 1M 的 1/7**；251 octets 在 7.5 ms 间隔下 Coded S=8 连一个包都放不下。
- 连接参数的合法区间：CI 7.5 ms–4 s 步进 1.25 ms；latency 0–499；timeout 100 ms–32 s 步进 10 ms；硬约束 `timeout > (1 + latency) × subrate × interval × 2`。**间隔取包周期的整数倍能白捡吞吐**——这是"间隔调大反而更快"的原因。
- 广播：间隔 20 ms–10.24 s 步进 0.625 ms，实际周期还要加 `advDelay`（每次随机 0–10 ms），所以占空比与速率都是一个**区间**；同一事件内相邻包起始间隔必须 ≤ 10 ms；legacy 广播规范上只能用 1M PHY。
- **连接参数只能"申请"**：脚本判的是规范合法性，对端（手机/网关）是否接受、实际协商到哪个间隔，必须真机抓包确认。

## 输出怎么读

结果里 `checks` 每项形如 `{ name, pass, detail }`：`pass: false` 是判定不通过，`pass: null` 是**没数据、该项被跳过**——两者必须分清，后者不是通过。
`warnings` 是口径提醒（例如"理论值偏乐观"），`notes` 是未计入项与假设。
