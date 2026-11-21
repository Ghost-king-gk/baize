import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ProviderError, MockProvider } from '../src/provider.mjs';
import { buildPrompt } from '../src/prompt.mjs';
import { createRouter } from '../src/router.mjs';
import { createService } from '../src/service.mjs';
import { mergeProviderTables, resolveProvider } from '../src/providers.mjs';

const OPTIONS = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];
const CATALOG_URL = 'https://opencode.ai/inference/go/v1/models';
const CATALOG = JSON.parse(
	readFileSync(fileURLToPath(new URL('./fixtures/opencode-go-models.json', import.meta.url)), 'utf8')
);

function singlePrompt(order = [0, 1, 2, 3]) {
	return buildPrompt({ type: 'single', title: '1+2 = ?', options: OPTIONS, order });
}

/** @param {string} id */
function provider(id) {
	return {
		id,
		label: id,
		protocol: 'openai',
		baseUrl: `http://${id}.test/v1`,
		keyEnv: 'TEST_KEY',
		model: 'test-model',
		apiKey: 'test-key',
		auth: 'api-key'
	};
}

function chatResponse(content, finishReason = 'stop') {
	return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * @param {Record<string, (url: string) => Response | Promise<Response>>} handlers
 * @param {Array<{url: string, init: any}>} [calls]
 */
function routedFetch(handlers, calls = []) {
	return async (url, init) => {
		calls.push({ url, init });
		const host = new URL(url).hostname;
		const handler = handlers[host];
		if (!handler) throw new Error(`unexpected host: ${host}`);
		return handler(url);
	};
}

/** @param {string[]} chain @param {Record<string, any>} handlers @param {any} [options] */
function buildRouter(chain, handlers, options = {}) {
	const calls = [];
	const logs = [];
	const providers = chain.map((id) =>
		id === 'mock'
			? { id: 'mock', label: 'Mock', protocol: 'mock', baseUrl: '', keyEnv: null, model: 'mock', apiKey: '' }
			: provider(id)
	);
	const router = createRouter({
		providers,
		chain,
		fetchImpl: routedFetch(handlers, calls),
		log: (event) => logs.push(event),
		...options
	});
	return { router, calls, logs };
}

test('路由：第一家成功即返回，不调用第二家；used provider 写进结果', async () => {
	const { router, calls } = buildRouter(['first', 'second'], {
		'first.test': () => chatResponse('1'),
		'second.test': () => chatResponse('1')
	});

	const result = await router.ask(singlePrompt([2, 0, 1, 3]), { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [3], '展示位 1 对应原始下标 3');
	assert.equal(result.provider, 'first');
	assert.equal(calls.length, 1);
	assert.match(calls[0].url, /^http:\/\/first\.test\/v1\/chat\/completions$/);
});

test('路由：第一家 429 → 换第二家，日志记录 provider + 状态码 + 下一家', async () => {
	const { router, calls, logs } = buildRouter(['first', 'second'], {
		'first.test': () => new Response('rate limited', { status: 429 }),
		'second.test': () => chatResponse('2')
	});

	const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [2]);
	assert.equal(result.provider, 'second');
	assert.equal(calls.length, 2);

	const fallback = logs.find((event) => event.event === 'provider_fallback');
	assert.deepEqual(
		{ provider: fallback.provider, status: fallback.status, next: fallback.next },
		{ provider: 'first', status: 429, next: 'second' }
	);
});

test('路由：401/403/404 鉴权失败 → 切下一家，日志 provider_auth_failed（不与 fallback 混淆）', async () => {
	for (const status of [401, 403, 404]) {
		const { router, calls, logs } = buildRouter(['first', 'second'], {
			'first.test': () => new Response('rejected', { status }),
			'second.test': () => chatResponse('1')
		});

		const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
		assert.equal(result.provider, 'second', `${status} 应该切换下一家`);
		assert.equal(calls.length, 2, `${status} 后第二家必须被调用`);

		const authLog = logs.find((event) => event.event === 'provider_auth_failed');
		assert.ok(authLog, `缺少 provider_auth_failed 事件（status=${status}）`);
		assert.deepEqual(
			{ provider: authLog.provider, status: authLog.status, next: authLog.next },
			{ provider: 'first', status, next: 'second' }
		);
		assert.equal(
			logs.some((event) => event.event === 'provider_fallback'),
			false,
			'鉴权失败要独立事件，不混进普通 fallback'
		);
		assert.equal(logs.some((event) => event.event === 'provider_fatal'), false);
	}
});

test('路由：401 计入熔断，连续 3 次后跳过死 key；冷却后恢复', async () => {
	let clock = 1000;
	const { router, calls, logs } = buildRouter(
		['expired', 'healthy'],
		{
			'expired.test': () => new Response('bad key', { status: 401 }),
			'healthy.test': () => chatResponse('1')
		},
		{ now: () => clock }
	);

	for (let i = 0; i < 3; i++) {
		const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
		assert.equal(result.provider, 'healthy');
	}
	assert.equal(calls.filter((call) => call.url.includes('expired.test')).length, 3);
	assert.ok(logs.some((event) => event.event === 'circuit_open' && event.provider === 'expired'));

	// 第 4 次：401 已经把 expired 熔断，直接走 healthy。
	const fourth = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(fourth.provider, 'healthy');
	assert.equal(
		calls.filter((call) => call.url.includes('expired.test')).length,
		3,
		'熔断期内不得再拿死 key 去撞 401'
	);
	assert.ok(logs.some((event) => event.event === 'circuit_skip' && event.provider === 'expired'));

	// 冷却 60 秒后放行：expired 会被再试一次。
	clock += 60_001;
	const afterCooldown = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(afterCooldown.provider, 'healthy');
	assert.equal(calls.filter((call) => call.url.includes('expired.test')).length, 4);
});

test('路由：400 → 立即抛错，不切下一家，日志 provider_fatal', async () => {
	const { router, calls, logs } = buildRouter(['first', 'second'], {
		'first.test': () => new Response('bad request', { status: 400 }),
		'second.test': () => chatResponse('1')
	});

	await assert.rejects(
		() => router.ask(singlePrompt(), { type: 'single', optionCount: 4 }),
		(error) => {
			assert.ok(error instanceof ProviderError);
			assert.equal(error.reason, 'provider_error');
			assert.equal(error.status, 400);
			assert.equal(error.retryable, false);
			return true;
		}
	);
	assert.equal(calls.length, 1, '400 是请求体问题，换下一家也一样');
	assert.ok(
		logs.some((event) => event.event === 'provider_fatal' && event.provider === 'first' && event.status === 400)
	);
	assert.equal(logs.some((event) => event.event === 'provider_auth_failed'), false);
});

test('路由：致命错误经 service 也不重试（retryable=false）', async () => {
	const { router, calls } = buildRouter(['first', 'second'], {
		'first.test': () => new Response('bad request', { status: 400 }),
		'second.test': () => chatResponse('1')
	});
	const service = createService({ provider: router, k: 1 });
	const result = await service({ title: 't', type: 'single', options: 'A. 1\nB. 2\nC. 3\nD. 4' });

	assert.deepEqual(result, { ok: false, reason: 'provider_error' });
	assert.equal(calls.length, 1, '400 只打一次，不重试也不切链');
});

test('路由：同一 provider 连续失败 3 次后熔断，第 4 次直接跳过；冷却后恢复', async () => {
	let clock = 1000;
	const { router, calls, logs } = buildRouter(
		['flaky', 'healthy'],
		{
			'flaky.test': () => new Response('boom', { status: 500 }),
			'healthy.test': () => chatResponse('1')
		},
		{ now: () => clock }
	);

	for (let i = 0; i < 3; i++) {
		const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
		assert.equal(result.provider, 'healthy');
	}
	const flakyCallsAfterThree = calls.filter((call) => call.url.includes('flaky.test')).length;
	assert.equal(flakyCallsAfterThree, 3);

	// 第 4 次：flaky 已熔断，直接走 healthy。
	const fourth = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(fourth.provider, 'healthy');
	assert.equal(calls.filter((call) => call.url.includes('flaky.test')).length, 3, '熔断期内不得再请求 flaky');
	assert.equal(calls.filter((call) => call.url.includes('healthy.test')).length, 4);
	assert.ok(logs.some((event) => event.event === 'circuit_skip' && event.provider === 'flaky'));

	// 冷却 60 秒后放行：flaky 会被再试一次。
	clock += 60_001;
	const afterCooldown = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(afterCooldown.provider, 'healthy');
	assert.equal(calls.filter((call) => call.url.includes('flaky.test')).length, 4);
});

test('路由：全链失败 → ProviderError(reason=provider_error)', async () => {
	const { router, calls } = buildRouter(['first', 'second'], {
		'first.test': () => new Response('boom', { status: 503 }),
		'second.test': () => new Response('down', { status: 502 })
	});

	await assert.rejects(
		() => router.ask(singlePrompt(), { type: 'single', optionCount: 4 }),
		(error) => {
			assert.ok(error instanceof ProviderError);
			assert.equal(error.reason, 'provider_error');
			assert.match(error.message, /all_providers_failed/);
			assert.match(error.message, /first: 503/, '全链失败信息要带每家的状态码');
			assert.match(error.message, /second: 502/);
			return true;
		}
	);
	assert.equal(calls.length, 2);
});

test('路由：mock 作为最后一环兜底，service 埋点记录实际使用的 provider', async () => {
	const { router } = buildRouter(
		['dead', 'mock'],
		{
			'dead.test': () => {
				throw new Error('ECONNREFUSED');
			}
		},
		{ mockProvider: new MockProvider({ letters: [3] }) }
	);

	const records = [];
	const service = createService({ provider: router, k: 1, logger: (record) => records.push(record) });
	const result = await service({ title: '1+2=?', type: 'single', options: 'A. 1\nB. 2\nC. 3\nD. 4' });

	assert.deepEqual(result, { ok: true, answer: 'C. 3' });
	assert.equal(records[0].provider, 'mock', '日志 provider 是实际应答的那家');
});

test('路由：内容层错误（截断/空输出）不触发故障转移，交给 service 重试', async () => {
	const { router, calls } = buildRouter(['first', 'second'], {
		'first.test': () => chatResponse('1', 'length'),
		'second.test': () => chatResponse('1')
	});

	await assert.rejects(
		() => router.ask(singlePrompt(), { type: 'single', optionCount: 4 }),
		(error) => error.name === 'InvalidOutputError'
	);
	assert.equal(calls.length, 1, '已经拿到应答就不切下一家');
});

/** @param {any} payload */
function jsonResponse(payload) {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

/**
 * 用真实的预设条目 + resolveProvider 构造目录型 provider，避免测试里手写假的目录字段。
 * @param {{model?: string}} [options]
 */
function catalogProvider(options = {}) {
	const table = mergeProviderTables({
		'opencode-go': {
			label: 'OpenCode Go（订阅）',
			catalog: { url: CATALOG_URL },
			keyEnv: 'OPENCODE_GO_API_KEY'
		}
	});
	return resolveProvider('opencode-go', table, {
		OPENCODE_GO_API_KEY: 'stub-token',
		ANSWERER_MODEL: options.model ?? 'claude-haiku-5-5'
	});
}

test('路由：目录 provider 在 ask 时解析协议与 baseUrl，最终 URL 用目录地址', async () => {
	const calls = [];
	const logs = [];
	const messagesUrl = 'https://opencode.ai/inference/go/anthropic/v1/messages';

	const fetchImpl = async (url, init) => {
		calls.push({ url, init });
		if (url === CATALOG_URL) return jsonResponse(CATALOG);
		if (url === messagesUrl) return jsonResponse({ content: [{ type: 'text', text: '1' }], stop_reason: 'end_turn' });
		throw new Error(`unexpected url: ${url}`);
	};

	const router = createRouter({
		providers: [catalogProvider()],
		chain: ['opencode-go'],
		fetchImpl,
		log: (event) => logs.push(event)
	});

	const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.deepEqual(result.letters, [1]);
	assert.equal(result.provider, 'opencode-go');
	assert.equal(result.model, 'claude-haiku-5-5');

	assert.equal(calls.length, 2, '先拉目录、再发 completion');
	assert.equal(calls[0].url, CATALOG_URL);
	assert.equal(calls[1].url, messagesUrl, '最终 URL 必须用目录给的 baseUrl + /messages');

	/** @type {Record<string, string>} */
	const headers = calls[1].init.headers;
	assert.equal(headers.Authorization, 'Bearer stub-token');
	assert.equal('x-api-key' in headers, false, '目录形态默认 bearer，不能混用 x-api-key');
	assert.equal('anthropic-beta' in headers, false);
	assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'Content-Type', 'User-Agent', 'anthropic-version']);
	assert.equal(headers['User-Agent'], 'baize/0.1.0', '客户端自报身份（OpenCode Go 要求）');

	const event = logs.find((item) => item.event === 'catalog_resolved');
	assert.deepEqual(
		{ provider: event.provider, protocol: event.protocol },
		{ provider: 'opencode-go', protocol: 'anthropic' }
	);
	assert.equal(JSON.stringify(logs).includes('stub-token'), false, '日志里不能出现 token');

	// 第二次 ask 复用同一个 catalog 实例：目录只拉一次。
	await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(calls.filter((call) => call.url === CATALOG_URL).length, 1, 'catalog 实例按 url 复用');
});

test('路由：目录拉取失败 → 可切换错误，继续下一家', async () => {
	const calls = [];
	const logs = [];
	const fetchImpl = async (url) => {
		calls.push(url);
		if (url === CATALOG_URL) return new Response('catalog down', { status: 503 });
		if (new URL(url).hostname === 'second.test') return chatResponse('1');
		throw new Error(`unexpected url: ${url}`);
	};

	const router = createRouter({
		providers: [catalogProvider(), provider('second')],
		chain: ['opencode-go', 'second'],
		fetchImpl,
		log: (event) => logs.push(event)
	});

	const result = await router.ask(singlePrompt(), { type: 'single', optionCount: 4 });
	assert.equal(result.provider, 'second');
	assert.equal(calls.length, 2);

	const fallback = logs.find((event) => event.event === 'provider_fallback' && event.provider === 'opencode-go');
	assert.ok(fallback, '目录拉取失败应记 fallback');
	assert.deepEqual({ status: fallback.status, next: fallback.next }, { status: 503, next: 'second' });
});

test('路由：目录里模型结构不对 → 不可切换，立即抛错；下一家不烧额度', async () => {
	const calls = [];
	const logs = [];
	const broken = {
		object: 'list',
		data: [{ id: 'claude-haiku-5-5', type: 'chat', api: { interactions: { base_url: 'https://gw.test/google/v1beta' } } }]
	};

	const fetchImpl = async (url) => {
		calls.push(url);
		if (url === CATALOG_URL) return jsonResponse(broken);
		if (new URL(url).hostname === 'second.test') return chatResponse('1');
		throw new Error(`unexpected url: ${url}`);
	};

	const router = createRouter({
		providers: [catalogProvider(), provider('second')],
		chain: ['opencode-go', 'second'],
		fetchImpl,
		log: (event) => logs.push(event)
	});

	await assert.rejects(
		() => router.ask(singlePrompt(), { type: 'single', optionCount: 4 }),
		(error) => {
			assert.ok(error instanceof ProviderError);
			assert.equal(error.retryable, false);
			assert.match(error.message, /interactions/, '报错要带实际键名');
			return true;
		}
	);
	assert.equal(calls.filter((url) => url.includes('second.test')).length, 0, '配置问题不能切下一家');
	assert.ok(logs.some((event) => event.event === 'provider_fatal' && event.provider === 'opencode-go'));
});
