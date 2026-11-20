// @ts-check
/** 环境变量配置。密钥只从环境读取，绝不写入文件或日志。 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（src/ 的上一级）。 */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 服务只绑定本机回环地址，且故意不提供环境变量覆盖。 */
export const HOST = '127.0.0.1';

/**
 * 加载仓库根目录的 .env（Node 内置 process.loadEnvFile，零依赖）。
 * 已存在的环境变量优先，不会被 .env 覆盖。
 */
export function loadDotenv() {
	const file = path.join(ROOT, '.env');
	if (!existsSync(file)) return false;
	try {
		process.loadEnvFile(file);
		return true;
	} catch (error) {
		console.error(`[ocs-answerer] 读取 .env 失败: ${/** @type {Error} */ (error)?.message ?? error}`);
		return false;
	}
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function intFromEnv(value, fallback, min, max, name) {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} 必须是 ${min}..${max} 之间的整数，收到: ${value}`);
	}
	return parsed;
}

/**
 * @param {string | undefined} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @param {string} name
 */
function floatFromEnv(value, fallback, min, max, name) {
	if (value === undefined || value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} 必须是 ${min}..${max} 之间的数字，收到: ${value}`);
	}
	return parsed;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
	const provider = String(env.ANSWERER_PROVIDER ?? 'openai').trim().toLowerCase();
	if (provider !== 'openai' && provider !== 'mock') {
		throw new Error(`ANSWERER_PROVIDER 只支持 openai 或 mock，收到: ${provider}`);
	}

	const baseUrl = String(env.ANSWERER_BASE_URL ?? '')
		.trim()
		.replace(/\/+$/, '');
	const apiKey = String(env.ANSWERER_API_KEY ?? '').trim();
	const model = String(env.ANSWERER_MODEL ?? '').trim();

	if (provider === 'openai') {
		const missing = [
			['ANSWERER_BASE_URL', baseUrl],
			['ANSWERER_API_KEY', apiKey],
			['ANSWERER_MODEL', model]
		]
			.filter(([, value]) => !value)
			.map(([name]) => name);
		if (missing.length > 0) {
			throw new Error(`openai provider 缺少环境变量: ${missing.join(', ')}（可复制 .env.example 为 .env）`);
		}
	}

	return {
		provider,
		baseUrl,
		apiKey,
		model,
		port: intFromEnv(env.ANSWERER_PORT, 8787, 1, 65535, 'ANSWERER_PORT'),
		k: intFromEnv(env.ANSWERER_K, 3, 1, 10, 'ANSWERER_K'),
		marginThreshold: floatFromEnv(env.ANSWERER_MARGIN, 0.15, 0, 1, 'ANSWERER_MARGIN'),
		timeoutMs: intFromEnv(env.ANSWERER_TIMEOUT_MS, 20000, 1000, 120000, 'ANSWERER_TIMEOUT_MS'),
		logFile: env.ANSWERER_LOG_FILE?.trim() || path.join(ROOT, 'logs', 'answers.jsonl'),
		logEnabled: env.ANSWERER_LOG !== '0',
		logprobs: env.ANSWERER_LOGPROBS === '1'
	};
}
