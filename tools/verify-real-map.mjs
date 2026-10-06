/**
 * 真实 `.map` 交叉验证脚本。
 *
 * 拿真实 Keil 工程产出的 `.map` 跑一遍解析，检查：
 *   - 能否识别列格式
 *   - 逐项求和得到的 ROM/RAM 是否与 Keil 自己的 `Total` 行一致
 *     （不一致就说明列语义判错了，这是本解析器的核心正确性判据）
 *
 * 用法：node tools/verify-real-map.mjs <map1> [map2] ...
 * 未传参数时使用包内样本（testdata/ 下）。历史版本曾默认扫某台机器上的私有
 * 绝对路径（其他机器上会全部静默跳过、验证覆盖名存实亡），已改为随包分发。
 */

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseKeilMap, buildSizeReport } from '../lib/mapfile.js'
import { decodeLog } from '../lib/keil.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MAPS = [join(HERE, '..', 'testdata', 'sample-keil.map')]

const targets = process.argv.slice(2)
const maps = targets.length > 0 ? targets : DEFAULT_MAPS

let anyFail = false

for (const mapPath of maps) {
	let text
	let encoding = 'unknown'
	try {
		const decoded = decodeLog(await readFile(mapPath))
		text = decoded.text
		encoding = decoded.encoding
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
