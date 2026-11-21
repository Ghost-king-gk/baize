// @ts-check
/**
 * 供应商预设表：供应商是「数据」不是代码。
 *
 * 预设只描述线协议、baseUrl 和密钥来自哪个环境变量，**绝不写模型 ID**。
 * 用户可以放一个 providers.local.json 做按 id 浅合并，覆盖或追加供应商。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readClaudeOAuth, readCodexOAuth } from './oauth.mjs';

/** 预设表允许的线协议（严格照官方 API）。`responses` 也走官方 API，只是端点不同。 */
export const PROTOCOLS = ['openai', 'anthropic', 'gemini', 'responses'];

/** 实验性协议别名：只允许出现在 providers.local.json，预设表里没有。 */
export const OAUTH_PROTOCOLS = ['anthropic-oauth', 'openai-oauth'];

/** 旧协议别名 → auth 标记；用户可以显式写 auth，但必须一致。 */
export const OAUTH_AUTH_MODES = { 'anthropic-oauth': 'oauth', 'openai-oauth': 'codex-oauth' };

/** 旧协议别名 → 规范协议。别名只是历史写法，内部一律按规范协议处理。 */
const LEGACY_PROTOCOLS = { 'anthropic-oauth': 'anthropic', 'openai-oauth': 'responses' };

/** 所有允许的 auth 取值；缺省是 `api-key`。 */
export const AUTH_MODES = ['api-key', 'bearer', 'oauth', 'codex-oauth', 'none'];

/**
 * 订阅类 auth 只能配对应的线协议：
 * - `oauth` 是 Claude Code 订阅，只对 Anthropic Messages 有意义；
 * - `codex-oauth` 是 Codex 订阅，只对 Responses 有意义。
 * `api-key` / `bearer` / `none` 与协议正交，四种协议都能用。
 */
const AUTH_PROTOCOL_RESTRICTIONS = { oauth: 'anthropic', 'codex-oauth': 'responses' };

/** @typedef {{
 *   id: string,
 *   label: string,
 *   protocol: string | null,
 *   baseUrl: string,
 *   keyEnv: string | null,
 *   model?: string,
 *   apiKey?: string,
 *   auth?: string,
 *   accountId?: string | null,
 *   impersonate?: boolean | string,
 *   userAgent?: string,
 *   catalog?: { url: string }
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

	// 两种形态二选一：传统形态写 protocol + baseUrl；目录形态只写 catalog.url。
	// 同时写会让人分不清运行时到底信谁，直接拒绝。
	const isCatalog = entry.catalog !== undefined;
	if (isCatalog) {
		if (
			Object.prototype.hasOwnProperty.call(entry, 'protocol') ||
			Object.prototype.hasOwnProperty.call(entry, 'baseUrl')
		) {
			throw new Error(
				`provider "${id}" 不能同时写 catalog 与 protocol/baseUrl：目录形态的协议和地址在运行时由模型目录解析`
			);
		}
		if (!isPlainObject(entry.catalog) || typeof entry.catalog.url !== 'string' || !entry.catalog.url.trim()) {
			throw new Error(`provider "${id}" 的 catalog.url 必须是非空字符串`);
		}
	} else if (!allowed.includes(entry.protocol)) {
		throw new Error(`provider "${id}" 的 protocol 必须是 ${allowed.join('|')}，收到: ${String(entry.protocol)}`);
	}

	// 旧写法 protocol=anthropic-oauth/openai-oauth：归一化成规范协议 + 对应订阅 auth。
	// 显式写了不匹配的 auth 时报错，而不是悄悄改掉用户的意图。
	const legacyProtocol = OAUTH_AUTH_MODES[/** @type {keyof typeof OAUTH_AUTH_MODES} */ (entry.protocol)];
	/** @type {string} */
	let protocol = entry.protocol;
	/** @type {string | undefined} */
	let auth = entry.auth;
	if (legacyProtocol) {
		if (auth !== undefined && auth !== legacyProtocol) {
			throw new Error(
				`provider "${id}" 的 protocol=${entry.protocol} 需要 auth="${legacyProtocol}"，收到: ${String(auth)}`
			);
		}
		auth = legacyProtocol;
		protocol = LEGACY_PROTOCOLS[/** @type {keyof typeof LEGACY_PROTOCOLS} */ (entry.protocol)];
	}

	if (auth !== undefined && !AUTH_MODES.includes(auth)) {
		throw new Error(`provider "${id}" 的 auth 必须是 ${AUTH_MODES.join('|')}，收到: ${String(auth)}`);
	}
	// 目录形态默认 Bearer：OpenCode Inference 两种目录都只认 Authorization: Bearer。
	auth = auth ?? (isCatalog ? 'bearer' : 'api-key');

	if (isCatalog && (auth === 'oauth' || auth === 'codex-oauth')) {
		throw new Error(`provider "${id}" 是目录形态，协议要等运行时解析，不能使用 auth="${auth}"`);
	}

	const restrictedProtocol = AUTH_PROTOCOL_RESTRICTIONS[/** @type {keyof typeof AUTH_PROTOCOL_RESTRICTIONS} */ (auth)];
	if (restrictedProtocol && protocol !== restrictedProtocol) {
		throw new Error(
			`provider "${id}" 的 auth="${auth}" 只能用于 protocol=${restrictedProtocol}，收到: ${protocol}`
		);
	}
	if (source === 'preset' && (auth === 'oauth' || auth === 'codex-oauth')) {
		throw new Error(`provider 预设 "${id}" 不能使用 auth="${auth}"：订阅凭据只允许写在 providers.local.json`);
	}

	if (
		entry.impersonate !== undefined &&
		typeof entry.impersonate !== 'boolean' &&
		(typeof entry.impersonate !== 'string' || entry.impersonate.trim() === '')
	) {
		throw new Error(`provider "${id}" 的 impersonate 必须是布尔值或自定义 User-Agent 字符串`);
	}

	if (source === 'preset' && Object.prototype.hasOwnProperty.call(entry, 'model')) {
		throw new Error(`provider 预设 "${id}" 不应写 model：模型只能来自 ANSWERER_MODEL（单 provider）或 providers.local.json 里逐家的 model`);
	}

	if (!isCatalog && typeof entry.baseUrl !== 'string') {
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
		protocol: isCatalog ? null : protocol,
		auth,
		baseUrl: isCatalog ? '' : entry.baseUrl.trim().replace(/\/+$/, ''),
		...(isCatalog ? { catalog: { url: entry.catalog.url.trim().replace(/\/+$/, '') } } : {}),
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
 * 混合链（长度 > 1）必须逐家指定 model：不同供应商的模型 id 通常不同，
 * 全局 ANSWERER_MODEL 只适合单 provider。mock 自带 model，不在此列。
 * 未知 provider 不在这里报错，交给 resolveProvider 给出更准确的提示。
 * @param {string[]} chain
 * @param {Record<string, ProviderEntry>} table
 */
export function assertMixedChainModels(chain, table) {
	if (chain.length <= 1) return;

	/** @type {string[]} */
	const missing = [];
	for (const id of chain) {
		if (id === 'mock') continue;
		const entry = table[id];
		if (!entry) continue;
		if (!entry.model) missing.push(id);
	}
	if (missing.length === 0) return;

	const fixes = missing
		.map(
			(id) =>
				`provider "${id}" 缺少 model；混合链必须逐家指定。在 config/providers.local.json 里加：\n  { "${id}": { "model": "<该供应商的模型 id>" } }`
		)
		.join('\n');
	throw new Error(`ANSWERER_CHAIN=${chain.join(',')} 包含多个 provider，不能只靠全局 ANSWERER_MODEL。\n${fixes}`);
}

/**
 * 把供应商条目 + 环境变量解析成可直接发请求的配置（含内存中的 key，绝不落盘）。
 *
 * OAuth provider 的 token 只从 oauth.mjs 读取（环境变量优先，其次本地凭据文件）；
 * `keyEnv` 在 OAuth 模式下不参与取值，只作为文档提示保留。
 *
 * @param {string} id
 * @param {Record<string, ProviderEntry>} table
 * @param {Record<string, string | undefined>} env
 * @param {{baseUrl?: string, apiKey?: string}} [overrides] 仅用于兼容旧配置的 ANSWERER_BASE_URL / ANSWERER_API_KEY
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

	const isCatalog = Boolean(entry.catalog);
	const auth =
		entry.auth ??
		(isCatalog ? 'bearer' : OAUTH_AUTH_MODES[/** @type {keyof typeof OAUTH_AUTH_MODES} */ (entry.protocol)] ?? 'api-key');
	const protocol = LEGACY_PROTOCOLS[/** @type {keyof typeof LEGACY_PROTOCOLS} */ (entry.protocol)] ?? entry.protocol;
	const isSubscription = auth === 'oauth' || auth === 'codex-oauth';
	// 目录形态没有静态 baseUrl：协议与地址都在 ask 时由 catalog.resolve() 决定。
	const baseUrl = isCatalog
		? ''
		: String(overrides.baseUrl || entry.baseUrl || '')
				.trim()
				.replace(/\/+$/, '');
	if (!isCatalog && !baseUrl) {
		throw new Error(`provider "${id}" 的 baseUrl 为空：请设置 ANSWERER_BASE_URL 或在 providers.local.json 里填写`);
	}

	const model = String(entry.model ?? env.ANSWERER_MODEL ?? '').trim();
	if (!model) {
		throw new Error(`provider "${id}" 缺少 model：请设置 ANSWERER_MODEL，或在 providers.local.json 的 "${id}" 条目里写 model`);
	}

	/** @type {string} */
	let apiKey = String(overrides.apiKey ?? '').trim();
	/** @type {string | null} */
	let accountId = null;

	if (isSubscription) {
		// 显式环境变量 > Claude Code / Codex 的本地凭据文件；具体错误由 oauth.mjs 给出。
		const credentials = auth === 'oauth' ? readClaudeOAuth({ env }) : readCodexOAuth({ env });
		if (!apiKey) apiKey = credentials.token;
		if (auth === 'codex-oauth') {
			accountId = /** @type {{accountId?: string | null}} */ (credentials).accountId ?? null;
		}
	} else if (auth === 'none') {
		// 本地服务显式声明无需鉴权：即使环境里恰好有同名变量也不发。
		apiKey = '';
	} else if (!apiKey && entry.keyEnv) {
		apiKey = String(env[entry.keyEnv] ?? '').trim();
	}

	if (!apiKey && entry.keyEnv && auth !== 'none') {
		throw new Error(`provider "${id}" 缺少环境变量 ${entry.keyEnv}`);
	}
	if (!apiKey && auth === 'bearer') {
		throw new Error(
			`provider "${id}" 的 auth=bearer 需要 API key：请设置 ${entry.keyEnv ?? 'ANSWERER_API_KEY'}（或 ANSWERER_API_KEY）`
		);
	}

	return {
		...entry,
		protocol: isCatalog ? null : protocol,
		model,
		baseUrl,
		apiKey,
		// 显式 auth 原样保留；api-key 没拿到 key 时降级为 none，协议适配器据此跳过认证头。
		auth: isSubscription || auth === 'none' ? auth : apiKey ? auth : 'none',
		...(accountId ? { accountId } : {}),
		...(isCatalog ? { catalog: entry.catalog } : {})
	};
}
