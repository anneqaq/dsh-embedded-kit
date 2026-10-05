/**
 * dsh-embedded-kit / lib/linkbudget.js 的独立探针。
 *
 * 直接跑：`node probe/linkbudget.probe.mjs`
 *
 * 做四件事：
 *   ① 用本模块的 FSPL 公式**复现公开文献印出来的查表值**（基准向量），逐条断言，防止实现漂移；
 *   ② 断言四种单位形式的对数式结果等价；
 *   ③ 跑几个真实用例：LoRa SF12 @ 868 MHz 的最大理论距离、同条件 2.4 GHz 对比、
 *      以及 433 / 868 / 2400 MHz 在同一距离下的 FSPL 差；
 *   ④ 验证"不内置默认值"这个契约：缺灵敏度就没有余量、缺扣减项就点名列出来、
 *      必填项缺失就抛错。
 *
 * 基准向量的出处逐条写在 FSPL_REFERENCE_ANCHORS（lib/linkbudget.js）里，这里只打印。
 *
 * 本脚本不依赖任何 npm 包，也不改动库文件。
 */

import {
	compareBands,
	FSPL_CONSTANT_M_HZ_DB,
	FSPL_CONSTANTS,
	FSPL_REFERENCE_ANCHORS,
	fsplDb,
	fsplDbByUnits,
	linkBudget,
	LOSS_ITEMS,
	LOSS_ITEM_KEYS,
	maxDistanceFromLink,
	SPEED_OF_LIGHT_MPS,
	wavelengthM,
} from '../lib/linkbudget.js'

let passed = 0
let failed = 0

/**
 * 断言辅助：既打印也计数。
 *
 * @param {string} label - 断言说明。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 细节。
 */
function check(label, ok, detail) {
	if (ok) passed += 1
	else failed += 1
	console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${label}${detail ? `  →  ${detail}` : ''}`)
}

/** 打印小节标题。 */
function section(title) {
	console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/**
 * 宽松数值比较（文献给的是四舍五入后的值）。
 *
 * @param {number} actual - 算出来的值。
 * @param {number} expected - 文献值。
 * @param {number} tolerance - 允许偏差（dB）。
 * @returns {boolean} 是否在容差内。
 */
function closeTo(actual, expected, tolerance) {
	return Math.abs(actual - expected) <= tolerance
}

// ─────────────────────────────────────────────────────────────────────────────
// 0. 常数本身
// ─────────────────────────────────────────────────────────────────────────────

section('0. FSPL 常数：20·log10(4π/c)')

console.log(`c = ${SPEED_OF_LIGHT_MPS} m/s（真空光速，精确值）`)
console.log(`20·log10(4π/c) = ${FSPL_CONSTANT_M_HZ_DB.toFixed(6)} dB   ← 文献习惯写作 −147.55`)
console.log('\n四种单位形式的常数（同一物理常数的单位折算）：')
for (const [key, u] of Object.entries(FSPL_CONSTANTS)) {
	console.log(
		`  ${key.padEnd(8)} d[${u.distanceUnit}] f[${u.frequencyUnit}]  ` +
			`计算值 ${u.constantDb.toFixed(6)}  文献值 ${u.publishedDb}`,
	)
	console.log(`           出处：${u.source}`)
}
check(
	'精确常数与文献 −147.55 一致（差 < 0.01 dB）',
	closeTo(FSPL_CONSTANT_M_HZ_DB, -147.55, 0.01),
	`${FSPL_CONSTANT_M_HZ_DB.toFixed(6)} vs −147.55`,
)
check(
	'km+MHz 形式折算回 32.44/32.45',
	closeTo(FSPL_CONSTANTS.km_mhz.constantDb, 32.44, 0.01),
	FSPL_CONSTANTS.km_mhz.constantDb.toFixed(6),
)
check(
	'km+GHz 形式折算回 92.44/92.45',
	closeTo(FSPL_CONSTANTS.km_ghz.constantDb, 92.45, 0.01),
	FSPL_CONSTANTS.km_ghz.constantDb.toFixed(6),
)
check(
	'm+MHz 形式折算回 −27.55',
	closeTo(FSPL_CONSTANTS.m_mhz.constantDb, -27.55, 0.01),
	FSPL_CONSTANTS.m_mhz.constantDb.toFixed(6),
)

// ─────────────────────────────────────────────────────────────────────────────
// 1. 基准向量：复现文献查表值
// ─────────────────────────────────────────────────────────────────────────────

section('1. FSPL 基准向量对照（公开文献查表值）')

console.log('距离        频率        本模块计算    文献值     偏差    文献出处')
console.log('─'.repeat(78))
for (const anchor of FSPL_REFERENCE_ANCHORS) {
	const actual = fsplDb(anchor.distanceM, anchor.frequencyHz)
	const diff = actual - anchor.fsplDb
	const ok = closeTo(actual, anchor.fsplDb, anchor.toleranceDb)
	check(
		`${anchor.label} → ${actual.toFixed(2)} dB`,
		ok,
		`文献 ${anchor.fsplDb} dB，偏差 ${diff >= 0 ? '+' : ''}${diff.toFixed(3)} dB（容差 ±${anchor.toleranceDb}）`,
	)
	console.log(
		`${String(anchor.distanceM).padStart(8)} m  ${String(anchor.frequencyHz).padStart(11)} Hz  ` +
			`${actual.toFixed(2).padStart(8)} dB  ${String(anchor.fsplDb).padStart(7)} dB  ` +
			`${(diff >= 0 ? '+' : '') + diff.toFixed(3)}  ${anchor.source}`,
	)
}
console.log(`\n共 ${FSPL_REFERENCE_ANCHORS.length} 条基准向量。`)

// ─────────────────────────────────────────────────────────────────────────────
// 2. 四种单位形式必须等价
// ─────────────────────────────────────────────────────────────────────────────

section('2. 四种单位形式的对数式等价性')

const unitCases = [
	// 每个用例给出同一物理量的两种写法，四种形式算出来必须完全一致
	{ d: 1, f: 2.4e9, key: 'm_hz', dAlt: 1, fAlt: 2.4e9 },
	{ d: 100, f: 433e6, key: 'km_mhz', dAlt: 0.1, fAlt: 433 },
	{ d: 5000, f: 868e6, key: 'km_ghz', dAlt: 5, fAlt: 0.868 },
	{ d: 10, f: 2.4e9, key: 'm_mhz', dAlt: 10, fAlt: 2400 },
]
for (const c of unitCases) {
	const viaM = fsplDb(c.d, c.f)
	const viaUnits = fsplDbByUnits(c.dAlt, c.fAlt, c.key)
	check(
		`${c.key} 形式与 m+Hz 形式一致`,
		closeTo(viaM, viaUnits, 1e-9),
		`${viaM.toFixed(9)} dB vs ${viaUnits.toFixed(9)} dB`,
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 真实用例 A：LoRa SF12 @ 868 MHz，最大理论距离
// ─────────────────────────────────────────────────────────────────────────────

section('3. 用例 A：LoRa SF12/125 kHz @ 868 MHz —— 最大理论距离')

// 下面这些数是**探针示例输入**（由调用方给出），不是 lib/linkbudget.js 的默认值：
//   灵敏度 −137 dBm  : Semtech SX1276 数据手册标称（SF12/125 kHz），
//                      引用自 rftools.io RF Link Budget Calculator 算例。
//   灵敏度 −123 dBm  : 同上，SF7/125 kHz。
//   发射功率 14 dBm  : LoRaWAN EU868 终端常见上限量级，示例取值。
const LORA_SENSITIVITY_SF12 = -137
const LORA_SENSITIVITY_SF7 = -123
const EXAMPLE_TX_DBM = 14

const loraPure = maxDistanceFromLink({
	frequencyHz: 868e6,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
})
console.log(`输入（探针示例）：f = 868 MHz，P_tx = ${EXAMPLE_TX_DBM} dBm，灵敏度 = ${LORA_SENSITIVITY_SF12} dBm（SF12/125 kHz）`)
console.log(`  未给任何扣减项 → 可承受路径损耗 = ${loraPure.sustainablePathLossDb.toFixed(2)} dB`)
console.log(`  λ = ${loraPure.wavelengthM.toFixed(4)} m`)
console.log(`  ★ 最大理论距离 d_max = ${loraPure.distanceM.toFixed(1)} m = ${loraPure.distanceKm.toFixed(2)} km`)
console.log(`  警告：${loraPure.warnings.join(' ')}`)
for (const note of loraPure.notes) console.log(`  说明：${note}`)
check(
	'纯自由空间上限落在数百 km 量级（SF12 的典型乐观口径）',
	loraPure.distanceKm > 100 && loraPure.distanceKm < 5000,
	`${loraPure.distanceKm.toFixed(2)} km`,
)
check(
	'未给扣减项时给出"纯自由空间上限"警告',
	loraPure.warnings.some((w) => w.includes('纯自由空间上限')),
	`${loraPure.warnings.length} 条警告`,
)

// 加上按文献区间取的示例扣减项（每一项都在注释里标明来源，均为**示例输入**）
const EXAMPLE_LOSSES_CITED = {
	txCableDb: 0.5, // 探针示例：短馈线 + 1 个接头，需按自己线缆查表
	rxCableDb: 0.5, // 同上
	fadeMarginDb: 10, // rftools.io：即使非关键链路也建议 ≥10 dB（ITU-R P.530 99% 可用度量级）
	bodyLossDb: 3, // engineersuniverse.com：手持 3–5 dB 的下沿
	mismatchLossDb: 0.5, // rftools.io：2:1 VSWR ≈ 0.5 dB 失配损耗
	polarizationLossDb: 3, // 线-圆固定 3 dB（线性对准为 0）
	temperatureDriftDb: 1, // 探针示例：必须实测，此处仅演示
}
const exampleLossTotal = Object.values(EXAMPLE_LOSSES_CITED).reduce((a, b) => a + b, 0)

const loraRealistic = maxDistanceFromLink({
	frequencyHz: 868e6,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
	losses: EXAMPLE_LOSSES_CITED,
	requiredMarginDb: 10,
})
console.log(
	`\n加上示例扣减项（合计 ${exampleLossTotal.toFixed(2)} dB）与要求余量 10 dB 后：` +
		`可承受路径损耗 = ${loraRealistic.sustainablePathLossDb.toFixed(2)} dB`,
)
console.log(`  ★ d_max = ${loraRealistic.distanceM.toFixed(1)} m = ${loraRealistic.distanceKm.toFixed(2)} km`)
check(
	'加扣减后距离显著缩短（仍为正、且小于纯自由空间值）',
	loraRealistic.distanceM > 0 && loraRealistic.distanceM < loraPure.distanceM,
	`${loraRealistic.distanceKm.toFixed(2)} km < ${loraPure.distanceKm.toFixed(2)} km`,
)

// 往返自洽：在反推出的距离上正向算，余量必须正好等于要求值
const roundTrip = linkBudget({
	frequencyHz: 868e6,
	distanceM: loraRealistic.distanceM,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
	losses: EXAMPLE_LOSSES_CITED,
	requiredMarginDb: 10,
})
check(
	'往返自洽：反推距离上正向算余量 = 要求值 10 dB',
	closeTo(roundTrip.marginDb, 10, 1e-6),
	`余量 ${roundTrip.marginDb.toFixed(9)} dB`,
)

// SF7 对照（灵敏度差 14 dB → 距离按 10^(14/20) ≈ 5.01 倍缩短）
const loraSf7 = maxDistanceFromLink({
	frequencyHz: 868e6,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF7,
})
const sfRatio = loraPure.distanceM / loraSf7.distanceM
console.log(
	`\nSF7 对照（灵敏度 ${LORA_SENSITIVITY_SF7} dBm）：d_max = ${loraSf7.distanceKm.toFixed(2)} km，` +
		`SF12/SF7 距离比 = ${sfRatio.toFixed(3)}（理论 = 10^(14/20) = ${(10 ** (14 / 20)).toFixed(3)}）`,
)
check('灵敏度每差 14 dB，距离比 = 10^(14/20) ≈ 5.012', closeTo(sfRatio, 10 ** (14 / 20), 1e-6), sfRatio.toFixed(6))

// ─────────────────────────────────────────────────────────────────────────────
// 4. 真实用例 B：同条件 2.4 GHz 对比
// ─────────────────────────────────────────────────────────────────────────────

section('4. 用例 B：同条件换成 2.4 GHz —— 频段的代价')

const bleLike = maxDistanceFromLink({
	frequencyHz: 2.4e9,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
})
const bleLikeReal = maxDistanceFromLink({
	frequencyHz: 2.4e9,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
	losses: EXAMPLE_LOSSES_CITED,
	requiredMarginDb: 10,
})
console.log('完全相同的参数（P_tx=14 dBm、灵敏度 −137 dBm、扣减同前），只把频率从 868 MHz 换成 2.4 GHz：')
console.log(`  纯自由空间：868 MHz → ${loraPure.distanceKm.toFixed(2)} km   2.4 GHz → ${bleLike.distanceKm.toFixed(2)} km`)
console.log(`  加同样扣减：868 MHz → ${loraRealistic.distanceKm.toFixed(2)} km   2.4 GHz → ${bleLikeReal.distanceKm.toFixed(2)} km`)
console.log(
	`  距离比 = ${(loraPure.distanceM / bleLike.distanceM).toFixed(4)}（理论 = f 之比 2400/868 = ${(2400 / 868).toFixed(4)}）` +
		`  —— 同损耗预算下距离与频率成反比。`,
)
console.log(`  ★ 代价 = 20·log10(2400/868) = ${(20 * Math.log10(2400 / 868)).toFixed(2)} dB（同距离下多出来的 FSPL）`)
check(
	'同预算下 868 MHz 距离是 2.4 GHz 的 f 之比倍',
	closeTo(loraPure.distanceM / bleLike.distanceM, 2400 / 868, 1e-6),
	(loraPure.distanceM / bleLike.distanceM).toFixed(6),
)
check(
	'868→2400 MHz 的 FSPL 代价 ≈ 8.83 dB',
	closeTo(20 * Math.log10(2400 / 868), 8.83, 0.01),
	(20 * Math.log10(2400 / 868)).toFixed(3),
)

// ─────────────────────────────────────────────────────────────────────────────
// 5. 不同频段的 FSPL 对比
// ─────────────────────────────────────────────────────────────────────────────

section('5. 同距离下 433 / 868 / 2400 MHz 的 FSPL 对比')

const BANDS = [433e6, 868e6, 2.4e9]
console.log(
	`频段：${BANDS.map((f) => `${formatMHz(f)}（λ=${wavelengthM(f).toFixed(3)} m）`).join('   ')}`,
	'\n括号内为"比最低频段多出的 FSPL"，只随频率变化，与距离无关。\n',
)
for (const d of [1, 10, 100, 1000, 5000, 10000]) {
	const cmp = compareBands({ distanceM: d, frequenciesHz: BANDS })
	const line = cmp.bands
		.map(
			(b) =>
				`${b.label.padStart(8)}: ${b.fsplDb.toFixed(2).padStart(6)} dB` +
				`(+${b.deltaVsLowestDb.toFixed(2)})`,
		)
		.join('   ')
	console.log(`  ${String(d).padStart(6)} m   ${line}`)
}

/**
 * 频率 → '433 MHz' 形式的显示标签（探针内部用，仅用于打印）。
 *
 * @param {number} frequencyHz - 频率（Hz）。
 * @returns {string} 标签。
 */
function formatMHz(frequencyHz) {
	return `${frequencyHz / 1e6} MHz`
}

const cmp100 = compareBands({ distanceM: 100, frequenciesHz: BANDS })
console.log('\n100 m 处（对照公开查表值：433 MHz 65 dB / 2.4 GHz 80 dB，Digi-Key 2011）：')
for (const b of cmp100.bands) {
	console.log(`  ${b.label.padStart(8)}  FSPL = ${b.fsplDb.toFixed(2)} dB   比最低频段多 ${b.deltaVsLowestDb.toFixed(2)} dB`)
}
check(
	'100 m 处 2400 MHz 比 433 MHz 多约 14.87 dB（文献口径"将近 15 dB"）',
	closeTo(cmp100.bands[2].deltaVsLowestDb, 14.87, 0.02),
	`${cmp100.bands[2].deltaVsLowestDb.toFixed(3)} dB`,
)
check(
	'100 m 处 2400 MHz FSPL ≈ 80.05 dB（Digi-Key 印 80 dB）',
	closeTo(cmp100.bands[2].fsplDb, 80.0, 0.06),
	`${cmp100.bands[2].fsplDb.toFixed(3)} dB`,
)
check(
	'100 m 处 433 MHz FSPL ≈ 65.18 dB（Digi-Key 印 65 dB）',
	closeTo(cmp100.bands[0].fsplDb, 65.0, 0.2),
	`${cmp100.bands[0].fsplDb.toFixed(3)} dB`,
)

// 带余量的频段对比（同一灵敏度跨频段只是演示，注释里已提示其局限）
const cmpWithMargin = compareBands({
	distanceM: 1000,
	frequenciesHz: BANDS,
	txPowerDbm: EXAMPLE_TX_DBM,
	rxSensitivityDbm: LORA_SENSITIVITY_SF12,
	losses: EXAMPLE_LOSSES_CITED,
	requiredMarginDb: 10,
})
console.log('\n1 km 处带余量对比（P_tx=14 dBm，灵敏度 −137 dBm，扣减合计 ' + exampleLossTotal.toFixed(2) + ' dB）：')
for (const b of cmpWithMargin.bands) {
	console.log(`  ${b.label.padStart(8)}  FSPL = ${b.fsplDb.toFixed(2)} dB   余量 = ${b.marginDb.toFixed(2)} dB`)
}
check(
	'1 km 处 433/868 MHz 达标而 2400 MHz 余量更小（单调劣化）',
	cmpWithMargin.bands[0].marginDb > cmpWithMargin.bands[1].marginDb &&
		cmpWithMargin.bands[1].marginDb > cmpWithMargin.bands[2].marginDb,
	`${cmpWithMargin.bands.map((b) => b.marginDb.toFixed(2)).join(' > ')}`,
)
console.log('\n频段对比的说明与警示：')
for (const note of cmpWithMargin.notes) console.log(`  说明：${note}`)
for (const w of cmpWithMargin.warnings) console.log(`  警告：${w}`)

// ─────────────────────────────────────────────────────────────────────────────
// 6. 契约验证：不内置任何臆造默认值
// ─────────────────────────────────────────────────────────────────────────────

section('6. 契约验证：不内置默认值 / 缺项必须点名')

console.log(`可扣减项共 ${LOSS_ITEM_KEYS.length} 项：${LOSS_ITEM_KEYS.map((k) => `${k}${LOSS_ITEMS[k].mustMeasure ? '(须实测)' : '(设计取值)'}`).join(', ')}`)

const noSens = linkBudget({ frequencyHz: 868e6, distanceM: 1000, txPowerDbm: 14 })
check('不给灵敏度 → marginDb 为 null（不假设）', noSens.marginDb === null, String(noSens.marginDb))
check(
	'不给灵敏度 → notIncluded 点名 rxSensitivityDbm',
	noSens.notIncluded.includes('rxSensitivityDbm'),
	noSens.notIncluded.join(', '),
)
check(
	'不给灵敏度 → notes 说明"必须取自手册或实测"',
	noSens.notes.some((n) => n.includes('必须取自器件手册或实测')),
	'已说明',
)

const noLosses = linkBudget({ frequencyHz: 2.4e9, distanceM: 5000, txPowerDbm: 0, rxSensitivityDbm: -100 })
check('不给任何扣减项 → lossTotalDb 为 0（不臆造）', noLosses.lossTotalDb === 0, `${noLosses.lossTotalDb} dB`)
check(
	'不给任何扣减项 → 8 项全部列入 notIncluded',
	noLosses.notIncluded.filter((k) => LOSS_ITEM_KEYS.includes(k)).length === LOSS_ITEM_KEYS.length,
	`${noLosses.notIncluded.filter((k) => LOSS_ITEM_KEYS.includes(k)).length}/${LOSS_ITEM_KEYS.length}`,
)
check(
	'不给任何扣减项 → notes 逐项点名列出来',
	noLosses.notes.some((n) => n.includes('未计入') && n.includes('fadeMarginDb') && n.includes('temperatureDriftDb')),
	'已逐项点名',
)
check(
	'不收 requiredMarginDb 就只判定"余量为正"，不擅自定要求值',
	noLosses.requiredMarginDb === null && noLosses.notes.some((n) => n.includes('未提供 required_margin_db')),
	`requiredMarginDb = ${noLosses.requiredMarginDb}`,
)
check(
	'天线增益未提供 → 按 0 dBi 且显式声明为假设',
	noLosses.assumptions.length === 2 && noLosses.assumptions[0].includes('0 dBi'),
	noLosses.assumptions.length + ' 条假设',
)
check(
	'0 dBm 发射、5 km、灵敏度 −100 dBm 时余量为负 → 应当告警',
	noLosses.marginDb < 0 && noLosses.warnings.some((w) => w.includes('链路不闭合')),
	`余量 ${noLosses.marginDb.toFixed(2)} dB，${noLosses.warnings.length} 条警告`,
)

const throws = (fn) => {
	try {
		fn()
		return false
	} catch {
		return true
	}
}
check(
	'maxDistanceFromLink 不给发射功率 → 抛错',
	throws(() => maxDistanceFromLink({ frequencyHz: 868e6, rxSensitivityDbm: -137 })),
	'抛出异常，不猜默认发射功率',
)
check(
	'maxDistanceFromLink 不给灵敏度 → 抛错',
	throws(() => maxDistanceFromLink({ frequencyHz: 868e6, txPowerDbm: 14 })),
	'抛出异常，不猜默认灵敏度',
)
check(
	'linkBudget 不给频率 → 抛错',
	throws(() => linkBudget({ distanceM: 10 })),
	'抛出异常',
)
check(
	'linkBudget 距离为 0 → 抛错（FSPL 在 d=0 无定义）',
	throws(() => linkBudget({ frequencyHz: 868e6, distanceM: 0 })),
	'抛出异常',
)
check(
	'fsplDbByUnits 用没定义的单位组合 → 抛错',
	throws(() => fsplDbByUnits(1, 100, 'ft_lb')),
	'抛出异常',
)
check(
	'compareBands 不传频段列表 → 抛错（不预设"常用频段"）',
	throws(() => compareBands({ distanceM: 100 })),
	'抛出异常',
)

// 近场告警：距离小于一个波长
const nearField = maxDistanceFromLink({
	frequencyHz: 2.4e9,
	txPowerDbm: -20,
	rxSensitivityDbm: -10,
})
check(
	'预算极差时反推距离落入近场 → 明确告警"没有物理意义"',
	nearField.warnings.some((w) => w.includes('近场')),
	neardetail(nearField),
)
/**
 * 组装近场用例的细节描述。
 *
 * @param {object} r - maxDistanceFromLink 的返回。
 * @returns {string} 描述。
 */
function neardetail(r) {
	return `d_max=${r.distanceM.toFixed(4)} m，λ=${r.wavelengthM.toFixed(4)} m，可承受损耗=${r.sustainablePathLossDb.toFixed(2)} dB`
}

// FSPL 只在远场：d < λ 时必须告警
const subWavelength = linkBudget({
	frequencyHz: 2.4e9,
	distanceM: 0.05,
	txPowerDbm: 0,
	rxSensitivityDbm: -100,
})
check(
	'd = 5 cm @ 2.4 GHz（λ=12.5 cm）→ 远场粗判不通过并告警',
	subWavelength.checks.some((c) => c.name.includes('远场') && c.pass === false) &&
		subWavelength.warnings.some((w) => w.includes('近场')),
	`λ = ${subWavelength.wavelengthM.toFixed(4)} m`,
)

// 波长换算交叉验证
check(
	'λ = c/f：2.4 GHz → 12.49 cm',
	closeTo(wavelengthM(2.4e9) * 100, 12.49, 0.01),
	`${(wavelengthM(2.4e9) * 100).toFixed(3)} cm`,
)

// ─────────────────────────────────────────────────────────────────────────────
// 小结
// ─────────────────────────────────────────────────────────────────────────────

section('小结')
console.log(`断言：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
	console.log('存在失败断言 —— 公式或基准向量可能已漂移，请复核。')
	process.exitCode = 1
} else {
	console.log(
		'全部通过：FSPL 复现了公开文献的查表值，四种单位形式等价，' +
			'反推与正向计算自洽，且模块在缺参数时不臆造任何默认值。',
	)
	console.log('提醒：所有最大距离都是**自由空间上限**，不含地形/多径/遮挡；真实距离必须现场实测。')
}
