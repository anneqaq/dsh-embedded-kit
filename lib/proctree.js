/**
 * 子进程树管理（跨平台）。
 *
 * 背景：Node `execFile` 的 `timeout`/`signal` 只对**直接子进程**生效。
 * 在 Windows 上，GUI 壳（如 UV4.exe）拉起的真实工作者（armclang/armasm）是孙进程，
 * 杀父不杀子会留下孤儿编译进程继续吃满 CPU —— "已杀进程"的承诺必须靠**杀整棵树**兑现。
 *
 * - Windows：`taskkill /PID <pid> /T /F`（/T = 连同子树，/F = 强制）
 * - POSIX：调用方以 `detached: true` spawn（子进程自成进程组组长），
 *   这里 `kill(-pid)` 对整个进程组发信号；组杀失败再退回单杀。
 *
 * @module dsh-embedded-kit/proctree
 */

import { execFile } from 'node:child_process'

/**
 * 强制终止整棵子进程树（尽力而为：失败不打断调用方）。
 * @param {number|undefined|null} pid - 直接子进程的 pid。
 * @returns {void}
 */
export function killProcessTree(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return
	if (process.platform === 'win32') {
		// taskkill 无害输出走 stderr；回调吞掉错误即可（进程可能已自行退出）。
		execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
	} else {
		try {
			process.kill(-pid, 'SIGKILL') // 组杀（要求 spawn 时 detached: true）
		} catch {
			try {
				process.kill(pid, 'SIGKILL')
			} catch {
				// 进程已退出：无需处理。
			}
		}
	}
}
