import test from 'node:test';
import assert from 'node:assert/strict';

import * as anthropic from '../src/protocols/anthropic.mjs';
import * as gemini from '../src/protocols/gemini.mjs';
import * as responses from '../src/protocols/responses.mjs';
import { ProtocolError, fetchJson } from '../src/protocols/http.mjs';
import * as openai from '../src/protocols/openai.mjs';

const PROMPT = '你是答题助手\n\n题型：单选题';

const OPENAI_PROVIDER = { baseUrl: 'https://api.openai.test/v1', apiKey: 'sk-test', auth: 'api-key' };

test('openai.buildRequest：URL、Bearer 头、body 形状、signal 透传', () => {
	const signal = AbortSignal.timeout(1000);
	const { url, init } = openai.buildRequest({
		provider: OPENAI_PROVIDER,
		model: 'gpt-test',
		prompt: PROMPT,
		maxTokens: 32,
		temperature: 0,
		signal
	});

	assert.equal(url, 'https://api.openai.test/v1/chat/completions');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.Authorization, 'Bearer sk-test');
	assert.equal(init.headers['Content-Type'], 'application/json');
	assert.equal(init.signal, signal);

	const body = JSON.parse(String(init.body));
	assert.deepEqual(body, {
		model: 'gpt-test',
		messages: [{ role: 'user', content: PROMPT }],
		temperature: 0,
		max_tokens: 32,
		stream: false
	});
});

test('openai.parseResponse：文本、finishReason、usage、logprobs margin', () => {
	const parsed = openai.parseResponse({
		choices: [
			{
				message: { content: '1' },
				finish_reason: 'stop',
				logprobs: {
					content: [
						{
							token: '1',
							top_logprobs: [
								{ token: '1', logprob: Math.log(0.6) },
								{ token: '3', logprob: Math.log(0.3) }
							]
						}
					]
				}
			}
		],
		usage: { prompt_tokens: 12, completion_tokens: 1 }
	});

	assert.equal(parsed.text, '1');
	assert.equal(parsed.finishReason, 'stop');
	assert.deepEqual(parsed.usage, { inputTokens: 12, outputTokens: 1 });
	assert.ok(Math.abs(parsed.margin - 0.3) < 1e-9, `margin=${parsed.margin}`);
});

test('openai.parseResponse：无 logprobs 时 margin=null；空 content 得到空串', () => {
	const parsed = openai.parseResponse({ choices: [{ message: { content: '' }, finish_reason: 'length' }] });
	assert.equal(parsed.text, '');
	assert.equal(parsed.finishReason, 'length');
	assert.equal(parsed.margin, null);

	assert.throws(() => openai.parseResponse({ choices: [] }), ProtocolError);
});

test('anthropic.buildRequest：x-api-key、版本头、max_tokens 必填、content block', () => {
	const { url, init } = anthropic.buildRequest({
		provider: { baseUrl: 'https://api.anthropic.test/v1', apiKey: 'ak-test', auth: 'api-key' },
		model: 'claude-test',
		prompt: PROMPT,
		maxTokens: 32,
		temperature: 0
	});

	assert.equal(url, 'https://api.anthropic.test/v1/messages');
	assert.equal(init.headers['x-api-key'], 'ak-test');
	assert.equal(init.headers['anthropic-version'], '2023-06-01');
	assert.equal(init.headers.Authorization, undefined);

	const body = JSON.parse(String(init.body));
	assert.equal(body.model, 'claude-test');
	assert.equal(body.max_tokens, 32);
	assert.equal(body.temperature, 0);
	assert.deepEqual(body.messages, [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }]);
});

test('anthropic.buildRequest：OAuth 用 Bearer + beta 头，不再发 x-api-key', () => {
	const { init } = anthropic.buildRequest({
		provider: { baseUrl: 'https://api.anthropic.test/v1', apiKey: 'oauth-token', auth: 'oauth' },
		model: 'claude-test',
		prompt: PROMPT,
		maxTokens: 64
	});

	assert.equal(init.headers.Authorization, 'Bearer oauth-token');
	assert.equal(init.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
	assert.equal(init.headers['x-api-key'], undefined);
	assert.equal(init.headers['x-app'], undefined, '默认不伪装指纹');
});

test('anthropic.parseResponse：拼接 text block，忽略非 text；margin 恒为 null', () => {
	const parsed = anthropic.parseResponse({
		content: [
			{ type: 'thinking', thinking: '...' },
			{ type: 'text', text: '1' },
			{ type: 'tool_use', id: 'x' },
			{ type: 'text', text: ',3' }
		],
		stop_reason: 'end_turn',
		usage: { input_tokens: 9, output_tokens: 2 }
	});

	assert.equal(parsed.text, '1,3');
	assert.equal(parsed.finishReason, 'end_turn');
	assert.deepEqual(parsed.usage, { inputTokens: 9, outputTokens: 2 });
	assert.equal(parsed.margin, null);

	const truncated = anthropic.parseResponse({ content: [], stop_reason: 'max_tokens' });
	assert.equal(truncated.text, '');
	assert.equal(truncated.finishReason, 'max_tokens');
});

test('gemini.buildRequest：models/{model}:generateContent、x-goog-api-key、generationConfig', () => {
	const { url, init } = gemini.buildRequest({
		provider: { baseUrl: 'https://gemini.test/v1beta', apiKey: 'gk-test', auth: 'api-key' },
		model: 'gemini-2.5-pro',
		prompt: PROMPT,
		maxTokens: 32,
		temperature: 0
	});

	assert.equal(url, 'https://gemini.test/v1beta/models/gemini-2.5-pro:generateContent');
	assert.equal(init.headers['x-goog-api-key'], 'gk-test');
	assert.equal(init.headers.Authorization, undefined);

	const body = JSON.parse(String(init.body));
	assert.deepEqual(body, {
		contents: [{ role: 'user', parts: [{ text: PROMPT }] }],
		generationConfig: { temperature: 0, maxOutputTokens: 32 }
	});
});

test('gemini.parseResponse：拼接 parts，STOP / MAX_TOKENS 与空 content', () => {
	const stopped = gemini.parseResponse({
		candidates: [{ content: { parts: [{ text: '1' }, { text: ',2' }] }, finishReason: 'STOP' }],
		usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 3 }
	});
	assert.equal(stopped.text, '1,2');
	assert.equal(stopped.finishReason, 'STOP');
	assert.deepEqual(stopped.usage, { inputTokens: 8, outputTokens: 3 });
	assert.equal(stopped.margin, null);

	const truncated = gemini.parseResponse({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] });
	assert.equal(truncated.text, '');
	assert.equal(truncated.finishReason, 'MAX_TOKENS');
});

test('fetchJson：429/5xx/网络错误与 401/403/404 可切换，400 致命；错误带状态码与响应体前 200 字', async () => {
	const respond = (body, status) => async () => new Response(body, { status });

	const rateLimited = await fetchJson(
		{ url: 'https://x.test', init: {} },
		respond('rate limited', 429)
	).catch((error) => error);
	assert.ok(rateLimited instanceof ProtocolError);
	assert.equal(rateLimited.status, 429);
	assert.equal(rateLimited.retryable, true);
	assert.equal(rateLimited.authFailure, false);
	assert.match(rateLimited.message, /http_429/);
	assert.match(rateLimited.message, /rate limited/);

	const serverError = await fetchJson({ url: 'https://x.test', init: {} }, respond('boom', 503)).catch(
		(error) => error
	);
	assert.equal(serverError.retryable, true);
	assert.equal(serverError.authFailure, false);

	for (const status of [401, 403, 404]) {
		const authFailed = await fetchJson({ url: 'https://x.test', init: {} }, respond('nope', status)).catch(
			(error) => error
		);
		assert.equal(authFailed.status, status);
		assert.equal(authFailed.retryable, true, `${status} 应可切换下一家`);
		assert.equal(authFailed.authFailure, true, `${status} 应标记为 authFailure`);
	}

	const badRequest = await fetchJson({ url: 'https://x.test', init: {} }, respond('bad request', 400)).catch(
		(error) => error
	);
	assert.equal(badRequest.status, 400);
	assert.equal(badRequest.retryable, false, '400 是请求体问题，换谁都一样');
	assert.equal(badRequest.authFailure, false);

	const network = await fetchJson(
		{ url: 'https://x.test', init: {} },
		async () => {
			throw new Error('ECONNREFUSED');
		}
	).catch((error) => error);
	assert.equal(network.retryable, true);
	assert.match(network.message, /network_error/);
});

test('anthropic.buildRequest：auth=bearer 只发 Bearer，不带订阅 beta', () => {
	const { init } = anthropic.buildRequest({
		provider: { baseUrl: 'https://gw.test/anthropic/v1', apiKey: 'gw-token', auth: 'bearer' },
		model: 'claude-x',
		prompt: PROMPT,
		maxTokens: 32
	});

	assert.equal(init.headers.Authorization, 'Bearer gw-token');
	assert.equal(init.headers['x-api-key'], undefined);
	assert.equal(init.headers['anthropic-beta'], undefined, '网关不需要订阅 beta');
});

test('gemini.buildRequest：auth=bearer 用 Authorization，不发 x-goog-api-key', () => {
	const { init } = gemini.buildRequest({
		provider: { baseUrl: 'https://gw.test/google/v1beta', apiKey: 'gw-token', auth: 'bearer' },
		model: 'gemini-x',
		prompt: PROMPT,
		maxTokens: 32
	});

	assert.equal(init.headers.Authorization, 'Bearer gw-token');
	assert.equal(init.headers['x-goog-api-key'], undefined);
});

test('responses.buildRequest：auth=bearer 只发 Bearer，不发 Codex 指纹头', () => {
	const { url, init } = responses.buildRequest({
		provider: { baseUrl: 'https://gw.test/openai/v1', apiKey: 'gw-token', auth: 'bearer' },
		model: 'gpt-x',
		prompt: PROMPT,
		maxTokens: 32
	});

	assert.equal(url, 'https://gw.test/openai/v1/responses');
	assert.equal(init.headers.Authorization, 'Bearer gw-token');
	assert.equal(init.headers.originator, undefined, 'originator 只属于 Codex 订阅');
	assert.equal(init.headers['chatgpt-account-id'], undefined);

	const body = JSON.parse(String(init.body));
	assert.deepEqual(body.input, [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }]);
	assert.equal(body.max_output_tokens, 32);
	assert.equal(body.temperature, 0);
});

test('responses.buildRequest：codex-oauth 才发 originator + account id，缺 account id 立即报错', () => {
	const { init } = responses.buildRequest({
		provider: {
			baseUrl: 'https://chatgpt.test/backend-api/codex',
			apiKey: 'tok',
			auth: 'codex-oauth',
			accountId: 'acct-1'
		},
		model: 'gpt-5-codex',
		prompt: PROMPT,
		maxTokens: 32
	});

	assert.equal(init.headers.originator, 'codex_cli_rs');
	assert.equal(init.headers['chatgpt-account-id'], 'acct-1');
	assert.equal(init.headers.Authorization, 'Bearer tok');

	assert.throws(
		() =>
			responses.buildRequest({
				provider: { baseUrl: 'https://chatgpt.test/backend-api/codex', apiKey: 'tok', auth: 'codex-oauth' },
				model: 'gpt-5-codex',
				prompt: PROMPT,
				maxTokens: 32
			}),
		/missing_chatgpt_account_id/
	);
});

test('responses.parseResponse：output[] 拼接、output_text 回退、incomplete 视为截断', () => {
	const parsed = responses.parseResponse({
		status: 'completed',
		output: [
			{ type: 'reasoning', content: [] },
			{ type: 'message', content: [{ type: 'output_text', text: '1' }, { type: 'output_text', text: ',3' }] }
		],
		usage: { input_tokens: 10, output_tokens: 2 }
	});

	assert.equal(parsed.text, '1,3');
	assert.equal(parsed.finishReason, 'completed');
	assert.deepEqual(parsed.usage, { inputTokens: 10, outputTokens: 2 });

	assert.equal(responses.parseResponse({ status: 'completed', output_text: '2' }).text, '2', '网关便捷字段回退');

	assert.throws(
		() =>
			responses.parseResponse({
				status: 'incomplete',
				incomplete_details: { reason: 'max_output_tokens' }
			}),
		/responses_incomplete/
	);
});
