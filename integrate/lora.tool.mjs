/**
 * `lora_airtime` 工具描述符 —— 把 lib/lora.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射与展示**，不复制、不改写 lib/lora.js 的任何算法与常量。
 * 空中时间公式的常数（Semtech SX1276/77/78/79 数据手册 Rev.7 §4.1.1.7、AN1200.13）、
 * EU868 占空比表的原文数值（ETSI EN 300 220-2 V3.2.2 Table 2 / Table 16）、
 * LDRO 的 16 ms 门限（同一数据手册 §4.1.1.6），以及全部出处登记都留在 lib/lora.js 的文件头。
 *
 * 三个动作对应 lib 里的三组入口：
 *   airtime → analyzeAirTime（单次空中时间 + LDRO / payload 上限的结构性检查）
 *   duty    → analyzeAirTime（先算出**射频实际在线时间**）→ analyzeDutyCycle（占空比合规与可用发送时长）
 *   compare → compareSpreadingFactors（同一 payload 在各 SF 下的空中时间与允许包数对比）
 *
 * duty 之所以要自己先算一遍空中时间，是因为占空比统计的是**射频实际在线时间**而不是公式 ToA
 * （EN 300 220-2 §5.4.3 按功率采样统计 Ton）。lib/analyzeDutyCycle 的入参注释已经把这条
 * 口径写在明面上；本工具把"公式 ToA + 额外开销"这一步做掉，免得调用方拿错口径。
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键（形状与 lib/i2c.js 一致），
 * 具体数值挂在各自动作的分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/lora.tool
 */

import {
  analyzeAirTime,
  analyzeDutyCycle,
  compareSpreadingFactors,
  codingRateValue,
  EU868_SUBBANDS,
  POLITE_SPECTRUM_ACCESS_LIMITS,
  TTN_FAIR_USE_POLICY,
} from '../lib/lora.js'

/** 可用的动作。 */
const ACTIONS = ['airtime', 'duty', 'compare']

/** 内置的 EU868 子频段 id（lib 的表，调用方可用 subband_override 整体覆盖）。 */
const SUBBAND_IDS = Object.keys(EU868_SUBBANDS)

/** 除 SF 之外，一次完整空中时间计算需要的参数。 */
const AIRTIME_ARGS = ['bw_hz', 'coding_rate', 'preamble_symbols', 'payload_bytes', 'crc', 'implicit_header']

/**
 * 校验一组参数是否都给全了，缺谁一次性点名。
 *
 * **不补默认值**：SF / BW / CR / 前导 / payload / CRC / 包头每一个都直接改变结果，
 * 替调用方猜一个"常见默认值"正是本模块要防的事（LoRaWAN 前导 8、Meshtastic 16，差别不小）。
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
      '这些量全部由调用方给出：SF、BW、编码率、前导符号数、payload 字节数、是否带 CRC、是否隐式包头' +
      '都会直接改变空中时间，本工具不会替你假设一个"典型值"。',
  )
}

/**
 * 把工具层的 `'auto'` / `'on'` / `'off'` 映射成 lib 接受的真值。
 *
 * @param {string|undefined} ldro - 工具入参。
 * @returns {boolean|'auto'} lib 接受的值。
 * @throws {Error} 取值非法时抛出。
 */
function ldroValue(ldro) {
  if (ldro === undefined || ldro === 'auto') return 'auto'
  if (ldro === 'on') return true
  if (ldro === 'off') return false
  throw new Error(`ldro 只能是 'auto' / 'on' / 'off'，收到 ${JSON.stringify(ldro)}`)
}

/**
 * 组装 lib 的 airTime 家族入参（camelCase）。
 *
 * @param {object} args - 工具入参。
 * @param {string} action - 动作名。
 * @returns {object} lib 入参。
 */
function airTimeInput(args, action) {
  const needsSf = action !== 'compare'
  requireArgs(args, needsSf ? ['sf', ...AIRTIME_ARGS] : AIRTIME_ARGS, action)
  const base = {
    bwHz: args.bw_hz,
    codingRate: args.coding_rate,
    preambleSymbols: args.preamble_symbols,
    payloadBytes: args.payload_bytes,
    crc: args.crc,
    implicitHeader: args.implicit_header,
    ldro: ldroValue(args.ldro),
  }
  return needsSf ? { sf: args.sf, ...base } : base
}

/**
 * 解析子频段：调用方给的覆盖对象优先，否则用内置 id。
 *
 * 法规参数（频率范围 / e.r.p. / 占空比上限 / Ton-Toff）**必须能由调用方整体覆盖**，
 * 所以这里把 subband_override 放在内置表之前；两者都给时覆盖对象优先。
 *
 * @param {object} args - 工具入参。
 * @returns {string|object} 交给 lib.resolveSubband 的值。
 * @throws {Error} 两者都没给时抛出。
 */
function subbandArg(args) {
  if (args.subband_override !== undefined && args.subband_override !== null) return args.subband_override
  if (args.subband === undefined || args.subband === null) {
    throw new Error(
      `需要 subband（内置 EU868 子频段 id：${SUBBAND_IDS.join(' / ')}），` +
        '或用 subband_override 传入你自己的子频段对象（把频率范围 / e.r.p. / 占空比上限整体覆盖掉）。' +
        '没有子频段就无法判占空比法规——本工具不会替你假设一个默认区域。',
    )
  }
  return args.subband
}

/** 是否给了子频段（内置 id 或覆盖对象）。 */
function hasSubband(args) {
  return (
    (args.subband !== undefined && args.subband !== null) ||
    (args.subband_override !== undefined && args.subband_override !== null)
  )
}

/**
 * 把 Hz 渲染成 kHz 文本。
 *
 * @param {number} hz - 频率（Hz）。
 * @returns {string} 形如 `125 kHz`。
 */
function khz(hz) {
  return `${Number((hz / 1000).toFixed(3))} kHz`
}

/* ------------------------------------------------------------------ */
/* 动作 1：airtime（单次空中时间）                                       */
/* ------------------------------------------------------------------ */

/**
 * 单次空中时间：走 lib 的 analyzeAirTime，顺带给出 LDRO 与 payload 上限的结构性检查。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runAirtime(args) {
  const r = analyzeAirTime({
    ...airTimeInput(args, 'airtime'),
    extraOverheadSec: args.extra_overhead_sec,
    maxPayloadBytes: args.max_payload_bytes,
  })
  return { action: 'airtime', ...r }
}

/* ------------------------------------------------------------------ */
/* 动作 2：duty（占空比合规与可用发送时长）                              */
/* ------------------------------------------------------------------ */

/**
 * 占空比合规：先算**射频实际在线时间**（公式 ToA + 额外开销），再交给 lib 判定。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runDuty(args) {
  const subband = subbandArg(args)

  const air = analyzeAirTime({
    ...airTimeInput(args, 'duty'),
    extraOverheadSec: args.extra_overhead_sec,
    maxPayloadBytes: args.max_payload_bytes,
  })

  const duty = analyzeDutyCycle({
    // ⚠ 口径：占空比统计的是射频实际在线时间，不是公式 ToA。见 lib/analyzeDutyCycle 的入参注释。
    airTimeSec: air.totalOnAirSec,
    subband,
    regime: args.regime,
    targetPeriodSec: args.target_period_sec,
    packetsPerWindow: args.packets_per_window,
    windowSec: args.window_sec,
    maxOnTimeSec: args.max_on_time_sec,
    networkAirTimeSecPerDay: args.network_air_time_sec_per_day,
  })

  const notes = [
    ...air.notes,
    ...duty.notes,
    `占空比用的是**射频实际在线时间** ${(air.totalOnAirSec * 1000).toFixed(3)} ms = ` +
      `公式 ToA ${(air.toaSec * 1000).toFixed(3)} ms + 额外开销 ${(air.overheadSec * 1000).toFixed(3)} ms。` +
      'EN 300 220-2 §5.4.3 用功率采样统计 Ton，所以做法规预算必须用前者；只拿公式 ToA 去算会偏乐观。',
  ]

  return {
    action: 'duty',
    ...duty,
    checks: [...air.checks, ...duty.checks],
    warnings: [...air.warnings, ...duty.warnings],
    notes,
    /** 本次空中时间分解（含 LDRO / payload 上限检查）。 */
    airTime: air,
    /** 公式口径的单包空中时间（秒）。 */
    formulaToaSec: air.toaSec,
    /** 实际参与占空比判定的在线时间（秒）。 */
    airTimeSecUsed: air.totalOnAirSec,
  }
}

/* ------------------------------------------------------------------ */
/* 动作 3：compare（SF 对比）                                            */
/* ------------------------------------------------------------------ */

/**
 * 同一 payload 在各 SF 下的空中时间与占空比可行性对比。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 */
function runCompare(args) {
  const input = airTimeInput(args, 'compare')
  const cr = codingRateValue(args.coding_rate)
  const r = compareSpreadingFactors({
    sfList: args.sf_list,
    ...input,
    extraOverheadSec: args.extra_overhead_sec,
    // 不给子频段就只做空中时间对比（lib 会把占空比相关字段置 null）。
    subband: hasSubband(args) ? subbandArg(args) : undefined,
    windowSec: args.window_sec,
  })
  return {
    action: 'compare',
    sfList: args.sf_list ?? null,
    payloadBytes: args.payload_bytes,
    codingRateLabel: `4/${cr + 4}`,
    ...r,
  }
}

/* ------------------------------------------------------------------ */
/* 分派                                                                */
/* ------------------------------------------------------------------ */

/** 动作 → 实现。 */
const RUNNERS = {
  airtime: runAirtime,
  duty: runDuty,
  compare: runCompare,
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
  const action = args.action ?? 'airtime'
  const runner = RUNNERS[action]
  if (!runner) throw new Error(`未知 action：${action}（可用：${ACTIONS.join(' / ')}）`)
  return runner(args)
}

/* ------------------------------------------------------------------ */
/* summaryLines：各动作的具体数值行                                      */
/* ------------------------------------------------------------------ */

/**
 * airtime 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function airtimeLines(v) {
  return [
    `  SF${v.sf} / BW ${khz(v.bwHz)} / CR ${v.codingRateLabel} / 前导 ${v.preambleSymbols} 符号 / ` +
      `payload ${v.payloadBytes} B / CRC ${v.crc ? '开' : '关'} / ${v.implicitHeader ? '隐式' : '显式'}包头 / ` +
      `LDRO ${v.ldro ? 'on' : 'off'}`,
    `  Ts = 2^${v.sf} / ${v.bwHz} Hz = ${(v.tsSec * 1000).toFixed(6)} ms` +
      `（16 ms 门限 → 要求 LDRO ${v.ldroRequired ? 'on' : 'off'}）`,
    `  Tpreamble = (${v.preambleSymbols} + 4.25) × Ts = ${(v.tpreambleSec * 1000).toFixed(3)} ms`,
    `  npayload = ${v.payloadSymbols} 符号 → Tpayload = ${(v.tpayloadSec * 1000).toFixed(3)} ms`,
    `  **空中时间 ToA = ${(v.toaSec * 1000).toFixed(3)} ms**（公式口径；不含 TX 起振 / PLL 锁定 / PA ramp / SPI）`,
    v.overheadSec === 0
      ? '  未叠加额外射频/MCU 开销（做法规预算时应通过 extra_overhead_sec 补上实测值）'
      : `  叠加额外开销 ${(v.overheadSec * 1000).toFixed(3)} ms → 射频实际在线 ${(v.totalOnAirSec * 1000).toFixed(3)} ms`,
    `  标称比特率 ${(v.nominalBitRateBps / 1000).toFixed(4)} kbit/s；payload 有效吞吐 ` +
      `${(v.payloadBitRateBps / 1000).toFixed(4)} kbit/s（共 ${v.totalSymbols} 符号）`,
  ]
}

/**
 * duty 的具体数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function dutyLines(v) {
  const isDuty = v.regime === 'duty-cycle'
  const lines = [
    `  ${v.subbandLabel}`,
    `  合规路径：${isDuty ? '占空比（EN 300 220-2 §4.4.3.2）' : 'polite spectrum access（Table 16）'}`,
    `  单包射频实际在线 ${(v.airTimeSec * 1000).toFixed(3)} ms` +
      `（公式 ToA ${(v.formulaToaSec * 1000).toFixed(3)} ms + 额外开销 ` +
      `${((v.airTimeSecUsed - v.formulaToaSec) * 1000).toFixed(3)} ms）`,
  ]

  if (isDuty) {
    if (v.effectiveDutyCycleLimit === null) {
      lines.push('  占空比：Table 2 写的是 "No requirement" → 无占空比上限（该段的实际约束是 e.r.p.）')
    } else {
      const windowBudget = v.maxTransmitSecPerHour * (v.windowSec / 3600)
      lines.push(
        `  占空比上限 ${(v.effectiveDutyCycleLimit * 100).toFixed(3)}%　→　观察窗 ${v.windowSec} s 内累计 ≤ ` +
          `${windowBudget.toFixed(3)} s（1 h 口径 ≤ ${v.maxTransmitSecPerHour.toFixed(1)} s，1 天 ≤ ${v.maxTransmitSecPerDay.toFixed(1)} s）`,
      )
      lines.push(
        `  按此上限：每小时 ≤ ${v.maxPacketsPerHour} 包、每天 ≤ ${v.maxPacketsPerDay} 包；` +
          `最小周期 ${v.minPeriodSec.toFixed(3)} s，发完必须静默 ≥ ${v.requiredSilenceSec.toFixed(3)} s`,
      )
    }
  } else {
    lines.push(
      `  每 200 kHz 频谱每小时累计 ≤ ${v.maxTransmitSecPerHour} s、每天 ≤ ${v.maxTransmitSecPerDay} s；` +
        `单次发射 ≤ ${POLITE_SPECTRUM_ACCESS_LIMITS.maxSingleTransmissionSec} s；` +
        `同频点静默 ≥ ${POLITE_SPECTRUM_ACCESS_LIMITS.minOffTimeSec * 1000} ms`,
    )
    lines.push(`  按此上限：每小时 ≤ ${v.maxPacketsPerHour} 包、每天 ≤ ${v.maxPacketsPerDay} 包`)
  }

  if (v.packets === null) {
    lines.push('  未给 target_period_sec / packets_per_window → 只给出预算，未判"实际用了多少"')
  } else {
    const pct = v.usedDutyCycle === null ? 'n/a（本路径不套占空比）' : `${(v.usedDutyCycle * 100).toFixed(4)}%`
    lines.push(
      `  实际：${v.windowSec} s 内 ${Number(v.packets.toFixed(3))} 包 → 累计在线 ${v.usedTransmitSec.toFixed(3)} s = ${pct}`,
    )
  }
  return lines
}

/**
 * compare 的各 SF 数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function compareLines(v) {
  const hasDuty = v.rows.length > 0 && v.rows[0].dutyCycleLimit !== null
  const lines = [
    `  payload ${v.payloadBytes} B / CR ${v.codingRateLabel} / 窗口 ${v.windowSec} s` +
      (v.subbandLabel ? ` / ${v.subbandLabel}` : ' / 未给子频段 → 只对比空中时间'),
    '  SF   Ts(ms)      LDRO  npayload  ToA(ms)' + (hasDuty ? '        上限内包数/h  最小周期(s)' : ''),
  ]
  for (const r of v.rows) {
    const row =
      `  ${String(r.sf).padStart(2)}  ${(r.tsSec * 1000).toFixed(3).padStart(9)}  ` +
      `${r.ldro ? 'on ' : 'off'}  ${String(r.payloadSymbols).padStart(7)}  ` +
      `${(r.toaSec * 1000).toFixed(3).padStart(10)}`
    lines.push(
      hasDuty
        ? `${row}  ${String(r.maxPacketsPerHour).padStart(13)}  ${r.minPeriodSec.toFixed(3).padStart(12)}`
        : row,
    )
  }
  return lines
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                          */
/* ------------------------------------------------------------------ */

/** DSH 工具描述符。 */
export const tool = {
  name: 'lora_airtime',
  title: 'LoRa 空中时间与 EU868 占空比合规（Semtech 公式 / ETSI EN 300 220-2）',
  description:
    '算 LoRa 的空中时间（Time on Air），并把它放到 EU868 的占空比法规下判合规。' +
    '公式口径出自 Semtech SX1276/77/78/79 数据手册 Rev.7 §4.1.1.7（同 AN1200.13）：' +
    'Ts=2^SF/BW、Tpreamble=(npreamble+4.25)×Ts、npayload=8+max(ceil((8PL−4SF+28+16CRC−20IH)/(4(SF−2DE)))×(CR+4),0)。' +
    '法规口径出自 ETSI EN 300 220-2 V3.2.2 (2024-03) Table 2 / Table 16 / §4.4.3。' +
    '三种动作：' +
    '① action=airtime（单次空中时间）：给 sf / bw_hz / coding_rate / preamble_symbols / payload_bytes / crc / implicit_header（+ 可选 ldro、extra_overhead_sec、max_payload_bytes），' +
    '返回 Ts、前导时长、payload 符号数与时长、**总空中时间**、总符号数、标称比特率与 payload 有效吞吐，并检查 LDRO 是否与数据手册的 16 ms 门限一致、payload 是否超给定上限。' +
    '② action=duty（占空比合规与可用发送时长）：在同一组参数上再给 subband（内置 EU868 子频段 id）或 subband_override、regime（duty-cycle / polite-spectrum-access）、' +
    '以及 target_period_sec 或 packets_per_window（+ 可选 window_sec / max_on_time_sec / network_air_time_sec_per_day），' +
    '返回该子频段的占空比上限、每个观察窗允许的累计发射秒数、每小时与每天的允许包数、两包之间的最小周期、发完必须静默多久，并判定你给的发送周期超不超限。' +
    '③ action=compare（SF 对比）：给 bw_hz / coding_rate / preamble_symbols / payload_bytes / crc / implicit_header（+ 可选 sf_list、subband），' +
    '逐 SF 列出 Ts、LDRO 实际值与手册要求、payload 符号数、空中时间，以及（给了子频段时）占空比上限内的每小时包数与最小周期，并做 Ts 翻倍与空中时间单调性的实现自检。' +
    '返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 每项形如 { name, pass, detail }）。' +
    '硬约束（请如实对待）：' +
    '（1）**法规参数可由调用方整体覆盖**——内置的 EU868_SUBBANDS 与 Table 16 限值都只是默认值，' +
    '子频段用 subband 选内置项，也可用 subband_override 直接传你自己的子频段对象（频率范围 / e.r.p. / 占空比上限 / Ton-Toff 全都会被覆盖，与 subband 同时给时覆盖对象优先）；' +
    '判某国 NRI 或私有网络的限值时，请走 subband_override 而不是指望本工具内置。' +
    '（2）**占空比统计的是射频实际在线时间，不是公式 ToA**（EN 300 220-2 §5.4.3 按功率采样统计 Ton）：' +
    '本工具先算公式 ToA，再通过 extra_overhead_sec 叠加 TX 起振 / PLL 锁定 / PA ramp / SPI 传输，用这个和做占空比判定。' +
    '**extra_overhead_sec 没有默认值**（SX127x 量级为毫秒级，必须按你的模块数据手册或实测填），不传就按 0 计并在 notes 里说明——即结果是乐观的。' +
    '（3）**不给子频段就不判占空比**：本工具不会替你假设一个默认区域；缺 subband 会直接报错并点名可用 id。' +
    '（4）**Ton / Toff 不替 868 的 LoRa 子频段编造**：EN 300 220-2 §4.4.12 的短时行为只在 "specified in Table 2 or in NRI" 时适用，' +
    '而 Table 2 对 K/L/M/N/O/P/Q 各段**没有**规定 Ton/Toff，所以这些子频段的 maxOnTimeSec / minOffTimeSec 一律为 null、该判定会被跳过。' +
    '要判这一条只能由调用方通过 max_on_time_sec 显式传入你所在国家 NRI 的数值。' +
    '（5）**占空比与 polite spectrum access 是二选一的两条合规路径**（§4.4.3.1），不是叠加约束：' +
    'Table 16 的「单次发射 ≤ 1 s / 对话或轮询序列 ≤ 4 s / 每 200 kHz 每小时累计 ≤ 100 s / 同频点静默 ≥ 100 ms」只在**选择走 polite spectrum access** 时才适用，' +
    '不要把它当成 EU868 的通用单次发射上限；走占空比路径时这些限值不参与判定（但占空比本身要满足）。' +
    '（6）**网络策略与频谱法规分开报**：LoRaWAN 三个强制信道（868.1/868.3/868.5 MHz）与 TTN Fair Use Policy（30 s/天/节点上行、10 条/天下行）是网络方策略，' +
    '与 ETSI 法规是两把尺子，可以各自独立地把方案枪毙；给 network_air_time_sec_per_day 时会单独判一条。' +
    '（7）输出全部是**设计值 / 公式口径的理论值**，不含 TX 起振与真实硬件开销，也不能替代法规符合性测试报告（占空比须按 §5.4.3 实测）。' +
    '灵敏度、发射功率上限、天线增益必须来自具体器件的数据手册与实测，本工具不内置。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ACTIONS,
      description:
        'airtime=单次空中时间（需 sf + bw_hz + coding_rate + preamble_symbols + payload_bytes + crc + implicit_header）；' +
        'duty=占空比合规与可用发送时长（在上面基础上再给 subband 或 subband_override）；' +
        'compare=各 SF 对比（同 airtime 的参数但不需 sf，可选 sf_list / subband）。',
    },
    sf: {
      type: 'integer',
      description:
        '扩频因子 SF，SX127x 系列为 6~12（SX126x 支持到 5，本工具不拦低于 6 的值）。' +
        'airtime 与 duty 必填；compare 用 sf_list 代替，不需要它。选最坏情况的那个 SF 做占空比预算。',
    },
    bw_hz: {
      type: 'integer',
      description:
        '带宽，**按公式口径必须是 Hz 而不是 kHz**：125 kHz 要传 125000。传小于 1000 的值会被判为"把 kHz 当 Hz 传"而报错（否则 Ts 会静默大 1000 倍）。',
    },
    coding_rate: {
      type: 'string',
      enum: ['4/5', '4/6', '4/7', '4/8'],
      description: '编码率 CR，对应公式里的 1~4。LoRaWAN 与多数私有网络用 4/5。',
    },
    preamble_symbols: {
      type: 'integer',
      description:
        '编程进 RegPreamble 的前导符号数，范围 6~65535。**LoRaWAN 用 8，Meshtastic 用 16**，' +
        '它直接改变空中时间，所以没有默认值、必须显式给。',
    },
    payload_bytes: {
      type: 'integer',
      description:
        'PHY 层 payload 字节数（1~255）。LoRaWAN 的 MAC 层还会再加约 13 字节（MHDR + FHDR + FPort + MIC），换算成 PHY payload 时要一起算进去。',
    },
    crc: {
      type: 'boolean',
      description: '是否带 payload CRC（对应公式分子里的 +16）。LoRaWAN 为 true。没有默认值。',
    },
    implicit_header: {
      type: 'boolean',
      description:
        '是否使用隐式包头（对应公式分子里的 −20）。LoRaWAN 用显式包头，即 false。两种取值改变结果，没有默认值。',
    },
    ldro: {
      type: 'string',
      enum: ['auto', 'on', 'off'],
      description:
        "LowDataRateOptimize 取值，默认 auto。auto 按 Semtech 数据手册 §4.1.1.6 的规则判：符号时长 > 16 ms 时强制打开" +
        '（在 125 kHz 下即 SF11/SF12）。**收发两端 LDRO 必须一致，否则收不到**；置错时算出的空中时间会偏小，是最坑的地方。',
    },
    subband: {
      type: 'string',
      enum: SUBBAND_IDS,
      description:
        `EU868 子频段 id：${SUBBAND_IDS.join(' / ')}。duty 必填（或改用 subband_override），compare 可选（给了才折算占空比）。` +
        '各段的频率范围、占空比上限与 e.r.p. 上限就是 ETSI EN 300 220-2 V3.2.2 Table 2 的原文数值。' +
        '**子频段落在哪一段取决于你最终产品的实测占用带宽（99 % OBW），不能靠推算**。',
    },
    subband_override: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true, description: '子频段标识（自定义，仅用于展示与日志）。' },
        label: { type: 'string', required: true, description: '人类可读名称，会出现在返回的 subbandLabel 里。' },
        fromMHz: { type: 'number', required: true, description: '频段下边界（MHz，含）。' },
        toMHz: { type: 'number', required: true, description: '频段上边界（MHz，含）。' },
        maxErpMw: { type: 'number', description: 'e.r.p. 上限（mW）；不填表示该段不限。' },
        dutyCycle: { type: 'number', description: '占空比上限（小数，1 % 填 0.01）；不填或 null 表示该段无占空比要求。' },
        politeSpectrumAccess: { type: 'boolean', description: '该段是否走 polite spectrum access 路径（与占空比二选一）。' },
        maxOnTimeSec: { type: 'number', description: '单次发射时长上限（s）；**没有把握就不要填**，不填即跳过该项判定。' },
        minOffTimeSec: { type: 'number', description: '发射后的最小静默时间（s）；不填即跳过。' },
      },
      description:
        '自定义子频段对象，用于**整体覆盖法规参数**（例如某国 NRI 或私有网络的规定）。形状与内置项一致：' +
        '{ id, label, fromMHz, toMHz, maxErpMw, dutyCycle, politeSpectrumAccess, maxOnTimeSec, minOffTimeSec }。' +
        'dutyCycle 用小数（1 % 填 0.01），不填表示该段无占空比要求。与 subband 同时给时本项优先。',
    },
    regime: {
      type: 'string',
      enum: ['duty-cycle', 'polite-spectrum-access'],
      description:
        '合规路径，默认 duty-cycle。二者**互斥**（EN 300 220-2 §4.4.3.1），不是叠加约束：' +
        'duty-cycle 按子频段的占空比上限判；polite-spectrum-access 按 Table 16 的 Ton/Toff/累计在线判，此时不再受占空比约束。',
    },
    target_period_sec: {
      type: 'number',
      description:
        '期望的发送周期（起-起，秒）。给了就判"这个周期合不合规"。与 packets_per_window 二选一，同时给时本项优先。',
    },
    packets_per_window: {
      type: 'integer',
      description: '或者直接给"每个观察窗想发几包"（与 target_period_sec 二选一）。',
    },
    window_sec: {
      type: 'number',
      description:
        '观察窗长度（秒），默认 3600。EN 300 220-2 §4.4.3.2 规定 Tobs 默认 1 小时，且观察带宽是**整个子频段**而不是单个信道。',
    },
    extra_overhead_sec: {
      type: 'number',
      description:
        '公式之外的额外在线时间（秒）：TX 起振 / PLL 锁定 / PA ramp / MCU 到射频的 SPI 传输。' +
        '**没有默认值**——不传按 0 计并在 notes 里标明结果是乐观值。做**法规**占空比预算时必须以实测值补上。',
    },
    max_on_time_sec: {
      type: 'number',
      description:
        '单次发射时长上限（秒）。**必须来自法规/NRI 或网络策略，不要凭感觉填**：ETSI Table 2 对 868 的 LoRa 子频段没有规定 Ton，' +
        '不给就不做这项判定（而不是替你猜一个值）。仅 duty 有效。',
    },
    max_payload_bytes: {
      type: 'integer',
      description:
        '该 SF/BW 下规范允许的最大 PHY payload 字节数。不给就不判（LoRaWAN 各 DR 的上限不同，不能一刀切）。airtime 与 duty 有效。',
    },
    network_air_time_sec_per_day: {
      type: 'number',
      description:
        '网络侧每日上行空中时间额度（秒），例如 TTN Fair Use Policy 的 30 s/天/节点。' +
        '它是**网络方策略而不是频谱法规**，会单独判一条，与 ETSI 合规分开报。仅 duty 有效。',
    },
    sf_list: {
      type: 'array',
      description:
        '仅 compare 有效：要对比的 SF 列表，默认 [7, 8, 9, 10, 11, 12]（EU868 DR0~DR5 常用）。' +
        'LDRO 置 auto 时会**逐 SF 重新判定**（SF11/SF12 @125 kHz 会翻到 on）。',
    },
  },
  /**
   * 按 action 分派到 lib/lora.js 的对应函数。
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
    if (v.action === 'airtime') return airtimeLines(v)
    if (v.action === 'duty') return dutyLines(v)
    if (v.action === 'compare') return compareLines(v)
    return []
  },
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测与文档使用：本工具支持的动作。 */
export const TOOL_ACTIONS = ACTIONS

/** 供自测使用：lib 里被本工具用到的函数，便于确认映射完整。 */
export const MAPPED_FUNCTIONS = {
  airtime: [analyzeAirTime],
  duty: [analyzeAirTime, analyzeDutyCycle],
  compare: [compareSpreadingFactors],
  helpers: [codingRateValue],
}

/** 供自测与文档使用：内置子频段 id 与工具常量（都在 lib 里，这里只是转出）。 */
export const TOOL_CONSTANTS = {
  subbandIds: SUBBAND_IDS,
  politeSpectrumAccessLimits: POLITE_SPECTRUM_ACCESS_LIMITS,
  ttnFairUsePolicy: TTN_FAIR_USE_POLICY,
}
