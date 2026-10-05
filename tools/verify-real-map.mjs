/**
 * 真实 `.map` 交叉验证脚本。
 *
 * 拿本机真实 Keil 工程产出的 `.map` 跑一遍解析，检查：
 *   - 能否识别列格式
 *   - 逐项求和得到的 ROM/RAM 是否与 Keil 自己的 `Total` 行一致
 *     （不一致就说明列语义判错了，这是本解析器的核心正确性判据）
 *
 * 用法：node tools/verify-real-map.mjs <map1> [map2] ...
 * 未传参数时使用内置的本机样本清单。
 */

import { readFile } from 'node:fs/promises'
import { parseKeilMap, buildSizeReport } from '../lib/mapfile.js'
import { decodeLog } from '../lib/keil.js'

const DEFAULT_MAPS = [
	'C:\\Users\\anneqaq\\Documents\\Car_Encoder.map',
	'C:\\Users\\anneqaq\\Desktop\\HAL_F103Balance\\Rang finder - 2\\MDK-ARM\\Timr\\Timr.map',
	'C:\\Users\\anneqaq\\Documents\\Tencent Files\\1696789950\\FileRecv\\6.Encoder\\MDK-ARM\\OLED\\OLED.map',
]

const targets = process.argv.slice(2)
const maps = targets.length > 0 ? targets : DEFAULT_MAPS

let anyFail = false

for (const mapPath of maps) {
	let text
	try {
		const decoded = decodeLog(await readFile(mapPath))
		text = decoded.text
		var encoding = decoded.encoding
	} catch (error) {
		console.log(`跳过（读不到）：${mapPath}`)
		console.log(`  ${error instanceof Error ? error.message : String(error)}`)
		continue
	}

	const parsed = parseKeilMap(text)
	const report = buildSizeReport(parsed)

	const consistent =
		parsed.totals.rom !== null &&
		parsed.components.length > 0 &&
		report.sumRom === parsed.totals.rom &&
		report.sumRam === parsed.totals.rw

	if (!consistent) anyFail = true

	console.log(`${consistent ? '通过' : '不一致'}  ${mapPath}`)
	console.log(`  编码=${encoding}  列格式=${parsed.layout}  目标文件数=${parsed.components.length}`)
	console.log(
		`  Keil 汇总：RO=${parsed.totals.ro}  RW=${parsed.totals.rw}  ROM=${parsed.totals.rom}`,
	)
	console.log(`  逐项求和：ROM=${report.sumRom}  RAM=${report.sumRam}`)
	if (report.warnings.length > 0) {
		console.log(`  警告：${report.warnings.join(' | ')}`)
	}
	const top = report.ranked[0]
	if (top) {
		console.log(`  最大 ROM 占用：${top.object} = ${top.rom} B（code ${top.code} + ro ${top.roData} + rw ${top.rwData}）`)
	}
	console.log('')
}

console.log(anyFail ? '结论：存在不自洽的样本，列语义需要复核。' : '结论：全部样本自洽，列语义得到真实数据验证。')
process.exitCode = anyFail ? 1 : 0
