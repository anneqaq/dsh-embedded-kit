/**
 * `link_budget` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './linkbudget.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖四类东西：
 *   ① lib/linkbudget.js 里的 FSPL 常数与**公开文献查表基准向量**——这是整个模块最强的
 *      正确性证据，逐条钉死（2.4 GHz @ 100 m = 80.05 dB、433 MHz @ 100 m = 65.18 dB、
 *      常数 −147.552217、km+MHz 形式 32.447783 …），任何公式实现漂移都会在这里暴露；
 *   ② 四种单位形式的对数式等价性（同一物理量的四种写法必须给出同一个数）；
 *   ③ 四个动作的行为：预算闭合的两层判定、反推距离的往返自洽、多频段对比的单调性；
 *   ④ 负向用例：余量为负、参数非法、以及本包装层额外拦掉的静默失败。
 *
 * 用例全部是**同步**的，走 integrate/linkbudget.tool.mjs 导出的 `dispatch`（execute 的同步内核），
 * 这样不依赖宿主 test 实现是否 await。用例只读，不修改 lib 中任何东西。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 诚实标注 ①：常数四舍五入不统一（32.44 vs 32.45），本模块用精确值
 * ─────────────────────────────────────────────────────────────────────────────
 * 公开文献对同一个 FSPL 加性常数给出的是**四舍五入到小数点后两位**的值，而且自己就不统一：
 *   · d 用 m、f 用 Hz  → 印 −147.55（Wikipedia《Free-space path loss》）
 *   · d 用 km、f 用 MHz → 同时印 32.44 与 32.45（Wikipedia 同页 / Digi-Key）
 *   · d 用 km、f 用 GHz → 同时印 92.44 与 92.45（ITU-R P.525 印 92.45，别处印 92.44）
 *   · d 用 m、f 用 MHz  → 印 −27.55
 * 这四个数其实是**同一个物理常数** 20·log10(4π/c) 在不同单位下的折算，不是四条经验值。
 * 所以 lib/linkbudget.js 一个都不采用，而是用
 *   Math.log10 算出的 20·log10(4π/c) = −147.552217，再加单位折算量（+60、+120 …）
 * 得到 km+MHz = 32.447783（而不是 32.44，也不是 32.45）。
 *
 * 为什么必须这样：**算法不应取决于"你查的是哪本书"**。取 32.44 还是 32.45 会让同一次计算
 * 相差 0.01 dB 量级——比任何一项真实扣减都小，但它会让"逐位复现文献查表值"变成不可能
 * （下面用例 ② 里给了三者的对照：65.177541 / 65.169758 / 65.179758）。
 * 因此本文件一律**对精确值断言**，只把 publishedDb 当成"文献习惯写法"来核对量级。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 诚实标注 ②：有公开查表行**自己印错了**，已登记原因并弃用该锚点
 * ─────────────────────────────────────────────────────────────────────────────
 *   · rftools.io 的 FSPL 表把 **5 GHz @ 8 km 印成 128.0 dB**：实算
 *     20·log10(8000) + 20·log10(5e9) − 147.552217 = **124.488983 dB**，
 *     差 3.51 dB —— 这不是四舍五入能解释的量级（128.0 恰好像是把 8 km 当成 80 km，
 *     或把 GHz/MHz 的常数用错）。lib 的 FSPL_REFERENCE_ANCHORS 里**没有**这一行，
 *     本文件也不拿它当锚点，只在此登记"为什么弃用"。
 *   · rfstudiolabs.com 的 FSPL 快速参考表把 **433 MHz @ 100 m 印成 65.6 dB**，与 Digi-Key
 *     同点位的 **65 dB** 直接矛盾；实算 65.177541 dB 明确落在 Digi-Key 一侧（jscalc-blog
 *     的 900 MHz 行同源口径亦印 65.2）。故锚点采用 65.18（Digi-Key 65 dB / jscalc 65.2 dB），
 *     **不采用 65.6**。
 * 原则：锚点只取"多来源互相印证、且能被公式复现"的行；对不上的行登记原因后弃用，
 * 而不是反过来调整公式去凑它。下面用例 ④ 会用断言把这条原则固化成可执行的检查。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 诚实标注 ③：探针里那个 975 km 是"纯自由空间"理论值，不是可用距离
 * ─────────────────────────────────────────────────────────────────────────────
 * 868 MHz / P_tx = 14 dBm / 灵敏度 −137 dBm（SF12 / 125 kHz 的极限档）在没有给**任何扣减项**、
 * 要求余量按"刚好闭合"（0 dB）处理时，反推出的 d_max = **975.194 km**。
 * 它意味着：可承受路径损耗（151 dB）**全部**被 FSPL 吃掉，一分钱都没留给
 * 衰落余量、体损耗、线缆插损、天线失配、极化与温漂，更不含地形、多径、遮挡、植被、穿墙。
 * 它是"物理上界"而不是"能用的距离"：一旦按探针里那组有出处标注的示例扣减
 * （合计 18.5 dB）并保留 10 dB 设计余量，同一个链路只剩 **36.651 km**（用例 ⑦ 的往返自洽）。
 * **不要把这个 975 km 当成布点依据**，也不要把它写进方案书当指标。
 *
 * @module dsh-embedded-kit/integrate/linkbudget.cases
 */

import { LOSS_ITEM_KEYS, FSPL_CONSTANTS, FSPL_CONSTANT_M_HZ_DB, FSPL_REFERENCE_ANCHORS, fsplDb, fsplDbByUnits, LOSS_ITEMS } from '../lib/linkbudget.js'

import { dispatch, tool, PARAM_NAMES, TOOL_ACTIONS } from './linkbudget.tool.mjs'

/**
 * 一组**有出处标注的示例扣减项**（来源见 lib/linkbudget.js 的 LOSS_ITEMS 逐项 source）。
 *
 * 它们只是用例输入，**不是 lib 的默认值**——lib 里没有任何一项自带数字：
 *   0.5 dB ×2  短馈线 + 1 个接头（必须按自己的线缆查表，此处仅示例）
 *   10 dB      衰落余量（ITU-R P.530 99% 可用度量级；rftools.io 建议非关键链路 ≥10 dB）
 *   3 dB       体损耗（engineersuniverse.com：手持 3–5 dB 的下沿）
 *   0.5 dB     天线失配（rftools.io：2:1 VSWR ≈ 0.5 dB）
 *   3 dB       极化损耗（线-圆固定 3 dB；线性对准为 0）
 *   1 dB       温漂（必须实测，此处仅演示）
 * 合计 18.5 dB。故意**不**把 additionalDb 填进去，用来验证 notIncluded 会点名它。
 */
const EXAMPLE_LOSSES = [
  { name: 'txCableDb', db: 0.5 },
  { name: 'rxCableDb', db: 0.5 },
  { name: 'fadeMarginDb', db: 10 },
  { name: 'bodyLossDb', db: 3 },
  { name: 'mismatchLossDb', db: 0.5 },
  { name: 'polarizationLossDb', db: 3 },
  { name: 'temperatureDriftDb', db: 1 },
]

/** 示例扣减合计（dB），多条用例要用。 */
const EXAMPLE_LOSS_TOTAL = 18.5

/** 供 register 内部各用例复用。 */
let assert

/**
 * 浮点近似断言。
 *
 * @param {number} actual - 实际值。
 * @param {number} expected - 期望值。
 * @param {number} tol - 容差。
 * @param {string} msg - 断言说明。
 */
function near(actual, expected, tol, msg) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= tol,
    `${msg}：期望 ${expected} ±${tol}，实际 ${actual}`,
  )
}

/**
 * 把浮点值对齐到 n 位小数后做严格相等断言（用来钉"公开文献公布精度"上的数值）。
 *
 * @param {number} actual - 实际值。
 * @param {number} expected - 期望值。
 * @param {number} digits - 小数位数。
 * @param {string} msg - 断言说明。
 */
function fixedEqual(actual, expected, digits, msg) {
  near(actual, expected, 0.5 * 10 ** -digits, `${msg}（对齐到 ${digits} 位小数）`)
  assert.equal(Number(actual.toFixed(digits)), Number(expected.toFixed(digits)), msg)
}

/**
 * 全部动作都必须给出这三个键（形状与 lib/i2c.js 一致）。
 *
 * @param {object} r - 任一动作的返回值。
 * @param {string} label - 断言说明前缀。
 */
function assertResultShape(r, label) {
  assert.ok(Array.isArray(r.checks), `${label}：checks 必须是数组`)
  assert.ok(Array.isArray(r.warnings), `${label}：warnings 必须是数组`)
  assert.ok(Array.isArray(r.notes), `${label}：notes 必须是数组`)
  for (const c of r.checks) {
    assert.equal(typeof c.name, 'string', `${label}：check.name 必须是字符串`)
    assert.equal(typeof c.pass, 'boolean', `${label}：check.pass 必须是布尔`)
    assert.equal(typeof c.detail, 'string', `${label}：check.detail 必须是字符串`)
  }
}

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例（同步）。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert: nodeAssert }) {
  assert = nodeAssert

  /* ── ① 工具描述符形状 ─────────────────────────────────────────── */

  test('工具描述符：名为 link_budget，参数 12 个（≤20）、动作 4 个、execute 是 async 函数', () => {
    assert.equal(tool.name, 'link_budget')
    assert.equal(typeof tool.title, 'string')
    assert.ok(tool.title.length > 0, '标题不能为空')
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 200, '说明应当把"做什么/要什么输入/给什么输出/硬约束"都写清')

    // 硬约束必须写在工具说明里（这是本模块最容易被绕过的一条）
    assert.ok(tool.description.includes('不内置任何扣减默认值'), 'description 必须声明不内置任何扣减默认值')
    assert.ok(tool.description.includes('必须取自器件手册或实测'), 'description 必须声明灵敏度必须来自手册或实测')

    assert.deepEqual(tool.parameters.action.enum, TOOL_ACTIONS)
    assert.deepEqual(TOOL_ACTIONS, ['budget', 'distance', 'fspl', 'bands'])
    assert.ok(PARAM_NAMES.length <= 20, `参数不得超过 20 个，实际 ${PARAM_NAMES.length}`)
    assert.equal(PARAM_NAMES.length, 12)
    for (const n of ['action', 'frequency_hz', 'distance_m', 'frequencies_hz', 'labels', 'tx_power_dbm', 'rx_sensitivity_dbm', 'tx_antenna_gain_dbi', 'rx_antenna_gain_dbi', 'losses', 'required_margin_db', 'largest_antenna_dimension_m']) {
      assert.ok(PARAM_NAMES.includes(n), `缺少参数 ${n}`)
    }
    // losses 必须是 array（不要嵌套 object）
    assert.equal(tool.parameters.losses.type, 'array')
    for (const p of PARAM_NAMES) {
      assert.equal(typeof tool.parameters[p].description, 'string')
      assert.ok(tool.parameters[p].description.length > 0, `参数 ${p} 必须有中文说明`)
    }
    assert.equal(tool.execute.constructor.name, 'AsyncFunction', 'execute 必须是 async 函数')
    assert.equal(typeof tool.summaryLines, 'function')
  })

  /* ── ② 常数：精确值 vs 文献四舍五入写法（诚实标注 ①）───────────── */

  test('常数：20·log10(4π/c) = −147.552217；km+MHz 折算 = 32.447783（不用 32.44 / 32.45）', () => {
    fixedEqual(FSPL_CONSTANT_M_HZ_DB, -147.552217, 6, '精确常数')
    fixedEqual(FSPL_CONSTANTS.km_mhz.constantDb, 32.447783, 6, 'km+MHz 精确常数')
    fixedEqual(FSPL_CONSTANTS.km_ghz.constantDb, 92.447783, 6, 'km+GHz 精确常数')
    fixedEqual(FSPL_CONSTANTS.m_mhz.constantDb, -27.552217, 6, 'm+MHz 精确常数')

    // 文献印的是两位小数，且自己就不统一 —— 量级对得上，但**不等于**精确值
    assert.equal(FSPL_CONSTANTS.m_hz.publishedDb, -147.55)
    assert.equal(FSPL_CONSTANTS.km_mhz.publishedDb, 32.44, 'lib 登记的是 Wikipedia/Digi-Key 的 32.44（别处亦见 32.45）')
    assert.equal(FSPL_CONSTANTS.km_ghz.publishedDb, 92.45, 'lib 登记的是 ITU-R P.525 的 92.45（别处亦见 92.44）')
    assert.equal(FSPL_CONSTANTS.m_mhz.publishedDb, -27.55)
    assert.notEqual(
      Number(FSPL_CONSTANTS.km_mhz.constantDb.toFixed(2)),
      FSPL_CONSTANTS.km_mhz.publishedDb,
      '32.447783 四舍五入到两位是 32.45，与登记的 publishedDb 32.44 并不相同 —— 所以计算绝不能反过来去用 publishedDb',
    )
    for (const key of Object.keys(FSPL_CONSTANTS)) {
      near(FSPL_CONSTANTS[key].constantDb, FSPL_CONSTANTS[key].publishedDb, 0.01, `${key} 与文献印值的量级一致`)
      assert.equal(typeof FSPL_CONSTANTS[key].source, 'string')
      assert.ok(FSPL_CONSTANTS[key].source.length > 0, `${key} 必须登记出处`)
    }

    // 取 32.44 / 32.45 / 精确值算同一个点位的对照：差异只在 0.01 dB 量级，
    // 但它决定了结果是否依赖"你查的是哪本书"——所以一律用精确值断言。
    const d = 0.1 // km
    const f = 433 // MHz
    const withExact = fsplDbByUnits(d, f, 'km_mhz')
    const with32_44 = 20 * Math.log10(d) + 20 * Math.log10(f) + 32.44
    const with32_45 = 20 * Math.log10(d) + 20 * Math.log10(f) + 32.45
    fixedEqual(withExact, 65.177541, 6, '精确常数下的 433 MHz @ 100 m')
    fixedEqual(with32_44, 65.169758, 6, '如果误用印出来的 32.44')
    fixedEqual(with32_45, 65.179758, 6, '如果误用别处的 32.45')
    near(Math.abs(withExact - with32_44), 0.0078, 0.0005, '两者差异仅 0.0078 dB')
    near(Math.abs(withExact - with32_45), 0.0022, 0.0005, '两者差异仅 0.0022 dB')
  })

  /* ── ③ FSPL 基准向量：复现公开文献查表值 ───────────────────────── */

  test('FSPL 基准：2.4 GHz @ 100 m = 80.05 dB、433 MHz @ 100 m = 65.18 dB（探针口径，逐条钉死）', () => {
    fixedEqual(fsplDb(100, 2.4e9), 80.052008, 6, '2.4 GHz @ 100 m')
    fixedEqual(fsplDb(100, 433e6), 65.177541, 6, '433 MHz @ 100 m')
    fixedEqual(fsplDb(100, 915e6), 71.676205, 6, '915 MHz @ 100 m')
    fixedEqual(fsplDb(1, 2.4e9), 40.052008, 6, '2.4 GHz @ 1 m')
    fixedEqual(fsplDb(10, 2.4e9), 60.052008, 6, '2.4 GHz @ 10 m')
    fixedEqual(fsplDb(1000, 900e6), 91.532633, 6, '900 MHz @ 1 km')
    fixedEqual(fsplDb(1000, 2.4e9), 100.052008, 6, '2.4 GHz @ 1 km')
    fixedEqual(fsplDb(1000, 5e9), 106.427183, 6, '5 GHz @ 1 km')
    fixedEqual(fsplDb(1000, 5.8e9), 107.716343, 6, '5.8 GHz @ 1 km')

    // 有容差的锚点（文献只印到整数或一位小数）逐条对照，来源写在 lib 的 FSPL_REFERENCE_ANCHORS 里
    assert.ok(FSPL_REFERENCE_ANCHORS.length >= 10, '基准向量应当有足够条数')
    for (const a of FSPL_REFERENCE_ANCHORS) {
      const actual = fsplDb(a.distanceM, a.frequencyHz)
      near(actual, a.fsplDb, a.toleranceDb, `基准 ${a.label}（出处：${a.source}）`)
      assert.ok(a.source.length > 0, `基准 ${a.label} 必须登记出处`)
    }

    // 走工具描述符必须与直接调 lib 完全一致（证明包装层没有动过算法）
    const viaTool = dispatch({ action: 'fspl', frequency_hz: 2.4e9, distance_m: 100 })
    assert.equal(viaTool.fsplDb, fsplDb(100, 2.4e9))
    fixedEqual(viaTool.fsplDb, 80.052008, 6, 'fspl 动作的 2.4 GHz @ 100 m')
    fixedEqual(viaTool.fsplConstMhzDb, -147.552217, 6, 'fspl 动作回报的常数')
    fixedEqual(viaTool.fsplConstKmMhzDb, 32.447783, 6, 'fspl 动作回报的 km+MHz 折算常数')
    assert.equal(viaTool.fsplConstKmMhzPublishedDb, 32.44, '同时回报文献印的值，便于复核')
    assertResultShape(viaTool, 'fspl')
  })

  /* ── ④ 弃用锚点：公开查表行自己印错的（诚实标注 ②）───────────── */

  test('弃用锚点登记：rftools 的 5 GHz @ 8 km 印 128.0 实算 124.49；rfstudiolabs 的 433 MHz@100 m 印 65.6 与 Digi-Key 的 65 矛盾', () => {
    // rftools.io 的 128.0 无法用四舍五入解释（差 3.51 dB），故弃用
    const fiveG8km = fsplDb(8000, 5e9)
    fixedEqual(fiveG8km, 124.488983, 6, '5 GHz @ 8 km 实算')
    near(fiveG8km - 128.0, -3.511017, 1e-6, '与印出来的 128.0 相差 3.51 dB')
    assert.ok(Math.abs(fiveG8km - 128.0) > 0.5, '差值远超任何四舍五入范围，判为印错')

    // rfstudiolabs 的 65.6 与 Digi-Key 的 65 矛盾；实算站在 Digi-Key 一侧
    const m433 = fsplDb(100, 433e6)
    fixedEqual(m433, 65.177541, 6, '433 MHz @ 100 m 实算')
    near(m433 - 65.6, -0.422459, 1e-6, '与 65.6 相差 0.42 dB')
    near(m433 - 65.0, 0.177541, 1e-6, '与 Digi-Key 的 65 只差 0.18 dB')
    assert.ok(Math.abs(m433 - 65.0) < Math.abs(m433 - 65.6), '实算明确站在 Digi-Key 一侧')

    // 两条被弃用的行都**不在** lib 的锚点表里（弃用不是嘴上说说，是可断言的）
    assert.equal(FSPL_REFERENCE_ANCHORS.some((a) => a.distanceM === 8000), false, 'lib 里不得含 5 GHz @ 8 km 这一行')
    assert.equal(FSPL_REFERENCE_ANCHORS.some((a) => a.fsplDb === 65.6), false, 'lib 里不得含印成 65.6 的那一行')
    assert.equal(FSPL_REFERENCE_ANCHORS.some((a) => a.fsplDb === 128.0), false, 'lib 里不得含印成 128.0 的那一行')
  })

  /* ── ⑤ 四种单位形式等价 ───────────────────────────────────────── */

  test('四种单位形式等价：m+Hz / km+MHz / km+GHz / m+MHz 给出同一个数', () => {
    const cases = [
      { key: 'm_hz', d: 100, f: 2.4e9, alt: [100, 2.4e9] },
      { key: 'km_mhz', d: 100, f: 433e6, alt: [0.1, 433] },
      { key: 'km_ghz', d: 5000, f: 868e6, alt: [5, 0.868] },
      { key: 'm_mhz', d: 10, f: 2.4e9, alt: [10, 2400] },
    ]
    for (const c of cases) {
      const viaSi = fsplDb(c.d, c.f)
      const viaUnits = fsplDbByUnits(c.alt[0], c.alt[1], c.key)
      near(viaSi, viaUnits, 1e-9, `${c.key} 形式与 m+Hz 形式一致`)
    }
    // 混用单位是这类计算最常见的错源：把 868 MHz 写成 868 Hz 会静默偏 120 dB
    near(fsplDb(1000, 868e6) - fsplDb(1000, 868), 120, 1e-6, '把 MHz 当 Hz 传的偏差恰好是 120 dB')
    assert.throws(() => fsplDbByUnits(1, 100, 'ft_lb'), /未知的单位组合/)
  })

  /* ── ⑥ 975 km 是纯自由空间理论值（诚实标注 ③）────────────────── */

  test('975.194 km 是**不含任何扣减**的纯自由空间理论值，绝不可当可用距离', () => {
    const pure = dispatch({ action: 'distance', frequency_hz: 868e6, tx_power_dbm: 14, rx_sensitivity_dbm: -137 })
    fixedEqual(pure.distanceKm, 975.194209, 6, '868 MHz / 14 dBm / −137 dBm 的纯自由空间 d_max')
    assert.equal(pure.sustainablePathLossDb, 151, '可承受路径损耗 = 14 + 137 = 151 dB，全部被 FSPL 吃掉')
    assert.equal(pure.lossTotalDb, 0, '一个扣减项都没给')
    assert.equal(pure.lossItems.length, 0)
    assert.equal(pure.requiredMarginDb, 0, '没给要求余量时按"刚好闭合"的 0 dB 处理')
    assert.ok(
      pure.warnings.some((w) => w.includes('纯自由空间上限')),
      '必须明确告警这是纯自由空间上限',
    )
    assert.ok(
      pure.notes.some((n) => n.includes('不考虑地形、多径、遮挡')),
      '必须说明不含地形/多径/遮挡',
    )
    assert.ok(
      pure.notes.some((n) => n.includes('理论极限')),
      '必须说明没给要求余量时得到的是理论极限而不是可用距离',
    )
    assertResultShape(pure, 'distance(纯自由空间)')
  })

  /* ── ⑦ 预算闭合 + 往返自洽 ─────────────────────────────────────── */

  test('budget：1 km @ 868 MHz / 14 dBm / −137 dBm / 扣减 18.5 dB / 要求 10 dB → 余量 41.28 dB，两层判定均通过', () => {
    const r = dispatch({
      action: 'budget',
      frequency_hz: 868e6,
      distance_m: 1000,
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: EXAMPLE_LOSSES,
      required_margin_db: 10,
    })
    fixedEqual(r.fsplDb, 91.218178, 6, 'FSPL @ 1 km / 868 MHz')
    assert.equal(r.lossTotalDb, EXAMPLE_LOSS_TOTAL, '扣减合计 = 18.5 dB')
    assert.equal(r.lossItems.length, 7, '7 项已计入')
    fixedEqual(r.rxPowerDbm, -95.718178, 6, 'P_rx')
    fixedEqual(r.marginDb, 41.281822, 6, '余量')
    assert.equal(r.eirpDbm, 13.5, 'EIRP = 14 + 0 − 0.5（发射侧线缆）')

    // 判定分两层：① 余量 > 0；② 余量 ≥ 要求值
    assert.deepEqual(
      r.checks.map((c) => c.pass),
      [true, true, true],
      '链路闭合 / 达到要求余量 / 远场粗判 三条都应通过',
    )
    assert.equal(r.warnings.length, 0, '这个链路的余量足够厚，不应有告警')
    assert.deepEqual(r.notIncluded, ['additionalDb'], '没给的 additionalDb 必须被点名列出来')

    // 与直接调 lib 完全一致（包装层不复制算法）
    assert.equal(r.marginDb, dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 1000, tx_power_dbm: 14, rx_sensitivity_dbm: -137, losses: EXAMPLE_LOSSES, required_margin_db: 10 }).marginDb)
    assertResultShape(r, 'budget')

    // 同一组参数下把同一个链路反推回去：d_max 上正向算余量必须正好等于要求值
    const d = dispatch({
      action: 'distance',
      frequency_hz: 868e6,
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: EXAMPLE_LOSSES,
      required_margin_db: 10,
    })
    assert.equal(d.sustainablePathLossDb, 122.5, '可承受路径损耗 = 14 + 137 − 18.5 − 10')
    fixedEqual(d.distanceKm, 36.651446, 6, '加扣减后的 d_max')
    assert.ok(d.distanceM < 975194.209, '加扣减后必须显著短于纯自由空间值')
    const roundTrip = dispatch({
      action: 'budget',
      frequency_hz: 868e6,
      distance_m: d.distanceM,
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: EXAMPLE_LOSSES,
      required_margin_db: 10,
    })
    near(roundTrip.marginDb, 10, 1e-6, '往返自洽：反推距离上正向算的余量 = 要求值 10 dB')
  })

  /* ── ⑧ 多频段对比 ─────────────────────────────────────────────── */

  test('bands：100 m 处 433→868→2400 MHz 的代价 6.04 / 14.87 dB，余量随频率单调劣化', () => {
    const cmp = dispatch({ action: 'bands', distance_m: 100, frequencies_hz: [433e6, 868e6, 2.4e9], labels: ['433', '868', '2400'] })
    assert.equal(cmp.bandCount, 3)
    fixedEqual(cmp.bands[0].fsplDb, 65.177541, 6, '433 MHz FSPL')
    fixedEqual(cmp.bands[1].fsplDb, 71.218178, 6, '868 MHz FSPL')
    fixedEqual(cmp.bands[2].fsplDb, 80.052008, 6, '2400 MHz FSPL（Digi-Key 印 80）')
    fixedEqual(cmp.bands[0].deltaVsLowestDb, 0, 6, '最低频段差值为 0')
    fixedEqual(cmp.bands[1].deltaVsLowestDb, 6.040637, 6, '868 vs 433 = 20log10(2)')
    fixedEqual(cmp.bands[2].deltaVsLowestDb, 14.874467, 6, '2400 vs 433 ≈ 近 15 dB（Digi-Key 口径）')
    assert.deepEqual(cmp.bands.map((b) => b.label), ['433', '868', '2400'], 'labels 应当被采用')
    assert.equal(cmp.checks[0].name, 'FSPL 随频率单调递增（自洽性）')
    assert.equal(cmp.checks[0].pass, true)
    assert.equal(cmp.bands[0].marginDb, null, '没给功率与灵敏度就不算余量')
    assert.ok(cmp.notes.some((n) => n.includes('未同时提供')), '必须说明本次只比 FSPL、未比余量')
    assertResultShape(cmp, 'bands(只比 FSPL)')

    // 带余量：同一灵敏度跨频段只是演示，lib 会提示其局限
    const withMargin = dispatch({
      action: 'bands',
      distance_m: 1000,
      frequencies_hz: [433e6, 868e6, 2.4e9],
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: EXAMPLE_LOSSES,
      required_margin_db: 10,
    })
    const margins = withMargin.bands.map((b) => b.marginDb)
    fixedEqual(margins[0], 47.322459, 6, '433 MHz @ 1 km 余量')
    fixedEqual(margins[1], 41.281822, 6, '868 MHz @ 1 km 余量')
    fixedEqual(margins[2], 32.447992, 6, '2400 MHz @ 1 km 余量')
    assert.ok(margins[0] > margins[1] && margins[1] > margins[2], '余量必须随频率单调劣化')
    assert.equal(withMargin.checks.length, 4, '1 条单调性 + 3 条逐频段余量判定')
    assert.ok(
      withMargin.notes.some((n) => n.includes('别把结论简化成')),
      '必须提示"别把结论简化成低频一定更好"（频率项来自接收天线有效面积）',
    )
    // 跨频段用了同一个线缆插损 → 必须告警（插损本身随频率变）
    assert.ok(
      withMargin.warnings.some((w) => w.includes('随频率变化')),
      '对每个频段用同一个线缆插损时必须告警',
    )
  })

  /* ── ⑨ 负向用例 1：余量为负 ───────────────────────────────────── */

  test('负向：余量为负 → 链路闭合 check 不通过并告警（不给任何"看起来还行"的余地）', () => {
    const r = dispatch({ action: 'budget', frequency_hz: 2.4e9, distance_m: 5000, tx_power_dbm: 0, rx_sensitivity_dbm: -100 })
    fixedEqual(r.marginDb, -14.031408, 6, '2.4 GHz / 5 km / 0 dBm / −100 dBm 的余量')
    assert.ok(r.marginDb < 0)
    const closing = r.checks.find((c) => c.name === '链路闭合（余量 > 0）')
    assert.equal(closing.pass, false, '余量为负时该 check 必须是不通过')
    assert.ok(
      r.warnings.some((w) => w.includes('链路不闭合')),
      '必须给出"链路不闭合"的告警',
    )
    assert.equal(r.requiredMarginDb, null, '没给要求余量就不擅自判定"是否达标"')
    assert.ok(
      r.notes.some((n) => n.includes('未提供 required_margin_db')),
      '必须说明这次只判"余量是否为正"',
    )

    // 反推距离侧：可承受路径损耗 ≤ 0 时同样必须报警而不是给一个正数糊弄过去
    const bad = dispatch({ action: 'distance', frequency_hz: 868e6, tx_power_dbm: -20, rx_sensitivity_dbm: -10, losses: [{ name: 'fadeMarginDb', db: 50 }] })
    assert.equal(bad.sustainablePathLossDb, -60)
    assert.equal(bad.checks.find((c) => c.name === '预算闭合（可承受路径损耗 > 0）').pass, false)
    assert.ok(bad.warnings.some((w) => w.includes('不是距离问题')), '必须说明这不是距离问题')
    assert.ok(bad.warnings.some((w) => w.includes('近场')), '反推出的荒谬距离必须被近场判据拦下并告警')
  })

  /* ── ⑩ 负向用例 2：参数非法 ───────────────────────────────────── */

  test('负向：参数非法一律抛错，绝不猜默认值（缺频率/距离 0/未知 action/losses 形状与键名/labels 长度）', () => {
    // 必填缺失
    assert.throws(() => dispatch({ action: 'fspl', distance_m: 100 }), /需要 frequency_hz/)
    assert.throws(() => dispatch({ action: 'fspl', frequency_hz: 2.4e9 }), /需要 distance_m/)
    assert.throws(() => dispatch({ action: 'budget', distance_m: 100 }), /需要 frequency_hz/)
    assert.throws(() => dispatch({ action: 'bands', frequencies_hz: [2.4e9] }), /需要 distance_m/)

    // 非正数（频率 0、距离 0：FSPL 在 d=0 / f=0 无定义）
    assert.throws(() => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 0 }), /distance_m 必须是正数/)
    assert.throws(() => dispatch({ action: 'budget', frequency_hz: 0, distance_m: 100 }), /frequency_hz 必须是正数/)
    assert.throws(() => dispatch({ action: 'fspl', frequency_hz: 2.4e9, distance_m: -1 }), /distance_m 必须是正数/)
    assert.throws(() => dispatch({ action: 'budget', frequency_hz: NaN, distance_m: 100 }), /需要 frequency_hz/)

    // 反推距离必须由调用方给发射功率与灵敏度
    assert.throws(() => dispatch({ action: 'distance', frequency_hz: 868e6, rx_sensitivity_dbm: -137 }), /需要 tx_power_dbm/)
    assert.throws(() => dispatch({ action: 'distance', frequency_hz: 868e6, tx_power_dbm: 14 }), /需要 rx_sensitivity_dbm/)
    // 灵敏度是负值，绝不能因为"不是正数"被拦（包装层曾经踩过这个坑，这里钉住）
    assert.equal(dispatch({ action: 'distance', frequency_hz: 868e6, tx_power_dbm: -20, rx_sensitivity_dbm: -137 }).txPowerDbm, -20)

    // 未知 action
    assert.throws(() => dispatch({ action: 'budget_' }), /未知 action/)
    assert.throws(() => dispatch({}), /未知 action/)

    // losses 形状与键名
    assert.throws(() => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 100, losses: { fadeMarginDb: 10 } }), /losses 必须是数组/)
    assert.throws(() => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 100, losses: [10] }), /losses\[0\] 必须是形如 \{ name, db \}/)
    assert.throws(
      () => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 100, losses: [{ name: 'fade_margin_db', db: 10 }] }),
      /不是 lib 的扣减项键名/,
    )
    assert.throws(
      () => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 100, losses: [{ name: 'fadeMarginDb', db: '10' }] }),
      /db 必须是有限数/,
    )

    // 频段列表与标签
    assert.throws(() => dispatch({ action: 'bands', distance_m: 100, frequencies_hz: [] }), /非空数组/)
    assert.throws(() => dispatch({ action: 'bands', distance_m: 100 }), /需要 frequencies_hz/)
    assert.throws(() => dispatch({ action: 'bands', distance_m: 100, frequencies_hz: [433e6, 0] }), /含非法值/)
    assert.throws(
      () => dispatch({ action: 'bands', distance_m: 100, frequencies_hz: [433e6, 868e6], labels: ['只有一条'] }),
      /与 frequencies_hz 长度 2 不一致/,
    )
  })

  /* ── ⑪ 契约：不内置任何默认值 ─────────────────────────────────── */

  test('契约：不给灵敏度就没有余量、不给扣减项就逐项点名、不给增益就声明 0 dBi 假设', () => {
    const noSens = dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 1000, tx_power_dbm: 14 })
    assert.equal(noSens.marginDb, null, '没有灵敏度就没有余量可谈')
    assert.ok(noSens.notIncluded.includes('rxSensitivityDbm'), '必须点名 rxSensitivityDbm 未计入')
    assert.ok(
      noSens.notes.some((n) => n.includes('必须取自器件手册或实测')),
      '必须说明灵敏度要取自手册或实测',
    )
    assert.equal(noSens.checks.length, 1, '余量相关的两条判定都以灵敏度为前提，缺灵敏度则不做；只剩不变的远场判定')
    assert.ok(noSens.checks[0].name.includes('远场'), '缺灵敏度时仍会做 FSPL 适用性判定')

    const noLosses = dispatch({ action: 'budget', frequency_hz: 2.4e9, distance_m: 5000, tx_power_dbm: 0, rx_sensitivity_dbm: -100 })
    assert.equal(noLosses.lossTotalDb, 0, '一个扣减默认值都不许有')
    assert.equal(noLosses.lossItems.length, 0)
    for (const key of LOSS_ITEM_KEYS) {
      assert.ok(noLosses.notIncluded.includes(key), `未提供的 ${key} 必须出现在 notIncluded 里`)
    }
    assert.equal(LOSS_ITEM_KEYS.length, 8)
    assert.ok(
      noLosses.notes.some((n) => n.includes('未计入') && n.includes('fadeMarginDb') && n.includes('temperatureDriftDb')),
      '说明里必须逐项点名列出来（不是笼统说一句"未计入部分损耗"）',
    )
    assert.equal(noLosses.assumptions.length, 2, '两个天线增益未给 → 两条假设')
    assert.ok(noLosses.assumptions[0].includes('0 dBi'), '假设里必须写明按 0 dBi 计入')
    assert.ok(noLosses.assumptions[0].includes('链路方向'), '必须提醒填链路方向上的增益而不是峰值增益')

    // 每一项扣减的语义说明都必须在 lib 里登记（含"是否必须实测"）
    for (const key of LOSS_ITEM_KEYS) {
      assert.equal(typeof LOSS_ITEMS[key].label, 'string')
      assert.equal(typeof LOSS_ITEMS[key].affects, 'string')
      assert.equal(typeof LOSS_ITEMS[key].why, 'string')
      assert.equal(typeof LOSS_ITEMS[key].mustMeasure, 'boolean')
    }
    assert.equal(LOSS_ITEMS.txCableDb.mustMeasure, true)
    assert.equal(LOSS_ITEMS.fadeMarginDb.mustMeasure, false, '衰落余量按环境"设计取值"，但同样必须由调用方给')
  })

  /* ── ⑫ 近场：FSPL 的前提被破坏时必须响 ───────────────────────── */

  test('近场：d < λ 时远场判定不通过并告警（FSPL 在那里没有物理意义）', () => {
    const sub = dispatch({ action: 'budget', frequency_hz: 2.4e9, distance_m: 0.05, tx_power_dbm: 0, rx_sensitivity_dbm: -100 })
    fixedEqual(sub.wavelengthM, 0.124914, 6, 'λ = c/f @ 2.4 GHz')
    assert.equal(sub.checks.find((c) => c.name.includes('远场')).pass, false)
    assert.ok(sub.warnings.some((w) => w.includes('近场')))

    // 给了天线最大尺寸 → 走严格的 2D²/λ 判据（lib 里由 linkBudget 做，包装层不复制）
    const strict = dispatch({
      action: 'budget',
      frequency_hz: 2.4e9,
      distance_m: 1,
      tx_power_dbm: 0,
      rx_sensitivity_dbm: -100,
      largest_antenna_dimension_m: 0.5,
    })
    const far = strict.checks.find((c) => c.name.includes('远场'))
    assert.equal(far.name, '远场（Fraunhofer）适用性')
    assert.equal(far.pass, false, 'D=0.5 m @ 2.4 GHz 的远场起点约 4 m，1 m 不成立')
    assert.ok(strict.warnings.some((w) => w.includes('远场起点')))

    // fspl 动作只做 d ≥ λ 的粗判，并说明严格判据要走 budget
    const viaFspl = dispatch({ action: 'fspl', frequency_hz: 2.4e9, distance_m: 0.05 })
    assert.equal(viaFspl.checks[0].pass, false)
    assert.ok(viaFspl.checks[0].detail.includes('2D²/λ'))
    assert.ok(viaFspl.warnings.some((w) => w.includes('近场')))
  })

  /* ── ⑬ 包装层的额外防护（发现自 lib 的静默行为）───────────────── */

  test('防护：lib 对未知 losses 键是**静默忽略**的 —— 包装层拒绝该键，并给负值与 0 值提醒', () => {
    // 这条用例记录一个从 lib 行为里发现的风险点：
    // lib/linkbudget.js 的 collectLosses 只遍历 LOSS_ITEM_KEYS，调用方传进来的键名拼错时
    // （例如写成 fade_margin_db 而不是 fadeMarginDb），那一项会被**静默丢弃**：
    // 既不计入 lossTotalDb，也不出现在 notIncluded 里 —— 于是"你以为扣了 25 dB、其实一分没扣"。
    // lib 本身没有任何提示（这是本模块唯一一处"沉默"）。包装层因此直接拒绝未知键。
    assert.throws(
      () => dispatch({ action: 'budget', frequency_hz: 868e6, distance_m: 1000, tx_power_dbm: 14, rx_sensitivity_dbm: -137, losses: [{ name: 'fade_margin_db', db: 25 }] }),
      /不是 lib 的扣减项键名/,
    )

    // 负值：lib 按算术当增益叠加，包装层必须告警（不能假装这是"负损耗"）
    const negative = dispatch({
      action: 'budget',
      frequency_hz: 868e6,
      distance_m: 1000,
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: [{ name: 'fadeMarginDb', db: -3 }],
    })
    assert.equal(negative.lossTotalDb, -3, 'lib 的算术就是把它加起来，数值上等于 +3 dB 增益')
    assert.ok(
      negative.warnings.some((w) => w.includes('负值')),
      '必须告警：负的扣减项等于凭空加增益',
    )

    // 0 值：lib 视为"已计入"，该项会从 notIncluded 消失 —— 需要说明这是"没扣任何东西的已计入"
    const zero = dispatch({
      action: 'budget',
      frequency_hz: 868e6,
      distance_m: 1000,
      tx_power_dbm: 14,
      rx_sensitivity_dbm: -137,
      losses: [{ name: 'fadeMarginDb', db: 0 }],
    })
    assert.equal(zero.lossItems.length, 1, 'db=0 仍算"已计入"')
    assert.equal(zero.notIncluded.includes('fadeMarginDb'), false, '填 0 后该项不再出现在 notIncluded 里')
    assert.ok(zero.notes.some((n) => n.includes('= 0')), '必须说明"填 0 只是让它从清单里消失，并没有扣掉东西"')
  })

  /* ── ⑭ 四个动作的统一形状与 summaryLines ─────────────────────── */

  test('四个动作都返回 checks/warnings/notes，summaryLines 对每个动作都给出数值行', () => {
    const outputs = [
      ['budget', { action: 'budget', frequency_hz: 868e6, distance_m: 1000, tx_power_dbm: 14, rx_sensitivity_dbm: -137, losses: EXAMPLE_LOSSES, required_margin_db: 10 }],
      ['distance', { action: 'distance', frequency_hz: 868e6, tx_power_dbm: 14, rx_sensitivity_dbm: -137, losses: EXAMPLE_LOSSES, required_margin_db: 10 }],
      ['fspl', { action: 'fspl', frequency_hz: 2.4e9, distance_m: 100 }],
      ['bands', { action: 'bands', distance_m: 100, frequencies_hz: [433e6, 868e6, 2.4e9] }],
    ]
    for (const [label, args] of outputs) {
      const r = dispatch(args)
      assertResultShape(r, label)
      assert.equal(r.action, label, '返回值必须回报 action')
      assert.ok(r.checks.length > 0, `${label} 至少应给出一条判定`)
      const lines = tool.summaryLines(r)
      assert.ok(Array.isArray(lines) && lines.length > 0, `${label} 的 summaryLines 应给出数值行`)
      for (const l of lines) assert.equal(typeof l, 'string')
      assert.ok(
        lines.some((l) => l.includes('dB')),
        `${label} 的数值行必须带上单位 dB`,
      )
    }
    // 对空值/未知动作要安全返回空数组（渲染层可能在任何时候调用）
    assert.deepEqual(tool.summaryLines(null), [])
    assert.deepEqual(tool.summaryLines({ action: 'nope' }), [])
  })
}
