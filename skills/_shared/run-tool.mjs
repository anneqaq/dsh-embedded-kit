#!/usr/bin/env node
/**
 * 技能随附脚本的**通用入口**。
 *
 * 为什么是一个通用入口而不是每个技能各带一份脚本：参数解析踩过两个真实的坑
 * （PowerShell 吃掉命令行双引号、PowerShell 5.1 写 UTF-8 带 BOM），
 * 每个技能复制一份就等于把这两个坑复制十几遍。这里只有一份。
 *
 * 它**不复制任何算法**：直接取插件里那个已测过的工具描述符并调用其 `execute()` ——
 * 参数校验、规范常量、checks/warnings/notes 全部来自同一份实现。所以把能力从工具
 * 列表摘下来（省掉每轮常驻 schema）时，一点正确性都不丢。
 *
 * 描述符有两个来源：
 *   - `integrate/*.tool.mjs`：导出的 `tool` 对象
 *   - `lib/index.js` 的 `TOOL_FACTORIES`：其余工具的工厂
 * 两者都能在宿主之外调用（见 lib/define-tool.js 的说明）。
 *
 * 用法（首选 key=value，任何 shell 都安全）：
 *   node run-tool.mjs i2c_bus mode=standard cb_pf=200 vdd_v=3.3
 *   node run-tool.mjs link_budget args.json        # 参数复杂（嵌套数组/对象）时写文件
 *   node run-tool.mjs sdio_speed '{"action":"init","clock_hz":400000}'   # bash 下可用
 *   node run-tool.mjs                              # 不带参数则列出可用工具
 *
 * @module dsh-embedded-kit/skills/_shared/run-tool
 */

import { readFileSync } from 'node:fs'

/** 工具名 → 导出 `tool` 对象的描述符模块。 */
const INTEGRATE_TOOLS = {
	ble_throughput: () => import('../../integrate/ble.tool.mjs'),
	canfd_timing: () => import('../../integrate/canfd.tool.mjs'),
	link_budget: () => import('../../integrate/linkbudget.tool.mjs'),
	lora_airtime: () => import('../../integrate/lora.tool.mjs'),
	pmbus_check: () => import('../../integrate/pmbus.tool.mjs'),
	sdio_speed: () => import('../../integrate/sdio.tool.mjs'),
	usb_bandwidth: () => import('../../integrate/usb.tool.mjs'),
}

/**
 * 按名字取描述符，两个来源都找。
 *
 * @param {string} name - 工具名。
 * @returns {Promise<{descriptor: object, source: string}|undefined>} 描述符与来源。
 */
async function loadDescriptor(name) {
	const integrate = INTEGRATE_TOOLS[name]
	if (integrate !== undefined) return { descriptor: (await integrate()).tool, source: 'integrate' }

	// 按需加载：只在这一支才把 lib/index.js 拉进来（它会带进全部 lib 模块）。
	// 先声明"允许透传"：脚本本来就跑在宿主之外，没有注册表可校验；
	// 不声明的话 lib/define-tool.js 会因为解析不到宿主包而直接抛错。
	process.env.DSH_EMBEDDED_KIT_ALLOW_TOOL_STUB = '1'
	const { TOOL_FACTORIES } = await import('../../lib/index.js')
	const factory = TOOL_FACTORIES[name]
	if (factory === undefined) return undefined
	return { descriptor: factory({}), source: 'lib' }
}

/** 列出两个来源的全部可用工具名。 */
async function listToolNames() {
	process.env.DSH_EMBEDDED_KIT_ALLOW_TOOL_STUB = '1'
	const { TOOL_FACTORIES } = await import('../../lib/index.js')
	return [...new Set([...Object.keys(INTEGRATE_TOOLS), ...Object.keys(TOOL_FACTORIES)])].sort()
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
	// 零参数：交给工具自己的校验去报"缺哪些必填项"——那份文案比这里能写的更准
	if (argv.length === 0) return {}
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
	for (const name of await listToolNames()) console.log(`  ${name}`)
	process.exit(toolName === undefined ? 2 : 0)
}

const loaded = await loadDescriptor(toolName)
if (loaded === undefined) {
	console.error(`未知工具 ${JSON.stringify(toolName)}`)
	console.error(`可用: ${(await listToolNames()).join(' / ')}`)
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

const { descriptor } = loaded

try {
	const value = await descriptor.execute(args)

	// 人读的摘要：integrate 系的描述符带 summaryLines；lib 系的带 output.render。
	// 两者都优先于裸 JSON —— 模型读结构化 JSON 没问题，但人看的时候可读性差得多。
	const lines = typeof descriptor.summaryLines === 'function' ? descriptor.summaryLines(value) : []
	if (lines.length > 0) {
		for (const line of lines) console.log(line)
	} else if (typeof descriptor.output?.render === 'function') {
		for (const block of descriptor.output.render(args, value)) {
			if (typeof block?.text === 'string') console.log(block.text)
		}
	}
	console.log('')
	console.log(JSON.stringify(value, null, 2))
} catch (error) {
	// 参数缺失/非法一律走这里：报错文案本身就是使用说明，直接透出
	console.error(`计算失败：${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}
