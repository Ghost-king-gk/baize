// @ts-check
/** OpenAI Chat Completions 线格式。 */

import { ProtocolError } from './http.mjs';

/**
 * @param {{
 *   provider: {baseUrl: string, apiKey?: string, auth?: string},
 *   model: string,
 *   prompt: string,
 *   maxTokens: number,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   logprobs?: boolean
 * }} input
 * @returns {{url: string, init: RequestInit}}
 */
export function buildRequest(input) {
	const { provider, model, prompt, maxTokens, temperature = 0, signal, logprobs } = input;

	/** @type {Record<string, string>} */
	const headers = { 'Content-Type': 'application/json' };
	if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;

	/** @type {Record<string, any>} */
	const body = {
		model,
		messages: [{ role: 'user', content: prompt }],
		temperature,
		max_tokens: maxTokens,
		stream: false
	};
	if (logprobs) {
		body.logprobs = true;
		body.top_logprobs = 5;
	}

	return {
		url: `${provider.baseUrl}/chat/completions`,
		init: {
			method: 'POST',
			headers,
			body: JSON.stringify(body),
			...(signal ? { signal } : {})
		}
	};
}

/**
 * logprobs 存在时，取第一个拥有 top-2 候选的 token，返回概率差（最高 - 次高）。
 * 不请求 logprobs 的供应商返回 null。
 * @param {any} choice
 * @returns {number | null}
 */
export function marginFromChoice(choice) {
	const content = choice?.logprobs?.content;
	if (!Array.isArray(content)) return null;

	for (const token of content) {
		const tops = token?.top_logprobs;
		if (!Array.isArray(tops) || tops.length < 2) continue;
		const probabilities = tops
			.filter((top) => typeof top?.logprob === 'number')
			.map((top) => Math.exp(top.logprob))
			.sort((a, b) => b - a);
		if (probabilities.length < 2) continue;
		return probabilities[0] - probabilities[1];
	}
	return null;
}

/**
 * @param {any} json
 * @returns {{text: string, finishReason: string | null, usage: {inputTokens: number | null, outputTokens: number | null}, margin: number | null}}
 */
export function parseResponse(json) {
	const choice = json?.choices?.[0];
	if (!choice) throw new ProtocolError('response_without_choices', { retryable: true });

	const content = choice.message?.content;
	let text = '';
	if (typeof content === 'string') text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((part) => {
				if (typeof part === 'string') return part;
				return typeof part?.text === 'string' ? part.text : '';
			})
			.join('');
	}

	return {
		text,
		finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
		usage: {
			inputTokens: typeof json?.usage?.prompt_tokens === 'number' ? json.usage.prompt_tokens : null,
			outputTokens: typeof json?.usage?.completion_tokens === 'number' ? json.usage.completion_tokens : null
		},
		margin: marginFromChoice(choice)
	};
}
