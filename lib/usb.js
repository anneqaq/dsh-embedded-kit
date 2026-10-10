/**
 * USB 2.0 带宽与端点预算（帧/微帧、各传输类型保留比例、包大小、高带宽端点、吞吐估算）。
 *
 * **联网核实记录（2026-09-20）**
 *
 * 1. **帧与微帧** — USB 2.0 §5.11.3 / §8.1。全速(FS)/低速(LS) 总线时间按 1 ms 的
 *    **帧** 划分；高速(HS) 按 125 µs 的 **微帧** 划分，8 个微帧构成 1 帧。
 *    每个 (微)帧起始由主控发出一个 SOF 包。（出处：Microsoft Learn《How to transfer
 *    data to USB isochronous endpoints》「For full speed, a bus interval is a frame.
 *    The length of a frame is 1 millisecond. For high speed ... 125 microseconds.
 *    Eight consecutive microframes constitute one ... frame.」）
 *
 * 2. **带宽保留比例** — USB 2.0 §5.11.3 "Bus Time Rationing"。核实到的确切数字：
 *
 *    | 传输类型 | LS/FS 保留 | HS 保留 | 语义 |
 *    |---|---|---|---|
 *    | 控制 | 10% 的帧 | 20% 的微帧 | **保留**（即使没用到也占着） |
 *    | 中断 | 周期合计 ≤90% 的帧 | 周期合计 ≤80% 的微帧 | 上限 |
 *    | 同步 | 同上（计入同一 90%） | 同上（计入同一 80%） | 上限 |
 *    | 批量 | **不保留任何带宽** | **不保留任何带宽** | 用剩余的 |
 *
 *    规范原文（§5.11.3）：「If a control transfer requires less than 10% of a frame,
 *    the remaining bus time can be used to support bulk transfers ... No more than
 *    90% of a frame may be allocated for periodic (isochronous and interrupt)
 *    transfers.」HS 侧对应 20% / 80%。
 *    出处交叉验证：
 *    - Chalmers 讲义《The Universal Serial Bus》(原始表格转自 USB 2.0 规范第 5 章)
 *      「Reserved bandwidth for all transfers of the type (percent): control
 *      10 at low- and full-speed, 20 at high-speed; bulk none; interrupt 90 at
 *      low- and full-speed, 80 at high-speed; Isochronous 同 interrupt」；
 *    - OSDev wiki "Bus Time Rationing"（逐条复述规范 §5.11.3）；
 *    - usbzh.com《USB带宽分配管理规则 为什么USB设备的最高带宽只能到达80%》；
 *    - 凡亿课堂《USB2.0实际传输速度为什么与480Mbps相差甚远》「控制传输应确保在低/全速时
 *      能够使用10%的带宽，高速时能够使用20%的带宽。而批量传输并没有保留任何带宽」。
 *
 * 3. **最大包大小** — USB 2.0 §5.5–§5.8 / §9.6.6 端点描述符 wMaxPacketSize。
 *
 *    | 传输类型 | LS | FS | HS |
 *    |---|---|---|---|
 *    | 控制 | 8 | 8/16/32/64 | 64（固定） |
 *    | 中断 | 1..8 | 1..64 | 1..1024 |
 *    | 批量 | 不支持 | 8/16/32/64 | 512（固定） |
 *    | 同步 | 不支持 | 1..1023 | 1..1024 |
 *
 *    出处交叉验证：Renesas《USB CDC Driver》应用笔记 Table 3.1；Zephyr
 *    `drivers/usb/udc/udc_sam_usbhs.c` 中直接引用「USB 2.0 Specification Maximum
 *    Packet Sizes (Section 5.5-5.8)」的同一张表；Cypress《Streaming Data Through
 *    Isochronous or Bulk Endpoints on EZ-USB FX2》Table 2；Microsoft Learn 同文。
 *    注意 FS 同步端点是 **1023** 而非 1024（HS 才是 1024），这点三个来源一致。
 *
 * 4. **高速高带宽端点** — wMaxPacketSize 的 **bit 12..11** 表示「每个微帧的**额外**
 *    事务数」：`00`=0 个（共 1 次事务）、`01`=1 个（共 2 次）、`10`=2 个（共 3 次）、
 *    `11` 保留。bit 10..0 是单个物理包的最大字节数（物理包硬上限 1024 字节）。
 *    因此一个微帧最多 3×1024 = **3072 字节**。高带宽**只适用于 HS 的中断与同步**端点，
 *    不适用于控制与批量。规范 §5.9 另规定：一个微帧内**除最后一次外**的所有事务都必须
 *    发满该端点的最大载荷。
 *    出处交叉验证：Microsoft USBD_PIPE_INFORMATION 文档「the number of additional
 *    transactions supported by that type of endpoint is indicated by bits 12..11 of
 *    wMaxPacketSize ... can transfer up to 3072 bytes in a single microframe」；
 *    Cypress 同一应用笔记 Table 5「1 包/微帧 → 0x0400，2 包 → 0x0C00，3 包 → 0x1400」；
 *    usbzh.com《USB 高速高带宽端点 wMaxPacketSize》。
 *
 * 5. **每事务的协议开销构成** — USB 2.0 规范第 5 章事务表（经 100ask.net《USB 2.0 详解
 *    (二)—— 数据流模型(下)》逐条转述规范原文核实）：「每个数据包的 SYNC 字段：低速/全速
 *    为 8 位，高速为 32 位；每个数据包的 PID 字节（含 PID 校验位）；每个数据包的 EOP 字段：
 *    低速/全速为 3 位，高速为 8 位；令牌包中含端点号、设备地址和 CRC5 字段（共 16 位）；
 *    数据包中含 CRC16 字段（共 16 位）；数据包之间的间隔（含总线切换时间）」。
 *    HS 的 EOP 由 USB 2.0 电气一致性规范 EL_25 确认为「8 位无位填充的 01111111」；
 *    SOF 的 EOP 另计 40 位（EL_55）。
 *
 * 6. **包间延迟（inter-packet gap）** — USB 2.0 §7.1.18.2，由 USB-IF《USB 2.0 Electrical
 *    Compliance Test Specification v1.07》§3.4 条目量化：
 *    - **EL_22**：设备/主机**收到包之后**再发，间隔 **≥8 且 ≤192 个位时间**（总线切换）；
 *    - **EL_23**：主机**连着发两个包**，间隔 **≥88 且 ≤192 个位时间**。
 *    这两条是**区间**，不是定值 —— 实际值取决于主控与 Hub，属于**必须实测**的量，
 *    所以本模块把它作为**参数**（`gapBits`）暴露，不当作规范常量硬编码。
 *
 * 7. **规范第 5 章的参考吞吐表**（本模块 `SPEC_THROUGHPUT_REFERENCE` 的数据来源）：
 *    单条管道每毫秒可传的最大字节数 ——
 *    FS：控制 832（13×64B/帧）、批量 1216（19×64B/帧）、中断 64（1×64B/帧）、
 *    同步 1023（1×1023B/帧）；
 *    HS：控制 15872（31×64B/微帧）、批量 53248（13×512B/微帧）、
 *    中断与同步各 24576（3×1024B/微帧）。
 *    出处：Chalmers 讲义表格（转自规范第 5 章），并与 Microchip Developer Help
 *    《USB Frames》「FULL SPEED Bulk 64 bytes / Up to 19 / 1.2 Mbytes/s；HIGH SPEED
 *    Bulk 512 bytes / up to 13 / 53 MByte/s」、以及多份中文规范转述一致。
 *
 * **什么是设计值、什么是必须实测**
 *   - 规范常量（包大小上限、保留比例、字段位数、位时间）：本模块内置并逐条注明出处。
 *   - **包间延迟 `gapBits`**：规范只给区间（≥8 / ≥88 位时间），实际值随主控、Hub、
 *     线缆变化 —— 必须实测（USB 分析仪测 SOF↔令牌、数据包之间的真实间隔），
 *     本模块只在调用方不给时退回规范下限，并在 `notes` 里明确标注。
 *   - **固件服务延迟 `serviceLatencyUs`**：器件相关，必须由调用方传入。
 *   - **FIFO 深度 / 是否双缓冲**：器件相关，必须由调用方传入。
 *   - 所有吞吐数字都是**理论设计上限**；真实吞吐必须在目标主机上实测（主控的调度实现、
 *     Hub 层级、总线竞争都会显著拉低它）。
 *
 * @module dsh-embedded-kit/usb
 */

/** 各位速率的物理与帧结构常量。`bitTimeNs` 由位速率反算，不是规范常量。 */
export const USB_SPEEDS = {
	low: {
		id: 'low',
		label: 'Low Speed (1.5 Mb/s)',
		bitRateHz: 1_500_000,
		frameUs: 1000,
		microframesPerFrame: 1,
		microframeUs: 1000,
		/** 规范第 5 章：LS/FS 的 SYNC 为 8 位。 */
		syncBits: 8,
		/** 规范第 5 章：LS/FS 的 EOP 为 3 位。 */
		eopBits: 3,
		/** 规范 EL_55 只对 HS 规定 40 位 SOF EOP；LS/FS 的 SOF 用普通 EOP。 */
		sofEopBits: 3,
	},
	full: {
		id: 'full',
		label: 'Full Speed (12 Mb/s)',
		bitRateHz: 12_000_000,
		frameUs: 1000,
		microframesPerFrame: 1,
		microframeUs: 1000,
		syncBits: 8,
		eopBits: 3,
		sofEopBits: 3,
	},
	high: {
		id: 'high',
		label: 'High Speed (480 Mb/s)',
		bitRateHz: 480_000_000,
		frameUs: 1000,
		microframesPerFrame: 8,
		microframeUs: 125,
		/** 规范第 5 章 / 电气一致性 EL_21：HS 的 SYNC 为 32 位。 */
		syncBits: 32,
		/** 规范第 5 章 / EL_25：HS 的 EOP 为 8 位。 */
		eopBits: 8,
		/** EL_55：HS 的 SOF EOP 扩展为 40 位（用于断开检测）。 */
		sofEopBits: 40,
	},
}

/**
 * 各速率的带宽分配策略。数字出自 USB 2.0 §5.11.3（详见文件头）。
 * `periodicMaxRatio` 是中断+同步**合计**的上限；`controlReservedRatio` 是控制的**保留**；
 * 批量不保留任何带宽（`bulkReservedRatio = 0`），只能用剩下的。
 */
export const BANDWIDTH_POLICY = {
	low: { periodicMaxRatio: 0.9, controlReservedRatio: 0.1, bulkReservedRatio: 0 },
	full: { periodicMaxRatio: 0.9, controlReservedRatio: 0.1, bulkReservedRatio: 0 },
	high: { periodicMaxRatio: 0.8, controlReservedRatio: 0.2, bulkReservedRatio: 0 },
}

/**
 * 最大包大小（字节）。`allowed` 是规范允许的取值集合；`max` 是上限。
 * 数字出自 USB 2.0 §5.5–§5.8 / §9.6.6（详见文件头第 3 条）。
 */
export const MAX_PACKET_SIZE = {
	low: {
		control: { allowed: [8], min: 8, max: 8 },
		interrupt: { allowed: null, min: 1, max: 8 },
		bulk: null,
		isochronous: null,
	},
	full: {
		control: { allowed: [8, 16, 32, 64], min: 8, max: 64 },
		interrupt: { allowed: null, min: 1, max: 64 },
		bulk: { allowed: [8, 16, 32, 64], min: 8, max: 64 },
		isochronous: { allowed: null, min: 1, max: 1023 },
	},
	high: {
		control: { allowed: [64], min: 64, max: 64 },
		interrupt: { allowed: null, min: 1, max: 1024 },
		bulk: { allowed: [512], min: 512, max: 512 },
		isochronous: { allowed: null, min: 1, max: 1024 },
	},
}

/**
 * wMaxPacketSize 的 bit 12..11 编码：每个微帧的**额外**事务数。
 * 出自 USB 2.0 §9.6.6（详见文件头第 4 条）。
 */
export const HIGH_BANDWIDTH_ENCODING = {
	0: { additionalTransactions: 0, transactionsPerMicroframe: 1, rawBits: 0x0000 },
	1: { additionalTransactions: 1, transactionsPerMicroframe: 2, rawBits: 0x0800 },
	2: { additionalTransactions: 2, transactionsPerMicroframe: 3, rawBits: 0x1000 },
}

/** 高带宽端点单微帧的硬上限：3 × 1024 字节。出处见文件头第 4 条。 */
export const HIGH_BANDWIDTH_MAX_BYTES_PER_MICROFRAME = 3072

/**
 * 规范第 5 章的参考吞吐表：单条管道每毫秒最大字节数。
 * 仅作**对照基准**（用于自检本模块的位级模型是否走偏），不是可达成保证。
 * 出处见文件头第 7 条。低速行不同二手来源互相矛盾（Microchip 说 LS 控制 1×8B/帧、
 * Chalmers 说 3×8B/帧），因此这里**不**给出 LS 行，避免固化有争议的数字。
 */
export const SPEC_THROUGHPUT_REFERENCE = {
	full: {
		control: { maxPacketBytes: 64, transactionsPerFrame: 13, bytesPerMs: 832 },
		bulk: { maxPacketBytes: 64, transactionsPerFrame: 19, bytesPerMs: 1216 },
		interrupt: { maxPacketBytes: 64, transactionsPerFrame: 1, bytesPerMs: 64 },
		isochronous: { maxPacketBytes: 1023, transactionsPerFrame: 1, bytesPerMs: 1023 },
	},
	high: {
		control: { maxPacketBytes: 64, transactionsPerFrame: 31, bytesPerMs: 15_872 },
		bulk: { maxPacketBytes: 512, transactionsPerFrame: 13, bytesPerMs: 53_248 },
		interrupt: { maxPacketBytes: 1024, transactionsPerFrame: 3, bytesPerMs: 24_576 },
		isochronous: { maxPacketBytes: 1024, transactionsPerFrame: 3, bytesPerMs: 24_576 },
	},
}

/**
 * 包间延迟（位时间）的**规范区间**。全部出自 USB 2.0 §7.1.18.2，
 * 由 USB-IF 电气一致性规范 EL_22 / EL_23 量化。这是区间不是定值 —— 实际取多少
 * 取决于主控与 Hub，**必须实测**。
 */
export const INTER_PACKET_GAP_BITS = {
	/** EL_22：收到包之后再发（总线切换 / 设备应答），≥8 位时间。 */
	turnaroundMin: 8,
	/** EL_23：主机连着发两个包，≥88 位时间。 */
	hostToHostMin: 88,
	/** EL_22 / EL_23：两者上限均为 192 位时间。 */
	max: 192,
}

/**
 * 数据包/令牌包中固定字段的位数（扣除 SYNC、EOP、数据域之外的）。
 * 出自规范第 5 章事务开销表：PID 8 位；令牌的 ADDR(7)+ENDP(4)+CRC5(5) = 16 位；
 * 数据包的 CRC16 = 16 位。
 */
export const PACKET_FIELD_BITS = {
	pid: 8,
	tokenAddrEndpCrc5: 16,
	dataCrc16: 16,
	/** SOF 令牌的帧号 11 位 + CRC5 5 位。 */
	sofFrameNumberCrc5: 16,
}

/**
 * 规范最小包间延迟（**仅作回退值**）。HS 采用规范下限 8/88；LS/FS 的 host-to-host
 * 延时规范未在 EL 条目中给出对应数字，这里的 8 是**反推值**：取 8 时本模块的位级模型
 * 恰好复现规范第 5 章 FS 批量「19 个 64 字节事务/帧」的结论（取 88 则只有 17）。
 * 它是设计校准值，**不是规范原文**，量产前必须用分析仪实测替换。
 */
export const MIN_GAP_BITS_BY_SPEED = {
	low: { turnaround: INTER_PACKET_GAP_BITS.turnaroundMin, hostToHost: 8 },
	full: { turnaround: INTER_PACKET_GAP_BITS.turnaroundMin, hostToHost: 8 },
	high: { turnaround: INTER_PACKET_GAP_BITS.turnaroundMin, hostToHost: INTER_PACKET_GAP_BITS.hostToHostMin },
}

/** 需要握手包的传输类型（同步没有握手阶段，规范 §8.5）。 */
const TYPES_WITH_HANDSHAKE = new Set(['control', 'interrupt', 'bulk'])
/** 支持高带宽（每微帧多事务）的传输类型：仅 HS 的中断与同步。 */
const TYPES_SUPPORTING_HIGH_BANDWIDTH = new Set(['interrupt', 'isochronous'])

/** 传输类型清单。 */
export const TRANSFER_TYPES = ['control', 'interrupt', 'bulk', 'isochronous']

/**
 * 取速率常量，未知则抛出带可选值清单的错误。
 *
 * @param {string} speed - `'low'` | `'full'` | `'high'`。
 * @returns {object} 速率常量对象。
 */
function requireSpeed(speed) {
	const s = USB_SPEEDS[speed]
	if (!s) throw new Error(`未知的 USB 速率：${speed}（可用：${Object.keys(USB_SPEEDS).join(' / ')}）`)
	return s
}

/**
 * 取传输类型的包大小规范，不支持时抛错（例如 LS 不支持批量/同步）。
 *
 * @param {string} speed - 速率 id。
 * @param {string} transferType - 传输类型。
 * @returns {object} `{ allowed, min, max }`。
 */
function requirePacketSpec(speed, transferType) {
	if (!TRANSFER_TYPES.includes(transferType)) {
		throw new Error(`未知的传输类型：${transferType}（可用：${TRANSFER_TYPES.join(' / ')}）`)
	}
	const spec = MAX_PACKET_SIZE[speed]?.[transferType]
	if (!spec) {
		throw new Error(`${USB_SPEEDS[speed].label} 不支持 ${transferType} 传输（规范 §5.5–§5.8）`)
	}
	return spec
}

/**
 * 归一化包间延迟参数：缺省时退回规范下限，并把「用了回退值」这件事记进 notes。
 *
 * @param {string} speed - 速率 id。
 * @param {{turnaround?: number, hostToHost?: number}|undefined} gapBits - 调用方实测值。
 * @param {string[]} notes - 结果收集。
 * @returns {{turnaround: number, hostToHost: number}} 位时间。
 */
function resolveGapBits(speed, gapBits, notes) {
	const fallback = MIN_GAP_BITS_BY_SPEED[speed]
	if (!gapBits || gapBits.turnaround === undefined || gapBits.hostToHost === undefined) {
		notes.push(
			`未提供 gap_bits，已退回规范下限（总线切换 ${fallback.turnaround} 位时间 / ` +
				`主机连发 ${fallback.hostToHost} 位时间，USB 2.0 §7.1.18.2、电气一致性 EL_22/EL_23）。` +
				`规范只规定区间（≥8 / ≥88，≤192），实际值随主控与 Hub 变化，` +
				`**这是设计上限，量产前必须用分析仪实测替换**。`,
		)
		return { ...fallback }
	}
	return {
		turnaround: gapBits.turnaround,
		hostToHost: gapBits.hostToHost,
	}
}

/**
 * 位速率反算的位时间（ns）。非规范常量，纯换算。
 *
 * @param {string} speed - 速率 id。
 * @returns {number} 位时间（ns）。
 */
export function bitTimeNs(speed) {
	return 1e9 / requireSpeed(speed).bitRateHz
}

/**
 * 帧预算：把 §5.11.3 的保留比例换算成绝对时间与绝对字节。
 *
 * 这是**分配规则**，不是实测：`bulkAvailableUs` 是在「周期传输已用满其上限」前提下的
 * 剩余量；真实总线上周期流量通常远小于上限，批量实际能拿到更多（上限见
 * `bulkAvailableRatioUpperBound`）。
 *
 * @param {string} speed - 速率 id。
 * @returns {object} `{ speed, label, frameUs, microframeUs, microframesPerFrame, bitTimeNs,
 *   periodicLimitUs, periodicMaxRatio, controlReservedUs, controlReservedRatio,
 *   bulkReservedRatio, bulkAvailableUs, bulkAvailableRatio, bulkAvailableRatioUpperBound }`。
 */
export function frameBudget(speed) {
	const s = requireSpeed(speed)
	const policy = BANDWIDTH_POLICY[s.id]
	const unitUs = s.microframeUs

	const periodicLimitUs = unitUs * policy.periodicMaxRatio
	const controlReservedUs = unitUs * policy.controlReservedRatio
	// 周期传输已占满上限时的批量剩余；可能为 0（FS 90%+10%、HS 80%+20% 都恰好为 0）。
	const bulkAvailableUs = Math.max(0, unitUs - periodicLimitUs - controlReservedUs)
	// 周期流量为 0 时的批量上界：只剩控制的保留。
	const bulkAvailableRatioUpperBound = 1 - policy.controlReservedRatio

	return {
		speed: s.id,
		label: s.label,
		unit: s.microframesPerFrame === 1 ? 'frame' : 'microframe',
		unitUs,
		frameUs: s.frameUs,
		microframeUs: s.microframeUs,
		microframesPerFrame: s.microframesPerFrame,
		bitTimeNs: 1e9 / s.bitRateHz,
		periodicMaxRatio: policy.periodicMaxRatio,
		periodicLimitUs,
		controlReservedRatio: policy.controlReservedRatio,
		controlReservedUs,
		bulkReservedRatio: policy.bulkReservedRatio,
		bulkAvailableUs,
		bulkAvailableRatio: bulkAvailableUs / unitUs,
		bulkAvailableRatioUpperBound,
	}
}

/**
 * 一个包的线上位数：SYNC + PID + 有效载荷 + （CRC）+ EOP。
 * 字段位数出自规范第 5 章事务开销表（见文件头第 5 条）。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {number} input.payloadBytes - 该包的数据域字节数（令牌/握手包为 0）。
 * @param {'token'|'data'|'handshake'|'sof'} input.kind - 包类型。
 * @returns {number} 位数。
 */
export function packetBits({ speed, kind, payloadBytes = 0 }) {
	const s = requireSpeed(speed)
	const base = s.syncBits + PACKET_FIELD_BITS.pid + s.eopBits
	if (kind === 'token') return base + PACKET_FIELD_BITS.tokenAddrEndpCrc5
	if (kind === 'data') return base + payloadBytes * 8 + PACKET_FIELD_BITS.dataCrc16
	if (kind === 'handshake') return base
	if (kind === 'sof') {
		// SOF 有自己的 EOP 长度（HS 为 40 位，EL_55）。
		return s.syncBits + PACKET_FIELD_BITS.pid + PACKET_FIELD_BITS.sofFrameNumberCrc5 + s.sofEopBits
	}
	throw new Error(`未知的包类型：${kind}（可用：token / data / handshake / sof）`)
}

/**
 * 单次数据事务的线上开销拆解。
 *
 * 事务 = 令牌包 + 数据包 + （握手包），包间按方向插入不同类型的间隔：
 *   - IN：主机发令牌 → 设备回数据 → 主机回握手，两处都是**总线切换**（EL_22，≥8 位时间）；
 *   - OUT：主机发令牌 → 主机发数据（**主机连发**，EL_23，≥88 位时间）→ 设备回握手（切换）；
 *   - 同步事务没有握手阶段（规范 §8.5），因此少一个包与一个间隔。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {string} input.transferType - 传输类型。
 * @param {'in'|'out'} [input.direction] - 方向，默认 `'in'`。
 * @param {number} input.payloadBytes - 数据域字节数（≤ wMaxPacketSize）。
 * @param {{turnaround?: number, hostToHost?: number}} [input.gapBits] - 实测包间延迟（位时间）。
 * @param {string[]} [input.notes] - 结果收集（用于记录回退值）。
 * @returns {object} `{ tokenBits, dataBits, handshakeBits, payloadBits, gapBits, totalBits,
 *   busTimeNs, payloadRatio, overheadRatio }`。
 */
export function transactionBits({ speed, transferType, direction = 'in', payloadBytes, gapBits, notes = [] }) {
	const s = requireSpeed(speed)
	if (!TRANSFER_TYPES.includes(transferType)) {
		throw new Error(`未知的传输类型：${transferType}（可用：${TRANSFER_TYPES.join(' / ')}）`)
	}
	if (!(payloadBytes >= 0)) throw new Error('payloadBytes 必须 ≥ 0')
	const gap = resolveGapBits(s.id, gapBits, notes)

	const tokenBits = packetBits({ speed: s.id, kind: 'token' })
	const dataBits = packetBits({ speed: s.id, kind: 'data', payloadBytes })
	// 同步事务无握手阶段（规范 §8.5）；其余按“正常完成、不回 NAK”的理想情形建模。
	const handshakeBits = TYPES_WITH_HANDSHAKE.has(transferType)
		? packetBits({ speed: s.id, kind: 'handshake' })
		: 0

	let gaps = 0
	if (transferType === 'isochronous') {
		// 令牌 → 数据：IN 是设备应答（切换），OUT 是主机连发。
		gaps = direction === 'out' ? gap.hostToHost : gap.turnaround
	} else if (direction === 'out') {
		gaps = gap.hostToHost + gap.turnaround
	} else {
		gaps = gap.turnaround + gap.turnaround
	}

	const payloadBits = payloadBytes * 8
	const totalBits = tokenBits + dataBits + handshakeBits + gaps
	return {
		tokenBits,
		dataBits,
		payloadBits,
		handshakeBits,
		gapBits: gaps,
		totalBits,
		busTimeNs: totalBits * (1e9 / s.bitRateHz),
		payloadRatio: totalBits > 0 ? payloadBits / totalBits : 0,
		overheadRatio: totalBits > 0 ? 1 - payloadBits / totalBits : 0,
	}
}

/**
 * 一次完整控制传输（建立 + 可选数据 + 状态）的位数。
 * 控制传输是令牌包 + 8 字节建立包 + 可选数据阶段 + 零长度状态阶段（规范 §8.5.3）。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {number} [input.dataBytes] - 数据阶段字节数，缺省 0（无数据阶段的请求）。
 * @param {number} input.maxPacketBytes - 数据阶段用的最大包大小。
 * @param {'in'|'out'} [input.dataDirection] - 数据阶段方向，默认 `'in'`。
 * @param {{turnaround?: number, hostToHost?: number}} [input.gapBits] - 实测包间延迟。
 * @param {string[]} [input.notes] - 结果收集。
 * @returns {object} `{ transactionCount, totalBits, busTimeNs, stages }`。
 */
export function controlTransferBits({
	speed,
	dataBytes = 0,
	maxPacketBytes,
	dataDirection = 'in',
	gapBits,
	notes = [],
}) {
	const s = requireSpeed(speed)
	const spec = requirePacketSpec(s.id, 'control')
	if (!(maxPacketBytes >= 1 && maxPacketBytes <= spec.max)) {
		throw new Error(`控制端点包大小必须 ≤ ${spec.max} 字节（规范 §5.5）`)
	}
	const gap = resolveGapBits(s.id, gapBits, notes)

	const setup = transactionBits({
		speed: s.id,
		transferType: 'control',
		direction: 'out',
		payloadBytes: 8,
		gapBits: gap,
		notes,
	})
	// 状态阶段是方向相反、载荷为 0 的一次事务。
	const status = transactionBits({
		speed: s.id,
		transferType: 'control',
		direction: dataDirection === 'in' ? 'out' : 'in',
		payloadBytes: 0,
		gapBits: gap,
		notes,
	})

	let dataTotalBits = 0
	let dataTransactionCount = 0
	if (dataBytes > 0) {
		const packets = Math.ceil(dataBytes / maxPacketBytes)
		let remaining = dataBytes
		for (let i = 0; i < packets; i += 1) {
			const size = Math.min(remaining, maxPacketBytes)
			remaining -= size
			const t = transactionBits({
				speed: s.id,
				transferType: 'control',
				direction: dataDirection,
				payloadBytes: size,
				gapBits: gap,
				notes,
			})
			dataTotalBits += t.totalBits
			dataTransactionCount += 1
		}
	}

	const totalBits = setup.totalBits + status.totalBits + dataTotalBits
	return {
		transactionCount: 1 + dataTransactionCount + 1,
		dataTransactionCount,
		totalBits,
		busTimeNs: totalBits * (1e9 / s.bitRateHz),
		setupBits: setup.totalBits,
		dataBits: dataTotalBits,
		statusBits: status.totalBits,
	}
}

/**
 * 给定事务耗时，算一个 (微)帧里最多塞得下多少次事务。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {number} input.totalBits - 单次事务的位数。
 * @param {number} [input.availableUs] - 可用时间（µs），缺省为一个完整的微帧/帧。
 * @param {number} [input.sofBits] - 每个 (微)帧的 SOF 占用位数，缺省 0（不扣）。
 * @returns {object} `{ maxTransactions, availableUs, transactionUs, usedUs, spareUs, usedRatio }`。
 */
export function maxTransactionsInInterval({ speed, totalBits, availableUs, sofBits = 0 }) {
	const s = requireSpeed(speed)
	const budgetUs = availableUs === undefined ? s.microframeUs : availableUs
	// 单位统一到 µs：bitRateHz 的倒数按 1e9 算是**纳秒**，
	// 混进下面 µs ÷ ns 的除法会恒得 0（maxTransactions 永远是 0）。
	const bitTimeUs = 1e6 / s.bitRateHz
	const transactionUs = totalBits * bitTimeUs
	const effectiveUs = budgetUs - sofBits * bitTimeUs
	if (transactionUs <= 0) return { maxTransactions: 0, availableUs: budgetUs, transactionUs: 0, usedUs: 0, spareUs: effectiveUs, usedRatio: 0 }
	// 单个事务就装不进可用窗口时 floor 会得 0 或负数 —— 负数没有意义，钳到 0。
	const maxTransactions = Math.max(0, Math.floor(effectiveUs / transactionUs))
	const usedUs = maxTransactions * transactionUs
	return {
		maxTransactions,
		availableUs: budgetUs,
		transactionUs,
		usedUs,
		spareUs: effectiveUs - usedUs,
		usedRatio: usedUs / budgetUs,
	}
}

/**
 * SOF 包在每个 (微)帧里占用的位数。HS 帧有 8 个微帧 → 8 个 SOF。
 * EOP 长度差异（HS 的 SOF EOP 为 40 位）出自电气一致性 EL_55。
 *
 * @param {string} speed - 速率 id。
 * @returns {number} 一个**帧**内 SOF 的总位数。
 */
export function sofBitsPerFrame(speed) {
	const s = requireSpeed(speed)
	return packetBits({ speed: s.id, kind: 'sof' }) * s.microframesPerFrame
}

/**
 * 把端点描述符的 bInterval 换算成服务间隔（µs）。
 * 规范 §9.6.6：HS 中断/同步的轮询周期为 2^(bInterval−1) 个微帧（bInterval 1..16）；
 * FS 中断/同步的 bInterval 就是帧数（1..255）。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {number} input.bInterval - 端点描述符 bInterval。
 * @returns {object} `{ bInterval, intervalMicroframes, intervalUs }`。
 */
export function bIntervalToInterval({ speed, bInterval }) {
	const s = requireSpeed(speed)
	if (!Number.isInteger(bInterval) || bInterval < 1) {
		throw new Error('bInterval 必须是 ≥ 1 的整数（规范 §9.6.6）')
	}
	if (s.id === 'high') {
		if (bInterval > 16) throw new Error('HS 的 bInterval 范围为 1..16（规范 §9.6.6）')
		const intervalMicroframes = 2 ** (bInterval - 1)
		return { bInterval, intervalMicroframes, intervalUs: intervalMicroframes * s.microframeUs }
	}
	if (bInterval > 255) throw new Error('LS/FS 的 bInterval 范围为 1..255（规范 §9.6.6）')
	return { bInterval, intervalMicroframes: bInterval * s.microframesPerFrame, intervalUs: bInterval * s.frameUs }
}

/**
 * 解析 wMaxPacketSize 原始 16 位值。
 *
 * @param {number} raw - 端点描述符里的 wMaxPacketSize。
 * @returns {object} `{ raw, maxPacketBytes, additionalTransactions, transactionsPerMicroframe,
 *   reservedBits }`。
 */
export function parseWMaxPacketSize(raw) {
	if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) throw new Error('raw 必须是 0..65535 的整数')
	const maxPacketBytes = raw & 0x07ff
	const additional = (raw >> 11) & 0x03
	return {
		raw,
		maxPacketBytes,
		additionalTransactions: additional === 3 ? null : additional,
		transactionsPerMicroframe: additional === 3 ? null : 1 + additional,
		/** bit 15..13 保留，必须为 0（规范 §9.6.6）。 */
		reservedBits: (raw >> 13) & 0x07,
	}
}

/**
 * 编码 wMaxPacketSize 原始 16 位值。
 *
 * @param {object} input - 输入。
 * @param {number} input.maxPacketBytes - 单个物理包字节数（≤1024）。
 * @param {number} [input.additionalTransactions] - 每微帧额外事务数（0/1/2），默认 0。
 * @returns {number} 16 位原始值。
 */
export function encodeWMaxPacketSize({ maxPacketBytes, additionalTransactions = 0 }) {
	if (!Number.isInteger(maxPacketBytes) || maxPacketBytes < 1 || maxPacketBytes > 1024) {
		throw new Error('单个物理包最大 1024 字节（规范 §5.5–§5.8）')
	}
	const enc = HIGH_BANDWIDTH_ENCODING[additionalTransactions]
	if (!enc) throw new Error('additionalTransactions 只能是 0 / 1 / 2（bit 12..11，规范 §9.6.6）')
	return (enc.rawBits | maxPacketBytes) & 0xffff
}

/**
 * 校验一组「高带宽端点」参数是否自洽（wMaxPacketSize / 事务数 / 传输类型 / 速率）。
 *
 * 这是纯描述符合法性判定，不含时间预算。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {string} input.transferType - 传输类型。
 * @param {number} input.maxPacketBytes - 单个物理包字节数。
 * @param {number} [input.additionalTransactions] - 每微帧额外事务数，默认 0。
 * @returns {object} `{ checks, warnings, notes, transactionsPerMicroframe, bytesPerMicroframe, maxPacketBytes }`。
 */
export function checkHighBandwidth({ speed, transferType, maxPacketBytes, additionalTransactions = 0 }) {
	const s = requireSpeed(speed)
	const checks = []
	const warnings = []
	const notes = []
	const spec = requirePacketSpec(s.id, transferType)

	if (!HIGH_BANDWIDTH_ENCODING[additionalTransactions]) {
		throw new Error('additionalTransactions 只能是 0 / 1 / 2（bit 12..11，规范 §9.6.6）')
	}
	const transactionsPerMicroframe = 1 + additionalTransactions
	const bytesPerMicroframe = maxPacketBytes * transactionsPerMicroframe

	// 1) 包大小必须落在该速率/类型允许的范围内。
	const inRange = maxPacketBytes >= spec.min && maxPacketBytes <= spec.max
	checks.push({
		name: '最大包大小',
		pass: inRange,
		detail: `${s.label} ${transferType} 允许 ${spec.min}..${spec.max} 字节，给定 ${maxPacketBytes}`,
	})
	if (!inRange) {
		warnings.push(
			`${transferType} 端点在 ${s.label} 下的单包大小必须是 ${spec.min}..${spec.max} 字节，` +
				`${maxPacketBytes} 不合法（规范 §5.5–§5.8）。`,
		)
	}
	if (spec.allowed && !spec.allowed.includes(maxPacketBytes)) {
		checks.push({
			name: '最大包大小取值集合',
			pass: false,
			detail: `${s.label} ${transferType} 只允许 ${spec.allowed.join('/')} 字节`,
		})
		warnings.push(`${s.label} 的 ${transferType} 端点单包大小只允许 ${spec.allowed.join('/')} 字节。`)
	} else {
		checks.push({
			name: '最大包大小取值集合',
			pass: true,
			detail: spec.allowed ? `∈ {${spec.allowed.join('/')}}` : '该类型允许 1 字节粒度取值',
		})
	}

	// 2) 高带宽（多事务/微帧）只对 HS 的中断与同步开放。
	const highBandwidthUsed = transactionsPerMicroframe > 1
	const typeOk = s.id === 'high' && TYPES_SUPPORTING_HIGH_BANDWIDTH.has(transferType)
	checks.push({
		name: '高带宽适用范围',
		pass: !highBandwidthUsed || typeOk,
		detail: highBandwidthUsed
			? `每微帧 ${transactionsPerMicroframe} 次事务：仅 HS 的中断/同步支持（规范 §9.6.6）`
			: '单事务/微帧，无高带宽约束',
	})
	if (highBandwidthUsed && !typeOk) {
		warnings.push(
			`每微帧多事务（bit 12..11 ≠ 00）**只适用于高速的中断与同步端点**；` +
				`${s.label} 的 ${transferType} 端点必须把 bit 12..11 置 0。` +
				`（出处：Microsoft USBD_PIPE_INFORMATION 文档、Cypress AN、规范 §9.6.6）`,
		)
	}

	// 3) 单微帧字节数硬上限 3072。
	const bytesOk = bytesPerMicroframe <= HIGH_BANDWIDTH_MAX_BYTES_PER_MICROFRAME
	checks.push({
		name: '单微帧字节上限',
		pass: bytesOk,
		detail: `${maxPacketBytes} × ${transactionsPerMicroframe} = ${bytesPerMicroframe} 字节 ≤ ${HIGH_BANDWIDTH_MAX_BYTES_PER_MICROFRAME}`,
	})
	if (!bytesOk) {
		warnings.push(
			`单微帧 ${bytesPerMicroframe} 字节超过 3072 字节上限（规范 §9.6.6）。` +
				`要么减小单包大小，要么减少每微帧事务数。`,
		)
	}

	if (highBandwidthUsed) {
		notes.push(
			'规范 §5.9：高带宽端点在一个微帧内**除最后一次事务外**，都必须发满该端点的最大载荷；' +
				`即 ${transactionsPerMicroframe} 次事务里前 ${transactionsPerMicroframe - 1} 次必须是 ${maxPacketBytes} 字节。`,
		)
	}
	notes.push(
		`wMaxPacketSize = 0x${encodeWMaxPacketSize({ maxPacketBytes, additionalTransactions }).toString(16).padStart(4, '0')} ` +
			`（低 11 位 ${maxPacketBytes}，bit 12..11 = ${additionalTransactions}）`,
	)

	return { checks, warnings, notes, transactionsPerMicroframe, bytesPerMicroframe, maxPacketBytes }
}

/**
 * 单条周期端点在一个服务间隔内的总线占用与有效吞吐。
 *
 * 这是**设计上限估算**：假定每次事务都能发满、不发生 NAK、不重传。真实吞吐必须实测。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {string} input.transferType - 传输类型（中断 / 同步）。
 * @param {'in'|'out'} [input.direction] - 方向，默认 `'in'`。
 * @param {number} input.maxPacketBytes - 单包字节数。
 * @param {number} [input.transactionsPerMicroframe] - 每微帧事务数，默认 1（仅 HS 可为 2/3）。
 * @param {number} [input.intervalFrames=1] - 服务间隔（帧数）。FS/LS 用这个；
 *   HS 下若不传 `intervalMicroframes` 则由它换算。
 * @param {number} [input.intervalMicroframes] - HS 的服务间隔（微帧数），优先于 `intervalFrames`。
 * @param {{turnaround?: number, hostToHost?: number}} [input.gapBits] - 实测包间延迟。
 * @param {string[]} [input.notes] - 结果收集。
 * @returns {object} `{ bytesPerFrame, bytesPerSecond, busTimeUsPerOccurrence, busTimeUsPerFrame,
 *   busTimeUsPerMicroframe, shareOfMicroframe, occurrencesPerFrame, transactionsPerFrame,
 *   intervalMicroframes, intervalFrames, transaction }`。
 */
export function estimatePeriodicEndpoint({
	speed,
	transferType,
	direction = 'in',
	maxPacketBytes,
	transactionsPerMicroframe = 1,
	intervalFrames = 1,
	intervalMicroframes,
	gapBits,
	notes = [],
}) {
	const s = requireSpeed(speed)
	if (!TYPES_SUPPORTING_HIGH_BANDWIDTH.has(transferType)) {
		throw new Error('周期端点只指中断与同步（estimatePeriodicEndpoint 的适用对象）')
	}
	const tx = transactionBits({
		speed: s.id,
		transferType,
		direction,
		payloadBytes: maxPacketBytes,
		gapBits,
		notes,
	})

	// 服务间隔统一换算成微帧数（FS/LS 的“微帧”就等于帧）。
	const microframesPerInterval =
		s.id === 'high' ? (intervalMicroframes ?? intervalFrames * s.microframesPerFrame) : intervalFrames * s.microframesPerFrame
	if (!(microframesPerInterval > 0)) throw new Error('服务间隔必须为正数')

	// 一帧里该端点被服务几次（可能不是整数，例如 HS bInterval=16）。
	const occurrencesPerFrame = s.microframesPerFrame / microframesPerInterval
	// 每次被服务发几次事务（HS 高带宽才 > 1）。
	const transactionsPerFrame = transactionsPerMicroframe * occurrencesPerFrame
	const bytesPerFrame = maxPacketBytes * transactionsPerFrame
	const bytesPerSecond = (bytesPerFrame * 1e6) / s.frameUs

	// 一次服务的总线时间，以及平摊到每个微帧的占用（带宽分配的记账口径）。
	const busTimeUsPerOccurrence = (tx.busTimeNs * transactionsPerMicroframe) / 1000
	const busTimeUsPerFrame = busTimeUsPerOccurrence * occurrencesPerFrame
	const busTimeUsPerMicroframe = busTimeUsPerFrame / s.microframesPerFrame

	return {
		bytesPerFrame,
		bytesPerSecond,
		busTimeUsPerOccurrence,
		busTimeUsPerFrame,
		busTimeUsPerMicroframe,
		shareOfMicroframe: busTimeUsPerMicroframe / s.microframeUs,
		occurrencesPerFrame,
		transactionsPerFrame,
		intervalMicroframes: microframesPerInterval,
		intervalFrames: microframesPerInterval / s.microframesPerFrame,
		transaction: tx,
	}
}

/**
 * **核心判定**：给定一组端点，判断能否装进一个 (微)帧的带宽预算。
 *
 * 判定口径严格按规范 §5.11.3：
 *   1. 周期端点（中断 + 同步）合计不得超过 `periodicMaxRatio`（FS 90% / HS 80%）；
 *   2. 控制传输**保留** `controlReservedRatio`（FS 10% / HS 20%），这部分不能给周期端点，
 *      也不计入批量可用量；
 *   3. 批量不保留任何带宽，只能吃剩下的：`剩余 = (微)帧 − 周期已用 − 控制保留`。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - 速率 id。
 * @param {Array<object>} input.endpoints - 端点清单，每项
 *   `{ name?, transferType, direction?, maxPacketBytes, transactionsPerMicroframe?,
 *      intervalFrames?, intervalMicroframes?, gapBits? }`。
 *   只接受周期性端点（中断/同步）；批量与控制请用 `bulk` / `controlBytesPerFrame` 另行评估。
 * @param {{turnaround?: number, hostToHost?: number}} [input.gapBits] - 全局实测包间延迟。
 * @param {boolean} [input.includeSof=true] - 是否扣除每个 (微)帧的 SOF 占用。
 * @param {number} [input.controlBytesPerFrame=0] - 该帧内预计的控制流量（字节），
 *   用于判断控制保留是否够用（不改成高速/全速包大小就无法换算成时间，故传字节并指定包大小）。
 * @param {number} [input.controlMaxPacketBytes] - 控制流量换算用的包大小。
 * @returns {object} 统一形状的结果。
 */
export function fitEndpointsInFrame({
	speed,
	endpoints = [],
	gapBits,
	includeSof = true,
	controlBytesPerFrame = 0,
	controlMaxPacketBytes,
}) {
	const s = requireSpeed(speed)
	const budget = frameBudget(s.id)
	const checks = []
	const warnings = []
	const notes = []
	const gap = resolveGapBits(s.id, gapBits, notes)

	const unitUs = s.microframeUs
	const sofBits = includeSof ? packetBits({ speed: s.id, kind: 'sof' }) : 0
	const sofUs = (sofBits * (1e9 / s.bitRateHz)) / 1000

	// 逐端点算占用，并按「该端点落在第几个微帧被服务」把时间摊到微帧槽位上。
	// 单微帧速率（LS/FS）只有一个槽位，退化成整帧记账。
	const slotCount = s.microframesPerFrame
	const perMicroframeUs = new Array(slotCount).fill(0)
	const rows = []
	for (const ep of endpoints) {
		const type = ep.transferType
		if (type === 'bulk' || type === 'control') {
			throw new Error(
				`fitEndpointsInFrame 只处理周期端点（中断/同步）。${type} 端点不参与周期预算，` +
					`请用批量剩余量（返回值 bulkAvailableUs）单独评估。`,
			)
		}
		const tpm = ep.transactionsPerMicroframe ?? 1
		if (tpm > 1 && s.id !== 'high') {
			warnings.push(
				`端点 ${ep.name ?? type} 声明每微帧 ${tpm} 次事务，但 ${s.label} 不支持高带宽端点，` +
					`按 1 次事务计算。`,
			)
		}
		const effectiveTpm = s.id === 'high' && TYPES_SUPPORTING_HIGH_BANDWIDTH.has(type) ? tpm : 1
		const est = estimatePeriodicEndpoint({
			speed: s.id,
			transferType: type,
			direction: ep.direction ?? 'in',
			maxPacketBytes: ep.maxPacketBytes,
			transactionsPerMicroframe: effectiveTpm,
			intervalFrames: ep.intervalFrames ?? 1,
			intervalMicroframes: ep.intervalMicroframes,
			gapBits: ep.gapBits ?? gap,
			notes,
		})

		// 间隔能整除一帧时按 slot % interval === 0 精确定位（主机就是这样排的）；
		// 间隔跨帧（HS bInterval > 4，或 FS bInterval > 1）时该端点并非每帧都被服务，
		// 退化为把平均占用摊到每个槽位 —— 这是平均口径，不是峰值口径，已在 notes 说明。
		const interval = est.intervalMicroframes
		const exact = Number.isInteger(interval) && interval <= slotCount && slotCount % interval === 0
		if (exact) {
			for (let i = 0; i < slotCount; i += 1) {
				if (i % interval === 0) perMicroframeUs[i] += est.busTimeUsPerOccurrence
			}
		} else {
			for (let i = 0; i < slotCount; i += 1) perMicroframeUs[i] += est.busTimeUsPerMicroframe
		}

		rows.push({
			name: ep.name ?? `${type}-${ep.direction ?? 'in'}`,
			transferType: type,
			direction: ep.direction ?? 'in',
			maxPacketBytes: ep.maxPacketBytes,
			transactionsPerMicroframe: effectiveTpm,
			intervalFrames: est.intervalFrames,
			intervalMicroframes: est.intervalMicroframes,
			occurrencesPerFrame: est.occurrencesPerFrame,
			bytesPerFrame: est.bytesPerFrame,
			bytesPerSecond: est.bytesPerSecond,
			busTimeUsPerOccurrence: est.busTimeUsPerOccurrence,
			busTimeUsPerFrame: est.busTimeUsPerFrame,
			busTimeUsPerMicroframe: est.busTimeUsPerMicroframe,
			// 峰值口径：所有落在这个微帧里的端点占用之和。
			peakSlotUs: exact ? est.busTimeUsPerOccurrence : est.busTimeUsPerMicroframe,
			slotAccounting: exact ? 'exact' : 'average',
		})
	}

	const periodicPeakUs = Math.max(0, ...perMicroframeUs)
	const periodicAvgUs = perMicroframeUs.reduce((a, b) => a + b, 0) / slotCount
	const periodicLimitUs = budget.periodicLimitUs
	const periodicOk = periodicPeakUs <= periodicLimitUs

	checks.push({
		name: '周期端点带宽',
		pass: periodicOk,
		detail:
			`峰值微帧周期合计 ${periodicPeakUs.toFixed(2)} µs（平均 ${periodicAvgUs.toFixed(2)} µs），` +
			`上限 ${periodicLimitUs.toFixed(2)} µs（${budget.periodicMaxRatio * 100}% × ${unitUs} µs）`,
	})
	if (!periodicOk) {
		warnings.push(
			`周期端点在最忙的那个微帧合计 ${periodicPeakUs.toFixed(2)} µs，超过 ` +
				`${budget.periodicMaxRatio * 100}% 的上限 ${periodicLimitUs.toFixed(2)} µs（规范 §5.11.3）。` +
				`这个端点组合**装不下**：减小单包大小、拉长服务间隔、减少每微帧事务数，或改走另一条总线。`,
		)
	}
	if (rows.some((r) => r.slotAccounting === 'average')) {
		notes.push(
			'有端点的服务间隔跨帧，其占用按**平均**口径摊到各微帧；最坏情况（多个跨帧端点恰好落到同一帧）' +
				'会比这个估计更紧，需要按实际主机调度再确认。',
		)
	}

	// 控制保留必须留得出来（它和周期上限是同一个微帧里的两块）。
	const withControlUs = periodicPeakUs + budget.controlReservedUs
	checks.push({
		name: '控制保留',
		pass: withControlUs <= unitUs,
		detail:
			`周期峰值 ${periodicPeakUs.toFixed(2)} + 控制保留 ${budget.controlReservedUs.toFixed(2)} = ` +
			`${withControlUs.toFixed(2)} µs ≤ ${unitUs} µs`,
	})
	if (withControlUs > unitUs) {
		warnings.push(
			`周期流量吃掉带宽后，控制传输保留的 ${budget.controlReservedUs.toFixed(2)} µs ` +
				`（${budget.controlReservedRatio * 100}% × ${unitUs} µs）已放不下（规范 §5.11.3）。`,
		)
	}

	// 批量：只能用剩下的。这里按最忙微帧扣除周期峰值、控制保留，再扣掉 SOF。
	const bulkAvailableUs = Math.max(0, unitUs - periodicPeakUs - budget.controlReservedUs - sofUs)
	const bulkTx = transactionBits({
		speed: s.id,
		transferType: 'bulk',
		direction: 'out',
		payloadBytes: s.id === 'high' ? 512 : 64,
		gapBits: gap,
		notes,
	})
	const bulkTransactions = Math.floor((bulkAvailableUs * 1000) / bulkTx.busTimeNs)

	checks.push({
		name: '批量剩余带宽',
		pass: true,
		detail:
			`批量可用 ${bulkAvailableUs.toFixed(2)} µs/(微)帧（${((bulkAvailableUs / unitUs) * 100).toFixed(1)}%）` +
			`≈ ${bulkTransactions} 个 ${s.id === 'high' ? 512 : 64} 字节事务`,
	})
	if (bulkAvailableUs <= 0) {
		warnings.push(
			'批量传输没有剩余带宽（周期 + 控制保留已占满 (微)帧）。批量端点会长期拿不到总线，' +
				'表现为极低吞吐或超时。',
		)
	}

	// 控制流量是否放得进保留（需要包大小才能换算时间）。
	if (controlBytesPerFrame > 0 && controlMaxPacketBytes > 0) {
		const controlSpec = requirePacketSpec(s.id, 'control')
		if (controlMaxPacketBytes > controlSpec.max) {
			warnings.push(
				`控制包大小 ${controlMaxPacketBytes} 超过 ${s.label} 的上限 ${controlSpec.max} 字节（规范 §5.5）。`,
			)
		}
		const perFrameUnits = s.microframesPerFrame
		const controlBits = controlTransferBits({
			speed: s.id,
			dataBytes: controlBytesPerFrame / perFrameUnits,
			maxPacketBytes: controlMaxPacketBytes,
			dataDirection: 'in',
			gapBits: gap,
			notes,
		})
		const controlUs = (controlBits.busTimeNs * perFrameUnits) / 1000
		const controlOk = controlUs <= budget.controlReservedUs
		checks.push({
			name: '控制流量 vs 保留',
			pass: controlOk,
			detail: `预计控制流量 ${controlUs.toFixed(2)} µs/帧 ≤ 保留 ${budget.controlReservedUs.toFixed(2)} µs/(微)帧`,
		})
		if (!controlOk) {
			notes.push(
				'控制流量超出保留量。规范允许主机把周期传输**未用满**的时间挪给控制传输，' +
					'所以这不一定是硬失败，但周期流量越满，控制请求的延迟就越不可控。',
			)
		}
	}

	if (includeSof) {
		notes.push(`已扣除每个 (微)帧的 SOF：${sofBits} 位 ≈ ${sofUs.toFixed(3)} µs（HS 的 SOF EOP 为 40 位，EL_55）。`)
	}
	notes.push(
		'**本模型的已知缺口**：低速设备挂在高速 Hub 后面时，每一次事务都要经过「分裂事务」（SSPLIT + ' +
			'下游低速事务 + CSPLIT），低速侧还会多一个 PRE 特殊包。规范 §5.11.3 规定分裂事务占用的时间' +
			'**从周期传输那 80% 里扣**。本模块不做分裂事务建模，所以**低速设备经 Hub 的场景会高估可用带宽**，' +
			'必须按 Hub 手册的实测值另行核算。',
	)
	notes.push(
		`事务开销拆解以 HS 批量 OUT / 512 字节为例：令牌 ${bulkTx.tokenBits} + 数据 ${bulkTx.dataBits} + ` +
			`握手 ${bulkTx.handshakeBits} + 包间 ${bulkTx.gapBits} = ${bulkTx.totalBits} 位，` +
			`其中有效载荷只占 ${(bulkTx.payloadRatio * 100).toFixed(1)}%。` +
			`**每多一个端点就多一份令牌/握手/包间开销**，所以把一个大端点拆成多个小端点会显著降低总线效率。`,
	)

	return {
		speed: s.id,
		speedLabel: s.label,
		unitUs,
		microframesPerFrame: s.microframesPerFrame,
		periodicPeakUs,
		periodicAvgUs,
		periodicUsedUs: periodicPeakUs,
		periodicLimitUs,
		periodicUsedRatio: periodicPeakUs / unitUs,
		periodicMaxRatio: budget.periodicMaxRatio,
		periodicHeadroomUs: periodicLimitUs - periodicPeakUs,
		controlReservedUs: budget.controlReservedUs,
		bulkAvailableUs,
		bulkAvailableRatio: bulkAvailableUs / unitUs,
		bulkTransactionsPerUnit: bulkTransactions,
		sofUs,
		perMicroframeUs,
		endpoints: rows,
		fits: periodicOk && withControlUs <= unitUs,
		checks,
		warnings,
		notes,
	}
}

/**
 * FIFO / 双缓冲对**可达**吞吐的限制。
 *
 * 这一段不是规范内容，是**排队模型**：端点能否跑满 `estimatePeriodicEndpoint` 算出的
 * 理论值，取决于固件能否在主机下一次来取之前把 FIFO 填好（IN）或掏空（OUT）。
 * 因此 `serviceLatencyUs`（固件从上一次中断/完成事件到重新武装 FIFO 的时间）
 * 与 `buffers`（是否双缓冲）**必须由调用方给出/实测**，本模块不内置任何器件的数字。
 *
 * 模型：`可达包率 = 1 / max(服务间隔, serviceLatencyUs / buffers)`。
 * 双缓冲把两次服务合并成一个窗口，等效于把服务延迟摊到两个包上。
 *
 * @param {object} input - 输入。
 * @param {number} input.maxPacketBytes - 单包字节数。
 * @param {number} input.intervalUs - 该端点的服务间隔（µs）。
 * @param {number} input.serviceLatencyUs - 实测的固件服务延迟（µs）。**必须实测**。
 * @param {number} [input.buffers=1] - FIFO 缓冲个数，1 = 单缓冲，2 = 双缓冲。
 * @param {number} [input.busLimitedBytesPerSecond] - 总线上限（来自 `estimatePeriodicEndpoint`），
 *   给了就一并报告谁是瓶颈。
 * @param {string} [input.name] - 端点名，用于输出。
 * @returns {object} 统一形状的结果。
 */
export function fifoServiceLimit({
	name,
	maxPacketBytes,
	intervalUs,
	serviceLatencyUs,
	buffers = 1,
	busLimitedBytesPerSecond,
}) {
	if (!(maxPacketBytes > 0)) throw new Error('maxPacketBytes 必须为正数')
	if (!(intervalUs > 0)) throw new Error('intervalUs 必须为正数')
	if (!(serviceLatencyUs > 0)) {
		throw new Error('serviceLatencyUs 必须由调用方给出（固件服务延迟是器件相关的，模块不内置默认值）')
	}
	if (!Number.isInteger(buffers) || buffers < 1) throw new Error('buffers 必须是 ≥ 1 的整数')

	const checks = []
	const warnings = []
	const notes = []

	const serviceWindowUs = serviceLatencyUs / buffers
	const effectiveIntervalUs = Math.max(intervalUs, serviceWindowUs)
	const packetsPerSecond = 1e6 / effectiveIntervalUs
	const fifoBytesPerSecond = packetsPerSecond * maxPacketBytes

	const serviceBound = serviceWindowUs > intervalUs
	checks.push({
		name: 'FIFO 服务是否成为瓶颈',
		pass: !serviceBound,
		detail: serviceBound
			? `服务窗口 ${serviceWindowUs.toFixed(1)} µs（${serviceLatencyUs} / ${buffers} 缓冲）> 服务间隔 ` +
				`${intervalUs.toFixed(1)} µs：FIFO 跟不上，跑不满总线`
			: `服务窗口 ${serviceWindowUs.toFixed(1)} µs ≤ 服务间隔 ${intervalUs.toFixed(1)} µs：FIFO 不是瓶颈`,
	})
	if (serviceBound) {
		warnings.push(
			`${name ?? '端点'}：FIFO 服务延迟 ${serviceLatencyUs} µs 分到 ${buffers} 个缓冲上是 ` +
				`${serviceWindowUs.toFixed(1)} µs，大于服务间隔 ${intervalUs.toFixed(1)} µs，` +
				`吞吐被 FIFO 卡住而不是被总线卡住。加双缓冲、减小包大小、拉长间隔都能缓解。`,
		)
	}

	let limitingFactor = serviceBound ? 'fifo' : 'bus'
	if (busLimitedBytesPerSecond !== undefined && busLimitedBytesPerSecond < fifoBytesPerSecond) {
		limitingFactor = 'bus'
	}
	const achievable = Math.min(fifoBytesPerSecond, busLimitedBytesPerSecond ?? Infinity)

	if (buffers === 1) {
		notes.push(
			'单缓冲下硬件在主机取走/送达一个包之后才能被固件重新武装，服务延迟**全额**计到每个包上；' +
				'双缓冲（乒乓）可让硬件打包下一个缓冲的同时固件填另一个，等效把窗口切成 1/2。',
		)
	}
	notes.push(
		'这只是排队模型的设计估算。真实吞吐还受中断延迟、DMA 带宽、CPU 抢占影响，必须实测（拉满负载测实际字节率）。',
	)

	return {
		name: name ?? null,
		buffers,
		intervalUs,
		serviceLatencyUs,
		serviceWindowUs,
		effectiveIntervalUs,
		packetsPerSecond,
		fifoBytesPerSecond,
		busLimitedBytesPerSecond: busLimitedBytesPerSecond ?? null,
		achievableBytesPerSecond: achievable,
		limitingFactor,
		checks,
		warnings,
		notes,
	}
}

/**
 * 统一入口：校验端点描述符 + 判断能否装进一帧 + 报出批量剩余与 FIFO 影响。
 *
 * @param {object} input - 输入。
 * @param {string} input.speed - `'low'` | `'full'` | `'high'`。
 * @param {Array<object>} input.endpoints - 端点清单（见 `fitEndpointsInFrame`）。
 * @param {{turnaround?: number, hostToHost?: number}} [input.gapBits] - 实测包间延迟（位时间）。
 * @param {boolean} [input.includeSof=true] - 是否扣除 SOF 占用。
 * @param {number} [input.controlBytesPerFrame=0] - 预计控制流量。
 * @param {number} [input.controlMaxPacketBytes] - 控制流量换算用包大小。
 * @param {object} [input.fifo] - FIFO 评估参数
 *   `{ name?, maxPacketBytes, intervalUs, serviceLatencyUs, buffers? }`。
 * @returns {object} 统一形状 `{ checks, warnings, notes, ...数值 }`。
 */
export function analyzeUsbBandwidth({
	speed,
	endpoints = [],
	gapBits,
	includeSof = true,
	controlBytesPerFrame = 0,
	controlMaxPacketBytes,
	fifo,
}) {
	const s = requireSpeed(speed)
	const budget = frameBudget(s.id)
	const checks = []
	const warnings = []
	const notes = []

	// 1) 端点描述符合法性。
	for (const ep of endpoints) {
		const spec = requirePacketSpec(s.id, ep.transferType)
		const label = ep.name ?? `${ep.transferType}-${ep.direction ?? 'in'}`
		const src = ep.wMaxPacketSizeRaw !== undefined ? parseWMaxPacketSize(ep.wMaxPacketSizeRaw) : null
		const packetBytes = src ? src.maxPacketBytes : ep.maxPacketBytes
		const additional = src ? src.additionalTransactions : (ep.transactionsPerMicroframe ?? 1) - 1

		const ok = packetBytes >= spec.min && packetBytes <= spec.max
		checks.push({
			name: `${label} 包大小`,
			pass: ok,
			detail: `${s.label} ${ep.transferType} 允许 ${spec.min}..${spec.max}，给定 ${packetBytes}`,
		})
		if (!ok) {
			warnings.push(`${label}：包大小 ${packetBytes} 超出 ${s.label} ${ep.transferType} 的 ${spec.min}..${spec.max}（规范 §5.5–§5.8）。`)
		}
		if (spec.allowed && !spec.allowed.includes(packetBytes)) {
			warnings.push(`${label}：${s.label} 的 ${ep.transferType} 只允许 ${spec.allowed.join('/')} 字节取值。`)
		}
		if (additional !== null && additional > 0) {
			const hb = checkHighBandwidth({
				speed: s.id,
				transferType: ep.transferType,
				maxPacketBytes: packetBytes,
				additionalTransactions: additional,
			})
			checks.push(...hb.checks)
			warnings.push(...hb.warnings)
			notes.push(...hb.notes)
		}
	}

	// 2) 周期带宽判定。
	const periodicEndpoints = endpoints.filter((e) => e.transferType === 'interrupt' || e.transferType === 'isochronous')
	const fit = fitEndpointsInFrame({
		speed: s.id,
		endpoints: periodicEndpoints,
		gapBits,
		includeSof,
		controlBytesPerFrame,
		controlMaxPacketBytes,
	})
	checks.push(...fit.checks)
	warnings.push(...fit.warnings)
	notes.push(...fit.notes)

	// 3) FIFO 影响（可选，需要调用方给实测服务延迟）。
	let fifoResult = null
	if (fifo) {
		const intervalUs = fifo.intervalUs ?? 0
		fifoResult = fifoServiceLimit({ ...fifo, intervalUs })
		checks.push(...fifoResult.checks)
		warnings.push(...fifoResult.warnings)
		notes.push(...fifoResult.notes)
	}

	// 4) 端点数量对效率的影响（定性但可量化：开销是按事务计的）。
	if (periodicEndpoints.length > 1) {
		const totalPayload = fit.endpoints.reduce((a, r) => a + r.maxPacketBytes, 0)
		const totalBusUs = fit.periodicUsedUs
		notes.push(
			`共 ${periodicEndpoints.length} 个周期端点，合计单次事务有效载荷 ${totalPayload} 字节 / ` +
				`占用 ${totalBusUs.toFixed(2)} µs。令牌、握手与包间延迟是**每个事务各付一份**的开销，` +
				`与载荷无关 —— 端点越多、单包越小，总线使用效率越低。`,
		)
	}

	notes.push(
		`${s.label}：帧 ${budget.frameUs} µs，微帧 ${budget.microframeUs} µs × ${budget.microframesPerFrame}；` +
			`周期上限 ${budget.periodicMaxRatio * 100}%，控制保留 ${budget.controlReservedRatio * 100}%，` +
			`批量不保留（规范 §5.11.3）。`,
	)
	notes.push(
		`批量的理论最大占比：无周期流量时 ${(budget.bulkAvailableRatioUpperBound * 100).toFixed(0)}%，` +
			`周期占满上限时为 ${(budget.bulkAvailableRatio * 100).toFixed(0)}%。`,
	)

	return {
		speed: s.id,
		speedLabel: s.label,
		...budget,
		periodicUsedUs: fit.periodicUsedUs,
		periodicUsedRatio: fit.periodicUsedRatio,
		periodicLimitUs: fit.periodicLimitUs,
		periodicHeadroomUs: fit.periodicHeadroomUs,
		bulkAvailableUs: fit.bulkAvailableUs,
		bulkAvailableRatio: fit.bulkAvailableRatio,
		bulkTransactionsPerUnit: fit.bulkTransactionsPerUnit,
		sofUs: fit.sofUs,
		endpoints: fit.endpoints,
		fifo: fifoResult,
		fits: fit.fits,
		checks,
		warnings,
		notes,
	}
}

/** 供文档与自测使用的速率清单。 */
export const USB_SPEED_IDS = Object.keys(USB_SPEEDS)

/** 供文档与自测使用的传输类型清单。 */
export const USB_TRANSFER_TYPE_IDS = [...TRANSFER_TYPES]
