import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { maskValue, renderHome, renderSettings } from '../src/web/admin.mjs';
import { createServer } from '../src/server.mjs';

test('maskValue：敏感变量只露前 4 位与长度', () => {
	const secret = 'oc_sk_abcdefghijklmnop';
	const masked = maskValue('OPENCODE_GO_API_KEY', secret);
	assert.ok(masked.startsWith('oc_s'));
	assert.ok(masked.includes(`${secret.length} 字符`));
	assert.ok(!masked.includes('abcdefghij'));

	assert.equal(maskValue('ANSWERER_MODEL', 'glm-5.3-flash'), 'glm-5.3-flash');
	assert.equal(maskValue('OPENCODE_GO_API_KEY', ''), '');
});

test('renderHome：链路、模型、端口、回环与非回环提示', () => {
	const base = {
		compat: 'ocsjs 5.4.2 @ 09628b7',
		chain: ['opencode-go', 'deepseek'],
		model: 'glm-5.3-flash',
		port: 8787,
		k: 3,
		startedAt: Date.now(),
		records: [{ ts: '2026-11-21T10:00:00.000Z', model: 'glm-5.3-flash', outcome: 'ok', ms: 900, allowance: 0.002 }],
		logFile: '/tmp/x.jsonl',
		hasQuota: true
	};
	const local = renderHome({ ...base, host: '127.0.0.1' });
	assert.ok(local.includes('opencode-go → deepseek'));
	assert.ok(local.includes('glm-5.3-flash'));
	assert.ok(local.includes('127.0.0.1:8787'));
	assert.ok(!local.includes('不是回环地址'), '回环地址不提示');
	assert.ok(local.includes('pill ok'), '成功记录用 ok 样式');

	const exposed = renderHome({ ...base, host: '0.0.0.0' });
	assert.ok(exposed.includes('不是回环地址'), '非回环要显式警告');
});

test('renderSettings：敏感值打码，契约 JSON 可复制', () => {
	const html = renderSettings({
		envRows: [
			{ key: 'OPENCODE_GO_API_KEY', value: 'oc_sk_0123456789abcdef' },
			{ key: 'ANSWERER_MODEL', value: 'glm-5.3-flash' }
		],
		contractText: '{"name":"白泽"}',
		host: '127.0.0.1',
		port: 8787,
		providersFile: 'config/providers.json',
		quotaFile: 'config/go-quota.json'
	});
	assert.ok(html.includes('oc_s'), '保留前四位便于确认');
	assert.ok(!html.includes('0123456789abcdef'), '不得泄露完整 key');
	assert.ok(html.includes('glm-5.3-flash'));
	assert.ok(html.includes('{&quot;name&quot;:&quot;白泽&quot;}'), '契约文本需转义');
	assert.ok(html.includes('navigator.clipboard'));
});

test('服务端：管理页与 /api/status 可用，日志缺失不报错', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'baize-admin-'));
	const logFile = path.join(dir, 'answers.jsonl');
	writeFileSync(logFile, `${JSON.stringify({ ts: '2026-11-21T10:00:00.000Z', model: 'm', outcome: 'ok', ms: 5 })}\n`);

	const server = createServer({
		answer: async () => ({ ok: true, answer: 'C' }),
		provider: 'mock',
		chain: ['mock'],
		model: 'mock',
		port: 0,
		k: 1,
		logFile,
		env: { ANSWERER_MODEL: 'mock' }
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = /** @type {any} */ (server.address());
	try {
		const home = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(home.status, 200);
		assert.match(home.headers.get('content-type') ?? '', /text\/html/);
		assert.ok((await home.text()).includes('服务状态'));

		const status = await fetch(`http://127.0.0.1:${port}/api/status`);
		const body = await status.json();
		assert.equal(body.ok, true);
		assert.equal(body.records, 1);
		assert.equal(body.lastOutcome, 'ok');

		const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard`);
		assert.equal(dashboard.status, 200);
		assert.ok((await dashboard.text()).includes('<svg'));
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});

test('服务端：日志文件不存在时管理页仍返回 200', async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'baize-admin-empty-'));
	const server = createServer({
		answer: async () => ({ ok: false, reason: 'invalid_request' }),
		provider: 'mock',
		chain: ['mock'],
		logFile: path.join(dir, 'missing.jsonl'),
		env: {}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = /** @type {any} */ (server.address());
	try {
		const response = await fetch(`http://127.0.0.1:${port}/`);
		assert.equal(response.status, 200);
		const status = await (await fetch(`http://127.0.0.1:${port}/api/status`)).json();
		assert.equal(status.records, 0);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		rmSync(dir, { recursive: true, force: true });
	}
});
