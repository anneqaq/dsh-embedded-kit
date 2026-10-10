/**
 * 宿主 `defineTool` 的解析入口。
 *
 * 必须动态解析：`lib/index.js` 里的描述符要能在**宿主之外**被调用（技能随附脚本就是干这个的），
 * 而静态 import 宿主包会让整个模块在宿主之外加载失败。
 *
 * 宿主不在时**只在调用方显式声明允许**（`DSH_EMBEDDED_KIT_ALLOW_TOOL_STUB=1`）才退化为透传：
 * 自动退化会把"宿主解析坏了"从硬失败变成静默降级。
 * 判断依据不能只看 `DSH_SESSION_ID` —— 在 DSH 会话里跑脚本时它也在，会造成误报。
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
