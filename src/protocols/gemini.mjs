// @ts-check
/** Google Gemini generateContent 线格式。 */

import { mergeHeaders, ProtocolError } from './http.mjs';
import { costFields, numberOrNull } from './usage.mjs';

/**
 * @param {{
 *   provider: {baseUrl: string, apiKey?: string, auth?: string, headers?: Record<string, string>},
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
	const headers = mergeHeaders(provider);
	if (provider.apiKey) {
		// auth=bearer 走网关（如 OpenCode Inference）；缺省 api-key 仍用 Google 原生头。
		if (provider.auth === 'bearer') headers.Authorization = `Bearer ${provider.apiKey}`;
		else headers['x-goog-api-key'] = provider.apiKey;
	}

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
 * @returns {{text: string, finishReason: string | null, usage: import('./usage.mjs').Usage, margin: null}}
 */
export function parseResponse(json) {
	const candidate = json?.candidates?.[0];
	if (!candidate) throw new ProtocolError('response_without_candidates', { retryable: true });

	const usage = json?.usageMetadata;

	const parts = candidate.content?.parts;
	const text = Array.isArray(parts) ? parts.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') : '';

	return {
		text,
		// STOP 正常；MAX_TOKENS 由 router 视为截断。
		finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : null,
		usage: {
			inputTokens: numberOrNull(usage?.promptTokenCount),
			outputTokens: numberOrNull(usage?.candidatesTokenCount),
			reasoningTokens: numberOrNull(usage?.thoughtsTokenCount),
			cachedTokens: numberOrNull(usage?.cachedContentTokenCount),
			...costFields(usage)
		},
		// Gemini 不提供 logprobs。
		margin: null
	};
}
