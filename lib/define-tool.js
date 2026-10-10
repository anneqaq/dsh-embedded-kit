/**
 * 宿主 `defineTool` 的解析入口。
 *
 * 为什么需要这一层：`lib/index.js` 里的工具描述符要能在**宿主之外**被调用 ——
 * 技能随附脚本（`skills/_shared/run-tool.mjs`）就是干这个的。若这里静态 import
 * 宿主包，那么一旦离开 DSH，整个 lib/index.js 都 import 不进来，脚本就没法用
 * 那些已经写好、已经测过的描述符，只能被迫重写一份算法 —— 那正是本项目要避免的事。
 *
 * 所以改成动态解析：
 *   - 宿主在（DSH 内，或仓库里装了 vendor stub）→ 用真的 defineTool，schema 校验照常
 *   - 宿主不在**且调用方显式声明允许**（脚本会设 `DSH_EMBEDDED_KIT_ALLOW_TOOL_STUB=1`）
 *     → 退化成透传
 *
 * 刻意**不做"解析不到就自动退化"**：那会把"宿主解析坏了"从硬失败变成静默降级，
 * 而静默降级正是本项目一直在防的事。没有显式声明时，导入失败就照旧抛出去。
 *
 * 判断依据不能只看 `DSH_SESSION_ID`：模型在 DSH 会话里跑脚本时那个变量也在，
 * 会造成每次调用都误报。所以让调用方自己声明意图，而不是替它猜。
 *
 * @module dsh-embedded-kit/define-tool
 */

/** @type {(spec: object) => object} */
let defineTool

try {
	;({ defineTool } = await import('@deepseek-ai/dsh-tools'))
} catch (error) {
	if (process.env.DSH_EMBEDDED_KIT_ALLOW_TOOL_STUB !== '1') throw error
	defineTool = (spec) => spec
}

export { defineTool }
