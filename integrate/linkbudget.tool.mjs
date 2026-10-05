/**
 * `link_budget` 工具描述符 —— 把 lib/linkbudget.js 包成 DSH 工具。
 *
 * 本文件**只做参数映射、单位口径说明与展示**，不复制、不改写 lib/linkbudget.js 的任何
 * 公式、常数与判定逻辑。FSPL 常数（20·log10(4π/c) = −147.552217 及四种单位形式的折算）、
 * 全部文献基准向量、LOSS_ITEMS 的逐项定义与出处，都留在 lib/linkbudget.js 的文件头与导出里。
 *
 * 四个动作对应 lib 里的三组入口：
 *   budget   → linkBudget（链路预算闭合：余量 = P_rx − 灵敏度，两层判定）
 *   distance → maxDistanceFromLink（由可承受路径损耗反推最大理论距离）
 *   fspl     → fsplDb + wavelengthM（只算单个路径损耗，不做闭合判定）
 *   bands    → compareBands（同距离多频段 FSPL 与余量对比）
 *
 * ── 单位口径（本包装层唯一的硬性收敛）────────────────────────────────────
 * 接口一律只收 **SI：距离用米（m）、频率用赫兹（Hz）**。km 请乘 1000，MHz 请乘 1e6。
 * 理由：FSPL 的四种对数形式（m+Hz / km+MHz / km+GHz / m+MHz）完全等价，混用单位是这类
 * 计算最常见的错源（把 868 MHz 写成 868 Hz 会静默偏 120 dB）。lib 把四者都导出且用精确
 * 常数，四种形式的等价性由 integrate/linkbudget.cases.mjs 直接对 lib 断言，不靠本工具的口径。
 *
 * ── 硬约束（与 lib 一致，本包装层不放松）──────────────────────────────────
 * **所有损耗项与灵敏度都必须由调用方传入，lib 不内置任何扣减默认值。**
 * losses 数组里没出现的项，lib 会计 0 并逐项写进结果的 notIncluded 与 notes；
 * 没给灵敏度就没有余量（marginDb 为 null），也没有"链路能通"的判定。
 * 本包装层额外做了三件事，都只是"把静默的坑变响"：
 *   ① 拒绝未知的 losses 项名（lib 会**静默丢弃**拼错的键，那等于凭空多出几 dB 余量）；
 *   ② losses 出现负值时给告警（lib 按算术把它当增益叠加）；
 *   ③ losses 项填 0 时给说明（lib 视为"已计入"，该项会从"未计入"清单里消失）。
 *
 * 返回值一律含 `checks` / `warnings` / `notes` 三个键（形状与 lib/i2c.js 一致），
 * 具体数值挂在各自动作的分支字段上，供 `summaryLines` 渲染。
 *
 * @module dsh-embedded-kit/integrate/linkbudget.tool
 */

import {
  compareBands,
  FSPL_CONSTANTS,
  FSPL_CONSTANT_M_HZ_DB,
  fsplDb,
  LOSS_ITEMS,
  LOSS_ITEM_KEYS,
  linkBudget,
  maxDistanceFromLink,
  wavelengthM,
} from '../lib/linkbudget.js'

/** 可用的动作。 */
const ACTIONS = ['budget', 'distance', 'fspl', 'bands']

/**
 * 频率 → 便于阅读的标签（纯展示用途，与 lib 内部同名的私有函数口径一致，不影响计算）。
 *
 * @param {number} hz - 频率（Hz）。
 * @returns {string} 形如 `433 MHz` / `2.4 GHz`。
 */
function freqLabel(hz) {
  if (!(hz > 0)) return '—'
  if (hz % 1e9 === 0) return `${hz / 1e9} GHz`
  if (hz % 1e6 === 0) return `${hz / 1e6} MHz`
  if (hz % 1e3 === 0) return `${hz / 1e3} kHz`
  return `${hz} Hz`
}

/**
 * 距离 → 便于阅读的标签（纯展示用途）。
 *
 * @param {number} m - 距离（m）。
 * @returns {string} 形如 `38.63 km` / `100 m`。
 */
function metersLabel(m) {
  return m >= 1000 ? `${Number((m / 1000).toFixed(3))} km` : `${Number(m.toFixed(3))} m`
}

/**
 * 校验必填的数值参数，缺谁一次性点名；需要正的项再单独判正负。
 *
 * **不补默认值**：频率与距离是 FSPL 的必要输入，灵敏度与发射功率直接决定余量，
 * 替调用方猜一个"常见值"正是本模块要防的事。
 *
 * 注意负值不能一刀切：**灵敏度通常就是负的**（−137 dBm），发射功率也可能是 −20 dBm，
 * 所以只有频率与距离按"必须为正"判，其余只判"是不是有限数"。
 *
 * @param {object} args - 工具入参。
 * @param {Array<[string, string, boolean?]>} spec - [参数名, 单位说明, 是否必须为正] 列表。
 * @param {string} action - 动作名，用于报错文案。
 * @throws {Error} 缺参数、非法数值或应当为正却非正时抛出。
 */
function requireNumbers(args, spec, action) {
  const missing = spec.filter(([n]) => !Number.isFinite(args[n]))
  if (missing.length > 0) {
    throw new Error(
      `action=${action} 需要 ${missing.map(([n, u]) => `${n}（${u}）`).join(' / ')}。` +
        '这些量全部由调用方给出，本工具不会替你假设默认值。',
    )
  }
  for (const [n, u, positive] of spec) {
    if (positive && !(args[n] > 0)) {
      throw new Error(`action=${action} 的 ${n} 必须是正数（${u}），收到 ${JSON.stringify(args[n])}`)
    }
  }
}

/**
 * 把工具的 `losses: [{ name, db }]` 数组转成 lib 要的 `{ [key]: db }` 对象。
 *
 * 逐项校验键名属于 lib 的 LOSS_ITEM_KEYS —— lib 的 collectLosses 只遍历自己的键，
 * **未知键会被静默忽略**（既不计入总扣减，也不出现在 notIncluded 里），
 * 那意味着一个拼错的键名会让"该扣的几 dB"凭空消失。这个静默失败必须在包装层拦掉。
 *
 * @param {*} list - 工具入参 args.losses。
 * @returns {Record<string, number>|undefined} lib 接受的 losses；未传时返回 undefined。
 * @throws {Error} 形状非法、键名未知或数值非法时抛出。
 */
function lossesFromArray(list) {
  if (list === undefined || list === null) return undefined
  if (!Array.isArray(list)) {
    throw new Error(
      `losses 必须是数组，形如 [{ name: 'fadeMarginDb', db: 10 }]，收到 ${typeof list}。` +
        `可用的 name：${LOSS_ITEM_KEYS.join(' / ')}`,
    )
  }
  /** @type {Record<string, number>} */
  const out = {}
  list.forEach((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`losses[${i}] 必须是形如 { name, db } 的对象，收到 ${JSON.stringify(item)}`)
    }
    const { name, db } = item
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`losses[${i}].name 必须是非空字符串（lib 的扣减项键名），收到 ${JSON.stringify(name)}`)
    }
    if (!LOSS_ITEM_KEYS.includes(name)) {
      throw new Error(
        `losses[${i}].name = '${name}' 不是 lib 的扣减项键名，已被拒绝：` +
          'lib 对未知键是**静默忽略**的，那会让你以为扣了、其实一分没扣。' +
          `可用键名：${LOSS_ITEM_KEYS.join(' / ')}`,
      )
    }
    if (!Number.isFinite(db)) {
      throw new Error(`losses[${i}].db 必须是有限数（dB），收到 ${JSON.stringify(db)}`)
    }
    out[name] = db
  })
  return out
}

/**
 * losses 里两类"值合法但语义容易出错"的取值，摘出来提醒。
 *
 * 只做提示，不修改任何数值 —— lib 已经按它自己的算术把结果算完了。
 *
 * @param {*} list - 工具入参 args.losses。
 * @returns {{notes: string[], warnings: string[]}} 追加的说明与告警。
 */
function lossAnnotations(list) {
  const notes = []
  const warnings = []
  if (!Array.isArray(list)) return { notes, warnings }
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { name, db } = item
    if (typeof name !== 'string' || !(name in LOSS_ITEMS)) continue
    const label = LOSS_ITEMS[name].label
    if (Number.isFinite(db) && db < 0) {
      warnings.push(
        `losses 里的 ${name}（${label}）= ${db} dB 是**负值**：lib 按算术把它当成增益叠加，余量会因此变大。` +
          '扣减项按定义应为非负（要表达增益请写进 tx_antenna_gain_dbi / rx_antenna_gain_dbi）。',
      )
    }
    if (db === 0) {
      notes.push(
        `losses 里的 ${name}（${label}）= 0：lib 把它视为"已计入"，该项因此从结果的 notIncluded 清单里消失，` +
          '但实际没有扣掉任何东西。请确认 0 就是你实测或设计的结果，而不是"随手填个 0"。',
      )
    }
  }
  return { notes, warnings }
}

/* ------------------------------------------------------------------ */
/* 动作 3：fspl（只算路径损耗）                                          */
/* ------------------------------------------------------------------ */

/**
 * 单算自由空间路径损耗，并给出该点位的波长与所用常数。
 *
 * 这里**不做链路预算闭合判定**（没有发射功率与灵敏度的位置），
 * 远场只做 d ≥ λ 的粗判；严格判据 d > 2D²/λ 需要天线最大尺寸，
 * 走 action=budget（lib 会在那里做）。
 *
 * @param {object} args - 工具入参。
 * @returns {object} 含 checks / warnings / notes 的结果。
 * @throws {Error} 频率或距离缺失、非正数时抛出。
 */
function runFspl(args) {
  requireNumbers(
    args,
    [
      ['frequency_hz', 'Hz，km/MHz 请先换算成 SI', true],
      ['distance_m', 'm', true],
    ],
    'fspl',
  )
  const frequencyHz = args.frequency_hz
  const distanceM = args.distance_m
  const lambda = wavelengthM(frequencyHz)
  const value = fsplDb(distanceM, frequencyHz)

  const checks = []
  const warnings = []
  const notes = []

  const inFarField = distanceM >= lambda
  checks.push({
    name: '远场适用性（粗判 d ≥ λ）',
    pass: inFarField,
    detail: `d = ${distanceM} m，λ = c/f = ${lambda.toFixed(4)} m。严格判据是 d > 2D²/λ，要给天线最大尺寸请走 action=budget。`,
  })
  if (!inFarField) {
    warnings.push(
      `距离 ${distanceM} m 小于一个波长 ${lambda.toFixed(4)} m：已进入近场，FSPL 不适用，这个数值没有物理意义。`,
    )
  }

  notes.push(
    'FSPL 只含几何扩散：不含地形、绕射、多径、遮挡、植被、穿墙、雨衰、大气吸收（>10 GHz 才显著）。' +
      '它是路径损耗的**下限**，真实损耗一定 ≥ FSPL。',
  )
  notes.push(
    '本动作只算路径损耗，没有扣减项、没有灵敏度，因此**没有余量、也没有"链路能通"的结论**。' +
      '要做闭合判定请走 action=budget，要反推距离请走 action=distance。',
  )
  notes.push(
    `单位口径：本工具只收 SI（距离 m、频率 Hz），本次用的是 20·log10(d_m) + 20·log10(f_Hz) + ` +
      `(${FSPL_CONSTANT_M_HZ_DB.toFixed(6)})，即文献里习惯写作 −147.55 的那个常数。`,
  )

  return {
    action: 'fspl',
    frequencyHz,
    frequencyMhz: frequencyHz / 1e6,
    wavelengthM: lambda,
    distanceM,
    fsplDb: value,
    fsplConstMhzDb: FSPL_CONSTANT_M_HZ_DB,
    fsplConstKmMhzDb: FSPL_CONSTANTS.km_mhz.constantDb,
    fsplConstKmMhzPublishedDb: FSPL_CONSTANTS.km_mhz.publishedDb,
    checks,
    warnings,
    notes,
  }
}

/* ------------------------------------------------------------------ */
/* 动作分派                                                             */
/* ------------------------------------------------------------------ */

/**
 * 按 action 分派到 lib/linkbudget.js 的对应函数。
 *
 * 同步实现，供用例直接调用，不依赖宿主 test 是否 await。
 *
 * @param {object} args - 模型传入的参数。
 * @returns {object} 含 checks / warnings / notes 的结果。
 * @throws {Error} 参数缺失、非法或未知 action 时抛出。
 */
function dispatch(args = {}) {
  const action = args.action
  if (!ACTIONS.includes(action)) {
    throw new Error(`未知 action：${JSON.stringify(action)}。可用：${ACTIONS.join(' / ')}（budget / distance / fspl / bands）`)
  }

  if (action === 'fspl') return runFspl(args)

  const losses = lossesFromArray(args.losses)
  const { notes: lossNotes, warnings: lossWarnings } = lossAnnotations(args.losses)

  /** @type {object} */
  let result

  if (action === 'budget') {
    requireNumbers(
      args,
      [
        ['frequency_hz', 'Hz', true],
        ['distance_m', 'm', true],
      ],
      action,
    )
    result = {
      action,
      ...linkBudget({
        frequencyHz: args.frequency_hz,
        distanceM: args.distance_m,
        txPowerDbm: args.tx_power_dbm,
        rxSensitivityDbm: args.rx_sensitivity_dbm,
        txAntennaGainDbi: args.tx_antenna_gain_dbi,
        rxAntennaGainDbi: args.rx_antenna_gain_dbi,
        losses,
        requiredMarginDb: args.required_margin_db,
        largestAntennaDimensionM: args.largest_antenna_dimension_m,
      }),
    }
  } else if (action === 'distance') {
    requireNumbers(
      args,
      [
        ['frequency_hz', 'Hz', true],
        ['tx_power_dbm', 'dBm（可以为负，如 −20）', false],
        ['rx_sensitivity_dbm', 'dBm（通常就是负值，必须取自手册或实测）', false],
      ],
      action,
    )
    result = {
      action,
      ...maxDistanceFromLink({
        frequencyHz: args.frequency_hz,
        txPowerDbm: args.tx_power_dbm,
        rxSensitivityDbm: args.rx_sensitivity_dbm,
        txAntennaGainDbi: args.tx_antenna_gain_dbi,
        rxAntennaGainDbi: args.rx_antenna_gain_dbi,
        losses,
        requiredMarginDb: args.required_margin_db,
        largestAntennaDimensionM: args.largest_antenna_dimension_m,
      }),
    }
  } else {
    requireNumbers(args, [['distance_m', 'm', true]], action)
    const frequenciesHz = args.frequencies_hz
    if (!Array.isArray(frequenciesHz) || frequenciesHz.length === 0) {
      throw new Error(
        'action=bands 需要 frequencies_hz（非空数组，单位 Hz）。' +
          '本工具不预设"常用频段"——要对比哪些频段由你决定，且请确认它们在你的产品上合法可用。',
      )
    }
    if (Array.isArray(args.labels) && args.labels.length !== frequenciesHz.length) {
      throw new Error(
        `labels 长度 ${args.labels.length} 与 frequencies_hz 长度 ${frequenciesHz.length} 不一致：` +
          'lib 对缺位的标签会静默回退成自动格式化，那样你看到的 label 可能不是你以为的那个频段，故在此拒绝。',
      )
    }
    result = {
      action,
      ...compareBands({
        distanceM: args.distance_m,
        frequenciesHz,
        labels: args.labels,
        txPowerDbm: args.tx_power_dbm,
        rxSensitivityDbm: args.rx_sensitivity_dbm,
        txAntennaGainDbi: args.tx_antenna_gain_dbi,
        rxAntennaGainDbi: args.rx_antenna_gain_dbi,
        losses,
        requiredMarginDb: args.required_margin_db,
      }),
    }
  }

  result.notes.push(...lossNotes)
  result.warnings.push(...lossWarnings)
  return result
}

/* ------------------------------------------------------------------ */
/* summaryLines：各动作的具体数值行                                      */
/* ------------------------------------------------------------------ */

/**
 * budget 动作的数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function budgetLines(v) {
  const num = (x, n = 2) => (x === null || x === undefined ? '—' : x.toFixed(n))
  const lines = [
    `  频率 ${freqLabel(v.frequencyHz)}（λ = ${v.wavelengthM.toFixed(4)} m），距离 ${metersLabel(v.distanceM)}`,
    `  FSPL = ${num(v.fsplDb)} dB（只含几何扩散，是路径损耗的下限）`,
    `  天线增益 ${num(v.txAntennaGainDbi)} + ${num(v.rxAntennaGainDbi)} dBi；扣减合计 ${num(v.lossTotalDb)} dB（已计入 ${v.lossItems.length} 项）`,
    `  P_rx = ${v.rxPowerDbm === null ? '—（未给发射功率）' : `${num(v.rxPowerDbm)} dBm`}` +
      `，灵敏度 ${v.rxSensitivityDbm === null ? '—（未给）' : `${v.rxSensitivityDbm} dBm`}`,
    `  余量 = ${v.marginDb === null ? '—（缺发射功率或灵敏度，不做判定）' : `${num(v.marginDb)} dB`}` +
      `${v.requiredMarginDb === null ? '（未给要求余量，只判"是否为正"）' : `（要求 ≥ ${v.requiredMarginDb} dB）`}`,
  ]
  if (v.notIncluded.length > 0) {
    lines.push(`  **未计入** ${v.notIncluded.length} 项（本模块不设默认值）：${v.notIncluded.join(' / ')}`)
  }
  return lines
}

/**
 * distance 动作的数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function distanceLines(v) {
  const lines = [
    `  频率 ${freqLabel(v.frequencyHz)}（λ = ${v.wavelengthM.toFixed(4)} m）`,
    `  可承受路径损耗 = ${v.sustainablePathLossDb.toFixed(2)} dB` +
      `（P_tx ${v.txPowerDbm} dBm + 增益 ${v.txAntennaGainDbi + v.rxAntennaGainDbi} dBi − 扣减 ${v.lossTotalDb.toFixed(2)} dB − 灵敏度 ${v.rxSensitivityDbm} dBm − 要求余量 ${v.requiredMarginDb} dB）`,
    `  **d_max = ${metersLabel(v.distanceM)}**（${v.distanceKm.toFixed(3)} km）`,
    `  ⚠ 这是**纯自由空间的乐观上限**：不含地形/多径/遮挡，真实可用距离必须现场拉距实测。`,
  ]
  if (v.notIncluded.length > 0) {
    lines.push(`  **未计入** ${v.notIncluded.length} 项扣减：${v.notIncluded.join(' / ')}`)
  }
  return lines
}

/**
 * fspl 动作的数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function fsplLines(v) {
  return [
    `  FSPL(${freqLabel(v.frequencyHz)}, ${metersLabel(v.distanceM)}) = **${v.fsplDb.toFixed(3)} dB**`,
    `  λ = ${v.wavelengthM.toFixed(4)} m`,
    `  所用常数（d 用 m、f 用 Hz）= ${v.fsplConstMhzDb.toFixed(6)}` +
      `（等价的 km+MHz 形式 = ${v.fsplConstKmMhzDb.toFixed(6)}，文献习惯写作 ${v.fsplConstKmMhzPublishedDb}）`,
    `  提醒：FSPL 只含几何扩散，是路径损耗的下限；本动作不含任何扣减项，也没有余量结论。`,
  ]
}

/**
 * bands 动作的数值行。
 *
 * @param {object} v - execute 的返回值。
 * @returns {string[]} 文本行。
 */
function bandsLines(v) {
  const lines = [`  统一距离 ${metersLabel(v.distanceM)}，共 ${v.bandCount} 个频段：`]
  for (const b of v.bands) {
    lines.push(
      `    ${b.label.padStart(9)}  λ=${b.wavelengthM.toFixed(3)} m  FSPL=${b.fsplDb.toFixed(2)} dB` +
        `（比最低频段 +${b.deltaVsLowestDb.toFixed(2)} dB）` +
        `${b.marginDb === null ? '  未算余量' : `  余量=${b.marginDb.toFixed(2)} dB`}`,
    )
  }
  lines.push('  提醒：换频段的代价 = 20·log10(f2/f1)，只随频率变化、与距离无关；')
  lines.push('        但别简化成"低频一定更好"——该频率项来自接收天线有效面积 λ²/(4π)，两端物理尺寸不变时增益会抵消一部分。')
  return lines
}

/* ------------------------------------------------------------------ */
/* 工具描述符                                                            */
/* ------------------------------------------------------------------ */

export const tool = {
  name: 'link_budget',
  title: '无线链路预算（自由空间路径损耗 / 链路闭合 / 最大距离 / 频段对比）',
  description:
    '无线链路预算（协议中立：Sub-GHz / LoRa / BLE / 2.4 GHz 私有协议 / NB-IoT 都适用）。' +
    '核心关系只有两条：FSPL(dB) = 20·log10(d_m) + 20·log10(f_Hz) + 20·log10(4π/c)，其中 20·log10(4π/c) = −147.552217（即文献里写作 −147.55 的那个常数，出自 Wikipedia《Free-space path loss》/ ITU-R P.525 / Friis 1946）；' +
    '以及 P_rx = P_tx + G_tx + G_rx − FSPL − Σ(各项扣减)，余量 = P_rx − 灵敏度。' +
    '四种动作：' +
    '① action=budget（链路预算闭合）：给 frequency_hz / distance_m（+ 可选 tx_power_dbm、rx_sensitivity_dbm、两端天线增益、losses、required_margin_db、largest_antenna_dimension_m），' +
    '返回 FSPL、波长、EIRP、扣减明细与合计、P_rx、余量，并分两层判定：余量 > 0（能闭合）与 余量 ≥ 你要求的余量（达标）；给了天线最大尺寸还会按 d > 2D²/λ 判远场。' +
    '② action=distance（反推最大距离）：给 frequency_hz / tx_power_dbm / rx_sensitivity_dbm（+ 可选增益、losses、required_margin_db），先算"可承受路径损耗"，再反解 d_max = 10^((可承受损耗 − 20log10(f) + 147.552217)/20)。' +
    '③ action=fspl（单算路径损耗）：只要 frequency_hz / distance_m，返回该点位的 FSPL、波长与所用常数，不做闭合判定。' +
    '④ action=bands（多频段对比）：给 distance_m / frequencies_hz（非空数组，Hz），逐频段列 FSPL 与"比最低频段多几 dB"；若同时给发射功率与灵敏度，还会逐频段算余量。' +
    '返回值统一为 { checks, warnings, notes } 加该动作的具体数值（checks 每项形如 { name, pass, detail }）。' +
    '硬约束（请如实对待）：' +
    '**（1）所有损耗项与灵敏度必须由调用方传入，本模块不内置任何扣减默认值。**' +
    'losses 传 [{ name, db }]，name 取 txCableDb / rxCableDb / fadeMarginDb / bodyLossDb / mismatchLossDb / polarizationLossDb / temperatureDriftDb / additionalDb；' +
    '**没传的项一律计 0，并逐项写进结果的 notIncluded 与 notes 点名"未计入哪一项"**。' +
    '为什么不设默认值：每一项的物理机理与影响对象都不同，同一个项在不同频段/环境下能差几十 dB（如城区 99.9% 可用度约需 8–12 dB 衰落余量，地面微波 99.99% 约需 30–40 dB），没有任何一个数字能"通用"地替换它们。' +
    '（2）**灵敏度必须取自器件手册或实测**（同一芯片不同 SF/BW/速率可差几十 dB），没给就没有余量（marginDb 为 null），也没有"链路能通"的判定；本工具绝不假设。' +
    '（3）**要求余量也要你给**（required_margin_db）：不给就只判"余量是否为正"，不判"是否达标"；要求值由你按环境与目标可用度确定。' +
    '（4）接口只收 SI 单位：距离米、频率赫兹。km 请乘 1000，MHz 请乘 1e6，工具内不做单位猜测（混用单位是这类计算最常见的错源，把 868 MHz 写成 868 Hz 会静默偏 120 dB）。' +
    '（5）**FSPL 只含几何扩散**，不含地形、绕射、多径、遮挡、植被、穿墙、雨衰、大气吸收；它是路径损耗的下限，所以任何 d_max 都是**乐观上限**，真实可用距离必须现场拉距实测（或用 ITU-R P.526/P.833/P.1411 等模型修正）。线缆/接头插损、天线失配、极化、温漂属于必须查厂家数据或实测的项，请用实测值替换。' +
    '（6）本包装层额外拒绝两种静默失败：**未知的 losses 项名**（lib 会静默丢弃拼错的键，那等于凭空多出几 dB 余量）与**labels 与 frequencies_hz 长度不一致**；losses 出现负值、或某项填 0 时也会分别给告警与说明。',
  parameters: {
    action: {
      type: 'string',
      required: true,
      enum: ACTIONS,
      description:
        'budget=链路预算闭合（频段+距离+可选功率/灵敏度/扣减，判余量与达标）；' +
        'distance=反推最大理论距离（必给 tx_power_dbm 与 rx_sensitivity_dbm）；' +
        'fspl=只算自由空间路径损耗（只要 frequency_hz + distance_m）；' +
        'bands=同距离多频段 FSPL 对比（要 distance_m + frequencies_hz）。',
    },
    frequency_hz: {
      type: 'number',
      description:
        '频率，**单位必须是 Hz**：433 MHz 传 433000000，868 MHz 传 868000000，2.4 GHz 传 2400000000。' +
        'budget / distance / fspl 必填；bands 用 frequencies_hz 代替。传 kHz 或 MHz 的数值会静默偏几十到上百 dB，所以请勿省略换算。',
    },
    distance_m: {
      type: 'number',
      description:
        '距离，**单位必须是 m**：100 m 传 100，5 km 传 5000。budget / fspl / bands 必填；distance 动作不需要（它就是要求距离）。',
    },
    frequencies_hz: {
      type: 'array',
      description:
        '仅 bands 有效：待对比的频率列表，单位 Hz，非空数组，如 [433000000, 868000000, 2400000000]。' +
        '本工具**不预设"常用频段"**——要对比哪些由你决定，且请自行确认这些频段在你的产品与销售地合法可用（法规功率上限与占空比不在本工具范围内）。',
    },
    labels: {
      type: 'array',
      description:
        '仅 bands 有效：与 frequencies_hz 一一对应的显示标签（如 ["433 MHz 私有协议", "LoRa EU868"]），长度必须与 frequencies_hz 一致。不给就按频率自动格式化。',
    },
    tx_power_dbm: {
      type: 'number',
      description:
        '发射功率（dBm）。budget 与 bands 可选（不给则不算 P_rx 与余量）；**distance 必填**（本工具不提供默认发射功率）。' +
        '填的是射频口实测/规格值，不是芯片 datasheet 的"典型输出"——后者在带外滤波与匹配后常有偏差。',
    },
    rx_sensitivity_dbm: {
      type: 'number',
      description:
        '接收灵敏度（dBm），一般填负值（如 LoRa SF12/125 kHz 约 −137，SF7/125 kHz 约 −123）。' +
        '**必须取自器件手册或实测**：它随调制/带宽/扩频因子/编码率变化可达几十 dB，本工具绝不假设。' +
        'budget 与 bands 可选（不给则 marginDb 为 null，不做闭合判定）；**distance 必填**。',
    },
    tx_antenna_gain_dbi: {
      type: 'number',
      description:
        '发射天线在**链路方向**上的增益（dBi），不是峰值增益、更不是"天线标称 5 dBi"就填 5。未传按 0 dBi（各向同性）计入并在结果的 assumptions 里显式声明。',
    },
    rx_antenna_gain_dbi: {
      type: 'number',
      description: '接收天线在链路方向上的增益（dBi）。未传按 0 dBi 计入并声明。',
    },
    losses: {
      type: 'array',
      description:
        '扣减项数组，每项 { name, db }，只接受 lib 的键名（未知键会被拒绝而不是静默忽略）：' +
        'txCableDb（发射侧线缆/接头/滤波器）、rxCableDb（接收侧线缆/接头/滤波器）、fadeMarginDb（衰落余量：多径/阴影/雨衰/大气吸收）、' +
        'bodyLossDb（体损耗/手持遮挡）、mismatchLossDb（天线失配，由实测 S11 换算）、polarizationLossDb（极化失配）、' +
        'temperatureDriftDb（温漂导致的全温区退化）、additionalDb（其他：屏蔽罩/外壳/老化/生产离散性）。' +
        '**哪些项必须实测、哪些按环境设计取值，见各 name 的出处说明**（线缆/失配/极化/温漂必须查厂家数据或实测）。' +
        '**没传的项计 0 并列入 notIncluded**；db 填 0 会被视为"已计入"（该项从 notIncluded 消失但没扣任何东西）；db 为负会按增益叠加并给出告警。' +
        '注意：bands 动作下这些扣减对所有频段用同一个值，而线缆插损本身是随频率变的——做正式频段对比请按各频段分别查表。',
    },
    required_margin_db: {
      type: 'number',
      description:
        '你要求的设计余量（dB）。给了才判定"是否达标"（余量 ≥ 该值），不给就只判"余量是否为正"。' +
        '**这个值必须你给**：它由环境（室内/城区/郊区/开阔）、频段与目标可用度共同决定，没有通用数字' +
        '（文献参考仅作参考、不是默认值：城区蜂窝 99.9% ≈ 8–12 dB，室内 WLAN 10–15 dB，地面微波 99.99% ≈ 30–40 dB）。' +
        'distance 动作里它同时会从"可承受路径损耗"中预先扣掉（不给按"刚好闭合"的 0 dB 处理，得到的是理论极限而非可用距离）。',
    },
    largest_antenna_dimension_m: {
      type: 'number',
      description:
        '天线最大物理尺寸（m），用于**严格的远场（Fraunhofer）判据** d > 2D²/λ。' +
        '给了才做这条判定，不给只做 d ≥ λ 的粗判。距离落在远场起点以内时 FSPL 不成立、结果没有物理意义（近场需全波仿真或实测标定）。',
    },
  },
  /**
   * 按 action 分派到 lib/linkbudget.js 的对应函数。
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
    if (v.action === 'budget') return budgetLines(v)
    if (v.action === 'distance') return distanceLines(v)
    if (v.action === 'fspl') return fsplLines(v)
    if (v.action === 'bands') return bandsLines(v)
    return []
  },
}

/** 供自测与文档使用：本工具暴露的参数名清单。 */
export const PARAM_NAMES = Object.keys(tool.parameters)

/** 供自测与文档使用：本工具支持的动作。 */
export const TOOL_ACTIONS = ACTIONS

/** 供自测使用：`execute` 的同步内核（用例是同步的，不能 await）。 */
export { dispatch }

/** 供自测使用：lib 里被本工具用到的函数与常量，便于确认映射完整。 */
export const MAPPED_FUNCTIONS = {
  budget: [linkBudget],
  distance: [maxDistanceFromLink],
  fspl: [fsplDb, wavelengthM],
  bands: [compareBands],
  constants: [FSPL_CONSTANT_M_HZ_DB, FSPL_CONSTANTS],
  lossKeys: [LOSS_ITEM_KEYS, LOSS_ITEMS],
}
