/**
 * 引脚电平冲突与漏电通路分析（纯函数）。
 *
 * 解决的是一类**在现场极难定位、但原理很确定**的问题：某一个引脚在休眠时
 * 持续吃掉几十 µA，导致电池寿命远低于设计值，而软件上看不出任何异常。
 *
 * 最典型的一例（也是最常被忽略的）：
 *   MCU 引脚使能**内部上拉**，而该引脚接的是某个通讯器件/芯片的
 *   **CMOS 推挽输出**，且该输出此刻为**低电平** →
 *   电流从 VDD 经内部上拉电阻灌进外部输出的下管，再到 GND，**持续不断**。
 *   软件没有任何报错，示波器上也看不到信号，只有电流表看得出来。
 *
 * ## 设计原则：区分「故障是否确定」与「电流能否算出」
 *
 * - **是否存在漏电通路**：由拓扑决定，确定无疑 —— 一定给出结论。
 * - **漏电流数值**：需要电阻与电平数据才能算 —— 缺数据时**只报通路、不算数值**，
 *   绝不拿一个"看起来合理"的默认电阻去凑一个数字出来。
 *
 * @module dsh-embedded-kit/leakage
 */

/** MCU 引脚的配置模式。 */
export const MCU_MODES = [
	'input-pullup',
	'input-pulldown',
	'input-floating',
	'output-pushpull',
	'output-opendrain',
	'af-pushpull',
	'af-opendrain',
	'analog',
	'unknown',
]

/** 外部器件的输出/连接类型。 */
export const EXTERNAL_KINDS = [
	'none',
	'cmos-pushpull',
	'open-drain',
	'open-collector',
	'analog',
	'passive-to-vdd',
	'passive-to-gnd',
	'switch-to-gnd',
	'switch-to-vdd',
]

/** 外部器件当前的输出状态。 */
export const EXTERNAL_LEVELS = ['high', 'low', 'highz', 'unknown']

/** 严重度排序，用于汇总排序。 */
const SEVERITY_ORDER = { high: 3, medium: 2, low: 1, none: 0 }

/**
 * MCU 侧配置的语义解析。
 * @param {string} mode - {@link MCU_MODES} 之一。
 * @returns {{pull: 'up'|'down'|null, drive: 'high'|'low'|null, drives: boolean, od: boolean}} 语义。
 */
function parseMcuMode(mode) {
	switch (mode) {
		case 'input-pullup':
			return { pull: 'up', drive: null, drives: false, od: false }
		case 'input-pulldown':
			return { pull: 'down', drive: null, drives: false, od: false }
		case 'input-floating':
			return { pull: null, drive: null, drives: false, od: false }
		case 'output-pushpull':
		case 'af-pushpull':
			return { pull: null, drive: null, drives: true, od: false }
		case 'output-opendrain':
		case 'af-opendrain':
			return { pull: null, drive: null, drives: true, od: true }
		case 'analog':
			return { pull: null, drive: null, drives: false, od: false }
		default:
			return { pull: null, drive: null, drives: false, od: false }
	}
}

/**
 * 判断外部器件此刻是否**主动驱动**某个电平。
 * @param {string} kind - {@link EXTERNAL_KINDS} 之一。
 * @param {string} level - {@link EXTERNAL_LEVELS} 之一。
 * @returns {{activelyDrives: boolean, level: 'high'|'low'|null}} 主动驱动情况。
 */
function parseExternal(kind, level) {
	const closedSwitch = level === 'low' && kind === 'switch-to-gnd'
	const closedSwitchHigh = level === 'high' && kind === 'switch-to-vdd'
	switch (kind) {
		case 'cmos-pushpull':
			// 只有 high/low 是主动驱动；highz/unknown 都不是。
			return { activelyDrives: level === 'high' || level === 'low', level: level === 'high' ? 'high' : level === 'low' ? 'low' : null }
		case 'open-drain':
		case 'open-collector':
			// 开漏/开集只能主动拉低；其余状态是高阻。
			return { activelyDrives: level === 'low', level: level === 'low' ? 'low' : null }
		case 'passive-to-vdd':
			return { activelyDrives: true, level: 'high' }
		case 'passive-to-gnd':
			return { activelyDrives: true, level: 'low' }
		case 'switch-to-gnd':
			return { activelyDrives: closedSwitch, level: closedSwitch ? 'low' : null }
		case 'switch-to-vdd':
			return { activelyDrives: closedSwitchHigh, level: closedSwitchHigh ? 'high' : null }
		default:
			return { activelyDrives: false, level: null }
	}
}

/**
 * 分析单个引脚。
 *
 * @param {object} spec - 引脚描述。
 * @param {string} [spec.pin] - 引脚名（仅用于展示）。
 * @param {string} spec.mcu_mode - MCU 侧模式，见 {@link MCU_MODES}。
 * @param {'high'|'low'} [spec.mcu_level] - MCU 为输出且非开漏时的输出电平。
 * @param {string} [spec.external_kind] - 外部器件类型，见 {@link EXTERNAL_KINDS}，默认 none。
 * @param {string} [spec.external_level] - 外部器件当前状态，见 {@link EXTERNAL_LEVELS}。
 * @param {number} [spec.vdd] - 供电电压（V），算电流必需。
 * @param {number} [spec.pull_ohm] - MCU 内部上/下拉电阻（Ω）单一值。
 * @param {number} [spec.pull_ohm_min] - 内部上/下拉电阻**最小值**（Ω）。数据手册给范围时应填这个 ——
 *   漏电流在电阻最小时最大，最坏情况必须用 min。
 * @param {number} [spec.pull_ohm_typ] - 内部上/下拉电阻典型值（Ω），用于给出典型电流。
 * @param {number} [spec.pull_ohm_max] - 内部上/下拉电阻最大值（Ω）。
 * @param {number} [spec.external_r_ohm] - 外部无源电阻（Ω）。
 * @param {number} [spec.series_ohm] - 串在回路里的限流电阻（Ω）。
 * @returns {object} 分析结果。`currentUa` 为**最坏情况**；`currentTypUa` 为典型值。
 *   两者为 null 表示通路确定但缺数据、未估算。
 */
export function analyzePin(spec) {
	const {
		pin = '（未命名）',
		mcu_mode = 'unknown',
		mcu_level = null,
		external_kind = 'none',
		external_level = 'unknown',
		vdd = null,
		pull_ohm = null,
		pull_ohm_min = null,
		pull_ohm_typ = null,
		pull_ohm_max = null,
		external_r_ohm = null,
		series_ohm = 0,
	} = spec

	// 电阻取三种口径：最坏情况用 min（电流最大），典型值用 typ。
	// 只给单一值时，三个口径相同 —— 但要在结论里提示"数据手册通常给范围，最坏情况可能更差"。
	const hasRange = pull_ohm_min !== null || pull_ohm_typ !== null || pull_ohm_max !== null
	const pullRMin = pull_ohm_min ?? pull_ohm ?? null
	const pullRTyp = pull_ohm_typ ?? pull_ohm ?? pullRMin
	const pullRMax = pull_ohm_max ?? pull_ohm ?? pullRMin
	const resistanceNote = hasRange
		? `内部上下拉按数据手册范围取（min ${pullRMin} Ω / typ ${pullRTyp} Ω）`
		: pull_ohm !== null
			? '内部上下拉用了单一值；数据手册通常给 min/typ/max 范围，**最坏情况应按 min 电阻计**'
			: '未提供内部上下拉电阻'

	const mcu = parseMcuMode(mcu_mode)
	const ext = parseExternal(external_kind, external_level)

	/** @type {Array<{kind: string, path: string, severity: string}>} */
	const findings = []
	/** 参与计算的等效电阻（Ω）—— 最坏情况口径。 */
	let rWorst = null
	/** 典型口径的等效电阻（Ω）。 */
	let rTyp = null
	/** 电流估算缺少的输入项。 */
	const missing = []

	/**
	 * 登记一个漏电通路并尝试估算电流。
	 * @param {string} kind - 通路类型。
	 * @param {string} path - 通路描述。
	 * @param {string} severity - 严重度。
	 * @param {number|null} rMin - 最坏情况等效电阻。
	 * @param {number|null} rT - 典型等效电阻。
	 */
	function addFinding(kind, path, severity, rMin, rT) {
		findings.push({ kind, path, severity })
		if (rWorst === null && rMin !== null) rWorst = rMin
		if (rTyp === null && rT !== null) rTyp = rT
	}

	if (external_kind === 'none' || (external_kind === 'analog' && mcu_mode !== 'analog')) {
		// 没有实质外部连接：只检查浮空。
		if (mcu_mode === 'input-floating' || mcu_mode === 'unknown') {
			addFinding(
				'floating-input',
				'输入悬空、无确定电平。CMOS 输入级会处于两管部分导通状态并随噪声翻转，产生贯穿电流与额外动态功耗；休眠时也随干扰波动。',
				'medium',
				null,
			)
		}
	} else if (ext.activelyDrives) {
		// 外部主动驱动某个电平 —— 这一支是漏电的主战场。
		if (mcu.pull === 'up' && ext.level === 'low') {
			// 外部若是**无源电阻/开关到地**，其阻值必须计入回路；
			// 若是 CMOS 推挽或开漏输出的下管，其导通电阻属未知量，不臆造。
			const passive = external_kind === 'passive-to-gnd' || external_kind === 'switch-to-gnd'
			const R = sumRange(
				passive
					? [
							[pullRMin, pullRTyp],
							[external_r_ohm, external_r_ohm],
							[series_ohm, series_ohm],
						]
					: [
							[pullRMin, pullRTyp],
							[series_ohm, series_ohm],
						],
				missing,
				passive ? ['pull_ohm（内部上拉）', 'external_r_ohm（外部下拉）'] : ['pull_ohm（内部上拉）'],
			)
			addFinding(
				passive ? 'mcu-pullup-vs-external-pulldown' : 'mcu-pullup-vs-external-low',
				passive
					? 'MCU 内部上拉与外部下拉电阻（或到地的闭合开关）构成分压回路，休眠时持续耗流。这类"两个电阻打架"在原理图上常被当成上下拉冗余而忽略。'
					: 'MCU 内部上拉（到 VDD）与外部低电平输出直接对打：电流从 VDD 经内部上拉电阻灌入外部低边，持续不断。**这是通讯器件 CMOS 推挽输出 + 使能上拉的经典漏电** —— 软件不报错，只有电流表看得出来。',
				'medium',
				R.rMin,
				R.rTyp,
			)
		} else if (mcu.pull === 'down' && ext.level === 'high') {
			const passive = external_kind === 'passive-to-vdd' || external_kind === 'switch-to-vdd'
			const R = sumRange(
				passive
					? [
							[pullRMin, pullRTyp],
							[external_r_ohm, external_r_ohm],
							[series_ohm, series_ohm],
						]
					: [
							[pullRMin, pullRTyp],
							[series_ohm, series_ohm],
						],
				missing,
				passive ? ['pull_ohm（内部下拉）', 'external_r_ohm（外部上拉）'] : ['pull_ohm（内部下拉）'],
			)
			addFinding(
				passive ? 'mcu-pulldown-vs-external-pullup' : 'mcu-pulldown-vs-external-high',
				passive
					? 'MCU 内部下拉与外部上拉电阻（或到 VDD 的闭合开关）构成分压回路，休眠时持续耗流。'
					: 'MCU 内部下拉（到 GND）与外部高电平输出对打：电流从外部高边经内部下拉电阻到 GND，持续不断。',
				'medium',
				R.rMin,
				R.rTyp,
			)
	} else if (mcu.drives && !mcu.od && mcu_level !== null && mcu_level !== ext.level && !isPassiveExternal(external_kind)) {
		// 两个推挽输出（或闭合开关）对打 = 短路。
		// 无源电阻（passive-to-*）**不算对打的驱动器**：它自己是限流元件，
		// 推挽输出驱动到电阻只是持续偏置电流，不是短路 —— 那种情况在下方单独报告。
		const R2 = sumRange(
			[
				[series_ohm, series_ohm],
				[external_r_ohm, external_r_ohm],
			],
			missing,
			['series_ohm 或 external_r_ohm（回路限流电阻）'],
		)
		addFinding(
			'pushpull-vs-pushpull',
			`MCU 推挽输出(${mcu_level === 'high' ? '高' : '低'})与外部主动驱动(${ext.level === 'high' ? '高' : '低'}，推挽输出或闭合开关)方向相反，构成**对电源/地的短路通路**。电流由两侧驱动能力与任何串联电阻限制，可能达数十 mA 并发热、损伤器件。`,
			'high',
			R2.rMin,
			R2.rTyp,
		)
	} else if (mcu.drives && mcu.od && mcu_level === 'low' && ext.level === 'high' && !isPassiveExternal(external_kind)) {
			const R3 = sumRange(
				[
					[series_ohm, series_ohm],
					[external_r_ohm, external_r_ohm],
				],
				missing,
				['series_ohm 或 external_r_ohm'],
			)
			addFinding(
				'opendrain-low-vs-external-high',
				'MCU 开漏输出拉低，同时外部驱动高电平 —— 仍是到地的低阻通路（开漏的下管导通）。',
				'high',
				R3.rMin,
				R3.rTyp,
			)
		} else if (mcu_mode === 'analog') {
			addFinding(
				'analog-vs-active-driver',
				'引脚配置为模拟输入，但外部在主动驱动电平。除可能加载外部输出外，模拟通路的读数会被钳位而失真。确认这是有意设计（如内部 ADC 采样点）。',
				'low',
				null,
				null,
			)
		} else if (mcu.pull === 'up' && ext.level === 'high') {
			// 同向，无电流。
		} else if (mcu.pull === 'down' && ext.level === 'low') {
			// 同向，无电流。
		}
	} else {
		// 外部为高阻/无源/断开的开关。
		if (mcu_mode === 'input-floating' || mcu_mode === 'unknown') {
			addFinding(
				'floating-input',
				'输入悬空（内部无上下拉），外部此刻也是高阻/无驱动。输入电平不确定：CMOS 输入级贯穿电流 + 噪声致振，休眠期功耗不可预测。',
				'medium',
				null,
			)
		}
		if (mcu.pull === 'up' && (external_kind === 'passive-to-gnd' || external_kind === 'switch-to-gnd')) {
			// 已在上面 activelyDrives 分支覆盖（无源到地会被判为主动低），这里仅为兜底。
		}
		if (mcu.pull === 'up' && external_kind === 'open-drain' && ext.level === null) {
			// 内部上拉 + 外部开漏高阻：这正是开漏通信应有的配置，无漏电。
		}
		if (mcu.pull === 'down' && external_kind === 'open-drain' && ext.level === null) {
			const R4 = sumRange(
				[
					[pullRMin, pullRTyp],
					[external_r_ohm, external_r_ohm],
				],
				missing,
				['pull_ohm', 'external_r_ohm'],
			)
			addFinding(
				'pulldown-on-opendrain-bus',
				'开漏总线（I²C 一类）配了内部**下拉**而非上拉：总线无法回到高电平，通信必然失败；若线上还有外部上拉，则该下拉会与其分压产生持续电流。',
				'high',
				R4.rMin,
				R4.rTyp,
			)
		}
	}

	// 无源上下拉分压的情况已在上面 activelyDrives 分支内处理（无源电阻本身即"主动"把电平拉向一侧），
	// 此处不再重复判定，避免同一物理通路报两次。

	// MCU 推挽输出驱动到无源电阻：不是"冲突"，但确实持续耗流。
	if (mcu.drives && !mcu.od && mcu_level === 'high' && external_kind === 'passive-to-gnd') {
		if (typeof external_r_ohm === 'number' && external_r_ohm > 0 && vdd !== null) {
			findings.push({
				kind: 'output-high-into-pulldown',
				path: `MCU 推挽输出高电平，经外部下拉电阻 ${external_r_ohm} Ω 到 GND，持续耗流约 ${formatUa((vdd / (external_r_ohm + series_ohm)) * 1e6)}。若这是有意设计（如驱动 LED/偏置），确认电流可接受。`,
				severity: 'low',
			})
		} else {
			findings.push({
				kind: 'output-high-into-pulldown',
				path: 'MCU 推挽输出高电平，经外部下拉电阻到 GND 持续耗流（未给 external_r_ohm，未估算数值）。',
				severity: 'low',
			})
		}
	}
	if (mcu.drives && !mcu.od && mcu_level === 'low' && external_kind === 'passive-to-vdd') {
		// 对称情况：推挽输出低电平，外部上拉电阻持续向该脚灌电流。
		if (typeof external_r_ohm === 'number' && external_r_ohm > 0 && vdd !== null) {
			findings.push({
				kind: 'output-low-into-pullup',
				path: `MCU 推挽输出低电平，外部上拉电阻 ${external_r_ohm} Ω 从 VDD 持续灌入该脚，耗流约 ${formatUa((vdd / (external_r_ohm + series_ohm)) * 1e6)}。若这是有意设计（如开漏仿真/指示），确认电流可接受；休眠前应把该脚改回高阻或模拟模式。`,
				severity: 'low',
			})
		} else {
			findings.push({
				kind: 'output-low-into-pullup',
				path: 'MCU 推挽输出低电平，外部上拉电阻从 VDD 持续灌入该脚（未给 external_r_ohm，未估算数值）。',
				severity: 'low',
			})
		}
	}

	// 计算电流。**最坏情况用 min 电阻（电流最大）**，同时给出典型值 ——
	// 数据手册给的是范围，只报典型值会低估现场实际耗流。
	let currentUa = null
	let currentTypUa = null
	if (rWorst !== null && rWorst > 0 && vdd !== null) {
		currentUa = toUa(vdd / rWorst)
		currentTypUa = rTyp !== null && rTyp > 0 ? toUa(vdd / rTyp) : null
	} else if (findings.length > 0 && vdd === null) {
		missing.push('vdd（供电电压）')
	}

	const worst = findings.reduce(
		(acc, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[acc] ? f.severity : acc),
		'none',
	)

	/** 修复建议（按通路类型给，去重）。 */
	const fixes = [...new Set(findings.map((f) => FIXES[f.kind]).filter(Boolean))]

	/** 电流估算依据的文字说明。 */
	let currentBasis = null
	if (currentUa !== null) {
		currentBasis = `最坏情况 ${vdd} V ÷ ${rWorst} Ω = ${currentUa} µA` +
			(currentTypUa !== null && rTyp !== rWorst ? `；典型值 ${vdd} V ÷ ${rTyp} Ω = ${currentTypUa} µA` : '')
	} else if (findings.length > 0) {
		currentBasis = `未估算：缺少 ${[...new Set(missing)].join('、')}`
	}

	return {
		pin,
		mcuMode: mcu_mode,
		mcuLevel: mcu_level,
		externalKind: external_kind,
		externalLevel: external_level,
		hasFault: findings.length > 0,
		severity: worst,
		// 通路是确定的；数值只有在数据齐全时才是确定的 —— 两者分开报告。
		pathCertainty: findings.length > 0 ? '通路确定（由拓扑与电平关系判定）' : '未发现漏电通路',
		/** 最坏情况漏电流（µA）：按数据手册的**最小**上下拉电阻计算。 */
		currentUa,
		/** 典型漏电流（µA）：按**典型**上下拉电阻计算。 */
		currentTypUa,
		resistanceBasis: resistanceNote,
		currentBasis,
		findings,
		fixes,
	}
}

/**
 * 外部连接是否为**无源电阻**（非主动驱动器件）。
 * 无源电阻是限流元件而不是对打的驱动器：与 MCU 推挽输出组合只构成持续偏置电流，
 * 不构成短路通路 —— 短路判定必须排除它们。
 * @param {string} kind - {@link EXTERNAL_KINDS} 之一。
 * @returns {boolean} 是否无源。
 */
function isPassiveExternal(kind) {
	return kind === 'passive-to-vdd' || kind === 'passive-to-gnd'
}

/**
 * 把若干「最坏情况 / 典型」电阻对相加。
 *
 * 为什么成对：数据手册给的是 min/typ/max 范围，而**漏电流在电阻最小时最大**。
 * 所以最坏情况必须用 min 电阻，同时给出按 typ 的典型值 —— 只报典型会低估现场耗流。
 *
 * @param {Array<[number|null, number|null]>} pairs - 每项为 `[最坏口径电阻, 典型口径电阻]`。
 * @param {string[]} missing - 缺失项收集数组。
 * @param {string[]} names - 缺失时的名称提示。
 * @returns {{rMin: number|null, rTyp: number|null}} 两个口径的合计电阻。
 */
function sumRange(pairs, missing, names) {
	let rMin = 0
	let rTyp = 0
	let sawAny = false
	for (const [lo, ty] of pairs) {
		if (isPositive(lo)) {
			rMin += lo
			rTyp += isPositive(ty) ? ty : lo
			sawAny = true
		}
	}
	if (!sawAny) {
		for (const n of names) if (!missing.includes(n)) missing.push(n)
		return { rMin: null, rTyp: null }
	}
	return { rMin, rTyp }
}

/**
 * 是否是有效的正电阻值。
 * @param {unknown} v - 待判定值。
 * @returns {boolean} 结果。
 */
function isPositive(v) {
	return typeof v === 'number' && Number.isFinite(v) && v > 0
}

/**
 * 把安培数转成 µA，保留三位小数。
 * @param {number} amps - 电流（A）。
 * @returns {number} 电流（µA）。
 */
function toUa(amps) {
	return Math.round((amps * 1e6 + Number.EPSILON) * 1000) / 1000
}

/** 各通路类型的修复建议。 */
const FIXES = {
	'mcu-pullup-vs-external-low':
		'关闭该引脚的内部上拉（改为浮空输入或模拟输入），电平交由外部驱动决定；若该引脚同时是开漏总线，则应确保总线上只有一处上拉，且上拉不由 MCU 内部提供。',
	'mcu-pulldown-vs-external-high': '关闭该引脚的内部下拉，改用浮空输入或模拟输入。',
	'pushpull-vs-pushpull':
		'把两侧之一改为开漏输出或高阻输入，避免两个推挽源对打；若必须对打，串入足够大的限流电阻（并确认功耗）。',
	'opendrain-low-vs-external-high': '避免 MCU 拉低的同时外部驱动高电平；确认总线仲裁逻辑或改为单向拓扑。',
	'floating-input':
		'给引脚确定电平：使能内部上/下拉，或外接上下拉，或配置为模拟模式（未使用引脚推荐配为模拟）。注意复位期间与初始化之前的默认状态同样需要确认。',
	'mcu-pullup-vs-external-pulldown':
		'只保留一侧的上下拉：通常保留外部（阻值可查、可控），关闭 MCU 内部上下拉；或在休眠前把该引脚切到模拟/高阻。',
	'mcu-pulldown-vs-external-pullup': '同上：只保留一侧的上下拉。',
	'pulldown-on-opendrain-bus': '开漏总线必须用上拉而不是下拉（I²C 一类）；改成内部或外部上拉。',
	'analog-vs-active-driver': '确认该脚是否真的要做模拟输入；若是，外部不应同时主动驱动。',
	'output-high-into-pulldown': '确认此持续电流是否可接受；若不可接受，输出端改开漏并在休眠前置高阻。',
	'output-low-into-pullup': '确认此持续电流是否可接受；若不可接受，休眠前把该脚切到高阻输入/模拟模式，或去掉外部上拉。',
}

/**
 * 批量分析一组引脚。
 *
 * @param {Array<object>} pins - {@link analyzePin} 的输入数组。
 * @param {object} [options] - 选项。
 * @param {number} [options.vdd] - 默认供电电压（V），引脚自身未给时用。
 * @param {number} [options.pull_ohm] - 默认内部上/下拉电阻（Ω），引脚自身未给时用。
 * @returns {object} 汇总报告。
 */
export function analyzePins(pins, options = {}) {
	const results = pins.map((p) =>
		analyzePin({
			...p,
			vdd: p.vdd ?? options.vdd ?? null,
			pull_ohm: p.pull_ohm ?? options.pull_ohm ?? null,
			pull_ohm_min: p.pull_ohm_min ?? options.pull_ohm_min ?? null,
			pull_ohm_typ: p.pull_ohm_typ ?? options.pull_ohm_typ ?? null,
			pull_ohm_max: p.pull_ohm_max ?? options.pull_ohm_max ?? null,
		}),
	)

	const faulty = results.filter((r) => r.hasFault)
	const worst = faulty.reduce(
		(acc, r) => (SEVERITY_ORDER[r.severity] > SEVERITY_ORDER[acc] ? r.severity : acc),
		'none',
	)
	const measured = faulty.filter((r) => r.currentUa !== null)
	const totalUa = measured.reduce((s, r) => s + r.currentUa, 0)
	const totalTyp = measured
		.filter((r) => r.currentTypUa !== null)
		.reduce((s, r) => s + r.currentTypUa, 0)

	const notes = []
	const notEstimated = faulty.length - measured.length
	if (notEstimated > 0) {
		notes.push(
			`${notEstimated} 个引脚的通路已确定，但因缺少电阻/电压数据**未估算电流**。要得到数值，请提供 vdd 与 pull_ohm_min（内部上下拉电阻，查数据手册的**最小值**）。`,
		)
	}
	if (measured.length > 0) {
		notes.push(
			`已估算的 ${measured.length} 个引脚合计：**最坏情况约 ${Math.round(totalUa * 1000) / 1000} µA**` +
				(totalTyp > 0 ? `，典型约 ${Math.round(totalTyp * 1000) / 1000} µA` : '') +
				`。这是按给定电阻的理想值，实际还受 MOS 导通电阻、温度与工艺批次影响。`,
		)
		notes.push(
			'数据手册的上下拉电阻通常给 min/typ/max 范围，且**随温度与电压变化**（高温下电阻偏小、漏电偏大）。做最坏情况设计请用 min 值并留余量。',
		)
	}
	notes.push(
		'这些通路的共同点是**在休眠期依然存在** —— 上拉/下拉与外部驱动的状态不随 MCU 睡眠而改变，所以它们直接吃掉电池寿命。应在进入低功耗模式前逐脚复核。',
	)
	notes.push(
		'本工具只算「引脚级」漏电。还有两类常被漏掉、需要另行计入：**ADC 输入采样网络的电荷转移电流**（随采样率线性增长）与**分压器/上拉的常态电流**，以及每个引脚的输入漏电流 I_LK（数据手册给出，未使用引脚也会有）。',
	)

	return {
		pinCount: results.length,
		faultyCount: faulty.length,
		worstSeverity: worst,
		/** 最坏情况合计漏电（µA）。 */
		totalEstimatedUa: measured.length > 0 ? Math.round(totalUa * 1000) / 1000 : null,
		/** 典型情况合计漏电（µA）。 */
		totalTypUa: measured.length > 0 && totalTyp > 0 ? Math.round(totalTyp * 1000) / 1000 : null,
		pins: results,
		notes,
	}
}

/**
 * 把微安数渲染成人类可读文本。
 * @param {number} ua - 电流（µA）。
 * @returns {string} 文本。
 */
function formatUa(ua) {
	const v = Math.round(ua * 1000) / 1000
	if (v >= 1000) return `${(v / 1000).toFixed(3)} mA`
	return `${v} µA`
}
