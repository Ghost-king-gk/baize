import test from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError, MockProvider } from '../src/provider.mjs';
import { buildPrompt } from '../src/prompt.mjs';
import { createRouter } from '../src/router.mjs';
import { createService } from '../src/service.mjs';

const OPTIONS = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];

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

test('路由：第一家 401 致命 → 立即抛错，不调用第二家；反复 401 也不会熔断成切换', async () => {
	const { router, calls } = buildRouter(['first', 'second'], {
		'first.test': () => new Response('bad key', { status: 401 }),
		'second.test': () => chatResponse('1')
	});

	for (let i = 0; i < 4; i++) {
		await assert.rejects(
			() => router.ask(singlePrompt(), { type: 'single', optionCount: 4 }),
			(error) => {
				assert.ok(error instanceof ProviderError);
				assert.equal(error.reason, 'provider_error');
				assert.equal(error.status, 401);
				return true;
			}
		);
	}
	assert.equal(calls.filter((call) => call.url.includes('first.test')).length, 4);
	assert.equal(calls.filter((call) => call.url.includes('second.test')).length, 0, '致命错误不能继续烧别家额度');
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
