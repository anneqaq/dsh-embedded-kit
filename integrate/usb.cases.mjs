/**
 * `usb_bandwidth` 的自测用例。
 *
 * 用法（与 DSH 自测框架约定的签名一致）：
 *
 *   import { register } from './usb.cases.mjs'
 *   register({ test: (label, fn) => ..., assert: nodeAssert })
 *
 * 覆盖三类东西：
 *   ① lib/usb.js 里**联网核实过的规范基准向量** —— 规范第 5 章的两条吞吐基准
 *      （FS 批量 64 B 一帧 19 个事务、HS 批量 512 B 一微帧 13 个事务）、
 *      §5.11.3 的保留比例、包大小表、SOF 位数、高带宽 3072 字节上限；
 *   ② 工具描述符（integrate/usb.tool.mjs）的形状与参数约束，以及三条动作的返回形状；
 *   ③ **负向用例**：周期端点超预算必须报警、批量端点声明高带宽必须被拒、
 *      包大小越界必须被拒、保留编码与越界参数必须抛错。
 *
 * 用例全部是**同步**的：宿主给的 `test` 签名是 `(label, fn) => void`，不 await。
 * 所以走的是工具导出的同步分派器 `dispatch`（`tool.execute` 内部就是它），
 * 这样不必依赖宿主 test 实现是否 await 一个 Promise。用例只读，不修改任何 lib 文件。
 *
 * @module dsh-embedded-kit/integrate/usb.cases
 */

import {
	fitEndpointsInFrame,
	frameBudget,
	transactionBits,
	BANDWIDTH_POLICY,
	INTER_PACKET_GAP_BITS,
	MAX_PACKET_SIZE,
	MIN_GAP_BITS_BY_SPEED,
	SPEC_THROUGHPUT_REFERENCE,
	USB_SPEEDS,
} from '../lib/usb.js'

import { dispatch, PARAM_NAMES, tool } from './usb.tool.mjs'

/* ------------------------------------------------------------------ */
/* 探针里用过的输入（probe/usb.probe.mjs 的同名常量）                     */
/* ------------------------------------------------------------------ */

/** FS 的包间延迟：规范下限 8/8（其中 hostToHost 是反推校准值，见文末用例）。 */
const GAP_FS = { turnaround: 8, hostToHost: 8 }

/** HS 的包间延迟：EL_22 / EL_23 的规范下限 8/88。 */
const GAP_HS = { turnaround: 8, hostToHost: 88 }

/** 传给工具的参数形式（成对给出，缺一个就整体退回规范下限）。 */
const TOOL_GAP_FS = { gap_turnaround_bits: 8, gap_host_to_host_bits: 8 }
const TOOL_GAP_HS = { gap_turnaround_bits: 8, gap_host_to_host_bits: 88 }

/** @param {number} v - 任意数。 @returns {number} 保留两位小数。 */
const round2 = (v) => Number(v.toFixed(2))

/**
 * 按名字取出一条 check（check 的顺序由模块决定，断言不该依赖下标）。
 *
 * @param {object} result - 任一分支的返回值。
 * @param {string} name - check 名。
 * @returns {object} 该条 check。
 */
function findCheck(result, name) {
	const hit = result.checks.find((c) => c.name === name)
	if (!hit) {
		throw new Error(`没有名为 '${name}' 的 check，实际有：${result.checks.map((c) => c.name).join(' / ')}`)
	}
	return hit
}

/** UVC 风格摄像头同步 IN 端点：1024 B × 3 事务/微帧，每个微帧都服务。 */
const CAMERA_EP = {
	name: 'cam-iso-in',
	transferType: 'isochronous',
	direction: 'in',
	maxPacketBytes: 1024,
	transactionsPerMicroframe: 3,
	intervalMicroframes: 1,
}

/** HID 风格中断 IN 端点：64 B，每 8 个微帧（= 1 ms）一次。 */
const HID_EP = {
	name: 'hid-int-in',
	transferType: 'interrupt',
	direction: 'in',
	maxPacketBytes: 64,
	intervalMicroframes: 8,
}

/**
 * 注册全部用例。
 *
 * @param {object} ctx - 自测上下文。
 * @param {(label: string, fn: () => void) => void} ctx.test - 注册一条用例。
 * @param {object} ctx.assert - node:assert/strict。
 */
export function register({ test, assert }) {
	/* ── ① 工具描述符形状 ───────────────────────────────────────── */

	test('工具形状：name / title / description / parameters / execute / summaryLines 齐全，参数不超过 20 个', () => {
		assert.equal(tool.name, 'usb_bandwidth')
		assert.equal(typeof tool.title, 'string')
		assert.ok(tool.title.length > 0, 'title 不能为空（中文标题）')
		assert.equal(typeof tool.description, 'string')
		// 说明里必须点明最关键的那条规范出处，否则"算的是哪一版口径"就无从追溯
		assert.ok(tool.description.includes('§5.11.3'), 'description 应点名 USB 2.0 §5.11.3 Bus Time Rationing')
		assert.ok(tool.description.includes('实测'), 'description 应写明"必须实测"的硬约束')
		assert.equal(typeof tool.execute, 'function')
		assert.equal(typeof tool.summaryLines, 'function')

		assert.ok(PARAM_NAMES.length <= 20, `参数不得超过 20 个，实际 ${PARAM_NAMES.length}`)
		assert.deepEqual(PARAM_NAMES, Object.keys(tool.parameters))

		for (const key of [
			'action',
			'speed',
			'transfer_type',
			'direction',
			'max_packet_bytes',
			'transactions_per_microframe',
			'wmax_packet_size_raw',
			'interval_frames',
			'interval_microframes',
			'data_bytes',
			'endpoints',
			'include_sof',
			'control_bytes_per_frame',
			'control_max_packet_bytes',
			'gap_turnaround_bits',
			'gap_host_to_host_bits',
		]) {
			assert.ok(PARAM_NAMES.includes(key), `缺少参数 ${key}`)
		}

		for (const [key, spec] of Object.entries(tool.parameters)) {
			assert.ok(['integer', 'number', 'string', 'boolean', 'array'].includes(spec.type), `${key} 的 type 非法`)
			assert.equal(typeof spec.description, 'string', `${key} 缺少描述`)
			assert.ok(spec.description.length > 0, `${key} 的描述为空`)
		}

		assert.equal(tool.parameters.action.required, true)
		assert.deepEqual(tool.parameters.action.enum, ['bandwidth', 'fit', 'hb'])
		assert.equal(tool.parameters.speed.required, true)
		assert.deepEqual(tool.parameters.speed.enum, ['low', 'full', 'high'])
		assert.equal(tool.parameters.endpoints.type, 'array')
		// 端点列表用扁平数组传，而不是嵌套 object
		assert.equal(tool.parameters.endpoints.items, undefined)
	})

	test('三个动作都返回 { checks, warnings, notes }，且 checks 每项都有 name/pass/detail', () => {
		const samples = [
			dispatch({ action: 'bandwidth', speed: 'high', transfer_type: 'isochronous', ...CAMERA_EP, ...TOOL_GAP_HS }),
			dispatch({ action: 'fit', speed: 'high', endpoints: [CAMERA_EP, HID_EP], ...TOOL_GAP_HS }),
			dispatch({ action: 'hb', speed: 'high', transfer_type: 'isochronous', max_packet_bytes: 1024, transactions_per_microframe: 3 }),
		]
		for (const v of samples) {
			assert.ok(Array.isArray(v.checks) && v.checks.length > 0, `${v.action} 的 checks 必须是非空数组`)
			assert.ok(Array.isArray(v.warnings), `${v.action} 的 warnings 必须是数组`)
			assert.ok(Array.isArray(v.notes) && v.notes.length > 0, `${v.action} 的 notes 必须是非空数组`)
			for (const c of v.checks) {
				assert.equal(typeof c.name, 'string')
				assert.equal(typeof c.pass, 'boolean')
				assert.ok(typeof c.detail === 'string' && c.detail.length > 0, `${c.name} 缺少 detail`)
			}
			const lines = tool.summaryLines(v)
			assert.ok(Array.isArray(lines) && lines.length > 0, `${v.action} 的 summaryLines 不应为空`)
			assert.ok(lines.every((l) => typeof l === 'string'), `${v.action} 的 summaryLines 必须全是字符串`)
		}
		// 未知 action 必须抛错点名可用值，而不是静默返回一个空壳
		assert.throws(() => dispatch({ action: 'nope' }), /未知 action/)
	})

	/* ── ② 规范基准向量（模型必须复现规范第 5 章的结论） ─────────── */

	test('FS 批量 64 B OUT：位级模型一帧装 19 个事务（规范第 5 章基准）', () => {
		const tx = transactionBits({ speed: 'full', transferType: 'bulk', direction: 'out', payloadBytes: 64, gapBits: GAP_FS })
		// 令牌 35 + 数据 547 + 握手 19 + 包间 16 = 617 位
		assert.equal(tx.tokenBits, 35)
		assert.equal(tx.dataBits, 547)
		assert.equal(tx.handshakeBits, 19)
		assert.equal(tx.gapBits, GAP_FS.hostToHost + GAP_FS.turnaround)
		assert.equal(tx.totalBits, 617)

		const count = Math.floor((1000 * 1000) / tx.busTimeNs)
		assert.equal(count, 19)
		assert.equal(count, SPEC_THROUGHPUT_REFERENCE.full.bulk.transactionsPerFrame)
		assert.ok(Math.abs((64 * count * 1000) / 1e6 - 1.216) < 0.01, 'FS 批量吞吐应 ≈ 1.216 MB/s')

		// 工具口径：满帧（只扣 SOF）复现 19；再扣掉 10% 控制保留后剩 17 —— 差的正是留给控制的量
		const v = dispatch({
			action: 'bandwidth',
			speed: 'full',
			transfer_type: 'bulk',
			direction: 'out',
			max_packet_bytes: 64,
			...TOOL_GAP_FS,
		})
		assert.equal(v.referenceTransactionsPerUnit, 19)
		assert.equal(v.transactionsPerUnit, 17)
		assert.equal(v.bytesPerFrame, 17 * 64)
		assert.equal(v.bytesPerSecond, 17 * 64 * 1000)
		assert.equal(v.budget.controlReservedUs, 100)
		assert.equal(v.budget.periodicLimitUs, 900)
		assert.equal(findCheck(v, '批量剩余带宽').pass, true)
		assert.equal(v.warnings.length, 0)
	})

	test('HS 批量 512 B OUT：位级模型一微帧装 13 个事务（规范第 5 章基准）', () => {
		const tx = transactionBits({ speed: 'high', transferType: 'bulk', direction: 'out', payloadBytes: 512, gapBits: GAP_HS })
		// 令牌 64 + 数据 4160 + 握手 48 + 包间 96 = 4368 位
		assert.equal(tx.tokenBits, 64)
		assert.equal(tx.dataBits, 4160)
		assert.equal(tx.handshakeBits, 48)
		assert.equal(tx.gapBits, GAP_HS.hostToHost + GAP_HS.turnaround)
		assert.equal(tx.totalBits, 4368)

		const count = Math.floor((125 * 1000) / tx.busTimeNs)
		assert.equal(count, 13)
		assert.equal(count, SPEC_THROUGHPUT_REFERENCE.high.bulk.transactionsPerFrame)
		assert.ok(Math.abs((512 * count * 8000) / 1e6 - 53.248) < 0.01, 'HS 批量吞吐应 ≈ 53.248 MB/s')

		const v = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'bulk',
			direction: 'out',
			max_packet_bytes: 512,
			...TOOL_GAP_HS,
		})
		assert.equal(v.referenceTransactionsPerUnit, 13)
		// 扣掉 20% 控制保留（25 µs）后剩 10 个
		assert.equal(v.transactionsPerUnit, 10)
		assert.equal(v.bytesPerFrame, 10 * 512 * USB_SPEEDS.high.microframesPerFrame)
		assert.equal(round2(v.availableUs), 99.8)
		assert.equal(v.budget.controlReservedUs, 25)
		assert.equal(v.budget.periodicLimitUs, 100)
		assert.equal(findCheck(v, '批量剩余带宽').pass, true)
	})

	test('HS 摄像头场景：同步 1024×3 + 中断 64 每 8 微帧 → 峰值微帧 53.52 µs，装得下', () => {
		const fit = fitEndpointsInFrame({ speed: 'high', endpoints: [CAMERA_EP, HID_EP], gapBits: GAP_HS })

		// 峰值出现在第 0 个微帧：摄像头 52.05 µs + HID 1.4667 µs = 53.5167 µs
		assert.equal(round2(fit.periodicPeakUs), 53.52)
		assert.equal(fit.periodicPeakUs, Math.max(...fit.perMicroframeUs))
		assert.equal(fit.perMicroframeUs.length, 8)
		assert.equal(round2(fit.endpoints[0].peakSlotUs), 52.05)
		assert.equal(round2(fit.endpoints[1].peakSlotUs), 1.47)
		assert.equal(fit.fits, true)
		assert.equal(round2(fit.periodicLimitUs), 100)

		// 摄像头单独占 24.576 MB/s（= 规范第 5 章同步 3 × 1024 B/微帧 的参考值）
		assert.equal(fit.endpoints[0].bytesPerSecond, 24_576_000)
		assert.equal(fit.endpoints[0].bytesPerFrame, 1024 * 3 * 8)

		// 工具 fit 动作给出同一个峰值（analyzeUsbBandwidth 把它叫 periodicUsedUs）
		const v = dispatch({ action: 'fit', speed: 'high', endpoints: [CAMERA_EP, HID_EP], ...TOOL_GAP_HS })
		assert.equal(v.periodicUsedUs, fit.periodicPeakUs)
		assert.equal(round2(v.periodicUsedUs), 53.52)
		assert.equal(v.fits, true)
		assert.ok(v.bulkAvailableUs > 0, '周期占掉一部分后批量仍应剩带宽')
		assert.equal(v.bulkAvailableUs, fit.bulkAvailableUs)
		assert.equal(round2(v.sofUs), 0.2)

		// 单端点口径：同步 1024×3 自己占微帧的 41.64%，没超 80%
		const one = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'isochronous',
			direction: 'in',
			max_packet_bytes: 1024,
			transactions_per_microframe: 3,
			interval_microframes: 1,
			...TOOL_GAP_HS,
		})
		assert.equal(one.bytesPerSecond, 24_576_000)
		assert.equal(round2(one.busTimeUsPerMicroframe), 52.05)
		assert.equal(Number((one.shareOfMicroframe * 100).toFixed(2)), 41.64)
		assert.equal(findCheck(one, '周期带宽占比').pass, true)
	})

	test('SOF 与包大小表：FS 的 SOF 35 位、HS 的 96 位（EL_55 的 40 位 EOP），包大小表与规范一致', () => {
		const fsBudget = frameBudget('full')
		const hsBudget = frameBudget('high')
		assert.equal(fsBudget.unitUs, 1000)
		assert.equal(hsBudget.unitUs, 125)
		assert.equal(hsBudget.microframesPerFrame, 8)
		assert.equal(round2((35 * (1e9 / USB_SPEEDS.full.bitRateHz)) / 1000), 2.92)
		assert.equal(round2((96 * (1e9 / USB_SPEEDS.high.bitRateHz)) / 1000), 0.2)

		// §5.11.3：FS 90%/10%，HS 80%/20%，批量一律不保留
		assert.equal(BANDWIDTH_POLICY.full.periodicMaxRatio, 0.9)
		assert.equal(BANDWIDTH_POLICY.full.controlReservedRatio, 0.1)
		assert.equal(BANDWIDTH_POLICY.high.periodicMaxRatio, 0.8)
		assert.equal(BANDWIDTH_POLICY.high.controlReservedRatio, 0.2)
		assert.ok(Object.values(BANDWIDTH_POLICY).every((p) => p.bulkReservedRatio === 0))

		// §5.5–§5.8 / §9.6.6：HS 控制固定 64、HS 批量固定 512、FS 同步上限 1023（不是 1024）、LS 不支持批量与同步
		assert.deepEqual(MAX_PACKET_SIZE.high.control.allowed, [64])
		assert.deepEqual(MAX_PACKET_SIZE.high.bulk.allowed, [512])
		assert.deepEqual(MAX_PACKET_SIZE.full.bulk.allowed, [8, 16, 32, 64])
		assert.equal(MAX_PACKET_SIZE.full.isochronous.max, 1023)
		assert.equal(MAX_PACKET_SIZE.high.isochronous.max, 1024)
		assert.equal(MAX_PACKET_SIZE.low.bulk, null)
		assert.equal(MAX_PACKET_SIZE.low.isochronous, null)
	})

	/* ── ③ 负向用例：必须报警 / 必须拒绝 ─────────────────────────── */

	test('负向：两个满配同步端点装不下（104.1 µs > 100 µs），告警点明规范出处', () => {
		const endpoints = [CAMERA_EP, { ...CAMERA_EP, name: 'cam2-iso-in' }]
		const v = dispatch({ action: 'fit', speed: 'high', endpoints, ...TOOL_GAP_HS })

		assert.equal(round2(v.periodicUsedUs), 104.1)
		assert.ok(v.periodicUsedUs > v.periodicLimitUs)
		assert.equal(v.fits, false)
		assert.equal(findCheck(v, '周期端点带宽').pass, false)
		assert.equal(findCheck(v, '控制保留').pass, false)
		assert.ok(v.warnings.length >= 2, `应给出多条告警，实际 ${v.warnings.length}`)
		assert.ok(v.warnings.some((w) => w.includes('5.11.3')), '告警必须点名规范出处 §5.11.3')
		assert.ok(v.warnings.some((w) => w.includes('装不下')), '告警必须给出"装不下"的结论')
		assert.ok(v.warnings.some((w) => w.includes('减小单包大小')), '告警必须给出可行的修法')

		// 批量剩余量同时被吃到 0，并给出对应告警
		assert.equal(v.bulkAvailableUs, 0)
		assert.equal(v.bulkTransactionsPerUnit, 0)
		assert.ok(v.warnings.some((w) => w.includes('批量传输没有剩余带宽')))

		// 降配之后应该回落
		const reduced = { ...CAMERA_EP, maxPacketBytes: 512, transactionsPerMicroframe: 2 }
		const ok = dispatch({ action: 'fit', speed: 'high', endpoints: [reduced, HID_EP], ...TOOL_GAP_HS })
		assert.equal(ok.fits, true)
		assert.ok(ok.bulkAvailableUs > v.bulkAvailableUs)
	})

	test('负向：HS 批量端点声明每微帧 2 次事务（高带宽只适用于中断/同步）必须被拒', () => {
		const hb = dispatch({
			action: 'hb',
			speed: 'high',
			transfer_type: 'bulk',
			max_packet_bytes: 512,
			transactions_per_microframe: 2,
		})
		assert.equal(findCheck(hb, '高带宽适用范围').pass, false)
		assert.equal(findCheck(hb, '最大包大小').pass, true) // 512 对 HS 批量本身是合法的
		assert.ok(hb.warnings.some((w) => w.includes('中断与同步')), '告警必须说明只适用于中断与同步')

		// 同一个组合走 bandwidth：按 1 次事务计算，并把不适用的事实记进 notes
		const bw = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'bulk',
			direction: 'out',
			max_packet_bytes: 512,
			transactions_per_microframe: 2,
			...TOOL_GAP_HS,
		})
		assert.equal(bw.transactionsPerMicroframe, 1)
		assert.equal(Number((bw.transaction.payloadRatio * 100).toFixed(1)), 93.8)
		assert.equal(bw.referenceTransactionsPerUnit, 13, '退化成 1 次事务后才与规范基准一致')
	})

	test('负向：包大小越界与非法取值集合必须被拒（FS 批量 512 B / 100 B）', () => {
		const tooBig = dispatch({ action: 'hb', speed: 'full', transfer_type: 'bulk', max_packet_bytes: 512 })
		assert.equal(findCheck(tooBig, '最大包大小').pass, false)
		assert.equal(findCheck(tooBig, '最大包大小取值集合').pass, false)
		assert.ok(tooBig.warnings.some((w) => w.includes('8..64')), '告警应给出合法范围')

		const illegalSet = dispatch({ action: 'hb', speed: 'full', transfer_type: 'bulk', max_packet_bytes: 100 })
		// 100 同时越界（> 64）且不在取值集合 {8,16,32,64} 里，两条判定都该失败
		assert.equal(findCheck(illegalSet, '最大包大小').pass, false)
		assert.equal(findCheck(illegalSet, '最大包大小取值集合').pass, false)
		assert.ok(illegalSet.warnings.some((w) => w.includes('8/16/32/64')))

		// 低速不支持批量/同步（规范 §5.5–§5.8），必须抛错而不是算出一个数
		assert.throws(() => dispatch({ action: 'bandwidth', speed: 'low', transfer_type: 'bulk' }), /不支持 bulk/)
		assert.throws(() => dispatch({ action: 'bandwidth', speed: 'low', transfer_type: 'isochronous' }), /不支持 isochronous/)
	})

	test('负向：保留编码与越界参数必须抛错（额外事务数 4、bit 12..11 = 11、未知键）', () => {
		// bit 12..11 只有 0/1/2 三种编码，第 4 种是保留的（规范 §9.6.6）
		assert.throws(
			() => dispatch({ action: 'hb', speed: 'high', transfer_type: 'isochronous', max_packet_bytes: 1024, transactions_per_microframe: 4 }),
			/只能是 1 \/ 2 \/ 3/,
		)
		// 0x1800 = bit 12..11 = 11，位级上根本无法描述
		assert.throws(
			() => dispatch({ action: 'hb', speed: 'high', transfer_type: 'isochronous', wmax_packet_size_raw: 0x1800 }),
			/保留编码/,
		)
		// 端点数组里的未知键必须报错，而不是静默变成 undefined 参与算术
		assert.throws(
			() => dispatch({ action: 'fit', speed: 'high', endpoints: [{ transferType: 'bulk', maxpacketbytes: 64 }] }),
			/未知键/,
		)
		// fit 缺 endpoints 数组
		assert.throws(() => dispatch({ action: 'fit', speed: 'high' }), /需要 endpoints 数组/)
		// 速率/传输类型拼错也要点名可选值
		assert.throws(() => dispatch({ action: 'bandwidth', speed: 'super', transfer_type: 'bulk' }), /low \/ full \/ high/)
		assert.throws(() => dispatch({ action: 'bandwidth', speed: 'high', transfer_type: 'nope' }), /control \/ interrupt/)
	})

	test('HS 高带宽：1024 B × 3 恰好合法（= 3072 字节/微帧上限），wMaxPacketSize 原始值可解析', () => {
		const ok = dispatch({
			action: 'hb',
			speed: 'high',
			transfer_type: 'isochronous',
			max_packet_bytes: 1024,
			transactions_per_microframe: 3,
		})
		assert.ok(ok.checks.every((c) => c.pass), '1024 × 3 应当全部通过')
		assert.equal(ok.bytesPerMicroframe, 3072)
		assert.equal(ok.transactionsPerMicroframe, 3)
		assert.ok(ok.notes.some((n) => n.includes('除最后一次')), '应说明 §5.9 的"除最后一次外必须发满"')

		// 0x1400 → 1024 B（bit 10..0）× 3 事务（bit 12..11 = 10）
		const raw = dispatch({ action: 'hb', speed: 'high', transfer_type: 'isochronous', wmax_packet_size_raw: 0x1400 })
		assert.equal(raw.maxPacketBytes, 1024)
		assert.equal(raw.transactionsPerMicroframe, 3)
		assert.equal(raw.packetSource, 'wmax_packet_size_raw')
		assert.ok(raw.checks.every((c) => c.pass))

		// 0x0C00 → 1024 B × 2 事务
		const raw2 = dispatch({ action: 'hb', speed: 'high', transfer_type: 'isochronous', wmax_packet_size_raw: 0x0c00 })
		assert.equal(raw2.maxPacketBytes, 1024)
		assert.equal(raw2.transactionsPerMicroframe, 2)

		// HS 中断也支持高带宽（1024 B × 3 = 24.576 MB/s）
		const intr = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'interrupt',
			direction: 'in',
			max_packet_bytes: 1024,
			transactions_per_microframe: 3,
			interval_microframes: 1,
			...TOOL_GAP_HS,
		})
		assert.equal(intr.bytesPerSecond, 24_576_000)
		assert.equal(findCheck(intr, '周期带宽占比').pass, true)
	})

	/* ── ④ 必须实测的量：包间延迟与跨帧记账口径 ─────────────────── */

	test('包间延迟：MIN_GAP_BITS_BY_SPEED.full.hostToHost = 8 是**反推校准值**，不是规范值', () => {
		// ⚠️ 这条断言是**故意写死的**：lib/usb.js 里 LS/FS 的 hostToHost = 8 属于
		//    **反推校准值（reverse-engineered calibration）**，出处并不是任何规范条款。
		//    EL_23 只给出 HS 的"主机连发 ≥88 位时间"；LS/FS 在电气一致性规范里**没有**对应数字。
		//    8 的来源是：取 8 时本模块的位级模型恰好复现规范第 5 章"FS 批量 19 个事务/帧"，
		//    取 88 则只有 17。它是让模型与规范结论对齐的**拟合参数**，量产前必须用 USB 分析仪
		//    实测 SOF↔令牌、数据包之间的真实间隔来替换。
		//    后来人请勿把它当作"规范规定 8 位时间"引用 —— 它没有规范出处。
		assert.equal(MIN_GAP_BITS_BY_SPEED.full.hostToHost, 8)
		assert.equal(MIN_GAP_BITS_BY_SPEED.low.hostToHost, 8)
		// HS 才是真正的规范下限（EL_23）
		assert.equal(MIN_GAP_BITS_BY_SPEED.high.hostToHost, INTER_PACKET_GAP_BITS.hostToHostMin)
		assert.equal(INTER_PACKET_GAP_BITS.hostToHostMin, 88)
		// LS/FS 的 8 与 EL_23 的 88 **不相等**：这一步就是在钉死"它不是规范值"
		assert.notEqual(MIN_GAP_BITS_BY_SPEED.full.hostToHost, INTER_PACKET_GAP_BITS.hostToHostMin)

		// 总线切换那条倒是有规范出处（EL_22 的 ≥8 位时间），三个速率一致
		assert.equal(INTER_PACKET_GAP_BITS.turnaroundMin, 8)
		assert.equal(INTER_PACKET_GAP_BITS.max, 192)
		for (const id of ['low', 'full', 'high']) {
			assert.equal(MIN_GAP_BITS_BY_SPEED[id].turnaround, INTER_PACKET_GAP_BITS.turnaroundMin)
		}

		// 校准的效果：用 8 得到 19（与规范一致），用 88 只有 17
		const with8 = Math.floor((1000 * 1000) / transactionBits({ speed: 'full', transferType: 'bulk', direction: 'out', payloadBytes: 64, gapBits: { turnaround: 8, hostToHost: 8 } }).busTimeNs)
		const with88 = Math.floor((1000 * 1000) / transactionBits({ speed: 'full', transferType: 'bulk', direction: 'out', payloadBytes: 64, gapBits: { turnaround: 8, hostToHost: 88 } }).busTimeNs)
		assert.equal(with8, 19)
		assert.equal(with88, 17)
	})

	test('未提供包间延迟时退回规范下限，并在 notes 里点名"必须实测替换"', () => {
		const noGap = dispatch({ action: 'bandwidth', speed: 'high', transfer_type: 'bulk', direction: 'out', max_packet_bytes: 512 })
		assert.ok(noGap.notes.some((n) => n.includes('未提供 gap_bits')), '必须点名回退事实')
		assert.ok(noGap.notes.some((n) => n.includes('实测')), '必须点名"必须实测替换"')
		assert.equal(noGap.referenceTransactionsPerUnit, 13, 'HS 的规范下限正好复现 13')

		// 只给一半时：整体按"未提供"处理，并额外给一条 warning，不让调用方以为生效了
		const half = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'bulk',
			direction: 'out',
			max_packet_bytes: 512,
			gap_turnaround_bits: 8,
		})
		assert.ok(half.warnings.some((w) => w.includes('必须成对给出')), '半截参数必须报警')
		assert.ok(half.notes.some((n) => n.includes('未提供 gap_bits')))
		assert.equal(half.referenceTransactionsPerUnit, 13)

		// 成对给出时不该出现回退说明
		const paired = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'bulk',
			direction: 'out',
			max_packet_bytes: 512,
			...TOOL_GAP_HS,
		})
		assert.equal(paired.warnings.length, 0)
		assert.ok(!paired.notes.some((n) => n.includes('未提供 gap_bits')))
	})

	test('跨帧服务间隔（HS bInterval 7 → 64 微帧）按平均口径记账，并给出说明', () => {
		const slowPoll = { name: 'slow-int-in', transferType: 'interrupt', direction: 'in', maxPacketBytes: 64, intervalMicroframes: 64 }
		const v = dispatch({ action: 'fit', speed: 'high', endpoints: [slowPoll], ...TOOL_GAP_HS })

		assert.equal(v.endpoints[0].slotAccounting, 'average')
		assert.equal(v.endpoints[0].intervalMicroframes, 64)
		assert.equal(v.endpoints[0].intervalFrames, 8)
		assert.equal(v.endpoints[0].occurrencesPerFrame, 1 / 8)
		assert.ok(Math.abs(v.endpoints[0].bytesPerSecond - 8000) < 1, '64 B / 8 帧 = 8 KB/s')
		assert.ok(v.notes.some((n) => n.includes('平均')), '必须说明占用是按平均口径摊的')

		// interval 能整除一帧时用精确槽位口径
		const perMicro = dispatch({ action: 'fit', speed: 'high', endpoints: [HID_EP], ...TOOL_GAP_HS })
		assert.equal(perMicro.endpoints[0].slotAccounting, 'exact')
		assert.equal(perMicro.endpoints[0].peakSlotUs, perMicro.endpoints[0].busTimeUsPerOccurrence)
	})

	/* ── ⑤ 控制端点与端点数量 ───────────────────────────────────── */

	test('控制端点：一次完整控制传输（建立 + 数据 + 状态）耗时与保留量占用可算', () => {
		const v = dispatch({
			action: 'bandwidth',
			speed: 'high',
			transfer_type: 'control',
			direction: 'in',
			data_bytes: 64,
			...TOOL_GAP_HS,
		})
		assert.equal(v.controlTransfer.transactionCount, 3) // 建立 + 数据(1 包) + 状态
		assert.equal(v.controlTransfer.totalBits, 1312)
		assert.equal(round2(v.transferUs), 2.73)
		// HS 的保留量是 20% × 125 µs × 8 微帧 = 200 µs/帧
		assert.equal(v.reservedPerFrameUs, 200)
		assert.ok(v.transfersPerFrame > 0)
		assert.equal(findCheck(v, '控制保留').pass, true)
		assert.ok(v.notes.some((n) => n.includes('参考表')), '应说明规范第 5 章的控制口径与本模型不同')

		// 无数据阶段（如 GET_STATUS）：只有建立 + 状态，共 2 次事务
		const noData = dispatch({ action: 'bandwidth', speed: 'high', transfer_type: 'control', ...TOOL_GAP_HS })
		assert.equal(noData.controlTransfer.transactionCount, 2)
		assert.equal(noData.dataBytes, 0)

		// LS 控制端点包大小固定 8 字节
		const ls = dispatch({ action: 'bandwidth', speed: 'low', transfer_type: 'control', ...TOOL_GAP_FS })
		assert.equal(ls.maxPacketBytes, 8)
		assert.equal(findCheck(ls, '最大包大小').pass, true)

		// 控制端点包大小超上限时 lib 直接抛错（规范 §5.5）—— 不给"算出一个数"的机会，
		// 因此这里断言抛错而不是断言告警：越界的描述符根本不该进入时间计算。
		assert.throws(
			() => dispatch({ action: 'bandwidth', speed: 'low', transfer_type: 'control', max_packet_bytes: 64 }),
			/控制端点包大小必须 ≤ 8 字节/,
		)
	})

	test('fit：空端点列表只报帧预算；批量端点与周期端点可同时传入', () => {
		const empty = dispatch({ action: 'fit', speed: 'high', endpoints: [], ...TOOL_GAP_HS })
		assert.equal(empty.endpointCount, 0)
		assert.equal(empty.periodicUsedUs, 0)
		assert.equal(round2(empty.bulkAvailableUs), 99.8)
		assert.equal(empty.bulkTransactionsPerUnit, 10) // = 规范基准 13 减掉控制保留
		assert.equal(round2(empty.bulkAvailableRatio * 100), 79.84) // 99.8 / 125 µs
		assert.ok(empty.notes.some((n) => n.includes('endpoints 为空')))

		// 批量端点不参与周期上限判定，只做描述符合法性校验
		const mixed = dispatch({
			action: 'fit',
			speed: 'high',
			endpoints: [CAMERA_EP, { name: 'bulk-out', transferType: 'bulk', direction: 'out', maxPacketBytes: 512 }],
			...TOOL_GAP_HS,
		})
		assert.equal(mixed.endpointCount, 2)
		assert.equal(mixed.periodicUsedUs, 52.05)
		assert.equal(mixed.fits, true)
		assert.ok(mixed.checks.some((c) => c.name === 'bulk-out 包大小' && c.pass))

		// 给了控制流量时多一条"控制流量 vs 保留"判定
		const withControl = dispatch({
			action: 'fit',
			speed: 'high',
			endpoints: [CAMERA_EP],
			control_bytes_per_frame: 256,
			control_max_packet_bytes: 64,
			...TOOL_GAP_HS,
		})
		assert.ok(withControl.checks.some((c) => c.name === '控制流量 vs 保留'))

		// 全速对照：1023 B 同步 + 64 B 中断装得下（每个帧只能发 1 次事务）
		const fsFit = dispatch({
			action: 'fit',
			speed: 'full',
			endpoints: [
				{ name: 'fs-iso-in', transferType: 'isochronous', direction: 'in', maxPacketBytes: 1023 },
				{ name: 'fs-int-in', transferType: 'interrupt', direction: 'in', maxPacketBytes: 64 },
			],
			...TOOL_GAP_FS,
		})
		assert.equal(fsFit.fits, true)
		assert.equal(round2(fsFit.periodicUsedUs), 739.92)
		assert.equal(fsFit.endpoints[0].bytesPerSecond, 1_023_000)
	})
}
