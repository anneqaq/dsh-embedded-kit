/**
 * `ble_throughput` 工具描述符 —— 把 lib/ble.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**，不复制、不改写 lib/ble.js 的任何算法、常量或出处登记。
 * 规范出处（Core Spec Vol 6 Part B / Vol 4 Part E、SIG 博客、Silabs、Memfault、Goodix、
 * Ezurio、EnGenius）全部留在 lib/ble.js 的文件头；本文件只把少数几条关键结论搬进
 * 工具描述与告警文案（2128 vs 2120 的 8 µs 差异、理论值 vs 实测的偏离）。
 *
 * 四个动作对应 lib 里的四组入口：
 *   throughput  → analyzeThroughput（逐层开销 → 包时间 → 每事件包数 → 三层吞吐与瓶颈定位）
 *   conn-params → checkConnectionParams（区间 / 步进 / timeout 不等式 / latency 反解）
 *   adv         → analyzeAdvertising（包时间、事件内包起始间隔、advDelay 两端点占空比与速率、AUX 链）
 *   phy         → comparePhys（各 PHY 的包时间 / 空包时间 / 往返周期 / 应用层连续流上限）
 *
 * 返回值一律含 `checks` / `warnings` / `notes`（形状与 lib/i2c.js 一致），
 * 具体数值挂在该动作的分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/ble.tool
 */

import {
  ADV_DELAY_MAX_MS,
  ADV_INTERVAL,
  analyzeAdvertising,
  analyzeThroughput,
  BLE_PHY_IDS,
  checkConnectionParams,
  comparePhys,
  CONN_INTERVAL,
  CONN_LATENCY,
  DEFAULT_ATT_MTU_OCTETS,
  DLE_MAX_PAYLOAD_OCTETS,
  DLE_MIN_PAYLOAD_OCTETS,
  HCI_MAX_TX_TIME_US,
  HCI_MIN_TX_TIME_US,
  MAX_ATT_MTU_OCTETS,
  PRIMARY_ADV_CHANNELS,
  SPEC_PACKET_TIME_BOUNDS_US,
  SUPERVISION_TIMEOUT,
  T_IFS_US,
} from '../lib/ble.js'

/** 可用的动作。 */
const ACTIONS = ['throughput', 'conn-params', 'adv', 'phy']

/** 广播响应类型：none 表示不需要在每包后监听 SCAN_REQ / CONNECT_IND。 */
const ADV_RESPONSE_KINDS = ['none', 'scanReq', 'connectInd']

/**
 * 校验一组参数是否都给全了，缺谁一次性点名。
 *
 * **不补默认值**：是否加密（决定有没有 4 octets MIC）、legacy 与否（数据上限不同）、
 * 广播信道数（直接乘进占空比）都由调用方给出——替调用方猜一个"常见值"正是本模块要防的事。
 *
 * @param {object} args - 工具入参。
 * @param {string[]} names - 必须出现的参数名。
 * @param {string} action - 动作名，用于报错文案。
 * @throws {Error} 缺参数时抛出。
 */
function requireArgs(args, names, action) {
  const missing = names.filter((n) => args[n] === undefined || args[n] === null)
  if (missing.length === 0) return
  throw new Error(
    `action=${action} 需要 ${missing.join(' / ')}。` +
      '这些量全部由调用方给出：加密与否决定数据包多不多 4 octets MIC，legacy 与扩展广播的数据上限不同，' +
      '广播信道数直接乘进占空比——本工具不会替你假设。',
  )
}

/**
 * 千比特每秒格式化。
 *
 * @param {number} bps - 比特每秒。
 * @returns {string} 形如 `780.8 kbps`。
 */
function kbps(bps) {
  return `${(bps / 1000).toFixed(1)} kbps`
}

/* ------------------------------------------------------------------ */
/* 动作 1：throughput（逐层开销 → 每事件包数 → 三层吞吐与瓶颈）             */
/* ------------------------------------------------------------------ */

/**
 * 连接吞吐与瓶颈定位：走 lib 的 analyzeThroughput。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runThroughput(args) {
  requireArgs(args, ['phy', 'data_len_octets', 'encrypted', 'conn_interval_ms'], 'throughput')
  const r = analyzeThroughput({
    phy: args.phy,
    dataLenOctets: args.data_len_octets,
    encrypted: args.encrypted,
    connIntervalMs: args.conn_interval_ms,
    attMtuOctets: args.att_mtu_octets,
    maxEventLengthUs: args.max_event_length_us,
    maxPacketsPerEvent: args.max_packets_per_event,
  })
  return { action: 'throughput', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 2：conn-params（连接参数合法性）                                  */
/* ------------------------------------------------------------------ */

/**
 * 连接参数合法性：走 lib 的 checkConnectionParams。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runConnParams(args) {
  requireArgs(args, ['conn_interval_ms', 'latency', 'supervision_timeout_ms'], 'conn-params')
  const r = checkConnectionParams({
    connIntervalMs: args.conn_interval_ms,
    latency: args.latency,
    supervisionTimeoutMs: args.supervision_timeout_ms,
    subrateFactor: args.subrate_factor,
    vendorTimeoutFactor: args.vendor_timeout_factor,
  })
  return { action: 'conn-params', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 3：adv（广播占空比与数据速率）                                    */
/* ------------------------------------------------------------------ */

/**
 * 广播占空比：走 lib 的 analyzeAdvertising。
 *
 * `expect_response_kind` 把"是否要监听对端包"与"监听哪一种"合成一个开关，
 * 免得出现 `expect_response=true` 却没给 `response_kind` 的半个状态。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runAdv(args) {
  requireArgs(args, ['phy', 'adv_interval_ms', 'legacy', 'channel_count', 'adv_data_octets'], 'adv')
  const kind = args.expect_response_kind ?? 'none'
  if (!ADV_RESPONSE_KINDS.includes(kind)) {
    throw new Error(`expect_response_kind 只能是 ${ADV_RESPONSE_KINDS.join(' / ')}，收到 ${JSON.stringify(kind)}`)
  }
  const r = analyzeAdvertising({
    phy: args.phy,
    advIntervalMs: args.adv_interval_ms,
    legacy: args.legacy,
    channelCount: args.channel_count,
    advDataOctets: args.adv_data_octets,
    expectResponse: kind !== 'none',
    responseKind: kind === 'none' ? undefined : kind,
    extHeaderOctets: args.ext_header_octets,
    hostDataTotalOctets: args.host_data_total_octets,
    auxPhy: args.aux_phy,
  })
  return { action: 'adv', expectResponseKind: kind, ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 4：phy（各 PHY 对比）                                           */
/* ------------------------------------------------------------------ */

/**
 * 各 PHY 的包时间 / 空包 / 往返周期 / 应用层连续流上限对比。
 *
 * lib 的 `comparePhys` 返回的是**数组**（本身没有 checks / warnings / notes），
 * 所以这里在包装层补上判定与说明，保持四个动作的输出形状一致。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runPhy(args) {
  requireArgs(args, ['encrypted'], 'phy')
  const encrypted = args.encrypted
  const dataLenOctets = args.data_len_octets ?? DLE_MAX_PAYLOAD_OCTETS
  const rows = comparePhys(encrypted, dataLenOctets)
  const byId = Object.fromEntries(rows.map((r) => [r.phy, r]))

  const checks = []
  const warnings = []
  const notes = []

  const oneM = byId['le-1m']
  const twoM = byId['le-2m']
  const s8 = byId['le-coded-s8']

  checks.push({
    name: '2M 的往返周期短于 1M（2 Msym/s 是有效提速）',
    pass: twoM.cycleUs < oneM.cycleUs,
    detail: `2M ${twoM.cycleUs.toFixed(0)} µs < 1M ${oneM.cycleUs.toFixed(0)} µs（同一 ${dataLenOctets} octets 载荷）`,
  })

  // Coded S=8 是 1 bit → 8 symbols，速率与吞吐都该落在 1M 的 1/7 附近。
  const ratioTo1M = s8.ceilingAppBps / oneM.ceilingAppBps
  checks.push({
    name: 'Coded S=8 的应用层连续流上限 ≈ 1M 的 1/7',
    pass: Math.abs(ratioTo1M - 1 / 7) <= (1 / 7) * 0.06,
    detail:
      `S=8 ${kbps(s8.ceilingAppBps)} / 1M ${kbps(oneM.ceilingAppBps)} = ${ratioTo1M.toFixed(3)}` +
      '（1/7 = 0.143；比值略低于 1/7 是因为 Coded 的前导码 80 符号把固定开销抬高了）',
  })

  checks.push({
    name: '空包 ACK 时间只随调制速率变',
    pass: oneM.emptyPacketUs === 80 && twoM.emptyPacketUs === 44 && s8.emptyPacketUs === 720,
    detail: `1M ${oneM.emptyPacketUs} / 2M ${twoM.emptyPacketUs} / Coded S=8 ${s8.emptyPacketUs} µs`,
  })

  notes.push(
    '表里的 PHY 速率（1000 / 2000 / 500 / 125 kbps）是**空口调制速率**，' +
      '`ceilingAppBps` 是应用层上限（已扣掉 L2CAP 4 + ATT 3 的开销，按 244 octets/包算），两者不要混用。',
  )
  notes.push(
    'Coded PHY 的符号率恒为 1 Msym/s，降速完全靠重复编码（S=2 → 500 kbps，S=8 → 125 kbps）；' +
      '前导码 80 symbols 不参与编码，所以包越短、Coded 的相对开销越大。',
  )
  notes.push(
    '`ceilingAppBps` 假设"间隔长到每事件发满、零丢包、对端秒回空包 ACK"，是**上界**；' +
      '实际吞吐还要乘上每个连接事件真正塞进去的包数比例（见 action=throughput）。',
  )

  if (s8.cycleUs > 7500) {
    warnings.push(
      `Coded S=8 在 ${dataLenOctets} octets 下的往返周期 ${s8.cycleUs.toFixed(0)} µs 已超过最小连接间隔 7.5 ms：` +
        '这个组合在 7.5 ms 间隔下一个包都放不下，必须放长间隔或缩短数据长度。',
    )
  }

  return {
    action: 'phy',
    encrypted,
    dataLenOctets,
    rows,
    checks,
    warnings,
    notes,
  }
}

/* ------------------------------------------------------------------ */
/* 分派                                                                */
/* ------------------------------------------------------------------ */

/** 动作 → 实现。 */
const RUNNERS = {
  throughput: runThroughput,
  'conn-params': runConnParams,
  adv: runAdv,
  phy: runPhy,
}

/**
 * 同步分派。`execute` 只是它的 async 外壳。
 *
 * 单独导出是为了让自测能在**同步**用例里覆盖每个动作分支（含未知 action 的报错），
 * 而不必依赖宿主 test 实现是否 await 返回的 Promise。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 * @throws {Error} action 未知时抛出。
 */
export function dispatch(args) {
  const action = args.action ?? 'throughput'
  const runner = RUNNERS[action]
  if (!runner) throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
  return runner(args)
}

/* ------------------------------------------------------------------ */
/* summaryLines：各动作的具体数值行                                      */
/* ------------------------------------------------------------------ */

/**
 * throughput 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function throughputLines(v) {
  const lines = [
    `  ${v.phyLabel}，数据长度 ${v.dataLenOctets} octets（LL 载荷），ATT_MTU ${v.attMtuOctets}`,
    `  单包 ${v.dataPacketUs.toFixed(0)} µs + T_IFS ${T_IFS_US} + 空包 ACK ${v.ackPacketUs.toFixed(0)} µs + ` +
      `T_IFS ${T_IFS_US} = **往返 ${v.cycleUs.toFixed(0)} µs**`,
    `  连接间隔 ${v.connIntervalMs} ms = ${v.intervalUs.toFixed(0)} µs → 每事件 **${v.packetsPerEvent} 包**，` +
      `填充率 ${(v.eventFillRatio * 100).toFixed(1)}%（占用 ${(v.eventBusyUs / 1000).toFixed(3)} ms）`,
    `  吞吐：LL 载荷 ${kbps(v.throughput.llPayloadBps)} / L2CAP SDU ${kbps(v.throughput.l2capSduBps)} / ` +
      `**ATT 应用 ${kbps(v.throughput.attAppBps)}**（每包 ${v.appOctetsPerPacket.toFixed(1)} octets 有效）`,
    `  瓶颈层：${v.bottleneckLayer}（损失 ${(v.bottleneckLoss * 100).toFixed(1)}%）；` +
      `三层损失 物理层 ${(v.losses.phy * 100).toFixed(1)}% / 每事件包数 ${(v.losses.packetsPerEvent * 100).toFixed(1)}% / ` +
      `MTU ${(v.losses.mtu * 100).toFixed(1)}%`,
  ]
  if (v.packetsByStackCap !== null && v.packetsByStackCap !== undefined) {
    lines.push(`  协议栈每事件发包上限（设计值，调用方给的）=${v.packetsByStackCap}`)
  }
  return lines
}

/**
 * conn-params 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function connParamsLines(v) {
  const lines = [
    `  连接间隔 ${v.connIntervalMs} ms / Slave Latency ${v.latency} / 监督超时 ${v.supervisionTimeoutMs} ms` +
      `（subrate ×${v.subrateFactor}）`,
    `  跳过窗口 = (1 + ${v.latency}) × ${v.subrateFactor} × ${v.connIntervalMs} ms = **${v.peripheralSilenceWindowMs} ms**`,
    `  规范硬约束：timeout > 2 × 跳过窗口 = **${v.minRequiredTimeoutMs} ms**，实际 ${v.supervisionTimeoutMs} ms`,
    `  最大合法 Slave Latency（反解）= **${v.maxLegalLatency}**；最坏自报间隔 ${v.worstCaseResponseIntervalMs} ms`,
    `  判定：**${v.legal ? '合法' : '不合法'}**（本函数只判规范可判定项）`,
  ]
  return lines
}

/**
 * adv 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function advLines(v) {
  const lines = [
    `  ${v.legacy ? 'legacy' : '扩展'} 广播 / ${v.phyLabel} / ${v.channelCount} 个主广播信道 / ` +
      `间隔 ${v.advIntervalMs} ms（+ advDelay 0–${ADV_DELAY_MAX_MS} ms 随机抖动）`,
    `  单包 ${v.packetUs.toFixed(0)} µs（PDU 载荷 ${v.pduPayloadOctets} octets）` +
      (v.listenUs > 0 ? `，每包后再监听 ${v.listenUs.toFixed(0)} µs（T_IFS + 对端包）` : ''),
    `  事件占用：TX ${v.eventTxUs.toFixed(0)} µs` +
      (v.eventRadioOnUs === v.eventTxUs ? '' : `，射频在线 ${v.eventRadioOnUs.toFixed(0)} µs`),
    `  TX 占空比 **${v.duty.advDelay0Ms.txDutyPercent.toFixed(3)}%–${v.duty.advDelayMaxMs.txDutyPercent.toFixed(3)}%**` +
      `（advDelay=0 → ${v.duty.advDelay0Ms.periodMs} ms 周期；advDelay=${ADV_DELAY_MAX_MS} → ${v.duty.advDelayMaxMs.periodMs} ms）`,
    `  数据速率 ${v.throughput.dataRateBpsAt0.toFixed(0)}–${v.throughput.dataRateBpsAtMax.toFixed(0)} bps` +
      `（每事件 ${v.perEventDataOctets} octets；占空比按 ${v.channelCount} 份算，速率只算一份）`,
  ]
  if (v.aux) {
    lines.push(
      `  AUX 链：${v.aux.chainPackets} 包 × ${v.aux.auxPacketUs.toFixed(0)} µs = ${v.aux.chainUs.toFixed(0)} µs（${v.aux.phy}）`,
    )
  }
  return lines
}

/**
 * phy 的逐 PHY 数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function phyLines(v) {
  const lines = [
    `  数据长度 ${v.dataLenOctets} octets，加密 ${v.encrypted ? '是（+4 octets MIC）' : '否'}；周期 = 包 + T_IFS 150 + 空包 ACK + T_IFS 150`,
    '  PHY             调制速率   数据包 µs   空包 µs   往返 µs   应用层连续流上限',
  ]
  for (const r of v.rows) {
    lines.push(
      `  ${r.phy.padEnd(14)}${`${(r.bitRateBps / 1000).toFixed(0)} kbps`.padStart(9)}` +
        `${r.packetUs.toFixed(0).padStart(11)}${r.emptyPacketUs.toFixed(0).padStart(10)}` +
        `${r.cycleUs.toFixed(0).padStart(10)}${kbps(r.ceilingAppBps).padStart(19)}`,
    )
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
  name: 'ble_throughput',
  title: 'BLE 连接吞吐 / 广播占空比 / 连接参数合法性（Core Spec 逐层开销模型）',
  description:
    '算 BLE（低功耗蓝牙）的连接吞吐、广播占空比、连接参数合法性与各 PHY 对比。' +
    '模型出自 Bluetooth Core Spec Vol 6 Part B（Link Layer，包格式与 T_IFS）与 Vol 4 Part E（HCI 参数区间），' +
    '数字对照 SIG 博客、Silicon Labs、Memfault、Goodix、Ezurio 与 EnGenius 实测表（**出处全在 lib/ble.js 文件头**）。' +
    '四个动作：' +
    '① action=throughput：给 phy（le-1m / le-2m / le-coded-s2 / le-coded-s8）、data_len_octets（27–251）、encrypted（是否加密，决定有没有 4 octets MIC）、conn_interval_ms，' +
    '可选 att_mtu_octets（默认 23）、max_event_length_us、max_packets_per_event（这两项是**协议栈设计值，必须实测或查 SDK**）。' +
    '返回逐层开销（ATT 3 / L2CAP 4 / LL 头 2 + MIC 4 / CRC 3 / 前导码 + AA + 两个 T_IFS 150 µs + 空包 ACK）、单包时间、往返周期、每事件包数与填充率、' +
    'LL 载荷 / L2CAP SDU / ATT 应用三层吞吐（bps 与 kbps），并把瓶颈定位到 phy / packetsPerEvent / mtu 三层、给出各自损失比。' +
    '② action=conn-params：给 conn_interval_ms、latency、supervision_timeout_ms，可选 subrate_factor、vendor_timeout_factor。' +
    '按规范的区间与步进（CI 7.5 ms–4 s 步进 1.25 ms、latency 0–499、timeout 100 ms–32 s 步进 10 ms）逐条判定，' +
    '并检查硬约束 timeout > (1 + latency) × subrate × interval × 2，反解最大合法 latency，给出从机的跳过窗口与最坏自报间隔。' +
    '③ action=adv：给 phy、adv_interval_ms（20 ms–10.24 s）、legacy（true / false）、channel_count（1–3）、adv_data_octets，' +
    '可选 expect_response_kind（none / scanReq / connectInd）、ext_header_octets、host_data_total_octets、aux_phy。' +
    '返回广播包时间、事件内相邻包起始间隔是否 ≤ 10 ms、advDelay 取 0 与 10 ms 两个端点时的 TX 占空比与射频在线占空比、数据速率，' +
    '扩展广播还会算 AUX 链的包数、链时长与是否装得进一个广播事件。' +
    '④ action=phy：给 encrypted，可选 data_len_octets（默认 251）。逐个 PHY 列出数据包时间、空包时间、往返周期与应用层连续流上限，并校验 S=8 ≈ 1M 的 1/7。' +
    '返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 每项形如 { name, pass, detail }）。' +
    '硬约束（请如实对待）：' +
    '（1）**encrypted / legacy / channel_count 没有默认值**：加密与否决定数据包多不多 4 octets MIC，legacy 与扩展广播的数据上限不同，广播信道数直接乘进占空比——缺任一项会直接报错，本工具不替你假设。' +
    '（2）**MaxTxTime 取 2120 µs，而不是规范 §2.1 原文的 2128 µs**：规范原文说未编码包最大 2128 µs，' +
    '而逐字节模型与 HCI MaxTxTime（0x0848）都给出 2120 µs，两者差 8 µs——恰好是 1M PHY 一个前导码 octet。' +
    '两处原文都没有解释这个差异；本模块取 2120（有 HCI 与 SIG 博客双重支撑），把 2128 作为已知差异记录，需人工复核。' +
    '（3）**理论值是上界，不是预测值**：吞吐结果假设"每个连接事件都发满、零丢包、对端秒回空包 ACK、每包都装满"。' +
    '与真实硅片实测对照（EnGenius 白皮书）：1M PHY 在大间隔下实测约为理论的 1/1.03（达 97%），说明包时间模型是对的；' +
    '而 Coded S=8 只有 1/1.88（实测约 53%，长包更容易被干扰打断、重传代价也大），2M + 7.5 ms 约 1/1.24（栈每事件发不满）。' +
    '**实测低于理论值时，绝大多数情况卡在"每事件实际发几个包"这一层**，而不是包时间公式。' +
    '（4）**max_packets_per_event 与 max_event_length_us 是设计值**：协议栈每事件实际发包数由 TX buffer 数与队列深度决定，' +
    '各栈不同，必须用嗅探器数 More Data 位或查 SDK 文档；不给这两项时只按连接间隔算上限，理论吞吐会明显偏乐观。' +
    '（5）不内置任何厂商默认值：实际协商到的 DLE（251 不一定给）、ATT_MTU、重传率、RSSI / 信道环境都必须实测；' +
    '本工具只算航空信道上的设计值，不含协议栈调度、重传与功耗。' +
    '（6）连接参数只能"申请"：本工具判的是规范合法性，对端（手机 / 网关）是否接受、实际协商到哪个连接间隔，必须在真机上抓包确认。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ACTIONS,
      description:
        'throughput=连接吞吐与瓶颈定位（需 phy / data_len_octets / encrypted / conn_interval_ms）；' +
        'conn-params=连接参数合法性（需 conn_interval_ms / latency / supervision_timeout_ms）；' +
        'adv=广播占空比（需 phy / adv_interval_ms / legacy / channel_count / adv_data_octets）；' +
        'phy=各 PHY 对比（需 encrypted）。',
    },
    phy: {
      type: 'string',
      enum: BLE_PHY_IDS,
      description:
        `PHY：${BLE_PHY_IDS.join(' / ')}。le-coded-s2 = 500 kbps、le-coded-s8 = 125 kbps（符号率恒 1 Msym/s，靠重复编码降速）。` +
        'throughput 与 adv 必填。**legacy 广播在规范上只能用 le-1m**，给别的值会被 lib 记一条 warning。',
    },
    data_len_octets: {
      type: 'integer',
      description:
        `LL 载荷 octets，规范 DLE 区间 ${DLE_MIN_PAYLOAD_OCTETS}–${DLE_MAX_PAYLOAD_OCTETS}（**不含** 2 octets 的 LL 头与 3 octets 的 CRC）。` +
        'throughput 必填；phy 不给时默认 251。注意它是 PHY 层长度：ATT_MTU 通常等于它减 4。',
    },
    encrypted: {
      type: 'boolean',
      description:
        '连接是否加密。**没有默认值**——加密连接的数据包多 4 octets MIC（空包 ACK 不带 MIC），' +
        '直接改变包时间与吞吐。throughput 与 phy 必填，必须显式写 true / false。',
    },
    conn_interval_ms: {
      type: 'number',
      description:
        `连接间隔（ms）。规范区间 ${CONN_INTERVAL.minMs}–${CONN_INTERVAL.maxMs} ms、步进 ${CONN_INTERVAL.stepMs} ms。` +
        'throughput 用它算每事件包数，conn-params 用它判合法性。**间隔取包周期的整数倍能白捡吞吐**——这是"间隔调大反而更快"的原因。',
    },
    att_mtu_octets: {
      type: 'integer',
      description:
        `协商到的 ATT_MTU，默认规范默认值 ${DEFAULT_ATT_MTU_OCTETS}。它的理论上限 = LL 载荷 − 4（251 → 247），` +
        `常见上限 ${MAX_ATT_MTU_OCTETS} 是推导值（512 字节长属性值 + 5 字节 ATT 开销）。` +
        'MTU 与 DLE 不匹配时，缺口全落在"最后一个分片装不满"上——这是最容易被忽略的一层损耗。仅 throughput 有效。',
    },
    max_event_length_us: {
      type: 'integer',
      description:
        '**协议栈**允许的最大连接事件长度（µs）。**没有默认值，属设计值**（如某些 Nordic 栈默认 7.5 ms，可配到几十 ms）。' +
        '不给就只按连接间隔算上限并记一条 notes。仅 throughput 有效。',
    },
    max_packets_per_event: {
      type: 'integer',
      description:
        '**协议栈**每个连接事件最多发几个包（由 TX buffer 数与队列深度决定）。**没有默认值，这是最常见的实测瓶颈**：' +
        '不给它，理论吞吐可能高估数倍（Memfault 的例子：15 ms 间隔理论可发 21 个 27 octets 包，iOS 栈只发 7 个）。' +
        '请在嗅探器上数 More Data 位，或查 SDK 文档。仅 throughput 有效。',
    },
    latency: {
      type: 'integer',
      description:
        `Slave Latency（connPeripheralLatency），可跳过的连接事件数，规范 ${CONN_LATENCY.min}–${CONN_LATENCY.max}。` +
        '**它不降低吞吐**（有数据时照样一到事件就回），只降低空闲时的唤醒次数。conn-params 必填。',
    },
    supervision_timeout_ms: {
      type: 'number',
      description:
        `监督超时（ms）。规范 ${SUPERVISION_TIMEOUT.minMs}–${SUPERVISION_TIMEOUT.maxMs} ms、步进 ${SUPERVISION_TIMEOUT.stepMs} ms，` +
        '且必须满足 timeout > (1 + latency) × subrate × interval × 2。太短会假断连，太长则设备走远后要等很久才发现。conn-params 必填。',
    },
    subrate_factor: {
      type: 'integer',
      description:
        '连接子速率因子（Connection Subrating，Core 5.3+），普通连接为 1、也是默认值。' +
        '它会等比放大从机的"跳过窗口"，从而抬高 timeout 下限。仅 conn-params 有效。',
    },
    vendor_timeout_factor: {
      type: 'number',
      description:
        '可选的**厂商余量系数**（如手机厂商常要求 timeout ≥ 3 × 跳过窗口）。规范只要求 2 ×；' +
        '**没有默认值**，不给就不判这一条（本工具不替你编造某个厂商的推荐值）。仅 conn-params 有效。',
    },
    adv_interval_ms: {
      type: 'number',
      description:
        `广播间隔（ms）。规范区间 ${ADV_INTERVAL.minMs}–${ADV_INTERVAL.maxMs} ms、步进 ${ADV_INTERVAL.stepMs} ms。` +
        '实际周期还要加上 advDelay（每次随机 0–10 ms），所以占空比与速率都是一个区间。adv 必填。',
    },
    legacy: {
      type: 'boolean',
      description:
        '是否 legacy 广播。**没有默认值**——legacy 单包 host 数据上限 31 octets，扩展广播每包 254、总量 1650，两者数据上限完全不同。adv 必填。',
    },
    channel_count: {
      type: 'integer',
      description:
        `广播用几个主广播信道（1–3，来自 channel map）。**没有默认值**：同一份数据在每个信道上各发一遍，` +
        `${PRIMARY_ADV_CHANNELS.map((c) => `${c.index}(${c.mhz} MHz)`).join(' / ')}——` +
        '占空比按信道数翻倍，但数据速率只算一份。adv 必填。',
    },
    adv_data_octets: {
      type: 'integer',
      description:
        '单个包里 host 广播数据 octets。legacy 上限 31（AdvA 6 + AdvData ≤ 31 → PDU 载荷 ≤ 37）；' +
        '扩展广播每包上限 254。adv 必填。',
    },
    expect_response_kind: {
      type: 'string',
      enum: ADV_RESPONSE_KINDS,
      description:
        '默认 none。scanReq / connectInd 表示主动扫描或可连接广播：每发完一包还要留 T_IFS + 对端包时间的监听窗，' +
        '射频在线占空比随之上升（SCAN_REQ 载荷 12 octets，CONNECT_IND 34 octets，都是规范字段大小）。仅 adv 有效。',
    },
    ext_header_octets: {
      type: 'integer',
      description:
        '扩展广播的扩展头 octets。**没有默认值，属设计细节**（随含哪些字段而变），legacy=false 时必填，缺了会报错。' +
        'PDU 载荷 = 扩展头 + 数据，不得超过 255。仅 adv 有效。',
    },
    host_data_total_octets: {
      type: 'integer',
      description:
        '扩展广播 host 侧数据总量（≤ 1650 octets）。给了就按"每包 ≤ 254"折出 AUX 链的包数与链时长，' +
        '并检查这条链能不能在下一个广播事件前结束。仅 adv 有效。',
    },
    aux_phy: {
      type: 'string',
      enum: BLE_PHY_IDS,
      description:
        'AUX 包（扩展广播的数据实际上走副信道）使用的 PHY。不给就按与主信道同 PHY 计算并在 notes 里说明——' +
        '实际可选 1M / 2M / Coded，属设计选择。仅 adv 有效。',
    },
  },
  /**
   * 按 action 分派到 lib/ble.js 的对应函数。
   *
   * @param {object} args - 模型传入的参数。
   * @returns {Promise<object>} 含 checks / warnings / notes 的结果。
   */
  async execute(args) {
    return dispatch(args)
  },
  /**
   * 供渲染层展示的具体数值行。
   *
   * @param {object} v - execute 的返回值。
   * @returns {string[]} 文本行。
   */
  summaryLines(v) {
    if (!v || typeof v !== 'object') return []
    if (v.action === 'throughput') return throughputLines(v)
    if (v.action === 'conn-params') return connParamsLines(v)
    if (v.action === 'adv') return advLines(v)
    if (v.action === 'phy') return phyLines(v)
    return []
  },
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测与文档使用：本工具支持的动作。 */
export const TOOL_ACTIONS = ACTIONS

/** 供自测使用：lib 里被本工具用到的函数，便于确认映射完整。 */
export const MAPPED_FUNCTIONS = {
  throughput: [analyzeThroughput],
  'conn-params': [checkConnectionParams],
  adv: [analyzeAdvertising],
  phy: [comparePhys],
}

/** 供自测与文档使用：工具层直接引用的规范常量（都在 lib 里，这里只是转出）。 */
export const TOOL_CONSTANTS = {
  phys: BLE_PHY_IDS,
  tIfsUs: T_IFS_US,
  advDelayMaxMs: ADV_DELAY_MAX_MS,
  hciTxTimeUs: { min: HCI_MIN_TX_TIME_US, max: HCI_MAX_TX_TIME_US },
  specPacketTimeBoundsUs: SPEC_PACKET_TIME_BOUNDS_US,
}
