#!/usr/bin/env node
/**
 * 技能随附脚本的**通用入口**。
 *
 * 为什么是一个通用入口而不是每个技能各带一份脚本：参数解析踩过两个真实的坑
 * （PowerShell 吃掉命令行双引号、PowerShell 5.1 写 UTF-8 带 BOM），
 * 每个技能复制一份就等于把这两个坑复制五遍。这里只有一份。
 *
 * 它**不复制任何算法**：直接把 `integrate/*.tool.mjs` 的工具描述符当 CLI 用 ——
 * 参数校验、规范常量、checks/warnings/notes 全部来自同一个已测实现，
 * 所以把能力从工具列表摘下来（省掉每轮常驻 schema）时，一点正确性都不丢。
 *
 * 用法（首选 key=value，任何 shell 都安全）：
 *   node run-tool.mjs pmbus_check action=pec address7=0x5a read=true command=0x21
 *   node run-tool.mjs link_budget args.json        # 参数复杂（嵌套数组/对象）时写文件
 *   node run-tool.mjs sdio_speed '{"action":"init","clock_hz":400000}'   # bash 下可用
 *   node run-tool.mjs                              # 不带参数则列出可用工具
 *
 * @module dsh-embedded-kit/skills/_shared/run-tool
 */

import { readFileSync } from 'node:fs'

/**
 * 工具名 → 描述符模块。键名就是模型看到的工具名，便于按名字取用。
 * 只列 `integrate/` 下的描述符 —— 它们导出的 `tool` 对象带可直接调用的 `execute()`。
 */
const TOOLS = {
	ble_throughput: () => import('../../integrate/ble.tool.mjs'),
	canfd_timing: () => import('../../integrate/canfd.tool.mjs'),
	link_budget: () => import('../../integrate/linkbudget.tool.mjs'),
	lora_airtime: () => import('../../integrate/lora.tool.mjs'),
	pmbus_check: () => import('../../integrate/pmbus.tool.mjs'),
	sdio_speed: () => import('../../integrate/sdio.tool.mjs'),
	usb_bandwidth: () => import('../../integrate/usb.tool.mjs'),
}

/** 把 `key=value` 的值转成合适的类型：能当 JSON 解析就当，否则当字符串。 */
function coerce(raw) {
	try {
		return JSON.parse(raw)
	} catch {
		return raw
	}
}

/**
 * 解析去掉工具名之后的参数。
 *
 * @param {string[]} argv - 参数。
 * @returns {Record<string, unknown>} 工具入参对象。
 * @throws {Error} 形式无法识别时抛出。
 */
function parseArgs(argv) {
	if (argv.length === 1 && argv[0].trimStart().startsWith('{')) {
		return JSON.parse(argv[0])
	}
	if (argv.length === 1 && /\.json$/i.test(argv[0].trim())) {
		// PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，JSON.parse 会因此
		// 报 "Unexpected token"；这是模型写参数文件最常见的方式，所以必须吃掉 BOM。
		return JSON.parse(readFileSync(argv[0].trim(), 'utf8').replace(/^\uFEFF/, ''))
	}
	if (argv.length > 0 && argv.every((a) => a.includes('='))) {
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

const [toolName, ...rest] = process.argv.slice(2)

if (toolName === undefined || toolName === '-h' || toolName === '--help') {
	console.log('用法: node run-tool.mjs <工具名> [key=value … | args.json | \'{"…"}\']')
	console.log('可用工具:')
	for (const name of Object.keys(TOOLS)) console.log(`  ${name}`)
	process.exit(toolName === undefined ? 2 : 0)
}

const loader = TOOLS[toolName]
if (loader === undefined) {
	console.error(`未知工具 ${JSON.stringify(toolName)}。可用: ${Object.keys(TOOLS).join(' / ')}`)
	process.exit(2)
}

let args
try {
	args = parseArgs(rest)
} catch (error) {
	console.error(`参数解析失败：${error instanceof Error ? error.message : String(error)}`)
	console.error(`用法: node run-tool.mjs ${toolName} key=value …`)
	process.exit(2)
}

const { tool } = await loader()

try {
	const value = await tool.execute(args)
	// 先给人读的摘要行，再给完整结构（模型读 JSON 比读渲染文本更省事）
	const lines = typeof tool.summaryLines === 'function' ? tool.summaryLines(value) : []
	for (const line of lines) console.log(line)
	if (lines.length > 0) console.log('')
	console.log(JSON.stringify(value, null, 2))
} catch (error) {
	// 参数缺失/非法一律走这里：报错文案本身就是使用说明，直接透出
	console.error(`计算失败：${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
