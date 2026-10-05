/**
 * Modbus RTU 帧的构建与审查（纯函数）。
 *
 * CRC 采用 Modbus 标准：多项式 0x8005 的反射形式 0xA001，初值 0xFFFF，
 * 无最终异或，**低字节先发**。这一条最容易写错 ——
 * 大量实现会按大端追加，导致从站静默丢弃整帧。
 *
 * 自测里钉了一组已知答案：帧 `01 03 00 00 00 0A` 的 CRC 必须是 0xCDC5，
 * 即线上字节为 `01 03 00 00 00 0A C5 CD`。
 *
 * @module dsh-embedded-kit/modbus
 */

/** 常用功能码 → 名称。用于审查时把裸字节翻译成人话。 */
export const FUNCTION_NAMES = {
	0x01: 'Read Coils（读线圈）',
	0x02: 'Read Discrete Inputs（读离散输入）',
	0x03: 'Read Holding Registers（读保持寄存器）',
	0x04: 'Read Input Registers（读输入寄存器）',
	0x05: 'Write Single Coil（写单个线圈）',
	0x06: 'Write Single Register（写单个寄存器）',
	0x07: 'Read Exception Status（读异常状态）',
	0x0f: 'Write Multiple Coils（写多个线圈）',
	0x10: 'Write Multiple Registers（写多个寄存器）',
	0x11: 'Report Server ID（报告从站 ID）',
	0x16: 'Mask Write Register（屏蔽写寄存器）',
	0x17: 'Read/Write Multiple Registers（读写多个寄存器）',
	0x18: 'Read FIFO Queue（读 FIFO 队列）',
}

/** 异常码 → 含义（功能码最高位置 1 时第二字节的含义）。 */
export const EXCEPTION_NAMES = {
	0x01: '非法功能（01）',
	0x02: '非法数据地址（02）',
	0x03: '非法数据值（03）',
	0x04: '从站设备故障（04）',
	0x05: '确认（05，从站已受理，需轮询）',
	0x06: '从站设备忙（06）',
	0x08: '存储奇偶性差错（08）',
	0x0a: '不可用网关路径（0A）',
	0x0b: '网关目标设备响应失败（0B）',
}

/**
 * 计算 Modbus RTU 的 CRC16。
 *
 * @param {Uint8Array|number[]} bytes - 参与校验的字节（不含 CRC 本身）。
 * @returns {number} 16 位 CRC，寄存器值（不是线上字节序）。
 */
export function crc16Modbus(bytes) {
	let crc = 0xffff
	for (const b of bytes) {
		crc ^= b & 0xff
		for (let i = 0; i < 8; i++) {
			if (crc & 1) crc = (crc >>> 1) ^ 0xa001
			else crc >>>= 1
		}
	}
	return crc & 0xffff
}

/**
 * 在载荷后追加 CRC（低字节先）。
 *
 * @param {Uint8Array|number[]} payload - 不含 CRC 的帧载荷。
 * @returns {Uint8Array} 完整帧。
 */
export function appendCrc(payload) {
	const crc = crc16Modbus(payload)
	const out = new Uint8Array(payload.length + 2)
	out.set(payload, 0)
	out[payload.length] = crc & 0xff
	out[payload.length + 1] = (crc >>> 8) & 0xff
	return out
}

/**
 * 构建 RTU 帧：`[从站地址][功能码][数据...][CRC 低][CRC 高]`。
 *
 * @param {object} spec - 帧定义。
 * @param {number} spec.slave - 从站地址 0-247；0 为广播。
 * @param {number} spec.function - 功能码 1-127。
 * @param {number[]|Uint8Array} [spec.data] - 数据域字节。
 * @returns {Uint8Array} 完整帧。
 * @throws {Error} 地址或功能码越界时抛出。
 */
export function buildFrame({ slave, function: func, data = [] }) {
	if (!Number.isInteger(slave) || slave < 0 || slave > 247) {
		throw new Error(`从站地址必须是 0-247 的整数，收到 ${slave}`)
	}
	if (!Number.isInteger(func) || func < 1 || func > 127) {
		throw new Error(`功能码必须是 1-127 的整数（异常位由从站置位），收到 ${func}`)
	}
	const payload = new Uint8Array(2 + data.length)
	payload[0] = slave
	payload[1] = func
	payload.set(data, 2)
	return appendCrc(payload)
}

/**
 * 审查一个 RTU 帧：校验 CRC、拆出字段、把功能码与异常码翻译成中文。
 *
 * @param {Uint8Array|number[]} frame - 待审查的完整帧（含 CRC）。
 * @returns {{valid: boolean, reason: string|null, slave: number|null,
 *            function: number|null, functionName: string|null,
 *            isException: boolean, exceptionCode: number|null,
 *            exceptionName: string|null, data: number[],
 *            crcInFrame: number|null, crcComputed: number|null,
 *            hex: string}} 审查结果。
 */
export function verifyFrame(frame) {
	const bytes = Array.from(frame)
	const hex = toHex(bytes)
	const result = {
		valid: false,
		reason: null,
		slave: null,
		function: null,
		functionName: null,
		isException: false,
		exceptionCode: null,
		exceptionName: null,
		data: [],
		crcInFrame: null,
		crcComputed: null,
		hex,
	}

	// RTU 最短合法帧：地址 + 功能码 + CRC(2) = 4 字节。
	if (bytes.length < 4) {
		result.reason = `帧长 ${bytes.length} 字节，RTU 最短合法帧为 4 字节（地址+功能码+CRC2）`
		return result
	}
	if (bytes.length > 256) {
		result.reason = `帧长 ${bytes.length} 字节，超过 RTU 上限 256 字节`
		return result
	}

	const body = bytes.slice(0, bytes.length - 2)
	const inFrame = bytes[bytes.length - 2] | (bytes[bytes.length - 1] << 8)
	const computed = crc16Modbus(body)

	result.slave = bytes[0]
	result.function = bytes[1]
	result.data = bytes.slice(2, bytes.length - 2)
	result.crcInFrame = inFrame
	result.crcComputed = computed

	if (bytes[0] > 247) {
		result.reason = `从站地址 ${bytes[0]} 超出 0-247 合法范围`
		return result
	}
	result.isException = (bytes[1] & 0x80) !== 0
	const baseFunc = bytes[1] & 0x7f
	result.functionName = FUNCTION_NAMES[baseFunc] ?? `未知功能码 0x${baseFunc.toString(16)}`

	if (result.isException) {
		if (result.data.length < 1) {
			result.reason = '异常响应的数据域缺少异常码'
			return result
		}
		result.exceptionCode = result.data[0]
		result.exceptionName =
			EXCEPTION_NAMES[result.data[0]] ?? `未知异常码 0x${result.data[0].toString(16)}`
	}

	if (inFrame !== computed) {
		result.reason = `CRC 不匹配：帧内 0x${inFrame.toString(16).padStart(4, '0')}，实算 0x${computed
			.toString(16)
			.padStart(4, '0')}（常见成因是低/高字节次序颠倒）`
		return result
	}

	result.valid = true
	return result
}

/**
 * 把字节数组渲染成 `01 03 00 00` 形式的大写十六进制串。
 *
 * @param {Uint8Array|number[]} bytes - 字节。
 * @returns {string} 空格分隔的十六进制串。
 */
export function toHex(bytes) {
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0').toUpperCase())
		.join(' ')
}

/**
 * 宽松解析十六进制字符串为字节数组。
 *
 * 接受 `01 03 00 0A`、`0103000A`、`0x01,0x03`、`01-03` 等写法；
 * 只保留十六进制字符，因此**不接受十进制输入**，避免把 "10" 误读成十进制 10。
 *
 * @param {string} text - 输入文本。
 * @returns {number[]} 字节数组。
 * @throws {Error} 含非十六进制字符、或长度为奇数时抛出。
 */
export function parseHex(text) {
	if (typeof text !== 'string') throw new Error('期望十六进制字符串')
	const cleaned = text.replace(/0x/gi, '').replace(/[^0-9a-fA-F]/g, '')
	if (cleaned.length === 0) throw new Error('未找到任何十六进制字符')
	if (cleaned.length % 2 !== 0) {
		throw new Error(`十六进制字符数为奇数（${cleaned.length}），无法按字节切分`)
	}
	const out = []
	for (let i = 0; i < cleaned.length; i += 2) {
		out.push(Number.parseInt(cleaned.slice(i, i + 2), 16))
	}
	return out
}
