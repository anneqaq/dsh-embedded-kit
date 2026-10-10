/**
 * 技能加载与注册。
 *
 * `skills/<name>/SKILL.md` 是**单一真源**：Markdown 带 YAML frontmatter，
 * 本模块读文件、拆 frontmatter、把正文注册成 DSH 运行时技能。
 * 这样改技能只要编辑 Markdown，不用碰 JS。
 *
 * 容错原则：单个技能文件缺失或格式坏掉时**只跳过它并记警告**，
 * 绝不因此让整个插件挂载失败 —— 工具部分必须照常可用。
 *
 * @module dsh-embedded-kit/skills
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 插件包根目录。技能正文里的 `{{PLUGIN_ROOT}}` 会被替换成它。 */
export const PLUGIN_ROOT = join(HERE, '..')

/** 技能根目录（插件包内）。 */
export const SKILLS_ROOT = join(PLUGIN_ROOT, 'skills')

/** 本插件随包发布的技能名（kebab-case，与目录名一致）。 */
export const SKILL_NAMES = [
	'embedded-code-review',
	'protocol-review',
	'fw-size-optimization',
	'scheduling-patterns',
	'low-power-and-leakage',
	'code-standards',
	'fault-diagnosis',
	'debug-methodology',
	'nvm-storage',
	'lvgl-patterns',
	'architecture-principles',
	'ble-throughput',
	'pmbus-check',
	'link-budget',
	'usb-bandwidth',
	'sdio-speed',
	'power-and-io',
	'bus-timing',
	'mcu-core',
	'storage-and-display',
	'lora-airtime',
]

/**
 * 拆出 YAML frontmatter 与正文。
 *
 * 只支持顶层 `key: value` 这一种形式 —— 本项目技能文件只用得到这一种，
 * 引入完整 YAML 解析器不值得。
 *
 * @param {string} text - SKILL.md 全文。
 * @returns {{meta: Record<string, string>, body: string}} 元信息与正文。
 */
export function parseSkillFile(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
	if (!match) return { meta: {}, body: text.trim() }

	/** @type {Record<string, string>} */
	const meta = {}
	for (const line of match[1].split(/\r?\n/)) {
		const trimmed = line.trim()
		if (trimmed.length === 0 || trimmed.startsWith('#')) continue
		const idx = trimmed.indexOf(':')
		if (idx <= 0) continue
		const key = trimmed.slice(0, idx).trim()
		const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '')
		if (key.length > 0 && value.length > 0) meta[key] = value
	}
	return { meta, body: text.slice(match[0].length).trim() }
}

/**
 * 从磁盘加载一个技能。
 *
 * @param {string} skillName - 技能名（同时是目录名）。
 * @param {string} [root] - 技能根目录，默认随包目录。
 * @returns {{name: string, description: string, whenToUse: string|undefined, content: string}}
 *   可供 `ctx.skills.register()` 使用的字段。
 * @throws {Error} 文件不存在或缺少必要元信息时抛出。
 */
export function loadSkill(skillName, root = SKILLS_ROOT) {
	const file = join(root, skillName, 'SKILL.md')
	const { meta, body } = parseSkillFile(readFileSync(file, 'utf8'))

	if (body.length === 0) throw new Error(`${skillName}: SKILL.md 正文为空`)
	if (!meta.description) throw new Error(`${skillName}: frontmatter 缺少 description`)

	return {
		name: meta.name || skillName,
		description: meta.description,
		whenToUse: meta.whenToUse,
		// 技能里的随附脚本要用绝对路径才能被模型直接执行，而插件装到哪个 profile
		// 由宿主决定（profile 目录随用户而异），所以路径在注册时才确定 ——
		// 正文写占位符，这里替换成实际安装位置。
		content: body.replaceAll('{{PLUGIN_ROOT}}', PLUGIN_ROOT),
	}
}

/**
 * 把随包技能注册进 `ctx.skills`。
 *
 * 设计取舍：本插件的 `inject` **只声明 `tools`**，技能服务是**尽力而为**的 ——
 * 因为一旦把 `skills` 写进 inject，而当前 profile 的组装里没有该服务，
 * 整个插件会一直停在 pending 状态，**连工具都用不了**。
 * 拿不到技能服务时只记警告，工具照常工作。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {object} [options] - 选项。
 * @param {string} [options.root] - 技能根目录。
 * @param {boolean} [options.enabled] - 是否注册技能，默认 true。
 * @returns {{registered: string[], skipped: Array<{name: string, reason: string}>, available: boolean}}
 *   注册结果汇总。
 */
export function registerSkills(ctx, options = {}) {
	const { root = SKILLS_ROOT, enabled = true } = options
	/** @type {string[]} */
	const registered = []
	/** @type {Array<{name: string, reason: string}>} */
	const skipped = []

	if (!enabled) {
		return { registered, skipped, available: true }
	}

	// 取技能服务必须是"软访问"：cordis 4 的 context proxy 在访问未 inject 的服务时
	// **抛错**而非返回 undefined（reflect.ts: `cannot get property "X" without inject`），
	// 所以直接 Reflect.get 会把"力所不及就跳过"变成"整个插件挂载失败"。
	// 这里吞掉异常退回 undefined，本模块的降级语义（工具照常、技能可缺）才成立。
	/** @type {any} */
	let skills
	try {
		skills = Reflect.get(ctx, 'skills')
	} catch {
		skills = undefined
	}
	if (skills === undefined || typeof skills.register !== 'function') {
		for (const skillName of SKILL_NAMES) {
			skipped.push({
				name: skillName,
				reason: 'ctx.skills 不可用（当前 profile 未启用技能服务）；技能正文仍在插件包 skills/ 下可直接阅读',
			})
		}
		return { registered, skipped, available: false }
	}

	for (const skillName of SKILL_NAMES) {
		try {
			const skill = loadSkill(skillName, root)
			skills.register({
				name: skill.name,
				description: skill.description,
				...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
				content: skill.content,
				source: 'runtime',
				provider: 'dsh-embedded-kit',
			})
			registered.push(skill.name)
		} catch (error) {
			skipped.push({
				name: skillName,
				reason: error instanceof Error ? error.message : String(error),
			})
		}
	}

	return { registered, skipped, available: true }
}
