/**
 * @deepseek-ai/dsh-tools 的本地开发 stub。
 *
 * 目的：让 `node selftest.mjs` 在干净 checkout 上可运行（CI、新贡献者）。
 * 真实实现会做参数 schema 校验与归一化；stub 只做最基本的形状检查并原样透传，
 * **不提供 schema 合法性保证** —— 那一层验证必须在真实 dsh profile 环境下做。
 *
 * 安装方式：package.json 的 devDependencies 用 `file:./vendor/dsh-tools` 引用，
 * `npm install` 后 node_modules 里会出现这个包；生产（dsh plugin add）不装
 * devDependencies，裸导入由宿主 profile 的 node_modules 解析，与本 stub 无关。
 */

/** 标记：调用方可据此区分 stub 与真实实现。 */
export const __DSTOOLS_STUB__ = true

/**
 * defineTool stub：做最小形状检查后原样返回定义。
 * @param {object} definition - 工具定义。
 * @returns {object} 同一定义对象。
 */
export function defineTool(definition) {
	if (definition === null || typeof definition !== 'object') {
		throw new TypeError('defineTool(stub): 定义必须是对象')
	}
	if (typeof definition.name !== 'string' || definition.name.length === 0) {
		throw new TypeError('defineTool(stub): 缺少工具 name')
	}
	if (typeof definition.execute !== 'function') {
		throw new TypeError(`defineTool(stub): 工具 ${definition.name} 缺少 execute 函数`)
	}
	return definition
}
