import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { API_PROTOCOLS, CatalogError, createCatalog } from '../src/catalog.mjs';

const GO_URL = 'https://opencode.ai/inference/go/v1/models';
const FIXTURE = JSON.parse(
	readFileSync(fileURLToPath(new URL('./fixtures/opencode-go-models.json', import.meta.url)), 'utf8')
);

/**
 * @param {any} payload
 * @param {Array<{url: string, init: any}>} calls
 */
function stubFetch(payload, calls) {
	return async (url, init) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	};
}

/** @param {() => Promise<any>} fn */
async function catalogError(fn) {
	try {
		await fn();
	} catch (error) {
		assert.ok(error instanceof CatalogError, `应为 CatalogError，收到: ${error?.name}`);
		return error;
	}
	assert.fail('应该抛错');
}

test('目录：四种 api 键映射到四种 protocol，baseUrl 原样取目录', async () => {
	assert.deepEqual(API_PROTOCOLS, {
		'chat-completions': 'openai',
		responses: 'responses',
		messages: 'anthropic',
		'generate-content': 'gemini'
	});

	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'stub-token', fetchImpl: stubFetch(FIXTURE, calls) });

	/** @type {Array<[string, string, string]>} */
	const cases = [
		['deepseek-v4.1-flash', 'openai', 'https://opencode.ai/inference/go/openai/v1'],
		['gpt-6-luna', 'responses', 'https://opencode.ai/inference/go/openai/v1'],
		['claude-haiku-5-5', 'anthropic', 'https://opencode.ai/inference/go/anthropic/v1'],
		['gemini-4-argon', 'gemini', 'https://opencode.ai/inference/go/google/v1beta']
	];

	for (const [modelId, protocol, baseUrl] of cases) {
		const resolved = await catalog.resolve(modelId);
		assert.deepEqual(resolved, { protocol, baseUrl, ownedBy: 'opencode', modelId });
	}

	assert.equal(calls.length, 1, 'TTL 内只发一次目录请求');
	assert.equal(calls[0].url, GO_URL);
	assert.equal(calls[0].init.method, 'GET');
	assert.equal(calls[0].init.headers.Authorization, 'Bearer stub-token');
	assert.equal(calls[0].init.headers.Accept, 'application/json');
	assert.equal(catalog.size, 4, 'size 是最近一次拉取的模型数');
});

test('目录：api 里混入不支持的键（interactions）时按支持的键解析，不误判歧义', async () => {
	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch(FIXTURE, calls) });

	const resolved = await catalog.resolve('gemini-4-argon');
	assert.equal(resolved.protocol, 'gemini', 'interactions 不参与解析，generate-content 是唯一支持的键');
	assert.equal(resolved.baseUrl, 'https://opencode.ai/inference/go/google/v1beta');
});

test('目录：未知模型 → 报错列出前 10 个候选 id，并提示 GET 目录自查', async () => {
	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch(FIXTURE, calls) });

	const error = await catalogError(() => catalog.resolve('no-such-model'));
	assert.equal(error.retryable, false, '模型不存在是配置问题，不可切换');
	assert.equal(error.modelId, 'no-such-model');
	assert.match(error.message, /模型目录里没有 "no-such-model"/);
	for (const id of ['deepseek-v4.1-flash', 'gpt-6-luna', 'claude-haiku-5-5', 'gemini-4-argon']) {
		assert.ok(error.message.includes(id), `候选里应有 ${id}`);
	}
	assert.ok(error.message.includes(`可以 GET ${GO_URL} 自查`));
});

test('目录：api 有两个可用协议 → 报歧义，列出两个键名并指向 providers.local.json', async () => {
	const payload = {
		object: 'list',
		data: [
			{
				id: 'ambiguous-pair',
				type: 'chat',
				api: {
					'chat-completions': { base_url: 'https://gw.test/openai/v1' },
					responses: { base_url: 'https://gw.test/openai/v1' }
				}
			}
		]
	};
	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch(payload, calls) });

	const error = await catalogError(() => catalog.resolve('ambiguous-pair'));
	assert.equal(error.retryable, false);
	assert.match(error.message, /多个可用协议 \[chat-completions, responses\]/);
	assert.match(error.message, /providers\.local\.json/);
	assert.match(error.message, /显式写 protocol 与 baseUrl/);
});

test('目录：api 只有 interactions → 报错并列出原始键名 interactions', async () => {
	const payload = {
		object: 'list',
		data: [{ id: 'interactions-only', type: 'chat', api: { interactions: { base_url: 'https://gw.test/google/v1beta' } } }]
	};
	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch(payload, calls) });

	const error = await catalogError(() => catalog.resolve('interactions-only'));
	assert.equal(error.retryable, false);
	assert.match(error.message, /没有可用的 API 协议/);
	assert.match(error.message, /interactions/, '必须提到原始键名，用户才知道少了什么');
	assert.match(error.message, /chat-completions, responses, messages, generate-content/);
});

test('目录：缺 base_url / type 不是 chat / api 不是对象 → 不可切换错误', async () => {
	const payload = {
		object: 'list',
		data: [
			{ id: 'no-base', type: 'chat', api: { messages: { sdk: {} } } },
			{ id: 'embedding-model', type: 'embedding', api: { 'chat-completions': { base_url: 'https://gw.test/v1' } } },
			{ id: 'no-api', type: 'chat' }
		]
	};
	const calls = [];
	const catalog = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch(payload, calls) });

	const noBase = await catalogError(() => catalog.resolve('no-base'));
	assert.equal(noBase.retryable, false);
	assert.match(noBase.message, /api\.messages 缺少 base_url/);

	const notChat = await catalogError(() => catalog.resolve('embedding-model'));
	assert.equal(notChat.retryable, false);
	assert.match(notChat.message, /type="embedding"/);
	assert.match(notChat.message, /只有 type="chat"/);

	const noApi = await catalogError(() => catalog.resolve('no-api'));
	assert.equal(noApi.retryable, false);
	assert.match(noApi.message, /api 字段缺失/);
});

test('目录：拉取失败（网络 / 5xx / 非 JSON）→ retryable，供路由切下一家', async () => {
	const network = createCatalog({
		url: GO_URL,
		apiKey: 'super-secret-token',
		fetchImpl: async () => {
			throw new TypeError('fetch failed');
		}
	});
	const networkError = await catalogError(() => network.resolve('claude-haiku-5-5'));
	assert.equal(networkError.retryable, true);
	assert.match(networkError.message, /拉取模型目录失败/);
	assert.equal(networkError.message.includes('super-secret-token'), false, '错误里绝不能出现 token');

	const http500 = createCatalog({
		url: GO_URL,
		apiKey: 'k',
		fetchImpl: async () => new Response('upstream boom', { status: 503 })
	});
	const httpError = await catalogError(() => http500.resolve('claude-haiku-5-5'));
	assert.equal(httpError.retryable, true);
	assert.equal(httpError.status, 503);

	const notJson = createCatalog({
		url: GO_URL,
		apiKey: 'k',
		fetchImpl: async () => new Response('<html>gateway</html>', { status: 200 })
	});
	const jsonError = await catalogError(() => notJson.resolve('claude-haiku-5-5'));
	assert.equal(jsonError.retryable, true);

	const noData = createCatalog({ url: GO_URL, apiKey: 'k', fetchImpl: stubFetch({ object: 'list' }, []) });
	const dataError = await catalogError(() => noData.resolve('claude-haiku-5-5'));
	assert.equal(dataError.retryable, false, '缺 data[] 是端点/结构问题，不是网络抖动');
	assert.match(dataError.message, /缺少 data\[\]/);
});

test('目录：TTL 内复用缓存，过期与 clear() 后重新拉取；并发只发一次请求', async () => {
	let clock = 1000;
	let calls = 0;
	const catalog = createCatalog({
		url: GO_URL,
		apiKey: 'k',
		ttlMs: 60_000,
		now: () => clock,
		fetchImpl: async (url, init) => {
			calls += 1;
			return stubFetch(FIXTURE, [])(url, init);
		}
	});

	await catalog.resolve('claude-haiku-5-5');
	await catalog.resolve('gpt-6-luna');
	assert.equal(calls, 1);

	clock += 60_001;
	await catalog.resolve('deepseek-v4.1-flash');
	assert.equal(calls, 2, 'TTL 过期后重新拉取');

	catalog.clear();
	assert.equal(catalog.size, 0);
	await catalog.resolve('gemini-4-argon');
	assert.equal(calls, 3, 'clear() 强制刷新');

	// 新实例上并发 resolve 共享同一个 in-flight 请求。
	let concurrentCalls = 0;
	const fresh = createCatalog({
		url: GO_URL,
		apiKey: 'k',
		fetchImpl: async (url, init) => {
			concurrentCalls += 1;
			return stubFetch(FIXTURE, [])(url, init);
		}
	});
	await Promise.all([fresh.resolve('claude-haiku-5-5'), fresh.resolve('gpt-6-luna'), fresh.resolve('deepseek-v4.1-flash')]);
	assert.equal(concurrentCalls, 1, '并发 resolve 不能打三次目录');
});
