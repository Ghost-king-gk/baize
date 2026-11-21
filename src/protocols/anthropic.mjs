// @ts-check
/** Anthropic Messages 线格式（含实验性订阅 OAuth 头）。 */

import { ProtocolError } from './http.mjs';

export const ANTHROPIC_VERSION = '2023-06-01';
export const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * @param {{
 *   provider: {baseUrl: string, apiKey?: string, auth?: string},
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
	const headers = {
		'Content-Type': 'application/json',
		'anthropic-version': ANTHROPIC_VERSION
	};

	if (provider.auth === 'oauth' && provider.apiKey) {
		// 订阅 OAuth：Bearer + beta 头，不能再用 x-api-key。
		headers.Authorization = `Bearer ${provider.apiKey}`;
		headers['anthropic-beta'] = OAUTH_BETA;
	} else if (provider.apiKey) {
		headers['x-api-key'] = provider.apiKey;
	}

	const body = {
		model,
		// max_tokens 在 Anthropic 是必填字段。
		max_tokens: maxTokens,
		temperature,
		messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
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
 * @returns {{text: string, finishReason: string | null, usage: {inputTokens: number | null, outputTokens: number | null}, margin: null}}
 */
export function parseResponse(json) {
	const content = json?.content;
	if (!Array.isArray(content)) throw new ProtocolError('response_without_content', { retryable: true });

	const text = content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('');

	return {
		text,
		finishReason: typeof json?.stop_reason === 'string' ? json.stop_reason : null,
		usage: {
			inputTokens: typeof json?.usage?.input_tokens === 'number' ? json.usage.input_tokens : null,
			outputTokens: typeof json?.usage?.output_tokens === 'number' ? json.usage.output_tokens : null
		},
		// Anthropic 不提供 logprobs。
		margin: null
	};
}
