// @ts-check
/** Anthropic Messages 线格式（含实验性订阅 OAuth 头）。 */

import {
	ANTHROPIC_OAUTH_BETA,
	CLAUDE_CODE_IDENTITY,
	DEFAULT_CLAUDE_CODE_USER_AGENT
} from '../oauth.mjs';
import { mergeHeaders, ProtocolError } from './http.mjs';
import { costFields, numberOrNull } from './usage.mjs';

export const ANTHROPIC_VERSION = '2023-06-01';
export { OAUTH_BETA, CLAUDE_CODE_BETA, ANTHROPIC_OAUTH_BETA } from '../oauth.mjs';

/**
 * @param {{
 *   provider: {
 *     baseUrl: string,
 *     protocol?: string,
 *     apiKey?: string,
 *     auth?: string,
 *     impersonate?: boolean | string,
 *     userAgent?: string
 *   },
 *   model: string,
 *   prompt: string,
 *   maxTokens: number,
 *   temperature?: number,
 *   signal?: AbortSignal
 * }} input
 * @returns {{url: string, init: RequestInit}}
 */
export function buildRequest(input) {
	const { provider, model, prompt, maxTokens, temperature = 0, signal } = input;

	/** @type {Record<string, string>} */
	const headers = mergeHeaders(provider, { 'anthropic-version': ANTHROPIC_VERSION });

	// auth 与线协议正交：
	// - api-key（默认）→ x-api-key；
	// - bearer → Authorization: Bearer，不带任何供应商 beta/指纹头；
	// - oauth（Claude 订阅）→ Bearer + beta + 可选伪装；
	// - 旧写法 protocol=anthropic-oauth 等价于 auth=oauth。
	const auth = provider.auth ?? (provider.protocol === 'anthropic-oauth' ? 'oauth' : 'api-key');
	const isOauth = auth === 'oauth';
	const isBearer = isOauth || auth === 'bearer';

	if (isBearer && provider.apiKey) {
		headers.Authorization = `Bearer ${provider.apiKey}`;
		if (isOauth) {
			headers['anthropic-beta'] = ANTHROPIC_OAUTH_BETA;

			if (provider.impersonate) {
				// 可选指纹伪装：只有用户显式开启才发，避免向普通网关暴露 Claude Code 身份。
				headers['x-app'] = 'cli';
				headers['User-Agent'] =
					typeof provider.impersonate === 'string'
						? provider.impersonate
						: provider.userAgent || DEFAULT_CLAUDE_CODE_USER_AGENT;
			}
		}
	} else if (provider.apiKey) {
		headers['x-api-key'] = provider.apiKey;
	}

	// Claude 订阅套餐要求首条内容以 Claude Code 身份开头；伪装关闭时保持原 prompt 不变。
	const text =
		isOauth && provider.impersonate
			? `${CLAUDE_CODE_IDENTITY}\n\n${prompt}`
			: prompt;

	const body = {
		model,
		// max_tokens 在 Anthropic 是必填字段。
		max_tokens: maxTokens,
		temperature,
		messages: [{ role: 'user', content: [{ type: 'text', text }] }]
	};

	return {
		url: `${provider.baseUrl}/messages`,
		init: {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			...(signal ? { signal } : {})
		}
	};
}

/**
 * @param {any} json
 * @returns {{text: string, finishReason: string | null, usage: import('./usage.mjs').Usage, margin: null}}
 */
export function parseResponse(json) {
	const content = json?.content;
	if (!Array.isArray(content)) throw new ProtocolError('response_without_content', { retryable: true });

	const usage = json?.usage;

	const text = content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('');

	return {
		text,
		finishReason: typeof json?.stop_reason === 'string' ? json.stop_reason : null,
		usage: {
			inputTokens: numberOrNull(usage?.input_tokens),
			outputTokens: numberOrNull(usage?.output_tokens),
			// Anthropic Messages 不返回 reasoning token 计数。
			reasoningTokens: null,
			cachedTokens: numberOrNull(usage?.cache_read_input_tokens),
			...costFields(usage)
		},
		// Anthropic 不提供 logprobs。
		margin: null
	};
}
