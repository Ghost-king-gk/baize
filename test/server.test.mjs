import test from 'node:test';
import assert from 'node:assert/strict';

import { MockProvider } from '../src/provider.mjs';
import { createServer } from '../src/server.mjs';
import { createService } from '../src/service.mjs';

const OPTIONS = 'A. 1\nB. 2\nC. 3\nD. 4';

/**
 * @param {import('node:http').Server} server
 * @param {(base: string) => Promise<void>} run
 */
async function withServer(server, run) {
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = /** @type {import('node:net').AddressInfo} */ (server.address());
	const base = `http://127.0.0.1:${address.port}`;
	try {
		await run(base);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
}

function buildServer({ k = 1, maxBodyBytes } = {}) {
	const provider = new MockProvider({ letters: [3], answers: ['甲', '乙'] });
	const answer = createService({ provider, k, marginThreshold: 0 });
	return createServer({ answer, provider: provider.name, model: provider.model, maxBodyBytes });
}

test('POST /answer：mock provider 返回 {"ok":true,"answer":"C. 3"}，并带 CORS 头', async () => {
	const server = buildServer();
	await withServer(server, async (base) => {
		const response = await fetch(`${base}/answer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: '1+2=?', type: 'single', options: OPTIONS })
		});

		assert.equal(response.status, 200);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		assert.match(response.headers.get('content-type') ?? '', /application\/json/);

		const body = await response.json();
		assert.deepEqual(body, { ok: true, answer: 'C. 3' });
	});
});

test('OPTIONS /answer：CORS 预检（OCS 用 type:fetch，浏览器必发预检）', async () => {
	const server = buildServer();
	await withServer(server, async (base) => {
		const response = await fetch(`${base}/answer`, {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://mooc1.chaoxing.com',
				'Access-Control-Request-Method': 'POST',
				'Access-Control-Request-Headers': 'content-type'
			}
		});

		assert.equal(response.status, 204);
		assert.equal(response.headers.get('access-control-allow-origin'), '*');
		assert.match(response.headers.get('access-control-allow-headers') ?? '', /Content-Type/i);
		assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
	});
});

test('POST /answer：坏 JSON / 缺题干 → 400 invalid_request', async () => {
	const server = buildServer();
	await withServer(server, async (base) => {
		const badJson = await fetch(`${base}/answer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{not json'
		});
		assert.equal(badJson.status, 400);
		assert.deepEqual(await badJson.json(), { ok: false, reason: 'invalid_request' });

		const noTitle = await fetch(`${base}/answer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ type: 'single', options: OPTIONS })
		});
		assert.equal(noTitle.status, 400);
		assert.deepEqual(await noTitle.json(), { ok: false, reason: 'invalid_request' });
	});
});

test('ok:false 的业务弃权仍返回 200（OCS 只看 JSON 的 ok 字段）', async () => {
	const server = buildServer();
	await withServer(server, async (base) => {
		const response = await fetch(`${base}/answer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				title: '看图',
				type: 'single',
				options: OPTIONS,
				images: ['data:image/png;base64,AAAA']
			})
		});
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: false, reason: 'unsupported_images' });
	});
});

test('GET /health、GET /、404、405', async () => {
	const server = buildServer();
	await withServer(server, async (base) => {
		const health = await fetch(`${base}/health`);
		assert.equal(health.status, 200);
		const healthBody = await health.json();
		assert.equal(healthBody.ok, true);
		assert.equal(healthBody.provider, 'mock');
		assert.equal(healthBody.compat, 'ocsjs 5.4.2 @ 09628b7');

		const root = await fetch(`${base}/`);
		assert.equal(root.status, 200);
		assert.match(await root.text(), /POST \/answer/);

		const missing = await fetch(`${base}/nope`);
		assert.equal(missing.status, 404);

		const wrongMethod = await fetch(`${base}/answer`);
		assert.equal(wrongMethod.status, 405);
	});
});

test('请求体超过上限 → 413', async () => {
	const server = buildServer({ maxBodyBytes: 64 });
	await withServer(server, async (base) => {
		const response = await fetch(`${base}/answer`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'x'.repeat(200), type: 'single', options: OPTIONS })
		});
		assert.equal(response.status, 413);
		assert.deepEqual(await response.json(), { ok: false, reason: 'body_too_large' });
	});
});
