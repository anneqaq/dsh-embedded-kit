/**
 * Keil MDK 命令行构建（`UV4.exe -b`）。
 *
 * 关键事实（决定了本模块的形状）：
 *   - UV4.exe 是 **GUI 子系统程序**，没有控制台输出，所以**必须**用 `-o <logfile>`
 *     落一个日志文件，再从日志里读结果。指望 stdout 会永远拿到空串。
 *   - 退出码语义在不同 Keil 版本间并不一致，因此**不把退出码当作结论**，
 *     结论一律取自日志末尾的 `N Error(s), M Warning(s)` 行；退出码只作参考上报。
 *   - 日志编码跟随系统区域设置：中文 Windows 上常是 GBK。按 UTF-8 硬读会把中文路径
 *     变成乱码，所以这里做编码探测并把实际使用的编码回报出来。
 *
 * @module dsh-embedded-kit/keil
 */

import { execFile } from 'node:child_process'
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { TextDecoder } from 'node:util'
import { killProcessTree } from './proctree.js'

/** 本机实测存在的默认 uVision 可执行文件路径。 */
export const DEFAULT_UV4_PATH = 'C:\\Keil_v5\\UV4\\UV4.exe'
/** 构建默认超时（毫秒）—— 绝不允许无限等待。 */
export const DEFAULT_BUILD_TIMEOUT_MS = 300_000

/** 构建模式 → UV4 参数。 */
const MODE_FLAGS = {
	build: '-b',
	rebuild: '-r',
}

/**
 * 解析要使用的 UV4 可执行文件路径。
 *
 * 优先级：显式配置 > 环境变量 `KEIL_UV4` > 默认路径。
 *
 * @param {object} [config] - 插件配置。
 * @param {string} [config.uv4Path] - 显式指定的 UV4 路径。
 * @returns {{path: string, source: string, exists: boolean}} 解析结果。
 */
export function resolveUv4Path(config = {}) {
	let path = config.uv4Path || process.env.KEIL_UV4 || DEFAULT_UV4_PATH
	const source = config.uv4Path ? '配置' : process.env.KEIL_UV4 ? '环境变量 KEIL_UV4' : '默认路径'
	return { path, source, exists: existsSync(path) }
}

/**
 * 按编码探测把日志字节解成文本。
 *
 * 先用严格 UTF-8 试解；失败则退回 GBK（中文 Windows 的常见编码，同样用 fatal 严格模式，
 * 否则 TextDecoder 对任意字节都解出 U+FFFD 而不抛错，latin1 兜底就永远不可达）；
 * 再失败退回 latin1，保证永远能拿到可读文本而不是抛错。
 *
 * @param {Buffer} buffer - 日志原始字节。
 * @returns {{text: string, encoding: string}} 文本与实际使用的编码。
 */
export function decodeLog(buffer) {
	try {
		return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8' }
	} catch {
		// 继续尝试 GBK。
	}
	try {
		return { text: new TextDecoder('gbk', { fatal: true }).decode(buffer), encoding: 'gbk' }
	} catch {
		// 继续尝试 latin1。
	}
	return { text: buffer.toString('latin1'), encoding: 'latin1' }
}

/** 日志末尾的结论行：`"project.uvprojx" - 0 Error(s), 2 Warning(s).` */
const SUMMARY_RE = /(\d+)\s+Error\(s\)\s*,\s*(\d+)\s+Warning\(s\)/i

/**
 * 从构建日志里抽取错误、警告与结论。
 *
 * @param {string} text - 日志文本。
 * @returns {{summary: {errors: number, warnings: number}|null,
 *            errors: string[], warnings: string[], truncated: boolean}}
 *   抽取结果；`truncated` 表示日志过长被截断。
 */
export function parseBuildLog(text) {
	const lines = text.split(/\r?\n/)
	/** @type {string[]} */
	const errors = []
	/** @type {string[]} */
	const warnings = []
	/** @type {{errors: number, warnings: number}|null} */
	let summary = null

	for (const raw of lines) {
		const line = raw.trim()
		if (line.length === 0) continue

		const m = SUMMARY_RE.exec(line)
		if (m) {
			// 结论行本身会被 /error/i 命中，必须先识别并抽走。
			summary = { errors: Number(m[1]), warnings: Number(m[2]) }
			continue
		}
		if (/error/i.test(line)) errors.push(line)
		else if (/warning/i.test(line)) warnings.push(line)
	}

	return {
		summary,
		errors: dedupe(errors),
		warnings: dedupe(warnings),
		truncated: false,
	}
}

/**
 * 去重并保留首次出现顺序。
 * @param {string[]} items - 原始列表。
 * @returns {string[]} 去重后的列表。
 */
function dedupe(items) {
	return Array.from(new Set(items))
}

/**
 * 调用 UV4 构建一个 Keil 工程。
 *
 * @param {object} spec - 构建输入。
 * @param {string} spec.project - `.uvprojx` 工程文件路径。
 * @param {string} [spec.target] - 目标名（对应 `-t`）。
 * @param {'build'|'rebuild'} [spec.mode] - 增量构建或全量重建，默认 build。
 * @param {number} [spec.timeoutMs] - 超时（毫秒），默认 300000。
 * @param {AbortSignal} [spec.signal] - 外部取消信号（来自工具调用的 `exec.signal`）。
 * @param {object} [config] - 插件配置，用于解析 UV4 路径。
 * @returns {Promise<object>} 构建结果；超时或日志缺失时也返回结构化结果而非抛错。
 * @throws {Error} 工程路径非法或 UV4 不存在时抛出（属调用方参数错误）。
 */
export async function buildWithUv4(spec, config = {}) {
	const {
		project,
		target,
		mode = 'build',
		timeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
		signal,
	} = spec

	if (typeof project !== 'string' || project.trim().length === 0) {
		throw new Error('必须提供 .uvprojx 工程路径')
	}
	const projectPath = resolve(project)
	const flag = MODE_FLAGS[mode]
	if (!flag) throw new Error(`构建模式只能是 build 或 rebuild，收到 ${mode}`)

	const uv4 = resolveUv4Path(config)
	if (!uv4.exists) {
		throw new Error(`未找到 UV4 可执行文件：${uv4.path}（来源：${uv4.source}）`)
	}
	if (!existsSync(projectPath)) {
		throw new Error(`工程文件不存在：${projectPath}`)
	}

	const tmpDir = await mkdtemp(join(tmpdir(), 'dsh-ek-keil-'))
	const logPath = join(tmpDir, 'build.log')

	const args = [flag, projectPath, '-o', logPath]
	if (typeof target === 'string' && target.trim().length > 0) args.push('-t', target)

	const startedAt = Date.now()
	let exitCode = null
	let timedOut = false
	let spawnError = null

	try {
		exitCode = await runUv4(uv4.path, args, timeoutMs, tmpDir, signal)
	} catch (error) {
		if (error && error.timedOut === true) timedOut = true
		else if (error && error.name === 'AbortError') {
			spawnError = '调用被取消（exec.signal 已 abort），子进程树已终止'
		} else spawnError = error instanceof Error ? error.message : String(error)
		exitCode = typeof error?.code === 'number' ? error.code : null
	}

	const durationMs = Date.now() - startedAt
	let logText = ''
	let encoding = 'none'
	let logPresent = false

	try {
		const info = await stat(logPath)
		if (info.size > 0) {
			logPresent = true
			const decoded = decodeLog(await readFile(logPath))
			logText = decoded.text
			encoding = decoded.encoding
		}
	} catch {
		// 日志没生成：UV4 可能在启动阶段就失败了，保持 logPresent=false。
	}

	const parsed = logPresent
		? parseBuildLog(logText)
		: { summary: null, errors: [], warnings: [], truncated: false }

	const result = {
		project: projectPath,
		target: target ?? null,
		mode,
		uv4: { path: uv4.path, source: uv4.source },
		exitCode,
		durationMs,
		timedOut,
		spawnError,
		logPresent,
		logEncoding: encoding,
		summary: parsed.summary,
		errors: parsed.errors,
		warnings: parsed.warnings,
		// 结论的权威性：有结论行才算确定，否则只能凭日志内容推断。
		verdict: deriveVerdict(parsed, timedOut, logPresent),
		notes: [],
	}

	if (timedOut) {
		result.notes.push(`构建超过 ${timeoutMs}ms 被强制终止（已杀整棵进程树 —— UV4 是 GUI 壳，真实编译在它拉起的 armclang/armasm 子进程里，只杀 UV4 会留下孤儿进程继续占 CPU）。`)
	}
	if (!logPresent) {
		result.notes.push(
			'UV4 未生成日志文件。常见成因：另一个 uVision 实例正打开该工程、工程路径错误、或 Keil 授权无效。',
		)
	}
	if (encoding === 'gbk') {
		result.notes.push('日志按 GBK 解码（中文 Windows 的常见编码）。')
	}
	if (parsed.summary === null && logPresent) {
		result.notes.push('日志中未找到 `N Error(s), M Warning(s)` 结论行，结论可能不完整。')
	}

	// 临时目录里的日志已读入内存，清理掉，避免在 %TEMP% 里堆积构建日志。
	await rm(tmpDir, { recursive: true, force: true }).catch(() => {})

	return result
}

/**
 * 执行 UV4 并等待退出。
 *
 * 不用 execFile 自带的 timeout：它只 terminate UV4.exe 这个 GUI 壳本身，
 * 真实编译进程（armclang/armasm）是孙进程会变成孤儿继续跑。
 * 这里自己计时，到点用 `taskkill /T /F`（或 POSIX 组杀）杀整棵树。
 *
 * @param {string} exe - UV4 可执行文件路径。
 * @param {string[]} args - 参数表。
 * @param {number} timeoutMs - 超时毫秒数。
 * @param {string} cwd - 工作目录。
 * @param {AbortSignal} [signal] - 外部取消信号，abort 时子进程树被终止。
 * @returns {Promise<number>} 退出码。
 */
function runUv4(exe, args, timeoutMs, cwd, signal) {
	return new Promise((resolvePromise, rejectPromise) => {
		/** @type {import('node:child_process').ChildProcess | undefined} */
		let child
		let timedOutLocal = false
		const timer = setTimeout(() => {
			timedOutLocal = true
			killProcessTree(child?.pid)
		}, timeoutMs)

		try {
			child = execFile(
				exe,
				args,
				{
					cwd,
					windowsHide: true,
					maxBuffer: 8 * 1024 * 1024,
					detached: process.platform !== 'win32',
					signal,
				},
				(error, stdout, stderr) => {
					clearTimeout(timer)
					void stdout
					void stderr
					if (error) {
						if (timedOutLocal) {
							const timeoutError = new Error(`UV4 构建超过 ${timeoutMs}ms 被强制终止`)
							timeoutError.timedOut = true
							if (typeof error.code === 'number') timeoutError.code = error.code
							return rejectPromise(timeoutError)
						}
						// 非零退出（含 maxBuffer 截断）都走这里；把退出码挂在 error 上供调用方读取。
						if (typeof error.code !== 'number') {
							error.code = error.killed === true ? null : 1
						}
						return rejectPromise(error)
					}
					resolvePromise(0)
				},
			)
		} catch (error) {
			clearTimeout(timer)
			rejectPromise(error)
		}

		// execFile 的 signal 选项只杀直接子进程；这里补杀整棵树。
		if (signal) {
			signal.addEventListener(
				'abort',
				() => killProcessTree(child?.pid),
				{ once: true },
			)
		}
	})
}

/**
 * 由日志结论推导构建判定。
 *
 * @param {{summary: {errors: number, warnings: number}|null, errors: string[]}} parsed - 解析结果。
 * @param {boolean} timedOut - 是否超时。
 * @param {boolean} logPresent - 日志是否存在。
 * @returns {'success'|'warnings'|'failed'|'unknown'} 判定。
 */
function deriveVerdict(parsed, timedOut, logPresent) {
	if (timedOut) return 'failed'
	if (parsed.summary) {
		if (parsed.summary.errors > 0) return 'failed'
		if (parsed.summary.warnings > 0) return 'warnings'
		return 'success'
	}
	// 没拿到结论行：只能凭日志里有没有 error 字样推断，并明确标为 unknown 更诚实。
	if (!logPresent) return 'unknown'
	if (parsed.errors.length > 0) return 'failed'
	return 'unknown'
}
