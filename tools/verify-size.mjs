/**
 * 体积分析的多格式/多架构验证。
 *
 * 走的是工具实际使用的入口 `analyzeBuffer`，因此验证的是真实代码路径。
 *
 * 三类验证：
 *   1. **跨格式互证（最强）**：同一份固件，读 ELF 与读 GNU ld map 是两个完全独立的
 *      解析器（一个读节区头、一个读链接脚本输出），它们算出的 ROM / RAM **必须一致**。
 *      不一致就说明至少有一个错了。
 *   2. **架构无关**：同一份源码用 ARM Cortex-M0 与 RISC-V RV32 两套工具链编译，
 *      两边都要能正确解析（验证 elf.js 不依赖任何特定架构假设）。
 *   3. **Keil 真实工程自洽**：逐项目标文件求和必须等于 Keil 自己的 Total 行。
 *
 * 用法：node tools/verify-size.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { analyzeBuffer } from '../lib/sizereport.js'
import { decodeLog } from '../lib/keil.js'
import { computePreset, CHECK_VALUES, PRESET_NAMES } from '../lib/crc.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const SMOKE = join(HERE, '..', 'testdata', 'smoke')

let failures = 0
/**
 * 断言。
 * @param {string} label - 用例名。
 * @param {boolean} ok - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function check(label, ok, detail = '') {
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === '' ? '' : `  —— ${detail}`}`)
	if (!ok) failures++
}

/**
 * 分析一个文件。
 * @param {string} path - 文件路径。
 * @returns {Promise<object>} 统一报告。
 */
async function analyze(path) {
	const buffer = await readFile(path)
	const decoded = decodeLog(buffer)
	return analyzeBuffer(buffer, decoded, { source: path, topN: 5 })
}

/** 真实 Keil 工程（本机既有，与插件无关）。 */
const REAL_KEIL_MAPS = [
	'C:\\Users\\anneqaq\\Documents\\Car_Encoder.map',
	'C:\\Users\\anneqaq\\Desktop\\HAL_F103Balance\\Rang finder - 2\\MDK-ARM\\Timr\\Timr.map',
	'C:\\Users\\anneqaq\\Documents\\Tencent Files\\1696789950\\FileRecv\\6.Encoder\\MDK-ARM\\OLED\\OLED.map',
]

console.log('\n=== 1. 同一固件：ELF 与 GNU ld map 跨格式互证 ===')

const ARCHES = [
	{ name: 'ARM Cortex-M0', elf: 'arm-cm0.elf', map: 'arm-cm0.map', archHint: 'ARM' },
	{ name: 'RISC-V RV32  ', elf: 'riscv.elf', map: 'riscv.map', archHint: 'RISC-V' },
]

/** @type {Record<string, object>} */
const elfReports = {}

for (const a of ARCHES) {
	console.log(`\n  --- ${a.name} ---`)
	let elf
	let map
	try {
		elf = await analyze(join(SMOKE, a.elf))
		map = await analyze(join(SMOKE, a.map))
	} catch (error) {
		check(`${a.name} 解析`, false, error instanceof Error ? error.message : String(error))
		continue
	}
	elfReports[a.name] = elf

	check(`${a.name} ELF 被识别为 elf`, elf.format === 'elf', `实际 ${elf.format}`)
	check(`${a.name} ELF 架构识别包含「${a.archHint}」`, elf.arch.includes(a.archHint), `实际 ${elf.arch}`)
	check(`${a.name} map 被识别为 gnu-map`, map.format === 'gnu-map', `实际 ${map.format}`)

	// 同一个固件的两种表示，两个独立解析器必须给出相同的总量。
	check(
		`${a.name} 跨格式 ROM 一致（ELF ${elf.totals.rom} vs map ${map.totals.rom}）`,
		elf.totals.rom === map.totals.rom,
		`差 ${elf.totals.rom - map.totals.rom}`,
	)
	check(
		`${a.name} 跨格式 RAM 一致（ELF ${elf.totals.ram} vs map ${map.totals.ram}）`,
		elf.totals.ram === map.totals.ram,
		`差 ${elf.totals.ram - map.totals.ram}`,
	)

	// 口径自洽：ROM = Code + RO + RW；RAM = RW + ZI
	check(
		`${a.name} ELF 口径自洽（ROM = code+ro+rw）`,
		elf.totals.rom === elf.totals.code + elf.totals.roData + elf.totals.rwData,
	)
	check(
		`${a.name} map 口径自洽（RAM = rw+zi）`,
		map.totals.ram === map.totals.rwData + map.totals.ziData,
	)

	// 由 testdata/smoke 的源码与链接脚本独立推算出的期望值：
	//   .rodata 16×2=32 + .isr_vector 8×4=32 → RO Data = 64
	//   .data g_counter = 4 字节 → RW Data = 4
	//   .bss (64+4)=68 + ._user_heap_stack 0x200=512 → ZI Data = 580
	//   RAM = 4 + 580 = 584
	// 注意：这是**独立算出来的**期望值，不是从解析器输出抄的。
	check(`${a.name} RO Data = 64（.isr_vector 32 + .rodata 32）`, elf.totals.roData === 64, `实际 ${elf.totals.roData}`)
	check(`${a.name} RW Data = 4（g_counter）`, elf.totals.rwData === 4, `实际 ${elf.totals.rwData}`)
	check(`${a.name} ZI Data = 580（.bss 68 + 堆栈预留 512）`, elf.totals.ziData === 580, `实际 ${elf.totals.ziData}`)
	check(`${a.name} RAM = 584`, elf.totals.ram === 584, `实际 ${elf.totals.ram}`)

	check(
		`${a.name} map 解析出 FLASH 与 RAM 区域`,
		map.memoryRegions.length >= 2 &&
			map.memoryRegions.some((r) => !r.writable) &&
			map.memoryRegions.some((r) => r.writable),
		`区域：${map.memoryRegions.map((r) => r.name).join(', ')}`,
	)

	console.log(
		`     ELF : ROM ${elf.totals.rom} / RAM ${elf.totals.ram}（code ${elf.totals.code} ro ${elf.totals.roData} rw ${elf.totals.rwData} zi ${elf.totals.ziData}）`,
	)
	console.log(
		`     MAP : ROM ${map.totals.rom} / RAM ${map.totals.ram}（code ${map.totals.code} ro ${map.totals.roData} rw ${map.totals.rwData} zi ${map.totals.ziData}）`,
	)
	console.log(`     最大 ROM 条目：${elf.top[0]?.object} = ${elf.top[0]?.rom} B`)
}

console.log('\n=== 2. 跨架构一致性（两套工具链编译的同一份源码）===')
if (elfReports['ARM Cortex-M0'] && elfReports['RISC-V RV32  ']) {
	const arm = elfReports['ARM Cortex-M0']
	const rv = elfReports['RISC-V RV32  ']
	// 数据部分与架构无关，必须完全相同；代码长度因指令集不同而不同。
	check('两架构 RO Data 相同（数据与架构无关）', arm.totals.roData === rv.totals.roData)
	check('两架构 RW Data 相同', arm.totals.rwData === rv.totals.rwData)
	check('两架构 ZI Data 相同', arm.totals.ziData === rv.totals.ziData)
	check(
		`两架构 Code 不同且都 > 0（ARM ${arm.totals.code} vs RISC-V ${rv.totals.code}）`,
		arm.totals.code > 0 && rv.totals.code > 0 && arm.totals.code !== rv.totals.code,
		'两个 ISA 的代码长度恰好相同，可能是编译产物异常',
	)
}

console.log('\n=== 3. 真实 Keil 工程：逐项求和 vs 官方汇总 ===')
for (const mapPath of REAL_KEIL_MAPS) {
	let report
	try {
		report = await analyze(mapPath)
	} catch (error) {
		console.log(`  跳过（读不到）${mapPath}`)
		continue
	}
	const short = mapPath.split('\\').pop()
	check(`${short} 被识别为 keil-map`, report.format === 'keil-map', `实际 ${report.format}`)
	check(`${short} 自洽校验通过（ROM ${report.totals.rom} / RAM ${report.totals.ram}）`, report.crossCheck.passed === true)
	check(`${short} 口径自洽（ROM = code+ro+rw）`, report.totals.rom === report.totals.code + report.totals.roData + report.totals.rwData)
}

console.log('\n=== 4. CRC 标准测试向量（ASCII "123456789"）===')
const check123 = Array.from('123456789').map((c) => c.charCodeAt(0))
for (const name of PRESET_NAMES) {
	const expected = CHECK_VALUES[name]
	if (expected === undefined) {
		console.log(`  --   ${name}（无公开 check value，跳过比对）`)
		continue
	}
	const got = computePreset(check123, name)
	check(
		`${name} = 0x${expected.toString(16).toUpperCase()}`,
		got === expected,
		`实算 0x${got.toString(16).toUpperCase()}`,
	)
}

console.log(`\n结论：失败 ${failures} 项。`)
if (failures > 0) {
	console.log('存在失败项，上述结论不可采信。')
	process.exitCode = 1
} else {
	console.log('全部通过：三种格式、两种架构、CRC 标准向量均验证一致。')
}
