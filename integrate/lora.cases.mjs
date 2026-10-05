/**
 * `lora_airtime` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './lora.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖四类东西：
 *   ① lib/lora.js 里**联网核实到的公开空中时间数值**——这四组是整个模块最强的正确性证据，
 *      全部钉成基准向量（配置参数与核实来源一致），任何公式实现漂移都会在这里暴露：
 *        V1 54.432 ms   Sensors 25(23) 7128 (2025) 附录 A（SF6 / BW500k / PL240）
 *        V2 354.304 ms  d-central.tech "Reference check"（Meshtastic Long Fast：SF11 / BW250k / PL16 / 前导 16）
 *        V3 41.216 ms   aestechno AN1200.13 计算器（SF7 / BW125k / PL12 / DE=0）
 *        V4 1318.912 ms OpenELAB / haraldkreuzer.net（SF12 / BW125k / PL20，自动 LDRO）
 *      另附 SF7 侧的同源数值 56.576 ms（公开资料写作 "56.6 ms"）与 125 kHz 带宽下的 Ts 表。
 *   ② EU868 法规常数（ETSI EN 300 220-2 V3.2.2 Table 2 / Table 16）的原文数值，
 *      并保留两条**纠偏注释**（见用例 ⑤ 与 ⑥，防止后来人误用）；
 *   ③ 三个动作的行为：占空比预算与判定、SF 对比的单调性、法规参数可由调用方整体覆盖；
 *   ④ 负向用例：占空比超限、非法参数（含单位防呆与不臆造阈值）。
 *
 * 用例全部是**同步**的，走 integrate/lora.tool.mjs 导出的 `dispatch`（execute 的同步内核），
 * 这样不依赖宿主 test 实现是否 await。用例只读，不修改 lib 中任何东西。
 *
 * @module dsh-embedded-kit/integrate/lora.cases
 */

import {
  airTime,
  EU868_SUBBANDS,
  LDRO_SYMBOL_TIME_LIMIT_SEC,
  LORAWAN_EU868_MANDATORY_CHANNELS_MHZ,
  POLITE_SPECTRUM_ACCESS_LIMITS,
  symbolTimeSec,
  TTN_FAIR_USE_POLICY,
} from '../lib/lora.js'

import { dispatch, tool, PARAM_NAMES, TOOL_ACTIONS } from './lora.tool.mjs'

/**
 * 一份给全的空中时间参数：SF7 / BW125 kHz / CR 4-5 / 前导 8 / 19 B PHY payload /
 * CRC 开 / 显式包头（= 6 字节应用数据 + LoRaWAN 约 13 字节 MAC 开销）。
 *
 * 这三个量（crc / implicit_header / preamble_symbols）都直接改变空中时间，
 * lib 刻意**没有**默认值，所以用例里一律显式写出来。
 */
const GOOD_ARGS = {
  sf: 7,
  bw_hz: 125000,
  coding_rate: '4/5',
  preamble_symbols: 8,
  payload_bytes: 19,
  crc: true,
  implicit_header: false,
}

/** 同上，SF 换成 12（EU868 DR0，最坏情况）。 */
const SF12_ARGS = { ...GOOD_ARGS, sf: 12 }

/** 供 register 内部各用例复用。 */
let assert

/**
 * 把秒换算成毫秒并四舍五入到 3 位小数。
 *
 * 公开资料给出的空中时间就是 3 位小数的毫秒（54.432 / 354.304 / 41.216 / 1318.912），
 * 所以用这个函数把浮点结果对齐到"公布精度"，以便用严格相等去钉基准值。
 *
 * @param {number} sec - 秒数。
 * @returns {number} 毫秒数（3 位小数）。
 */
function ms3(sec) {
  return Number((sec * 1000).toFixed(3))
}

/**
 * 浮点近似断言。
 *
 * @param {number} actual - 实际值。
 * @param {number} expected - 期望值。
 * @param {number} tol - 容差。
 * @param {string} msg - 断言说明。
 */
function near(actual, expected, tol, msg) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}：期望 ${expected} ±${tol}，实际 ${actual}`)
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

  /* ── ① 基准向量：联网核实到的公开空中时间数值 ───────────────── */

  test('基准 V1 = 54.432 ms：SF6 / BW500k / PL240 / CR4-5 / 显式包头 / CRC 开（Sensors 25(23) 7128 附录 A）', () => {
    const a = airTime({
      sf: 6,
      bwHz: 500000,
      codingRate: '4/5',
      preambleSymbols: 8,
      payloadBytes: 240,
      crc: true,
      implicitHeader: false,
      ldro: false,
    })
    assert.equal(ms3(a.tsSec), 0.128, 'Ts = 2^6 / 500000')
    assert.equal(ms3(a.tpreambleSec), 1.568, 'Tpreamble = (8 + 4.25) × Ts')
    assert.equal(a.payloadSymbols, 413, 'npayload')
    assert.equal(ms3(a.tpayloadSec), 52.864, 'Tpayload')
    assert.equal(ms3(a.toaSec), 54.432, '**总空中时间 54.432 ms（公开基准，钉死）**')

    // 同一组参数走工具描述符，结果必须与直接调 lib 完全一致（证明包装没有动过算法）
    const viaTool = dispatch({
      action: 'airtime',
      sf: 6,
      bw_hz: 500000,
      coding_rate: '4/5',
      preamble_symbols: 8,
      payload_bytes: 240,
      crc: true,
      implicit_header: false,
      ldro: 'off',
    })
    assert.equal(ms3(viaTool.toaSec), 54.432)
    assert.equal(viaTool.payloadSymbols, 413)
    assert.ok(Array.isArray(viaTool.checks) && Array.isArray(viaTool.warnings) && Array.isArray(viaTool.notes))
  })

  test('基准 V2 = 354.304 ms：SF11 / BW250k / PL16 / 前导 16（Meshtastic Long Fast，d-central.tech Reference check）', () => {
    const a = airTime({
      sf: 11,
      bwHz: 250000,
      codingRate: '4/5',
      preambleSymbols: 16,
      payloadBytes: 16,
      crc: true,
      implicitHeader: false,
      ldro: false,
    })
    assert.equal(ms3(a.tsSec), 8.192, 'Ts = 2^11 / 250000')
    assert.equal(a.payloadSymbols, 23, 'npayload')
    assert.equal(ms3(a.toaSec), 354.304, '**总空中时间 354.304 ms（公开基准，钉死）**')

    const viaTool = dispatch({
      action: 'airtime',
      sf: 11,
      bw_hz: 250000,
      coding_rate: '4/5',
      preamble_symbols: 16,
      payload_bytes: 16,
      crc: true,
      implicit_header: false,
      ldro: 'off',
    })
    assert.equal(ms3(viaTool.toaSec), 354.304)
    // 前导 16 而非 8：同样 16 字节 payload，前导改 8 会让结果变小 —— 说明它不能被默认值糊过去
    assert.ok(ms3(viaTool.tpreambleSec) > ms3(airTime({ ...{ sf: 11, bwHz: 250000, codingRate: '4/5', preambleSymbols: 8, payloadBytes: 16, crc: true, implicitHeader: false, ldro: false } }).tpreambleSec))
  })

  test('基准 V3 = 56.576 ms(SF7) / 1318.912 ms(SF12)：BW125k / PL20，SF12 自动 LDRO 判为 on', () => {
    const cfg = {
      bwHz: 125000,
      codingRate: '4/5',
      preambleSymbols: 8,
      payloadBytes: 20,
      crc: true,
      implicitHeader: false,
    }
    const sf7 = airTime({ ...cfg, sf: 7, ldro: 'auto' })
    const sf12 = airTime({ ...cfg, sf: 12, ldro: 'auto' })

    // 公开资料把 SF7 那档写作 "56.6 ms"，精确值是 56.576 ms
    assert.equal(ms3(sf7.toaSec), 56.576, 'SF7 / 20 B')
    assert.equal(ms3(sf12.toaSec), 1318.912, '**SF12 / 20 B = 1318.912 ms（公开基准，钉死）**')
    assert.equal(sf12.payloadSymbols, 28)
    assert.equal(sf7.payloadSymbols, 43)

    // LDRO 的 'auto' 按数据手册 §4.1.1.6 的 16 ms 规则走，不是猜的
    assert.equal(sf7.ldro, false, 'SF7 @125k 的 Ts = 1.024 ms < 16 ms → off')
    assert.equal(sf12.ldro, true, 'SF12 @125k 的 Ts = 32.768 ms > 16 ms → on')
    assert.equal(sf12.ldroMismatch, false)

    // 走工具：LDRO 用 'auto' 时也必须得到同一个 1318.912 ms
    const viaTool = dispatch({ action: 'airtime', ...GOOD_ARGS, payload_bytes: 20, sf: 12, ldro: 'auto' })
    assert.equal(ms3(viaTool.toaSec), 1318.912)
  })

  test('基准 V4 = 41.216 ms：SF7 / BW125k / PL12 / DE=0（aestechno AN1200.13 计算器）+ 125 kHz 下的 Ts 表', () => {
    const a = airTime({
      sf: 7,
      bwHz: 125000,
      codingRate: '4/5',
      preambleSymbols: 8,
      payloadBytes: 12,
      crc: true,
      implicitHeader: false,
      ldro: false,
    })
    assert.equal(ms3(a.tsSec), 1.024)
    assert.equal(a.payloadSymbols, 28)
    assert.equal(ms3(a.toaSec), 41.216, '**总空中时间 41.216 ms（公开基准，钉死）**')

    const viaTool = dispatch({
      action: 'airtime',
      sf: 7,
      bw_hz: 125000,
      coding_rate: '4/5',
      preamble_symbols: 8,
      payload_bytes: 12,
      crc: true,
      implicit_header: false,
      ldro: 'off',
    })
    assert.equal(ms3(viaTool.toaSec), 41.216)

    // 符号时间表（SX1276 数据手册口径 Ts = 2^SF / BW，BW = 125 kHz）
    const expectMs = { 7: 1.024, 8: 2.048, 9: 4.096, 10: 8.192, 11: 16.384, 12: 32.768 }
    for (const sf of [7, 8, 9, 10, 11, 12]) assert.equal(ms3(symbolTimeSec(sf, 125000)), expectMs[sf], `SF${sf} 的 Ts`)
    // 16 ms 门限恰好在 SF10 → SF11 之间跨过
    assert.equal(LDRO_SYMBOL_TIME_LIMIT_SEC, 0.016)
    assert.ok(symbolTimeSec(10, 125000) < LDRO_SYMBOL_TIME_LIMIT_SEC)
    assert.ok(symbolTimeSec(11, 125000) > LDRO_SYMBOL_TIME_LIMIT_SEC)
  })

  /* ── ② EU868 法规常数与两条纠偏 ─────────────────────────────── */

  test('纠偏①：1 s / 100 s / 100 ms 那组限值属于 polite spectrum access 路径（与占空比二选一），不是 EU868 通用限值', () => {
    // 【纠偏保留 —— 防后来人误用】
    //   ETSI EN 300 220-2 V3.2.2 **Table 16** 的这组时限：
    //       Maximum Transmission Duration Ton  ≤ 1 s   （For a single transmission）
    //       Maximum Transmission Duration Ton  ≤ 4 s   （For a transmission dialogue / polling sequence）
    //       Max Tcum_on over 1 hour            ≤ 100 s  （per 200 kHz spectrum）
    //       Minimum Toff_min                   ≥ 100 ms （at the same nominal operating frequency）
    //       Minimum CCA interval               = 160 µs
    //   **只在设备选择走 polite spectrum access（LBT + AFA）替代占空比时才适用。**
    //   §4.4.3.1 明确这两条是**互斥**的合规路径，不是叠加约束。
    //   ⚠ 千万不要把它当成"EU868 通用单次发射上限"：占空比路径下的 LoRa 子频段
    //     （K/L/M/N/O/P/Q）在 **Table 2 里根本没有 Ton 限值**。
    const p = POLITE_SPECTRUM_ACCESS_LIMITS
    assert.equal(p.maxSingleTransmissionSec, 1, 'Table 16 单次发射 ≤ 1 s')
    assert.equal(p.maxDialogueSec, 4, 'Table 16 对话/轮询序列 ≤ 4 s')
    assert.equal(p.maxCumulativeOnSecPerHourPer200kHz, 100, 'Table 16 每 200 kHz 每小时累计 ≤ 100 s')
    assert.equal(ms3(p.minOffTimeSec), 100, 'Table 16 同频点最小静默 = 100 ms')
    near(p.ccaMinSec * 1e6, 160, 1e-9, 'Table 16 最小 CCA 侦听')

    // 同一条包走两条路径 → 每小时预算不同，证明它们不是同一套约束
    const viaDuty = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'duty-cycle', packets_per_window: 4 })
    const viaPsa = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'polite-spectrum-access', packets_per_window: 4 })
    assert.equal(viaDuty.maxTransmitSecPerHour, 36, 'M 段 1% → 36 s/h')
    assert.equal(viaPsa.maxTransmitSecPerHour, 100, 'psa 路径 → 100 s/h（每 200 kHz）')
    assert.notEqual(viaDuty.maxPacketsPerHour, viaPsa.maxPacketsPerHour)
    // 走 psa 时**不再**叠加占空比约束，所以 effectiveDutyCycleLimit 保持 null
    assert.equal(viaPsa.effectiveDutyCycleLimit, null)
    assert.ok(viaPsa.notes.some((n) => n.includes('不再')), 'psa 路径必须写明"不再叠加占空比"')
    assert.ok(viaDuty.notes.some((n) => n.includes('法规原文口径')), '占空比路径必须写明统计口径的出处')

    // 1 s 上限**只**出现在 psa 路径里
    assert.ok(!viaDuty.checks.some((c) => c.name.includes('polite spectrum access')), '占空比路径不应出现 Table 16 的判定')
    assert.ok(viaPsa.checks.some((c) => c.name === 'polite spectrum access 单次发射'))

    // SF12 的单包 1.3189 s：走 psa 被 1 s 挡住；走占空比则不受这条限制（受占空比限制）
    const longPsa = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'm', regime: 'polite-spectrum-access' })
    assert.equal(longPsa.checks.find((c) => c.name === 'polite spectrum access 单次发射').pass, false)
    assert.ok(longPsa.warnings.some((w) => w.includes('1 s 上限')))
    const longDuty = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'm', regime: 'duty-cycle' })
    assert.ok(!longDuty.checks.some((c) => c.name === 'polite spectrum access 单次发射'))

    // K0 段（862–863 MHz）在 Table 2 里没有 "or polite spectrum access" → 不能靠 LBT+AFA 替代占空比
    const badPsa = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'k0', regime: 'polite-spectrum-access' })
    assert.ok(badPsa.warnings.some((w) => w.includes('没有')), 'K0 段走 psa 必须被告警')
  })

  test('纠偏②：Ton/Toff 在 Table 2 里对 K/L/M/N/O/P/Q 不适用，故 lib 未填任何默认值', () => {
    // 【纠偏保留 —— 防后来人误用】
    //   EN 300 220-2 §4.4.12（短时行为 Ton/Toff）的适用条件是 "when Ton or Toff limits are
    //   specified in NRI"，§4.4.12.3 又说限值 "as specified in Table 2 or in NRI"。
    //   而 **Table 2 对 868 MHz 的 K/L/M/N/O/P/Q 各段根本没有给出 Ton/Toff**。
    //   因此 lib/lora.js 对这几个子频段的 maxOnTimeSec / minOffTimeSec **一律保持 null**，
    //   绝不替调用方编造"单次最长发射 X 秒"。
    //   （Table 2 里唯一出现 Ton_max 的是 X/Y 频段 —— ER-GSM 保护，≤5 ms/1 s，与 LoRa 无关。）
    //   要把 Ton 纳入判定，只能由调用方通过 max_on_time_sec 显式传入（并注明来源，如某国 NRI）。
    for (const id of ['k0', 'k', 'l', 'm', 'n', 'o', 'p', 'q']) {
      assert.equal(EU868_SUBBANDS[id].maxOnTimeSec, null, `${id}.maxOnTimeSec 必须保持 null（不臆造）`)
      assert.equal(EU868_SUBBANDS[id].minOffTimeSec, null, `${id}.minOffTimeSec 必须保持 null（不臆造）`)
    }
    // 例外有出处：V 段（FHSS）的 dwell time ≤ 400 ms 来自 §4.4.11.3 d)，不是 Table 2 的 Ton
    assert.equal(EU868_SUBBANDS.v.maxOnTimeSec, 0.4)

    // 未给 max_on_time_sec 时，这一项**被跳过**并说明原因，而不是猜一个值
    const skipped = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'm', regime: 'duty-cycle' })
    const ton = skipped.checks.find((c) => c.name === '单次发射时长')
    assert.equal(ton.pass, true)
    assert.ok(/未规定 Ton/.test(ton.detail), `应说明该段未规定 Ton：${ton.detail}`)
    assert.ok(skipped.notes.some((n) => n.includes('maxOnTimeSec')), 'notes 要指出需传 maxOnTimeSec 才能判')

    // 显式传入才判：0.4 s 上限下，SF12 的 1.3189 s 单包不通过
    const strict = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'm', regime: 'duty-cycle', max_on_time_sec: 0.4 })
    assert.equal(strict.checks.find((c) => c.name === '单次发射时长').pass, false)
    assert.ok(strict.warnings.some((w) => w.includes('超过给定的 Ton 上限')))
  })

  test('EU868 Table 2 原文数值逐项钉住；法规参数可由调用方通过 subband_override 整体覆盖', () => {
    const expect = {
      k0: { from: 862.0, to: 863.0, mw: 25, dc: 0.001, psa: false },
      k: { from: 863.0, to: 865.0, mw: 25, dc: 0.001, psa: true },
      l: { from: 865.0, to: 868.0, mw: 25, dc: 0.01, psa: true },
      m: { from: 868.0, to: 868.6, mw: 25, dc: 0.01, psa: true },
      n: { from: 868.7, to: 869.2, mw: 25, dc: 0.001, psa: true },
      o: { from: 869.4, to: 869.65, mw: 500, dc: 0.1, psa: true },
      p: { from: 869.7, to: 870.0, mw: 5, dc: null, psa: false },
      q: { from: 869.7, to: 870.0, mw: 25, dc: 0.01, psa: true },
    }
    for (const [id, e] of Object.entries(expect)) {
      const b = EU868_SUBBANDS[id]
      assert.equal(b.fromMHz, e.from, `${id} 频率下限`)
      assert.equal(b.toMHz, e.to, `${id} 频率上限`)
      assert.equal(b.maxErpMw, e.mw, `${id} e.r.p.`)
      assert.equal(b.dutyCycle, e.dc, `${id} 占空比上限`)
      assert.equal(b.politeSpectrumAccess, e.psa, `${id} 是否允许 polite spectrum access`)
    }
    // V 段（FHSS，≥47 跳频信道）
    assert.equal(EU868_SUBBANDS.v.dutyCycle, 0.001)
    assert.equal(EU868_SUBBANDS.v.maxErpMw, 25)
    assert.equal(EU868_SUBBANDS.v.politeSpectrumAccess, false)

    // P 段在 Table 2 里是 "No requirement" → 无占空比上限，预算字段一律 null 而不是 0
    const pSeg = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'p', regime: 'duty-cycle' })
    assert.equal(pSeg.effectiveDutyCycleLimit, null)
    assert.equal(pSeg.maxTransmitSecPerHour, null)
    assert.equal(pSeg.checks.find((c) => c.name === '占空比').pass, true)
    assert.ok(pSeg.notes.some((n) => n.includes('无占空比要求')))

    // 覆盖：调用方给一个自己的子频段对象（例如某国 NRI 规定的 0.5% 占空比 / 14 mW）
    const custom = {
      id: 'custom',
      label: '自定义子频段（调用方覆盖）',
      dutyCycle: 0.005,
      maxErpMw: 14,
      politeSpectrumAccess: false,
      maxOnTimeSec: null,
      minOffTimeSec: null,
    }
    const ov = dispatch({ action: 'duty', ...GOOD_ARGS, subband_override: custom })
    assert.equal(ov.effectiveDutyCycleLimit, 0.005)
    assert.equal(ov.maxTransmitSecPerHour, 18, '0.5% × 3600 s = 18 s')
    assert.equal(ov.subbandLabel, custom.label)

    // 与内置 id 同时给时，覆盖对象优先（法规参数必须能被调用方覆盖）
    const both = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', subband_override: custom })
    assert.equal(both.effectiveDutyCycleLimit, 0.005)
    assert.equal(both.subbandLabel, custom.label, '覆盖对象应取代内置 M 段')

    // 网络侧策略独立于频谱法规：LoRaWAN 三个强制信道与 TTN 额度
    assert.deepEqual(LORAWAN_EU868_MANDATORY_CHANNELS_MHZ, [868.1, 868.3, 868.5])
    assert.equal(TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay, 30)
    assert.equal(TTN_FAIR_USE_POLICY.downlinkMessagesPerDay, 10)
  })

  /* ── ③ 工具行为 ─────────────────────────────────────────────── */

  test('duty 动作：SF7 每 60 s 一包满足 M 段 1% 占空比，并给出完整预算；法规与网络额度分开报', () => {
    const r = dispatch({
      action: 'duty',
      ...GOOD_ARGS,
      subband: 'm',
      regime: 'duty-cycle',
      target_period_sec: 60,
      network_air_time_sec_per_day: TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay,
    })
    assert.equal(ms3(r.formulaToaSec), 51.456)
    assert.equal(r.airTimeSecUsed, r.formulaToaSec, '未给 extra_overhead_sec 时两者相等')
    assert.equal(r.effectiveDutyCycleLimit, 0.01)
    assert.equal(r.maxTransmitSecPerHour, 36, '1% × 3600 = 36 s/h')
    assert.equal(r.maxPacketsPerHour, 699)
    assert.equal(r.maxPacketsPerDay, 16791)
    near(r.minPeriodSec, 5.1456, 1e-9, '最小周期 = Ton / DC')
    near(r.requiredSilenceSec, 5.094144, 1e-9, '发完静默 = Ton × (1/DC − 1)')

    // 每 60 s 一包 → 3600/60 = 60 包 → 3.08736 s = 0.08576%
    assert.equal(r.packets, 60)
    near(r.usedTransmitSec, 3.08736, 1e-9, '累计在线时间')
    near(r.usedDutyCycle, 0.0008576, 1e-12, '实际占空比')
    assert.equal(r.checks.find((c) => c.name === '占空比').pass, true)
    assert.equal(r.warnings.filter((w) => w.includes('超出占空比')).length, 0)

    // 法规过、网络额度不过 —— 两把尺子必须分开报
    assert.equal(r.checks.find((c) => c.name === '网络侧每日上行空中时间').pass, false)
    assert.ok(r.warnings.some((w) => w.includes('网络侧额度')), '网络额度不够必须单独告警')
    assert.ok(r.warnings.some((w) => w.includes('不是频谱法规')))

    // 额外开销必须真的进入占空比口径（这是 lib 特意留给调用方的一项）
    const withOv = dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'duty-cycle', extra_overhead_sec: 0.003 })
    assert.equal(ms3(withOv.formulaToaSec), 51.456)
    assert.equal(ms3(withOv.airTimeSecUsed), 54.456)
    assert.ok(withOv.notes.some((n) => n.includes('射频实际在线时间')), '必须写明占空比用的是哪一个口径')
  })

  test('compare 动作：SF7→SF12 的 Ts 翻倍、空中时间单调递增、逐 SF 的 LDRO 与 16 ms 规则一致', () => {
    const cmp = dispatch({ action: 'compare', ...GOOD_ARGS, subband: 'm' })
    assert.equal(cmp.rows.length, 6)
    assert.equal(cmp.codingRateLabel, '4/5')
    assert.deepEqual(cmp.rows.map((r) => r.sf), [7, 8, 9, 10, 11, 12])
    assert.deepEqual(
      cmp.rows.map((r) => ms3(r.toaSec)),
      [51.456, 102.912, 185.344, 329.728, 741.376, 1318.912],
    )
    // SF12 那档同样落在公开基准 1318.912 ms 上（PL19 与 PL20 的 npayload 恰好都是 28）
    assert.equal(ms3(cmp.rows[5].toaSec), 1318.912)

    // LDRO：SF11/SF12 @125 kHz 自动翻到 on，SF7~SF10 为 off
    assert.deepEqual(cmp.rows.map((r) => r.ldro), [false, false, false, false, true, true])
    assert.ok(cmp.rows.every((r) => r.ldro === r.ldroRequired), '逐 SF 的 LDRO 必须与手册要求一致')
    assert.deepEqual(cmp.checks.filter((c) => c.name.startsWith('LDRO')).map((c) => c.pass), [true, true, true, true, true, true])

    // 实现自检：Ts 严格翻倍、空中时间单调递增
    assert.ok(cmp.checks.filter((c) => c.name.startsWith('Ts 比例')).every((c) => c.pass))
    assert.ok(cmp.rows.every((r, i) => i === 0 || r.toaSec > cmp.rows[i - 1].toaSec))

    // 占空比换算：SF 越高每小时允许的包数越少（灵敏度换占空比）
    assert.deepEqual(cmp.rows.map((r) => r.maxPacketsPerHour), [699, 349, 194, 109, 48, 27])
    assert.ok(cmp.rows.every((r, i) => i === 0 || r.maxPacketsPerHour <= cmp.rows[i - 1].maxPacketsPerHour))
    // SF12 每 131.8912 s 才允许发一包 → "每 10 s 上报一次"在 SF12 下不可能
    near(cmp.rows[5].minPeriodSec, 131.8912, 1e-9, 'SF12 在 1% 下的最小周期')
    assert.ok(cmp.rows[5].minPeriodSec > 10)

    // 不给子频段 → 只对比空中时间，占空比字段为 null（不假装有区域信息）
    const noBand = dispatch({ action: 'compare', ...GOOD_ARGS })
    assert.equal(noBand.subband, null)
    assert.ok(noBand.rows.every((r) => r.dutyCycleLimit === null && r.maxPacketsPerHour === null))
    // sf_list 可自定义
    assert.deepEqual(dispatch({ action: 'compare', ...GOOD_ARGS, sf_list: [12, 7] }).rows.map((r) => r.sf), [12, 7])
  })

  test('工具形状：name=lora_airtime、参数 ≤ 20 且都有中文说明、三动作齐备且返回 { checks, warnings, notes }', () => {
    assert.equal(tool.name, 'lora_airtime')
    assert.equal(typeof tool.title, 'string')
    assert.ok(tool.title.length > 0)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 200, 'description 应说清做什么/要什么输入/给什么输出/硬约束')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.summaryLines, 'function')

    // 参数数量硬约束
    assert.ok(PARAM_NAMES.length <= 20, `参数不得超过 20 个，实际 ${PARAM_NAMES.length}`)
    for (const name of PARAM_NAMES) {
      const p = tool.parameters[name]
      assert.ok(typeof p.type === 'string', `${name} 缺少 type`)
      assert.ok(typeof p.description === 'string' && p.description.length > 0, `${name} 缺少说明`)
      assert.ok(/[\u4e00-\u9fff]/.test(p.description), `${name} 的说明应为中文`)
    }
    // action 的 enum 与实现的动作表一致，且三个建议动作都在
    assert.deepEqual(tool.parameters.action.enum, TOOL_ACTIONS)
    assert.deepEqual(TOOL_ACTIONS.slice().sort(), ['airtime', 'compare', 'duty'])
    assert.equal(tool.parameters.action.required, true)

    // 三个动作都返回 { checks, warnings, notes }，且 summaryLines 出具体数值行
    const branches = [
      dispatch({ action: 'airtime', ...GOOD_ARGS }),
      dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'duty-cycle', target_period_sec: 60 }),
      dispatch({ action: 'compare', ...GOOD_ARGS, subband: 'm' }),
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
    // airtime 的数值行要带上关键数
    const airText = tool.summaryLines(branches[0]).join('\n')
    assert.ok(airText.includes('51.456'))
    assert.ok(airText.includes('Ts'))
    assert.ok(airText.includes('Tpreamble'))
    assert.ok(airText.includes('ToA'))
    // compare 的数值行是逐 SF 的表
    const cmpText = tool.summaryLines(branches[2]).join('\n')
    assert.ok(cmpText.includes('1318.912'))
    assert.ok(cmpText.includes('699'))
    // 未识别的 action / 非对象一律返回空数组，不抛错
    assert.deepEqual(tool.summaryLines({ action: 'nope' }), [])
    assert.deepEqual(tool.summaryLines(null), [])
  })

  /* ── ④ 负向用例 ─────────────────────────────────────────────── */

  test('负向：SF12 每 60 s 一包违反 M 段 1% 占空比（法规侧被"占空比"这一条挡住）', () => {
    const r = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'm', regime: 'duty-cycle', target_period_sec: 60 })
    const dc = r.checks.find((c) => c.name === '占空比')
    assert.equal(dc.pass, false)
    // 60 包 × 1.318912 s = 79.13472 s = 2.1982% > 1%
    assert.equal(r.packets, 60)
    near(r.usedTransmitSec, 79.13472, 1e-9, '累计在线时间')
    near(r.usedDutyCycle, 0.021981866666666666, 1e-12, '实际占空比 2.1982%')
    assert.ok(r.usedDutyCycle > r.effectiveDutyCycleLimit)
    assert.ok(r.warnings.some((w) => w.includes('超出占空比')), '超限必须告警')
    assert.ok(r.warnings.some((w) => w.includes('拉长周期到')), '告警要给出可行方向（拉长周期）')
    assert.ok(r.warnings.some((w) => w.includes('降 SF')), '告警要指出降 SF 才省时间')

    // 同一包放到 O 段（10%）就合规 —— 说明挡住的确实是占空比这一条，而非空中时间本身
    const oSeg = dispatch({ action: 'duty', ...SF12_ARGS, subband: 'o', regime: 'duty-cycle', target_period_sec: 60 })
    assert.equal(oSeg.effectiveDutyCycleLimit, 0.1)
    assert.equal(oSeg.maxTransmitSecPerHour, 360)
    assert.equal(oSeg.checks.find((c) => c.name === '占空比').pass, true)
    assert.equal(oSeg.warnings.length, 0)
  })

  test('负向：非法参数一律报错点名（单位防呆 / 越界 / 未知子频段 / 未知 action / 缺必填）', () => {
    // 缺必填：不给默认值，一次性点名
    assert.throws(() => dispatch({ action: 'airtime' }), /需要 sf/)
    assert.throws(() => dispatch({ action: 'airtime', sf: 7 }), /需要 bw_hz/)
    assert.throws(() => dispatch({ action: 'compare' }), /需要 bw_hz/)
    assert.throws(() => dispatch({ action: 'duty', ...GOOD_ARGS }), /需要 subband/)

    // 单位防呆：把 kHz 当 Hz 传必须报错，而不是静默算出大 1000 倍的结果
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, bw_hz: 125 }), /太小|kHz/)
    // 越界与非法取值
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, sf: 13 }), /sf 必须是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, sf: 0 }), /sf 必须是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, payload_bytes: 0 }), /payloadBytes 必须是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, payload_bytes: 256 }), /payloadBytes 必须是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, coding_rate: '4/9' }), /未知的编码率/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, preamble_symbols: 4 }), /preambleSymbols 必须是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, ldro: 'maybe' }), /ldro 只能是/)
    assert.throws(() => dispatch({ action: 'airtime', ...GOOD_ARGS, extra_overhead_sec: -1 }), /extraOverheadSec 必须是/)
    assert.throws(() => dispatch({ action: 'compare', ...GOOD_ARGS, sf_list: [] }), /非空数组/)

    // 占空比侧：未知子频段 / 非法 regime / 非法包数 / 调用方给坏的法规参数
    assert.throws(() => dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'zz' }), /未知的 EU868 子频段/)
    assert.throws(() => dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'lbt' }), /regime 只能是/)
    assert.throws(
      () => dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'duty-cycle', packets_per_window: -1 }),
      /packetsPerWindow 必须非负/,
    )
    assert.throws(
      () => dispatch({ action: 'duty', ...GOOD_ARGS, subband: 'm', regime: 'duty-cycle', target_period_sec: 0 }),
      /targetPeriodSec 必须为正数/,
    )
    // 覆盖对象里的占空比也要被校验（不能因为"是调用方给的"就跳过）
    assert.throws(
      () => dispatch({ action: 'duty', ...GOOD_ARGS, subband_override: { id: 'x', label: 'x', dutyCycle: 1.5 } }),
      /dutyCycle 必须落在/,
    )

    // 未知 action
    assert.throws(() => dispatch({ action: 'duty_cycle' }), /未知 action/)
  })
}
