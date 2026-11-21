// @ts-check
/**
 * OpenAI Responses API 线格式（Codex / ChatGPT 订阅）。
 *
 * 与 chat/completions 的差别：
 * - 端点固定 `POST {baseUrl}/responses`；
 * - 请求体用 `input` / `content[].input_text` / `max_output_tokens`；
 * - 响应文本在 `output[].content[].output_text`，部分网关只给便捷字段 `output_text`；
 * - 截断看 `status === "incomplete"` 与 `incomplete_details.reason`。
 */

import { InvalidOutputError } from '../format.mjs';
import { CODEX_ORIGINATOR } from '../oauth.mjs';
import { ProtocolError } from './http.mjs';

/**
 * @param {{
 *   provider: {
 *     baseUrl: string,
 *     protocol?: string,
 *     apiKey?: string,
 *     auth?: string,
 *     accountId?: string | null,
 *     account_id?: string | null
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

	const accountId = provider.accountId ?? provider.account_id ?? '';
	const isOauth =
		provider.auth === 'oauth' || provider.auth === 'codex-oauth' || provider.protocol === 'openai-oauth';
	if (isOauth && !accountId) {
		// 本地配置问题：不要带着空 header 去换一个 401，直接告诉用户缺什么。
		throw new ProtocolError(
			'missing_chatgpt_account_id: Codex OAuth 需要 chatgpt-account-id；' +
				'请设置 OPENAI_ACCOUNT_ID，或确认 ~/.codex/auth.json 的 tokens.account_id / JWT claim 可用',
			{ retryable: false }
		);
	}

	/** @type {Record<string, string>} */
	const headers = {
		'Content-Type': 'application/json',
		originator: CODEX_ORIGINATOR
	};
	if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
	if (accountId) headers['chatgpt-account-id'] = accountId;

	const body = {
		model,
		input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
		max_output_tokens: maxTokens,
		temperature
	};

	return {
		url: `${provider.baseUrl}/responses`,
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
	const status = typeof json?.status === 'string' ? json.status : null;
	const incompleteReason =
		typeof json?.incomplete_details?.reason === 'string' ? json.incomplete_details.reason : null;

	// 与 router 的截断语义一致：内容不完整就当作无效输出，交给 service 重试/弃权。
	if (status === 'incomplete' || incompleteReason === 'max_output_tokens') {
		throw new InvalidOutputError(`responses_incomplete_${incompleteReason ?? 'unknown'}`);
	}

	let text = '';
	const output = json?.output;
	if (Array.isArray(output)) {
		for (const item of output) {
			// 只取 message 项；reasoning / tool_call 里没有答案文本。
			if (item?.type && item.type !== 'message') continue;
			const content = item?.content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text;
			}
		}
	}
	// 部分网关（或精简模式）只返回便捷字段 output_text。
	if (!text && typeof json?.output_text === 'string') text = json.output_text;

	return {
		text,
		finishReason: status,
		usage: {
			inputTokens: typeof json?.usage?.input_tokens === 'number' ? json.usage.input_tokens : null,
			outputTokens: typeof json?.usage?.output_tokens === 'number' ? json.usage.output_tokens : null
		},
		// Responses API 不提供本服务可用的 logprobs。
		margin: null
	};
}
