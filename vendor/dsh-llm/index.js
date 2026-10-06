/**
 * @deepseek-ai/dsh-llm 的本地开发 stub。
 *
 * 目的：让 selftest / CI 在干净 checkout 上可运行。真实实现会规范化消息形状；
 * stub 只需保证 `createUserMessage(spec)` 返回携带 spec 字段的消息对象 ——
 * selftest 对门禁消息形状的断言（content 数组、source.plugin）由此成立。
 * 生产（dsh plugin add）不装 devDependencies，裸导入由宿主 profile 解析。
 */

/** 标记：调用方可据此区分 stub 与真实实现。 */
export const __DSLLM_STUB__ = true

/**
 * createUserMessage stub：浅拷贝并原样返回。
 * @param {object} spec - 消息规格（content / source 等）。
 * @returns {object} 消息对象。
 */
export function createUserMessage(spec) {
	if (spec === null || typeof spec !== 'object') {
		throw new TypeError('createUserMessage(stub): 规格必须是对象')
	}
	return { ...spec }
}
