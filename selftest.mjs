/**
 * dsh-embedded-kit 自测 —— 不依赖 DSH 进程，纯 Node 直接跑。
 *
 *   node selftest.mjs
 *
 * 覆盖：
 *   1. Modbus CRC 的**已知答案向量**（01 03 00 00 00 0A → CRC 0xCDC5）
 *   2. 帧构建 / 审查 / 异常响应识别
 *   3. Keil `.map` 解析（用 testdata 里的样本，且交叉验证总量自洽）
 *   4. RS-485 时序计算（含 >19200 的固定静默值分支）
 *   5. 三个技能文件可加载且 frontmatter 已被剥离
 *   6. **端到端**：用假 ctx 真的调用 apply()，捕获 4 个工具 + 3 个技能
 *
 * 第 6 项特别重要 —— 它会真的执行 defineTool()，因此能验证 4 个工具的
 * 参数 schema 合法；同时也会真的执行 `import ... from '@deepseek-ai/dsh-tools'`，
 * 因此能验证裸导入解析路径（Node 需能从插件目录向上找到 my-DSH/node_modules）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

let passed = 0
/** @type {Array<{label: string, detail: string}>} */
const failures = []
/** 异步用例的收尾 Promise，汇总前必须全部 await 掉。 */
const pending = []

/**
 * 跑一条断言，同步与异步用例都支持。
 * @param {string} label - 用例名。
 * @param {() => void|Promise<void>} fn - 断言体。
 */
function test(label, fn) {
	/** @param {unknown} err */
	const finish = (err) => {
		if (err) {
			const detail = err instanceof Error ? err.message : String(err)
			failures.push({ label, detail })
			console.log(`  FAIL ${label}`)
			console.log(`       ${detail}`)
		} else {
			passed++
			console.log(`  ok   ${label}`)
		}
	}
	try {
		const result = fn()
		if (result && typeof result.then === 'function') {
			// 异步用例：错误必须在这里捕获，否则会变成未处理的 rejection。
			pending.push(result.then(() => finish(null), (e) => finish(e)))
			return
		}
		finish(null)
	} catch (error) {
		finish(error)
	}
}

/** 约等于断言（浮点用）。 */
function closeTo(actual, expected, tolerance, message) {
	assert.ok(
		Math.abs(actual - expected) <= tolerance,
		`${message ?? '数值不接近'}：期望 ${expected} ±${tolerance}，实际 ${actual}`,
	)
}

const near = (a, b, t = 1e-6) => Math.abs(a - b) <= t

console.log('\n== 1. 模块导入（同时验证裸导入解析） ==')
const mapfile = await import('./lib/mapfile.js')
const modbus = await import('./lib/modbus.js')
const rs485 = await import('./lib/rs485.js')
const skillsMod = await import('./lib/skills.js')
const elfMod = await import('./lib/elf.js')
const gnumapMod = await import('./lib/gnumap.js')
const crcMod = await import('./lib/crc.js')
const buildMod = await import('./lib/build.js')
const sizereportMod = await import('./lib/sizereport.js')
const plugin = await import('./lib/index.js')
const dshTools = await import('@deepseek-ai/dsh-tools')
test('@deepseek-ai/dsh-tools 裸导入可解析，且导出 defineTool', () => {
	assert.equal(typeof dshTools.defineTool, 'function')
})

console.log('\n== 2. Modbus CRC 已知答案向量 ==')
test('载荷 01 03 00 00 00 0A 的 CRC = 0xCDC5', () => {
	const crc = modbus.crc16Modbus(modbus.parseHex('01 03 00 00 00 0A'))
	assert.equal(crc, 0xcdc5)
})
test('buildFrame 产出 01 03 00 00 00 0A C5 CD（低字节先）', () => {
	const frame = modbus.buildFrame({ slave: 1, function: 3, data: [0, 0, 0, 10] })
	assert.equal(modbus.toHex(frame), '01 03 00 00 00 0A C5 CD')
})
test('verifyFrame 接受合法帧并翻译功能码', () => {
	const v = modbus.verifyFrame(modbus.parseHex('01 03 00 00 00 0A C5 CD'))
	assert.equal(v.valid, true)
	assert.equal(v.slave, 1)
	assert.match(v.functionName, /Read Holding Registers/)
})
test('verifyFrame 检出 CRC 被改动（低/高字节互换的典型错误）', () => {
	const v = modbus.verifyFrame(modbus.parseHex('01 03 00 00 00 0A CD C5'))
	assert.equal(v.valid, false)
	assert.match(v.reason, /CRC 不匹配/)
})
test('verifyFrame 识别异常响应（功能码最高位置 1）', () => {
	const payload = [0x01, 0x83, 0x02]
	const crc = modbus.crc16Modbus(payload)
	const frame = [...payload, crc & 0xff, (crc >>> 8) & 0xff]
	const v = modbus.verifyFrame(frame)
	assert.equal(v.valid, true)
	assert.equal(v.isException, true)
	assert.equal(v.exceptionCode, 2)
	assert.match(v.exceptionName, /非法数据地址/)
	assert.match(v.functionName, /Read Holding Registers/)
})
test('verifyFrame 拒绝过短的帧', () => {
	const v = modbus.verifyFrame([0x01, 0x03])
	assert.equal(v.valid, false)
	assert.match(v.reason, /最短合法帧/)
})
test('parseHex 拒绝奇数个十六进制字符', () => {
	assert.throws(() => modbus.parseHex('010'), /奇数/)
})

console.log('\n== 3. Keil .map 解析 ==')
const mapText = readFileSync(join(HERE, 'testdata', 'sample-keil.map'), 'utf8')
const parsed = mapfile.parseKeilMap(mapText)
test('识别为六列格式', () => {
	assert.equal(parsed.layout, 'six-column')
})
test('汇总行解析正确（RO 964 / RW 1156 / ROM 1008）', () => {
	assert.equal(parsed.totals.ro, 964)
	assert.equal(parsed.totals.rw, 1156)
	assert.equal(parsed.totals.rom, 1008)
})
test('得到 8 个成分：4 个 .o + 2 行链接器生成/填充 + 2 个库成员', () => {
	assert.equal(parsed.components.length, 8)
	const generated = parsed.components.filter((c) => c.generated === true)
	assert.equal(generated.length, 2, `generated 行数不对：${generated.map((c) => c.object).join(', ')}`)
})
test('聚合视图与小计行没有被当成目标文件', () => {
	const leaked = parsed.components.filter((c) => /totals/i.test(c.object) || c.object.endsWith('.l'))
	assert.deepEqual(leaked, [], `不该纳入的行混入了：${leaked.map((c) => c.object).join(', ')}`)
})
test('两类处理都被记进 notes（生成/填充计入、聚合视图排除）', () => {
	assert.equal(parsed.notes.length, 2)
	assert.ok(
		parsed.notes.some((n) => n.includes('生成/填充')),
		`notes 缺生成/填充说明：${parsed.notes.join(' | ')}`,
	)
	assert.ok(parsed.notes.some((n) => n.includes('聚合视图')), `notes 缺聚合视图说明：${parsed.notes.join(' | ')}`)
})
test('小计行被单独记录下来，可交叉验证', () => {
	assert.ok(parsed.subtotals['Object Totals'], '未记录 Object Totals')
	assert.ok(parsed.subtotals['Grand Totals'], '未记录 Grand Totals')
	assert.equal(parsed.subtotals['Grand Totals'].code, 560)
	assert.equal(parsed.subtotals['Object Totals'].code, 512)
})
test('列语义正确：startup 的 392 归为 RO Data（向量表）、1024 归为 ZI Data（栈）', () => {
	const startup = parsed.components.find((c) => c.object === 'startup_m031series.o')
	assert.ok(startup, '未找到 startup_m031series.o')
	assert.equal(startup.roData, 392)
	assert.equal(startup.ziData, 1024)
	assert.equal(startup.rwData, 0)
})
test('inc. data 被作为 code 的细分，不额外相加（逐项求和与 Keil 汇总完全一致）', () => {
	const report = mapfile.buildSizeReport(parsed)
	assert.equal(report.sumRom, 1008)
	assert.equal(report.sumRam, 1156)
	assert.equal(report.warnings.length, 0, `不该有警告，实际：${report.warnings.join(' | ')}`)
})
test('体积排序把向量表所在的 startup 排在首位（ROM 428）', () => {
	const report = mapfile.buildSizeReport(parsed, { topN: 2 })
	assert.equal(report.ranked[0].object, 'startup_m031series.o')
	assert.equal(report.ranked[0].rom, 428)
})
test('预算占用率计算正确（ROM 1008 / 预算 32768 = 3.08%）', () => {
	const report = mapfile.buildSizeReport(parsed, { romBudget: 32768, ramBudget: 4096 })
	assert.equal(report.romBudget.percent, 3.08)
	assert.equal(report.romBudget.headroom, 32768 - 1008)
	closeTo(report.ramBudget.percent, 28.22, 0.01)
})
test('总量不自洽时会发出交叉验证警告（不会静默采信）', () => {
	const broken = mapfile.parseKeilMap(mapText.replace('1008 (   0.98kB)', '9999 (   9.77kB)'))
	const report = mapfile.buildSizeReport(broken)
	assert.ok(
		report.warnings.some((w) => w.includes('交叉验证不一致')),
		`应发出交叉验证警告，实际警告：${report.warnings.join(' | ')}`,
	)
})
test('互等断言：sizereport 与 mapfile 的 ROM/RAM footprint 公式单源一致', () => {
	// sizereport.normalizeKeil 现在复用 mapfile.componentFootprint（此前两份独立实现无互等保证）。
	const normalized = sizereportMod.normalizeKeil(parsed)
	for (const [i, c] of parsed.components.entries()) {
		const fp = mapfile.componentFootprint(c)
		assert.equal(normalized.components[i].rom, fp.rom, `成分 ${c.object} 的 ROM 不一致`)
		assert.equal(normalized.components[i].ram, fp.ram, `成分 ${c.object} 的 RAM 不一致`)
	}
})

console.log('\n== 4. RS-485 时序 ==')
test('9600 / 8N1：10 位每字符，字符时间 1041.667µs', () => {
	const r = rs485.analyzeTiming({ baud: 9600, frameBytes: 8 })
	assert.equal(r.bitsPerChar, 10)
	closeTo(r.bitTimeUs, 104.167, 0.001)
	closeTo(r.charTimeUs, 1041.667, 0.001)
	closeTo(r.frameTimeUs, 8333.333, 0.001)
})
test('9600：按 1.5 / 3.5 字符时间算静默（1562.5 / 3645.833µs）', () => {
	const r = rs485.analyzeTiming({ baud: 9600 })
	assert.equal(r.modbus.usingFixedSilence, false)
	closeTo(r.modbus.t15Us, 1562.5, 0.001)
	closeTo(r.modbus.t35Us, 3645.833, 0.001)
})
test('115200：波特率 > 19200 时套用固定静默值 750 / 1750µs', () => {
	const r = rs485.analyzeTiming({ baud: 115200 })
	assert.equal(r.modbus.usingFixedSilence, true)
	assert.equal(r.modbus.t15Us, 750)
	assert.equal(r.modbus.t35Us, 1750)
})
test('8E1 的字符位数为 11', () => {
	const r = rs485.analyzeTiming({ baud: 9600, parity: 'even' })
	assert.equal(r.bitsPerChar, 11)
})
test('未提供收发器参数时列入 pending，且不编造数值', () => {
	const r = rs485.analyzeTiming({ baud: 9600 })
	assert.equal(r.turnaround.driverEnableUs, 0)
	assert.equal(r.turnaround.driverDisableUs, 0)
	assert.equal(r.pending.length, 2)
})
test('提供收发器参数后合成切换窗口；关闭耗时是否装得进 t3.5 静默', () => {
	const r = rs485.analyzeTiming({ baud: 9600, driverEnableNs: 500, driverDisableNs: 500 })
	closeTo(r.turnaround.driverEnableUs, 0.5, 1e-9)
	closeTo(r.turnaround.busOccupancyUs, 8334.333, 0.01)
	// 关闭 0.5µs ≪ t3.5 3645.8µs → 装得进。
	assert.equal(r.turnaround.disableFitsInSilence, true)
	assert.equal(r.turnaround.leadTimeNeededUs, 0.5)
	assert.equal(r.pending.length, 0)
})
test('驱动关闭慢于 t3.5 时 disableFitsInSilence 为 false（会吃掉帧间静默）', () => {
	const r = rs485.analyzeTiming({ baud: 115200, driverDisableNs: 2000 * 1000 })
	assert.equal(r.turnaround.disableFitsInSilence, false)
})

console.log('\n== 5. 技能文件加载 ==')
for (const skillName of skillsMod.SKILL_NAMES) {
	test(`技能 ${skillName} 可加载且 frontmatter 已剥离`, () => {
		const s = skillsMod.loadSkill(skillName)
		assert.ok(s.description.length > 10, 'description 过短')
		assert.ok(s.content.length > 800, `正文过短（${s.content.length} 字符）`)
		assert.ok(!s.content.startsWith('---'), '正文不应包含 frontmatter 分隔线')
		assert.ok(s.name === skillName, 'name 应与目录名一致')
	})
}

console.log('\n== 6. 通用 CRC 标准测试向量 ==')
// 对 ASCII "123456789" 的校验值在 CRC 社区是公开公认值（check value）。
// 用它验证实现，而不是"我算了一遍觉得对"。
const check123 = Array.from('123456789').map((c) => c.charCodeAt(0))
for (const presetName of crcMod.PRESET_NAMES) {
	const expected = crcMod.CHECK_VALUES[presetName]
	if (expected === undefined) continue
	test(`${presetName} = 0x${expected.toString(16).toUpperCase()}`, () => {
		assert.equal(crcMod.computePreset(check123, presetName), expected)
	})
}
test('自定义 CRC 参数可算出与预设一致的结果（crc16-modbus 手写参数）', () => {
	const custom = crcMod.computeCheck(check123, {
		width: 16,
		poly: 0x8005,
		init: 0xffff,
		refin: true,
		refout: true,
		xorout: 0,
	})
	assert.equal(custom, crcMod.CHECK_VALUES['crc16-modbus'])
})
test('校验值可按低/高字节先两种顺序上线', () => {
	assert.deepEqual(crcMod.checkBytesLE(0x1234, 16), [0x34, 0x12])
	assert.deepEqual(crcMod.checkBytesBE(0x1234, 16), [0x12, 0x34])
})
test('未知预设名会报错并列出可用项', () => {
	assert.throws(() => crcMod.computePreset(check123, 'nope'), /未知校验预设/)
})
test('互等断言：modbus.crc16Modbus 特化实现 ≡ crc.js 参数化预设（任意一侧改动必须同步）', () => {
	// 两套实现（modbus.js 右移 0xA001 特化 vs crc.js 参数化引擎）数学上应等价；
	// 此前没有断言保证持续互等，任一侧改动只能靠各自向量单独发现。
	const samples = [
		check123,
		[0x01, 0x03, 0x00, 0x00, 0x00, 0x0a],
		[],
		[0x00],
		[0xff, 0xff, 0xff],
		Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff),
	]
	for (const s of samples) {
		assert.equal(
			modbus.crc16Modbus(s),
			crcMod.computePreset(s, 'crc16-modbus'),
			`载荷 ${JSON.stringify(s.slice(0, 8))}... 两套实现结果不一致`,
		)
	}
})

console.log('\n== 7. ELF 解析（ARM Cortex-M0 真实产物） ==')
const armElfPath = join(HERE, 'testdata', 'smoke', 'arm-cm0.elf')
const armMapPath = join(HERE, 'testdata', 'smoke', 'arm-cm0.map')
const rvElfPath = join(HERE, 'testdata', 'smoke', 'riscv.elf')
const rvMapPath = join(HERE, 'testdata', 'smoke', 'riscv.map')

/** 用与工具相同的入口分析一个文件。 */
async function analyzeFile(path, options = {}) {
	const buffer = readFileSync(path)
	const { decodeLog } = await import('./lib/keil.js')
	return sizereportMod.analyzeBuffer(buffer, decodeLog(buffer), { source: path, topN: 5, ...options })
}

const armElf = await analyzeFile(armElfPath)
const armMap = await analyzeFile(armMapPath)

test('ELF 被自动识别，架构解析为 ARM', () => {
	assert.equal(armElf.format, 'elf')
	assert.match(armElf.arch, /ARM/)
})
test('ELF 四项明细与链接脚本独立推算值一致（ro 64 / rw 4 / zi 580）', () => {
	// 期望值由 testdata/smoke 的源码与 link.ld 独立算出，不是从解析器输出抄的。
	assert.equal(armElf.totals.roData, 64) // .isr_vector 8×4 + .rodata 16×2
	assert.equal(armElf.totals.rwData, 4) // g_counter
	assert.equal(armElf.totals.ziData, 580) // .bss 68 + 堆栈预留 0x200
})
test('ELF 口径自洽：ROM = code+ro+rw，RAM = rw+zi', () => {
	assert.equal(armElf.totals.rom, armElf.totals.code + armElf.totals.roData + armElf.totals.rwData)
	assert.equal(armElf.totals.ram, armElf.totals.rwData + armElf.totals.ziData)
})
test('ELF 不需要交叉校验（节区头本身即权威源），如实标注而非假装校验', () => {
	assert.equal(armElf.crossCheck.passed, null)
	assert.match(armElf.crossCheck.detail, /无需交叉校验|权威来源/)
})

// 直接用解析器做断言（避免把完整符号表塞进工具输出里，那对大工程会是巨量文本）。
const armElfParsed = elfMod.parseElf(readFileSync(armElfPath))

test('节区尺寸 == arm-none-eabi-size 的实测捕获值（回归保护，非活调用）', () => {
	// 真值来自 `arm-none-eabi-size -A -d arm-cm0.elf` 的实测输出：
	//   .isr_vector 32 / .text 48 / .rodata 32 / .data 4 / .bss 68 / ._user_heap_stack 512
	//   另有 .comment 126 / .ARM.attributes 49（非 SHF_ALLOC，不应计入）
	const secs = Object.fromEntries(armElfParsed.sections.map((s) => [s.name, s.size]))
	assert.equal(secs['.isr_vector'], 32)
	assert.equal(secs['.text'], 48)
	assert.equal(secs['.rodata'], 32)
	assert.equal(secs['.data'], 4)
	assert.equal(secs['.bss'], 68)
	assert.equal(secs['._user_heap_stack'], 512)
	assert.equal(secs['.comment'], undefined, '.comment 不应计入（非 SHF_ALLOC）')
	assert.equal(secs['.ARM.attributes'], undefined, '.ARM.attributes 不应计入（非 SHF_ALLOC）')
})

test('体积排序粒度是符号级（不是段级）—— 段名对优化没有可操作性', () => {
	assert.equal(armElf.granularity, 'symbol')
	assert.ok(!armElf.top.some((c) => c.object.startsWith('.text')), '不应以段名作为体积大户')
})

test('符号提取 == nm --size-sort 的实测捕获值（回归保护，非活调用）', () => {
	// 口径说明（避免误解）：真值由 2026-09-18 用
	// `arm-none-eabi-nm --print-size --size-sort --radix=d` **实际跑出来并抄进来的常量**。
	// 本用例的作用是防止解析器日后回归，它**不会**再次调用外部工具。
	// 另两条活验证在 tools/verify-size.mjs 与 tools/verify-real-map.mjs：
	// 前者用 ELF 与 GNU map 两条独立解析路径互证（每次运行都重新解析真实产物），
	// 后者与 Keil 自己打印的 Total 行比对（每次运行都重新读真实 map）。
	// 真值来自 `arm-none-eabi-nm --print-size --size-sort --radix=d arm-cm0.elf`：
	//   g_counter D 4 / g_overruns B 4 / g_crc_table R 32 / g_vectors R 32
	//   Reset_Handler T 48 / g_rx_buf B 64
	const got = Object.fromEntries(armElfParsed.symbols.map((s) => [s.name, s.size]))
	assert.deepEqual(got, {
		g_counter: 4,
		g_overruns: 4,
		g_crc_table: 32,
		g_vectors: 32,
		Reset_Handler: 48,
		g_rx_buf: 64,
	})
})

test('符号按节区正确归类（B→ZI / T→Code / R→RO / D→RW）', () => {
	const kind = Object.fromEntries(armElfParsed.symbols.map((s) => [s.name, s.kind]))
	assert.equal(kind.g_rx_buf, 'ziData') // .bss
	assert.equal(kind.g_overruns, 'ziData') // .bss
	assert.equal(kind.Reset_Handler, 'code') // .text
	assert.equal(kind.g_crc_table, 'roData') // .rodata
	assert.equal(kind.g_vectors, 'roData') // .isr_vector
	assert.equal(kind.g_counter, 'rwData') // .data
})

test('符号按大小降序：g_rx_buf(64) > Reset_Handler(48) > g_crc_table(32)', () => {
	assert.equal(armElfParsed.symbols[0].name, 'g_rx_buf')
	assert.equal(armElfParsed.symbols[0].size, 64)
	assert.equal(armElfParsed.symbols[1].name, 'Reset_Handler')
	assert.equal(armElfParsed.symbols[1].size, 48)
})

test('符号求和与节区合计的差额被如实解释（对齐填充 + 无符号区域）', () => {
	assert.ok(
		armElf.notes.some((n) => n.includes('对齐填充与无符号区域')),
		`说明里应解释差额来源：${armElf.notes.join(' | ')}`,
	)
})

console.log('\n== 8. GNU ld map 解析 + 跨格式互证（最强判据） ==')
test('GNU map 被自动识别', () => {
	assert.equal(armMap.format, 'gnu-map')
})
test('解析出 FLASH(不可写) 与 RAM(可写) 两个区域', () => {
	const flash = armMap.memoryRegions.find((r) => r.name === 'FLASH')
	const ram = armMap.memoryRegions.find((r) => r.name === 'RAM')
	assert.ok(flash && ram, '缺少 FLASH 或 RAM 区域')
	assert.equal(flash.writable, false)
	assert.equal(ram.writable, true)
})
test('ROM / RAM 与 ELF 解析结果完全一致（两个独立解析器互证）', () => {
	assert.equal(armMap.totals.rom, armElf.totals.rom)
	assert.equal(armMap.totals.ram, armElf.totals.ram)
})
test('四项明细也与 ELF 完全一致（code/ro/rw/zi 逐项相同）', () => {
	assert.equal(armMap.totals.code, armElf.totals.code)
	assert.equal(armMap.totals.roData, armElf.totals.roData)
	assert.equal(armMap.totals.rwData, armElf.totals.rwData)
	assert.equal(armMap.totals.ziData, armElf.totals.ziData)
})
test('换行形式的段（._user_heap_stack）被正确解析，512 字节预留计入 RAM', () => {
	// 该段在 map 里段名单独占一行，地址在下一行 —— 只认单行格式会整段漏掉。
	assert.ok(
		armMap.top.some((c) => c.object === '._user_heap_stack') ||
			armMap.totals.ziData >= 580,
		`ZI 应包含 512 字节预留，实际 ziData=${armMap.totals.ziData}`,
	)
	assert.ok(armMap.totals.ziData >= 512, `ziData 应 ≥512，实际 ${armMap.totals.ziData}`)
})
test('未分配段（.comment / .ARM.attributes）被排除，未虚增 RO Data', () => {
	// 这两个段的 VMA 是 0x0，不属于任何 MEMORY 区域，不烧进芯片。
	assert.ok(armMap.notes.some((n) => n.includes('不属于任何 MEMORY 区域')), `说明里应提到排除：${armMap.notes.join(' | ')}`)
	assert.equal(armMap.totals.roData, 64, 'RO Data 不应包含 .comment 的 126 字节')
})

console.log('\n== 9. 跨架构一致性（RISC-V RV32） ==')
const rvElf = await analyzeFile(rvElfPath)
const rvMap = await analyzeFile(rvMapPath)
test('RISC-V ELF 架构被正确识别', () => {
	assert.match(rvElf.arch, /RISC-V/)
})
test('RISC-V 跨格式一致（map 与 ELF 的 ROM/RAM 相同）', () => {
	assert.equal(rvMap.totals.rom, rvElf.totals.rom)
	assert.equal(rvMap.totals.ram, rvElf.totals.ram)
})
test('数据部分与架构无关：ARM 与 RISC-V 的 ro/rw/zi 完全相同', () => {
	assert.equal(rvElf.totals.roData, armElf.totals.roData)
	assert.equal(rvElf.totals.rwData, armElf.totals.rwData)
	assert.equal(rvElf.totals.ziData, armElf.totals.ziData)
})
test('代码长度随 ISA 不同（证明真的读到了各自的目标码）', () => {
	assert.ok(rvElf.totals.code > 0 && armElf.totals.code > 0)
	assert.notEqual(rvElf.totals.code, armElf.totals.code)
})

console.log('\n== 10. 格式识别与防误用 ==')
test('ELF 与两种 map 的格式识别互不混淆', () => {
	assert.equal(sizereportMod.detectFormat(readFileSync(armElfPath), ''), 'elf')
	assert.equal(sizereportMod.detectFormat(Buffer.from('x'), 'Image component sizes'), 'keil-map')
	assert.equal(sizereportMod.detectFormat(Buffer.from('x'), 'Memory Configuration\nFLASH 0x0 0x100 xr'), 'gnu-map')
	assert.equal(sizereportMod.detectFormat(Buffer.from('x'), 'nothing here'), 'unknown')
})
test('显式指定的格式与内容矛盾时报错，而不是硬按用户说的解析', () => {
	assert.throws(() => {
		const buffer = readFileSync(armElfPath)
		sizereportMod.analyzeBuffer(buffer, { text: '', encoding: 'utf-8' }, { format: 'keil-map' })
	}, /内容特征更像/)
})

console.log('\n== 11. 多工具链构建后端 ==')
test('后端清单包含 keil / platformio / cmake / make / idf / iar / custom', () => {
	assert.deepEqual(
		buildMod.TOOLCHAIN_IDS.sort(),
		['cmake', 'custom', 'iar', 'idf', 'keil', 'make', 'platformio'].sort(),
	)
})
test('probeToolchains 不抛错并返回每个后端的可用性（可实测事实）', () => {
	const probes = buildMod.probeToolchains({})
	assert.equal(probes.length, buildMod.TOOLCHAIN_IDS.length)
	for (const p of probes) {
		assert.equal(typeof p.available, 'boolean')
		assert.equal(typeof p.verified, 'boolean')
	}
})
test('全部后端的 verified 都是 false（未在真实工程验证，不虚报）', () => {
	const probes = buildMod.probeToolchains({})
	assert.equal(probes.filter((p) => p.verified).length, 0)
})
test('未知工具链会报错并列出可用项', async () => {
	await assert.rejects(() => buildMod.runBuild({ toolchain: 'nope' }, {}), /未知工具链/)
})
test('通用日志解析兼容 GCC / Keil / IAR / MSVC 四种措辞', () => {
	const log = [
		'src/main.c:42:5: error: use of undeclared identifier \'x\'',
		'..\\src\\spi.c(88): error:  #20: identifier "y" is undefined',
		'Error[Pe020]: identifier "z" is undefined',
		'error C1234: something failed',
		'src/a.c:7:2: warning: unused variable \'w\'',
		'"proj.uvprojx" - 1 Error(s), 1 Warning(s).',
	].join('\n')
	const parsed = buildMod.parseToolchainLog(log)
	assert.ok(parsed.summary, '应解析出 Keil 的官方结论行')
	assert.equal(parsed.summary.errors, 1)
	assert.ok(parsed.counts.errors >= 3, `应至少识别 3 类错误措辞，实际 ${parsed.counts.errors}`)
	assert.ok(parsed.counts.warnings >= 1)
})

console.log('\n== 12. 引脚漏电与电平冲突（leak_pin 的物理判据） ==')
const leakMod = await import('./lib/leakage.js')

test('经典漏电：内部上拉 + 外部 CMOS 推挽输出低 → 判定漏电，电流 = VDD/Rpu', () => {
	const r = leakMod.analyzePin({
		pin: 'PA1',
		mcu_mode: 'input-pullup',
		external_kind: 'cmos-pushpull',
		external_level: 'low',
		vdd: 3.3,
		pull_ohm: 40000,
	})
	assert.equal(r.hasFault, true)
	assert.equal(r.severity, 'medium')
	assert.ok(r.findings.some((f) => f.kind === 'mcu-pullup-vs-external-low'))
	// 3.3 V ÷ 40 kΩ = 82.5 µA
	assert.equal(r.currentUa, 82.5)
})
test('同向不构成漏电：开漏总线高阻态 + 内部上拉（这是开漏的正确用法）', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'open-drain',
		external_level: 'highz',
		vdd: 3.3,
		pull_ohm: 40000,
	})
	assert.equal(r.hasFault, false)
})
test('开漏拉低 + 内部上拉 → 仍然漏电（与 CMOS 低同理）', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'open-drain',
		external_level: 'low',
		vdd: 3.3,
		pull_ohm: 40000,
	})
	assert.equal(r.hasFault, true)
	assert.equal(r.currentUa, 82.5)
})
test('推挽对推挽方向相反 → 判为短路冲突，严重度高', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'output-pushpull',
		mcu_level: 'high',
		external_kind: 'cmos-pushpull',
		external_level: 'low',
		vdd: 3.3,
	})
	assert.equal(r.hasFault, true)
	assert.equal(r.severity, 'high')
	assert.ok(r.findings.some((f) => f.kind === 'pushpull-vs-pushpull'))
})
test('悬空输入 → 判为电平不确定，但不编造电流值', () => {
	const r = leakMod.analyzePin({ mcu_mode: 'input-floating', external_kind: 'none', vdd: 3.3 })
	assert.equal(r.hasFault, true)
	assert.ok(r.findings.some((f) => f.kind === 'floating-input'))
	assert.equal(r.currentUa, null, '缺少电阻数据时不应给出电流数值')
	assert.match(r.currentBasis, /未估算/)
})
test('缺 vdd/pull_ohm 时：通路确定但电流不估算（不拿假数据凑数）', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'cmos-pushpull',
		external_level: 'low',
	})
	assert.equal(r.hasFault, true, '通路必须判定')
	assert.equal(r.currentUa, null)
	assert.match(r.currentBasis, /未估算/)
})
test('内外部上下拉打架 → 识别分压漏电', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'passive-to-gnd',
		vdd: 3.3,
		pull_ohm: 40000,
		external_r_ohm: 10000,
	})
	assert.equal(r.hasFault, true)
	assert.ok(r.findings.some((f) => f.kind === 'mcu-pullup-vs-external-pulldown'))
	// 3.3 V ÷ (40k + 10k) = 66 µA
	assert.equal(r.currentUa, 66)
})
test('批量分析汇总：总计与最严重度正确', () => {
	const rep = leakMod.analyzePins(
		[
			{ mcu_mode: 'input-pullup', external_kind: 'cmos-pushpull', external_level: 'low' },
			{ mcu_mode: 'output-pushpull', mcu_level: 'low', external_kind: 'cmos-pushpull', external_level: 'high' },
			{ mcu_mode: 'input-pulldown', external_kind: 'none' },
		],
		{ vdd: 3.3, pull_ohm: 40000 },
	)
	assert.equal(rep.pinCount, 3)
	assert.equal(rep.faultyCount, 2)
	assert.equal(rep.worstSeverity, 'high')
	assert.equal(rep.totalEstimatedUa, 82.5, '只有第一个能算出数值')
})
test('推挽输出高 + 无源下拉电阻：不是短路，只报偏置电流（低严重度）', () => {
	// 回归用例：无源电阻是限流元件不是对打的驱动器，误报"短路"会严重误导排查。
	const r = leakMod.analyzePin({
		pin: 'PA8',
		mcu_mode: 'output-pushpull',
		mcu_level: 'high',
		external_kind: 'passive-to-gnd',
		external_level: 'low',
		external_r_ohm: 10000,
		vdd: 3.3,
	})
	assert.equal(r.severity, 'low', '推挽高 + 下拉电阻只是持续偏置电流，不是短路')
	assert.ok(!r.findings.some((f) => f.kind === 'pushpull-vs-pushpull'), '不得误报短路')
	assert.ok(r.findings.some((f) => f.kind === 'output-high-into-pulldown'))
})
test('推挽输出低 + 无源上拉电阻：对称情况同样不误报短路', () => {
	const r = leakMod.analyzePin({
		pin: 'PA9',
		mcu_mode: 'output-pushpull',
		mcu_level: 'low',
		external_kind: 'passive-to-vdd',
		external_level: 'high',
		external_r_ohm: 4700,
		vdd: 3.3,
	})
	assert.ok(!r.findings.some((f) => f.kind === 'pushpull-vs-pushpull'))
	assert.ok(r.findings.some((f) => f.kind === 'output-low-into-pullup'))
})
test('闭合开关与推挽对打仍是真短路（不得因修复而漏报）', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'output-pushpull',
		mcu_level: 'high',
		external_kind: 'switch-to-gnd',
		external_level: 'low',
		vdd: 3.3,
	})
	assert.equal(r.severity, 'high')
	assert.ok(r.findings.some((f) => f.kind === 'pushpull-vs-pushpull'))
})

console.log('\n== 13. 调度可行性分析 ==')
const schedMod = await import('./lib/sched.js')

test('占用率与节拍碰撞：最重的一拍可算且跑得完', () => {
	const r = schedMod.analyzeSchedule({
		mode: 'cooperative-tick',
		tick_us: 1000,
		tasks: [
			{ name: 'A', period_us: 1000, exec_us: 50 },
			{ name: 'B', period_us: 5000, exec_us: 200 },
			{ name: 'C', period_us: 10000, exec_us: 400 },
		],
	})
	// 50/1000 + 200/5000 + 400/10000 = 0.13
	assert.equal(r.totalUtilization, 0.13)
	assert.equal(r.verdict, 'ok')
	// 节拍数 1 / 5 / 10 → 最小公倍数 10 拍
	assert.equal(r.collisions.cycleTicks, 10)
	// 第 0 拍三个任务同时到期：50 + 200 + 400 = 650 µs
	assert.equal(r.collisions.peakTick, 0)
	assert.equal(r.collisions.peakLoadUs, 650)
	assert.equal(r.collisions.peakFitsInTick, true)
})
test('同一拍上排在后面的任务，最坏等待 = 前面任务执行时间之和', () => {
	const r = schedMod.analyzeSchedule({
		mode: 'cooperative-tick',
		tick_us: 1000,
		tasks: [
			{ name: 'A', period_us: 1000, exec_us: 50 },
			{ name: 'B', period_us: 5000, exec_us: 200 },
			{ name: 'C', period_us: 10000, exec_us: 400 },
		],
	})
	const w = Object.fromEntries(r.collisions.worstWaitByTask.map((x) => [x.name, x.worstWaitUs]))
	assert.equal(w.A, 0) // 最高优先级，不等待
	assert.equal(w.B, 50) // 等 A
	assert.equal(w.C, 250) // 等 A + B
})
test('占用率超 100% → 判为排不下，并给出警告', () => {
	const r = schedMod.analyzeSchedule({
		tick_us: 1000,
		tasks: [
			{ name: 'X', period_us: 1000, exec_us: 700 },
			{ name: 'Y', period_us: 2000, exec_us: 900 },
		],
	})
	assert.equal(r.totalUtilization, 1.15)
	assert.equal(r.verdict, 'overload')
	assert.ok(r.warnings.some((w) => w.includes('超过 100%')))
})
test('最重的一拍跑不完 → 明确报警（这是节拍驱动的生死线）', () => {
	const r = schedMod.analyzeSchedule({
		tick_us: 100,
		tasks: [
			{ name: 'A', period_us: 100, exec_us: 60 },
			{ name: 'B', period_us: 200, exec_us: 60 },
		],
	})
	// 第 0 拍 A+B 同时到期 = 120 µs > 100 µs
	assert.equal(r.collisions.peakLoadUs, 120)
	assert.equal(r.collisions.peakFitsInTick, false)
	assert.ok(r.warnings.some((w) => w.includes('跑不完')))
})
test('周期不是节拍整数倍 → 报出量化误差（2.5 拍进为 3 拍）', () => {
	const r = schedMod.analyzeSchedule({
		tick_us: 1000,
		tasks: [{ name: 'A', period_us: 3000, exec_us: 100 }, { name: 'B', period_us: 2500, exec_us: 100 }],
	})
	const b = r.tickResolvability.find((x) => x.name === 'B')
	assert.equal(b.ticksPerPeriodExact, 2.5)
	assert.equal(b.ticksPerPeriod, 3, '2.5 拍按四舍五入进为 3 拍')
	assert.equal(b.actualPeriodUs, 3000)
	assert.equal(b.errorUs, 500)
})
test('执行时间超过周期 → 提前警告该任务永不按时完成', () => {
	const r = schedMod.analyzeSchedule({ tick_us: 1000, tasks: [{ name: 'A', period_us: 1000, exec_us: 1500 }] })
	assert.ok(r.warnings.some((w) => w.includes('永远无法按时完成')))
})

console.log('\n== 14. 功耗预算 ==')
const powerMod = await import('./lib/power.js')

test('按占空比加权：5000µA×1% + 20µA×99% = 69.8µA', () => {
	const r = powerMod.computePowerBudget({
		modes: [
			{ name: 'Run', current_ua: 5000, duty_percent: 1 },
			{ name: 'Sleep', current_ua: 20, duty_percent: 99 },
		],
	})
	assert.equal(r.averageUa, 69.8)
	assert.equal(r.method, 'duty-percent')
})
test('按绝对时长加权：同一组数据应得到相同结果', () => {
	const r = powerMod.computePowerBudget({
		modes: [
			{ name: 'Run', current_ua: 5000, duration_us: 10 },
			{ name: 'Sleep', current_ua: 20, duration_us: 990 },
		],
	})
	assert.equal(r.averageUa, 69.8)
	assert.equal(r.method, 'absolute-duration')
})
test('电池寿命：1000mAh × 0.8 ÷ 69.8µA ≈ 11461.32 小时', () => {
	const r = powerMod.computePowerBudget({
		modes: [
			{ name: 'Run', current_ua: 5000, duty_percent: 1 },
			{ name: 'Sleep', current_ua: 20, duty_percent: 99 },
		],
		battery_mah: 1000,
		battery_derating: 0.8,
	})
	assert.equal(r.batteryLife.hours, 11461.32)
	assert.equal(r.batteryLife.usableMah, 800)
})
test('常驻漏电叠加进平均电流，并指出它是硬地板', () => {
	const r = powerMod.computePowerBudget({
		modes: [{ name: 'Sleep', current_ua: 20, duty_percent: 100 }],
		sleep_leak_ua: 80,
	})
	assert.equal(r.averageUa, 100)
	assert.ok(r.notes.some((n) => n.includes('硬地板')))
})
test('占空比之和超 100% → 报警（说明输入有误）', () => {
	const r = powerMod.computePowerBudget({
		modes: [
			{ name: 'A', current_ua: 100, duty_percent: 60 },
			{ name: 'B', current_ua: 100, duty_percent: 60 },
		],
	})
	assert.ok(r.warnings.some((w) => w.includes('100%')))
})
test('缺 current_ua → 明确报错而不是静默 NaN 污染全部输出（回归用例）', () => {
	assert.throws(
		() => powerMod.computePowerBudget({ modes: [{ name: 'Run', duty_percent: 100 }] }),
		/缺少 current_ua/,
	)
})
test('负电流 → 提醒（通常是笔误）而不是静默接受', () => {
	const r = powerMod.computePowerBudget({ modes: [{ name: 'X', current_ua: -50, duty_percent: 100 }] })
	assert.ok(r.warnings.some((w) => w.includes('负值')))
})

console.log('\n== 16. 内部上下拉电阻的范围（数据手册给 min/typ/max） ==')
test('同时给 min 与 typ 时：最坏情况用 min 电阻，另给典型值', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'cmos-pushpull',
		external_level: 'low',
		vdd: 3.3,
		pull_ohm_min: 30000,
		pull_ohm_typ: 40000,
		pull_ohm_max: 50000,
	})
	// 最坏情况取 min 电阻 = 最大电流：3.3 / 30k = 110 µA
	assert.equal(r.currentUa, 110)
	// 典型值：3.3 / 40k = 82.5 µA
	assert.equal(r.currentTypUa, 82.5)
	assert.match(r.resistanceBasis, /min 30000 Ω/)
})
test('只给单一电阻值时会提示"数据手册通常给范围"（避免只报典型值而低估）', () => {
	const r = leakMod.analyzePin({
		mcu_mode: 'input-pullup',
		external_kind: 'cmos-pushpull',
		external_level: 'low',
		vdd: 3.3,
		pull_ohm: 40000,
	})
	assert.match(r.resistanceBasis, /最坏情况应按 min 电阻计/)
})
test('批量分析同时给出最坏与典型合计', () => {
	const rep = leakMod.analyzePins(
		[
			{ mcu_mode: 'input-pullup', external_kind: 'cmos-pushpull', external_level: 'low' },
			{ mcu_mode: 'input-pulldown', external_kind: 'cmos-pushpull', external_level: 'high' },
		],
		{ vdd: 3.3, pull_ohm_min: 30000, pull_ohm_typ: 40000 },
	)
	assert.equal(rep.totalEstimatedUa, 220) // 2 × 110
	assert.equal(rep.totalTypUa, 165) // 2 × 82.5
})

console.log('\n== 17. ADC 输入负载与采样功耗 ==')
const adcMod = await import('./lib/adc.js')

test('采样电荷转移电流 = f × C_sample × Vref × 通道数', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 10000,
		c_sample_pf: 8,
		r_adc_ohm: 1000,
		source_r_ohm: 10000,
		sample_time_ns: 1500,
	})
	// 10000 Hz × 8 pF × 3.3 V = 0.264 µA
	assert.equal(r.chargeCurrentUa, 0.264)
})
test('采样率翻倍，电荷转移电流也翻倍（线性）', () => {
	const r = adcMod.analyzeAdcLoad({ v_ref: 3.3, resolution_bits: 12, sample_rate_hz: 20000, c_sample_pf: 8 })
	assert.equal(r.chargeCurrentUa, 0.528)
})
test('τ 与所需建立时间：τ = (R_source + R_ADC) × C_sample', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 10000,
		c_sample_pf: 8,
		r_adc_ohm: 1000,
		source_r_ohm: 10000,
		sample_time_ns: 1500,
	})
	// (10000 + 1000) Ω × 8 pF = 88 ns
	assert.equal(r.settling.tauNs, 88)
	// 12 位需 (12+1)·ln2 ≈ 9.0109 τ → 88 × 9.0109 ≈ 792.96 ns
	assert.ok(Math.abs(r.settling.requiredSettleNs - 792.96) < 0.01, `实际 ${r.settling.requiredSettleNs}`)
	assert.equal(r.settling.sourceWithinLimit, true)
})
test('源阻抗上限随采样窗口与分辨率变化（12 位 / 1500ns / 8pF ≈ 19.8kΩ）', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 10000,
		c_sample_pf: 8,
		r_adc_ohm: 1000,
		source_r_ohm: 10000,
		sample_time_ns: 1500,
	})
	assert.ok(
		r.settling.maxSourceROhm > 19000 && r.settling.maxSourceROhm < 20500,
		`应在 19k~20.5k 之间，实际 ${r.settling.maxSourceROhm}`,
	)
})
test('源阻抗超上限 → 警告"读数会偏低且非线性"（比功耗更致命）', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 10000,
		c_sample_pf: 8,
		r_adc_ohm: 1000,
		source_r_ohm: 200000,
		sample_time_ns: 1500,
	})
	assert.equal(r.settling.sourceWithinLimit, false)
	assert.ok(r.warnings.some((w) => w.includes('偏低且非线性')))
})
test('分压网络常态电流：3.3V / (100k + 100k) = 16.5 µA', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 100,
		dividers: [{ name: '电池分压', r_top_ohm: 100000, r_bottom_ohm: 100000 }],
	})
	assert.equal(r.staticLoadUa, 16.5)
	assert.equal(r.totalAdcRelatedUa, 16.5) // 未给 c_sample_pf，动态项为 0
})
test('缺数据手册参数时列入 pending，且不编造结论', () => {
	const r = adcMod.analyzeAdcLoad({ v_ref: 3.3, resolution_bits: 12, sample_rate_hz: 1000 })
	assert.equal(r.chargeCurrentUa, null)
	assert.equal(r.settling, null)
	assert.ok(r.pending.some((p) => p.includes('c_sample_pf')))
	assert.ok(r.pending.some((p) => p.includes('r_adc_ohm')))
	assert.ok(r.pending.some((p) => p.includes('input_leakage_ua')))
})
test('输入漏电流按通道数累加', () => {
	const r = adcMod.analyzeAdcLoad({
		v_ref: 3.3,
		resolution_bits: 12,
		sample_rate_hz: 1000,
		channels: 8,
		input_leakage_ua: 0.05,
	})
	assert.equal(r.staticLoadUa, 0.4) // 0.05 × 8
})

console.log('\n== 18. 会话启动门禁（pre-step 注入） ==')
const gateMod = await import('./lib/gate.js')

// 门禁的定位是**整套工具的使用说明**：每个工具都必须在里面被描述到。
// schema 讲的是参数形状；使用说明讲的是"什么场景该用它、它要什么、它给不了什么"。
test(`门禁文本描述了全部 ${plugin.TOOL_NAMES.length} 个工具`, () => {
	for (const name of plugin.TOOL_NAMES) {
		assert.ok(gateMod.DEFAULT_GATE_CONTENT.includes(name), `门禁文本缺少工具 ${name}`)
	}
})

test('门禁文本点明了硬约束（手册参数不得猜 / 设计值与实测值分开）', () => {
	const t = gateMod.DEFAULT_GATE_CONTENT
	assert.match(t, /数据手册/, '缺少"某些参数必须查数据手册"')
	assert.match(t, /设计值/)
	assert.match(t, /实测值/)
})

// 篇幅保护：上限**随工具数伸缩**，不写死。
// 门禁的定位是"整套工具的使用说明"，工具多了它必然变长——写死一个数，加工具时就
// 逼着砍内容（说明曾被砍成清单就是这个原因）。按每工具均摊来卡，
// 既能拦住"某一条描述失控膨胀"，又不会阻止覆盖完整的工具集。
test('门禁文本篇幅随工具数伸缩（每工具均摊不超过 200 字符）', () => {
	const n = gateMod.DEFAULT_GATE_CONTENT.length
	const limit = plugin.TOOL_NAMES.length * 200
	assert.ok(n > 300, `门禁文本过短：${n} 字符`)
	assert.ok(
		n < limit,
		`门禁文本 ${n} 字符，超过 ${plugin.TOOL_NAMES.length} 个工具 × 200 = ${limit} 字符的均摊上限`,
	)
})
test('pre-step 处理函数：首步在既有消息后追加一条门禁', async () => {
	const handler = gateMod.createGateHandler({ makeMessage: () => ({ marker: 'GATE' }) })
	const out = await handler({ agent: { session: {} } }, async () => ({ kind: 'enter', messages: [{ a: 1 }] }))
	assert.equal(out.kind, 'enter')
	assert.equal(out.messages.length, 2)
	assert.deepEqual(out.messages[0], { a: 1 })
	assert.deepEqual(out.messages[1], { marker: 'GATE' })
})
test('同一会话只注入一次（第二次不再追加）', async () => {
	const handler = gateMod.createGateHandler({ makeMessage: () => ({ marker: 'GATE' }) })
	const session = {}
	const next = async () => ({ kind: 'enter', messages: [] })
	const first = await handler({ agent: { session } }, next)
	const second = await handler({ agent: { session } }, next)
	assert.equal(first.messages.length, 1)
	assert.equal(second.messages.length, 0, '同一会话不应重复注入')
})
test('不同会话各自注入一次', async () => {
	const handler = gateMod.createGateHandler({ makeMessage: () => ({ marker: 'GATE' }) })
	const next = async () => ({ kind: 'enter', messages: [] })
	const a = await handler({ agent: { session: {} } }, next)
	const b = await handler({ agent: { session: {} } }, next)
	assert.equal(a.messages.length, 1)
	assert.equal(b.messages.length, 1)
})
test('reject 决定原样透传，不往里面塞消息', async () => {
	const handler = gateMod.createGateHandler({ makeMessage: () => ({ marker: 'GATE' }) })
	const rejected = { kind: 'reject', reason: 'x' }
	const out = await handler({ agent: { session: {} } }, async () => rejected)
	assert.deepEqual(out, rejected)
})
test('没有 session 对象时仍能工作（只失去去重能力，不抛错）', async () => {
	const handler = gateMod.createGateHandler({ makeMessage: () => ({ marker: 'GATE' }) })
	const out = await handler({}, async () => ({ kind: 'enter', messages: [] }))
	assert.equal(out.messages.length, 1)
})
test('@deepseek-ai/dsh-llm 可解析且导出 createUserMessage（门禁能否真正生效的前提）', async () => {
	const llmMod = await import('@deepseek-ai/dsh-llm')
	assert.equal(typeof llmMod.createUserMessage, 'function')
})
test('门禁消息形状：text 内容块 + source.kind 是 producer 自己的标识', async () => {
	const llmMod = await import('@deepseek-ai/dsh-llm')
	const msg = gateMod.buildGateMessage(llmMod.createUserMessage, 'hello gate')
	assert.ok(Array.isArray(msg.content))
	assert.equal(msg.content[0].type, 'text')
	assert.equal(msg.content[0].text, 'hello gate')
	assert.equal(msg.source?.kind, `plugin:${gateMod.GATE_PLUGIN_ID}`)
	// 会话格式 v4 拒绝通配的 `plugin` kind（持久化时抛 SessionFormatError）——不得回归。
	assert.notEqual(msg.source?.kind, 'plugin')
	assert.ok(!('plugin' in (msg.source ?? {})), 'v4 形状里没有独立的 plugin 字段')
})
test('registerGate 注册成功，且注册进 ctx.on("agent/pre-step")', async () => {
	const events = []
	const ctx = { on: (name, fn) => events.push([name, fn]) }
	const r = await gateMod.registerGate(ctx, {})
	assert.equal(r.registered, true, `未注册：${r.reason}`)
	assert.equal(events.length, 1)
	assert.equal(events[0][0], 'agent/pre-step')
})
test('配置 gateEnabled=false 时不注册（可关）', async () => {
	const events = []
	const r = await gateMod.registerGate({ on: (n) => events.push(n) }, { gateEnabled: false })
	assert.equal(r.registered, false)
	assert.equal(events.length, 0)
})

console.log('\n== 19. HardFault 异常分诊 ==')
const faultMod = await import('./lib/fault.js')

test('EXC_RETURN 按标准值表匹配：标准帧 3 个 + 扩展帧 3 个', () => {
	// 标准帧（不含浮点上下文）
	assert.deepEqual(
		[0xfffffff1, 0xfffffff9, 0xfffffffd].map((v) => {
			const d = faultMod.decodeExcReturn(v)
			return [d.mode, d.stack, d.fpuFrame]
		}),
		[
			['Handler', 'MSP', false],
			['Thread', 'MSP', false],
			['Thread', 'PSP', false],
		],
	)
	// 扩展帧（含浮点上下文，多压 104 字节）
	assert.deepEqual(
		[0xffffffe1, 0xffffffe9, 0xffffffed].map((v) => {
			const d = faultMod.decodeExcReturn(v)
			return [d.mode, d.stack, d.fpuFrame]
		}),
		[
			['Handler', 'MSP', true],
			['Thread', 'MSP', true],
			['Thread', 'PSP', true],
		],
	)
})
test('非标准 EXC_RETURN 判为非法（不靠位推断硬猜）', () => {
	assert.equal(faultMod.decodeExcReturn(0x00000000).valid, false)
	assert.equal(faultMod.decodeExcReturn(0xfffffff5).valid, false)
	assert.equal(faultMod.decodeExcReturn(0xfffffff5).fpuFrame, false)
})
test('分诊：给了非标准 LR 时提示栈帧可能被破坏', () => {
	const r = faultMod.decodeFault({ frame: { pc: 0x08000020, lr: 0x12345678 }, cfsr: 1 << 25 })
	assert.equal(r.excReturnValid, false)
	assert.ok(r.notes.some((n) => n.includes('栈帧可能已被破坏')))
})
test('符号查表：Thumb 位被清掉，命中函数体内并给出偏移', () => {
	const syms = [{ name: 'Reset_Handler', size: 48, addr: 0x08000020, kind: 'code' }]
	// PC 带 Thumb 位（0x...21）应被清成 0x08000020
	const hit = faultMod.lookupSymbol(syms, 0x08000031)
	assert.equal(hit.name, 'Reset_Handler')
	assert.equal(hit.offset, 0x10) // 0x30 - 0x20
	assert.equal(hit.exact, true)
})
test('符号查表：落在区间的两个符号取更具体的那个', () => {
	const syms = [
		{ name: 'outer', size: 1000, addr: 0x1000, kind: 'code' },
		{ name: 'inner', size: 16, addr: 0x1010, kind: 'code' },
	]
	assert.equal(faultMod.lookupSymbol(syms, 0x1018).name, 'inner')
})
test('符号查表：无覆盖符号时回退到最近的起始地址，并标为推断', () => {
	const syms = [{ name: 'g_counter', size: 4, addr: 0x20000000, kind: 'rwData' }]
	const hit = faultMod.lookupSymbol(syms, 0x20000100)
	assert.equal(hit.name, 'g_counter')
	assert.equal(hit.exact, false)
	assert.equal(hit.offset, 0x100)
})
test('分诊：除零 → 归因到 UFSR.DIVBYZERO', () => {
	const r = faultMod.decodeFault({
		frame: { pc: 0x08000031, lr: 0xfffffff9, xpsr: 0x01000000 },
		exc_return: 0xfffffff9,
		cfsr: 1 << 25,
		symbols: [{ name: 'Reset_Handler', size: 48, addr: 0x08000020, kind: 'code' }],
	})
	assert.equal(r.stack, 'MSP')
	assert.equal(r.mode, 'Thread')
	assert.ok(r.cfsr.bits.some((b) => b.name === 'DIVBYZERO'))
	assert.ok(r.hypotheses.some((h) => h.kind === 'div-by-zero'))
	assert.match(r.pc.rendered, /Reset_Handler \+ 0x10/)
})
test('分诊：MSTKERR → 首要怀疑栈溢出', () => {
	const r = faultMod.decodeFault({ frame: { pc: 0x08000020 }, cfsr: 1 << 4 })
	assert.ok(r.cfsr.bits.some((b) => b.name === 'MSTKERR'))
	assert.ok(r.hypotheses.some((h) => h.kind === 'stack-overflow'))
})
test('分诊：xPSR 的 Thumb 位为 0 → 判 INVSTATE（跳到偶地址）', () => {
	const r = faultMod.decodeFault({ frame: { pc: 0x08000021, xpsr: 0x00000000 }, cfsr: 1 << 17 })
	assert.ok(r.hypotheses.some((h) => h.kind === 'thumb-bit-clear'))
	assert.ok(r.hypotheses.some((h) => h.kind === 'invstate'))
})
test('分诊：PC 落在 RAM 内 → 判程序跑飞（返回地址被覆盖）', () => {
	const r = faultMod.decodeFault({
		frame: { pc: 0x20000042 },
		memoryRegions: [
			{ name: 'FLASH', start: 0x08000000, end: 0x08004000, kind: 'flash' },
			{ name: 'RAM', start: 0x20000000, end: 0x20001000, kind: 'ram' },
		],
	})
	assert.ok(r.hypotheses.some((h) => h.kind === 'pc-in-ram'))
	assert.equal(r.hypotheses.find((h) => h.kind === 'pc-in-ram').confidence, '高')
})
test('分诊：HFSR.FORCED → 提示这是被升级的故障，根因看 CFSR', () => {
	const r = faultMod.decodeFault({ frame: { pc: 0x08000020 }, hfsr: 1 << 30, cfsr: 1 << 25 })
	assert.ok(r.hfsr.bits.some((b) => b.name === 'FORCED'))
	assert.ok(r.notes.some((n) => n.includes('被升级的故障')))
})
test('分诊：非精确总线错误 → 明确提示"PC 不是根因所在"', () => {
	const r = faultMod.decodeFault({ frame: { pc: 0x08000020 }, cfsr: 1 << 10 })
	assert.ok(r.hypotheses.some((h) => h.kind === 'imprecise-bus'))
	assert.match(r.hypotheses.find((h) => h.kind === 'imprecise-bus').cause, /不是\*\*根因所在|不是根因所在/)
})
test('分诊：信息不足时给出警告，不硬编一个结论', () => {
	const r = faultMod.decodeFault({ frame: {} })
	assert.equal(r.hypotheses.length, 0)
	assert.ok(r.warnings.some((w) => w.includes('无法分诊')))
})

console.log('\n== 20. NVM 分区与磨损 ==')
const nvmMod = await import('./lib/nvm.js')

test('分区对齐检查：非页对齐的偏移与大小会被指出', () => {
	const r = nvmMod.planNvmLayout({
		flash: { base: 0x08000000, size: 0x10000, page_size: 2048 },
		regions: [
			{ name: 'boot', offset: 0, size: 0x2000, kind: 'bootloader' }, // 0x2000 = 4 页，对齐
			{ name: 'app', offset: 0x3100, size: 0x2500, kind: 'app' }, // 偏移与大小都不对齐
		],
	})
	const boot = r.regions.find((g) => g.name === 'boot')
	const app = r.regions.find((g) => g.name === 'app')
	assert.equal(boot.issues.length, 0, `boot 应无对齐问题：${boot.issues.join('；')}`)
	assert.equal(app.issues.length, 2, `app 应有 2 条对齐问题，实际 ${app.issues.length}：${app.issues.join('；')}`)
	assert.match(app.issues[0], /起始偏移/)
})
test('分区重叠被检出', () => {
	const r = nvmMod.planNvmLayout({
		flash: { base: 0x08000000, size: 0x10000, page_size: 1024 },
		regions: [
			{ name: 'a', offset: 0, size: 0x1000 },
			{ name: 'b', offset: 0x800, size: 0x1000 },
		],
	})
	assert.ok(r.warnings.some((w) => w.includes('分区重叠')))
})
test('整页重写寿命：10 万次上限 ÷ 每天 100 次 = 2.74 年', () => {
	const r = nvmMod.planNvmLayout({
		flash: { base: 0x08000000, size: 0x10000, page_size: 2048 },
		regions: [{ name: 'config', offset: 0, size: 4096, kind: 'config' }],
		erase_cycles_max: 100000,
		wear: [{ region: 'config', writes_per_day: 100, bytes_per_write: 64, mode: 'page-rewrite' }],
	})
	// 100000 / 100 / 365 = 2.7397 → 2.74
	assert.equal(r.wear[0].years, 2.74)
	assert.ok(r.warnings.some((w) => w.includes('寿命仅')))
})
test('同一负载改环形日志后寿命放大到页数倍', () => {
	const base = {
		flash: { base: 0x08000000, size: 0x10000, page_size: 2048 },
		regions: [{ name: 'log', offset: 0, size: 8192, kind: 'log' }],
		erase_cycles_max: 100000,
	}
	const rewrite = nvmMod.planNvmLayout({ ...base, wear: [{ region: 'log', writes_per_day: 1000, bytes_per_write: 64, mode: 'page-rewrite' }] })
	const log = nvmMod.planNvmLayout({ ...base, wear: [{ region: 'log', writes_per_day: 1000, bytes_per_write: 64, mode: 'circular-log' }] })
	assert.ok(log.wear[0].years > rewrite.wear[0].years * 30, `环形日志应显著更耐久：${log.wear[0].years} vs ${rewrite.wear[0].years}`)
})
test('缺 erase_cycles_max 时不编寿命数字', () => {
	const r = nvmMod.planNvmLayout({
		flash: { base: 0x08000000, size: 0x10000, page_size: 2048 },
		regions: [{ name: 'c', offset: 0, size: 4096 }],
		wear: [{ region: 'c', writes_per_day: 10, bytes_per_write: 32 }],
	})
	assert.equal(r.wear[0].years, null)
	assert.ok(r.notes.some((n) => n.includes('未提供 erase_cycles_max')))
})
test('分区超出 Flash 容量 → 报警', () => {
	const r = nvmMod.planNvmLayout({
		flash: { base: 0x08000000, size: 0x1000, page_size: 1024 },
		regions: [{ name: 'x', offset: 0, size: 0x2000 }],
	})
	assert.ok(r.warnings.some((w) => w.includes('放不下')))
})

console.log('\n== 21. LVGL 缓冲与带宽 ==')
const lvglMod = await import('./lib/lvgl.js')

test('16 位色 320×240 整帧 = 153600 字节', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16 })
	assert.equal(r.bytesPerPixel, 2)
	assert.equal(r.fullFrameBytes, 153600)
})
test('局部缓冲默认取屏高 1/10：320×24×2 = 15360 字节', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16 })
	assert.equal(r.linesPerBuffer, 24)
	assert.equal(r.bufferBytes, 15360)
	assert.equal(r.totalDrawBufferBytes, 15360)
})
test('双缓冲把绘制缓冲翻倍', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16, buffer_count: 2, partial_lines: 40 })
	assert.equal(r.totalDrawBufferBytes, 320 * 40 * 2 * 2)
})
test('全屏缓冲吃掉过半 RAM → 报警并建议改局部', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16, buffer_mode: 'full', ram_total_bytes: 262144 })
	assert.ok(r.warnings.some((w) => w.includes('50%')))
})
test('局部缓冲行数过小 → 提示会被拆成多次 flush 导致变慢', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16, partial_lines: 4 })
	assert.ok(r.warnings.some((w) => w.includes('不足屏高的 5%')))
})
test('带宽不足 → 报警；够用则给出占用率', () => {
	const bad = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16, refresh_rate_hz: 60, bus_bytes_per_second: 1000000 })
	assert.equal(bad.bandwidth.fits, false)
	assert.ok(bad.warnings.some((w) => w.includes('带宽不够')))
	const ok = lvglMod.sizeLvglBuffers({ hres: 128, vres: 64, color_depth_bits: 16, refresh_rate_hz: 30, bus_bytes_per_second: 5000000 })
	assert.equal(ok.bandwidth.fits, true)
})
test('LV_MEM_SIZE 明确标注"无法静态计算"（不假装能算）', () => {
	const r = lvglMod.sizeLvglBuffers({ hres: 320, vres: 240, color_depth_bits: 16 })
	assert.ok(r.notes.some((n) => n.includes('LV_MEM_SIZE 无法静态计算')))
	assert.ok(r.notes.some((n) => n.includes('lv_mem_monitor')))
})
test('不支持的位深被拒绝', () => {
	assert.throws(() => lvglMod.sizeLvglBuffers({ hres: 8, vres: 8, color_depth_bits: 12 }), /color_depth_bits/)
})

console.log('\n== 22. 端到端：用假 ctx 调用 apply() ==')
const registeredTools = []
const registeredSkills = []
const logs = []
const fakeCtx = {
	tools: {
		register: (def) => {
			registeredTools.push(def)
		},
	},
	skills: {
		register: (s) => {
			registeredSkills.push(s)
			return () => {}
		},
	},
	logger: {
		info: (...a) => logs.push(['info', ...a]),
		warn: (...a) => logs.push(['warn', ...a]),
	},
}

// cordis 注册表 mixin 的作用域注入。真实实现会等 deps 就绪后再回调；
// 这里服务已直接挂在假 ctx 上，同步回调同一个对象即可。
const injectCalls = []
fakeCtx.inject = (deps, cb) => {
	injectCalls.push(deps)
	return cb(fakeCtx)
}

test('插件元信息正确（name / inject 只声明 tools）', () => {
	assert.equal(plugin.name, 'dsh-embedded-kit')
	assert.deepEqual(plugin.inject, ['tools'])
	assert.equal(typeof plugin.apply, 'function')
})

let applyError = null
try {
	plugin.apply(fakeCtx, {})
} catch (error) {
	applyError = error
}

test('apply() 执行不抛错（即 4 个工具的 schema 全部合法）', () => {
	assert.equal(applyError, null, applyError ? String(applyError) : '')
})

test(`注册了 ${plugin.TOOL_NAMES.length} 个工具，名称与预期一致`, () => {
	const names = registeredTools.map((t) => t.name)
	assert.deepEqual(names.sort(), [...plugin.TOOL_NAMES].sort())
})

test(`注册了 ${skillsMod.SKILL_NAMES.length} 个技能（与 SKILL_NAMES 一致）`, () => {
	assert.equal(registeredSkills.length, skillsMod.SKILL_NAMES.length)
	for (const s of registeredSkills) {
		assert.equal(s.source, 'runtime')
		assert.equal(s.provider, 'dsh-embedded-kit')
		assert.ok(s.content.length > 800, `${s.name} 正文过短`)
		assert.ok(!s.content.startsWith('---'), `${s.name} 正文不应含 frontmatter`)
	}
})

test('技能走作用域注入（只声明 skills），不靠裸访问服务', () => {
	assert.equal(injectCalls.length, 1)
	assert.deepEqual(injectCalls[0], ['skills'])
})

// 回归：cordis 4 的服务访问守卫是**抛错**，不是返回 undefined
// （src/reflect.ts: `cannot get property "X" without inject`）。
// 旧写法直接 `Reflect.get(ctx, 'skills')`，在这一版上会把整棵插件树搞崩；
// 这里锁住"软降级、不抛错"的行为。
test('服务访问抛错时（cordis 4 守卫）软降级，不抛错', () => {
	const guarded = new Proxy(
		{},
		{
			get(_target, key) {
				throw new Error(`cannot get property "${String(key)}" without inject`)
			},
		},
	)
	const result = skillsMod.registerSkills(guarded, {})
	assert.equal(result.available, false)
	assert.equal(result.registered.length, 0)
	assert.equal(result.skipped.length, skillsMod.SKILL_NAMES.length)
})

test('proto_frame 端到端可执行并返回 CRC 正确的帧', async () => {
	const tool = registeredTools.find((t) => t.name === 'proto_frame')
	const out = await tool.execute(
		{ action: 'build', slave: 1, function_code: 3, data: '00 00 00 0A' },
		{ signal: undefined },
	)
	assert.equal(out.hex, '01 03 00 00 00 0A C5 CD')
	assert.equal(out.crc, 0xcdc5)
})

test('fw_size 端到端可执行（Keil map 样本，自动识别）', async () => {
	const tool = registeredTools.find((t) => t.name === 'fw_size')
	const out = await tool.execute(
		{ path: join(HERE, 'testdata', 'sample-keil.map'), top_n: 2, rom_budget: 32768 },
		{ signal: undefined },
	)
	assert.equal(out.format, 'keil-map')
	assert.equal(out.totals.rom, 1008)
	assert.equal(out.objectCount, 8)
	assert.equal(out.top.length, 2)
	assert.equal(out.romBudget.percent, 3.08)
})

test('fw_size 端到端可执行（ELF，同一工具自动换格式）', async () => {
	const tool = registeredTools.find((t) => t.name === 'fw_size')
	const out = await tool.execute({ path: armElfPath, top_n: 3 }, { signal: undefined })
	assert.equal(out.format, 'elf')
	assert.match(out.arch, /ARM/)
	assert.equal(out.totals.ziData, 580)
})

test('proto_frame 的通用 CRC 动作端到端可执行', async () => {
	const tool = registeredTools.find((t) => t.name === 'proto_frame')
	const out = await tool.execute(
		{ action: 'crc', preset: 'crc32', data: '31 32 33 34 35 36 37 38 39', order: 'be' },
		{ signal: undefined },
	)
	assert.equal(out.crc, 0xcbf43926)
	assert.equal(out.crcBytesHex, 'CB F4 39 26')
})

test('fw_build 的 probe 动作端到端可执行', async () => {
	const tool = registeredTools.find((t) => t.name === 'fw_build')
	const out = await tool.execute({ action: 'probe' }, { signal: undefined })
	assert.equal(out.action, 'probe')
	assert.ok(out.toolchains.length >= 7)
})

test('rs485_timing 端到端可执行', async () => {
	const tool = registeredTools.find((t) => t.name === 'rs485_timing')
	const out = await tool.execute({ baud: 115200, frame_bytes: 8 }, { signal: undefined })
	assert.equal(out.modbus.usingFixedSilence, true)
	assert.equal(out.bitsPerChar, 10)
})

test('技能服务缺失时工具仍照常注册（不因技能而整体 pending）', () => {
	const only = []
	const ctxNoSkills = { tools: { register: (d) => only.push(d) }, logger: { info() {}, warn() {} } }
	plugin.apply(ctxNoSkills, {})
	assert.equal(only.length, plugin.TOOL_NAMES.length, `应注册 ${plugin.TOOL_NAMES.length} 个工具，实际 ${only.length}`)
})

console.log('\n== 13. 工具定义结构（供 README 记录） ==')
const sampleDef = registeredTools[0]
console.log(`  已注册工具定义暴露的键：${Object.keys(sampleDef).sort().join(', ')}`)

console.log('\n== 23. 总线与协议工具（I²C / CAN / SPI / I²S / LIN / 1-Wire / RS-232） ==')
const i2cMod = await import('./lib/i2c.js')
const canMod = await import('./lib/can.js')
const spiMod = await import('./lib/spi.js')
const linesMod = await import('./lib/lines.js')

test('I²C 上拉下限：Rp(min) = (VDD − VOL) / IOL', () => {
	assert.equal(Math.round(i2cMod.rpMinFromSink(3.3, 0.4, 0.003)), 967)
})

test('I²C 上升时间：tr = 0.8473 × Rp × Cb', () => {
	assert.equal(Math.round(i2cMod.rpMaxFromRiseTime(1000, 100)), 11802)
	assert.ok(Math.abs(i2cMod.riseTimeNs(4700, 100) - 398.2) < 0.5, `实际 ${i2cMod.riseTimeNs(4700, 100)}`)
})

test('I²C fast 模式在 400 pF 下区间为空（该组合物理上不可行）', () => {
	const r = i2cMod.analyzeI2c({ mode: 'fast', cbPf: 400 })
	assert.ok(r.rpMaxOhm < r.rpMinOhm, `上限 ${r.rpMaxOhm} 应小于下限 ${r.rpMinOhm}`)
	assert.ok(r.warnings.some((w) => w.includes('区间为空')))
})

test('I²C 同一上拉值：100 kHz 可用、400 kHz 不可用', () => {
	const ok = i2cMod.analyzeI2c({ mode: 'standard', cbPf: 100, rpOhm: 4700 })
	assert.ok(ok.checks.find((c) => c.name === '上升时间').pass)
	const bad = i2cMod.analyzeI2c({ mode: 'fast', cbPf: 100, rpOhm: 4700 })
	assert.equal(bad.checks.find((c) => c.name === '上升时间').pass, false)
})

test('I²C 总线电容超规范上限会被报出来', () => {
	const r = i2cMod.analyzeI2c({ mode: 'standard', cbPf: 500 })
	assert.ok(r.warnings.some((w) => w.includes('超过')))
})

// 文献基准：Bosch/CiA《The Configuration of the CAN Bit Timing》给出的经典最优组合
test('CAN 振荡器容差命中文献基准（Prop=1, P1=P2=SJW=4 → 1.587%）', () => {
	const t = canMod.oscillatorTolerance({ propSeg: 1, phaseSeg1: 4, phaseSeg2: 4, sjw: 4 })
	assert.equal(t.nbt, 10)
	assert.ok(Math.abs(t.df * 100 - 1.5873) < 0.001, `实际 ${t.df * 100}`)
})

test('CAN 位时序反算：36MHz/500kbps 精确命中且采样点取 87.5%', () => {
	const r = canMod.bestBitTiming({ fclk: 36_000_000, bitrate: 500_000 })
	assert.equal(r.exact, true)
	assert.ok(r.best !== null)
	assert.equal(r.best.bitrateErrorPpm, 0)
	assert.ok(Math.abs(r.best.samplePointPercent - 87.5) < 0.01, `实际 ${r.best.samplePointPercent}`)
})

test('CAN 寄存器字段是功能值 − 1', () => {
	const b = canMod.bestBitTiming({ fclk: 36_000_000, bitrate: 500_000 }).best
	assert.equal(b.registers.BRP, b.brp - 1)
	assert.equal(b.registers.TSEG1, b.propSeg + b.phaseSeg1 - 1)
	assert.equal(b.registers.TSEG2, b.phaseSeg2 - 1)
	assert.equal(b.registers.SJW, b.sjw - 1)
})

test('CAN 时钟太慢时如实报无解，不硬凑一组数', () => {
	const r = canMod.enumerateBitTiming({ fclk: 4_000_000, bitrate: 1_000_000, nbtMin: 8 })
	assert.equal(r.candidates.length, 0)
})

test('SPI 模式 3 = CPOL1/CPHA1，第二个边沿采样', () => {
	const m = spiMod.describeSpiMode(3)
	assert.equal(m.cpol, 1)
	assert.equal(m.cpha, 1)
	assert.ok(m.sampleEdge.includes('第二个边沿'))
})

test('SPI 最高时钟按半个周期预算算', () => {
	const r = spiMod.estimateSpiMaxClock({ masterDataValidNs: 5, slaveSetupNs: 5, skewNs: 0 })
	assert.equal(r.writeBudgetNs, 10)
	assert.ok(Math.abs(r.writeMaxHz - 5e7) < 1, `实际 ${r.writeMaxHz}`)
})

test('I²S BCLK = fs × 槽位数 × 槽数', () => {
	const r = spiMod.analyzeI2s({ sampleRateHz: 48000, slotBits: 16, slots: 2 })
	assert.equal(r.bitsPerFrame, 32)
	assert.equal(r.bclkHz, 1_536_000)
	assert.equal(r.lrckHz, 48000)
})

test('LIN 帧位数 = 34 位帧头 + 响应字节 × 10', () => {
	const r = linesMod.analyzeLin({ baud: 19200, frames: [{ name: 'F1', dataBytes: 8 }] })
	assert.equal(r.frames[0].totalBits, 34 + 9 * 10)
	assert.ok(Math.abs(r.frames[0].frameTimeUs - (124 * 1e6) / 19200) < 0.01)
})

test('LIN 槽位不足规范的 1.4 倍裕量会报警', () => {
	const r = linesMod.analyzeLin({ baud: 19200, frames: [{ name: 'F1', dataBytes: 8, slotMs: 1 }] })
	assert.ok(r.warnings.some((w) => w.includes('小于规范要求')))
})

test('1-Wire 时隙超出窗口会被判出来', () => {
	const ok = linesMod.analyzeOneWire({ bitSlotUs: 80 })
	assert.ok(ok.checks.every((c) => c.pass))
	const bad = linesMod.analyzeOneWire({ bitSlotUs: 200 })
	assert.ok(bad.warnings.length > 0)
	assert.ok(bad.checks.some((c) => c.pass === false))
})

test('RS-232 长度按线缆电容折算，不是固定米数', () => {
	const r = linesMod.analyzeRs232({ cableLengthM: 50, cablePfPerM: 100 })
	assert.ok(Math.abs(r.maxLengthM - 25) < 0.01, `实际 ${r.maxLengthM}`)
	assert.ok(r.warnings.some((w) => w.includes('2500')))
})

console.log('\n== 24. 固件镜像 / QSPI / 栈深度（覆盖地图第 1 批） ==')
const imageMod = await import('./lib/image.js')
const qspiMod = await import('./lib/qspi.js')
const stackMod = await import('./lib/stack.js')

// Intel HEX 是确定的格式，校验和可逐字节验算，正好当基准向量。
const HEX_VALID = ':10010000214601360121470136007EFE09D2190140\n:00000001FF\n'

test('Intel HEX：合法文件零错误，数据 16 字节 @0x100', () => {
	const r = imageMod.parseIntelHex(HEX_VALID)
	assert.equal(r.errors.length, 0, r.errors.join(' | '))
	assert.equal(r.eofSeen, true)
	assert.equal(r.dataBytes, 16)
	assert.equal(r.minAddress, 0x100)
	assert.equal(r.maxAddress, 0x10f)
})

test('Intel HEX：校验和被改会逐条报出来', () => {
	const bad = HEX_VALID.replace('140', '141')
	const r = imageMod.parseIntelHex(bad)
	assert.ok(r.errors.some((e) => e.includes('校验和错误')), r.errors.join(' | '))
})

test('Intel HEX：缺 EOF 记录会报错', () => {
	const r = imageMod.parseIntelHex(':10010000214601360121470136007EFE09D2190140\n')
	assert.ok(r.errors.some((e) => e.includes('EOF')))
})

test('Intel HEX：地址重叠会被检出', () => {
	// 第二行必须是一条**完整合法**的记录（LL=0x10 → 16 个数据字节 + CC）。
	// 早期版本这条用例只写了 15 个数据字节，靠旧解析器"把校验和字节吞进数据"的缺陷才碰巧触发重叠；
	// 解析器补上记录体长度校验后，该用例数据本身就被正确拒绝了 —— 这里修正为合法记录。
	const dup = ':10010000214601360121470136007EFE09D2190140\n:1001000000000000000000000000000000000000EF\n:00000001FF\n'
	const r = imageMod.parseIntelHex(dup)
	assert.ok(r.errors.some((e) => e.includes('重叠')), r.errors.join(' | '))
})

test('Intel HEX：记录体长度与 LL 不一致（含把 CC 吞进数据的老 bug 形态）会被拒绝', () => {
	// LL=0x10 但只给 15 个数据字节 —— 旧解析器会把校验和字节当第 16 个数据字节吞掉，
	// 现在必须显式报错而不是静默接受。
	const short = ':10010000000000000000000000000000000000EF\n:00000001FF\n'
	const r = imageMod.parseIntelHex(short)
	assert.ok(r.errors.some((e) => e.includes('长度与 LL 不一致')), r.errors.join(' | '))
	assert.equal(r.dataBytes, 0)
})

test('Intel HEX：特殊记录类型的长度不符会被拒绝', () => {
	// type 04 要求恰好 2 个数据字节；type 05 要求 4 个。
	const bad04 = ':0300000408FF01F1\n:00000001FF\n'
	const r04 = imageMod.parseIntelHex(bad04)
	assert.ok(r04.errors.some((e) => e.includes('记录类型 0x04')), r04.errors.join(' | '))
	const bad05 = ':0200000508FFF2\n:00000001FF\n'
	const r05 = imageMod.parseIntelHex(bad05)
	assert.ok(r05.errors.some((e) => e.includes('记录类型 0x05')), r05.errors.join(' | '))
})

test('Intel HEX：256KB 大固件完整解析（回归用例）', () => {
	// ≥128KB 是 Cortex-M 最常见规格，必须覆盖；最小/最大地址不能用展开运算符求。
	function mkRecord(len, addr, type, data) {
		const all = [len & 0xff, (addr >> 8) & 0xff, addr & 0xff, type, ...data]
		const cks = (256 - (all.reduce((a, b) => a + b, 0) & 0xff)) & 0xff
		return ':' + [...all, cks].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('')
	}
	const lines = []
	const TOTAL = 262144 // 256KB
	const base = 0x08000000
	for (let i = 0; i < TOTAL; i += 4096) {
		const up = ((base + i) >>> 16) & 0xffff
		lines.push(mkRecord(2, 0, 4, [(up >> 8) & 0xff, up & 0xff]))
		for (let j = 0; j < 4096 && i + j < TOTAL; j += 16) {
			const n = Math.min(16, TOTAL - (i + j))
			lines.push(mkRecord(n, (base + i + j) & 0xffff, 0, Array.from({ length: n }, (_, k) => (i + j + k) & 0xff)))
		}
	}
	lines.push(':00000001FF')
	const r = imageMod.parseIntelHex(lines.join('\n'))
	assert.equal(r.errors.length, 0, r.errors.join(' | '))
	assert.equal(r.dataBytes, TOTAL)
	assert.equal(r.minAddress, 0x08000000)
	assert.equal(r.maxAddress, 0x08000000 + TOTAL - 1)
})

test('向量表：合法的 SP/复位向量全部通过', () => {
	const r = imageMod.checkVectors({
		initialSp: 0x20005000,
		resetVector: 0x08000121,
		flashRange: { start: 0x08000000, end: 0x08100000 },
		ramRange: { start: 0x20000000, end: 0x20010000 },
	})
	assert.ok(r.checks.every((c) => c.pass), JSON.stringify(r.checks))
	assert.equal(r.warnings.length, 0)
})

test('向量表：SP 未 8 字节对齐会被判出来', () => {
	const r = imageMod.checkVectors({
		initialSp: 0x20005004,
		resetVector: 0x08000121,
		flashRange: { start: 0x08000000, end: 0x08100000 },
		ramRange: { start: 0x20000000, end: 0x20010000 },
	})
	const c = r.checks.find((x) => x.name.includes('8 字节对齐'))
	assert.equal(c.pass, false)
	assert.ok(r.warnings.some((w) => w.includes('对齐')))
})

test('向量表：复位向量 Thumb 位为 0 会被判出来（会 lockup）', () => {
	const r = imageMod.checkVectors({
		initialSp: 0x20005000,
		resetVector: 0x08000120,
		flashRange: { start: 0x08000000, end: 0x08100000 },
		ramRange: { start: 0x20000000, end: 0x20010000 },
	})
	const c = r.checks.find((x) => x.name.includes('Thumb'))
	assert.equal(c.pass, false)
	assert.ok(r.warnings.some((w) => w.includes('lockup')))
})

test('QSPI：dummy 下限 = ceil(tAccess × f)', () => {
	assert.equal(qspiMod.dummyCyclesNeeded(30, 100e6), 3)
	assert.equal(qspiMod.dummyCyclesNeeded(8, 100e6), 1)
})

test('QSPI：给定 dummy 的频率上限 = D / tAccess', () => {
	assert.ok(Math.abs(qspiMod.maxFrequencyForDummy(3, 30) - 100e6) < 1)
})

test('QSPI：dummy 配少会报出"读到上一位残留"', () => {
	const r = qspiMod.analyzeQspi({ fHz: 100e6, accessTimeNs: 30, mode: '1-4-4', dummyCycles: 2 })
	const c = r.checks.find((x) => x.name.includes('dummy'))
	assert.equal(c.pass, false)
	assert.ok(r.warnings.some((w) => w.includes('残留')))
})

test('栈深度：最坏链 + 最深 N 层中断叠加', () => {
	const r = stackMod.analyzeStack({
		stackSizeBytes: 4096,
		callChains: [
			{ name: 'main', framesBytes: [64, 128, 32] },
			{ name: 'isr-path', framesBytes: [64, 400] },
		],
		isrFramesBytes: [200, 100],
		maxIsrNesting: 2,
	})
	assert.equal(r.worstChain.name, 'isr-path')
	assert.equal(r.worstChain.bytes, 464)
	assert.equal(r.isrBytes, 300)
	assert.equal(r.totalBytes, 764)
	assert.equal(r.marginBytes, 4096 - 764)
	assert.ok(r.checks.every((c) => c.pass))
})

test('栈深度：超了会判不通过', () => {
	const r = stackMod.analyzeStack({
		stackSizeBytes: 512,
		callChains: [{ name: 'main', framesBytes: [400, 400] }],
	})
	assert.equal(r.checks.find((c) => c.name.includes('装得下')).pass, false)
	assert.ok(r.warnings.length > 0)
})

test('栈深度：水印地址反算已用字节', () => {
	const r = stackMod.usedBytesFromWatermark({
		stackStart: 0x20000000,
		stackSizeBytes: 4096,
		growsDown: true,
		watermarkAddress: 0x20000f00,
	})
	assert.equal(r.usedBytes, 256)
	assert.equal(r.remainingBytes, 4096 - 256)
})

console.log('\n== 25. 时钟树 / NVIC / 看门狗 / 电源树（覆盖地图第 2 批） ==')
const clockMod = await import('./lib/clock.js')
const nvicMod = await import('./lib/nvic.js')
const wdtMod = await import('./lib/watchdog.js')
const supplyMod = await import('./lib/supply.js')

test('时钟求解：8 MHz → 48 MHz 能精确命中', () => {
	const r = clockMod.solvePll({ sourceHz: 8e6, targetHz: 48e6 })
	assert.ok(r.solutions.length > 0)
	assert.ok(r.solutions.some((s) => s.outHz === 48e6))
	for (const s of r.solutions) assert.equal(s.outHz, 48e6)
})

test('时钟求解：凑不出来时如实报最接近的，不硬凑', () => {
	const r = clockMod.solvePll({ sourceHz: 25e6, targetHz: 48e6, mulMax: 20, outputDivMax: 4 })
	assert.equal(r.solutions.length, 0)
	assert.ok(r.nearMiss !== null)
	assert.ok(r.warnings.some((w) => w.includes('找不到')))
})

test('时钟链逐节点：8→96→48 MHz，节点频率正确', () => {
	const r = clockMod.evaluateClockChain({
		sourceHz: 8e6,
		stages: [
			{ name: 'pll', kind: 'mul', value: 12 },
			{ name: 'ahb', kind: 'div', value: 2 },
		],
		limits: [{ name: 'ahb', maxHz: 60e6 }],
	})
	assert.equal(r.nodes.find((n) => n.name === 'pll').hz, 96e6)
	assert.equal(r.nodes.find((n) => n.name === 'ahb').hz, 48e6)
	assert.ok(r.checks.every((c) => c.pass))
})

test('时钟链：超频会被判出来', () => {
	const r = clockMod.evaluateClockChain({
		sourceHz: 8e6,
		stages: [{ name: 'ahb', kind: 'mul', value: 12 }],
		limits: [{ name: 'ahb', maxHz: 60e6 }],
	})
	assert.ok(r.checks.some((c) => c.pass === false))
	assert.ok(r.warnings.some((w) => w.includes('超频')))
})

test('串口时钟容错：预算 0.5 / 每帧位数', () => {
	const ok = clockMod.uartTolerance({ actualHz: 16e6, nominalHz: 16e6, bitsPerFrame: 10 })
	assert.ok(ok.pass)
	assert.ok(Math.abs(ok.budgetPercent - 5) < 1e-9)
	const bad = clockMod.uartTolerance({ actualHz: 16e6 * 1.06, nominalHz: 16e6, bitsPerFrame: 10 })
	assert.equal(bad.pass, false)
})

test('NVIC 分组：4 位全给抢占 → 16 级', () => {
	const g = nvicMod.priorityGrouping({ implementedBits: 4, subPriorityBits: 0 })
	assert.equal(g.preemptBits, 4)
	assert.equal(g.preemptLevels, 16)
	assert.equal(g.shift, 4)
})

test('NVIC 抢占：抢占级相同则不能互相抢占（子优先级不产生抢占）', () => {
	// 4 位实现、2 位子优先级 → 抢占位 2，抢占级 = prio >> 2
	const yes = nvicMod.canPreempt({ aPriority: 0, bPriority: 5, implementedBits: 4, subPriorityBits: 2 })
	assert.equal(yes.preempts, true)
	const no = nvicMod.canPreempt({ aPriority: 1, bPriority: 2, implementedBits: 4, subPriorityBits: 2 })
	assert.equal(no.preempts, false)
	assert.ok(no.notes.some((n) => n.includes('不产生抢占')))
})

test('NVIC 延迟上界 = 最长关中断 + 更高优先级 ISR 之和 + 入栈', () => {
	const r = nvicMod.analyzeInterruptLatency({
		disabledWindowsUs: [
			{ name: 'flash-write', us: 40 },
			{ name: 'adc-latch', us: 5 },
		],
		higherPriorityIsrsUs: [{ name: 'timer', us: 3 }, { name: 'dma', us: 2 }],
		entryOverheadUs: 0.3,
		requirementUs: 50,
	})
	assert.equal(r.longestDisabled.name, 'flash-write')
	assert.equal(r.isrSum, 5)
	assert.ok(Math.abs(r.upperBoundUs - 45.3) < 1e-9)
	assert.ok(r.checks[0].pass)
})

test('看门狗：由计数参数算超时为 (reload+1)×prescaler/clock', () => {
	assert.ok(Math.abs(wdtMod.timeoutUs({ clockHz: 40e3, prescaler: 1, reload: 999 }) - 25000) < 1e-6)
})

test('看门狗：反算精确命中 1 s', () => {
	const r = wdtMod.solveTimeout({ clockHz: 40e3, targetTimeoutUs: 1e6 })
	assert.ok(r.exact.length > 0)
	assert.ok(r.exact.every((x) => Math.abs(x.timeoutUs - 1e6) < 1e-6))
})

test('看门狗：最坏喂狗间隔逼近超时会报警（偶发重启的典型成因）', () => {
	const r = wdtMod.analyzeWatchdog({ timeoutUs: 100_000, worstFeedIntervalUs: 80_000 })
	assert.equal(r.checks[0].pass, false)
	assert.ok(r.warnings.some((w) => w.includes('偶发重启')))
})

test('看门狗：窗口下限不满足（喂太早）会报警', () => {
	// 语义修正后的判据：worst ≤ lower → 最短间隔必然更早，必违规（保守可判定分支）。
	const r = wdtMod.analyzeWatchdog({ timeoutUs: 100_000, worstFeedIntervalUs: 30_000, windowLowerUs: 50_000 })
	const c = r.checks.find((x) => x.name.includes('窗口下限'))
	assert.equal(c.pass, false)
	assert.ok(r.warnings.some((w) => w.includes('太早')))
})

test('看门狗：窗口下限判定用最快一圈（worst 过关 ≠ 安全）', () => {
	// 100ms 超时 / 最坏 80ms / 最快一圈 10ms / 窗口下限 20ms：
	// 只拿 worst(80ms) > lower(20ms) 判"通过"是漏报 —— 最快一圈 10ms 就喂了狗。
	const r = wdtMod.analyzeWatchdog({
		timeoutUs: 100_000, worstFeedIntervalUs: 80_000, bestFeedIntervalUs: 10_000, windowLowerUs: 20_000,
	})
	const c = r.checks.find((x) => x.name.includes('窗口下限'))
	assert.equal(c.pass, false)
	assert.ok(r.warnings.some((w) => w.includes('太早')))
})

test('看门狗：未给最快一圈时窗口下限如实标无法判定（pass=null）', () => {
	const r = wdtMod.analyzeWatchdog({ timeoutUs: 100_000, worstFeedIntervalUs: 80_000, windowLowerUs: 20_000 })
	const c = r.checks.find((x) => x.name.includes('窗口下限'))
	assert.equal(c.pass, null)
	assert.ok(r.notes.some((n) => n.includes('best_feed_interval_us')))
})

test('看门狗：best > worst 的矛盾输入会被拒绝', () => {
	assert.throws(
		() => wdtMod.analyzeWatchdog({ timeoutUs: 100_000, worstFeedIntervalUs: 10_000, bestFeedIntervalUs: 80_000 }),
		/不能大于/,
	)
})

test('看门狗：上电初始化超过超时会报警', () => {
	const r = wdtMod.analyzeWatchdog({ timeoutUs: 100_000, worstFeedIntervalUs: 50_000, initTimeUs: 150_000 })
	assert.ok(r.warnings.some((w) => w.includes('上电初始化')))
})

test('电源树：LDO 耗散 =(Vin−Vout)×Iout，效率与电流无关', () => {
	const r = supplyMod.analyzeRail({ name: '3v3', type: 'ldo', vinV: 12, voutV: 3.3, ioutA: 0.1 })
	assert.ok(Math.abs(r.pDissipated - 0.87) < 1e-9, `实际 ${r.pDissipated}`)
	assert.ok(Math.abs(r.efficiency - 3.3 / 12) < 1e-9)
	assert.ok(Math.abs(r.pIn - 1.2) < 1e-9)
})

test('电源树：结温 Tj = Ta + Pd × Rθja，超限会报警', () => {
	const ok = supplyMod.analyzeRail({ name: 'a', type: 'ldo', vinV: 5, voutV: 3.3, ioutA: 0.05, rthjaCPerW: 50, tjMaxC: 125 })
	assert.ok(Math.abs(ok.tjC - (25 + 0.085 * 50)) < 1e-9)
	assert.ok(ok.checks.every((c) => c.pass))
	const bad = supplyMod.analyzeRail({ name: 'b', type: 'ldo', vinV: 12, voutV: 3.3, ioutA: 0.5, rthjaCPerW: 100, tjMaxC: 125 })
	assert.ok(bad.checks.some((c) => c.pass === false))
	assert.ok(bad.warnings.some((w) => w.includes('结温')))
})

test('电源树：DCDC 按效率算输入功率', () => {
	const r = supplyMod.analyzeRail({ name: 'd', type: 'dcdc', vinV: 5, voutV: 3.3, ioutA: 0.5, efficiency: 0.9 })
	assert.ok(Math.abs(r.pOut - 1.65) < 1e-9)
	assert.ok(Math.abs(r.pIn - 1.65 / 0.9) < 1e-9)
	assert.ok(Math.abs(r.pDissipated - (1.65 / 0.9 - 1.65)) < 1e-9)
})

test('电源树：整树合计与最热轨', () => {
	const r = supplyMod.analyzePowerTree({
		rails: [
			{ name: 'v1', type: 'ldo', vinV: 5, voutV: 3.3, ioutA: 0.1, rthjaCPerW: 50, tjMaxC: 125 },
			{ name: 'v2', type: 'dcdc', vinV: 12, voutV: 5, ioutA: 0.2, efficiency: 0.9, rthjaCPerW: 40, tjMaxC: 125 },
		],
	})
	assert.ok(Math.abs(r.totalPOut - (0.33 + 1.0)) < 1e-9)
	assert.ok(r.hottestRail !== null)
})

console.log('\n== 26. 高速总线与无线模块（用例见各自 integrate/*.cases.mjs） ==')
// 用例写在各自的 integrate/<name>.cases.mjs 里，
// 这里只做一次统一注册——避免把上千行断言塞进本文件，也让"模块与它的用例"放在一起。
const INTEGRATED_MODULES = ['canfd', 'pmbus', 'usb', 'sdio', 'lora', 'ble', 'linkbudget']
for (const name of INTEGRATED_MODULES) {
	const mod = await import(`./integrate/${name}.cases.mjs`)
	if (typeof mod.register !== 'function') {
		throw new Error(`integrate/${name}.cases.mjs 未导出 register()`)
	}
	await mod.register({ test, assert })
}

console.log('\n== 27. 关键行为的回归用例 ==')
test('usb.bitTimeNs：返回真实位时间', async () => {
	const usbLib = await import('./lib/usb.js')
	assert.ok(Math.abs(usbLib.bitTimeNs('full') - 83.33333333333333) < 1e-9, `full 实际 ${usbLib.bitTimeNs('full')}`)
	assert.ok(Math.abs(usbLib.bitTimeNs('high') - 2.0833333333333335) < 1e-9, `high 实际 ${usbLib.bitTimeNs('high')}`)
})
test('usb.maxTransactionsInInterval：事务装不进窗口时钳到 0', async () => {
	const usbLib = await import('./lib/usb.js')
	const r = usbLib.maxTransactionsInInterval({ speed: 'full', totalBits: 100000, availableUs: 1000 })
	assert.equal(r.maxTransactions, 0)
})
test('ble.maxLegalSlaveLatency：整除边界回代自检（100ms/2000ms → 8）', async () => {
	const bleLib = await import('./lib/ble.js')
	assert.equal(
		bleLib.maxLegalSlaveLatency({ connIntervalMs: 100, supervisionTimeoutMs: 2000, subrateFactor: 1 }),
		8,
	)
	// 非整除的常规边界保持正确。
	assert.equal(
		bleLib.maxLegalSlaveLatency({ connIntervalMs: 30, supervisionTimeoutMs: 2000, subrateFactor: 1 }),
		32,
	)
})
test('canfd.dynamicStuffingRegionBits：FD 标准帧含 IDE 位（DLC15 → 534）', async () => {
	const canfdLib = await import('./lib/canfd.js')
	assert.equal(canfdLib.dynamicStuffingRegionBits({ fd: true, extended: false, dlc: 15 }), 534)
	assert.equal(canfdLib.dynamicStuffingRegionBits({ fd: true, extended: true, dlc: 15 }), 553)
	// 经典帧基准不回归：98 位（SOF+仲裁+控制+数据+CRC 序列）。
	assert.equal(canfdLib.dynamicStuffingRegionBits({ fd: false, extended: false, dlc: 8 }), 98)
})
test('pmbus DIRECT 负 m 系数：halfStep 取绝对值', async () => {
	const toolMod = await import('./integrate/pmbus.tool.mjs')
	// m=-4617 的厂商系数形态：负 m 时 halfStep 必须取绝对值，否则编码值正确也会误报"取整出了问题"。
	// dispatch 主入口对负 m 系数的编码请求必须正常返回（含 checks）。
	const r = toolMod.dispatch({ action: 'linear', format: 'direct', value: 1, m: -4617, b: 0, r: 0 })
	assert.ok(Array.isArray(r.checks))
	const stepCheck = r.checks.find((c) => c.name.includes('格子'))
	assert.ok(stepCheck !== undefined, '应包含编码格子判定')
	assert.equal(stepCheck.pass, true, `负 m 系数的正确编码被误报：${stepCheck.detail}`)
})

await Promise.all(pending)

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
	console.log('\n失败明细：')
	for (const f of failures) console.log(`  - ${f.label}: ${f.detail}`)
	process.exitCode = 1
} else {
	console.log('全部通过。')
}
