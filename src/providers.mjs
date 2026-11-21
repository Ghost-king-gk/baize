// @ts-check
/**
 * 供应商预设表：供应商是「数据」不是代码。
 *
 * 预设只描述线协议、baseUrl 和密钥来自哪个环境变量，**绝不写模型 ID**。
 * 用户可以放一个 providers.local.json 做按 id 浅合并，覆盖或追加供应商。
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 预设表允许的线协议（严格照官方 API）。 */
export const PROTOCOLS = ['openai', 'anthropic', 'gemini'];

/** 实验性协议：只允许出现在 providers.local.json，预设表里没有。 */
export const OAUTH_PROTOCOLS = ['anthropic-oauth', 'openai-oauth'];

/** @typedef {{
 *   id: string,
 *   label: string,
 *   protocol: string,
 *   baseUrl: string,
 *   keyEnv: string | null,
 *   model?: string,
 *   apiKey?: string,
 *   auth?: string
 * }} ProviderEntry */

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 读取一个 JSON 文件；不存在时返回空对象。语法错误直接抛，避免带病启动。
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function readProviderFile(file) {
	if (!existsSync(file)) return {};
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		throw new Error(`读取 provider 配置失败 ${file}: ${/** @type {Error} */ (error)?.message ?? error}`);
	}

	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`provider 配置不是合法 JSON ${file}: ${/** @type {Error} */ (error)?.message ?? error}`);
	}
	if (!isPlainObject(parsed)) throw new Error(`provider 配置必须是 JSON 对象: ${file}`);
	return parsed;
}

/**
 * 校验并规范化单个供应商条目。预设与本地覆盖的允许范围不同：
 * - 预设：protocol 只能是 openai/anthropic/gemini，且绝不能写 model；
 * - 本地：可以写 model，也可以用实验性的 *-oauth 协议。
 * @param {string} id
 * @param {unknown} entry
 * @param {{source?: 'preset' | 'local'}} [options]
 * @returns {ProviderEntry}
 */
export function normalizeProvider(id, entry, options = {}) {
	const source = options.source ?? 'preset';
	const allowed = source === 'preset' ? PROTOCOLS : [...PROTOCOLS, ...OAUTH_PROTOCOLS];

	if (!id || typeof id !== 'string') throw new Error('provider id 必须是非空字符串');
	if (!isPlainObject(entry)) throw new Error(`provider "${id}" 必须是 JSON 对象`);

	if (!allowed.includes(entry.protocol)) {
		throw new Error(`provider "${id}" 的 protocol 必须是 ${allowed.join('|')}，收到: ${String(entry.protocol)}`);
	}

	if (source === 'preset' && Object.prototype.hasOwnProperty.call(entry, 'model')) {
		throw new Error(`provider 预设 "${id}" 不应写 model：模型只能来自 ANSWERER_MODEL 或 providers.local.json`);
	}

	if (typeof entry.baseUrl !== 'string') {
		throw new Error(`provider "${id}" 的 baseUrl 必须是字符串（可以为空，表示必须由用户填写）`);
	}

	const keyEnv = entry.keyEnv ?? null;
	if (keyEnv !== null && (typeof keyEnv !== 'string' || keyEnv.trim() === '')) {
		throw new Error(`provider "${id}" 的 keyEnv 必须是环境变量名或 null（本地服务无需鉴权）`);
	}

	if (entry.model !== undefined && (typeof entry.model !== 'string' || entry.model.trim() === '')) {
		throw new Error(`provider "${id}" 的 model 必须是非空字符串`);
	}

	return {
		...entry,
		id,
		label: typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : id,
		protocol: entry.protocol,
		baseUrl: entry.baseUrl.trim().replace(/\/+$/, ''),
		keyEnv
	};
}

/**
 * 合并预设与本地覆盖（按 id 浅合并，用户值优先）。
 * @param {Record<string, any>} presets
 * @param {Record<string, any>} [local]
 * @returns {Record<string, ProviderEntry>}
 */
export function mergeProviderTables(presets, local = {}) {
	if (!isPlainObject(presets)) throw new Error('provider 预设表必须是 JSON 对象');
	if (!isPlainObject(local)) throw new Error('providers.local.json 必须是 JSON 对象');

	/** @type {Record<string, ProviderEntry>} */
	const merged = {};
	for (const [id, entry] of Object.entries(presets)) {
		merged[id] = normalizeProvider(id, entry, { source: 'preset' });
	}
	for (const [id, override] of Object.entries(local)) {
		if (!isPlainObject(override)) throw new Error(`providers.local.json 里的 "${id}" 必须是 JSON 对象`);
		merged[id] = normalizeProvider(id, { ...(merged[id] ?? {}), ...override }, { source: 'local' });
	}
	return merged;
}

/**
 * 读取预设 + 本地覆盖。本地文件固定与预设同目录，名为 providers.local.json。
 * @param {{file: string, localFile?: string}} options
 * @returns {{presets: Record<string, any>, local: Record<string, any>, providers: Record<string, ProviderEntry>}}
 */
export function loadProviderTable(options) {
	const presets = readProviderFile(options.file);
	const localFile = options.localFile ?? path.join(path.dirname(options.file), 'providers.local.json');
	const local = readProviderFile(localFile);
	return { presets, local, providers: mergeProviderTables(presets, local) };
}

/**
 * 只读取 ~/.claude/.credentials.json 里的 access token。
 * 这是 Claude Code 自己的凭据文件；代码不会遍历其它凭据目录。
 * @returns {string}
 */
export function readClaudeAccessToken() {
	const file = path.join(os.homedir(), '.claude', '.credentials.json');
	if (!existsSync(file)) return '';
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		const token = parsed?.claudeAiOauth?.accessToken ?? parsed?.accessToken;
		return typeof token === 'string' ? token.trim() : '';
	} catch {
		return '';
	}
}

/**
 * 把供应商条目 + 环境变量解析成可直接发请求的配置（含内存中的 key，绝不落盘）。
 * @param {string} id
 * @param {Record<string, ProviderEntry>} table
 * @param {Record<string, string | undefined>} env
 * @param {{baseUrl?: string, apiKey?: string}} [overrides] 仅用于兼容旧配置的 ANSWERER_BASE_URL / ANSWERER_API_KEY
 * @returns {ProviderEntry & {model: string, apiKey: string, auth: string}}
 */
export function resolveProvider(id, table, env, overrides = {}) {
	if (id === 'mock') {
		return { id: 'mock', label: 'Mock', protocol: 'mock', baseUrl: '', keyEnv: null, model: 'mock', apiKey: '', auth: 'none' };
	}

	const entry = table[id];
	if (!entry) {
		const known = Object.keys(table).sort().join(', ');
		throw new Error(`未知 provider "${id}"。可用: mock, ${known}（自定义请写 config/providers.local.json）`);
	}

	const protocol = entry.protocol;
	const isOauth = OAUTH_PROTOCOLS.includes(protocol);
	const baseUrl = String(overrides.baseUrl || entry.baseUrl || '')
		.trim()
		.replace(/\/+$/, '');
	if (!baseUrl) {
		throw new Error(`provider "${id}" 的 baseUrl 为空：请设置 ANSWERER_BASE_URL 或在 providers.local.json 里填写`);
	}

	const model = String(entry.model ?? env.ANSWERER_MODEL ?? '').trim();
	if (!model) {
		throw new Error(`provider "${id}" 缺少 model：请设置 ANSWERER_MODEL，或在 providers.local.json 的 "${id}" 条目里写 model`);
	}

	/** @type {string} */
	let apiKey = String(overrides.apiKey ?? '').trim();
	if (!apiKey && entry.keyEnv) apiKey = String(env[entry.keyEnv] ?? '').trim();
	if (!apiKey && protocol === 'anthropic-oauth') {
		apiKey = String(env.ANTHROPIC_OAUTH_TOKEN ?? '').trim() || readClaudeAccessToken();
	}
	if (!apiKey && protocol === 'openai-oauth') {
		apiKey = String(env.OPENAI_OAUTH_TOKEN ?? '').trim();
	}
	if (isOauth && !apiKey) {
		const hint = protocol === 'anthropic-oauth' ? 'ANTHROPIC_OAUTH_TOKEN' : 'OPENAI_OAUTH_TOKEN';
		throw new Error(`provider "${id}" 缺少 OAuth token：请设置 ${entry.keyEnv ?? hint}`);
	}

	if (!apiKey && entry.keyEnv) {
		const hint =
			protocol === 'anthropic-oauth'
				? '（也可设置 ANTHROPIC_OAUTH_TOKEN 或运行 claude 登录）'
				: protocol === 'openai-oauth'
					? '（也可设置 OPENAI_OAUTH_TOKEN）'
					: '';
		throw new Error(`provider "${id}" 缺少环境变量 ${entry.keyEnv}${hint}`);
	}

	return {
		...entry,
		model,
		baseUrl,
		apiKey,
		auth: isOauth ? 'oauth' : apiKey ? 'api-key' : 'none'
	};
}
