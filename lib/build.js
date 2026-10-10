/**
 * 多工具链构建（通用）。
 *
 * 不绑定任何一家 IDE。每个工具链是一个后端，统一契约：
 * 构造 argv → 跑进程 → 抓日志 → 解析错误/警告 → 给判定。
 *
 * 支持的后端：
 *   - `keil`        Keil MDK（`UV4.exe -b/-r`，GUI 程序必须用 `-o` 落日志）
 *   - `platformio`  PlatformIO（`pio run`）
 *   - `cmake`       CMake 构建（`cmake --build`，覆盖 Ninja / Makefile / MSBuild 生成器，
 *                   是覆盖面最广的一条路）
 *   - `make`        GNU Make / mingw32-make / gmake
 *   - `idf`         ESP-IDF（`idf.py build`）
 *   - `iar`         IAR（`IarBuild.exe` / `iarbuild.exe`）
 *   - `custom`      任意命令，**以 argv 数组传入，不经 shell**（避免注入）
 *
 * 两类事实必须分开报告，不能混为一谈：
 *   1. **可执行文件是否探测到**（`probeToolchains`）—— 本机可实测
 *   2. **实际构建是否成功** —— 需要真实工程，本模块在真实工程上**未经验证**
 * 工具输出会如实区分这两者。
 *
 * @module dsh-embedded-kit/build
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import { buildWithUv4, decodeLog, DEFAULT_UV4_PATH } from './keil.js'
import { killProcessTree } from './proctree.js'

/** 构建默认超时（毫秒）—— 绝不允许无限等待。 */
export const DEFAULT_BUILD_TIMEOUT_MS = 300_000

/**
 * 后端定义。
 *
 * `probe(config)` 返回本机可执行文件位置；`build(spec, config)` 执行构建。
 * `verified` 表示该后端是否在真实工程上验证过 —— 当前**全部为 false**，如实标注。
 */
export const BACKENDS = {
	keil: {
		id: 'keil',
		label: 'Keil MDK',
		verified: false,
		verifiedNote: 'UV4 存在性与参数用法已核对，但未在真实 .uvprojx 上跑过构建',
		probe: (config) => {
			const p = config?.uv4Path || process.env.KEIL_UV4 || DEFAULT_UV4_PATH
			return existsSync(p) ? { exe: p, hint: null } : { exe: null, hint: `未找到 UV4：${p}` }
		},
		build: async (spec, config) => {
			const r = await buildWithUv4(
				{
					project: spec.project,
					target: spec.target,
					mode: spec.mode ?? 'build',
					...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
					signal: spec.signal,
				},
				config,
			)
			return { ...r, toolchain: 'keil', toolchainLabel: 'Keil MDK' }
		},
	},

	platformio: {
		id: 'platformio',
		label: 'PlatformIO',
		verified: false,
		verifiedNote: '命令依据 PlatformIO 官方 CLI 文档构造，未在真实工程上验证',
		probe: () => {
			const local = join(homedir(), '.platformio', 'penv', 'Scripts', 'pio.exe')
			const found = findExecutable(['pio', 'platformio'], [local])
			if (found) return { exe: found, hint: null }
			// pip 装出来的常是 pio.cmd / platformio.cmd 包装器 —— execFile 不经 shell 跑不了它们，
			// 探测到也算"不可用"，但要在 hint 里说清楚为什么、怎么修。
			const wrapper = findFile(['pio.cmd', 'platformio.cmd', 'pio.bat'])
			const hint = wrapper
				? `探测到包装器 ${wrapper}，但 execFile（不经 shell）无法直接执行 .cmd/.bat —— 请使用 ${local}，或把 toolchain 设为 custom 并经 shell 调用`
				: '未找到 pio（可 pip install platformio）'
			return { exe: null, hint }
		},
		build: async (spec, config) => {
			const pio = BACKENDS.platformio.probe(config).exe
			if (!pio) throw new Error('未找到 pio 可执行文件')
			const args = ['run']
			if (spec.env) args.push('-e', spec.env)
			if (spec.target) args.push('-t', spec.target)
			return runGeneric('platformio', 'PlatformIO', pio, args, spec)
		},
	},

	cmake: {
		id: 'cmake',
		label: 'CMake',
		verified: false,
		verifiedNote: '命令依据 CMake 官方文档构造，未在真实工程上验证',
		probe: () => {
			const found = findExecutable(['cmake'])
			return found ? { exe: found, hint: null } : { exe: null, hint: '未找到 cmake' }
		},
		build: async (spec, config) => {
			const exe = BACKENDS.cmake.probe(config).exe
			if (!exe) throw new Error('未找到 cmake 可执行文件')
			// project 指向**构建目录**（含 CMakeCache.txt）或源目录。
			const args = ['--build', spec.project]
			if (spec.target) args.push('--target', spec.target)
			if (spec.buildType) args.push('--config', spec.buildType)
			return runGeneric('cmake', 'CMake', exe, args, spec)
		},
	},

	make: {
		id: 'make',
		label: 'GNU Make',
		verified: false,
		verifiedNote: '命令依据 GNU Make 文档构造，未在真实工程上验证',
		probe: () => {
			// Windows 上常见的是 mingw32-make；也兼容 gmake（BSD / macOS）。
			const found = findExecutable(['make', 'mingw32-make', 'gmake'])
			return found ? { exe: found, hint: null } : { exe: null, hint: '未找到 make / mingw32-make / gmake' }
		},
		build: async (spec, config) => {
			const exe = BACKENDS.make.probe(config).exe
			if (!exe) throw new Error('未找到 make 可执行文件')
			const args = spec.target ? [spec.target] : []
			return runGeneric('make', 'GNU Make', exe, args, spec)
		},
	},

	idf: {
		id: 'idf',
		label: 'ESP-IDF',
		verified: false,
		verifiedNote: '命令依据 ESP-IDF 文档构造，未在真实工程上验证',
		probe: () => {
			// Windows 安装器会放一个 idf.py.exe 控制台壳（可直接 execFile）；
			// 激活脚本放进 PATH 的裸 idf.py 是 Python 脚本 —— 必须经 python 解释器运行。
			const exeShim = findExecutable(['idf.py', 'idf.py.exe'])
			if (exeShim && exeShim.toLowerCase().endsWith('.exe')) return { exe: exeShim, hint: null }
			const script = exeShim ?? findFile(['idf.py'])
			if (script) {
				const python = findExecutable(['python', 'python3'])
				if (python) return { exe: python, hint: null }
				return { exe: null, hint: `找到 ${script} 但未找到 python 解释器（idf.py 是 Python 脚本，需经 python 运行）` }
			}
			return {
				exe: null,
				hint: '未找到 idf.py（通常需先 source export.sh / 运行 export.bat 激活 IDF 环境）',
			}
		},
		build: async (spec, config) => {
			const probe = BACKENDS.idf.probe(config)
			if (!probe.exe) throw new Error(probe.hint ?? '未找到 idf.py 可执行文件')
			// 裸 idf.py 脚本要作为 python 的第一个参数；.exe 壳直接跑。
			// 工程目录经 runGeneric 的 cwd 传入（idf.py 以当前目录为工程根）。
			const script = findFile(['idf.py'])
			const args = script && !probe.exe.toLowerCase().endsWith('idf.py.exe')
				? [script, 'build']
				: ['build']
			return runGeneric('idf', 'ESP-IDF', probe.exe, args, spec)
		},
	},

	iar: {
		id: 'iar',
		label: 'IAR Embedded Workbench',
		verified: false,
		verifiedNote: '命令依据 IAR 文档构造，未在真实工程上验证；IarBuild 与 iarbuild 的参数形式略有差异',
		probe: () => {
			// IAR 的固定安装布局是 <root>\<产品目录>\common\bin\IarBuild.exe ——
			// 只查安装根目录找不到。
			const roots = ['C:\\Program Files\\IAR Systems', 'C:\\Program Files (x86)\\IAR Systems']
			const candidates = []
			for (const root of roots) {
				candidates.push(root)
				try {
					for (const sub of readdirSync(root)) {
						candidates.push(join(root, sub, 'common', 'bin'))
					}
				} catch {
					// 根目录不存在或不可读：只保留根目录候选。
				}
			}
			const found = findExecutable(['IarBuild', 'IarBuild.exe', 'iarbuild', 'iarbuild.exe'], candidates)
			return found ? { exe: found, hint: null } : { exe: null, hint: '未找到 IarBuild / iarbuild（在 IAR 安装目录的 <产品>\\common\\bin 下）' }
		},
		build: async (spec, config) => {
			const exe = BACKENDS.iar.probe(config).exe
			if (!exe) throw new Error('未找到 IarBuild / iarbuild 可执行文件')
			// project 指向 .ewp；目标配置名对应 IAR 的 Build Configuration。
			const args = [spec.project, '-build']
			if (spec.target) args.push(spec.target)
			return runGeneric('iar', 'IAR', exe, args, spec)
		},
	},

	custom: {
		id: 'custom',
		label: '自定义命令',
		verified: false,
		verifiedNote: '命令由调用方提供，不适用"已验证"概念',
		probe: () => ({ exe: null, hint: 'custom 后端由调用方提供 command，不做探测' }),
		build: async (spec, config) => {
			if (typeof spec.command !== 'string' || spec.command.trim() === '') {
				throw new Error('custom 后端必须提供 command（可执行文件路径）')
			}
			// args 必须是字符串数组：直接传给 execFile，**不经 shell**，因此没有注入面。
			const args = Array.isArray(spec.args) ? spec.args.map(String) : []
			return runGeneric('custom', '自定义命令', spec.command, args, spec)
		},
	},
}

/** 全部后端 id。 */
export const TOOLCHAIN_IDS = Object.keys(BACKENDS)

/**
 * 探测本机各个工具链的可用性。
 *
 * @param {object} [config] - 插件配置（用于 keil 的 uv4Path 覆盖）。
 * @returns {Array<{id: string, label: string, available: boolean, exe: string|null, hint: string|null, verified: boolean}>}
 *   探测结果。
 */
export function probeToolchains(config = {}) {
	return TOOLCHAIN_IDS.map((id) => {
		const backend = BACKENDS[id]
		let probe = { exe: null, hint: null }
		try {
			probe = backend.probe(config)
		} catch (error) {
			probe = { exe: null, hint: error instanceof Error ? error.message : String(error) }
		}
		return {
			id,
			label: backend.label,
			available: probe.exe !== null,
			exe: probe.exe,
			hint: probe.hint,
			verified: backend.verified,
		}
	})
}

/**
 * 执行一次构建。
 *
 * @param {object} spec - 构建输入。
 * @param {'keil'|'platformio'|'cmake'|'make'|'idf'|'iar'|'custom'} spec.toolchain - 后端 id。
 * @param {string} spec.project - 工程文件 / 构建目录路径。
 * @param {string} [spec.target] - 目标（Keil 的 target / make 的 target 等）。
 * @param {string} [spec.env] - PlatformIO 的环境名。
 * @param {'build'|'rebuild'} [spec.mode] - 仅 Keil 使用。
 * @param {number} [spec.timeoutMs] - 超时毫秒。
 * @param {AbortSignal} [spec.signal] - 取消信号。
 * @param {string} [spec.command] - custom 后端的可执行文件。
 * @param {string[]} [spec.args] - custom 后端的参数数组。
 * @param {object} [config] - 插件配置。
 * @returns {Promise<object>} 归一化构建结果。
 * @throws {Error} 后端未知或参数缺失时抛出。
 */
export async function runBuild(spec, config = {}) {
	const backend = BACKENDS[spec.toolchain]
	if (!backend) {
		throw new Error(`未知工具链 '${spec.toolchain}'。可用：${TOOLCHAIN_IDS.join(', ')}`)
	}
	if (backend.id !== 'custom' && (typeof spec.project !== 'string' || spec.project.trim() === '')) {
		throw new Error(`${backend.label} 后端必须提供 project 路径`)
	}
	const result = await backend.build(spec, config)
	return { ...result, backendVerified: backend.verified, backendVerifiedNote: backend.verifiedNote }
}

/**
 * 通用后端执行：跑进程、抓输出、解析日志。
 *
 * @param {string} id - 后端 id。
 * @param {string} label - 展示名。
 * @param {string} exe - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {object} spec - 原始 spec。
 * @returns {Promise<object>} 归一化结果。
 */
async function runGeneric(id, label, exe, args, spec) {
	const timeoutMs = spec.timeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS
	const cwd = spec.project && existsSync(spec.project) ? spec.project : process.cwd()
	const startedAt = Date.now()

	let exitCode = null
	let timedOut = false
	let outputTruncated = false
	let spawnError = null
	let stdout = ''
	let stderr = ''

	try {
		const r = await runProcess(exe, args, { cwd, timeoutMs, signal: spec.signal })
		exitCode = r.exitCode
		stdout = r.stdout
		stderr = r.stderr
	} catch (error) {
		// 归因顺序很重要：maxBuffer 截断时 Node 也把 killed 置 true，先判 code 才不会误报成超时。
		if (error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
			outputTruncated = true
		} else if (error && error.timedOut === true) {
			timedOut = true
		} else if (error && error.name === 'AbortError') {
			spawnError = '调用被取消（exec.signal 已 abort），子进程树已终止'
		} else {
			spawnError = error instanceof Error ? error.message : String(error)
		}
		exitCode = typeof error?.code === 'number' ? error.code : null
		stdout = error?.stdout ?? ''
		stderr = error?.stderr ?? ''
	}

	const durationMs = Date.now() - startedAt
	// 命令行工具直接把输出写在 stdout/stderr，无需像 Keil 那样读日志文件。
	const combined = stderr.length > 0 ? `${stdout}\n${stderr}` : stdout
	const parsed = parseToolchainLog(combined)

	const notes = []
	if (timedOut) notes.push(`构建超过 ${timeoutMs}ms 被强制终止（已杀整棵进程树，含工具链拉起的子进程）。`)
	if (outputTruncated) {
		notes.push('构建输出超过 16 MB 缓冲上限被截断，进程已终止。日志解析基于截断后的输出，错误统计可能不完整 —— 大型工程可调大输出缓冲或改用落盘日志的构建方式。')
	}
	if (spawnError) notes.push(`进程未能正常完成：${spawnError}`)
	notes.push(`执行命令：${exe} ${args.join(' ')}`)
	notes.push('命令行工具链的输出按 stdout/stderr 直接解析；不同版本措辞可能有差异。')

	return {
		toolchain: id,
		toolchainLabel: label,
		project: spec.project ?? null,
		target: spec.target ?? null,
		mode: spec.mode ?? null,
		command: exe,
		args,
		cwd,
		exitCode,
		durationMs,
		timedOut,
		outputTruncated,
		spawnError,
		logPresent: combined.trim().length > 0,
		logEncoding: 'utf-8（子进程管道，未做编码探测）',
		summary: parsed.summary,
		errors: parsed.errors,
		warnings: parsed.warnings,
		verdict: deriveVerdict(parsed, timedOut, outputTruncated, exitCode, combined),
		notes,
	}
}

/**
 * 跑一个子进程并捕获输出。
 *
 * 超时/取消/输出超限都会**杀整棵进程树**（工具链壳进程拉起的编译器是孙进程，
 * 只杀直接子进程会留孤儿）—— 这就是不用 execFile 自带 timeout 的原因：
 * 它只 terminate 直接子进程，且把 maxBuffer 截断与超时混在同一个 killed 标志里。
 *
 * @param {string} exe - 可执行文件。
 * @param {string[]} args - 参数。
 * @param {object} opts - 选项（cwd / timeoutMs / signal）。
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string}>} 结果。
 * @throws {Error} 超时错误带 `timedOut: true`；abort 为 AbortError；
 *   输出超限保留 Node 原生 `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` code。
 */
function runProcess(exe, args, opts) {
	return new Promise((resolvePromise, rejectPromise) => {
		/** @type {import('node:child_process').ChildProcess | undefined} */
		let child
		let timedOutLocal = false
		const timer = setTimeout(() => {
			timedOutLocal = true
			killProcessTree(child?.pid)
		}, opts.timeoutMs)

		try {
			child = execFile(
				exe,
				args,
				{
					cwd: opts.cwd,
					windowsHide: true,
					maxBuffer: 16 * 1024 * 1024,
					// POSIX 上让子进程自成进程组，kill(-pid) 才能杀整组；
					// Windows 用 taskkill /T 杀树，不需要 detached。
					detached: process.platform !== 'win32',
					signal: opts.signal,
				},
				(error, stdout, stderr) => {
					clearTimeout(timer)
					if (error) {
						error.stdout = stdout
						error.stderr = stderr
						if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
							// 截断只杀了直接子进程，树里的孙进程可能还活着 —— 补杀整棵树。
							killProcessTree(child?.pid)
						}
						if (timedOutLocal) {
							const timeoutError = new Error(`构建超过 ${opts.timeoutMs}ms 被强制终止`)
							timeoutError.timedOut = true
							timeoutError.stdout = stdout
							timeoutError.stderr = stderr
							return rejectPromise(timeoutError)
						}
						if (typeof error.code !== 'number') error.code = error.killed === true ? null : 1
						return rejectPromise(error)
					}
					resolvePromise({ exitCode: 0, stdout, stderr })
				},
			)
		} catch (error) {
			clearTimeout(timer)
			rejectPromise(error)
		}

		// execFile 的 signal 选项只会杀直接子进程；这里补杀整棵树。
		if (opts.signal) {
			opts.signal.addEventListener(
				'abort',
				() => killProcessTree(child?.pid),
				{ once: true },
			)
		}
	})
}

/**
 * 解析命令行工具链的构建日志。
 *
 * 兼容多种措辞：
 *   - GCC / Clang / xtensa-esp-elf / riscv-elf：`path:line:col: error: msg`
 *   - Keil AC5 / AC6：`path(line): error: #20: msg`、`path:line:col: error: msg`
 *   - IAR：`Error[Pe020]: msg`、`Warning[Pe...]`
 *   - MSVC / MSBuild：`error C1234:`、`error MSB1234:`
 *   - PlatformIO / make 的总结行：`=== N failed`、`make: *** [...] Error N`
 *
 * @param {string} text - 日志文本。
 * @returns {{summary: {errors: number, warnings: number}|null, errors: string[], warnings: string[], counts: {errors: number, warnings: number}}} 解析结果。
 */
export function parseToolchainLog(text) {
	const errors = []
	const warnings = []
	let summary = null

	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim()
		if (line.length === 0) continue

		// Keil 的官方结论行：`"proj.uvprojx" - 0 Error(s), 2 Warning(s).`
		const keilSummary = /(\d+)\s+Error\(s\)\s*,\s*(\d+)\s+Warning\(s\)/i.exec(line)
		if (keilSummary) {
			summary = { errors: Number(keilSummary[1]), warnings: Number(keilSummary[2]) }
			continue
		}

		if (isErrorLine(line)) errors.push(line)
		else if (isWarningLine(line)) warnings.push(line)
	}

	/**
	 * 去重并保留首次出现顺序。
	 * @param {string[]} items - 原始列表。
	 * @returns {string[]} 去重后的列表。
	 */
	function unique(items) {
		return Array.from(new Set(items))
	}

	const uniqueErrors = unique(errors)
	const uniqueWarnings = unique(warnings)
	return {
		summary,
		errors: uniqueErrors,
		warnings: uniqueWarnings,
		counts: { errors: uniqueErrors.length, warnings: uniqueWarnings.length },
	}
}

/**
 * 判定一行是否是错误。
 * @param {string} line - 日志行。
 * @returns {boolean} 是否是错误行。
 */
function isErrorLine(line) {
	if (/Error\(s\)/i.test(line)) return false
	// IAR：`Error[Pe020]: ...`
	if (/^\s*(Fatal\s+)?Error\s*\[/i.test(line)) return true
	// GCC / Clang / AC6：`... error:`
	if (/:\s*(fatal\s+)?error:\s/i.test(line)) return true
	// Keil AC5：`path(123): error: ...`
	if (/\(\d+\)\s*:\s*(fatal\s+)?error\s*:/i.test(line)) return true
	// MSVC / MSBuild：`error C1234:` / `error MSB1234:`
	if (/^\s*error\s+[A-Z]+\d+:/i.test(line)) return true
	// 工具链的失败汇总
	if (/^=+\s*\d+\s+failed/i.test(line)) return true
	if (/make(\[\d+\])?:\s*\*\*\*/i.test(line) && /error/i.test(line)) return true
	return false
}

/**
 * 判定一行是否是警告。
 * @param {string} line - 日志行。
 * @returns {boolean} 是否是警告行。
 */
function isWarningLine(line) {
	if (/Warning\(s\)/i.test(line)) return false
	if (/^\s*Warning\s*\[/i.test(line)) return true
	if (/:\s*warning:\s/i.test(line)) return true
	if (/\(\d+\)\s*:\s*warning\s*:/i.test(line)) return true
	if (/^\s*warning\s+[A-Z]+\d+:/i.test(line)) return true
	return false
}

/**
 * 推导构建判定。
 *
 * 优先级：有官方结论行就用它；否则用日志里的错误计数；退出码只作最后参考
 * （不同工具链的退出码语义不一致，不能当结论）。
 *
 * @param {{summary: object|null, counts: {errors: number, warnings: number}}} parsed - 日志解析结果。
 * @param {boolean} timedOut - 是否超时。
 * @param {number|null} exitCode - 退出码。
 * @param {string} text - 原始日志。
 * @returns {'success'|'warnings'|'failed'|'unknown'} 判定。
 */
function deriveVerdict(parsed, timedOut, outputTruncated, exitCode, text) {
	if (timedOut) return 'failed'
	if (outputTruncated) return 'failed'
	if (parsed.summary) {
		if (parsed.summary.errors > 0) return 'failed'
		if (parsed.summary.warnings > 0) return 'warnings'
		return 'success'
	}
	if (parsed.counts.errors > 0) return 'failed'
	if (exitCode !== null && exitCode !== 0) return 'failed'
	// 退出码 0 且日志里没有错误字样：若完全没日志，无法判断。
	if (text.trim().length === 0) return 'unknown'
	if (parsed.counts.warnings > 0) return 'warnings'
	return 'success'
}

/**
 * 在 PATH 与额外候选目录里查找可执行文件。
 *
 * 不依赖 `which` / `where`（沙箱里未必可用），也不引入第三方依赖。
 *
 * 注意：execFile **不经 shell**，只能执行 PE 文件（Windows 上的 .exe）。
 * `.cmd` / `.bat` 包装器（pip 安装的 CLI 常见形态）会被误判为"可用"但实际跑不起来
 * （新版 Node 因 CVE-2024-27980 的缓解对非 PE 文件直接抛 EINVAL），所以这里**不**把它们
 * 算作可执行 —— 探测包装器请用 {@link findFile} 并在 hint 里说明。
 *
 * @param {string[]} names - 候选文件名（含扩展名与否均可）。
 * @param {string[]} [extraDirs] - 额外搜索目录。
 * @returns {string|null} 命中的绝对路径，或 null。
 */
export function findExecutable(names, extraDirs = []) {
	const exts = process.platform === 'win32' ? ['', '.exe'] : ['']
	const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs]
	for (const dir of dirs) {
		for (const name of names) {
			for (const ext of exts) {
				const candidate = join(dir, name.endsWith(ext) ? name : name + ext)
				try {
					if (existsSync(candidate)) return candidate
				} catch {
					// 目录不可访问，继续找。
				}
			}
		}
	}
	return null
}

/**
 * 在 PATH 与额外候选目录里查找**任意文件**（不限于可执行 —— 含 .cmd/.bat/.py 包装器）。
 * 用于探测提示：找到了包装器 ≠ 能直接执行，但可以在 hint 里告诉用户它在那里。
 *
 * @param {string[]} names - 候选文件名（必须含扩展名）。
 * @param {string[]} [extraDirs] - 额外搜索目录。
 * @returns {string|null} 命中的绝对路径，或 null。
 */
export function findFile(names, extraDirs = []) {
	const dirs = [...(process.env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs]
	for (const dir of dirs) {
		for (const name of names) {
			try {
				const candidate = join(dir, name)
				if (existsSync(candidate)) return candidate
			} catch {
				// 目录不可访问，继续找。
			}
		}
	}
	return null
}
