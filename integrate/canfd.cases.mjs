/**
 * `canfd_timing` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './canfd.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖两类东西：
 *   ① lib/canfd.js 里**规范基准向量**——DLC 映射表、CRC17/21 分界、
 *      CRC 场固定填充位个数（6 / 7）、BRS 位 1800 ns、stuff count 格雷码、动态填充最坏值；
 *   ② 本工具描述符（integrate/canfd.tool.mjs）的形状与参数约束；
 *   ③ 负向用例：缺关键量必须抛错点名、时钟不够必须报"无解"、未使能 TDC 必须报警。
 *
 * 用例全部是同步的（execute 是 async，其行为另由验证脚本覆盖），这样不依赖
 * 宿主 test 实现是否 await。用例只读，不修改 lib 中任何东西。
 *
 * @module dsh-embedded-kit/integrate/canfd.cases
 */

import {
	analyzeCanFdBitTiming,
	analyzeDlc,
	brsSwitchTiming,
	bytesToDlc,
	CANFD_DLC_TO_BYTES,
	CANFD_VALID_PAYLOAD_BYTES,
	crcVariantForBytes,
	CRC_VARIANTS,
	dlcToBytes,
	dynamicStuffBitsWorstCase,
	estimateFrameTime,
	fixedStuffBits,
	frameLayout,
	stuffCountEncoding,
} from '../lib/canfd.js'

import { tool } from './canfd.tool.mjs'

/** 探针里用过的控制器寄存器范围（示例芯片口径，非本模块内置默认值）。 */
const LIMITS_FD = {
	brpMax: 1024,
	tseg1TqMax: 256,
	tseg2TqMax: 128,
	sjwTqMax: 128,
	nbtMin: 8,
	nbtMax: 385,
}

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert }) {
	/* ── ① 规范基准向量 ─────────────────────────────────────────── */

	test('DLC 映射表：FD 的 16 种合法长度与经典 CAN 的截断', () => {
		assert.deepEqual(CANFD_DLC_TO_BYTES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64])
		assert.deepEqual(CANFD_VALID_PAYLOAD_BYTES, CANFD_DLC_TO_BYTES)
		for (let dlc = 0; dlc <= 15; dlc += 1) {
			assert.equal(dlcToBytes(dlc), CANFD_DLC_TO_BYTES[dlc], `FD DLC ${dlc}`)
			assert.equal(dlcToBytes(dlc, { fd: false }), Math.min(dlc, 8), `经典 DLC ${dlc}`)
		}
		// DLC 9~15 是 FD 的非线性档，经典 CAN 侧一律 8 字节
		assert.equal(analyzeDlc({ dlc: 9 }).dataBytes, 12)
		assert.equal(analyzeDlc({ dlc: 15 }).dataBytes, 64)
		assert.equal(analyzeDlc({ dlc: 15, options: { fd: false } }).dataBytes, 8)
	})

	test('字节数→DLC：10 字节在 FD 里没有编码，必须补齐到 12（DLC 9）', () => {
		const exact = bytesToDlc(12)
		assert.equal(exact.dlc, 9)
		assert.equal(exact.encodedBytes, 12)
		assert.equal(exact.paddingBytes, 0)
		assert.equal(exact.exact, true)

		const padded = bytesToDlc(10)
		assert.equal(padded.dlc, 9)
		assert.equal(padded.encodedBytes, 12)
		assert.equal(padded.paddingBytes, 2)
		assert.equal(padded.exact, false)

		assert.equal(bytesToDlc(0).dlc, 0)
		assert.equal(bytesToDlc(8).dlc, 8)
		assert.equal(bytesToDlc(64).dlc, 15)
		assert.equal(bytesToDlc(64).exact, true)
	})

	test('CRC 17/21 分界：数据场 ≤16 字节用 CRC17、>16 字节用 CRC21', () => {
		assert.equal(analyzeDlc({ dlc: 10 }).dataBytes, 16)
		assert.equal(analyzeDlc({ dlc: 10 }).crc.bits, 17)
		assert.equal(analyzeDlc({ dlc: 11 }).dataBytes, 20)
		assert.equal(analyzeDlc({ dlc: 11 }).crc.bits, 21)

		assert.equal(crcVariantForBytes(16).id, 'crc17')
		assert.equal(crcVariantForBytes(17).id, 'crc21')
		assert.equal(crcVariantForBytes(64).id, 'crc21')

		// 多项式与 Hamming 距离（Bosch《CAN with Flexible Data-Rate》V1.0）
		assert.equal(CRC_VARIANTS.crc15.polynomialHex, '0xC599')
		assert.equal(CRC_VARIANTS.crc17.polynomialHex, '0x3685B')
		assert.equal(CRC_VARIANTS.crc21.polynomialHex, '0x302899')
		assert.ok([15, 17, 21].every((b) => CRC_VARIANTS[`crc${b}`].hammingDistance === 6))

		// 经典 CAN 的 CRC 不计填充位，FD 计（Bosch 原文）
		assert.equal(CRC_VARIANTS.crc15.includesStuffBits, false)
		assert.equal(CRC_VARIANTS.crc17.includesStuffBits, true)
		assert.equal(CRC_VARIANTS.crc21.includesStuffBits, true)
	})

	test('CRC 场固定填充位：CRC17 → 6 个、CRC21 → 7 个（= 1 + floor(CRC 场位数/4)）', () => {
		const a = fixedStuffBits(17)
		const b = fixedStuffBits(21)

		assert.equal(a.crcFieldBits, 21) // stuff count(4) + CRC(17)
		assert.equal(a.count, 6)
		assert.deepEqual(a.positionsAfter, [0, 4, 8, 12, 16, 20])

		assert.equal(b.crcFieldBits, 25) // stuff count(4) + CRC(21)
		assert.equal(b.count, 7)
		assert.deepEqual(b.positionsAfter, [0, 4, 8, 12, 16, 20, 24])

		// 公式自洽
		assert.equal(a.count, 1 + Math.floor(a.crcFieldBits / 4))
		assert.equal(b.count, 1 + Math.floor(b.crcFieldBits / 4))

		// 与 DLC 侧打通：DLC 10（16 字节）→ CRC17 → 6 个；DLC 15（64 字节）→ CRC21 → 7 个
		assert.equal(analyzeDlc({ dlc: 10 }).fixedStuffBits.count, 6)
		assert.equal(analyzeDlc({ dlc: 15 }).fixedStuffBits.count, 7)
	})

	test('BRS 位 = 1800 ns、CRC 界定符位 = 700 ns（NXP AMF-AUT-T3346 原文示例）', () => {
		const r = brsSwitchTiming({
			arbitrationBitrate: 500_000,
			dataBitrate: 2_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.6,
		})
		assert.equal(r.arbitrationBitTimeNs, 2000)
		assert.equal(r.dataBitTimeNs, 500)
		assert.equal(r.brsBitNs, 1800) // 2000 × 0.8 + 500 × (1 − 0.6)
		assert.equal(r.crcDelimiterBitNs, 700) // 500 × 0.6 + 2000 × (1 − 0.8)
		assert.equal(r.bitrateRatio, 4)

		// mixed bit 的定性性质：BRS 比纯仲裁位短，CRC 界定符比纯数据位长
		assert.ok(r.brsBitNs < r.arbitrationBitTimeNs)
		assert.ok(r.crcDelimiterBitNs > r.dataBitTimeNs)
		assert.ok(r.checks.every((c) => c.pass === true))
	})

	test('stuff count：3 位格雷码 + 1 位偶校验，8 项全为偶校验', () => {
		for (let n = 0; n <= 7; n += 1) {
			const e = stuffCountEncoding(n)
			assert.equal(e.modulo8, n)
			assert.equal(e.bits.length, 4)
			assert.equal(e.bits.reduce((acc, b) => acc + b, 0) % 2, 0, `n=${n} 应为偶校验`)
			assert.equal(e.parity, e.bits[3])
			assert.equal(e.grayCode.join(''), (n ^ (n >> 1)).toString(2).padStart(3, '0'), `n=${n} 格雷码`)
		}
		// 超过 8 取模
		assert.equal(stuffCountEncoding(13).modulo8, 5)
		assert.deepEqual(stuffCountEncoding(13).bits, stuffCountEncoding(5).bits)
	})

	test('动态填充最坏个数：经典 CAN 8 字节 → 24 个、整帧最多 132 位（教材交叉验证）', () => {
		// SOF(1) + ID(11) + RTR(1) + IDE(1) + r0(1) + DLC(4) + Data(64) + CRC(15)
		const classicRegionBits = 1 + 11 + 1 + 1 + 1 + 4 + 64 + 15
		assert.equal(classicRegionBits, 98)
		assert.equal(dynamicStuffBitsWorstCase(classicRegionBits), 24)
		assert.equal(classicRegionBits + 24 + 10, 132)

		// "每 4 位 1 个填充位"的交替模式 → floor((L − 1) / 4)
		assert.equal(dynamicStuffBitsWorstCase(0), 0)
		assert.equal(dynamicStuffBitsWorstCase(1), 0)
		assert.equal(dynamicStuffBitsWorstCase(5), 1)
		assert.equal(dynamicStuffBitsWorstCase(9), 2)

		// FD 帧的动态填充止于数据场结束，其区域位数应与 frameLayout 报告的一致
		const layout = frameLayout({ dlc: 15 })
		assert.equal(layout.totals.stuffingRegionBits, 534) // SOF+ID+RRS+IDE+FDF+res+BRS+ESI+DLC(4)+Data(512) = 1+11+1+1+1+1+1+1+4+512（逐项独立求和，非抄实现输出）
		assert.equal(layout.totals.worstCaseStuffBits, dynamicStuffBitsWorstCase(534))
	})

	test('FD 帧结构：标准格式固定开销 67 位、扩展格式 86 位（CRC21 口径，不含数据场）', () => {
		const sff = frameLayout({ dlc: 15 })
		const eff = frameLayout({ dlc: 15, options: { extended: true } })

		assert.equal(sff.dataBytes, 64)
		assert.equal(sff.totals.idealTotalBits, 579)
		assert.equal(sff.totals.idealTotalBits - sff.dataBytes * 8, 67)
		assert.equal(eff.totals.idealTotalBits - eff.dataBytes * 8, 86)
		// 扩展格式比标准格式多的就是仲裁场那 19 位（SRR 1 + 扩展 ID 18）
		assert.equal(eff.totals.idealTotalBits - sff.totals.idealTotalBits, 19)

		// BRS 与 CRC 界定符是两个 mixed bit
		assert.equal(sff.totals.bitsByRate.mixed, 2)

		// CRC17 口径：CRC 少 4 位、FSB 少 1 个 → 67 − 4 − 1 = 62
		const sff16 = frameLayout({ dlc: 10 })
		assert.equal(sff16.totals.idealTotalBits - sff16.dataBytes * 8, 62)

		// 逐字段累加自洽
		assert.ok(sff.checks.find((c) => c.name === '帧内位数合计是否自洽').pass)
	})

	test('整帧时长估算：含 BRS 与 CRC 界定符，且随 DLC 单调增长', () => {
		const base = {
			arbitrationBitrate: 500_000,
			dataBitrate: 2_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.75,
		}
		const short = estimateFrameTime({ dlc: 0, ...base })
		const long = estimateFrameTime({ dlc: 15, ...base })

		assert.ok(Number.isFinite(short.durationNs) && short.durationNs > 0)
		assert.ok(long.durationNs > short.durationNs)
		assert.equal(short.durationUs, short.durationNs / 1000)
		assert.equal(short.estimatedFramesPerSecond, 1e9 / short.durationNs)
		assert.equal(short.brsBitNs, brsSwitchTiming(base).brsBitNs)

		// 时长 = 仲裁段位数 × 仲裁位时间 + 数据段位数 × 数据位时间 + BRS + CRC 界定符（动态填充 0）
		const expected =
			short.totals.bitsByRate.arbitration * short.arbitrationBitTimeNs +
			short.totals.bitsByRate.data * short.dataBitTimeNs +
			short.brsBitNs +
			short.crcDelimiterBitNs
		assert.ok(Math.abs(short.durationNs - expected) < 1e-6, `${short.durationNs} vs ${expected}`)
	})

	test('位时序反算：80 MHz / 500 k 仲裁（SP 79.375%）/ 2 M 数据（SP 80%）复现实车参数', () => {
		const r = analyzeCanFdBitTiming({
			clockHz: 80_000_000,
			arbitrationBitrate: 500_000,
			dataBitrate: 2_000_000,
			arbitrationSamplePoint: 0.79375,
			dataSamplePoint: 0.8,
			limits: LIMITS_FD,
			tdc: { enabled: true, dataBrp: 1 },
		})
		const a = r.arbitration.best
		const d = r.data.best
		assert.ok(a && d, '两段都应有候选')

		// 寄存器值 = 功能值 − 1；实车报告里写的是功能值
		assert.equal(a.brp, 1)
		assert.equal(a.registers.TSEG1 + 1, 126)
		assert.equal(a.registers.TSEG2 + 1, 33)
		assert.equal(a.nbt, 160)
		assert.equal(a.bitrateErrorPpm, 0)
		assert.ok(Math.abs(a.samplePointPercent - 79.375) < 1e-9)

		assert.equal(d.brp, 1)
		assert.equal(d.registers.TSEG1 + 1, 31)
		assert.equal(d.registers.TSEG2 + 1, 8)
		assert.equal(d.nbt, 40)
		assert.equal(d.bitrateErrorPpm, 0)
		assert.ok(Math.abs(d.samplePointPercent - 80) < 1e-9)

		// BRS 切换点用的是两段**实际**采样点
		assert.equal(r.brsSwitch.dataSamplePoint, d.samplePointPercent / 100)
		assert.equal(r.brsSwitch.arbitrationSamplePoint, a.samplePointPercent / 100)

		// 数据段采样点（80%）晚于仲裁段（79.375%）→ 必须给出 warning，但不判 fail
		assert.ok(r.warnings.some((w) => w.includes('晚于')), '应提示数据段采样点偏晚')
	})

	/* ── ② 工具描述符 ──────────────────────────────────────────── */

	test('工具描述符：名称固定、参数不超过 20 个、每项都有 type 与中文 description', () => {
		assert.equal(tool.name, 'canfd_timing')
		assert.equal(typeof tool.title, 'string')
		assert.ok(tool.title.length > 0)
		assert.equal(typeof tool.description, 'string')
		assert.ok(tool.description.length > 200, 'description 应足够长以说明硬约束')
		assert.equal(typeof tool.execute, 'function')
		assert.equal(typeof tool.summaryLines, 'function')

		const names = Object.keys(tool.parameters)
		assert.ok(names.length <= 20, `参数 ${names.length} 个，超过 20 个上限`)
		assert.deepEqual(tool.parameters.action.enum, ['bit-timing', 'frame', 'dlc'])
		assert.equal(tool.parameters.action.required, true)

		const allowed = ['integer', 'number', 'string', 'boolean', 'array']
		for (const [key, p] of Object.entries(tool.parameters)) {
			assert.ok(allowed.includes(p.type), `${key} 的 type='${p.type}' 不在允许集合内`)
			assert.equal(typeof p.description, 'string', `${key} 缺 description`)
			assert.ok(p.description.length > 0, `${key} 的 description 为空`)
		}

		// 题目要求的覆盖点：两段波特率 / 控制器时钟 / 采样点 / DLC 或字节数 / 帧类型 / action
		for (const key of [
			'action',
			'clock_hz',
			'arbitration_bitrate',
			'data_bitrate',
			'arbitration_sample_point',
			'data_sample_point',
			'dlc',
			'data_bytes',
			'extended',
			'limits',
		]) {
			assert.ok(names.includes(key), `缺少参数 ${key}`)
		}
	})

	test('summaryLines 能消费 lib 的结果并给出含具体数值的行', () => {
		const lines = tool.summaryLines({ action: 'dlc', kind: 'dlc-to-bytes', ...analyzeDlc({ dlc: 15 }) })
		assert.ok(Array.isArray(lines))
		assert.ok(lines.length > 0)
		const text = lines.join('\n')
		assert.ok(text.includes('64'), '应出现 64 字节')
		assert.ok(text.includes('CRC21'), '应出现 CRC21')
		assert.ok(text.includes('7'), '应出现固定填充位个数 7')
	})

	/* ── ③ 负向用例 ───────────────────────────────────────────── */

	test('负向：缺 clock_hz / 采样点时抛错点名，越界值也抛错——不得悄悄塞默认值', () => {
		assert.throws(
			() =>
				analyzeCanFdBitTiming({
					arbitrationBitrate: 500_000,
					dataBitrate: 2_000_000,
					arbitrationSamplePoint: 0.8,
					dataSamplePoint: 0.75,
				}),
			/clock_hz/,
		)
		assert.throws(
			() =>
				analyzeCanFdBitTiming({
					clockHz: 40_000_000,
					arbitrationBitrate: 500_000,
					dataBitrate: 2_000_000,
					dataSamplePoint: 0.75,
				}),
			/arbitration_sample_point/,
		)
		assert.throws(
			() =>
				analyzeCanFdBitTiming({
					clockHz: 40_000_000,
					arbitrationBitrate: 500_000,
					dataBitrate: 2_000_000,
					arbitrationSamplePoint: 0.8,
				}),
			/data_sample_point/,
		)
		// 采样点必须是 0~1 之间的比例
		assert.throws(() => brsSwitchTiming({ arbitrationBitrate: 500_000, dataBitrate: 2_000_000, arbitrationSamplePoint: 80, dataSamplePoint: 0.6 }), /arbitration_sample_point/)
		// DLC / 字节数越界
		assert.throws(() => dlcToBytes(16), /0~15/)
		assert.throws(() => bytesToDlc(65), /上限/)
		// CRC 位数只允许 17 / 21
		assert.throws(() => fixedStuffBits(15), /17 或 21/)
	})

	test('负向：20 MHz 配 5 Mbit/s 数据段无解时必须报"找不到任何组合"，且缺 limits 要点名', () => {
		const r = analyzeCanFdBitTiming({
			clockHz: 20_000_000,
			arbitrationBitrate: 1_000_000,
			dataBitrate: 5_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.7,
			limits: LIMITS_FD,
			tdc: { enabled: true, dataBrp: 1 },
		})
		assert.equal(r.data.totalCandidates, 0)
		assert.equal(r.data.best, null)
		assert.ok(
			r.warnings.some((w) => w.startsWith('[数据段]') && w.includes('找不到任何组合')),
			'无解必须给出明确 warning，而不是静默返回空',
		)
		// 该时钟除 5 Mbit/s 只有 4 个周期，低于 NBT ≥ 4 tq 的结构下限
		assert.equal(20_000_000 / 5_000_000, 4)

		// 未给 limits：不能假装知道芯片寄存器范围
		const noLimits = analyzeCanFdBitTiming({
			clockHz: 40_000_000,
			arbitrationBitrate: 500_000,
			dataBitrate: 2_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.75,
		})
		assert.ok(noLimits.warnings.some((w) => w.includes('缺少控制器位时序寄存器范围')))
		// 未给 tdc：不做 TDC 判定，但在 notes 里点名
		assert.equal(noLimits.tdcProvided, false)
		assert.ok(noLimits.notes.some((n) => n.includes('未提供 tdc 配置')))
	})

	test('负向：数据段 >1 Mbit/s 未使能 TDC 必须报 fail + 后果说明', () => {
		const r = analyzeCanFdBitTiming({
			clockHz: 80_000_000,
			arbitrationBitrate: 1_000_000,
			dataBitrate: 5_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.7,
			limits: LIMITS_FD,
			tdc: { enabled: false },
		})
		const tdcCheck = r.checks.find((c) => c.name.includes('TDC'))
		assert.ok(tdcCheck, '应有 TDC 判定项')
		assert.equal(tdcCheck.pass, false)
		assert.ok(r.warnings.some((w) => w.includes('Bit Error')), '应说明误报位错误的后果')

		// 数据段 = 仲裁段时（BRS 无收益）也要报
		const sameRate = analyzeCanFdBitTiming({
			clockHz: 40_000_000,
			arbitrationBitrate: 500_000,
			dataBitrate: 500_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.8,
			limits: LIMITS_FD,
		})
		assert.equal(sameRate.checks.find((c) => c.name.includes('数据段波特率是否高于仲裁段')).pass, false)
		assert.ok(sameRate.warnings.some((w) => w.includes('两段波特率相同')))

		// TDC 使能但 BRPD 不为 1/2、SSP offset > 63 时也应报警
		const badTdc = analyzeCanFdBitTiming({
			clockHz: 80_000_000,
			arbitrationBitrate: 1_000_000,
			dataBitrate: 5_000_000,
			arbitrationSamplePoint: 0.8,
			dataSamplePoint: 0.7,
			limits: LIMITS_FD,
			tdc: { enabled: true, dataBrp: 4, sspOffsetTq: 70 },
		})
		assert.ok(badTdc.warnings.some((w) => w.includes('BRPD')))
		assert.ok(badTdc.warnings.some((w) => w.includes('0~63')))
	})
}
