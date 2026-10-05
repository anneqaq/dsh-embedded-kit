/**
 * dsh-embedded-kit / lib/lora.js 的独立探针。
 *
 * 直接跑：`node probe/lora.probe.mjs`
 *
 * 做两件事：
 *   ① 用本模块的公式**复现文档里现成的空中时间数值**（基准向量），逐条断言，防止实现漂移；
 *   ② 跑几个真实用例：同一 payload 在 SF7~SF12 下的空中时间对比、EU868 各子频段占空比换算、
 *      以及几个"这个上报周期合不合规"的判定样例。
 *
 * 基准向量的出处全部写在 lib/lora.js 的文件头注释里，这里只标编号：
 *   V1  Sensors 25(23) 7128 (2025) 附录 A —— 按 SX1276 数据手册公式逐步算出的完整样例
 *   V2  d-central.tech LoRa Airtime Calculator 的 "Reference check"（Meshtastic Long Fast）
 *   V3  OpenELAB / haraldkreuzer.net —— 20 字节 payload 在 SF7 与 SF12 的空中时间
 *   V4  aestechno AN1200.13 计算器 —— SF7/BW125 的符号数与总空中时间
 *   V5  ETSI EN 300 220-2 V3.2.2 Table 2 / Table 16 原文数值
 *
 * 本脚本不依赖任何 npm 包，也不改动库文件。
 */

import {
	ADR_TX_POWER_NOTES,
	analyzeDutyCycle,
	analyzeLinkPlan,
	airTime,
	compareSpreadingFactors,
	EU868_SUBBANDS,
	LDRO_SYMBOL_TIME_LIMIT_SEC,
	LORAWAN_EU868_MANDATORY_CHANNELS_MHZ,
	POLITE_SPECTRUM_ACCESS_LIMITS,
	symbolTimeSec,
	TTN_FAIR_USE_POLICY,
} from '../lib/lora.js'

let passed = 0
let failed = 0

/**
 * 断言辅助：既打印也计数。
 *
 * @param {string} label - 断言说明。
 * @param {boolean} ok - 是否通过。
 * @param {string} detail - 细节。
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
 * 宽松数值比较（文档给的是四舍五入后的值）。
 *
 * @param {number} actual - 实测/算出的值。
 * @param {number} expected - 文档值。
 * @param {number} tol - 绝对容差。
 * @returns {boolean} 是否在容差内。
 */
function near(actual, expected, tol) {
	return Math.abs(actual - expected) <= tol
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 基准向量：复现文档里给的空中时间
// ─────────────────────────────────────────────────────────────────────────────

section('① 基准向量：复现文档里现成的空中时间（出处见 lib/lora.js 文件头）')

console.log('\n-- V1  Sensors 25(23) 7128 (2025) 附录 A：SF6 / BW500k / PL240 / CR4-5 / 显式包头 / CRC 开 --')
{
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
	console.log(
		`     本模块: Ts=${(a.tsSec * 1000).toFixed(3)} ms  Tpreamble=${(a.tpreambleSec * 1000).toFixed(3)} ms  ` +
			`npayload=${a.payloadSymbols}  Tpayload=${(a.tpayloadSec * 1000).toFixed(3)} ms  ToA=${(a.toaSec * 1000).toFixed(3)} ms`,
	)
	console.log('     文档值: Ts=0.128 ms        Tpreamble=1.568 ms             npayload=413  Tpayload=52.864 ms       ToA=54.432 ms')
	check('V1 符号时间 Ts = 0.128 ms', near(a.tsSec * 1000, 0.128, 1e-9), `${(a.tsSec * 1000).toFixed(6)} ms`)
	check('V1 前导时长 = 1.568 ms', near(a.tpreambleSec * 1000, 1.568, 1e-9), `${(a.tpreambleSec * 1000).toFixed(6)} ms`)
	check('V1 payload 符号数 = 413', a.payloadSymbols === 413, `${a.payloadSymbols}`)
	check('V1 payload 时长 = 52.864 ms', near(a.tpayloadSec * 1000, 52.864, 1e-9), `${(a.tpayloadSec * 1000).toFixed(6)} ms`)
	check('V1 总空中时间 = 54.432 ms', near(a.toaSec * 1000, 54.432, 1e-9), `${(a.toaSec * 1000).toFixed(6)} ms`)
}

console.log('\n-- V2  d-central.tech "Reference check"：Meshtastic Long Fast，SF11 / BW250k / PL16 / CR4-5 / 前导 16 --')
{
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
	console.log(
		`     本模块: Ts=${(a.tsSec * 1000).toFixed(3)} ms  npayload=${a.payloadSymbols}  ToA=${(a.toaSec * 1000).toFixed(3)} ms`,
	)
	console.log('     文档值: Ts=8.192 ms             npayload=23             ToA=354.304 ms')
	check('V2 符号时间 Ts = 8.192 ms', near(a.tsSec * 1000, 8.192, 1e-9), `${(a.tsSec * 1000).toFixed(6)} ms`)
	check('V2 payload 符号数 = 23', a.payloadSymbols === 23, `${a.payloadSymbols}`)
	check('V2 总空中时间 = 354.304 ms', near(a.toaSec * 1000, 354.304, 1e-9), `${(a.toaSec * 1000).toFixed(6)} ms`)
}

console.log('\n-- V3  OpenELAB / haraldkreuzer.net：BW125k / CR4-5 / 显式包头 / CRC 开 / 前导 8 / PL20 --')
{
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
	console.log(`     本模块: SF7  ToA=${(sf7.toaSec * 1000).toFixed(3)} ms        SF12 ToA=${(sf12.toaSec * 1000).toFixed(3)} ms`)
	console.log('     文档值: SF7  "56.6 ms"                SF12 "1,319 ms"（另一处写作 ≈1.32 s）')
	check('V3a SF7 20 字节 ≈ 56.6 ms', near(sf7.toaSec * 1000, 56.6, 0.1), `${(sf7.toaSec * 1000).toFixed(3)} ms`)
	check('V3b SF12 20 字节 ≈ 1,319 ms', near(sf12.toaSec * 1000, 1319, 1), `${(sf12.toaSec * 1000).toFixed(3)} ms`)
	check('V3c SF12 自动 LDRO 判为 on（Ts=32.768 ms > 16 ms）', sf12.ldro === true, `ldro=${sf12.ldro}`)
	check('V3d SF7 自动 LDRO 判为 off（Ts=1.024 ms < 16 ms）', sf7.ldro === false, `ldro=${sf7.ldro}`)
}

console.log('\n-- V4  aestechno（AN1200.13 计算器）：SF7 / BW125k / 前导 8 / DE=0 --')
{
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
	console.log(`     本模块: Ts=${(a.tsSec * 1000).toFixed(3)} ms  npayload=${a.payloadSymbols}  ToA=${(a.toaSec * 1000).toFixed(3)} ms`)
	console.log('     文档值: Ts=1.024 ms             npayload=28             ToA=41.216 ms')
	check('V4 符号时间 Ts = 1.024 ms', near(a.tsSec * 1000, 1.024, 1e-9), `${(a.tsSec * 1000).toFixed(6)} ms`)
	check('V4 payload 符号数 = 28', a.payloadSymbols === 28, `${a.payloadSymbols}`)
	check('V4 总空中时间 = 41.216 ms', near(a.toaSec * 1000, 41.216, 1e-9), `${(a.toaSec * 1000).toFixed(6)} ms`)
}

console.log('\n-- 符号时间表（SX1276 数据手册口径 Ts = 2^SF / BW，BW=125 kHz）--')
{
	const expectMs = { 7: 1.024, 8: 2.048, 9: 4.096, 10: 8.192, 11: 16.384, 12: 32.768 }
	console.log('   SF   Ts(ms)        Ts > 16 ms → LDRO 强制？')
	for (const sf of [7, 8, 9, 10, 11, 12]) {
		const tsMs = symbolTimeSec(sf, 125000) * 1000
		const req = tsMs / 1000 > LDRO_SYMBOL_TIME_LIMIT_SEC
		console.log(`   ${String(sf).padStart(2)}   ${tsMs.toFixed(3).padStart(8)}      ${req ? '是 → LDRO on' : '否'}`)
		check(`SF${sf} @125k Ts = ${expectMs[sf]} ms`, near(tsMs, expectMs[sf], 1e-9), `${tsMs.toFixed(6)} ms`)
	}
	check(
		'LDRO 门限恰好在 SF11 处跨过（SF10 以下不强制）',
		symbolTimeSec(10, 125000) < LDRO_SYMBOL_TIME_LIMIT_SEC && symbolTimeSec(11, 125000) > LDRO_SYMBOL_TIME_LIMIT_SEC,
		`SF10=${(symbolTimeSec(10, 125000) * 1000).toFixed(3)} ms, SF11=${(symbolTimeSec(11, 125000) * 1000).toFixed(3)} ms`,
	)
}

console.log('\n-- V5  EU868 子频段（ETSI EN 300 220-2 V3.2.2 Table 2 原文数值）--')
{
	// 只断言原文写死的数值，防止有人"顺手改成记忆里的版本"。
	const expect = {
		k0: { from: 862.0, to: 863.0, mw: 25, dc: 0.001 },
		k: { from: 863.0, to: 865.0, mw: 25, dc: 0.001 },
		l: { from: 865.0, to: 868.0, mw: 25, dc: 0.01 },
		m: { from: 868.0, to: 868.6, mw: 25, dc: 0.01 },
		n: { from: 868.7, to: 869.2, mw: 25, dc: 0.001 },
		o: { from: 869.4, to: 869.65, mw: 500, dc: 0.1 },
		p: { from: 869.7, to: 870.0, mw: 5, dc: null },
		q: { from: 869.7, to: 870.0, mw: 25, dc: 0.01 },
	}
	console.log('   段   频率范围(MHz)          e.r.p.(mW)   占空比上限     可走 polite spectrum access')
	for (const [id, e] of Object.entries(expect)) {
		const b = EU868_SUBBANDS[id]
		const dcText = b.dutyCycle === null ? 'No requirement' : `${(b.dutyCycle * 100).toFixed(3)} %`
		console.log(
			`   ${b.band.padEnd(4)} ${`${b.fromMHz}–${b.toMHz}`.padEnd(20)} ${String(b.maxErpMw).padStart(6)}      ` +
				`${dcText.padEnd(15)} ${b.politeSpectrumAccess ? '是' : '否'}`,
		)
		check(`EU868 ${b.band} 频率下限 ${e.from} MHz`, b.fromMHz === e.from, `${b.fromMHz}`)
		check(`EU868 ${b.band} 频率上限 ${e.to} MHz`, b.toMHz === e.to, `${b.toMHz}`)
		check(`EU868 ${b.band} e.r.p. = ${e.mw} mW`, b.maxErpMw === e.mw, `${b.maxErpMw}`)
		check(`EU868 ${b.band} 占空比上限 = ${e.dc === null ? 'null' : `${e.dc * 100}%`}`, b.dutyCycle === e.dc, `${b.dutyCycle}`)
	}
	check(
		'868 MHz 的 LoRa 子频段未规定 Ton/Toff（Table 2 原文无此项，不得臆造）',
		['k0', 'k', 'l', 'm', 'n', 'o', 'p', 'q'].every(
			(id) => EU868_SUBBANDS[id].maxOnTimeSec === null && EU868_SUBBANDS[id].minOffTimeSec === null,
		),
		'全部为 null',
	)
}

console.log('\n-- V5b  polite spectrum access 时限（Table 16 原文数值）--')
{
	const p = POLITE_SPECTRUM_ACCESS_LIMITS
	console.log(`     CCA 最小侦听         ${(p.ccaMinSec * 1e6).toFixed(0)} µs`)
	console.log(`     单次发射 Ton 上限     ${p.maxSingleTransmissionSec} s`)
	console.log(`     对话/轮询序列上限     ${p.maxDialogueSec} s`)
	console.log(`     每 200 kHz 每小时累计 ${p.maxCumulativeOnSecPerHourPer200kHz} s`)
	console.log(`     同频点最小静默 Toff   ${p.minOffTimeSec * 1000} ms`)
	check('Table 16 CCA 最小侦听 = 160 µs', near(p.ccaMinSec * 1e6, 160, 1e-9), `${(p.ccaMinSec * 1e6).toFixed(2)} µs`)
	check('Table 16 单次发射 ≤ 1 s', p.maxSingleTransmissionSec === 1, `${p.maxSingleTransmissionSec} s`)
	check('Table 16 对话序列 ≤ 4 s', p.maxDialogueSec === 4, `${p.maxDialogueSec} s`)
	check('Table 16 每 200 kHz 每小时累计 ≤ 100 s', p.maxCumulativeOnSecPerHourPer200kHz === 100, `${p.maxCumulativeOnSecPerHourPer200kHz} s`)
	check('Table 16 同频点最小静默 = 100 ms', near(p.minOffTimeSec * 1000, 100, 1e-9), `${p.minOffTimeSec * 1000} ms`)
}

console.log('\n-- V5c  网络侧策略（非频谱法规）--')
{
	console.log(`     TTN Fair Use：上行空中时间 ≤ ${TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay} s/天/节点，下行 ≤ ${TTN_FAIR_USE_POLICY.downlinkMessagesPerDay} 条/天/节点`)
	console.log(`     LoRaWAN EU868 强制信道：${LORAWAN_EU868_MANDATORY_CHANNELS_MHZ.join(' / ')} MHz（125 kHz，1% 占空比）`)
	check('TTN 每日上行额度 = 30 s', TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay === 30, `${TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay}`)
	check('TTN 每日下行 = 10 条', TTN_FAIR_USE_POLICY.downlinkMessagesPerDay === 10, `${TTN_FAIR_USE_POLICY.downlinkMessagesPerDay}`)
	check(
		'LoRaWAN EU868 三个强制信道 = 868.1 / 868.3 / 868.5 MHz',
		JSON.stringify(LORAWAN_EU868_MANDATORY_CHANNELS_MHZ) === JSON.stringify([868.1, 868.3, 868.5]),
		LORAWAN_EU868_MANDATORY_CHANNELS_MHZ.join(', '),
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 真实用例
// ─────────────────────────────────────────────────────────────────────────────

section('② 真实用例：同一 payload 在 SF7~SF12 下的空中时间与 EU868 1% 可行性')

console.log('\n-- 用例 A：19 字节 PHY payload（6 字节应用数据 + LoRaWAN 约 13 字节 MAC 开销）--')
console.log('            BW=125 kHz / CR 4-5 / 前导 8 / 显式包头 / CRC 开 / LDRO 自动')
console.log('           子频段 M（868.0–868.6 MHz，占空比 1%，即 36 s/h）')
{
	const cmp = compareSpreadingFactors({
		sfList: [7, 8, 9, 10, 11, 12],
		bwHz: 125000,
		codingRate: '4/5',
		preambleSymbols: 8,
		payloadBytes: 19,
		crc: true,
		implicitHeader: false,
		ldro: 'auto',
		subband: 'm',
	})
	console.log(
		'\n   SF  Ts(ms)   LDRO  符号数  ToA(ms)      1% 每小时最多   等效次/分钟   最小周期(s)  发完静默(s)',
	)
	for (const r of cmp.rows) {
		const perMin = (60 * 0.01) / r.toaSec
		console.log(
			`   ${String(r.sf).padStart(2)}  ${(r.tsSec * 1000).toFixed(3).padStart(7)}   ${(r.ldro ? 'on ' : 'off')}  ` +
				`${String(r.payloadSymbols).padStart(5)}  ${(r.toaSec * 1000).toFixed(3).padStart(9)}   ` +
				`${String(r.maxPacketsPerHour).padStart(11)}   ${perMin.toFixed(3).padStart(11)}   ` +
				`${r.minPeriodSec.toFixed(3).padStart(10)}   ${r.requiredSilenceSec.toFixed(3).padStart(10)}`,
		)
	}
	const sf7 = cmp.rows[0]
	const sf12 = cmp.rows[5]
	console.log(
		`\n   → SF7 与 SF12 的空中时间比为 ${(sf12.toaSec / sf7.toaSec).toFixed(2)}×，` +
			`1% 下每小时可发次数从 ${sf7.maxPacketsPerHour} 掉到 ${sf12.maxPacketsPerHour}（约 ${(sf7.maxPacketsPerHour / sf12.maxPacketsPerHour).toFixed(1)}× 差距）。`,
	)
	console.log(`   → SF12 每 ${sf12.minPeriodSec.toFixed(1)} s 才允许发一包，即约 ${(1 / sf12.minPeriodSec).toFixed(4)} 包/s；`)
	console.log(`     想"每 10 s 上报一次"，在 SF12 下是不可能的（需要 ${sf12.minPeriodSec.toFixed(1)} s/包）。`)
	check('SF7 → SF12 空中时间单调递增', cmp.rows.every((r, i) => i === 0 || r.toaSec > cmp.rows[i - 1].toaSec), 'ok')
	check(
		'逐 SF 的 LDRO 与 16 ms 规则一致',
		cmp.rows.every((r) => r.ldro === r.ldroRequired),
		cmp.rows.map((r) => `SF${r.sf}:${r.ldro ? 'on' : 'off'}`).join(' '),
	)
	check(
		'SF11/SF12 @125 kHz 自动打开 LDRO',
		cmp.rows[4].ldro === true && cmp.rows[5].ldro === true,
		`SF11=${cmp.rows[4].ldro}, SF12=${cmp.rows[5].ldro}`,
	)
	check(
		'1% 下每小时包数随 SF 严格递减',
		cmp.rows.every((r, i) => i === 0 || r.maxPacketsPerHour <= cmp.rows[i - 1].maxPacketsPerHour),
		cmp.rows.map((r) => `SF${r.sf}:${r.maxPacketsPerHour}`).join(' '),
	)
}

console.log('\n-- 用例 B：合规判定 —— 每 60 s 上报一次的土壤传感器（19 字节 PHY payload）--')
{
	const make = (sf) =>
		analyzeLinkPlan({
			sf,
			bwHz: 125000,
			codingRate: '4/5',
			preambleSymbols: 8,
			payloadBytes: 19,
			crc: true,
			implicitHeader: false,
			ldro: 'auto',
			subband: 'm',
			targetPeriodSec: 60,
			networkAirTimeSecPerDay: TTN_FAIR_USE_POLICY.uplinkAirTimeSecPerDay,
		})

	for (const sf of [7, 10, 12]) {
		const plan = make(sf)
		console.log(
			`\n   ── SF${sf}：ToA=${(plan.airTime.toaSec * 1000).toFixed(3)} ms，` +
				`实际占空比 ${(plan.dutyCycle.usedDutyCycle * 100).toFixed(4)}% / 上限 1%  ` +
				`法规→${plan.regulatoryCompliance ? '过' : '不过'}  网络额度→${plan.networkCompliance ? '过' : '不过'}`,
		)
		for (const c of plan.checks.filter((c) => c.name === '占空比' || c.name === '网络侧每日上行空中时间')) {
			console.log(`      ${c.pass ? '[ ok ]' : '[FAIL]'} ${c.name}：${c.detail}`)
		}
	}

	check('SF7 每 60 s 一包满足 1% 占空比（法规侧）', make(7).regulatoryCompliance === true, 'ok')
	check('SF12 每 60 s 一包违反 1% 占空比（法规侧）', make(12).regulatoryCompliance === false, 'ok')
	check(
		'SF12 之所以法规不过，是被"占空比"这一条挡住',
		make(12).checks.find((c) => c.name === '占空比').pass === false,
		'ok',
	)
	// 这一条是真实结论：即使 SF7 法规侧只用了 0.086% 的占空比，TTN 的 30 s/天 公平使用额度
	// 也撑不住 60 s 一包（等效 74 s/天）。法规与网络策略是两把尺子。
	check(
		'法规与网络额度分开报：SF7 法规过、但 TTN 30 s/天 额度不过',
		make(7).regulatoryCompliance === true && make(7).networkCompliance === false,
		`合规占空比 ${(make(7).dutyCycle.usedDutyCycle * 100).toFixed(4)}%，等效 ${(make(7).dutyCycle.usedTransmitSec * 24).toFixed(1)} s/天`,
	)
}

console.log('\n-- 用例 C：换成 10% 的 O 段（869.4–869.65 MHz）--')
{
	const p = analyzeLinkPlan({
		sf: 12,
		bwHz: 125000,
		codingRate: '4/5',
		preambleSymbols: 8,
		payloadBytes: 19,
		crc: true,
		implicitHeader: false,
		ldro: 'auto',
		subband: 'o',
		targetPeriodSec: 60,
	})
	console.log(
		`   ToA=${(p.airTime.toaSec * 1000).toFixed(3)} ms  实际占空比 ${(p.dutyCycle.usedDutyCycle * 100).toFixed(4)}% / 上限 10% ` +
			`→ 每小时最多 ${p.dutyCycle.maxPacketsPerHour} 包，最小周期 ${p.dutyCycle.minPeriodSec.toFixed(3)} s`,
	)
	check('SF12 每 60 s 一包在 O 段（10%）下满足法规', p.regulatoryCompliance === true, 'ok')
	check('未给网络额度时 networkCompliance 不误报', p.networkCompliance === true, 'ok')
	check('O 段每小时预算 = 360 s', Math.abs(p.dutyCycle.maxTransmitSecPerHour - 360) < 1e-9, `${p.dutyCycle.maxTransmitSecPerHour} s`)
}

console.log('\n-- 用例 D：两条合规路径的差别（同一包，M 段）--')
{
	const airTimeSec = airTime({
		sf: 12,
		bwHz: 125000,
		codingRate: '4/5',
		preambleSymbols: 8,
		payloadBytes: 19,
		crc: true,
		implicitHeader: false,
		ldro: 'auto',
	}).toaSec
	const viaDuty = analyzeDutyCycle({ airTimeSec, subband: 'm', regime: 'duty-cycle', packetsPerWindow: 10 })
	const viaPsa = analyzeDutyCycle({ airTimeSec, subband: 'm', regime: 'polite-spectrum-access', packetsPerWindow: 10 })
	console.log(
		`   占空比路径：每小时上限 ${viaDuty.maxTransmitSecPerHour.toFixed(1)} s → 每小时最多 ${viaDuty.maxPacketsPerHour} 包，` +
			`每包后静默 ${viaDuty.requiredSilenceSec.toFixed(3)} s`,
	)
	console.log(
		`   polite spectrum access 路径：每 200 kHz 每小时上限 ${viaPsa.maxTransmitSecPerHour} s → 每小时最多 ${viaPsa.maxPacketsPerHour} 包，` +
			`但单次发射被限制在 ${POLITE_SPECTRUM_ACCESS_LIMITS.maxSingleTransmissionSec} s 内，同频点静默 ≥ ${POLITE_SPECTRUM_ACCESS_LIMITS.minOffTimeSec * 1000} ms`,
	)
	check('两条路径的每小时包数不同（说明它们不是同一套约束）', viaDuty.maxPacketsPerHour !== viaPsa.maxPacketsPerHour, `${viaDuty.maxPacketsPerHour} vs ${viaPsa.maxPacketsPerHour}`)
	check(
		'走 PSA 时 SF12 单包超过 1 s，会触发警告',
		viaPsa.checks.find((c) => c.name === 'polite spectrum access 单次发射').pass === false,
		`ToA=${airTimeSec.toFixed(3)} s`,
	)
	check(
		'两条路径都有"选择此路径则不再叠加另一条"的说明',
		viaPsa.notes.some((n) => n.includes('不再')) && viaDuty.notes.some((n) => n.includes('法规原文口径')),
		'ok',
	)
}

console.log('\n-- 用例 E：当子频段没有 Ton 规定时，本模块拒绝判定（不臆造阈值）--')
{
	const r = analyzeDutyCycle({
		airTimeSec: 1.4,
		subband: 'm',
		regime: 'duty-cycle',
	})
	const tonCheck = r.checks.find((c) => c.name === '单次发射时长')
	console.log(`   ${tonCheck.pass ? '[ ok ]' : '[FAIL]'} 单次发射时长：${tonCheck.detail}`)
	check('未提供 Ton 来源时该判定被跳过而非猜测', /未规定 Ton/.test(tonCheck.detail), tonCheck.detail)
	check('并在 notes 里说明了要传 maxOnTimeSec 才能判', r.notes.some((n) => n.includes('maxOnTimeSec')), 'ok')
}

console.log('\n-- 用例 F：ADR 与发射功率（只说明影响，不给阈值）--')
{
	for (const n of ADR_TX_POWER_NOTES) console.log(`   · ${n}`)
	check('ADR/功率说明不含任何臆造阈值', ADR_TX_POWER_NOTES.every((n) => !/\d+\s*dBm\s*(以|门限|阈值)/.test(n)), `共 ${ADR_TX_POWER_NOTES.length} 条`)
	const plan = analyzeLinkPlan({
		sf: 9,
		bwHz: 125000,
		codingRate: '4/5',
		preambleSymbols: 8,
		payloadBytes: 19,
		crc: true,
		implicitHeader: false,
		subband: 'm',
		targetPeriodSec: 300,
	})
	check('综合结果的 ADR 说明被打了标签', plan.notes.some((n) => n.startsWith('[ADR/功率]')), 'ok')
	check('综合结果同时含空气时间/占空比/SF 对比三块', Boolean(plan.airTime && plan.dutyCycle && plan.sfComparison), 'ok')
}

console.log('\n-- 单位防呆：把 kHz 当 Hz 传时必须报错，而不是静默算错 --')
{
	const throws = (fn) => {
		try {
			fn()
			return false
		} catch {
			return true
		}
	}
	check(
		'bwHz=125（误传 kHz）被拒绝',
		throws(() => airTime({ sf: 7, bwHz: 125, codingRate: '4/5', preambleSymbols: 8, payloadBytes: 19, crc: true, implicitHeader: false, ldro: false })),
		'抛出异常',
	)
	check(
		'bwHz=125000（正确 Hz）被接受',
		!throws(() => symbolTimeSec(7, 125000)),
		`Ts=${(symbolTimeSec(7, 125000) * 1000).toFixed(3)} ms`,
	)
	check('sf=13 被拒绝', throws(() => symbolTimeSec(13, 125000)), '抛出异常')
	check('编码率 4/9 被拒绝', throws(() => airTime({ sf: 7, bwHz: 125000, codingRate: '4/9', preambleSymbols: 8, payloadBytes: 19, crc: true, implicitHeader: false, ldro: false })), '抛出异常')
	check('payloadBytes=0 被拒绝', throws(() => airTime({ sf: 7, bwHz: 125000, codingRate: '4/5', preambleSymbols: 8, payloadBytes: 0, crc: true, implicitHeader: false, ldro: false })), '抛出异常')
	check(
		'不给 subband 时 analyzeLinkPlan 拒绝替你假设区域',
		throws(() => analyzeLinkPlan({ sf: 7, bwHz: 125000, codingRate: '4/5', preambleSymbols: 8, payloadBytes: 19, crc: true, implicitHeader: false })),
		'抛出异常',
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// 小结
// ─────────────────────────────────────────────────────────────────────────────

section('小结')
console.log(`断言：通过 ${passed}，失败 ${failed}`)
if (failed > 0) {
	console.log('存在失败断言 —— 公式或法规常数可能已漂移，请复核。')
	process.exitCode = 1
} else {
	console.log('全部通过：本模块的公式复现了文档给定的空中时间，EU868 常数与 ETSI 原文一致。')
}
