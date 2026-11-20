// @ts-check
/** 每题一行 JSONL 埋点。不记录完整题干，只记录长度与 sha256 前缀。 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * @param {string} text
 * @returns {string} 16 位十六进制（sha256 前 8 字节）
 */
export function hashTitle(text) {
	return createHash('sha256').update(String(text), 'utf8').digest('hex').slice(0, 16);
}

/**
 * @param {{file: string, enabled?: boolean}} config
 * @returns {(record: Record<string, unknown>) => Promise<void>}
 */
export function createJsonlLogger(config) {
	const enabled = config.enabled !== false;
	let directoryReady;

	return async function log(record) {
		if (!enabled) return;
		try {
			directoryReady ??= mkdir(path.dirname(config.file), { recursive: true });
			await directoryReady;
			await appendFile(config.file, `${JSON.stringify(record)}\n`, 'utf8');
		} catch (error) {
			// 埋点失败不能影响答题主流程
			console.error(`[ocs-answerer] 写日志失败: ${/** @type {Error} */ (error)?.message ?? error}`);
		}
	};
}
