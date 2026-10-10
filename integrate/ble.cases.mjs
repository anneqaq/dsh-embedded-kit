/**
 * `ble_throughput` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './ble.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 用例全部是**同步**的，走 integrate/ble.tool.mjs 导出的 `dispatch`（execute 的同步内核），
 * 这样不依赖宿主 test 实现是否 await。用例只读，不修改 lib 中任何东西。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 覆盖的东西
 * ─────────────────────────────────────────────────────────────────────────────
 * ① **probe 里跑通过的全部基准向量**（防实现漂移）：
 *      Silabs《Throughput with BLE》  27 B → 708 µs / 305,080 bps；251 B → 2500 µs / 803,200 bps；
 *                                   ATT 有效载荷 (251−4−3) B / 2500 µs = **780,800 bps**
 *      HCI MaxTxTime（Vol 4 Part E）  0x0148 / 0x0848 = 328 / 2120 µs —— 规范自己给的锚点
 *      SIG 博客《Higher speed》        空包 80 µs、4.0/4.1 最大包 328 µs、DLE 最大包 2120 µs
 *      Ezurio DTM 应用笔记            **LE Coded S=8、37 octets payload → 3088 µs**（DTM 包无 MIC）
 *      规范 Vol 6 Part B §2.2          Coded 包上下界 462 / 17040 µs
 *      Walsh Medical Media            legacy ADV_IND 47 octets → 376 µs
 * ② **EnGenius 白皮书里保留的那几行真机实测吞吐**，逐行对照理论值（含理论/实测比值）。
 * ③ 四个动作的行为：吞吐与瓶颈定位、连接参数合法性、广播占空比与 AUX 链、PHY 对比。
 * ④ 负向用例：连接参数非法（区间 / 步进 / **timeout 不等式不满足**）、非法入参一律报错点名、
 *    legacy 数据超 31 octets 被判断为不通过。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 必须保留的诚实性说明（三条，勿删）
 * ─────────────────────────────────────────────────────────────────────────────
 * 【诚实性 ①】规范原文 2128 µs 与 HCI / 逐字节模型 2120 µs 相差 8 µs，**本模块取 2120**。
 *     Core Spec Vol 6 Part B §2.1 原文写 "Packets ... take between 44 and 2128 µs to transmit."，
 *     而逐字节模型（260 octets × 8 bits @1 Mbps）与 HCI Vol 4 Part E 的 MaxTxTime 上限 0x0848
 *     都给出 **2120 µs**，两者相差 8 µs —— 恰好是 1M PHY 的一个前导码 octet。
 *     **两处规范原文都没有解释这个差异**，需要人工复核；本模块取舍为 2120（HCI + SIG 博客双重支撑），
 *     并把 2128 作为已知差异用 `SPEC_PACKET_TIME_BOUNDS_US.uncoded.max` 保留。（见用例「诚实性 ①」）
 * 【诚实性 ②】理论值 vs 实测值的偏离不是同一量级，**不能拿一个系数去套所有 PHY**：
 *     1M PHY 在大连接间隔下实测已达理论的 1/1.03（约 97%）—— 说明包时间模型本身是对的；
 *     而 **Coded S=8 只有 1/1.88（约 53%）** —— 长包更容易被干扰打断、重传代价也大；
 *     2M + 7.5 ms 间隔约 1/1.24（80%），卡在"协议栈每事件发不满"这一层。
 *     所以"实测低于理论"时优先怀疑每事件包数，而不是去改包时间公式。（见用例「EnGenius」）
 * 【诚实性 ③】`analyzeScanning` 里把扫描窗按**三个主广播信道均分**（驻留 ≈ 窗口 / 3）是
 *     **本模块的推导假设，规范并未明说**：Core Spec 只规定 Scan_Window ≤ Scan_Interval，
 *     没有规定窗口内如何在 37/38/39 三个信道间分配时间（各厂商调度器实现不同）。
 *     因此"单信道驻留时间"只能当量级参考，**必须用嗅探器实测**。（见用例「诚实性 ③」）
 *
 * @module dsh-embedded-kit/integrate/ble.cases
 */

import {
  analyzeScanning,
  packetCycleUs,
  packetTimeUs,
  PRIMARY_ADV_CHANNELS,
  SPEC_PACKET_TIME_BOUNDS_US,
} from '../lib/ble.js'

import { dispatch, tool, PARAM_NAMES, TOOL_ACTIONS } from './ble.tool.mjs'

/** 供 register 内部各用例复用。 */
let assert

/**
 * 浮点近似断言。
 *
 * @param {number} actual - 实际值。
 * @param {number} expected - 期望值。
 * @param {number} tol - 绝对容差。
 * @param {string} msg - 断言说明。
 */
function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}：期望 ${expected} ±${tol}，实际 ${actual}`)
}

/** 相对容差断言（probe 里的 approx 同款）。 */
function approx(actual, expected, relTol, msg) {
  assert.ok(
    Math.abs(actual - expected) <= Math.abs(expected) * relTol,
    `${msg}：期望 ${expected} ±${relTol * 100}%，实际 ${actual}`,
  )
}

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert: nodeAssert }) {
  assert = nodeAssert

  /* ── ① 基准向量：公开文档里现成的包时间 / 周期 / 吞吐 ─────────── */

  test('基准 Silabs：251 B / 2500 µs 往返 → ATT 应用 780,800 bps（工具 throughput 动作）', () => {
    // 7.5 ms 恰好是 2500 µs 的 3 倍 → 填充率 100%，吞吐等于"连续流上限"，
    // 因此这条同时验证了包时间模型、三段吞吐换算与每事件包数三件事。
    const t = dispatch({
      action: 'throughput',
      phy: 'le-1m',
      data_len_octets: 251,
      encrypted: true,
      conn_interval_ms: 7.5,
      att_mtu_octets: 247,
    })

    assert.equal(t.action, 'throughput')
    assert.equal(t.dataPacketUs, 2120, '单包 2120 µs = SIG 博客的 DLE 最大包')
    assert.equal(t.ackPacketUs, 80, '空包 ACK 80 µs')
    assert.equal(t.cycleUs, 2500, '往返周期 = 2120 + 150 + 80 + 150 = 2500 µs（Silabs）')
    assert.equal(t.packetsPerEvent, 3, '7500 / 2500 = 3 包/事件')
    assert.equal(t.eventFillRatio, 1, '填充率 100%')

    assert.equal(t.throughput.llPayloadBps, 803200, '**LL 载荷 803,200 bps（Silabs）**')
    assert.equal(t.throughput.attAppBps, 780800, '**ATT 应用有效数据 780,800 bps（Silabs）**')
    assert.equal(t.appOctetsPerPacket, 244, '每包 251 − 4(L2CAP) − 3(ATT) = 244 octets')

    assert.ok(Array.isArray(t.checks) && Array.isArray(t.warnings) && Array.isArray(t.notes))
    assert.equal(t.bottleneckLayer, 'phy', '这个组合下瓶颈是物理层固定开销，不是事件切分或 MTU')
  })

  test('基准 Silabs：27 B / 708 µs 往返（4.0/4.1 时代的小包）', () => {
    const c = packetCycleUs({ phy: 'le-1m', dataLenOctets: 27, micOctets: 4 })
    assert.equal(c.dataPacketUs, 328, '328 µs = SIG 博客的 41 octets 最大包，也是 HCI MaxTxTime 下限')
    assert.equal(c.ackPacketUs, 80)
    assert.equal(c.cycleUs, 708, '**328 + 150 + 80 + 150 = 708 µs（Silabs）**')

    // Silabs 把它折成 305,080 bps（对 708 µs 取整后的值）；本模型逐位算是 305,084.7 bps。
    approx((27 * 8 * 1e6) / c.cycleUs, 305080, 0.01, 'LL 载荷速率 ≈ 305,080 bps（Silabs 四舍五入）')

    // 走工具层复核同一组数字
    const t = dispatch({
      action: 'throughput',
      phy: 'le-1m',
      data_len_octets: 27,
      encrypted: true,
      conn_interval_ms: 15,
      att_mtu_octets: 23,
    })
    assert.equal(t.dataPacketUs, 328)
    assert.equal(t.cycleUs, 708, '同一组数字经工具层包装后不应有任何漂移')
    approx((27 * 8 * 1e6) / t.cycleUs, 305080, 0.01, '工具层复核 LL 载荷速率')
  })

  test('基准 HCI (Vol 4 Part E) 与规范 §2.1 / §2.2：包时间上下界全部命中', () => {
    // HCI 自己给的 MaxTxTime 端点 = 1M + MIC 下 27 / 251 octets 的包时间，是最强的自校验锚点
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 27, micOctets: 4 }), 328, '0x0148 = 328 µs')
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 251, micOctets: 4 }), 2120, '0x0848 = 2120 µs')
    // SIG 博客的三个数
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 0, micOctets: 0 }), 80, '空 PDU 10 octets = 80 µs')
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 31, micOctets: 0 }), 328, '4.0/4.1 最大包 41 octets = 328 µs')
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 255, micOctets: 0 }), 2120, 'DLE 最大包 265 octets = 2120 µs')
    // 规范 §2.1 / §2.2 的四个端点
    assert.equal(packetTimeUs({ phy: 'le-2m', payloadOctets: 0, micOctets: 0 }), SPEC_PACKET_TIME_BOUNDS_US.uncoded.min, '2M 空包 = 44 µs')
    assert.equal(
      packetTimeUs({ phy: 'le-coded-s2', payloadOctets: 0, micOctets: 0 }),
      SPEC_PACKET_TIME_BOUNDS_US.coded.min,
      'Coded S=2 空包 = 462 µs',
    )
    assert.equal(
      packetTimeUs({ phy: 'le-coded-s8', payloadOctets: 255, micOctets: 0 }),
      SPEC_PACKET_TIME_BOUNDS_US.coded.max,
      'Coded S=8 最大包 = 17040 µs',
    )
    // Ezurio DTM 的 Coded S=8 独立基准向量（DTM 包不带 MIC）
    assert.equal(packetTimeUs({ phy: 'le-coded-s8', payloadOctets: 37, micOctets: 0 }), 3088, '**Ezurio DTM 3088 µs**')
    // Walsh legacy ADV_IND 最大帧 47 octets
    assert.equal(packetTimeUs({ phy: 'le-1m', payloadOctets: 37, micOctets: 0 }), 376, 'ADV_IND 47 octets = 0.376 ms')
  })

  test('诚实性 ①：规范原文 2128 µs 与 HCI / 模型的 2120 µs 差 8 µs，本模块取 2120', () => {
    // 见文件头【诚实性 ①】。这条**不是**在断言 2128 是错的，而是把差异钉住：
    // 2128 不是实现 bug，改动它就会丢掉 HCI 与 SIG 的双重支撑。
    const modelMax = packetTimeUs({ phy: 'le-1m', payloadOctets: 255, micOctets: 0 })
    assert.equal(SPEC_PACKET_TIME_BOUNDS_US.uncoded.max, 2128, '规范 §2.1 原文写的是 2128 µs')
    assert.equal(modelMax, 2120, '逐字节模型 / HCI MaxTxTime / SIG 博客都是 2120 µs（本模块采用）')
    assert.equal(SPEC_PACKET_TIME_BOUNDS_US.uncoded.max - modelMax, 8, '差值 8 µs = 1M PHY 一个前导码 octet')
    // 两处原文都没解释这个差异 —— 这是**已知未决项**，不是可以悄悄抹平的数值。
    assert.notEqual(modelMax, SPEC_PACKET_TIME_BOUNDS_US.uncoded.max)
  })

  /* ── ② EnGenius 真机实测吞吐对照（含诚实性 ②）──────────────── */

  test('诚实性 ②：EnGenius 真机实测表逐行对照 —— 1M 约 1.03×、Coded S=8 约 1.88×、2M 约 1.05×', () => {
    // 见文件头【诚实性 ②】。EnGenius《Bluetooth Low-Energy 5.0 Throughput Testing》的实测表，
    // 只取标签自洽的行（原表有若干行把 "Data Length 251 bytes" 与 "DLE OFF" 写在一起，自相矛盾，已剔除）。
    // 理论值是上界（每事件发满、零丢包、对端秒回空包 ACK），所以比值恒 ≥ 1。
    const ROWS = [
      { label: '2M / MTU247 / DL251 / CI 400 ms', phy: 'le-2m', ci: 400, measuredKbps: 1317, packets: 284, ratio: 1.0523 },
      { label: '1M / MTU247 / DL251 / CI 400 ms', phy: 'le-1m', ci: 400, measuredKbps: 760, packets: 160, ratio: 1.0274 },
      { label: 'Coded S=8 / MTU247 / DL251 / CI 400 ms', phy: 'le-coded-s8', ci: 400, measuredKbps: 57, packets: 22, ratio: 1.8835 },
      { label: '2M / MTU247 / DL251 / CI 50 ms', phy: 'le-2m', ci: 50, measuredKbps: 1309, packets: 35, ratio: 1.0438 },
      { label: '2M / MTU247 / DL251 / CI 7.5 ms', phy: 'le-2m', ci: 7.5, measuredKbps: 1047, packets: 5, ratio: 1.2429 },
    ]

    for (const row of ROWS) {
      const t = dispatch({
        action: 'throughput',
        phy: row.phy,
        data_len_octets: 251,
        encrypted: true,
        conn_interval_ms: row.ci,
        att_mtu_octets: 247,
      })
      assert.equal(t.packetsPerEvent, row.packets, `${row.label}：每事件包数`)
      const theoryKbps = t.throughput.attAppBps / 1000
      near(theoryKbps / row.measuredKbps, row.ratio, 0.001, `${row.label}：理论/实测`)
      // 理论必须 ≥ 实测（是上界），且不应离谱到 2 倍以上，否则公式或参数模型有问题。
      assert.ok(theoryKbps / row.measuredKbps >= 1 && theoryKbps / row.measuredKbps <= 2, `${row.label}：比值应落在 [1, 2]`)
    }

    // 把三个量级的偏离分别钉住：1M ≈ 1.03×（几乎追平理论），Coded S=8 ≈ 1.88×（只有一半出头）。
    const oneM = dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, encrypted: true, conn_interval_ms: 400, att_mtu_octets: 247 })
    const s8 = dispatch({ action: 'throughput', phy: 'le-coded-s8', data_len_octets: 251, encrypted: true, conn_interval_ms: 400, att_mtu_octets: 247 })
    near(oneM.throughput.attAppBps / 1000 / 760, 1.03, 0.01, '1M 的理论/实测 ≈ 1.03×（实测达 97%）')
    near(s8.throughput.attAppBps / 1000 / 57, 1.88, 0.01, 'Coded S=8 的理论/实测 ≈ 1.88×（实测仅 53%，长包易被打断）')
    assert.ok(s8.throughput.attAppBps / 1000 / 57 > oneM.throughput.attAppBps / 1000 / 760, 'S=8 的偏离明显大于 1M')
  })

  test('Memfault 的间隔切分算例：11.25 ms → 4 包（余 1.25 ms 白扔），12.5 ms → 正好 5 包', () => {
    const a = dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, encrypted: true, conn_interval_ms: 11.25, att_mtu_octets: 247 })
    const b = dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, encrypted: true, conn_interval_ms: 12.5, att_mtu_octets: 247 })
    assert.equal(a.packetsPerEvent, 4, '11250 / 2500 = 4.5 → 只能装 4 个')
    assert.equal(b.packetsPerEvent, 5, '12500 / 2500 = 5 个，利用率 100%')
    approx(a.eventFillRatio, 0.8889, 1e-3, '填充率 88.9%')
    assert.equal(b.eventFillRatio, 1, '填充率 100%')
    // 同样的包，间隔大一点反而更快 —— 这就是"取包周期整数倍"的价值
    assert.ok(b.throughput.attAppBps > a.throughput.attAppBps, '12.5 ms 的吞吐应高于 11.25 ms')
    // 未给栈上限时，本模块会明确说明"每事件包数只是间隔切出来的上限"
    assert.ok(a.notes.some((n) => n.includes('max_packets_per_event') || n.includes('实测')), '缺栈设计值时必须提示实测')
  })

  test('every-event 包数上限（max_packets_per_event）复现 Memfault 的 iOS 7 包限制', () => {
    // 15 ms 间隔理论塞得下 21 个 27 octets 包，但 iOS 栈每事件只发 7 个 —— 这是"理论 vs 实测"的教科书例子。
    const noCap = dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 27, encrypted: true, conn_interval_ms: 15, att_mtu_octets: 23 })
    const capped = dispatch({
      action: 'throughput',
      phy: 'le-1m',
      data_len_octets: 27,
      encrypted: true,
      conn_interval_ms: 15,
      att_mtu_octets: 23,
      max_packets_per_event: 7,
    })
    assert.equal(noCap.packetsPerEvent, 21)
    assert.equal(capped.packetsPerEvent, 7)
    assert.equal(capped.packetsByStackCap, 7)
    assert.equal(noCap.packetsByStackCap, null, '未给栈上限时应为 null（不是 0）')
    assert.ok(capped.throughput.attAppBps < noCap.throughput.attAppBps, '栈上限应把理论吞吐压下来')
  })

  /* ── ③ 广播 / 扩展广播 / PHY 对比 ───────────────────────────── */

  test('广播：legacy ADV_IND 31 octets = 376 µs，20 ms 间隔下三信道 TX 占空比 ≈ 7.89%', () => {
    const a = dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 20, legacy: true, channel_count: 3, adv_data_octets: 31 })
    assert.equal(a.packetUs, 376, 'AdvA 6 + AdvData 31 = 37 octets 载荷 → 376 µs')
    assert.equal(a.pduPayloadOctets, 37)
    assert.equal(a.eventTxUs, 3 * (376 + 150), 'TX 占用 = 3 × (376 + 150) = 1578 µs')
    approx(a.duty.advDelay0Ms.txDutyPercent, 7.89, 0.01, 'advDelay=0 时 TX 占空比 ≈ 7.89%')
    approx(a.duty.advDelayMaxMs.txDutyPercent, 5.26, 0.01, 'advDelay=10 ms 时 ≈ 5.26%')
    assert.equal(a.duty.advDelayMaxMs.periodMs, 30, '周期 = 20 + 10 = 30 ms')
    // 数据速率只算一份（信道数不增加信息量，只提高被扫到的概率）
    assert.equal(a.throughput.dataRateBpsAt0, (31 * 8 * 1e6) / 20000)
    // 事件内相邻包起始间隔 ≤ 10 ms
    assert.equal(a.checks.find((c) => c.name.includes('10 ms')).pass, true)
    assert.equal(a.channelOffsetsUs.length, 3, '三个主广播信道 37/38/39')
    assert.deepEqual(a.channelOffsetsUs.map((c) => c.channel), PRIMARY_ADV_CHANNELS.map((c) => c.index))
  })

  test('广播：可连接广播的监听窗（CONNECT_IND 34 octets）与扩展广播的 AUX 链', () => {
    const legacy = dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 100, legacy: true, channel_count: 3, adv_data_octets: 31 })
    const connectable = dispatch({
      action: 'adv',
      phy: 'le-1m',
      adv_interval_ms: 100,
      legacy: true,
      channel_count: 3,
      adv_data_octets: 31,
      expect_response_kind: 'connectInd',
    })
    assert.equal(legacy.listenUs, 0, '不监听时为 0')
    // CONNECT_IND 载荷 34 octets（InitA 6 + AdvA 6 + LLData 22）→ 352 µs，监听窗 = T_IFS 150 + 352 = 502 µs
    assert.equal(connectable.listenUs, 150 + packetTimeUs({ phy: 'le-1m', payloadOctets: 34, micOctets: 0 }))
    assert.equal(connectable.listenUs, 502)
    assert.ok(connectable.duty.advDelay0Ms.radioOnDutyPercent > legacy.duty.advDelay0Ms.radioOnDutyPercent, '监听窗会抬高射频在线占空比')

    // 扩展广播：1650 octets host 数据 → 每包 ≤ 254 → AUX 链
    const ext = dispatch({
      action: 'adv',
      phy: 'le-2m',
      adv_interval_ms: 100,
      legacy: false,
      channel_count: 3,
      adv_data_octets: 242,
      ext_header_octets: 13,
      host_data_total_octets: 1650,
      aux_phy: 'le-2m',
    })
    assert.equal(ext.aux.chainPackets, 7, 'ceil(1650 / 242) = 7 包')
    assert.equal(ext.aux.auxPacketUs, packetTimeUs({ phy: 'le-2m', payloadOctets: 255, micOctets: 0 }))
    assert.equal(ext.aux.chainUs, 7 * (ext.aux.auxPacketUs + 150), '链时长含包间 T_IFS')
    assert.equal(ext.checks.find((c) => c.name.includes('AUX')).pass, true, 'AUX 链必须装得进一个广播事件')
    assert.equal(ext.eventTxUs, 3 * (ext.packetUs + 150) + ext.aux.chainUs)
    assert.equal(ext.throughput.dataRateBpsAt0, (1650 * 8 * 1e6) / 100000, '数据速率按 host 数据总量算一份')
  })

  test('PHY 对比：Coded S=8 的应用层上限 ≈ 1M 的 1/7，且 2M 周期短于 1M', () => {
    const v = dispatch({ action: 'phy', encrypted: true, data_len_octets: 251 })
    const byId = Object.fromEntries(v.rows.map((r) => [r.phy, r]))

    assert.equal(byId['le-1m'].packetUs, 2120)
    assert.equal(byId['le-1m'].cycleUs, 2500)
    assert.equal(byId['le-1m'].ceilingAppBps, 780800)
    assert.equal(byId['le-2m'].cycleUs, 1408, '1064 + 150 + 44 + 150（Memfault 的 ~1400 µs 是四舍五入值）')
    assert.equal(byId['le-coded-s8'].packetUs, 17040, '规范 §2.2 的 Coded 上界')
    assert.equal(byId['le-coded-s8'].emptyPacketUs, 720, 'Coded 空包 = 前导 80 + 296 + (16+27)×8')
    assert.equal(byId['le-coded-s8'].cycleUs, 18060)

    approx(byId['le-coded-s8'].ceilingAppBps / byId['le-1m'].ceilingAppBps, 1 / 7, 0.06, 'S=8 上限 ≈ 1M 的 1/7')
    assert.ok(byId['le-2m'].cycleUs < byId['le-1m'].cycleUs, '2M 应比 1M 快')
    assert.ok(Array.isArray(v.checks) && Array.isArray(v.warnings) && Array.isArray(v.notes))
    assert.ok(v.checks.every((c) => c.pass), 'PHY 对比的自检项都应通过')
  })

  test('Coded S=8 的现实约束：251 octets 在 7.5 ms 间隔下连一个包都放不下', () => {
    const t = dispatch({ action: 'throughput', phy: 'le-coded-s8', data_len_octets: 251, encrypted: true, conn_interval_ms: 7.5, att_mtu_octets: 247 })
    assert.equal(t.cycleUs, 18060, '17040 + 150 + 720 + 150')
    assert.equal(t.packetsPerEvent, 0, '一个连接事件连一个往返都装不下')
    assert.ok(t.warnings.length > 0, '必须告警，而不是静默给出 0 吞吐')
    assert.equal(t.checks.find((c) => c.name === '连接间隔下能塞进包').pass, false)
    assert.equal(t.throughput.attAppBps, 0)

    // 同一 PHY 把间隔放到 20 ms 就能塞进 1 个包（但填充率只有 90%）
    const t20 = dispatch({ action: 'throughput', phy: 'le-coded-s8', data_len_octets: 251, encrypted: true, conn_interval_ms: 20, att_mtu_octets: 247 })
    assert.equal(t20.packetsPerEvent, 1)
    assert.ok(t20.eventFillRatio < 1)
  })

  /* ── ④ 连接参数合法性 ───────────────────────────────────────── */

  test('连接参数：CI 30 ms + SL 9 + timeout 2000 ms 合法，且反解出最大 SL = 32', () => {
    const r = dispatch({ action: 'conn-params', conn_interval_ms: 30, latency: 9, supervision_timeout_ms: 2000 })
    assert.equal(r.legal, true)
    assert.equal(r.peripheralSilenceWindowMs, 300, '(1 + 9) × 1 × 30 ms')
    assert.equal(r.minRequiredTimeoutMs, 600, '规范要求 timeout > 2 × 300 ms')
    assert.equal(r.maxLegalLatency, 32, 'floor(2000 / (2 × 30) − 1) = 32')
    assert.equal(r.checks.find((c) => c.name === 'timeout > (1 + latency) × sub × interval × 2').pass, true)
    assert.equal(r.warnings.length, 0)
    assert.ok(r.notes.some((n) => n.includes('不降低吞吐')), '必须说明 Slave Latency 不降吞吐，只是省电')
  })

  test('连接参数：subrate 因子会等比抬高 timeout 下限（latency 反解随之下移）', () => {
    const plain = dispatch({ action: 'conn-params', conn_interval_ms: 100, latency: 2, supervision_timeout_ms: 4000 })
    const sub4 = dispatch({ action: 'conn-params', conn_interval_ms: 100, latency: 2, supervision_timeout_ms: 4000, subrate_factor: 4 })
    assert.equal(plain.legal, true, '2 × (1 + 2) × 100 = 600 ms < 4000 ms')
    assert.equal(sub4.peripheralSilenceWindowMs, 4 * 300, 'subrate 把跳过窗口放大 4 倍')
    assert.equal(sub4.minRequiredTimeoutMs, 2400)
    assert.equal(sub4.legal, true, '4000 > 2400，仍合法')
    assert.ok(sub4.maxLegalLatency < plain.maxLegalLatency, 'subrate 越大，允许的 latency 越小')
    // 厂商余量系数只在你给了时才判，且不内置任何厂商推荐值
    const vendor = dispatch({
      action: 'conn-params',
      conn_interval_ms: 100,
      latency: 2,
      supervision_timeout_ms: 4000,
      vendor_timeout_factor: 3,
    })
    assert.equal(vendor.checks.find((c) => c.name.includes('厂商余量')).pass, true, '3 × 300 = 900 ms < 4000 ms，余量充足')
    assert.ok(vendor.checks.length > plain.checks.length, '给了厂商系数才多出这一条')
    // 同样一组参数，把余量要求提到 20× 就会被挡下（说明这一条确实在按你给的系数判）
    assert.equal(
      dispatch({ action: 'conn-params', conn_interval_ms: 100, latency: 2, supervision_timeout_ms: 4000, vendor_timeout_factor: 20 }).checks.find((c) =>
        c.name.includes('厂商余量'),
      ).pass,
      false,
    )
    // 不给系数时不判这一条，并在 notes 里说明
    assert.equal(plain.checks.some((c) => c.name.includes('厂商余量')), false)
  })

  /* ── ⑤ 负向用例 ─────────────────────────────────────────────── */

  test('负向：连接参数非法 —— timeout 不满足 (1 + latency) × interval × 2（两组）', () => {
    // ① CI 100 ms + SL 4 → 跳过窗口 500 ms，要求 timeout > 1000 ms，实际只给 500 ms
    const bad1 = dispatch({ action: 'conn-params', conn_interval_ms: 100, latency: 4, supervision_timeout_ms: 500 })
    assert.equal(bad1.legal, false)
    assert.equal(bad1.peripheralSilenceWindowMs, 500)
    assert.equal(bad1.minRequiredTimeoutMs, 1000)
    assert.equal(bad1.checks.find((c) => c.name === 'timeout > (1 + latency) × sub × interval × 2').pass, false)
    assert.ok(bad1.warnings.some((w) => w.includes('违反规范硬约束')), '必须点明违反的是规范硬约束')
    assert.ok(bad1.warnings.some((w) => w.includes('1000 ms')), '告警要给出最小合法 timeout')

    // ② CI 4 s + SL 0 → 下限 8000 ms，实际 5000 ms；这条其它项（区间 / 步进）都合法，
    //    所以不合法**只可能**来自 timeout 不等式，排除掉参数区间判定的干扰。
    const bad2 = dispatch({ action: 'conn-params', conn_interval_ms: 4000, latency: 0, supervision_timeout_ms: 5000 })
    assert.equal(bad2.legal, false)
    assert.equal(bad2.minRequiredTimeoutMs, 8000)
    const failed = bad2.checks.filter((c) => !c.pass).map((c) => c.name)
    assert.deepEqual(failed, ['timeout > (1 + latency) × sub × interval × 2'], '这条只该违反 timeout 不等式')

    // 对照组：同样 CI 4000 + SL 0，把 timeout 放到 10000 ms 就合法了
    assert.equal(dispatch({ action: 'conn-params', conn_interval_ms: 4000, latency: 0, supervision_timeout_ms: 10000 }).legal, true)
  })

  test('负向：连接参数的区间 / 步进非法（timeout 非 10 ms 倍数、CI 非 1.25 ms 倍数）', () => {
    const badStep = dispatch({ action: 'conn-params', conn_interval_ms: 100, latency: 0, supervision_timeout_ms: 2505 })
    assert.equal(badStep.legal, false)
    assert.equal(badStep.checks.find((c) => c.name === '监督超时步进').pass, false, '2505 不是 10 ms 的整数倍')

    const badCi = dispatch({ action: 'conn-params', conn_interval_ms: 7.6, latency: 0, supervision_timeout_ms: 5000 })
    assert.equal(badCi.legal, false)
    assert.equal(badCi.checks.find((c) => c.name === '连接间隔步进').pass, false, '7.6 不是 1.25 ms 的整数倍')

    // 边界：7.5 ms 与 4 s 是规范端点，应通过区间判定
    const edge = dispatch({ action: 'conn-params', conn_interval_ms: 7.5, latency: 0, supervision_timeout_ms: 100 })
    assert.equal(edge.checks.find((c) => c.name === '连接间隔范围').pass, true)
    assert.equal(edge.checks.find((c) => c.name === '监督超时范围').pass, true)
    assert.equal(edge.minRequiredTimeoutMs, 15, '2 × 7.5 = 15 ms，100 ms 的下限远够')
    assert.equal(edge.legal, true)
  })

  test('负向：非法入参一律报错点名（未知 PHY / MIC 值 / DLE 越界 / ATT_MTU 越界 / 缺必填 / 未知 action）', () => {
    // 缺必填：一次性点名，不猜默认值
    assert.throws(() => dispatch({ action: 'throughput' }), /需要 phy/)
    assert.throws(() => dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, conn_interval_ms: 30 }), /需要 encrypted/)
    assert.throws(() => dispatch({ action: 'conn-params', conn_interval_ms: 30 }), /需要 latency/)
    assert.throws(() => dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 100 }), /需要 legacy/)
    assert.throws(() => dispatch({ action: 'phy' }), /需要 encrypted/)
    // encrypted 必须是真布尔，字符串 'true' 不算
    assert.throws(() => dispatch({ action: 'phy', encrypted: 'true' }), /encrypted 必须显式给出/)

    // lib 侧的取值校验
    assert.throws(() => dispatch({ action: 'throughput', phy: 'le-4m', data_len_octets: 251, encrypted: true, conn_interval_ms: 30 }), /未知的 PHY/)
    assert.throws(() => dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 300, encrypted: true, conn_interval_ms: 30 }), /27~251/)
    assert.throws(() => dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, encrypted: true, conn_interval_ms: 30, att_mtu_octets: 10 }), /att_mtu_octets/)
    assert.throws(() => packetTimeUs({ phy: 'le-1m', payloadOctets: 10, micOctets: 2 }), /mic_octets 只能是/)

    // 扩展广播不给扩展头 → 报错（扩展头大小属设计细节，无默认值）
    assert.throws(
      () => dispatch({ action: 'adv', phy: 'le-2m', adv_interval_ms: 100, legacy: false, channel_count: 3, adv_data_octets: 100 }),
      /ext_header_octets/,
    )
    assert.throws(() => dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 100, legacy: true, channel_count: 3, adv_data_octets: 31, expect_response_kind: 'scan' }), /expect_response_kind/)
    // 未知 action
    assert.throws(() => dispatch({ action: 'through_put', phy: 'le-1m' }), /未知 action/)
  })

  test('负向：legacy 广播数据超 31 octets 判不通过（规范上不可能发生，只报警）', () => {
    const over = dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 100, legacy: true, channel_count: 3, adv_data_octets: 100 })
    assert.equal(over.checks.find((c) => c.name.includes('31')).pass, false, 'AdvA 6 + AdvData 31 = PDU 载荷上限 37')
    assert.equal(over.checks.find((c) => c.name.includes('31')).detail.includes('100'), true)
    // 同一条检查在 31 octets 时应通过
    assert.equal(
      dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 100, legacy: true, channel_count: 3, adv_data_octets: 31 }).checks.find((c) => c.name.includes('31')).pass,
      true,
    )
    // legacy 广播在规范上只能用 LE 1M：给别的 PHY 会被记一条 warning，而不是静默算错
    const wrongPhy = dispatch({ action: 'adv', phy: 'le-2m', adv_interval_ms: 100, legacy: true, channel_count: 3, adv_data_octets: 31 })
    assert.ok(wrongPhy.warnings.some((w) => w.includes('只能用 LE 1M')))
  })

  /* ── ⑥ 诚实性 ③：扫描窗均分是推导假设 ───────────────────────── */

  test('诚实性 ③：扫描窗按 3 信道均分是推导假设，规范未规定窗口内如何分配时间', () => {
    // 见文件头【诚实性 ③】。Core Spec 只规定 Scan_Window ≤ Scan_Interval（Vol 4 Part E
    // LE Set Scan Parameters），**没有**规定窗口内如何在 37/38/39 三个主广播信道之间分配时间；
    // lib 采用"窗口 ÷ 信道数"这个最简单的假设，各厂商调度器的实际实现并不一致。
    // 因此 `perChannelDwellUs` 只能当量级参考，**真机必须用嗅探器实测**。
    const s3 = analyzeScanning({ scanIntervalMs: 100, scanWindowMs: 3, advPacketUs: 376, advIntervalMs: 100 })
    assert.equal(s3.perChannelDwellUs, 1000, '3 ms ÷ 3 信道 = 1000 µs（**推导假设**，不是规范值）')
    assert.equal(s3.channelCount, 3, '默认按规范上的三个主广播信道算')

    // 假设换了，驻留时间就跟着变 —— 正说明它是假设而非规范结论
    const s1 = analyzeScanning({ scanIntervalMs: 100, scanWindowMs: 3, advPacketUs: 376, advIntervalMs: 100, channelCount: 1 })
    assert.equal(s1.perChannelDwellUs, 3000, '按 1 个信道算就是整个窗口')
    assert.notEqual(s3.perChannelDwellUs, s1.perChannelDwellUs)

    // 窗口 ≤ 间隔是**规范硬约束**（这条是真规范），可以放心依赖
    const bad = analyzeScanning({ scanIntervalMs: 10, scanWindowMs: 20, advPacketUs: 376, advIntervalMs: 100 })
    assert.equal(bad.checks.find((c) => c.name === '扫描窗口 ≤ 扫描间隔').pass, false)
    assert.equal(bad.scanDutyPercent, 100, '占空比按窗口 = 间隔截断，不放大到 200%')
    assert.ok(bad.warnings.some((w) => w.includes('规范不允许')))
  })

  /* ── ⑦ 工具形状 ─────────────────────────────────────────────── */

  test('工具形状：name=ble_throughput、参数 ≤ 20 且说明为中文、四动作齐备且都返回 { checks, warnings, notes }', () => {
    assert.equal(tool.name, 'ble_throughput')
    assert.equal(typeof tool.title, 'string')
    assert.ok(tool.title.length > 0)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 200, 'description 应说清做什么 / 要什么输入 / 给什么输出 / 硬约束')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.summaryLines, 'function')

    assert.ok(PARAM_NAMES.length <= 20, `参数不得超过 20 个，实际 ${PARAM_NAMES.length}`)
    for (const name of PARAM_NAMES) {
      const p = tool.parameters[name]
      assert.ok(typeof p.type === 'string', `${name} 缺少 type`)
      assert.ok(typeof p.description === 'string' && p.description.length > 0, `${name} 缺少说明`)
      assert.ok(/[\u4e00-\u9fff]/.test(p.description), `${name} 的说明应为中文`)
    }

    assert.deepEqual(tool.parameters.action.enum, TOOL_ACTIONS)
    assert.deepEqual(TOOL_ACTIONS.slice().sort(), ['adv', 'conn-params', 'phy', 'throughput'])
    assert.equal(tool.parameters.action.required, true)
    // 三个"必须显式给出、没有默认值"的开关
    assert.equal(tool.parameters.encrypted.type, 'boolean')
    assert.equal(tool.parameters.legacy.type, 'boolean')

    // 四个动作都返回 { checks, warnings, notes }，且 summaryLines 出具体数值行
    const branches = [
      dispatch({ action: 'throughput', phy: 'le-1m', data_len_octets: 251, encrypted: true, conn_interval_ms: 7.5, att_mtu_octets: 247 }),
      dispatch({ action: 'conn-params', conn_interval_ms: 30, latency: 9, supervision_timeout_ms: 2000 }),
      dispatch({ action: 'adv', phy: 'le-1m', adv_interval_ms: 20, legacy: true, channel_count: 3, adv_data_octets: 31 }),
      dispatch({ action: 'phy', encrypted: true }),
    ]
    for (const v of branches) {
      assert.ok(Array.isArray(v.checks), `${v.action} 的 checks 应为数组`)
      assert.ok(Array.isArray(v.warnings), `${v.action} 的 warnings 应为数组`)
      assert.ok(Array.isArray(v.notes), `${v.action} 的 notes 应为数组`)
      assert.ok(v.checks.every((c) => typeof c.name === 'string' && typeof c.pass === 'boolean' && typeof c.detail === 'string'))
      const lines = tool.summaryLines(v)
      assert.ok(Array.isArray(lines) && lines.length > 0, `${v.action} 应渲染出具体数值行`)
      assert.ok(lines.every((l) => typeof l === 'string'), `${v.action} 的数值行应全是字符串`)
    }

    // 数值行要带上关键数
    const tp = tool.summaryLines(branches[0]).join('\n')
    assert.ok(tp.includes('2120') && tp.includes('2500') && tp.includes('780.8'), 'throughput 行应含包时间 / 周期 / 吞吐')
    assert.ok(tp.includes('瓶颈层'))
    const cp = tool.summaryLines(branches[1]).join('\n')
    assert.ok(cp.includes('300') && cp.includes('600') && cp.includes('32'), 'conn-params 行应含跳过窗口 / 下限 / SL 上限')
    const adv = tool.summaryLines(branches[2]).join('\n')
    assert.ok(adv.includes('376') && adv.includes('7.890'), 'adv 行应含包时间与占空比')
    const phy = tool.summaryLines(branches[3]).join('\n')
    assert.ok(phy.includes('17040') && phy.includes('780.8'), 'phy 行应是逐 PHY 的表')

    // 未识别的 action / 非对象一律返回空数组，不抛错
    assert.deepEqual(tool.summaryLines({ action: 'nope' }), [])
    assert.deepEqual(tool.summaryLines(null), [])
    // execute 是 dispatch 的 async 外壳（用例同步，故只核形状）
    assert.equal(typeof tool.execute, 'function')
  })
}
