---
name: pmbus-check
description: PMBus / SMBus 命令层校验：超时与时钟拉伸的实测裕量判定、PEC 覆盖范围与 CRC-8 交叉校验、LINEAR11 / LINEAR16 / DIRECT 双向换算与量化误差。只做命令层，不做电气层。
whenToUse: 需要判 SMBus 超时/时钟拉伸是否合规、PEC 对不上要定位是算法还是覆盖范围、或要把 LINEAR/DIRECT 原始值换成物理量时。
---

# PMBus / SMBus 命令层校验

**本技能自带可执行脚本**，不要手算——PEC 的覆盖范围与 CRC 参数极易记错。

```bash
node {{PLUGIN_ROOT}}/skills/_shared/run-tool.mjs pmbus_check action=pec address7=0x5a read=true command=0x21
```

入参用 `key=value`（PowerShell 会吃掉双引号，别传 JSON 字符串）；参数复杂时写 `.json` 文件再传路径。
返回含 `checks` / `warnings` / `notes`。

## 三个动作

| action | 算什么 | 必填 |
|---|---|---|
| `timing` | SMBus 超时与时钟拉伸逐项裕量 | 实测值（见下） |
| `pec` | PEC 覆盖字节序列 + CRC-8 校验，可选逐字节交叉校验 | `address7`，其余按事务类型 |
| `linear` | LINEAR11 / LINEAR16 / DIRECT 双向换算与量化误差 | `format`，且 `raw` 或 `value` 二选一 |

## timing：25 / 35 ms 不是"典型值的上下限"

- **25 ms 是误触发阈值**：单次低电平超过它，参与传输的器件可以中止并释放总线
- **35 ms 是清除期限**：检测到超时的器件必须在此之前复位通信
- **落在 25~35 ms 的灰区最危险** —— 通信偶发失败且难以复现
- `tLOW:SEXT` 是**整条消息 start→stop 的累计量**；`tLOW:MEXT` 在**每个字节内重新起算**。手册里的"典型拉伸"要按你实际连读多少个字节换算
- 四项输入全是**实测值**，不是手册 typ 值。缺哪一项，对应 check 会被标成 `pass: null, skipped: true` —— **"没数据"和"不通过"必须能区分**
- 想靠主动拉低 SCL 逼对端超时：只有 ≥ 35 ms 才能**确保**逼出，低于此值对端可能判定了超时却没复位完，你随后的 START 它接不住

## pec：覆盖范围比算法更容易错

PEC 覆盖 = `(address7 << 1 | R/W#)` + 命令 + 数据，CRC-8（poly `0x07`、init `0x00`、不反射）。

- **读事务的地址字节出现两次**：`+W` 送命令一次、`+R` 收数据一次。**漏掉第二个是"PEC 一直对不上"的头号原因**
- **Block Read 的 COUNT 字节也算进覆盖**
- Receive Byte / ARA 这类协议没有命令码，读事务的覆盖只剩 `+R` 那一段
- 只比对 CRC 值无法区分"算法不一致"与"覆盖范围不一致"。要定位就传 `observed_bytes`（逻辑分析仪抓到的 PEC 之前全部字节），脚本会逐字节比对并报出**第几个字节起不一致**

## linear：不内置任何器件默认值

- **LINEAR11**：指数 N 与尾数 Y 编码在同一个 16 位字里，两个都不用你给
- **LINEAR16**：N **必须**来自器件 `VOUT_MODE`(0x20) 读回的 Parameter bits[4:0]。本实现**不内置任何默认指数**（器件之间常见 −9 / −13，猜错差几个数量级）。分 ULINEAR16（无符号，`VOUT_COMMAND` 等）与 SLINEAR16（二进制补码，`VOUT_TRIM` / `VOUT_CAL_OFFSET`）
- **DIRECT**：`m` / `b` / `R` 必须来自 `COEFFICIENTS` 命令或器件手册系数表；量化台阶是 `10^−R / m`（**不是 2 的幂**），与 LINEAR16 的 N 不是一回事

缺哪一项就抛错点名，不会替你猜一个"常见值"。

## 边界

本技能只做**命令层**。上拉电阻区间、总线电容、上升时间属电气层，用 `i2c_bus`；CRC 引擎与 PEC 复用同一份参数化实现，不另造一份。

## 输出怎么读

`checks` 每项形如 `{ name, pass, detail, skipped? }`：`pass: false` 是判定不通过，`pass: null` + `skipped: true` 是**没数据、该项被跳过**——后者不是通过。
