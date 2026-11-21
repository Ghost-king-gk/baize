// @ts-check
/** Google Gemini generateContent 线格式。 */

import { ProtocolError } from './http.mjs';

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
	const headers = { 'Content-Type': 'application/json' };
	if (provider.apiKey) headers['x-goog-api-key'] = provider.apiKey;

	const body = {
		contents: [{ role: 'user', parts: [{ text: prompt }] }],
		generationConfig: {
			temperature,
			maxOutputTokens: maxTokens
		}
	};

	return {
		// 官方要求 model 是裸 id（如 gemini-2.5-pro），不是 models/xxx 完整路径。
		url: `${provider.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
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
	const candidate = json?.candidates?.[0];
	if (!candidate) throw new ProtocolError('response_without_candidates', { retryable: true });

	const parts = candidate.content?.parts;
	const text = Array.isArray(parts) ? parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : '';

	return {
		text,
		// STOP 正常；MAX_TOKENS 由 router 视为截断。
		finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
		usage: {
			inputTokens:
				typeof json?.usageMetadata?.promptTokenCount === 'number' ? json.usageMetadata.promptTokenCount : null,
			outputTokens:
				typeof json?.usageMetadata?.candidatesTokenCount === 'number'
					? json.usageMetadata.candidatesTokenCount
					: null
		},
		// Gemini 不提供 logprobs。
		margin: null
	};
}
