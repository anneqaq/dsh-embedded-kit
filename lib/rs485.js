/**
 * RS-485 半双工时序计算（纯函数）。
 *
 * 解决一个最容易出错的板级问题：**DE/RE 方向切换的裕量够不够**。
 * 收发的电气时序由收发器数据手册给（tPZH/tPZL 使能、tPHZ/tPLZ 关闭），
 * 线路上的字符时间由波特率与帧格式决定；本模块把两者合成一个可判定的窗口。
 *
 * 诚实边界：**本模块不会猜收发器的数据手册参数**。没给就按 0 计入并在
 * `pending` 里列出来，绝不拿一个看起来合理的数字冒充实测值。
 *
 * @module dsh-embedded-kit/rs485
 */

/** MODBUS over Serial Line 规范建议：波特率 > 19200 时改用固定静默时间。 */
export const MODBUS_FIXED_T15_US = 750
/** 同上，帧间静默 t3.5 的固定值。 */
export const MODBUS_FIXED_T35_US = 1750
/** 上述固定值的适用门槛。 */
export const MODBUS_FIXED_THRESHOLD_BAUD = 19200

/**
 * 计算一个 UART 字符占用的位数。
 *
 * @param {object} fmt - 帧格式。
 * @param {number} fmt.dataBits - 数据位（5-9）。
 * @param {'none'|'even'|'odd'|'mark'|'space'} fmt.parity - 校验方式。
 * @param {number} fmt.stopBits - 停止位（1 / 1.5 / 2）。
 * @returns {number} 每字符总位数（含起始位与校验位）。
 * @throws {Error} 参数越界时抛出。
 */
export function bitsPerChar({ dataBits, parity, stopBits }) {
	if (!Number.isInteger(dataBits) || dataBits < 5 || dataBits > 9) {
		throw new Error(`数据位必须是 5-9 的整数，收到 ${dataBits}`)
	}
	if (!Number.isFinite(stopBits) || stopBits <= 0) {
		throw new Error(`停止位必须为正数，收到 ${stopBits}`)
	}
	const parityBits = parity === 'none' ? 0 : 1
	return 1 + dataBits + parityBits + stopBits
}

/**
 * 计算线路级时序，并把收发器参数合成方向切换窗口。
 *
 * @param {object} spec - 计算输入。
 * @param {number} spec.baud - 波特率（bit/s）。
 * @param {number} [spec.dataBits] - 数据位，默认 8。
 * @param {'none'|'even'|'odd'|'mark'|'space'} [spec.parity] - 校验方式，默认 none。
 * @param {number} [spec.stopBits] - 停止位，默认 1。
 * @param {number} [spec.frameBytes] - 待发送帧长度（字节），默认 8。
 * @param {number} [spec.responseBytes] - 预期响应帧长度（字节），给了才算整笔事务耗时。
 * @param {number} [spec.driverEnableNs] - 收发器驱动使能时间 tPZH/tPZL（ns），**来自数据手册**。
 * @param {number} [spec.driverDisableNs] - 收发器驱动关闭时间 tPHZ/tPLZ（ns），**来自数据手册**。
 * @param {boolean} [spec.modbusFixedSilence] - >19200 波特率时是否套用 Modbus 固定静默值，默认 true。
 * @returns {object} 时序报告。
 * @throws {Error} 波特率非法时抛出。
 */
export function analyzeTiming(spec) {
	const {
		baud,
		dataBits = 8,
		parity = 'none',
		stopBits = 1,
		frameBytes = 8,
		responseBytes,
		driverEnableNs = 0,
		driverDisableNs = 0,
		modbusFixedSilence = true,
	} = spec

	if (!Number.isFinite(baud) || baud <= 0) {
		throw new Error(`波特率必须为正数，收到 ${baud}`)
	}
	if (!Number.isInteger(frameBytes) || frameBytes <= 0) {
		throw new Error(`帧长度必须是正整数，收到 ${frameBytes}`)
	}

	const bits = bitsPerChar({ dataBits, parity, stopBits })
	const bitTimeUs = 1e6 / baud
	const charTimeUs = bits * bitTimeUs
	const frameTimeUs = frameBytes * charTimeUs

	// Modbus RTU 的静默时间：默认按 1.5 / 3.5 字符时间估算；
	// 波特率超过 19200 时规范建议改用固定值（硬件定时器分辨率不足以区分更短的字符时间）。
	const useFixed = modbusFixedSilence && baud > MODBUS_FIXED_THRESHOLD_BAUD
	const t15Us = useFixed ? MODBUS_FIXED_T15_US : 1.5 * charTimeUs
	const t35Us = useFixed ? MODBUS_FIXED_T35_US : 3.5 * charTimeUs

	const driverEnableUs = driverEnableNs / 1000
	const driverDisableUs = driverDisableNs / 1000

	// 方向切换窗口：DE 必须在首字节起始位到达线路前 ≥ 使能时间就置起，
	// 且在末字节停止位发完后 ≥ 关闭时间才可撤销，否则末位会被截断。
	const busOccupancyUs = driverEnableUs + frameTimeUs + driverDisableUs

	/** 需要从收发器数据手册补的项。 */
	const pending = []
	if (!(driverEnableNs > 0)) {
		pending.push('driverEnableNs（收发器驱动使能时间 tPZH/tPZL，查数据手册）')
	}
	if (!(driverDisableNs > 0)) {
		pending.push('driverDisableNs（收发器驱动关闭时间 tPHZ/tPLZ，查数据手册）')
	}

	const report = {
		bitsPerChar: bits,
		bitTimeUs: round3(bitTimeUs),
		charTimeUs: round3(charTimeUs),
		frameBytes,
		frameTimeUs: round3(frameTimeUs),
		modbus: {
			usingFixedSilence: useFixed,
			t15Us: round3(t15Us),
			t35Us: round3(t35Us),
			note: useFixed
				? `波特率 ${baud} > ${MODBUS_FIXED_THRESHOLD_BAUD}，按规范建议套用固定值`
				: `波特率 ${baud} ≤ ${MODBUS_FIXED_THRESHOLD_BAUD}，按 1.5 / 3.5 字符时间计算`,
		},
		turnaround: {
			driverEnableUs: round3(driverEnableUs),
			driverDisableUs: round3(driverDisableUs),
			busOccupancyUs: round3(busOccupancyUs),
			fitsInT35: busOccupancyUs <= t35Us,
		},
		pending,
	}

	// 整笔事务耗时：请求 + 方向切换 + 从站处理 + 响应。
	if (Number.isInteger(responseBytes) && responseBytes > 0) {
		const responseTimeUs = responseBytes * charTimeUs
		report.transaction = {
			requestBytes: frameBytes,
			responseBytes,
			responseTimeUs: round3(responseTimeUs),
			// 往返只算一次发送的占用窗口，其余按纯线路时间估算。
			wireTimeUs: round3(frameTimeUs + responseTimeUs),
			note: '未计入从站处理延迟与主机软件调度开销；实测请在 DE 脚与总线 A/B 上同时抓波形。',
		}
	}

	return report
}

/**
 * 保留三位小数。
 * @param {number} value - 原值。
 * @returns {number} 四舍五入结果。
 */
function round3(value) {
	return Math.round(value * 1000) / 1000
}
