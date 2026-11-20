import test from 'node:test';
import assert from 'node:assert/strict';

import { InvalidOutputError } from '../src/format.mjs';
import { MockProvider, OpenAIProvider, ProviderError, marginFromLogprobs } from '../src/provider.mjs';
import { buildPrompt } from '../src/prompt.mjs';

/**
 * @param {unknown} payload
 * @param {{status?: number, capture?: any[]}} [options]
 */
function stubFetch(payload, options = {}) {
	const status = options.status ?? 200;
	return async (url, init) => {
		options.capture?.push({ url, init });
		const body = typeof payload === 'function' ? payload(url, init) : payload;
		return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});
	};
}

function chatResponse(content, extra = {}) {
	return {
		choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }]
	};
}

const OPTIONS = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];

function singlePrompt(order = [0, 1, 2, 3]) {
	return buildPrompt({ type: 'single', title: '1+2 = ?', options: OPTIONS, order });
}

test('OpenAIProvider：把打乱后的序号映射回原始下标', async () => {
	const calls = [];
	// 展示顺序：原始 3,1,2,4 → 模型选展示位 1 → 原始下标 3（1-based）
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid/v1/',
		apiKey: 'test-key',
		model: 'test-model',
		fetchImpl: stubFetch(chatResponse('1'), { capture: calls })
	});

	const result = await provider.ask(singlePrompt([2, 0, 1, 3]), { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [3]);

	const { url, init } = calls[0];
	assert.equal(url, 'http://model.invalid/v1/chat/completions');
	assert.equal(init.method, 'POST');
	assert.equal(init.headers.Authorization, 'Bearer test-key');

	const body = JSON.parse(init.body);
	assert.equal(body.model, 'test-model');
	assert.equal(body.temperature, 0);
	assert.equal(body.max_tokens, 32);
	assert.equal(body.stream, false);
	assert.equal(body.logprobs, undefined, '默认不能带 logprobs，避免网关 400');

	const user = body.messages[1].content;
	assert.match(user, /1\) 3/);
	assert.match(user, /2\) 1/);
	assert.match(user, /3\) 2/);
	assert.doesNotMatch(init.body, /A\. 1/, '模型不应该看到选项字母前缀');
});

test('OpenAIProvider：多选序号解析 + 排序', async () => {
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid/v1',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch(chatResponse('3, 1'))
	});
	const prompt = buildPrompt({ type: 'multiple', title: 't', options: OPTIONS, order: [3, 2, 1, 0] });
	// 展示位 3 → 原始 1（字母 2）；展示位 1 → 原始 3（字母 4）
	const result = await provider.ask(prompt, { type: 'multiple', optionCount: 4 });
	assert.deepEqual(result.letters, [2, 4]);
});

test('OpenAIProvider：finish_reason=length 视为无效输出', async () => {
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch({ choices: [{ message: { content: '1' }, finish_reason: 'length' }] })
	});
	await assert.rejects(() => provider.ask(singlePrompt(), { type: 'single', optionCount: 4 }), InvalidOutputError);
});

test('OpenAIProvider：越界/非法输出抛 InvalidOutputError', async () => {
	const make = (content) =>
		new OpenAIProvider({
			baseUrl: 'http://model.invalid',
			apiKey: 'k',
			model: 'm',
			fetchImpl: stubFetch(chatResponse(content))
		});

	await assert.rejects(() => make('9').ask(singlePrompt(), { type: 'single', optionCount: 4 }), InvalidOutputError);
	await assert.rejects(() => make('1,3').ask(singlePrompt(), { type: 'single', optionCount: 4 }), InvalidOutputError);
	await assert.rejects(() => make('好的，我选 C').ask(singlePrompt(), { type: 'single', optionCount: 4 }), InvalidOutputError);
});

test('OpenAIProvider：HTTP 错误 / 网络错误 / 响应结构错误 → ProviderError', async () => {
	const http = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch('rate limited', { status: 429 })
	});
	await assert.rejects(() => http.ask(singlePrompt(), { type: 'single', optionCount: 4 }), ProviderError);

	const network = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: async () => {
			throw new Error('ECONNREFUSED');
		}
	});
	await assert.rejects(() => network.ask(singlePrompt(), { type: 'single', optionCount: 4 }), ProviderError);

	const noChoices = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch({ choices: [] })
	});
	await assert.rejects(() => noChoices.ask(singlePrompt(), { type: 'single', optionCount: 4 }), ProviderError);

	const notJson = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch('<html>gateway</html>')
	});
	await assert.rejects(() => notJson.ask(singlePrompt(), { type: 'single', optionCount: 4 }), ProviderError);
});

test('OpenAIProvider：content 为分段数组时也能取到文本', async () => {
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch({ choices: [{ message: { content: [{ type: 'text', text: '2' }] }, finish_reason: 'stop' }] })
	});
	const result = await provider.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [2]);
});

test('OpenAIProvider：填空走 answers，max_tokens 放宽', async () => {
	const calls = [];
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		fetchImpl: stubFetch(chatResponse('["北京","上海"]'), { capture: calls })
	});
	const prompt = buildPrompt({ type: 'completion', title: '首都', options: [], order: [0] });
	const result = await provider.ask(prompt, { type: 'completion', optionCount: 0 });
	assert.deepEqual(result.answers, ['北京', '上海']);
	assert.deepEqual(result.letters, []);
	assert.equal(JSON.parse(calls[0].init.body).max_tokens, 600);
});

test('OpenAIProvider：开启 logprobs 时计算 margin', async () => {
	const calls = [];
	const choice = {
		message: { content: '1' },
		finish_reason: 'stop',
		logprobs: {
			content: [
				{
					token: '1',
					top_logprobs: [
						{ token: '1', logprob: Math.log(0.7) },
						{ token: '3', logprob: Math.log(0.2) },
						{ token: '2', logprob: Math.log(0.1) }
					]
				}
			]
		}
	};
	const provider = new OpenAIProvider({
		baseUrl: 'http://model.invalid',
		apiKey: 'k',
		model: 'm',
		logprobs: true,
		fetchImpl: stubFetch({ choices: [choice] }, { capture: calls })
	});

	const result = await provider.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(JSON.parse(calls[0].init.body).logprobs, true);
	assert.ok(Math.abs(result.margin - 0.5) < 1e-9, `margin=${result.margin}`);
});

test('marginFromLogprobs：缺少数据时返回 undefined，不瞎猜', () => {
	assert.equal(marginFromLogprobs(undefined), undefined);
	assert.equal(marginFromLogprobs({}), undefined);
	assert.equal(marginFromLogprobs({ logprobs: { content: [{ top_logprobs: [] }] } }), undefined);
	assert.equal(
		marginFromLogprobs({ logprobs: { content: [{ top_logprobs: [{ token: '1', logprob: 0 }] }] } }),
		undefined
	);
});

test('MockProvider：预置答案、不联网；fromEnv 解析环境变量', async () => {
	const provider = new MockProvider({ letters: [3], answers: ['甲'], margin: 0.9 });
	const prompt = singlePrompt([1, 0, 3, 2]);
	const result = await provider.ask(prompt, { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [3], 'mock 的 letters 是原始下标，不受打乱影响');
	assert.equal(result.margin, 0.9);

	const fromEnv = MockProvider.fromEnv({
		ANSWERER_MOCK_LETTERS: '1,3',
		ANSWERER_MOCK_ANSWERS: 'a;b',
		ANSWERER_MOCK_MARGIN: '0.4'
	});
	const multi = await fromEnv.ask(prompt, { type: 'multiple', optionCount: 4 });
	assert.deepEqual(multi.letters, [1, 3]);
	const completion = await fromEnv.ask(prompt, { type: 'completion', optionCount: 0 });
	assert.deepEqual(completion.answers, ['a', 'b']);
	assert.equal(completion.margin, 0.4);
});
