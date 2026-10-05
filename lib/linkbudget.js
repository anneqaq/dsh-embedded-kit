/**
 * 无线链路预算（协议中立：Sub-GHz / LoRa / BLE / 2.4 GHz 私有协议 / NB-IoT 都适用）。
 *
 * **本模块只做算术，不猜参数。** 所有损耗扣减项与接收灵敏度都必须由调用方传入；
 * 缺哪一项，结果里就明确写"未计入"，绝不替你填一个"看起来合理"的数。为什么见第 3 节。
 *
 * ── 1. 自由空间路径损耗（FSPL）─────────────────────────────────────────────
 *
 * 由 Friis 传输方程出发（各向同性天线）：功率密度按 1/(4πd²) 扩散，
 * 接收天线只截获其有效面积 Aeff = λ²/(4π) 上的那一点功率：
 *
 *   Pr/Pt = (λ / 4πd)²      →      FSPL = (4πd/λ)² = (4πdf/c)²
 *
 * 换成 dB（这一步只是把平方提出来，纯代数）：
 *
 *   FSPL(dB) = 10·log10((4πdf/c)²)
 *            = 20·log10(4πdf/c)
 *            = 20·log10(d) + 20·log10(f) + 20·log10(4π/c)
 *
 * 当 **d 用米（m）、f 用赫兹（Hz）**、c = 299 792 458 m/s 时：
 *
 *   20·log10(4π/c) = 20·log10(4π/299792458) ≈ −147.553   →   习惯写作 −147.55
 *
 *   于是：**FSPL(dB) = 20·log10(d_m) + 20·log10(f_Hz) − 147.55**
 *
 * 这个 −147.55 **不是经验值**，它就是 20·log10(4π/c) 本身。换单位只改变这个加性常数：
 *   d=km, f=MHz：+20log10(10³)+20log10(10⁶) = +180 dB  →  常数 32.448（文献写 32.44 / 32.45）
 *   d=km, f=GHz：+20log10(10³)+20log10(10⁹) = +240 dB  →  常数 92.448（文献写 92.44 / 92.45）
 *   d=m,  f=MHz：            +20log10(10⁶) = +120 dB  →  常数 −27.552（文献写 −27.55）
 * 四种形式结果**完全等价**；混用单位才是这类计算最常见的错源。本模块把四者都导出，
 * 并且用精确常数（−147.552217），不硬编码小数点后两位。
 *
 * **出处**：
 *   - Wikipedia《Free-space path loss》：给出 FSPL(dB) = 20log10(d_m) + 20log10(f_Hz) − 147.55
 *     （SI 单位：m / Hz / m·s⁻¹），并列出 km+GHz → +92.45、m+MHz → −27.55、km+MHz → 32.44/32.45；
 *     同页 "Physical explanation" 一节明确说明**频率项来自接收天线有效面积 λ²/(4π) 随频率缩小，
 *     并非自由空间里存在与频率相关的吸收**。
 *   - ITU-R P.525《Free-space basic transmission loss》：各向同性天线间
 *     Lbf(dB) = 20log10(d_km) + 20log10(f_GHz) + 92.45。
 *   - Friis, H. T., "A Note on a Simple Transmission Formula", Proc. IRE, 1946（原始公式）。
 *
 * ⚠ FSPL **只在远场成立**，且**只含几何扩散**：不含地形、绕射、多径、遮挡、植被、
 *   穿墙、雨衰、大气吸收（>10 GHz 才显著）、天线失配。它是路径损耗的**下限**，
 *   真实损耗一定 ≥ FSPL —— 所以本模块算出的任何"最大距离"都只能当乐观上限。
 *
 * ── 2. 链路预算闭合 ───────────────────────────────────────────────────────
 *
 *   P_tx + G_tx − L_path + G_rx − L_cable = P_rx
 *   余量 = P_rx − 灵敏度
 *
 * 展开即：P_rx = P_tx + G_tx + G_rx − FSPL − Σ(各项扣减)。
 * 判定分两层：① 余量 > 0（链路能闭合）；② 余量 ≥ 调用方要求的设计余量（才算达标）。
 *
 * ── 3. 余量到底要留多少：为什么不能由模块给一个通用数字 ────────────────────
 *
 * 每一项的物理机理、影响对象都不同，而且同一项在不同频段/环境下能差几十 dB，
 * 所以没有任何一个数字能"通用"地替换它们（详见下面的 LOSS_ITEMS，逐项写了"影响什么"
 * 和"为什么不能通用"）。这里只给引用来源，**不作为默认值内置**：
 *
 *   衰落余量  ——  由环境、频段、可用度目标共同决定。文献参考（仅参考，不是默认值）：
 *                 城区蜂窝 99.9% ≈ 8–12 dB；室内 WLAN 10–15 dB；地面微波 99.99% ≈ 30–40 dB；
 *                 99.999% ≈ 35–40 dB。出处：rfessentials.com「Link Budget」与
 *                 rftools.io「RF Link Margin Calculator」（后者按 ITU-R P.530-17 的
 *                 可用度-余量对应给区间）。宽松文献口径是"自由空间 10–30 dB"（engicalchub.com）。
 *   体损耗    ——  手持/穿戴设备人体遮挡：2.4 GHz 约 3–8 dB，28 GHz 可到 8–15 dB
 *                 （engicalchub.com FSPL 指南）；手持电台常取 3–5 dB（engineersuniverse.com）。
 *   天线失配  ——  由实测 S11/VSWR 换算：失配损耗 = −10·log10(1 − |Γ|²)。
 *                 经验参考：2:1 VSWR ≈ 0.5 dB（rftools.io 博客）。必须实测，否则不知道 Γ。
 *   极化损耗  ——  线-线对准 ≈ 0；线-圆固定 3 dB；姿态不受控（翻滚动/随手放置）可达十几 dB。
 *                 文献参考区间 0.5–3 dB（engineersuniverse.com）。
 *   温度漂移  ——  影响晶振频偏（→ 灵敏度/频偏容限退化）、LNA 增益与噪声系数、
 *                 匹配网络与天线效率；量级完全取决于器件与温区，只能查手册温漂曲线或做高低温实测。
 *
 * **结论：这些项一律作为调用方可选的"扣减项"传入（losses.*），模块不设任何默认值。**
 *   - 没传 → 该项计 0，同时在结果的 notIncluded / notes 里点名"未计入哪一项"；
 *   - 传了 → 计入总扣减，并计入 lossItems 明细。
 *
 * ── 4. 设计值 vs 必须实测 ─────────────────────────────────────────────────
 *
 *   FSPL、链路闭合、距离反推：**设计值**（几何+算术，可直接用于方案阶段的量级判断）。
 *   线缆/接头插损、天线失配、极化、温漂：**必须查厂家数据或实测**（VNA / 高低温箱 / 拉距）。
 *   灵敏度：**必须取自器件手册或实测**（同一芯片不同 SF/BW/速率差几十 dB，模块无从假设）。
 *   衰落余量、体损耗：**按环境与可用度目标设计取值**，需在实测中回归修正。
 *   LOSS_ITEMS 里每项都有 mustMeasure 标记。
 *
 * ── 5. 频段选择的代价 ─────────────────────────────────────────────────────
 *
 * 同距离下换频段的代价是 20·log10(f2/f1)：433→868 MHz ≈ +6.0 dB，
 * 868→2400 MHz ≈ +8.8 dB，433→2400 MHz ≈ +14.9 dB。
 * 但注意别把它当成"低频一定更好"：该频率项来自接收天线有效面积 λ²/(4π)，
 * 若两端**物理尺寸不变**，天线增益本身会随频率上升而上升，会抵消掉一部分
 * （Wikipedia 同页 "Physical explanation"）。频段选择还要看法规功率/占空比、
 * 天线尺寸、绕射与穿透能力、噪声与干扰环境 —— FSPL 只是其中一项。
 *
 * @module dsh-embedded-kit/linkbudget
 */

/** 真空光速（m/s），CODATA/ISO 299 792 458 的精确值。 */
export const SPEED_OF_LIGHT_MPS = 299_792_458

/**
 * 20·log10(4π/c)，即 d 用 m、f 用 Hz 时的 FSPL 常数。
 * 精确值 ≈ −147.552217；文献习惯写作 −147.55。
 */
export const FSPL_CONSTANT_M_HZ_DB = 20 * Math.log10((4 * Math.PI) / SPEED_OF_LIGHT_MPS)

/** 距离单位 → 米 的换算比例。 */
const DISTANCE_UNIT_SCALE_M = { m: 1, km: 1000 }

/** 频率单位 → Hz 的换算比例。 */
const FREQUENCY_UNIT_SCALE_HZ = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9 }

/**
 * 构造某一组单位下的 FSPL 加性常数（同一物理常数的单位折算，不是新经验值）。
 *
 * @param {string} distanceUnit - 距离单位（m / km）。
 * @param {string} frequencyUnit - 频率单位（hz / khz / mhz / ghz）。
 * @param {number} publishedDb - 文献里习惯写的四舍五入值。
 * @param {string} source - 该形式的文献出处。
 * @returns {object} 常数条目。
 */
function makeConstant(distanceUnit, frequencyUnit, publishedDb, source) {
	const distanceScaleM = DISTANCE_UNIT_SCALE_M[distanceUnit]
	const frequencyScaleHz = FREQUENCY_UNIT_SCALE_HZ[frequencyUnit]
	return {
		distanceUnit,
		frequencyUnit,
		distanceScaleM,
		frequencyScaleHz,
		constantDb:
			FSPL_CONSTANT_M_HZ_DB + 20 * Math.log10(distanceScaleM) + 20 * Math.log10(frequencyScaleHz),
		publishedDb,
		source,
	}
}

/**
 * FSPL 的四种等价对数形式及其常数。
 *
 * 常数由 20·log10(4π/c) 加上单位折算量算出（见 makeConstant），
 * publishedDb 只是文献里的写法，计算不用它 —— 所以本文不会因为
 * "32.44 还是 32.45"这种取舍产生偏差。
 *
 * 出处：Wikipedia《Free-space path loss》（四种形式的常数）；ITU-R P.525（km+GHz 形式）。
 */
export const FSPL_CONSTANTS = {
	m_hz: makeConstant(
		'm',
		'hz',
		-147.55,
		'Wikipedia《Free-space path loss》: FSPL(dB) = 20log10(d_m) + 20log10(f_Hz) − 147.55',
	),
	km_mhz: makeConstant(
		'km',
		'mhz',
		32.44,
		'Wikipedia 同页 / Digi-Key《Making Choices in Wireless Networks》: +32.44（亦见 32.45）',
	),
	km_ghz: makeConstant(
		'km',
		'ghz',
		92.45,
		'ITU-R P.525: Lbf(dB) = 20log10(d_km) + 20log10(f_GHz) + 92.45（亦见 92.44）',
	),
	m_mhz: makeConstant(
		'm',
		'mhz',
		-27.55,
		'Wikipedia 同页: d 用 m、f 用 MHz 时常数为 −27.55',
	),
}

/**
 * 公开可查的 FSPL 基准向量（**只用于对照验证，不参与任何计算**）。
 *
 * 每条的 fsplDb 是文献里印出来的值；有些文献只印到整数，所以对照时用容差而不是相等。
 * 出处逐条标注，便于复核。
 */
export const FSPL_REFERENCE_ANCHORS = [
	{
		label: '2.4 GHz @ 1 m',
		distanceM: 1,
		frequencyHz: 2.4e9,
		fsplDb: 40.05,
		toleranceDb: 0.02,
		source: 'calculatorhub.com WiFi 计算器 / iotclass.org 复核页（40.05 dB，含 20log10 中间项）',
	},
	{
		label: '2.4 GHz @ 10 m',
		distanceM: 10,
		frequencyHz: 2.4e9,
		fsplDb: 60.05,
		toleranceDb: 0.02,
		source: 'calculatorhub.com 逐步演算示例（20 + 187.6 − 147.55 = 60.05 dB）',
	},
	{
		label: '2.4 GHz @ 100 m',
		distanceM: 100,
		frequencyHz: 2.4e9,
		fsplDb: 80.0,
		toleranceDb: 0.06,
		source: 'Digi-Key《Making Choices in Wireless Networks》(2011)：2.4 GHz @ 100 m = 80 dB',
	},
	{
		label: '433 MHz @ 100 m',
		distanceM: 100,
		frequencyHz: 433e6,
		fsplDb: 65.18,
		toleranceDb: 0.04,
		source: 'Digi-Key 同文（65 dB）/ jscalc-blog FSPL 表（65.2 dB）',
	},
	{
		label: '915 MHz @ 100 m',
		distanceM: 100,
		frequencyHz: 915e6,
		fsplDb: 71.68,
		toleranceDb: 0.05,
		source: 'Digi-Key 同文（915 MHz @ 100 m = 72 dB）/ jscalc-blog 900 MHz 行（71.5 dB）',
	},
	{
		label: '900 MHz @ 1 km',
		distanceM: 1000,
		frequencyHz: 900e6,
		fsplDb: 91.53,
		toleranceDb: 0.02,
		source: 'iotclass.org 复核页：32.45 + 0 + 59.08 = 91.53 dB',
	},
	{
		label: '2.4 GHz @ 1 km',
		distanceM: 1000,
		frequencyHz: 2.4e9,
		fsplDb: 100.05,
		toleranceDb: 0.03,
		source: 'jscalc-blog（100.0 dB）/ iotclass.org（100.05 dB）',
	},
	{
		label: '5 GHz @ 1 km',
		distanceM: 1000,
		frequencyHz: 5e9,
		fsplDb: 106.43,
		toleranceDb: 0.02,
		source: 'iotclass.org 复核页：32.45 + 0 + 73.98 = 106.43 dB',
	},
	{
		label: '5.8 GHz @ 1 km',
		distanceM: 1000,
		frequencyHz: 5.8e9,
		fsplDb: 107.72,
		toleranceDb: 0.02,
		source: 'jscalc-blog FSPL 表：1 km 5.8 GHz = 107.7 dB（点对点回传典型行）',
	},
	{
		label: '3.5 GHz @ 1 km',
		distanceM: 1000,
		frequencyHz: 3.5e9,
		fsplDb: 103.3,
		toleranceDb: 0.05,
		source: 'rfessentials.com「Link Budget」5G NR 宏站算例（FSPL@1 km = 103.3 dB）',
	},
	{
		label: '868 MHz @ 5 km',
		distanceM: 5000,
		frequencyHz: 868e6,
		fsplDb: 105.2,
		toleranceDb: 0.1,
		source: 'engicalchub.com FSPL 指南：5 km LoRaWAN @ 868 MHz ≈ 105 dB',
	},
	{
		label: '868 MHz @ 10 km',
		distanceM: 10000,
		frequencyHz: 868e6,
		fsplDb: 111.2,
		toleranceDb: 0.05,
		source: 'jscalc-blog FSPL 表：10 km 868 MHz = 111.2 dB（LoRa 遥测典型行）',
	},
	{
		label: '915 MHz @ 10 km',
		distanceM: 10000,
		frequencyHz: 915e6,
		fsplDb: 111.7,
		toleranceDb: 0.05,
		source: 'rftools.io 915 MHz LoRa 10 km 算例（111.7 dB）',
	},
	{
		label: '437 MHz @ 1930 km',
		distanceM: 1_930_000,
		frequencyHz: 437e6,
		fsplDb: 151.0,
		toleranceDb: 0.1,
		source: 'rftools.io 立方星 UHF 下行算例（斜距 1930 km，FSPL ≈ 151.0 dB）',
	},
	{
		label: '2.4 GHz @ 500 km（对地静止量级）',
		distanceM: 5e5,
		frequencyHz: 2.4e9,
		fsplDb: 154.0,
		toleranceDb: 0.1,
		source: 'rfstudiolabs.com FSPL 快速参考表（500 km 行 154.0 dB）',
	},
]

/**
 * 损耗/余量扣减项定义。**这里只描述，不提供任何默认值。**
 *
 * mustMeasure=true  → 必须实测或查厂家数据，不能凭感觉填。
 * mustMeasure=false → 按环境与可用度目标"设计取值"，同样必须由调用方决定。
 *
 * @type {Record<string, {label: string, affects: string, why: string, mustMeasure: boolean, source?: string}>}
 */
export const LOSS_ITEMS = {
	txCableDb: {
		label: '发射侧线缆/接头/滤波器损耗',
		affects: '直接吃掉发射功率，等效降低 EIRP；对收发两侧都存在的链路是单向损失。',
		why: '取决于线缆型号、长度、接头数量、工作频率，每米插损随频率近似线性上升（同型号线缆 2.4 GHz 的每米插损约是 433 MHz 的数倍）。同一根线换频段就得重新查表。',
		mustMeasure: true,
		source: 'engicalchub.com FSPL 指南：10 m LMR-400 @ 2.4 GHz ≈ 2.2 dB，10 m RG-58 ≈ 7 dB；每个接头约 0.1–0.5 dB',
	},
	rxCableDb: {
		label: '接收侧线缆/接头/滤波器损耗',
		affects: '抬高接收机的等效噪声系数基线之上的信号损耗，直接减少余量；对灵敏度的影响应并入灵敏度本身，不要在这里重复扣。',
		why: '同 txCableDb，取决于线缆/接头/滤波器与频率，必须查表或实测。',
		mustMeasure: true,
		source: '同上（engicalchub.com）',
	},
	fadeMarginDb: {
		label: '衰落余量（多径 / 阴影 / 雨衰 / 大气吸收）',
		affects: '覆盖"瞬时信道比中值差"的那部分：多径深衰落可达 30–40 dB，阴影衰落服从对数正态分布。',
		why: '没有通用数字：它由环境（室内/城区/郊区/开阔）、频段、链路距离、以及要求的可用度共同决定。可用度目标每提高一个 9，需要的余量就跳一截。必须由调用方按自己场景的目标可用度确定。',
		mustMeasure: false,
		source:
			'rfessentials.com（城区蜂窝 99.9%: 8–12 dB；室内 WLAN 10–15 dB；地面微波 99.99%: 30–40 dB）; rftools.io（按 ITU-R P.530-17 的可用度-余量对应）; engicalchub.com（宽松口径 10–30 dB）',
	},
	bodyLossDb: {
		label: '体损耗（人体遮挡 / 手持姿态）',
		affects: '人手、头部、躯干吸收与遮挡发射/接收能量，等效降低天线效率与方向图；随姿态和朝向剧烈变化。',
		why: '取决于频段（越高越严重）、佩戴位置（手腕/口袋/头盔）、人体与天线的距离。同一产品不同用户能差好几 dB，只能实测或按文献区间设计取值。',
		mustMeasure: false,
		source: 'engicalchub.com（2.4 GHz ≈ 3–8 dB，28 GHz ≈ 8–15 dB）; engineersuniverse.com（手持电台 3–5 dB）',
	},
	mismatchLossDb: {
		label: '天线失配（VSWR / 回波损耗）',
		affects: '一部分功率被反射回源端，既降低有效辐射功率，也使接收侧少收能量；同时会改变 LNA 看到的噪声匹配。',
		why: '由 −10·log10(1 − |Γ|²) 从**实测** S11 算出，而 Γ 又随频率、装配、外壳与手边环境变化 —— 不实测就不知道 Γ，无法给数字。窄带天线在带边失配会比中心差很多。',
		mustMeasure: true,
		source: 'rftools.io 博客：2:1 VSWR ≈ 0.5 dB 失配损耗',
	},
	polarizationLossDb: {
		label: '极化损耗（极化失配）',
		affects: '收发极化不匹配时只能收到投影分量，等效降低接收功率。',
		why: '取决于两端极化型式和相对姿态：线-线对准 ≈ 0，线-圆固定 3 dB，姿态不受控（翻滚动/随手放置）可达十几 dB。必须按实际安装方式和实测姿态评估。',
		mustMeasure: true,
		source: 'engineersuniverse.com：极化失配损耗参考区间 0.5–3 dB',
	},
	temperatureDriftDb: {
		label: '温度漂移（全温区退化）',
		affects:
			'两条路径：① 晶振/TCXO 频偏 → 载波频偏超出接收机容限，等效灵敏度退化（LoRa 在 SF12 对频偏最敏感）；② LNA 增益与噪声系数、匹配网络、天线效率随温度漂移 → 链路增益变化。',
		why: '量级完全取决于器件等级（普通晶振 vs TCXO）与温区范围，且是"设计要覆盖的最坏点"而非典型值。只能查器件手册的温漂曲线，或在整机高低温箱里实测灵敏度/发射功率随温度的变化。模块无从假设。',
		mustMeasure: true,
	},
	additionalDb: {
		label: '其他扣减（屏蔽罩、外壳、老化、生产离散性）',
		affects: '塑料/金属外壳与屏蔽罩的近场耦合、器件老化与批次离散、装配公差带来的额外损耗。',
		why: '因产品结构而异，通常靠样机实测同频段对比裸板与整机灵敏度得出。请调用方自行填写并在 note 里写明它包含什么，不要与本模块已有项重复计。',
		mustMeasure: true,
	},
}

/** 扣减项键名（稳定顺序，供结果输出使用）。 */
export const LOSS_ITEM_KEYS = Object.keys(LOSS_ITEMS)

/**
 * 频率 → 波长。λ = c / f。
 *
 * @param {number} frequencyHz - 频率（Hz），必须为正。
 * @returns {number} 波长（m）。
 */
export function wavelengthM(frequencyHz) {
	if (!(frequencyHz > 0)) throw new Error('frequency_hz 必须为正数（Hz）')
	return SPEED_OF_LIGHT_MPS / frequencyHz
}

/**
 * 自由空间路径损耗：FSPL(dB) = 20log10(d_m) + 20log10(f_Hz) + 20log10(4π/c)。
 *
 * @param {number} distanceM - 距离（m），必须为正。
 * @param {number} frequencyHz - 频率（Hz），必须为正。
 * @returns {number} FSPL（dB，正数表示损耗）。
 */
export function fsplDb(distanceM, frequencyHz) {
	if (!(distanceM > 0)) throw new Error('distance_m 必须为正数（m）')
	if (!(frequencyHz > 0)) throw new Error('frequency_hz 必须为正数（Hz）')
	return 20 * Math.log10(distanceM) + 20 * Math.log10(frequencyHz) + FSPL_CONSTANT_M_HZ_DB
}

/**
 * 按任意单位组合算 FSPL（四种等价对数形式）。
 *
 * @param {number} distance - 距离，单位由 unitsKey 决定。
 * @param {number} frequency - 频率，单位由 unitsKey 决定。
 * @param {string} [unitsKey='m_hz'] - FSPL_CONSTANTS 的键：'m_hz' / 'km_mhz' / 'km_ghz' / 'm_mhz'。
 * @returns {number} FSPL（dB）。
 */
export function fsplDbByUnits(distance, frequency, unitsKey = 'm_hz') {
	const units = FSPL_CONSTANTS[unitsKey]
	if (!units) {
		throw new Error(
			`未知的单位组合：${unitsKey}（可用：${Object.keys(FSPL_CONSTANTS).join(' / ')}）`,
		)
	}
	if (!(distance > 0)) throw new Error('distance 必须为正数')
	if (!(frequency > 0)) throw new Error('frequency 必须为正数')
	return 20 * Math.log10(distance) + 20 * Math.log10(frequency) + units.constantDb
}

/**
 * 由 FSPL 反解距离。d = 10^((FSPL − 20log10(f) − 常数) / 20)。
 *
 * @param {number} fspl - 目标路径损耗（dB）。
 * @param {number} frequencyHz - 频率（Hz）。
 * @returns {number} 距离（m）。
 */
export function distanceFromFsplDb(fspl, frequencyHz) {
	if (!Number.isFinite(fspl)) throw new Error('fspl 必须是有限数（dB）')
	if (!(frequencyHz > 0)) throw new Error('frequency_hz 必须为正数（Hz）')
	return 10 ** ((fspl - FSPL_CONSTANT_M_HZ_DB - 20 * Math.log10(frequencyHz)) / 20)
}

/**
 * 汇总调用方传入的扣减项：分出"已计入"与"未计入"。
 *
 * @param {Record<string, number>} [losses] - 扣减项，键取自 LOSS_ITEM_KEYS。
 * @returns {{applied: Array<{key: string, label: string, db: number}>, notIncluded: string[], totalDb: number}} 汇总结果。
 */
function collectLosses(losses) {
	const src = losses && typeof losses === 'object' ? losses : {}
	const applied = []
	const notIncluded = []
	let totalDb = 0
	for (const key of LOSS_ITEM_KEYS) {
		const value = src[key]
		if (Number.isFinite(value)) {
			applied.push({ key, label: LOSS_ITEMS[key].label, db: value })
			totalDb += value
		} else {
			notIncluded.push(key)
		}
	}
	return { applied, notIncluded, totalDb }
}

/**
 * 生成"哪些扣减项未计入"的说明文本 —— 缺什么就点名叫什么，不含任何填补值。
 *
 * @param {string[]} notIncluded - 未提供的扣减项键名。
 * @returns {string} 说明文本。
 */
function notIncludedText(notIncluded) {
	if (notIncluded.length === 0) return '所有扣减项均由调用方提供并已计入。'
	return (
		`未提供、因此**未计入**以下 ${notIncluded.length} 项扣减（本模块不设默认值）：` +
		notIncluded.map((k) => `${k}（${LOSS_ITEMS[k].label}）`).join('；') +
		'。把它们填上后余量会相应减少。'
	)
}

/**
 * 天线增益的取值说明（未提供时按 0 dBi 计入，并显式声明这个假设）。
 *
 * @param {*} gain - 调用方传入的增益。
 * @param {string} label - 字段名，用于提示。
 * @param {string[]} assumptions - 假设收集。
 * @returns {number} 用于计算的增益（dBi）。
 */
function resolveGain(gain, label, assumptions) {
	if (Number.isFinite(gain)) return gain
	assumptions.push(
		`未提供 ${label}，按 0 dBi（各向同性）计入。这是"不含天线增益"的裸链路；` +
			`实际请填天线方向图上**链路方向**的增益，不要填峰值增益。`,
	)
	return 0
}

/**
 * 链路预算闭合计算。
 *
 * P_rx = P_tx + G_tx + G_rx − FSPL − Σ(扣减)；余量 = P_rx − 灵敏度。
 *
 * frequencyHz / distanceM 是 FSPL 的必要输入，缺失即无法计算 → 抛错。
 * txPowerDbm / rxSensitivityDbm / 各项扣减缺失 → 不猜值，对应的量置 null 并写入
 * notIncluded、notes（例如没给灵敏度就没有余量，也没有"链路能通"的判定）。
 *
 * @param {object} input - 输入。
 * @param {number} input.frequencyHz - 频率（Hz），必填。
 * @param {number} input.distanceM - 距离（m），必填。
 * @param {number} [input.txPowerDbm] - 发射功率（dBm）。未传则接收功率与余量均为 null。
 * @param {number} [input.rxSensitivityDbm] - 接收灵敏度（dBm）。**必须由调用方传入**（随速率/带宽/编码变化，可达几十 dB 差异），未传则余量为 null。
 * @param {number} [input.txAntennaGainDbi] - 发射天线在链路方向上的增益（dBi）。未传按 0 dBi 并声明。
 * @param {number} [input.rxAntennaGainDbi] - 接收天线在链路方向上的增益（dBi）。未传按 0 dBi 并声明。
 * @param {Record<string, number>} [input.losses] - 扣减项，键取自 LOSS_ITEM_KEYS；未提供的项记 0 并列入 notIncluded。
 * @param {number} [input.requiredMarginDb] - 调用方要求的设计余量（dB）。给了才判定"是否达标"；没给只判定余量为正。
 * @param {number} [input.largestAntennaDimensionM] - 天线最大物理尺寸（m），给了就做严格的远场（Fraunhofer）判据 d > 2D²/λ。
 * @returns {object} {checks, warnings, notes, ...数值}。
 */
export function linkBudget({
	frequencyHz,
	distanceM,
	txPowerDbm,
	rxSensitivityDbm,
	txAntennaGainDbi,
	rxAntennaGainDbi,
	losses,
	requiredMarginDb,
	largestAntennaDimensionM,
} = {}) {
	if (!(frequencyHz > 0)) throw new Error('frequency_hz 必须为正数（Hz）')
	if (!(distanceM > 0)) throw new Error('distance_m 必须为正数（m）')

	const checks = []
	const warnings = []
	const notes = []
	const assumptions = []
	const notIncluded = []

	const lambda = wavelengthM(frequencyHz)
	const fspl = fsplDb(distanceM, frequencyHz)

	const txGain = resolveGain(txAntennaGainDbi, 'tx_antenna_gain_dbi', assumptions)
	const rxGain = resolveGain(rxAntennaGainDbi, 'rx_antenna_gain_dbi', assumptions)

	const lossDetail = collectLosses(losses)
	notIncluded.push(...lossDetail.notIncluded)
	notes.push(notIncludedText(lossDetail.notIncluded))

	// 设计值 / 实测值的边界说明，随结果一起返回，避免被误当成实测结论。
	notes.push(
		'本结果是**设计值**：FSPL 只含几何扩散（不含地形、绕射、多径、遮挡、植被、穿墙、雨衰、大气吸收），' +
			'并用调用方给的扣减项近似环境效应。线缆/接头/失配/极化/温漂属必须实测或查厂家数据的项，请用实测值替换。',
	)

	// 收发功率与灵敏度：缺就不算，绝不填默认值。
	const hasTxPower = Number.isFinite(txPowerDbm)
	const hasSensitivity = Number.isFinite(rxSensitivityDbm)
	if (!hasTxPower) {
		notIncluded.push('txPowerDbm')
		notes.push('未提供 tx_power_dbm：无法算接收功率，接收功率与余量置为 null（本模块不提供默认发射功率）。')
	}
	if (!hasSensitivity) {
		notIncluded.push('rxSensitivityDbm')
		notes.push(
			'未提供 rx_sensitivity_dbm：没有灵敏度就没有余量可谈，余量置为 null。' +
				'灵敏度随调制/带宽/扩频因子/编码率变化可达几十 dB，**必须取自器件手册或实测**，本模块绝不假设。',
		)
	}

	const txCableDb = Number.isFinite(losses?.txCableDb) ? losses.txCableDb : 0
	const eirpDbm = hasTxPower ? txPowerDbm + txGain - txCableDb : null
	const rxPowerDbm = hasTxPower ? txPowerDbm + txGain + rxGain - fspl - lossDetail.totalDb : null
	const marginDb = rxPowerDbm !== null && hasSensitivity ? rxPowerDbm - rxSensitivityDbm : null
	const required = Number.isFinite(requiredMarginDb) ? requiredMarginDb : null

	// 1) 余量为正 —— 链路闭合
	if (marginDb !== null) {
		const pass = marginDb > 0
		checks.push({
			name: '链路闭合（余量 > 0）',
			pass,
			detail: `P_rx = ${rxPowerDbm.toFixed(2)} dBm，灵敏度 ${rxSensitivityDbm} dBm → 余量 ${marginDb.toFixed(2)} dB`,
		})
		if (!pass) {
			warnings.push(
				`余量 ${marginDb.toFixed(2)} dB ≤ 0：链路不闭合。` +
					`可动的是天线增益、发射功率、灵敏度（降速率/降带宽/提高扩频因子）、或缩短距离/换低频段。`,
			)
		} else if (marginDb < 6) {
			warnings.push(
				`余量仅 ${marginDb.toFixed(2)} dB，非常薄：几乎任何衰落、体遮挡或温漂都会把它吃掉。` +
					`注意这时**还没**算入任何未提供的扣减项。`,
			)
		}
	}

	// 2) 是否达到调用方要求的设计余量
	if (marginDb !== null && required !== null) {
		const pass = marginDb >= required
		checks.push({
			name: `达到要求余量（≥ ${required} dB）`,
			pass,
			detail: `余量 ${marginDb.toFixed(2)} dB vs 要求 ${required} dB，差 ${(marginDb - required).toFixed(2)} dB`,
		})
		if (!pass) {
			warnings.push(
				`余量 ${marginDb.toFixed(2)} dB 未达到调用方要求的 ${required} dB（差 ${(required - marginDb).toFixed(2)} dB）。` +
					`要求值由调用方按可用度目标给出（如 ITU-R P.530 的可用度-余量对应）；本模块不替你设定。`,
			)
		}
	} else if (marginDb !== null) {
		notes.push(
			'未提供 required_margin_db：本次只判定"余量是否为正"，未判定"是否达到要求余量"。' +
				'设计余量要留多少取决于环境与目标可用度，没有通用数字，请显式传入。',
		)
	}

	// 3) 远场适用性（FSPL 的前提）
	if (Number.isFinite(largestAntennaDimensionM) && largestAntennaDimensionM > 0) {
		const farFieldStartM = (2 * largestAntennaDimensionM ** 2) / lambda
		const pass = distanceM >= farFieldStartM
		checks.push({
			name: '远场（Fraunhofer）适用性',
			pass,
			detail: `d = ${distanceM} m vs 远场起点 2D²/λ = ${farFieldStartM.toFixed(3)} m（D = ${largestAntennaDimensionM} m，λ = ${lambda.toFixed(4)} m）`,
		})
		if (!pass) {
			warnings.push(
				`距离 ${distanceM} m 小于远场起点 ${farFieldStartM.toFixed(3)} m：FSPL 在此不成立，` +
					`结果没有物理意义（近场需用全波仿真或实测标定）。`,
			)
		}
	} else {
		const pass = distanceM >= lambda
		checks.push({
			name: '远场适用性（粗判）',
			pass,
			detail: `未提供天线最大尺寸，只做 d ≥ λ 的粗判：d = ${distanceM} m，λ = ${lambda.toFixed(4)} m。严格判据是 d > 2D²/λ。`,
		})
		if (!pass) {
			warnings.push(`距离 ${distanceM} m 小于一个波长 ${lambda.toFixed(4)} m：已进入近场，FSPL 不适用。`)
		}
	}

	return {
		frequencyHz,
		frequencyMhz: frequencyHz / 1e6,
		wavelengthM: lambda,
		distanceM,
		fsplDb: fspl,
		txPowerDbm: hasTxPower ? txPowerDbm : null,
		txAntennaGainDbi: txGain,
		rxAntennaGainDbi: rxGain,
		eirpDbm,
		lossItems: lossDetail.applied,
		lossTotalDb: lossDetail.totalDb,
		rxPowerDbm,
		rxSensitivityDbm: hasSensitivity ? rxSensitivityDbm : null,
		marginDb,
		requiredMarginDb: required,
		assumptions,
		notIncluded,
		checks,
		warnings,
		notes,
	}
}

/**
 * 由链路参数反推**最大理论通信距离**（FSPL 反解）。
 *
 * 思路：先把"可承受的最大路径损耗"算出来，再反解距离。
 *
 *   可承受路径损耗 = P_tx + G_tx + G_rx − Σ(扣减) − 灵敏度 − 要求余量
 *   d_max = 10^((可承受路径损耗 − 20log10(f) + 147.552) / 20)
 *
 * ⚠ **这个距离不考虑地形、多径、遮挡**（也不含植被、穿墙、雨衰）。
 *   FSPL 是路径损耗的下限，所以 d_max 是**自由空间上限（乐观值）**；
 *   真实可用距离通常显著更短。要更接近真实，只能给 losses 里填入按现场实测/统计
 *   标定的扣减项（含衰落余量、体损耗等），或改用 ITU-R P.526/P.833/P.1411 等模型。
 *
 * @param {object} input - 输入。
 * @param {number} input.frequencyHz - 频率（Hz），必填。
 * @param {number} input.txPowerDbm - 发射功率（dBm），必填（不设默认）。
 * @param {number} input.rxSensitivityDbm - 接收灵敏度（dBm），必填（不设默认）。
 * @param {number} [input.txAntennaGainDbi] - 发射天线增益（dBi），未传按 0 dBi 并声明。
 * @param {number} [input.rxAntennaGainDbi] - 接收天线增益（dBi），未传按 0 dBi 并声明。
 * @param {Record<string, number>} [input.losses] - 扣减项（线缆、衰落余量、体损耗等）。
 * @param {number} [input.requiredMarginDb] - 要求保留的设计余量（dB），不给按 0 处理（即"刚好闭合"）。
 * @param {number} [input.largestAntennaDimensionM] - 天线最大尺寸（m），用于严格远场判据。
 * @returns {object} {checks, warnings, notes, ...数值}。
 */
export function maxDistanceFromLink({
	frequencyHz,
	txPowerDbm,
	rxSensitivityDbm,
	txAntennaGainDbi,
	rxAntennaGainDbi,
	losses,
	requiredMarginDb,
	largestAntennaDimensionM,
} = {}) {
	if (!(frequencyHz > 0)) throw new Error('frequency_hz 必须为正数（Hz）')
	if (!Number.isFinite(txPowerDbm)) {
		throw new Error('tx_power_dbm 必须由调用方传入（本模块不提供默认发射功率）')
	}
	if (!Number.isFinite(rxSensitivityDbm)) {
		throw new Error(
			'rx_sensitivity_dbm 必须由调用方传入（灵敏度随调制/带宽/扩频因子/编码率变化可达几十 dB，本模块绝不假设）',
		)
	}

	const checks = []
	const warnings = []
	const notes = []
	const assumptions = []

	const lambda = wavelengthM(frequencyHz)
	const txGain = resolveGain(txAntennaGainDbi, 'tx_antenna_gain_dbi', assumptions)
	const rxGain = resolveGain(rxAntennaGainDbi, 'rx_antenna_gain_dbi', assumptions)
	const lossDetail = collectLosses(losses)
	const targetMarginDb = Number.isFinite(requiredMarginDb) ? requiredMarginDb : 0

	if (!Number.isFinite(requiredMarginDb)) {
		notes.push('未提供 required_margin_db，反推时按"刚好闭合"（保留余量 0 dB）处理。这样得到的是理论极限，不是可用距离。')
	}
	notes.push(notIncludedText(lossDetail.notIncluded))
	if (lossDetail.applied.length === 0) {
		warnings.push(
			'未提供任何扣减项：这个距离是**纯自由空间上限**，不含衰落余量、体损耗、线缆、失配、极化与温漂。' +
				'真实可用距离一定更短，请不要把它当成布点依据。',
		)
	}
	if (Number.isFinite(losses?.fadeMarginDb) && Number.isFinite(requiredMarginDb)) {
		notes.push(
			'注意：losses.fadeMarginDb 与 required_margin_db 会**叠加**扣减。' +
				'两者含义不同（前者是对信道的经验扣减，后者是验收阈值），但请不要把同一个衰落余量在两边各写一次。',
		)
	}
	notes.push(
		'⚠ 本距离**不考虑地形、多径、遮挡**，也不含植被、穿墙、雨衰与大气吸收（>10 GHz 才显著）。' +
			'FSPL 是路径损耗下限，故该值为乐观上限；真实距离需现场拉距实测，' +
			'或用 ITU-R P.526（绕射）/P.833（植被）/P.1411（短距城区）等模型修正。',
	)

	const sustainablePathLossDb =
		txPowerDbm + txGain + rxGain - lossDetail.totalDb - rxSensitivityDbm - targetMarginDb
	const distanceM = distanceFromFsplDb(sustainablePathLossDb, frequencyHz)

	// 1) 预算是否闭合（可承受路径损耗必须为正才有意义）
	const budgetPass = sustainablePathLossDb > 0
	checks.push({
		name: '预算闭合（可承受路径损耗 > 0）',
		pass: budgetPass,
		detail: `${txPowerDbm} dBm + ${txGain} dBi + ${rxGain} dBi − 扣减 ${lossDetail.totalDb.toFixed(2)} dB − 灵敏度 ${rxSensitivityDbm} dBm − 要求余量 ${targetMarginDb} dB = ${sustainablePathLossDb.toFixed(2)} dB`,
	})
	if (!budgetPass) {
		warnings.push(
			`可承受路径损耗为 ${sustainablePathLossDb.toFixed(2)} dB ≤ 0：就算把距离压到 0 m 也收不到。` +
				`这不是距离问题 —— 需要加大发射功率/天线增益、降低速率或带宽以换取更好的灵敏度，或降低要求的余量。`,
		)
	}

	// 2) 反推距离是否落在 FSPL 适用区（d ≥ λ），否则近场，结果无意义
	const nearFieldPass = distanceM >= lambda
	checks.push({
		name: '反推距离在 FSPL 适用区（d ≥ λ）',
		pass: nearFieldPass,
		detail: `d_max = ${distanceM.toFixed(3)} m（${(distanceM / 1000).toFixed(4)} km）vs λ = ${lambda.toFixed(4)} m`,
	})
	if (!nearFieldPass) {
		warnings.push(
			`反推距离 ${distanceM.toFixed(4)} m 小于一个波长 ${lambda.toFixed(4)} m：已进入近场，` +
				`FSPL 模型失效，该数值没有物理意义（真实含义是"预算在极近距离都不够"）。`,
		)
	}

	// 3) 远场严格判据（仅在给了天线尺寸时）
	if (Number.isFinite(largestAntennaDimensionM) && largestAntennaDimensionM > 0) {
		const farFieldStartM = (2 * largestAntennaDimensionM ** 2) / lambda
		const pass = distanceM >= farFieldStartM
		checks.push({
			name: '远场（Fraunhofer）适用性',
			pass,
			detail: `d_max = ${distanceM.toFixed(3)} m vs 远场起点 2D²/λ = ${farFieldStartM.toFixed(3)} m`,
		})
		if (!pass) {
			warnings.push(`反推距离小于远场起点 ${farFieldStartM.toFixed(3)} m，FSPL 在此不成立。`)
		}
	}

	return {
		frequencyHz,
		frequencyMhz: frequencyHz / 1e6,
		wavelengthM: lambda,
		txPowerDbm,
		txAntennaGainDbi: txGain,
		rxAntennaGainDbi: rxGain,
		rxSensitivityDbm,
		lossItems: lossDetail.applied,
		lossTotalDb: lossDetail.totalDb,
		requiredMarginDb: targetMarginDb,
		sustainablePathLossDb,
		distanceM,
		distanceKm: distanceM / 1000,
		assumptions,
		notIncluded: lossDetail.notIncluded,
		checks,
		warnings,
		notes,
	}
}

/**
 * 把频率格式化成便于阅读的标签（纯显示用途，不影响计算）。
 *
 * @param {number} frequencyHz - 频率（Hz）。
 * @returns {string} 形如 '433 MHz' / '2.4 GHz' / '31500 Hz'。
 */
function formatFrequencyLabel(frequencyHz) {
	if (frequencyHz % 1e9 === 0) return `${frequencyHz / 1e9} GHz`
	if (frequencyHz % 1e6 === 0) return `${frequencyHz / 1e6} MHz`
	if (frequencyHz % 1e3 === 0) return `${frequencyHz / 1e3} kHz`
	return `${frequencyHz} Hz`
}

/**
 * 同一距离下多频段的 FSPL 对比 —— 用来判断换频段的代价。
 *
 * 频段差异只来自 20·log10(f)：频率翻倍多 6.02 dB。但两个提醒写进 notes：
 *   ① 该频率项来自接收天线有效面积 λ²/(4π)，若两端物理尺寸不变、增益随频率上升，会抵消一部分；
 *   ② 频段选择还要看法规（功率上限、占空比）、天线尺寸、绕射/穿透能力与噪声干扰环境。
 *
 * @param {object} input - 输入。
 * @param {number} input.distanceM - 统一评估距离（m），必填。
 * @param {number[]} input.frequenciesHz - 待对比的频率列表（Hz），必填且非空（本模块不预设"常用频段"以免被当成默认方案）。
 * @param {string[]} [input.labels] - 与 frequenciesHz 一一对应的显示标签；不给则自动格式化。
 * @param {number} [input.txPowerDbm] - 发射功率（dBm）。与 rxSensitivityDbm 同时给出时，额外算各频段余量。
 * @param {number} [input.rxSensitivityDbm] - 接收灵敏度（dBm）。不建议用同一个灵敏度跨频段比 —— 除非你的接收机确实如此。
 * @param {number} [input.txAntennaGainDbi] - 发射天线增益（dBi），未传按 0 dBi 并声明。
 * @param {number} [input.rxAntennaGainDbi] - 接收天线增益（dBi），未传按 0 dBi 并声明。
 * @param {Record<string, number>} [input.losses] - 扣减项，各频段共用（注意线缆插损本身是随频率变的！）。
 * @param {number} [input.requiredMarginDb] - 要求余量（dB），用于逐频段达标判定。
 * @returns {object} {bands, checks, warnings, notes, ...}。
 */
export function compareBands({
	distanceM,
	frequenciesHz,
	labels,
	txPowerDbm,
	rxSensitivityDbm,
	txAntennaGainDbi,
	rxAntennaGainDbi,
	losses,
	requiredMarginDb,
} = {}) {
	if (!(distanceM > 0)) throw new Error('distance_m 必须为正数（m）')
	if (!Array.isArray(frequenciesHz) || frequenciesHz.length === 0) {
		throw new Error('frequencies_hz 必须是非空数组（本模块不预设"常用频段"，请显式传入）')
	}
	for (const f of frequenciesHz) {
		if (!(f > 0)) throw new Error(`frequencies_hz 含非法值：${f}（必须为正的 Hz）`)
	}

	const checks = []
	const warnings = []
	const notes = []
	const assumptions = []

	const withMargin = Number.isFinite(txPowerDbm) && Number.isFinite(rxSensitivityDbm)
	const bands = frequenciesHz.map((frequencyHz, i) => {
		const label = Array.isArray(labels) && labels[i] ? labels[i] : formatFrequencyLabel(frequencyHz)
		const bandFspl = fsplDb(distanceM, frequencyHz)
		/** @type {number|null} */
		let marginDb = null
		if (withMargin) {
			marginDb = linkBudget({
				frequencyHz,
				distanceM,
				txPowerDbm,
				rxSensitivityDbm,
				txAntennaGainDbi,
				rxAntennaGainDbi,
				losses,
				requiredMarginDb,
			}).marginDb
		}
		return {
			frequencyHz,
			label,
			wavelengthM: wavelengthM(frequencyHz),
			fsplDb: bandFspl,
			marginDb,
		}
	})

	const lowestFspl = Math.min(...bands.map((b) => b.fsplDb))
	for (const band of bands) {
		band.deltaVsLowestDb = band.fsplDb - lowestFspl
	}

	// 自洽性判据：频率越高，同距离 FSPL 必须越大（单调性破坏就说明输入或实现有问题）
	const sorted = [...bands].sort((a, b) => a.frequencyHz - b.frequencyHz)
	let monotonic = true
	for (let i = 1; i < sorted.length; i += 1) {
		if (!(sorted[i].fsplDb > sorted[i - 1].fsplDb)) monotonic = false
	}
	checks.push({
		name: 'FSPL 随频率单调递增（自洽性）',
		pass: monotonic,
		detail: sorted.map((b) => `${b.label}: ${b.fsplDb.toFixed(2)} dB`).join('  <  '),
	})
	if (!monotonic) {
		warnings.push('FSPL 未随频率单调递增，说明输入重复或实现异常，请复核。')
	}

	if (withMargin) {
		for (const band of bands) {
			const pass = band.marginDb > 0
			checks.push({
				name: `余量 > 0 @ ${band.label}`,
				pass,
				detail: `P_rx = ${(band.marginDb + rxSensitivityDbm).toFixed(2)} dBm，余量 ${band.marginDb.toFixed(2)} dB`,
			})
			if (!pass) warnings.push(`${band.label} 在该距离下不闭合（余量 ${band.marginDb.toFixed(2)} dB）。`)
		}
	} else {
		notes.push(
			'未同时提供 tx_power_dbm 与 rx_sensitivity_dbm，本次只比较 FSPL，未比较余量。' +
				'跨频段比较余量时注意：灵敏度本身与频段/带宽相关，除非你的接收机确实相同。',
		)
	}

	notes.push(
		'换频段的代价 = 20·log10(f2/f1)：频率翻倍多 6.02 dB。' +
			`本次区间 ${sorted[0]?.label ?? ''} → ${sorted[sorted.length - 1]?.label ?? ''} 相差 ${(bands[0] ? Math.max(...bands.map((b) => b.deltaVsLowestDb)) : 0).toFixed(2)} dB。`,
	)
	notes.push(
		'别把结论简化成"低频一定更好"：该频率项来自接收天线有效面积 λ²/(4π)，' +
			'若两端**物理尺寸不变**，天线增益会随频率上升而上升并抵消一部分（Wikipedia "Physical explanation"）。' +
			'频段选择还要一并考虑法规功率上限与占空比、天线尺寸、绕射/穿透能力、噪声与干扰环境。',
	)
	if (Object.keys(losses ?? {}).some((k) => k === 'txCableDb' || k === 'rxCableDb')) {
		warnings.push(
			'losses 里的线缆/接头插损是**随频率变化**的，这里对每个频段用了同一个值。' +
				'做正式频段对比时，请按各频段分别查线缆插损表。',
		)
	}
	notes.push(notIncludedText(collectLosses(losses).notIncluded))

	return {
		distanceM,
		bandCount: bands.length,
		bands,
		frequenciesHz,
		assumptions,
		notIncluded: collectLosses(losses).notIncluded,
		checks,
		warnings,
		notes,
	}
}
