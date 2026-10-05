/**
 * 通用 CRC / 校验和引擎（参数化，协议中立）。
 *
 * 只做 Modbus 的 CRC-16 是不够的 —— 各家协议用的校验算法五花八门。
 * 这里实现**参数化的通用引擎**（width / poly / init / refin / refout / xorout），
 * 于是任何厂商自定义的 CRC 都能算；内置预设只是常用组合的快捷方式。
 *
 * 位宽支持 8 / 16 / 32。实现用 32 位有符号整数运算 + 全程 `>>> 0` 归一，
 * 避免 JS 位运算的符号陷阱（这是手写 CRC 最容易出错的地方）。
 *
 * 正确性由**标准测试向量**保证：对字符串 `"123456789"`（字节 31..39）的
 * 校验值在 CRC 社区里是公开的公认值（check value），见 `CHECK_VALUES`。
 * 自测直接比对这组值 —— 不用"我觉得对"。
 *
 * @module dsh-embedded-kit/crc
 */

/**
 * 内置预设。
 *
 * `refin` / `refout` 为输入/输出是否按位反射（reflected），
 * `xorout` 为最终异或值。这是 CRC 参数的标准记法。
 */
export const CRC_PRESETS = {
	'crc16-modbus': {
		width: 16,
		poly: 0x8005,
		init: 0xffff,
		refin: true,
		refout: true,
		xorout: 0x0000,
		label: 'CRC-16/MODBUS（Modbus RTU）',
	},
	'crc16-ccitt-false': {
		width: 16,
		poly: 0x1021,
		init: 0xffff,
		refin: false,
		refout: false,
		xorout: 0x0000,
		label: 'CRC-16/CCITT-FALSE',
	},
	'crc16-xmodem': {
		width: 16,
		poly: 0x1021,
		init: 0x0000,
		refin: false,
		refout: false,
		xorout: 0x0000,
		label: 'CRC-16/XMODEM',
	},
	'crc16-arc': {
		width: 16,
		poly: 0x8005,
		init: 0x0000,
		refin: true,
		refout: true,
		xorout: 0x0000,
		label: 'CRC-16/ARC（IBM），也被一些私有协议当作"CRC16"',
	},
	'crc16-x25': {
		width: 16,
		poly: 0x1021,
		init: 0xffff,
		refin: true,
		refout: true,
		xorout: 0xffff,
		label: 'CRC-16/X-25',
	},
	'crc16-dnp': {
		width: 16,
		poly: 0x3d65,
		init: 0x0000,
		refin: true,
		refout: true,
		xorout: 0xffff,
		label: 'CRC-16/DNP',
	},
	'crc8': {
		width: 8,
		poly: 0x07,
		init: 0x00,
		refin: false,
		refout: false,
		xorout: 0x00,
		label: 'CRC-8（ATM / 常见 8 位 CRC）',
	},
	'crc8-maxim': {
		width: 8,
		poly: 0x31,
		init: 0x00,
		refin: true,
		refout: true,
		xorout: 0x00,
		label: 'CRC-8/MAXIM（Dallas / 1-Wire）',
	},
	'crc32': {
		width: 32,
		poly: 0x04c11db7,
		init: 0xffffffff,
		refin: true,
		refout: true,
		xorout: 0xffffffff,
		label: 'CRC-32（ISO-HDLC / zlib / PNG）',
	},
	sum8: { width: 8, algorithm: 'sum', label: '8 位累加和（截断到低 8 位）' },
	sum16: { width: 16, algorithm: 'sum', label: '16 位累加和' },
	xor8: { width: 8, algorithm: 'xor', label: '8 位异或校验' },
}

/**
 * 标准 check value：对 ASCII `"123456789"` 计算得到的公认校验值。
 *
 * 这组值是 CRC 参数目录（CRC RevEng catalogue）里的公开基准，
 * 用来验证实现是否正确 —— 比"我算了一遍觉得对"可靠得多。
 */
export const CHECK_VALUES = {
	'crc16-modbus': 0x4b37,
	'crc16-ccitt-false': 0x29b1,
	'crc16-xmodem': 0x31c3,
	'crc16-arc': 0xbb3d,
	'crc16-x25': 0x906e,
	'crc16-dnp': 0xea82,
	crc8: 0xf4,
	'crc8-maxim': 0xa1,
	crc32: 0xcbf43926,
}

/** 全部预设名。 */
export const PRESET_NAMES = Object.keys(CRC_PRESETS)

/**
 * 反射一个 value 的低 `width` 位。
 * @param {number} value - 输入值。
 * @param {number} width - 位宽。
 * @returns {number} 反射结果（无符号）。
 */
function reflect(value, width) {
	let r = 0
	for (let i = 0; i < width; i++) r = (r << 1) | ((value >>> i) & 1)
	return r >>> 0
}

/**
 * 参数化 CRC 引擎。
 *
 * @param {Uint8Array|number[]} bytes - 参与计算的字节。
 * @param {object} params - CRC 参数。
 * @param {number} params.width - 位宽（8 / 16 / 32）。
 * @param {number} [params.poly] - 生成多项式（已去掉最高位）。
 * @param {number} [params.init] - 初值。
 * @param {boolean} [params.refin] - 输入是否按字节反射。
 * @param {boolean} [params.refout] - 输出是否反射。
 * @param {number} [params.xorout] - 最终异或值。
 * @param {'crc'|'sum'|'xor'} [params.algorithm] - 算法族，默认 crc。
 * @returns {number} 校验值（无符号，落在位宽内）。
 * @throws {Error} 位宽不支持时抛出。
 */
export function computeCheck(bytes, params) {
	const width = params.width
	if (width !== 8 && width !== 16 && width !== 32) {
		throw new Error(`仅支持 8 / 16 / 32 位宽，收到 ${width}`)
	}
	const mask = width === 32 ? 0xffffffff : (1 << width) - 1
	const algorithm = params.algorithm ?? 'crc'

	if (algorithm === 'sum') {
		let acc = 0
		for (const b of bytes) acc = (acc + (b & 0xff)) >>> 0
		return (acc & mask) >>> 0
	}
	if (algorithm === 'xor') {
		let acc = 0
		for (const b of bytes) acc ^= b & 0xff
		return (acc & mask) >>> 0
	}

	const poly = params.poly >>> 0
	const init = (params.init ?? 0) >>> 0
	const refin = params.refin === true
	const refout = params.refout === true
	const xorout = (params.xorout ?? 0) >>> 0
	const topBit = width === 32 ? 0x80000000 : 1 << (width - 1)
	const shift = width - 8

	let crc = (init & mask) >>> 0
	for (const byte of bytes) {
		const b = refin ? reflect(byte & 0xff, 8) : byte & 0xff
		crc = ((crc ^ ((b << shift) >>> 0)) & mask) >>> 0
		for (let i = 0; i < 8; i++) {
			if (crc & topBit) crc = ((((crc << 1) >>> 0) ^ poly) & mask) >>> 0
			else crc = ((crc << 1) & mask) >>> 0
		}
	}
	if (refout) crc = reflect(crc, width)
	return ((crc ^ xorout) & mask) >>> 0
}

/**
 * 按预设名计算校验值。
 *
 * @param {Uint8Array|number[]} bytes - 参与计算的字节。
 * @param {string} presetName - 预设名，见 {@link PRESET_NAMES}。
 * @returns {number} 校验值。
 * @throws {Error} 预设不存在时抛出（附带可选清单，便于纠正）。
 */
export function computePreset(bytes, presetName) {
	const preset = CRC_PRESETS[presetName]
	if (!preset) {
		throw new Error(`未知校验预设 '${presetName}'。可用：${PRESET_NAMES.join(', ')}`)
	}
	return computeCheck(bytes, preset)
}

/**
 * 把一个校验值按 **低字节先** 拆成线上字节。
 *
 * 之所以默认低字节先：串行协议（Modbus RTU、DNP3 等）普遍如此，
 * 写错顺序会导致从站静默丢帧。
 *
 * @param {number} value - 校验值。
 * @param {number} width - 位宽（8 / 16 / 32）。
 * @returns {number[]} 字节数组（低字节在前）。
 */
export function checkBytesLE(value, width) {
	const count = width / 8
	const out = []
	for (let i = 0; i < count; i++) out.push((value >>> (8 * i)) & 0xff)
	return out
}

/**
 * 把一个校验值按 **高字节先** 拆成线上字节。
 * @param {number} value - 校验值。
 * @param {number} width - 位宽（8 / 16 / 32）。
 * @returns {number[]} 字节数组（高字节在前）。
 */
export function checkBytesBE(value, width) {
	return checkBytesLE(value, width).reverse()
}
