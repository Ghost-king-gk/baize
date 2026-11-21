// @ts-check
/**
 * 订阅 OAuth 凭据：读取 Claude Code / Codex 已经登录好的本地 token。
 *
 * 设计约束（见 README「订阅 OAuth」）：
 * - 只读，不刷新、不联网、不写回凭据文件；
 * - 只在内存里传递 token，绝不落盘、绝不打日志；
 * - 文件不存在 / 无权限 / JSON 损坏 / 字段缺失 / 已过期，分别给出可操作的错误；
 * - JWT 只做 base64url 解码，不校验签名（我们不是签发方，也不是验证方）。
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Claude Code 在 Anthropic 原生路由上固定携带的 beta 标记。 */
export const CLAUDE_CODE_BETA = 'claude-code-20250219';

/** Claude Code 订阅 OAuth 的 beta 标记（单独的 oauth usage 接口不在这里用）。 */
export const OAUTH_BETA = 'oauth-2025-04-20';

/** 订阅 OAuth 的 anthropic-beta 头：两个都要发，顺序固定。 */
export const ANTHROPIC_OAUTH_BETA = `${CLAUDE_CODE_BETA},${OAUTH_BETA}`;

/** Anthropic 订阅套餐要求 system prompt / 首条输入以这句身份开头。 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Claude Code 指纹伪装默认 User-Agent（可在 providers.local.json 里覆盖）。 */
export const DEFAULT_CLAUDE_CODE_USER_AGENT = 'claude-cli/1.0.0 (external, cli)';

/** Codex CLI 的请求来源标记，ChatGPT 后端据此做模型 cohort 路由。 */
export const CODEX_ORIGINATOR = 'codex_cli_rs';

/** JWT 里 ChatGPT 账号信息的命名空间 claim。 */
export const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';

/** 凭据错误：message 面向用户，code 面向程序判断。 */
export class OAuthError extends Error {
	/**
	 * @param {string} message
	 * @param {{code?: string, hint?: string, cause?: unknown}} [options]
	 */
	constructor(message, options = {}) {
		const hint = options.hint ? `；${options.hint}` : '';
		super(`${message}${hint}`, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'OAuthError';
		this.code = options.code ?? 'oauth_error';
		this.hint = options.hint ?? '';
	}
}

/** @param {string} home */
export function claudeCredentialsPath(home = os.homedir()) {
	return path.join(home, '.claude', '.credentials.json');
}

/** @param {string} home */
export function codexAuthPath(home = os.homedir()) {
	return path.join(home, '.codex', 'auth.json');
}

/**
 * 把绝对路径缩成 ~/...，错误信息更短，也避免把完整 home 目录打得到处都是。
 * @param {string} file
 * @param {string} home
 */
function displayPath(file, home) {
	const prefix = home.endsWith(path.sep) ? home : `${home}${path.sep}`;
	return file.startsWith(prefix) ? `~${path.sep}${file.slice(prefix.length)}` : file;
}

/**
 * 读取并解析一个凭据 JSON 文件。
 *
 * 和常见的「读不到就当没配置」不同，这里必须把 ENOENT / EACCES / JSON 损坏分开：
 * 用户看到的应该是「没登录」或「权限不对」，而不是含糊的「token 无效」。
 *
 * @param {string} file
 * @param {{home: string, label: string, loginHint: string}} options
 * @returns {any}
 */
function readCredentialJson(file, options) {
	/** @type {string} */
	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		const code = /** @type {any} */ (error)?.code;
		const shown = displayPath(file, options.home);
		if (code === 'ENOENT') {
			throw new OAuthError(`未找到 ${shown}（${options.label} 未登录或尚未生成凭据）`, {
				code: 'credentials_missing',
				hint: options.loginHint,
				cause: error
			});
		}
		if (code === 'EACCES' || code === 'EPERM') {
			throw new OAuthError(`无权读取 ${shown}（${code}）`, {
				code: 'credentials_unreadable',
				hint: '请检查文件权限（通常应为 600，且属于当前用户）',
				cause: error
			});
		}
		throw new OAuthError(`读取 ${shown} 失败: ${/** @type {any} */ (error)?.message ?? error}`, {
			code: 'credentials_unreadable',
			hint: options.loginHint,
			cause: error
		});
	}

	/** @type {unknown} */
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new OAuthError(`${displayPath(file, options.home)} 不是合法 JSON`, {
			code: 'credentials_invalid',
			hint: options.loginHint,
			cause: error
		});
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new OAuthError(`${displayPath(file, options.home)} 的顶层必须是 JSON 对象`, {
			code: 'credentials_invalid',
			hint: options.loginHint
		});
	}
	return parsed;
}

/**
 * `expiresAt` 按毫秒时间戳处理；额外容忍纯数字字符串和 ISO 字符串，
 * 但不猜其它格式——猜错会把有效 token 判成过期，比直接报错更糟。
 * @param {unknown} value
 * @param {string} shown
 */
function normalizeExpiresAt(value, shown) {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const text = value.trim();
		if (/^\d+$/.test(text)) {
			const numeric = Number(text);
			if (Number.isFinite(numeric)) return numeric;
		}
		const parsed = Date.parse(text);
		if (Number.isFinite(parsed)) return parsed;
	}
	throw new OAuthError(`${shown} 的 expiresAt 不是合法时间戳: ${String(value)}`, {
		code: 'credentials_invalid',
		hint: '请重新运行 claude setup-token 生成新的凭据文件'
	});
}

/**
 * 读取 Claude Code 订阅凭据。
 *
 * 优先级：`ANTHROPIC_OAUTH_TOKEN` → `~/.claude/.credentials.json` 的
 * `claudeAiOauth.accessToken`。显式环境变量没有 expiresAt，由用户自己保证新鲜。
 *
 * @param {{env?: Record<string, string | undefined>, home?: string, file?: string, now?: () => number}} [options]
 * @returns {{token: string, expiresAt: number | null, subscriptionType: string | null, source: string}}
 */
export function readClaudeOAuth(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? os.homedir();
	const now = options.now ?? Date.now;

	const envToken = String(env.ANTHROPIC_OAUTH_TOKEN ?? '').trim();
	if (envToken) {
		return {
			token: envToken,
			expiresAt: null,
			subscriptionType: null,
			source: 'env:ANTHROPIC_OAUTH_TOKEN'
		};
	}

	const file = options.file ?? claudeCredentialsPath(home);
	const shown = displayPath(file, home);
	const json = readCredentialJson(file, {
		home,
		label: 'Claude Code',
		loginHint: '请先在终端运行 claude setup-token 生成订阅 token'
	});

	const oauth = json?.claudeAiOauth;
	if (!oauth || typeof oauth !== 'object' || Array.isArray(oauth)) {
		throw new OAuthError(`${shown} 缺少 claudeAiOauth 对象`, {
			code: 'credentials_invalid',
			hint: '请重新运行 claude setup-token'
		});
	}

	const token = typeof oauth.accessToken === 'string' ? oauth.accessToken.trim() : '';
	if (!token) {
		throw new OAuthError(`${shown} 缺少 claudeAiOauth.accessToken`, {
			code: 'credentials_invalid',
			hint: '请重新运行 claude setup-token'
		});
	}

	const expiresAt = normalizeExpiresAt(oauth.expiresAt, shown);
	if (expiresAt !== null && expiresAt <= now()) {
		throw new OAuthError(`Claude OAuth token 已过期（expiresAt=${new Date(expiresAt).toISOString()}）`, {
			code: 'token_expired',
			hint: '请重新运行 claude setup-token'
		});
	}

	return {
		token,
		expiresAt,
		subscriptionType: typeof oauth.subscriptionType === 'string' ? oauth.subscriptionType : null,
		source: `file:${shown}`
	};
}

/**
 * 解析 JWT payload（base64url，无依赖，不校验签名）。
 *
 * @param {string} token
 * @returns {Record<string, any>}
 */
export function decodeJwtPayload(token) {
	const value = typeof token === 'string' ? token.trim() : '';
	if (!value) throw new OAuthError('JWT 为空，无法解析 payload', { code: 'jwt_invalid' });

	const parts = value.split('.');
	if (parts.length !== 3) {
		throw new OAuthError(`JWT 结构不合法：需要 header.payload.signature 三段，收到 ${parts.length} 段`, {
			code: 'jwt_invalid',
			hint: '确认传入的是 access token；JWE（五段）或 refresh token 不适用'
		});
	}

	const payloadPart = parts[1];
	if (!payloadPart || !/^[A-Za-z0-9_-]+$/.test(payloadPart)) {
		throw new OAuthError('JWT payload 不是合法的 base64url 字符串', { code: 'jwt_invalid' });
	}

	/** @type {string} */
	let decoded;
	try {
		decoded = Buffer.from(payloadPart, 'base64url').toString('utf8');
	} catch (error) {
		throw new OAuthError(`JWT payload base64url 解码失败: ${/** @type {any} */ (error)?.message ?? error}`, {
			code: 'jwt_invalid',
			cause: error
		});
	}

	/** @type {unknown} */
	let payload;
	try {
		payload = JSON.parse(decoded);
	} catch (error) {
		throw new OAuthError('JWT payload 不是合法 JSON（base64url 解码后）', {
			code: 'jwt_invalid',
			cause: error
		});
	}
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new OAuthError('JWT payload 必须是 JSON 对象', { code: 'jwt_invalid' });
	}
	return /** @type {Record<string, any>} */ (payload);
}

/**
 * 从 Codex access token 的 JWT claim 里取 chatgpt_account_id。
 * 失败时给出明确提示，不静默返回空。
 * @param {string} token
 * @returns {string}
 */
export function codexAccountIdFromToken(token) {
	const payload = decodeJwtPayload(token);
	const auth = payload[CODEX_AUTH_CLAIM];
	// cc-switch 同时容忍顶层的 chatgpt_account_id；这里保持一致。
	const nested =
		auth && typeof auth === 'object' && typeof auth.chatgpt_account_id === 'string'
			? auth.chatgpt_account_id.trim()
			: '';
	const topLevel =
		typeof payload.chatgpt_account_id === 'string' ? payload.chatgpt_account_id.trim() : '';
	const accountId = nested || topLevel;
	if (!accountId) {
		throw new OAuthError(`JWT payload 缺少 ${CODEX_AUTH_CLAIM}.chatgpt_account_id`, {
			code: 'account_id_missing',
			hint: '请设置 OPENAI_ACCOUNT_ID，或重新运行 codex login'
		});
	}
	return accountId;
}

/**
 * token 是否长得像 JWT。OAuth 环境变量里也可能放不透明 token（某些网关），
 * 这种 token 无法解出 account_id，只能要求用户显式提供 OPENAI_ACCOUNT_ID。
 * @param {string} token
 */
function looksLikeJwt(token) {
	return token.split('.').length === 3;
}

/**
 * 读取 Codex（ChatGPT 订阅）凭据。
 *
 * 优先级：`OPENAI_OAUTH_TOKEN`（可选 `OPENAI_ACCOUNT_ID`）→ `~/.codex/auth.json`
 * 的 `tokens.access_token` / `tokens.account_id`。文件里没有 account_id 时从 JWT 解。
 *
 * @param {{env?: Record<string, string | undefined>, home?: string, file?: string}} [options]
 * @returns {{token: string, accountId: string | null, source: string}}
 */
export function readCodexOAuth(options = {}) {
	const env = options.env ?? process.env;
	const home = options.home ?? os.homedir();

	const envToken = String(env.OPENAI_OAUTH_TOKEN ?? '').trim();
	const envAccountId = String(env.OPENAI_ACCOUNT_ID ?? '').trim();

	if (envToken) {
		/** @type {string | null} */
		let accountId = envAccountId || null;
		if (!accountId && looksLikeJwt(envToken)) accountId = codexAccountIdFromToken(envToken);
		return { token: envToken, accountId, source: 'env:OPENAI_OAUTH_TOKEN' };
	}

	const file = options.file ?? codexAuthPath(home);
	const shown = displayPath(file, home);
	const json = readCredentialJson(file, {
		home,
		label: 'Codex CLI',
		loginHint: '请先在终端运行 codex login'
	});

	const tokens = json?.tokens && typeof json.tokens === 'object' && !Array.isArray(json.tokens) ? json.tokens : {};
	const token =
		typeof tokens.access_token === 'string' && tokens.access_token.trim()
			? tokens.access_token.trim()
			: typeof json?.access_token === 'string' && json.access_token.trim()
				? json.access_token.trim()
				: '';
	if (!token) {
		throw new OAuthError(`${shown} 缺少 tokens.access_token`, {
			code: 'credentials_invalid',
			hint: '请重新运行 codex login'
		});
	}

	const storedAccountId =
		typeof tokens.account_id === 'string' && tokens.account_id.trim()
			? tokens.account_id.trim()
			: typeof json?.account_id === 'string' && json.account_id.trim()
				? json.account_id.trim()
				: '';

	/** @type {string | null} */
	let accountId = envAccountId || storedAccountId || null;
	if (!accountId && looksLikeJwt(token)) accountId = codexAccountIdFromToken(token);

	return { token, accountId, source: `file:${shown}` };
}
