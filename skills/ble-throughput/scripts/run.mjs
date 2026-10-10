#!/usr/bin/env node
/**
 * `ble-throughput` 技能随附脚本。
 *
 * 它**不复制任何算法**：直接把插件里的工具描述符当 CLI 用 —— 参数校验、规范常量、
 * checks/warnings/notes 全部来自同一个实现，所以数值与"工具时代"逐字节一致。
 * 这样把能力从工具列表里摘下来（省下每轮常驻的 schema），但一点正确性都不丢。
 *
 * 入参支持三种形式，**首选 key=value**：PowerShell 会把命令行里的双引号吃掉，
 * 直接传 JSON 在 Windows 上不可靠（这是实测踩到的，不是理论担忧）。
 *
 *   node run.mjs action=phy encrypted=false
 *   node run.mjs action=throughput phy=le-1m data_len_octets=251 encrypted=false conn_interval_ms=30
 *   node run.mjs args.json                      # 参数复杂（嵌套数组/对象）时写文件再传路径
 *   node run.mjs '{"action":"phy","encrypted":false}'   # bash 下可用
 *
 * @module dsh-embedded-kit/skills/ble-throughput/run
 */

import { readFileSync } from 'node:fs'
import { tool } from '../../../integrate/ble.tool.mjs'

/** 把 `key=value` 的值转成合适的类型：能当 JSON 解析就当，否则当字符串。 */
function coerce(raw) {
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

/** @returns {Record<string, unknown>} */
function parseArgs(argv) {
	if (argv.length === 0) return undefined

	// 形式一：单个 JSON 字符串（bash 友好）
	if (argv.length === 1 && argv[0].trimStart().startsWith('{')) {
		return JSON.parse(argv[0])
	}

	// 形式二：单个 .json 文件路径（任何 shell 都安全，嵌套参数用这个）
	if (argv.length === 1 && /\.json$/i.test(argv[0].trim())) {
		// PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，JSON.parse 会因此报
		// "Unexpected token"；这里是模型最常见的写文件方式，所以必须吃掉 BOM。
		return JSON.parse(readFileSync(argv[0].trim(), 'utf8').replace(/^\uFEFF/, ''))
	}

	// 形式三：key=value（首选）
	if (argv.every((a) => a.includes('='))) {
		/** @type {Record<string, unknown>} */
		const out = {}
		for (const pair of argv) {
			const at = pair.indexOf('=')
			const key = pair.slice(0, at)
			if (key.length === 0) throw new Error(`参数 ${JSON.stringify(pair)} 缺少键名`)
			out[key] = coerce(pair.slice(at + 1))
		}
		return out
	}

	throw new Error('参数形式无法识别：请用 key=value、单个 JSON 字符串，或 .json 文件路径')
}

const USAGE = [
	'用法（四选一）：',
	'  node run.mjs action=phy encrypted=false',
	'  node run.mjs action=throughput phy=le-1m data_len_octets=251 encrypted=false conn_interval_ms=30',
	'  node run.mjs args.json',
	`  node run.mjs '{"action":"phy","encrypted":false}'`,
	'动作: throughput / conn-params / adv / phy',
].join('\n')

let args
try {
	args = parseArgs(process.argv.slice(2))
} catch (error) {
	console.error(`参数解析失败：${error instanceof Error ? error.message : String(error)}`)
	console.error(USAGE)
	process.exit(2)
}

if (args === undefined) {
	console.error(USAGE)
	process.exit(2)
}

try {
	const value = await tool.execute(args)
	// 先给人读的摘要行，再给完整结构（模型读 JSON 比读渲染文本更省事）
	const lines = tool.summaryLines(value)
	for (const line of lines) console.log(line)
	if (lines.length > 0) console.log('')
	console.log(JSON.stringify(value, null, 2))
} catch (error) {
	// 参数缺失/非法一律走这里：报错文案本身就是使用说明，直接透出
	console.error(`计算失败：${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
