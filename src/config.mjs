// @ts-check
/** 环境变量配置。密钥只从环境读取，绝不写入文件或日志。 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertMixedChainModels, loadProviderTable, resolveProvider } from './providers.mjs';

/** 仓库根目录（src/ 的上一级）。 */
export const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 服务只绑定本机回环地址，且故意不提供环境变量覆盖。 */
export const HOST = '127.0.0.1';

/** 默认供应商预设表。 */
export const DEFAULT_PROVIDERS_FILE = path.join(ROOT, 'config', 'providers.json');

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
		console.error(`[baize] 读取 .env 失败: ${/** @type {Error} */ (error)?.message ?? error}`);
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
 * ANSWERER_CHAIN 优先；未设置时退回 ANSWERER_PROVIDER（兼容旧配置）。
 * 逗号分隔、去空白、按出现顺序去重。
 * @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
export function parseProviderChain(env) {
	const raw = String(env.ANSWERER_CHAIN ?? '').trim();
	const parts = raw ? raw.split(',') : [String(env.ANSWERER_PROVIDER ?? 'openai')];

	/** @type {string[]} */
	const chain = [];
	for (const part of parts) {
		const id = part.trim();
		if (!id || chain.includes(id)) continue;
		chain.push(id);
	}
	if (chain.length === 0) throw new Error('ANSWERER_CHAIN 不能为空');
	return chain;
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function loadConfig(env = process.env) {
	const rawChain = parseProviderChain(env);

	const providersFile = path.resolve(
		ROOT,
		String(env.ANSWERER_PROVIDERS_FILE ?? '').trim() || DEFAULT_PROVIDERS_FILE
	);
	const table = loadProviderTable({ file: providersFile }).providers;

	// 兼容旧配置的大小写写法（以前 ANSWERER_PROVIDER 会被 toLowerCase）。
	const chain = rawChain.map((id) => {
		if (id === 'mock' || table[id]) return id;
		const lower = id.toLowerCase();
		if (lower === 'mock' || table[lower]) return lower;
		return id;
	});

	// 混合链必须逐家指定 model：全局 ANSWERER_MODEL 无法同时适配不同供应商。
	// 在监听端口之前就拒绝启动，避免用户到第一次请求才发现第二家 404/400。
	assertMixedChainModels(chain, table);

	// 旧的 ANSWERER_BASE_URL / ANSWERER_API_KEY 继续生效：只覆盖链上第一家。
	const providers = chain.map((id, index) =>
		resolveProvider(id, table, env, {
			baseUrl: index === 0 ? env.ANSWERER_BASE_URL : undefined,
			apiKey: index === 0 ? env.ANSWERER_API_KEY : undefined
		})
	);

	const first = providers[0];

	return {
		provider: first.id,
		chain,
		providers,
		baseUrl: first.baseUrl,
		apiKey: first.apiKey,
		model: first.model,
		host: env.ANSWERER_HOST?.trim() || HOST,
		port: intFromEnv(env.ANSWERER_PORT, 8787, 1, 65535, 'ANSWERER_PORT'),
		k: intFromEnv(env.ANSWERER_K, 3, 1, 10, 'ANSWERER_K'),
		marginThreshold: floatFromEnv(env.ANSWERER_MARGIN, 0.15, 0, 1, 'ANSWERER_MARGIN'),
		timeoutMs: intFromEnv(env.ANSWERER_TIMEOUT_MS, 20000, 1000, 120000, 'ANSWERER_TIMEOUT_MS'),
		logFile: env.ANSWERER_LOG_FILE?.trim() || path.join(ROOT, 'logs', 'answers.jsonl'),
		logEnabled: env.ANSWERER_LOG !== '0',
		logprobs: env.ANSWERER_LOGPROBS === '1'
	};
}
