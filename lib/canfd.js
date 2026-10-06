/**
 * CAN-FD 位时序（仲裁段 / 数据段分立）、BRS 切换点、帧结构、DLC 映射与 CRC 场。
 *
 * ## 联网核实到的出处（如实登记，非凭记忆）
 *
 * 1. **ISO 11898-1:2015**（CAN FD 数据链路层与物理层信令）
 *    - §10.4.2.6「CRC field」：FD 帧的 CRC 场 = stuff count + CRC sequence + CRC delimiter。
 *      stuff count 位于 CRC 场的**开头**，由「stuff bit count 模 8 的 3 位格雷码 + 1 位奇偶位」组成。
 *    - §10.5「Frame coding」：FD 帧 CRC 场内的填充位插在**固定位置**（fixed stuff bit）：
 *      “There shall be a fixed stuff bit before the first bit of the stuff count, even if the last bits
 *       of the preceding field are a sequence of five consecutive bits of identical value, there shall be
 *       only the fixed stuff bit, there shall not be two consecutive stuff bits. A further fixed stuff bit
 *       shall be inserted after each fourth bit of the CRC field.”
 *      （原文经 Linux 内核 include/linux/can/length.h 的 commit 9fde4c557f78 引用核对；
 *        同一说法另见 GigaDevice GD32H7/GD32A5 用户手册「Bit stuff」节。）
 *    - 动态位填充覆盖 SOF、仲裁场、控制场、数据场；CRC 界定符 / ACK 场 / EOF 为固定形式、不填充。
 *      FD 帧的 CRC 场改用固定填充位，故 FD 的动态填充范围**止于数据场结束**。
 *      同一出处给出：FSB 数 = 1 + floor(len(CRC field) / 4)，len(CRC field) = 4 + len(CRC)
 *      → CRC17 共 **6** 个，CRC21 共 **7** 个。
 *    - CRC 界定符：FD 帧**可能**由 1 或 2 个隐性位构成（发送方只发 1 位，接收方接受 2 位）。
 *
 * 2. **Bosch《CAN with Flexible Data-Rate》V1.0（2012-04）**（CAN FD 原始规范，ISO 的前身）
 *    - CRC 多项式：CRC_15 = 0xC599（经典帧）；CRC_17 = 0x3685B（FD 帧，数据场 **≤ 16 字节**）；
 *      CRC_21 = 0x302899（FD 帧，数据场 **> 16 字节**）。三者 Hamming 距离均为 HD = 6。
 *    - “In CAN FD format frames, STUFF-BITS are included in the relevant bit stream for CRC
 *       calculation, in CAN format frames, STUFF-BITS are not included.”
 *      （经典 CAN 的 CRC **不计**填充位；FD **计**填充位。）
 *    - “CAN FD protocol controllers switch back from the DATA-PHASE to the ARBITRATION PHASE when
 *       they reach the SAMPLE POINT of the (first bit of the) CRC DELIMITER.”
 *
 * 3. **NXP AMF-AUT-T3346 / AMF-AUT-T2788（CAN FD and Partial Networking）**
 *    - 位速率在 **BRS 位的采样点**切到数据段速率，在 **CRC 界定符位的采样点**切回仲裁段速率；
 *      因此 BRS 与 CRC 界定符是所谓 “mixed bits”（前半段一种速率、后半段另一种速率）。
 *    - 给出示例：仲裁段 500 kbit/s（位时间 2000 ns，SP 80%）、数据段 2 Mbit/s（位时间 500 ns，SP 60%）
 *      → BRS 位 = 2000 ns × 80% + 500 ns × (1 − 60%) = **1800 ns**；
 *        CRC 界定符位 = 500 ns × 60% + 2000 ns × (1 − 80%) = **700 ns**。
 *      （本模块把这两个数当基准向量钉住，见 probe/canfd.probe.mjs。）
 *
 * 4. **DLC → 数据字节数映射**（Vector certification 页、Kvaser《Comparing CAN FD with Classical
 *    CAN》、CiA 的 CAN FD 介绍、Beckhoff CAN Interface 手册 口径一致）：
 *    经典 CAN 与 FD 的 DLC 0~8 → 0~8 字节（经典 CAN 的 DLC 9~15 编码合法，但数据场固定按 8 字节处理）；
 *    FD 的 DLC 9~15 → 12 / 16 / 20 / 24 / 32 / 48 / 64 字节。
 *    注意 FD 的合法载荷长度只有 0~8、12、16、20、24、32、48、64 这 16 种：
 *    9~11、13~15、17~19、21~23… 字节**没有对应编码**，必须补齐到下一档。
 *
 * 5. **CiA《Recommendation for the CAN FD bit-timing》(Holger Zeltwanger, CAN Newsletter 2018-03)**
 *    - 仲裁段采样点：“A value of higher than 80 % is not recommended for automotive applications
 *      due to robustness reasons”；采样越早鲁棒性越好，但可支持的网络长度越短（是权衡，不是单向越好）。
 *    - 数据段采样点：位置取决于物理层的**位不对称量**（显性位最长延长 A1 / 最长缩短 A2），
 *      须用实测或仿真的 A1、A2 按 CiA 601-3 的方法证明相位裕量 PM1/PM2 为正。
 *    - Rec. 6：数据波特率 > 1 Mbit/s 时**必须使能 TDC**，且此时 BRPD 应设为 1 或 2（引 ISO 11898-1:2015）。
 *    - Rec. 5：SJW 取尽可能大（上限 min(Phase_Seg1, Phase_Seg2)）；数据段 SJW 越大时钟容差越大。
 *    - 二次采样点 SSP：位置以「距位时间起点的最小时间量子数」表示，范围至少 0~63 个最小时间量子；
 *      发送延迟的测量在**每帧**的 FDF 位→res 位隐性→显性边沿上进行，同帧数据段生效
 *      （此条另见 GigaDevice GD32H7 用户手册「Transmitter delay compensation」节）。
 *
 * ## 两段采样点的关系（请连同上面第 5 条一起读）
 *
 * 两段采样点**互相独立**，各自按自己的 BRP/TSEG1/TSEG2/SJW 计算，协议**没有**要求两者相等。
 * 但本模块查到的资料口径基本一致：**数据段采样点通常比仲裁段更早（百分比更低）**——
 * 仲裁段 75~80%（CiA 明确不建议 > 80%），数据段按位不对称量与相位裕量往**前**挪
 * （常见 60~80%，速率越高越靠前；例：NXP 示例 仲裁 80% / 数据 60%）。
 * 另有资料与 OEM 规范把两者定得很接近（例：仲裁 80% / 数据 75%），也有实车配置落在
 * 仲裁 79.375% / 数据 80% 这种「数据段略靠后」的组合。
 * 所以本模块**不把「谁大谁小」当 pass/fail 判据**，只在数据段采样点晚于仲裁段时给一条 warnings，
 * 提醒必须用实测 A1/A2 与相位裕量论证——最终请以项目 / OEM 规范为准。
 *
 * ## 设计值 vs 必须实测
 *
 * - **设计值**（本模块算的）：BRP/TSEG1/TSEG2/SJW、两段位时间与波特率误差、采样点百分比、
 *   BRS 与 CRC 界定符这两个 mixed bit 的时长、帧结构位数在各速率段的分布。
 * - **必须实测**：实际位宽与波特率（示波器看 CAN_H/CAN_L）、边沿抖动、位不对称量 A1/A2、
 *   收发器环回延迟（TDC 的 TD 测量值）、最终误帧率。采样点附近的振铃 / 反射只能实测。
 * - 本模块**不内置任何来自数据手册的经验默认值**：采样点目标、SJW、控制器寄存器范围（limits）、
 *   收发器支持的最高数据速率，全部必须由调用方传入；缺哪一项就在 warnings 里点名。
 *
 * @module dsh-embedded-kit/canfd
 */

import { SYNC_SEG_TQ, oscillatorTolerance } from './can.js'

/**
 * 协议结构下限：Sync_Seg(1) + Prop_Seg(≥ 1) + Phase_Seg1(≥ 1) + Phase_Seg2(≥ 1)。
 * 这是帧结构决定的硬下限，**不是**任何芯片手册的经验值。
 */
export const MIN_NBT_TQ = 4

/** 功能值与寄存器编程值的固定偏移：编程值 = 功能值 − 1。 */
export const REGISTER_VALUE_OFFSET = 1

/** 经典 CAN：DLC 0~8 直映字节数；DLC 9~15 合法但数据场固定按 8 字节处理。 */
export const CLASSIC_DLC_TO_BYTES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8, 8, 8, 8, 8, 8]

/** CAN FD：DLC 0~8 直映；DLC 9~15 非线性映射到 12/16/20/24/32/48/64 字节。 */
export const CANFD_DLC_TO_BYTES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]

/** FD 能直接编码的合法载荷长度（共 16 种）。其余长度必须补齐到下一档。 */
export const CANFD_VALID_PAYLOAD_BYTES = [...CANFD_DLC_TO_BYTES]

/** DLC 字段位宽。 */
export const DLC_BITS = 4

/** FD 数据场最大字节数（DLC 15）。 */
export const CANFD_MAX_PAYLOAD_BYTES = 64

/**
 * CRC 变体。字段与出处见文件头第 2 条（Bosch CAN FD 规范原文）。
 *
 * `appliesTo` 里的字节数是**数据场长度**，不是 DLC。
 */
export const CRC_VARIANTS = {
	'crc15': {
		id: 'crc15',
		bits: 15,
		polynomialHex: '0xC599',
		polynomial:
			'x^15 + x^14 + x^10 + x^8 + x^7 + x^4 + x^3 + x^0',
		hammingDistance: 6,
		appliesTo: '经典 CAN 帧（数据场 0~8 字节）',
		includesStuffBits: false,
	},
	'crc17': {
		id: 'crc17',
		bits: 17,
		polynomialHex: '0x3685B',
		polynomial:
			'x^17 + x^16 + x^14 + x^13 + x^11 + x^6 + x^4 + x^3 + x^1 + x^0',
		hammingDistance: 6,
		appliesTo: 'CAN FD 帧，数据场 ≤ 16 字节（即 DLC 0~10）',
		includesStuffBits: true,
	},
	'crc21': {
		id: 'crc21',
		bits: 21,
		polynomialHex: '0x302899',
		polynomial:
			'x^21 + x^20 + x^13 + x^11 + x^7 + x^4 + x^3 + x^0',
		hammingDistance: 6,
		appliesTo: 'CAN FD 帧，数据场 > 16 字节（即 DLC 11~15）',
		includesStuffBits: true,
	},
}

/** CRC17 / CRC21 的长度分界：数据场 ≤ 16 字节用 CRC17，> 16 字节用 CRC21（Bosch 规范原文）。 */
export const CRC17_MAX_PAYLOAD_BYTES = 16

/** stuff count 的编码表：索引 = 动态填充位数模 8，值为 4 位（3 位格雷码 + 1 位偶校验）。 */
export const STUFF_COUNT_ENCODING = [
	[0, 0, 0, 0],
	[0, 0, 1, 1],
	[0, 1, 1, 0],
	[0, 1, 0, 1],
	[1, 1, 0, 0],
	[1, 1, 1, 1],
	[1, 0, 1, 0],
	[1, 0, 0, 1],
]

/**
 * CRC 计算覆盖的位流。出处见文件头第 2 条（Bosch 原文）与第 1 条（ISO）。
 *
 * `isoCanFd` 的 stuff count 是否计入 CRC 输入流，本模块未能直接读到 ISO 11898-1:2015 正文核对
 * （Bosch 2012 版规范早于 stuff count 的引入，其原文只写到「SOF + 仲裁场 + 控制场 + 数据场」）。
 * 二手资料（含中文规范解读）称 ISO 版比 non-ISO 版多了 4 位 stuff count 且初值不同，
 * 这正是 ISO 与非 ISO CAN FD 互不兼容的原因之一。此处如实标注 `verified: false`。
 */
export const CRC_INPUT_COVERAGE = {
	classicCan: {
		fields: 'SOF + 仲裁场 + 控制场 + 数据场 + CRC 序列',
		includesStuffBits: false,
		includesStuffCount: false,
		verified: true,
	},
	nonIsoCanFd: {
		fields: 'SOF + 仲裁场 + 控制场 + 数据场（含填充位）',
		includesStuffBits: true,
		includesStuffCount: false,
		verified: true,
	},
	isoCanFd: {
		fields: 'SOF + 仲裁场 + 控制场 + 数据场（含填充位）+ stuff count',
		includesStuffBits: true,
		includesStuffCount: true,
		verified: false,
		caveat:
			'stuff count 是否计入 CRC 输入流，本模块只读到二手说法、没能核对 ISO 11898-1:2015 正文。' +
			'做逐位 CRC 实现前必须拿标准正文或 ISO 参考实现复核。',
	},
}

/**
 * FD 标准格式（11 位标识符，FBFF）的字段模板。
 *
 * `rate`  = 该字段跑在哪一套位时序上（仲裁段 / 数据段 / 两者切换的 mixed bit）。
 * `stuffing` = 该字段的填充方式：动态位填充 / 固定填充位 / 不填充。
 *
 * `bits: null` 表示长度需要按 DLC / CRC 变体计算。
 */
export const CANFD_STANDARD_FIELDS = [
	{ name: 'SOF', label: '帧起始（显性）', bits: 1, group: '帧起始', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'Identifier', label: '11 位基本标识符', bits: 11, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'RRS', label: '远程请求替代位（CAN FD 恒显性，无远程帧）', bits: 1, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'IDE', label: '标识符扩展位（基本格式为显性）', bits: 1, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'FDF', label: 'FD 格式指示位（FD 帧为隐性，旧名 r0/EDL）', bits: 1, group: '控制场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'res', label: '保留位（恒显性）', bits: 1, group: '控制场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'BRS', label: '位速率切换（隐性 → 以下切到数据段速率）', bits: 1, group: '控制场', rate: 'mixed', stuffing: 'dynamic' },
	{ name: 'ESI', label: '错误状态指示（隐性 = 发送方 error passive）', bits: 1, group: '控制场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'DLC', label: '数据长度码（4 位）', bits: 4, group: '控制场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'Data', label: '数据场（按 DLC 映射）', bits: null, group: '数据场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'SBC', label: '填充位计数（3 位格雷码 + 1 位偶校验）', bits: 4, group: 'CRC 场', rate: 'data', stuffing: 'fixed' },
	{ name: 'CRC', label: 'CRC 序列（17 或 21 位）', bits: null, group: 'CRC 场', rate: 'data', stuffing: 'fixed' },
	{ name: 'FSB', label: '固定填充位（CRC17 共 6 个 / CRC21 共 7 个）', bits: null, group: 'CRC 场', rate: 'data', stuffing: 'none' },
	{ name: 'CD', label: 'CRC 界定符（发送 1 位，接收方可接受 2 位）', bits: 1, group: 'CRC 场', rate: 'mixed', stuffing: 'none' },
	{ name: 'ACKsl', label: 'ACK 槽（接收方拉显性应答）', bits: 1, group: 'ACK 场', rate: 'arbitration', stuffing: 'none' },
	{ name: 'ACKdel', label: 'ACK 界定符', bits: 1, group: 'ACK 场', rate: 'arbitration', stuffing: 'none' },
	{ name: 'EOF', label: '帧结束（7 位隐性）', bits: 7, group: '帧结束', rate: 'arbitration', stuffing: 'none' },
	{ name: 'IFS', label: '帧间间隔（3 位隐性；不属于帧本身，但占总线时间）', bits: 3, group: '帧间间隔', rate: 'arbitration', stuffing: 'none' },
]

/** FD 扩展格式（29 位标识符，FEFF）的字段模板：仲裁场换成 基本 ID + SRR + IDE + 扩展 ID + RRS。 */
export const CANFD_EXTENDED_FIELDS = [
	{ name: 'SOF', label: '帧起始（显性）', bits: 1, group: '帧起始', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'IdentifierA', label: '11 位基本标识符', bits: 11, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'SRR', label: '替代远程请求位（恒隐性）', bits: 1, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'IDE', label: '标识符扩展位（扩展格式为隐性）', bits: 1, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'IdentifierB', label: '18 位扩展标识符', bits: 18, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'RRS', label: '远程请求替代位（CAN FD 恒显性，位于扩展标识符之后）', bits: 1, group: '仲裁场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'FDF', label: 'FD 格式指示位（FD 帧为隐性，旧名 r0/EDL）', bits: 1, group: '控制场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'res', label: '保留位（恒显性）', bits: 1, group: '控制场', rate: 'arbitration', stuffing: 'dynamic' },
	{ name: 'BRS', label: '位速率切换（隐性 → 以下切到数据段速率）', bits: 1, group: '控制场', rate: 'mixed', stuffing: 'dynamic' },
	{ name: 'ESI', label: '错误状态指示（隐性 = 发送方 error passive）', bits: 1, group: '控制场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'DLC', label: '数据长度码（4 位）', bits: 4, group: '控制场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'Data', label: '数据场（按 DLC 映射）', bits: null, group: '数据场', rate: 'data', stuffing: 'dynamic' },
	{ name: 'SBC', label: '填充位计数（3 位格雷码 + 1 位偶校验）', bits: 4, group: 'CRC 场', rate: 'data', stuffing: 'fixed' },
	{ name: 'CRC', label: 'CRC 序列（17 或 21 位）', bits: null, group: 'CRC 场', rate: 'data', stuffing: 'fixed' },
	{ name: 'FSB', label: '固定填充位（CRC17 共 6 个 / CRC21 共 7 个）', bits: null, group: 'CRC 场', rate: 'data', stuffing: 'none' },
	{ name: 'CD', label: 'CRC 界定符（发送 1 位，接收方可接受 2 位）', bits: 1, group: 'CRC 场', rate: 'mixed', stuffing: 'none' },
	{ name: 'ACKsl', label: 'ACK 槽（接收方拉显性应答）', bits: 1, group: 'ACK 场', rate: 'arbitration', stuffing: 'none' },
	{ name: 'ACKdel', label: 'ACK 界定符', bits: 1, group: 'ACK 场', rate: 'arbitration', stuffing: 'none' },
	{ name: 'EOF', label: '帧结束（7 位隐性）', bits: 7, group: '帧结束', rate: 'arbitration', stuffing: 'none' },
	{ name: 'IFS', label: '帧间间隔（3 位隐性；不属于帧本身，但占总线时间）', bits: 3, group: '帧间间隔', rate: 'arbitration', stuffing: 'none' },
]

/**
 * DLC → 数据场字节数（正向映射）。
 *
 * @param {number} dlc - DLC 值 0~15。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.fd] - true 按 CAN FD 映射，false 按经典 CAN 映射（9~15 一律 8 字节）。默认 true。
 * @returns {number} 数据场字节数。
 */
export function dlcToBytes(dlc, { fd = true } = {}) {
	assertDlc(dlc)
	return fd ? CANFD_DLC_TO_BYTES[dlc] : CLASSIC_DLC_TO_BYTES[dlc]
}

/**
 * 数据字节数 → 能装下它的 DLC（反向查询）。
 *
 * FD 只有 16 种合法长度，所以 10 字节这样的载荷会被顶到 DLC 9（12 字节），多出的要填充。
 *
 * @param {number} byteLength - 需要的载荷字节数。
 * @param {object} [options] - 选项。
 * @param {boolean} [options.fd] - true 按 CAN FD（最大 64 字节），false 按经典 CAN（最大 8 字节）。默认 true。
 * @returns {{dlc:number, encodedBytes:number, paddingBytes:number, exact:boolean, byteLength:number, fd:boolean}}
 *   DLC、实际数据场长度、需要填充的字节数、是否精确命中。
 */
export function bytesToDlc(byteLength, { fd = true } = {}) {
	if (!Number.isInteger(byteLength) || byteLength < 0) {
		throw new Error('byte_length 必须是非负整数（载荷字节数）')
	}
	const table = fd ? CANFD_DLC_TO_BYTES : CLASSIC_DLC_TO_BYTES
	const limit = fd ? CANFD_MAX_PAYLOAD_BYTES : 8
	if (byteLength > limit) {
		throw new Error(
			`byte_length=${byteLength} 超出 ${fd ? 'CAN FD（DLC 15 → 64 字节）' : '经典 CAN（DLC 8 → 8 字节）'} 的上限 ${limit} 字节`,
		)
	}
	for (let dlc = 0; dlc <= 15; dlc += 1) {
		if (table[dlc] >= byteLength) {
			return {
				dlc,
				encodedBytes: table[dlc],
				paddingBytes: table[dlc] - byteLength,
				exact: table[dlc] === byteLength,
				byteLength,
				fd,
			}
		}
	}
	// 上面的循环必然命中（byteLength ≤ limit），这里只是防御
	throw new Error(`内部错误：${byteLength} 字节在 ${fd ? 'FD' : '经典 CAN'} 表中找不到对应 DLC`)
}

/**
 * 判定并说明一个 DLC：映射字节数、CRC 变体、是否需要填充、经典 CAN 下的截断。
 *
 * @param {object} input - 输入。
 * @param {number} input.dlc - DLC 值 0~15。
 * @param {object} [input.options] - 透传给 dlcToBytes 的选项（`fd`）。
 * @returns {object} `{ checks, warnings, notes, dlc, dataBytes, crc, ... }`。
 */
export function analyzeDlc({ dlc, options = {} }) {
	const fd = options.fd !== false
	assertDlc(dlc)

	const dataBytes = dlcToBytes(dlc, { fd })
	const checks = []
	const warnings = []
	const notes = []

	if (fd) {
		checks.push({
			name: 'FD 载荷是否在合法长度集合内',
			pass: true,
			detail:
				`DLC ${dlc} → ${dataBytes} 字节，是 FD 的 16 种合法长度之一` +
				`（0~8 / 12 / 16 / 20 / 24 / 32 / 48 / 64）`,
		})
	} else if (dlc > 8) {
		warnings.push(
			`经典 CAN 的 DLC ${dlc} 编码本身合法，但数据场**固定按 8 字节**处理（实际只发 8 字节）。` +
				`如果对端按 CAN FD 解释这 4 位，它会当成 ${CANFD_DLC_TO_BYTES[dlc]} 字节——` +
				'这正是经典 CAN 节点收到 FD 帧会报错、以及混总线时长度解析对不上的根源。',
		)
	}

	const crc = crcVariantForBytes(dataBytes)
	const fsb = fixedStuffBits(crc.bits)

	checks.push({
		name: 'CRC 变体分界',
		pass: true,
		detail: `数据场 ${dataBytes} 字节 ${dataBytes <= CRC17_MAX_PAYLOAD_BYTES ? '≤' : '>'} 16 字节 → ${crc.id.toUpperCase()}（${crc.bits} 位）`,
	})
	checks.push({
		name: 'CRC 场固定填充位数',
		pass: true,
		detail: `CRC 场 = stuff count(4) + CRC(${crc.bits}) = ${fsb.crcFieldBits} 位 → FSB ${fsb.count} 个`,
	})

	notes.push(
		'DLC 只描述**数据场**长度，与整帧位数无关；整帧还要加上控制场、CRC 场、ACK 与 EOF。',
	)
	if (fd) {
		notes.push(
			'FD 的 DLC 9~15 是非线性映射（12/16/20/24/32/48/64）。' +
				'例如 10 字节载荷没有直接编码，必须用 DLC 9（12 字节）并自行约定填充内容。',
		)
	}
	notes.push(
		`CRC 场的固定填充位共 ${fsb.count} 个，插在 CRC 场第 ${fsb.positionsAfter.join('、')} 位之后` +
			'（第 0 位表示插在 CRC 场第一位**之前**）；每一位取前一位的反值。详见 fixedStuffBits()。',
	)

	return {
		dlc,
		fd,
		dataBytes,
		payloadBits: dataBytes * 8,
		crc,
		fixedStuffBits: fsb,
		isExtendedLengthCode: dlc > 8,
		checks,
		warnings,
		notes,
	}
}

/**
 * 按数据场字节数选 CRC 变体。
 *
 * 分界出自 Bosch《CAN with Flexible Data-Rate》：数据场 ≤ 16 字节用 CRC_17，> 16 字节用 CRC_21。
 * 由于 FD 的合法长度从 16 直接跳到 20，实际不存在「17~19 字节该用哪个」的歧义。
 *
 * @param {number} byteLength - 数据场字节数。
 * @returns {typeof CRC_VARIANTS.crc17} CRC 变体对象。
 */
export function crcVariantForBytes(byteLength) {
	if (!Number.isInteger(byteLength) || byteLength < 0) {
		throw new Error('byte_length 必须是非负整数（数据场字节数）')
	}
	if (byteLength > CANFD_MAX_PAYLOAD_BYTES) {
		throw new Error(`byte_length=${byteLength} 超出 CAN FD 数据场上限 64 字节`)
	}
	return byteLength <= CRC17_MAX_PAYLOAD_BYTES ? CRC_VARIANTS.crc17 : CRC_VARIANTS.crc21
}

/**
 * 按 DLC 选 CRC 变体（内部先做 DLC→字节数映射）。
 *
 * @param {number} dlc - DLC 值 0~15。
 * @returns {typeof CRC_VARIANTS.crc17} CRC 变体对象。
 */
export function crcVariantForDlc(dlc) {
	assertDlc(dlc)
	return crcVariantForBytes(dlcToBytes(dlc))
}

/**
 * CRC 场的固定填充位（fixed stuff bit）数量与插入位置。
 *
 * 规则出自 ISO 11898-1:2015 §10.5（见文件头第 1 条）：
 *   - 在 CRC 场**第一位之前**插一个固定填充位；
 *   - 之后**每 4 位**再插一个固定填充位。
 * 所以 FSB 数 = 1 + floor(len(CRC 场) / 4)，而 len(CRC 场) = stuff count(4) + CRC(17 或 21)。
 *   CRC17 → 1 + floor(21/4) = **6**；CRC21 → 1 + floor(25/4) = **7**。
 *
 * @param {number} crcBits - CRC 序列位数，只能是 17 或 21。
 * @returns {{count:number, crcFieldBits:number, positionsAfter:number[], rule:string}}
 *   FSB 个数、CRC 场位数、每个 FSB 插在第几位之后（0 = 插在 CRC 场首位之前）。
 */
export function fixedStuffBits(crcBits) {
	if (crcBits !== 17 && crcBits !== 21) {
		throw new Error(`crc_bits 只能是 17 或 21（CAN FD 的两种 CRC 序列长度），收到 ${crcBits}`)
	}
	const crcFieldBits = DLC_BITS + crcBits
	const positionsAfter = [0]
	for (let i = 4; i < crcFieldBits; i += 4) positionsAfter.push(i)
	return {
		count: 1 + Math.floor(crcFieldBits / 4),
		crcFieldBits,
		positionsAfter,
		rule: 'CRC 场首位之前插 1 个，之后每 4 位插 1 个（共 1 + floor(CRC 场位数/4) 个），每位取前一位的反值',
	}
}

/**
 * 动态位填充的**最坏**个数。
 *
 * ISO 11898-1:2015 §10.5：「检测到 5 个连续相同位（**含填充位**）就插一个反值位」——
 * 因为有「含填充位」这一句，最坏情况不是「每 5 位 1 个」，而是
 * 「每 4 位 1 个」的交替模式（1111 0000 1111 …），对应公式 floor((L − 1) / 4)。
 *
 * 这个公式可以用已知结论交叉验证：经典 CAN 标准帧 8 字节数据时，
 * 动态填充区 = SOF(1) + ID(11) + RTR(1) + IDE(1) + r0(1) + DLC(4) + Data(64) + CRC(15) = 98 位，
 * floor((98 − 1) / 4) = 24 个填充位，与教材常引的「最多 24 个填充位、整帧最多 132 位」一致。
 *
 * @param {number} streamBits - 动态填充区内的位数（不含已插入的填充位）。
 * @returns {number} 最坏情况下的填充位个数。
 */
export function dynamicStuffBitsWorstCase(streamBits) {
	if (!Number.isInteger(streamBits) || streamBits < 0) {
		throw new Error('stream_bits 必须是非负整数')
	}
	return Math.max(0, Math.floor((streamBits - 1) / 4))
}

/**
 * 动态填充区（dynamic stuffing 区）的位数。
 *
 * - 经典 CAN：动态填充从 SOF 一直到 **CRC 序列最后一位**。
 * - CAN FD：CRC 场改用固定填充位，所以动态填充**止于数据场结束**。
 *
 * @param {object} input - 输入。
 * @param {boolean} input.fd - 是否 FD 帧。
 * @param {boolean} input.extended - 是否扩展格式（29 位标识符）。
 * @param {number} input.dlc - DLC 值。
 * @returns {number} 动态填充区位数。
 */
export function dynamicStuffingRegionBits({ fd, extended, dlc }) {
	assertDlc(dlc)
	const dataBits = dlcToBytes(dlc, { fd }) * 8
	// SOF + 标识符部分 + RRS（扩展帧的 idBits 已含 IDE 位）
	const idBits = extended ? 1 + 11 + 1 + 1 + 18 + 1 : 1 + 11 + 1
	if (!fd) {
		// 经典 CAN 的控制场是 **6 位**：IDE(1) + r0(1) + DLC(4)。
		// 早先写成 `+ 1 + 4`（只算了 IDE 与 DLC，漏掉 r0）→ 标准帧 8 字节得到 97 位，
		// 而正确值是 SOF(1)+仲裁场(11+1)+控制场(6)+数据(64)+CRC 序列(15) = **98**。
		// 扩展帧的 idBits 里已经含 IDE，控制场同样再跟 6 位（r1 + r0 + DLC）。
		return idBits + 1 + 1 + 4 + dataBits + CRC_VARIANTS.crc15.bits
	}
	// FD：标准帧的 IDE 位位于 RRS 之后、FDF 之前（仲裁场末尾，dominant）——
	// 之前漏了它导致标准帧动态填充区少 1 位（DLC15 得 533，正确是 534）。
	// 扩展帧的 IDE 已计入 idBits，不再重复加。
	const ideBits = extended ? 0 : 1
	// 控制场 FDF + res + BRS + ESI + DLC(4)
	return idBits + ideBits + 1 + 1 + 1 + 1 + 4 + dataBits
}

/**
 * stuff count 的 4 位编码。
 *
 * stuff count = 帧中**第一个固定填充位之前**的动态填充位个数，取模 8，
 * 用 3 位格雷码表示，后面再跟 1 位偶校验位（ISO 11898-1:2015）。
 *
 * @param {number} stuffBitCount - 动态填充位个数（函数内部取模 8）。
 * @returns {{count:number, modulo8:number, bits:number[], grayCode:number[], parity:number}}
 */
export function stuffCountEncoding(stuffBitCount) {
	if (!Number.isInteger(stuffBitCount) || stuffBitCount < 0) {
		throw new Error('stuff_bit_count 必须是非负整数')
	}
	const modulo8 = stuffBitCount % 8
	const bits = STUFF_COUNT_ENCODING[modulo8]
	return {
		count: stuffBitCount,
		modulo8,
		bits,
		grayCode: bits.slice(0, 3),
		parity: bits[3],
	}
}

/**
 * 生成 FD 帧的字段布局（逐字段位数、起始位、所处速率段、填充方式）。
 *
 * 这是**设计值**：不包含动态填充位（`dynamicStuffBits` 由调用方传入——它要么取上式计算的最坏值，
 * 要么取实测值，二者给出的整帧时间差别很大，本模块不替你猜）。
 *
 * @param {object} input - 输入。
 * @param {number} input.dlc - DLC 值 0~15。
 * @param {object} [input.options] - 选项。
 * @param {boolean} [input.options.extended] - true 用扩展格式（29 位标识符）。默认 false。
 * @param {number} [input.options.dynamicStuffBits] - 计入的动态填充位个数。默认 0（理想、无填充）。
 * @returns {object} `{ checks, warnings, notes, fields, totals, ... }`。
 */
export function frameLayout({ dlc, options = {} }) {
	const extended = options.extended === true
	const dynamicStuffBits = options.dynamicStuffBits ?? 0
	assertDlc(dlc)
	if (!Number.isInteger(dynamicStuffBits) || dynamicStuffBits < 0) {
		throw new Error('dynamic_stuff_bits 必须是非负整数（取 0 表示理想无填充）')
	}

	const dataBytes = dlcToBytes(dlc)
	const crc = crcVariantForBytes(dataBytes)
	const fsb = fixedStuffBits(crc.bits)
	const template = extended ? CANFD_EXTENDED_FIELDS : CANFD_STANDARD_FIELDS

	const checks = []
	const warnings = []
	const notes = []

	let cursor = 0
	const fields = template.map((f) => {
		let bits = f.bits
		if (f.name === 'Data') bits = dataBytes * 8
		if (f.name === 'CRC') bits = crc.bits
		if (f.name === 'FSB') bits = fsb.count
		const entry = {
			name: f.name,
			label: f.label,
			group: f.group,
			rate: f.rate,
			stuffing: f.stuffing,
			bits,
			startBit: cursor,
			endBit: cursor + bits - 1,
		}
		cursor += bits
		return entry
	})

	const sumBy = (predicate) => fields.reduce((acc, f) => acc + (predicate(f) ? f.bits : 0), 0)
	const bitsByRate = {
		arbitration: sumBy((f) => f.rate === 'arbitration'),
		data: sumBy((f) => f.rate === 'data'),
		mixed: sumBy((f) => f.rate === 'mixed'),
	}
	const idealTotalBits = fields.reduce((acc, f) => acc + f.bits, 0)
	const stuffingRegion = dynamicStuffingRegionBits({ fd: true, extended, dlc })
	const worstCaseStuffBits = dynamicStuffBitsWorstCase(stuffingRegion)

	checks.push({
		name: '帧内位数合计是否自洽',
		pass: cursor === idealTotalBits,
		detail: `逐字段累加 = ${cursor} 位（理想、不含动态填充位）`,
	})
	checks.push({
		name: '动态填充位是否与计算的区域匹配',
		pass: dynamicStuffBits <= worstCaseStuffBits,
		detail: `传入 ${dynamicStuffBits} 个 vs 最坏 ${worstCaseStuffBits} 个（动态填充区 ${stuffingRegion} 位）`,
	})
	if (dynamicStuffBits > worstCaseStuffBits) {
		warnings.push(
			`传入的动态填充位数 ${dynamicStuffBits} 超过理论最坏值 ${worstCaseStuffBits}：` +
				'要么算错了，要么把 CRC 场的固定填充位重复计入了。',
		)
	}

	notes.push(
		`逐字段相加得到理想 ${idealTotalBits} 位；其中仲裁段速率 ${bitsByRate.arbitration} 位、` +
			`数据段速率 ${bitsByRate.data} 位、mixed bit ${bitsByRate.mixed} 位（BRS 与 CRC 界定符，各跨两段）。`,
	)
	notes.push(
		`动态填充区（FD 帧止于数据场结束）共 ${stuffingRegion} 位；最坏情况填充 ${worstCaseStuffBits} 个` +
			'（交替 4 位模式）。实际填充数取决于数据内容，逐位精确值只能按实际位流算。',
	)
	notes.push(
		`CRC 场固定填充位恒定 ${fsb.count} 个（CRC${crc.bits}），与数据内容无关，可直接计入。` +
			'固定填充位**不计入「含填充位就补」的动态规则**，即它本身不触发新的动态填充位。',
	)
	notes.push(
		'IFS（帧间间隔）不属于帧本身，但占总线时间；算总线负载时不要漏掉这 3 位。',
	)

	return {
		dlc,
		extended,
		dataBytes,
		crc,
		fixedStuffBits: fsb,
		fields,
		totals: {
			idealTotalBits,
			dynamicStuffBits,
			totalBits: idealTotalBits + dynamicStuffBits,
			bitsByRate,
			stuffingRegionBits: stuffingRegion,
			worstCaseStuffBits,
		},
		checks,
		warnings,
		notes,
	}
}

/**
 * 由波特率与采样点算 BRS / CRC 界定符这两个 mixed bit 的时长。
 *
 * 切换模型（NXP AMF-AUT-T3346，见文件头第 3 条）：
 *   - **BRS 位**：从位起点按**仲裁段**位时序跑，跑到它的仲裁段采样点时切到数据段速率，
 *     剩下的部分按数据段位时序的 Phase_Seg2 走。
 *     → 时长 = 仲裁位时间 × 仲裁 SP + 数据位时间 × (1 − 数据 SP)
 *   - **CRC 界定符位**：从位起点按**数据段**位时序跑，跑到它的数据段采样点时切回仲裁段速率。
 *     → 时长 = 数据位时间 × 数据 SP + 仲裁位时间 × (1 − 仲裁 SP)
 *
 * 基准向量（NXP 原文示例）：仲裁 2000 ns @ 80%、数据 500 ns @ 60%
 *   → BRS = 2000 × 0.8 + 500 × 0.4 = 1800 ns；CRC 界定符 = 500 × 0.6 + 2000 × 0.2 = 700 ns。
 *
 * @param {object} input - 输入。
 * @param {number} input.arbitrationBitrate - 仲裁段波特率（bit/s）。
 * @param {number} input.dataBitrate - 数据段波特率（bit/s）。
 * @param {number} input.arbitrationSamplePoint - 仲裁段采样点（0~1 的比例）。
 * @param {number} input.dataSamplePoint - 数据段采样点（0~1 的比例）。
 * @returns {object} `{ checks, warnings, notes, brsBitNs, crcDelimiterBitNs, ... }`。
 */
export function brsSwitchTiming({
	arbitrationBitrate,
	dataBitrate,
	arbitrationSamplePoint,
	dataSamplePoint,
}) {
	const arbBitTimeNs = assertBitrate(arbitrationBitrate, 'arbitration_bitrate')
	const dataBitTimeNs = assertBitrate(dataBitrate, 'data_bitrate')
	const arbSp = assertSamplePoint(arbitrationSamplePoint, 'arbitration_sample_point')
	const dataSp = assertSamplePoint(dataSamplePoint, 'data_sample_point')

	const checks = []
	const warnings = []
	const notes = []

	// 两个 mixed bit：一个是「仲裁 → 数据」，一个是「数据 → 仲裁」。
	// 取值是浮点乘加，像 300 + 400.00000000000006 这种尾差会直接印到结果里，故统一收拾到 6 位小数。
	const brsBitNs = round6(arbBitTimeNs * arbSp + dataBitTimeNs * (1 - dataSp))
	const crcDelimiterBitNs = round6(dataBitTimeNs * dataSp + arbBitTimeNs * (1 - arbSp))

	const dataSpLater = dataSp > arbSp
	checks.push({
		name: 'BRS 位是否比纯仲裁位短',
		pass: brsBitNs < arbBitTimeNs,
		detail: `BRS ${brsBitNs.toFixed(2)} ns vs 纯仲裁位 ${arbBitTimeNs.toFixed(2)} ns`,
	})
	checks.push({
		name: '数据段确实更快（BRS 切换有意义）',
		pass: dataBitrate > arbitrationBitrate,
		detail: `数据段 ${dataBitrate} bit/s vs 仲裁段 ${arbitrationBitrate} bit/s`,
	})

	if (dataSpLater) {
		warnings.push(
			`数据段采样点 ${(dataSp * 100).toFixed(2)}% 晚于仲裁段采样点 ${(arbSp * 100).toFixed(2)}%。` +
				'本模块查到的资料口径是**数据段通常更早采样**（仲裁段 75~80%，数据段按位不对称量往前挪，' +
				'速率越高越靠前；NXP 示例为 仲裁 80% / 数据 60%），CiA 也指出数据段采样点必须用实测的' +
				'位不对称量 A1/A2 与相位裕量 PM1/PM2 证明。数据段偏晚并非一定错（实车也有 79.375%/80% 的配置），' +
				'但必须拿出实测/仿真依据，不能只看「跑通了」。',
		)
	}
	if (dataBitrate === arbitrationBitrate) {
		warnings.push('数据段与仲裁段波特率相同：此时 BRS 切换没有收益，直接按普通 CAN 帧配即可。')
	}

	notes.push(
		'BRS 与 CRC 界定符在协议里叫 **mixed bit**：同一个位时间里跑两套位时序。' +
			'BRS 位的位时间比普通仲裁位短；CRC 界定符位的位时间比普通数据位长。' +
			'它们各自的**采样点**就是切换发生的时刻——这也是为什么分析仪上量 BRS 位宽度可以反推两段采样点。',
	)
	notes.push(
		'BRS 位本身仍跑在仲裁段速率上（其采样点之前是仲裁段位宽）；' +
			'BRS 后的**第一个数据段速率位是 ESI**，然后是 DLC、数据场、stuff count、CRC 场。',
	)
	notes.push(
		'切回仲裁段的时刻是 **CRC 界定符（第一位）的采样点**，之后的 ACK 槽、ACK 界定符、EOF 都是仲裁段速率。',
	)
	notes.push(
		`数据段速率是仲裁段的 ${(dataBitrate / arbitrationBitrate).toFixed(3)} 倍。` +
			'CiA 资料里常用 1:8 这个比例做吞吐估算（考虑控制场与 CRC 场变长后，整帧吞吐约提升 6 倍）；' +
			'实际能跑多高受收发器与总线拓扑限制，必须实测。',
	)

	return {
		arbitrationBitrate,
		dataBitrate,
		arbitrationBitTimeNs: arbBitTimeNs,
		dataBitTimeNs: dataBitTimeNs,
		arbitrationSamplePoint: arbSp,
		dataSamplePoint: dataSp,
		bitrateRatio: dataBitrate / arbitrationBitrate,
		brsBitNs,
		crcDelimiterBitNs,
		checks,
		warnings,
		notes,
	}
}

/**
 * 由字段布局与两段位时间估算整帧在总线上的时长。
 *
 * 时长 = 仲裁段速率位数 × 仲裁位时间
 *      + 数据段速率位数 × 数据位时间
 *      + BRS 位（mixed）
 *      + CRC 界定符位（mixed）
 *
 * 传 `dynamicStuffBits` 时按「填充位也按同速率”折算」（填充位落在哪个速率段取决于它在位流里的位置，
 * 本模块不逐位模拟，只在 notes 里说明这一近似）。
 *
 * @param {object} input - 输入。
 * @param {number} input.dlc - DLC 值。
 * @param {number} input.arbitrationBitrate - 仲裁段波特率（bit/s）。
 * @param {number} input.dataBitrate - 数据段波特率（bit/s）。
 * @param {number} input.arbitrationSamplePoint - 仲裁段采样点（0~1）。
 * @param {number} input.dataSamplePoint - 数据段采样点（0~1）。
 * @param {object} [input.options] - 透传给 frameLayout 的选项，外加 `dynamicStuffBits`。
 * @returns {object} `{ checks, warnings, notes, totalNs, ... }`。
 */
export function estimateFrameTime({
	dlc,
	arbitrationBitrate,
	dataBitrate,
	arbitrationSamplePoint,
	dataSamplePoint,
	options = {},
}) {
	const layout = frameLayout({ dlc, options })
	const brs = brsSwitchTiming({
		arbitrationBitrate,
		dataBitrate,
		arbitrationSamplePoint,
		dataSamplePoint,
	})

	const { bitsByRate, dynamicStuffBits } = layout.totals
	const arbNs = bitsByRate.arbitration * brs.arbitrationBitTimeNs
	const dataNs = bitsByRate.data * brs.dataBitTimeNs
	// 近似：把动态填充位按「它在位流里的位置」归到对应速率段。
	// 保守做法是全部按仲裁位时间算（填充位多落在控制场/数据场，仲裁段填充分量小），
	// 这里简单地按两段占比分摊，并在 notes 里如实说明这是近似。
	const stuffNs =
		dynamicStuffBits === 0
			? 0
			: dynamicStuffBits *
				((bitsByRate.arbitration * brs.arbitrationBitTimeNs +
					bitsByRate.data * brs.dataBitTimeNs) /
					(bitsByRate.arbitration + bitsByRate.data))

	const totalNs = arbNs + dataNs + brs.brsBitNs + brs.crcDelimiterBitNs + stuffNs

	const checks = [
		...layout.checks,
		...brs.checks,
		{
			name: '整帧时长是否为正且有限',
			pass: Number.isFinite(totalNs) && totalNs > 0,
			detail: `估算整帧 ${totalNs.toFixed(1)} ns`,
		},
	]

	const notes = [
		...layout.notes,
		...brs.notes,
		`估算：仲裁段速率 ${bitsByRate.arbitration} 位 × ${brs.arbitrationBitTimeNs.toFixed(1)} ns` +
			` + 数据段速率 ${bitsByRate.data} 位 × ${brs.dataBitTimeNs.toFixed(1)} ns` +
			` + BRS ${brs.brsBitNs.toFixed(1)} ns + CRC 界定符 ${brs.crcDelimiterBitNs.toFixed(1)} ns` +
			` = ${totalNs.toFixed(1)} ns。`,
		'动态填充位的时长是按两段占比**分摊估算**的（没有逐位模拟每个填充位落在哪一段）。' +
			'做精确总线负载计算时应按实际位流逐位累加。',
		'这是**设计值**：实际帧时长会因收发器环路延迟、边沿抖动而略有出入，须用示波器/分析仪实测。',
	]

	return {
		...layout,
		...brs,
		durationNs: totalNs,
		durationUs: totalNs / 1000,
		estimatedFramesPerSecond: 1e9 / totalNs,
		checks,
		warnings: [...layout.warnings, ...brs.warnings],
		notes,
	}
}

/**
 * 枚举单段（仲裁段或数据段）能精确（或最接近）命中目标波特率与采样点的位时序组合。
 *
 * 结构关系（与 lib/can.js 保持同一套命名）：
 *   位时间 = Sync_Seg(固定 1 tq) + Prop_Seg + Phase_Seg1 + Phase_Seg2 = NBT
 *   tq     = BRP(功能值) / 控制器时钟
 *   采样点 = (1 + Prop_Seg + Phase_Seg1) / NBT
 *   寄存器编程值 = 功能值 − 1（BRP/TSEG1/TSEG2/SJW 都这个偏移）
 *
 * @param {object} input - 输入。**全部关键量必须由调用方给出，缺失即抛错点名。**
 * @param {number} input.clockHz - CAN 控制器输入时钟（Hz）。
 * @param {number} input.bitrate - 本段目标波特率（bit/s）。
 * @param {number} input.samplePoint - 本段目标采样点（0~1 的比例）。
 * @param {object} [input.limits] - 控制器寄存器范围。缺失会在 warnings 里点名，不替你填默认值。
 * @param {number} [input.limits.brpMin] - BRP 功能值下限。
 * @param {number} [input.limits.brpMax] - BRP 功能值上限。
 * @param {number} [input.limits.tseg1TqMax] - TSEG1（Prop_Seg + Phase_Seg1）功能值上限（tq）。
 * @param {number} [input.limits.tseg2TqMax] - Phase_Seg2 功能值上限（tq）。
 * @param {number} [input.limits.sjwTqMax] - SJW 功能值上限（tq）。
 * @param {number} [input.maxCandidates] - 输出条数上限（**仅用于控制输出体积**，非硬件参数），默认 8。
 * @returns {object} `{ checks, warnings, notes, candidates, totalCandidates, ... }`。
 */
export function enumerateSegmentTiming({
	clockHz,
	bitrate,
	samplePoint,
	limits,
	maxCandidates = 8,
}) {
	if (!(clockHz > 0)) throw new Error('clock_hz 必须为正数（CAN 控制器输入时钟）')
	const bitTimeNs = assertBitrate(bitrate, 'bitrate')
	const spTarget = assertSamplePoint(samplePoint, 'sample_point')

	const checks = []
	const warnings = []
	const notes = []
	const candidates = []
	const totalCycles = clockHz / bitrate

	checks.push({
		name: '该时钟能否精确合成目标波特率',
		pass: Number.isInteger(totalCycles),
		detail:
			`clock / bitrate = ${totalCycles}` +
			(Number.isInteger(totalCycles) ? '（整数，可精确命中）' : '（非整数，只能近似，会有波特率误差）'),
	})
	if (!Number.isInteger(totalCycles)) {
		warnings.push(
			`时钟 ${clockHz} Hz 除不出 ${bitrate} bit/s（clock/bitrate = ${totalCycles}）。` +
				'下面的候选带波特率误差（ppm）。CAN FD 数据段对波特率精度敏感（对端要按同一时钟采样），' +
				'数据段出现几十到上百 ppm 的系统性偏差会直接压缩相位裕量，建议换能整除的时钟源。',
		)
	}

	if (!limits) {
		warnings.push(
			'**缺少控制器位时序寄存器范围**（limits.brpMax / tseg1TqMax / tseg2TqMax / sjwTqMax）：' +
				'下面只按「能整除」枚举，结果可能超出你手上芯片可写范围、或缺少控制器要求的 tq 数下限。' +
				'本模块不替你做这个假设——请补上 limits 后重算。',
		)
	} else {
		const missing = ['brpMax', 'tseg1TqMax', 'tseg2TqMax', 'sjwTqMax'].filter(
			(k) => limits[k] === undefined,
		)
		if (missing.length > 0) {
			warnings.push(
				`limits 里缺少 ${missing.join(' / ')}：这些项没被约束，候选里可能包含超出芯片能力的组合。`,
			)
		}
	}

	const structuralFloor = Math.max(MIN_NBT_TQ, limits?.nbtMin ?? 0)
	const structuralCeil = limits?.nbtMax ?? Infinity
	const brpMax = Math.min(limits?.brpMax ?? Infinity, Math.ceil(totalCycles) + 2)
	const brpMin = Math.max(limits?.brpMin ?? 1, 1)

	for (let brp = brpMin; brp <= brpMax; brp += 1) {
		const nbtFloat = totalCycles / brp
		// 只考虑 NBT 为整数的组合（NBT 必须是整数个 tq）
		const nbt = Math.round(nbtFloat)
		if (!Number.isInteger(nbtFloat)) continue
		if (nbt < structuralFloor || nbt > structuralCeil) continue

		const actualBitrate = clockHz / (brp * nbt)
		const bitrateErrorPpm = Math.round(((actualBitrate - bitrate) / bitrate) * 1e6)
		const tqNs = (brp / clockHz) * 1e9

		// 目标 (1 + TSEG1) / NBT = samplePoint  →  TSEG1 = round(sp × NBT) − 1
		const tseg1Target = Math.round(spTarget * nbt) - SYNC_SEG_TQ
		const tseg1 = Math.min(Math.max(tseg1Target, 2), nbt - 2) // Prop≥1、Phase1≥1，且 Phase2≥1
		if (tseg1 < 2 || nbt - SYNC_SEG_TQ - tseg1 < 1) continue
		if (limits?.tseg1TqMax !== undefined && tseg1 > limits.tseg1TqMax) continue
		const phaseSeg2 = nbt - SYNC_SEG_TQ - tseg1
		if (limits?.tseg2TqMax !== undefined && phaseSeg2 > limits.tseg2TqMax) continue

		const sp = (SYNC_SEG_TQ + tseg1) / nbt

		// Prop_Seg 与 Phase_Seg1 的切分不影响采样点，但影响能容忍的总线传播延迟
		for (let propSeg = 1; propSeg <= tseg1 - 1; propSeg += 1) {
			const phaseSeg1 = tseg1 - propSeg
			// SJW 上限取三者最小：Phase_Seg1、Phase_Seg2、控制器寄存器上限（若给出）
			const sjwCeiling = Math.min(phaseSeg1, phaseSeg2, limits?.sjwTqMax ?? Infinity)
			let sjwLegalMax = sjwCeiling
			// 协议要求：Phase_Seg1 + Phase_Seg2 > 2 × SJW
			while (sjwLegalMax > 1 && phaseSeg1 + phaseSeg2 <= 2 * sjwLegalMax) sjwLegalMax -= 1
			// 连 SJW=1 都违反时，这个切分本身不合法，直接丢掉
			if (!(sjwLegalMax >= 1) || phaseSeg1 + phaseSeg2 <= 2 * sjwLegalMax) continue

			const tol = oscillatorTolerance({
				propSeg,
				phaseSeg1,
				phaseSeg2,
				sjw: sjwLegalMax,
			})

			candidates.push({
				brp,
				nbt,
				tqNs,
				propSeg,
				phaseSeg1,
				phaseSeg2,
				tseg1Tq: tseg1,
				sjwMaxTq: sjwLegalMax,
				actualBitrate,
				bitrateErrorPpm,
				bitTimeNs,
				samplePointPercent: sp * 100,
				samplePointErrorPercent: (sp - spTarget) * 100,
				// 振荡器容差是在「SJW 取到最大」下算的，即该组合的理论上限
				oscTolerancePercent: tol.df * 100,
				maxOneWayDelayUs: ((propSeg * tqNs) / 2 / 1000),
				registers: {
					BRP: brp - REGISTER_VALUE_OFFSET,
					TSEG1: tseg1 - REGISTER_VALUE_OFFSET,
					TSEG2: phaseSeg2 - REGISTER_VALUE_OFFSET,
					SJW: sjwLegalMax - REGISTER_VALUE_OFFSET,
				},
			})
		}
	}

	// 排序依据：
	//   1. 采样点离目标的远近——采样点是网络上必须一致的公共约定，命不中别的都白搭
	//   2. 波特率误差（越小越好）
	//   3. 振荡器容差（越大越好）——这一项会自然选到 Phase_Seg1 与 Phase_Seg2 均衡的切分，
	//      而不是把 Prop_Seg 拉满、Phase_Seg1 压到 1（那样 SJW 只能取 1，容差最差）。
	//      注意容差是按「SJW 取到该组合的上限」算的，所以它反映的是该切分的容差**上限**。
	//   4. 传播段（越长越好，即同一容差下留更多总线延迟余量）
	//   5. BRP 越小越好（tq 越细，重同步分辨率越高）
	//
	// 总线较长、需要更大传播余量时，调用方应从候选里主动挑 propSeg 更大的那一组——
	// 那要拿总线长度与收发器延迟来定，本模块不替你假设。
	candidates.sort(
		(a, b) =>
			Math.abs(a.samplePointErrorPercent) - Math.abs(b.samplePointErrorPercent) ||
			Math.abs(a.bitrateErrorPpm) - Math.abs(b.bitrateErrorPpm) ||
			b.oscTolerancePercent - a.oscTolerancePercent ||
			b.propSeg - a.propSeg ||
			a.brp - b.brp,
	)

	if (candidates.length === 0) {
		warnings.push(
			`在给定约束下找不到任何组合：clock=${clockHz} Hz、bitrate=${bitrate} bit/s、` +
				`samplePoint=${(spTarget * 100).toFixed(2)}%、结构下限 NBT≥${structuralFloor} tq。` +
				'放宽 limits、换时钟，或改目标采样点。',
		)
	} else {
		const best = candidates[0]
		checks.push({
			name: '目标采样点是否可达（受 tq 分辨率限制）',
			pass: true,
			detail:
				`目标 ${(spTarget * 100).toFixed(3)}%，最接近可达 ${best.samplePointPercent.toFixed(3)}%` +
				`（偏差 ${Math.abs(best.samplePointErrorPercent).toFixed(3)}%，NBT=${best.nbt} tq，` +
				`分辨率 ${(100 / best.nbt).toFixed(3)}%）`,
		})
		if (Math.abs(best.samplePointErrorPercent) > 100 / best.nbt) {
			warnings.push('可达采样点与目标的偏差超过一个 tq 的分辨率，说明搜索空间被 limits 裁掉了太多。')
		}
	}

	notes.push(
		`共 ${candidates.length} 组候选；排序按「采样点偏差 → 波特率误差 → 振荡器容差 → 传播段 → BRP」。`,
	)
	notes.push(
		'寄存器字段是**功能值 − 1**（BRP/TSEG1/TSEG2/SJW 都是这个偏移）。' +
			'Freescale/NXP 命名里 TSEG1 = Prop_Seg + Phase_Seg1。' +
			'注意有些配置工具与分析仪直接显示**功能值**（不 −1），对齐参数时先确认是哪一套，否则会差 1。',
	)
	notes.push(
		'候选里 Prop_Seg 与 Phase_Seg1 的**切分**不影响采样点，但影响两件事：' +
			'Prop_Seg 决定能容忍的总线往返传播延迟（maxOneWayDelayUs）；' +
			'Phase_Seg1 参与振荡器容差并使 SJW 能取更大值。' +
			'本模块按容差优先排序（得到两者较均衡的切分）；总线很长时请自己挑 propSeg 更大的一组。',
	)
	notes.push(
		'振荡器容差按 **SJW 取到该组合上限**计算，是理论上限；SJW 取小值容差会同步变小（CiA 建议 SJW 尽量取大）。',
	)
	notes.push(
		'以上全是**设计值**。真实位宽、采样点位置、边沿抖动必须用示波器（CAN_H/CAN_L）实测确认——' +
			'尤其数据段，采样点附近往往正是振铃/反射区。',
	)

	return {
		clockHz,
		bitrate,
		samplePoint: spTarget,
		bitTimeNs,
		totalCycles,
		limitsProvided: limits !== undefined,
		candidates: candidates.slice(0, maxCandidates),
		totalCandidates: candidates.length,
		checks,
		warnings,
		notes,
	}
}

/**
 * 主入口：给定时钟 + 仲裁波特率 + 数据波特率，分别反算两段可用的位时序组合，并核对 BRS 切换点与 TDC。
 *
 * 两段**各自独立**求解：各自有 BRP/TSEG1/TSEG2/SJW，各自有采样点。
 *
 * @param {object} input - 输入。关键量必须由调用方给出。
 * @param {number} input.clockHz - CAN 控制器输入时钟（Hz）。
 * @param {number} input.arbitrationBitrate - 仲裁段波特率（bit/s）。
 * @param {number} input.dataBitrate - 数据段波特率（bit/s）。
 * @param {number} input.arbitrationSamplePoint - 仲裁段采样点目标（0~1）。**必须由调用方给**。
 * @param {number} input.dataSamplePoint - 数据段采样点目标（0~1）。**必须由调用方给**。
 * @param {object} [input.tdc] - 发送延迟补偿（TDC）配置。未提供时不做 TDC 判定并在 notes 里点名。
 * @param {boolean} [input.tdc.enabled] - 是否使能 TDC。
 * @param {number} [input.tdc.dataBrp] - 数据段 BRP 功能值（TDC 要求其寄存器值为 1 或 2 时有额外约束）。
 * @param {number} [input.tdc.sspOffsetTq] - SSP offset（最小时间量子数）。
 * @param {object} [input.limits] - 控制器寄存器范围（同时作用于两段）。
 * @param {object} [input.segmentLimits] - 分段覆盖：`{ arbitration: limits, data: limits }`。
 * @param {number} [input.maxCandidates] - 每段输出条数上限。
 * @returns {object} `{ checks, warnings, notes, arbitration, data, brsSwitch, ... }`。
 */
export function analyzeCanFdBitTiming({
	clockHz,
	arbitrationBitrate,
	dataBitrate,
	arbitrationSamplePoint,
	dataSamplePoint,
	tdc,
	limits,
	segmentLimits,
	maxCandidates = 8,
}) {
	if (!(clockHz > 0)) throw new Error('clock_hz 必须为正数（CAN 控制器输入时钟）')
	assertBitrate(arbitrationBitrate, 'arbitration_bitrate')
	assertBitrate(dataBitrate, 'data_bitrate')
	assertSamplePoint(arbitrationSamplePoint, 'arbitration_sample_point')
	assertSamplePoint(dataSamplePoint, 'data_sample_point')

	const checks = []
	const warnings = []
	const notes = []

	const arb = enumerateSegmentTiming({
		clockHz,
		bitrate: arbitrationBitrate,
		samplePoint: arbitrationSamplePoint,
		limits: segmentLimits?.arbitration ?? limits,
		maxCandidates,
	})
	const data = enumerateSegmentTiming({
		clockHz,
		bitrate: dataBitrate,
		samplePoint: dataSamplePoint,
		limits: segmentLimits?.data ?? limits,
		maxCandidates,
	})

	checks.push(...arb.checks.map(tagCheck('仲裁段')), ...data.checks.map(tagCheck('数据段')))
	warnings.push(
		...arb.warnings.map((w) => `[仲裁段] ${w}`),
		...data.warnings.map((w) => `[数据段] ${w}`),
	)

	// 两段是否共用同一个时钟域：FD 控制器通常两段共用 fCAN，但 tq 各自分频
	checks.push({
		name: '两段是否用同一控制器时钟',
		pass: true,
		detail: `两段都按 clock = ${clockHz} Hz 反算（BRP 各自独立，故 tq 可以不同）`,
	})

	// 数据段必须确实更快
	checks.push({
		name: '数据段波特率是否高于仲裁段',
		pass: dataBitrate > arbitrationBitrate,
		detail: `${dataBitrate} bit/s vs ${arbitrationBitrate} bit/s（比值 ${(dataBitrate / arbitrationBitrate).toFixed(3)}）`,
	})
	if (dataBitrate === arbitrationBitrate) {
		warnings.push(
			'两段波特率相同：这等价于 BRS 始终发显性，CAN FD 只带来更长载荷、没有速率收益。' +
				'确认这是有意为之（兼容旧节点）还是漏配。',
		)
	}

	// TDC 判定（CiA Rec. 6：数据波特率 > 1 Mbit/s 必须使能 TDC，且 BRPD 应为 1 或 2）
	if (tdc === undefined) {
		notes.push(
			'**未提供 tdc 配置**，因此没有检查发送延迟补偿。' +
				'CiA《Recommendation for the CAN FD bit-timing》Rec. 6 要求：数据波特率 > 1 Mbit/s 时必须使能 TDC，' +
				'且此时 BRPD 应设为 1 或 2（引 ISO 11898-1:2015）。请补上 tdc.enabled 再判定。',
		)
	} else {
		const tdcNeeded = dataBitrate > 1_000_000
		const pass = !tdcNeeded || tdc.enabled === true
		checks.push({
			name: '数据段 > 1 Mbit/s 时是否使能 TDC',
			pass,
			detail: `数据段 ${dataBitrate} bit/s（${tdcNeeded ? '需要' : '不强制需要'} TDC），tdc.enabled = ${tdc.enabled}`,
		})
		if (!pass) {
			warnings.push(
				`数据段 ${dataBitrate} bit/s 已超过 1 Mbit/s，但 tdc.enabled 不是 true。` +
					'后果很具体：数据段位时间短于收发器环路延迟时，发送方在采样点上读回自己的位会读到**上一位的值**，' +
					'从而误报位错误（Bit Error）、帧被打断并触发错误帧。' +
					'症状是「低速能通、一切到 2 Mbit/s 就报位错误」，而且随温度/批次漂移。' +
					'请使能 TDC 并用实测的发送延迟设置 SSP。',
			)
		}
		if (tdc.enabled === true && tdc.dataBrp !== undefined && tdc.dataBrp !== 1 && tdc.dataBrp !== 2) {
			warnings.push(
				`TDC 使能时数据段 BRPD 功能值为 ${tdc.dataBrp}，而 CiA Rec. 6 引 ISO 11898-1:2015 要求此时 BRPD 应设为 1 或 2。` +
					'BRPD 偏大时 TDC 的补偿分辨率会变粗，直接影响数据段相位裕量。',
			)
		}
		if (tdc.enabled === true && tdc.sspOffsetTq !== undefined && tdc.sspOffsetTq > 63) {
			warnings.push(
				`SSP offset 为 ${tdc.sspOffsetTq} 个最小时间量子，而 ISO 11898-1:2015 要求 SSP 配置范围**至少** 0~63。` +
					'超过 63 是否支持取决于控制器，且过大的 offset 会把二次采样点推到下一位，需实测确认。',
			)
		}
	}

	// 用两段的最优候选算 mixed bit
	const arbBest = arb.candidates[0] ?? null
	const dataBest = data.candidates[0] ?? null
	let brsSwitch = null
	if (arbBest && dataBest) {
		brsSwitch = brsSwitchTiming({
			arbitrationBitrate,
			dataBitrate,
			arbitrationSamplePoint: arbBest.samplePointPercent / 100,
			dataSamplePoint: dataBest.samplePointPercent / 100,
		})
		checks.push(...brsSwitch.checks.map(tagCheck('BRS 切换')))
		warnings.push(...brsSwitch.warnings.map((w) => `[BRS 切换] ${w}`))
		notes.push(...brsSwitch.notes)
	}

	notes.push(
		'**两段位时序各自独立**：BRP/TSEG1/TSEG2/SJW 各一套，tq 可以不同。上面两段的最优候选可以分别直接查寄存器。',
	)
	notes.push(
		'仲裁段采样点是「所有节点都能收对」的公共约定，网络上**必须一致**；' +
			'数据段采样点同样必须一致，且往往还要与主机厂规范一致（分析仪 / 测试用例会照这个判）。' +
			'两侧节点采样点差得太多会出现「与数据内容相关的偶发错误帧」，很难查。',
	)
	notes.push(
		'数据段相位裕量 PM1/PM2 需要实测的位不对称量 A1（显性位最长延长）、A2（显性位最长缩短）' +
			'带入 CiA 601-3 的方法计算。**本模块不重算相位裕量**——那需要收发器与拓扑的实测数据，' +
			'凭空给一个「看起来合理」的采样点或裕量是误导。',
	)
	notes.push(
		'以上全是**设计值**。请用示波器同时探 CAN_H/CAN_L 与控制器 TXD/RXD，量实际位宽、' +
			'BRS 位宽度（可由它反推两段采样点）与 SSP，再决定是否保留这组参数。',
	)

	return {
		clockHz,
		arbitrationBitrate,
		dataBitrate,
		arbitration: {
			bitrate: arbitrationBitrate,
			samplePointTarget: arbitrationSamplePoint,
			best: arbBest,
			candidates: arb.candidates,
			totalCandidates: arb.totalCandidates,
		},
		data: {
			bitrate: dataBitrate,
			samplePointTarget: dataSamplePoint,
			best: dataBest,
			candidates: data.candidates,
			totalCandidates: data.totalCandidates,
		},
		brsSwitch,
		tdcProvided: tdc !== undefined,
		checks,
		warnings,
		notes,
	}
}

/**
 * 校验一个数字是不是合法波特率，并返回该波特率对应的位时间（ns）。
 *
 * @param {number} value - 波特率（bit/s）。
 * @param {string} fieldName - 出错时点名的字段名。
 * @returns {number} 位时间（ns）。
 */
function assertBitrate(value, fieldName) {
	if (!(value > 0)) throw new Error(`${fieldName} 必须为正数（bit/s），收到 ${value}`)
	return 1e9 / value
}

/**
 * 校验采样点比例。
 *
 * @param {number} value - 采样点（0~1 的比例）。
 * @param {string} fieldName - 出错时点名的字段名。
 * @returns {number} 采样点比例。
 */
function assertSamplePoint(value, fieldName) {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		throw new Error(
			`缺少 ${fieldName}：采样点必须由调用方给出（0~1 的比例，例如 0.8 表示 80%）。` +
				'本模块不内置任何「惯例采样点」默认值——仲裁段与数据段的采样点都是设计决策，必须显式指定。',
		)
	}
	if (!(value > 0 && value < 1)) {
		throw new Error(`${fieldName} 必须是 0~1 之间（不含端点）的比例，收到 ${value}`)
	}
	return value
}

/**
 * 校验 DLC 取值。
 *
 * @param {number} dlc - DLC 值。
 */
function assertDlc(dlc) {
	if (!Number.isInteger(dlc) || dlc < 0 || dlc > 15) {
		throw new Error(`dlc 必须是 0~15 的整数（4 位字段），收到 ${dlc}`)
	}
}

/**
 * 给 checks 名称加段前缀，便于两段结果混在一个列表里区分。
 *
 * @param {string} prefix - 前缀。
 * @returns {(c: {name:string, pass:boolean, detail:string}) => object} 映射函数。
 */
function tagCheck(prefix) {
	return (c) => ({ name: `[${prefix}] ${c.name}`, pass: c.pass, detail: c.detail })
}

/**
 * 收掉浮点乘加的尾差（如 699.9999999999999 → 700），保留 6 位小数。
 *
 * @param {number} value - 原值。
 * @returns {number} 收拾后的值。
 */
function round6(value) {
	return Math.round(value * 1e6) / 1e6
}
