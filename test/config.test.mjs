import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_PROVIDERS_FILE, loadConfig, parseProviderChain } from '../src/config.mjs';
import {
	AUTH_MODES,
	PROTOCOLS,
	loadProviderTable,
	mergeProviderTables,
	normalizeProvider,
	resolveProvider
} from '../src/providers.mjs';

const PRESETS = JSON.parse(readFileSync(DEFAULT_PROVIDERS_FILE, 'utf8'));

/**
 * @param {Record<string, any>} presets
 * @param {Record<string, any>} local
 * @param {(dir: string) => void} run
 */
function withTempProviderFiles(presets, local, run) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'baize-providers-'));
	try {
		writeFileSync(path.join(dir, 'providers.json'), JSON.stringify(presets), 'utf8');
		writeFileSync(path.join(dir, 'providers.local.json'), JSON.stringify(local), 'utf8');
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test('config/providers.json：protocol 合法、不写 model、keyEnv 为 null 或环境变量名', () => {
	assert.deepEqual(PROTOCOLS, ['openai', 'anthropic', 'gemini', 'responses']);
	assert.deepEqual(Object.keys(PRESETS).sort(), [
		'anthropic',
		'deepseek',
		'glm',
		'google',
		'kimi',
		'lmstudio',
		'minimax',
		'ollama',
		'openai',
		'openrouter'
	]);

	for (const [id, entry] of Object.entries(PRESETS)) {
		assert.ok(PROTOCOLS.includes(entry.protocol), `${id}.protocol=${entry.protocol}`);
		assert.equal(Object.prototype.hasOwnProperty.call(entry, 'model'), false, `${id} 不能写死 model`);
		assert.equal(typeof entry.baseUrl, 'string', `${id}.baseUrl`);
		assert.ok(entry.keyEnv === null || typeof entry.keyEnv === 'string', `${id}.keyEnv`);
		assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `${id}.label`);
	}

	const normalized = normalizeProvider('openai', PRESETS.openai, { source: 'preset' });
	assert.equal(normalized.id, 'openai');
	assert.equal(normalized.baseUrl, 'https://api.openai.com/v1');
});

test('providers.local.json：按 id 浅合并，用户值优先，可追加新供应商', () => {
	const merged = mergeProviderTables(
		{
			openai: { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' }
		},
		{
			openai: { baseUrl: 'http://127.0.0.1:9999/v1', model: 'local-model' },
			acme: { label: 'Acme', protocol: 'anthropic', baseUrl: 'https://acme.test/v1', keyEnv: 'ACME_KEY' }
		}
	);

	assert.equal(merged.openai.label, 'OpenAI', '未被覆盖的字段保留预设值');
	assert.equal(merged.openai.baseUrl, 'http://127.0.0.1:9999/v1');
	assert.equal(merged.openai.model, 'local-model');
	assert.equal(merged.acme.protocol, 'anthropic');
	assert.equal(merged.acme.keyEnv, 'ACME_KEY');
});

test('provider 校验：预设不能用非法 protocol / 不能写 model；本地允许 oauth 协议与 model', () => {
	assert.throws(
		() => normalizeProvider('x', { protocol: 'grpc', baseUrl: '', keyEnv: null }, { source: 'preset' }),
		/protocol/
	);
	assert.throws(
		() =>
			normalizeProvider(
				'x',
				{ protocol: 'openai', baseUrl: '', keyEnv: null, model: 'hard-coded' },
				{ source: 'preset' }
			),
		/不应写 model/
	);
	assert.throws(
		() => normalizeProvider('x', { protocol: 'openai', baseUrl: 123, keyEnv: null }, { source: 'preset' }),
		/baseUrl/
	);
	assert.throws(
		() => normalizeProvider('x', { protocol: 'openai', baseUrl: '', keyEnv: 42 }, { source: 'preset' }),
		/keyEnv/
	);

	// 旧别名 protocol=anthropic-oauth 仍可使用，但归一化成「规范协议 + 订阅 auth」
	const oauth = normalizeProvider(
		'claude-oauth',
		{ protocol: 'anthropic-oauth', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_OAUTH_TOKEN' },
		{ source: 'local' }
	);
	assert.equal(oauth.protocol, 'anthropic');
	assert.equal(oauth.auth, 'oauth');
});

test('loadProviderTable：预设 + providers.local.json 合并读取', () => {
	withTempProviderFiles(
		{
			base: { label: 'Base', protocol: 'openai', baseUrl: 'https://base.test/v1', keyEnv: 'BASE_KEY' }
		},
		{
			base: { baseUrl: 'http://127.0.0.1:11434/v1', keyEnv: null },
			extra: { label: 'Extra', protocol: 'gemini', baseUrl: 'https://extra.test/v1beta', keyEnv: null }
		},
		(dir) => {
			const table = loadProviderTable({ file: path.join(dir, 'providers.json') });
			assert.equal(table.providers.base.baseUrl, 'http://127.0.0.1:11434/v1');
			assert.equal(table.providers.base.keyEnv, null);
			assert.equal(table.providers.extra.protocol, 'gemini');
			assert.equal(table.local.extra.label, 'Extra');
		}
	);
});

test('ANSWERER_CHAIN：逗号分隔、去空白、按顺序去重；优先于 ANSWERER_PROVIDER', () => {
	assert.deepEqual(parseProviderChain({ ANSWERER_CHAIN: ' openai, deepseek ,openai ' }), ['openai', 'deepseek']);
	assert.deepEqual(parseProviderChain({ ANSWERER_PROVIDER: 'deepseek' }), ['deepseek']);
	assert.deepEqual(parseProviderChain({}), ['openai']);
	assert.throws(() => parseProviderChain({ ANSWERER_CHAIN: ' , ' }), /不能为空/);

	// 旧配置大小写写法仍兼容。
	const upper = loadConfig({ ANSWERER_PROVIDER: 'OPENAI', ANSWERER_MODEL: 'm', OPENAI_API_KEY: 'k' });
	assert.deepEqual(upper.chain, ['openai']);
});

test('loadConfig：多 provider 链逐家指定 model、每家 keyEnv 各自解析', () => {
	withTempProviderFiles(
		{
			openai: {
				label: 'OpenAI',
				protocol: 'openai',
				baseUrl: 'https://api.openai.com/v1',
				keyEnv: 'OPENAI_API_KEY'
			},
			deepseek: {
				label: 'DeepSeek',
				protocol: 'openai',
				baseUrl: 'https://api.deepseek.com/v1',
				keyEnv: 'DEEPSEEK_API_KEY'
			}
		},
		{
			openai: { model: 'gpt-test' },
			deepseek: { model: 'deepseek-test' }
		},
		(dir) => {
			const config = loadConfig({
				ANSWERER_CHAIN: 'openai,deepseek',
				ANSWERER_PROVIDERS_FILE: path.join(dir, 'providers.json'),
				OPENAI_API_KEY: 'openai-key',
				DEEPSEEK_API_KEY: 'deepseek-key'
			});

			assert.deepEqual(config.chain, ['openai', 'deepseek']);
			assert.equal(config.provider, 'openai');
			assert.equal(config.model, 'gpt-test');
			assert.equal(config.providers[0].baseUrl, 'https://api.openai.com/v1');
			assert.equal(config.providers[0].model, 'gpt-test');
			assert.equal(config.providers[0].apiKey, 'openai-key');
			assert.equal(config.providers[1].baseUrl, 'https://api.deepseek.com/v1');
			assert.equal(config.providers[1].model, 'deepseek-test');
			assert.equal(config.providers[1].apiKey, 'deepseek-key');
			assert.equal(config.providers[1].protocol, 'openai');
		}
	);
});

test('loadConfig：ANSWERER_CHAIN=mock 不需要 key/model；旧 ANSWERER_PROVIDER=mock 仍可用', () => {
	const chained = loadConfig({ ANSWERER_CHAIN: 'mock' });
	assert.deepEqual(chained.chain, ['mock']);
	assert.equal(chained.provider, 'mock');
	assert.equal(chained.model, 'mock');

	const legacy = loadConfig({ ANSWERER_PROVIDER: 'mock' });
	assert.deepEqual(legacy.chain, ['mock']);
});

test('loadConfig：旧 ANSWERER_BASE_URL / ANSWERER_API_KEY 覆盖链上第一家', () => {
	withTempProviderFiles(
		{
			openai: {
				label: 'OpenAI',
				protocol: 'openai',
				baseUrl: 'https://api.openai.com/v1',
				keyEnv: 'OPENAI_API_KEY'
			}
		},
		{ openai: { model: 'gpt-test' } },
		(dir) => {
			const config = loadConfig({
				ANSWERER_CHAIN: 'openai,mock',
				ANSWERER_PROVIDERS_FILE: path.join(dir, 'providers.json'),
				ANSWERER_BASE_URL: 'http://127.0.0.1:9/v1',
				ANSWERER_API_KEY: 'legacy-key'
			});
			assert.equal(config.providers[0].baseUrl, 'http://127.0.0.1:9/v1');
			assert.equal(config.providers[0].apiKey, 'legacy-key');
			assert.equal(config.providers[0].model, 'gpt-test');
			assert.equal(config.providers[1].id, 'mock');
		}
	);
});

test('loadConfig：混合链缺 model → 拒绝启动，并给出可照抄的修复示例', () => {
	withTempProviderFiles(
		{
			deepseek: {
				label: 'DeepSeek',
				protocol: 'openai',
				baseUrl: 'https://api.deepseek.com/v1',
				keyEnv: 'DEEPSEEK_API_KEY'
			},
			openai: {
				label: 'OpenAI',
				protocol: 'openai',
				baseUrl: 'https://api.openai.com/v1',
				keyEnv: 'OPENAI_API_KEY'
			}
		},
		{},
		(dir) => {
			assert.throws(
				() =>
					loadConfig({
						ANSWERER_CHAIN: 'deepseek,openai',
						ANSWERER_PROVIDERS_FILE: path.join(dir, 'providers.json'),
						ANSWERER_MODEL: 'global-model',
						DEEPSEEK_API_KEY: 'deepseek-key',
						OPENAI_API_KEY: 'openai-key'
					}),
				(error) => {
					assert.match(error.message, /ANSWERER_CHAIN=deepseek,openai 包含多个 provider/);
					assert.match(error.message, /provider "deepseek" 缺少 model；混合链必须逐家指定/);
					assert.match(error.message, /provider "openai" 缺少 model；混合链必须逐家指定/);
					assert.match(
						error.message,
						/\{ "deepseek": \{ "model": "<该供应商的模型 id>" \} \}/,
						'错误信息要能直接照抄'
					);
					return true;
				}
			);
		}
	);
});

test('loadConfig：单 provider 链允许只用全局 ANSWERER_MODEL', () => {
	const config = loadConfig({
		ANSWERER_CHAIN: 'openai',
		ANSWERER_MODEL: 'global-model',
		OPENAI_API_KEY: 'openai-key'
	});

	assert.deepEqual(config.chain, ['openai']);
	assert.equal(config.providers.length, 1);
	assert.equal(config.providers[0].model, 'global-model');
});

test('resolveProvider：OAuth 只从指定环境变量取 token，且不在预设表里', () => {
	const table = mergeProviderTables(
		{},
		{
			'claude-oauth': {
				protocol: 'anthropic-oauth',
				baseUrl: 'https://api.anthropic.com/v1',
				keyEnv: 'ANTHROPIC_OAUTH_TOKEN',
				model: 'm'
			},
			'codex-oauth': {
				protocol: 'openai-oauth',
				baseUrl: 'https://api.openai.com/v1',
				keyEnv: 'OPENAI_OAUTH_TOKEN',
				model: 'm'
			}
		}
	);
	assert.equal(Object.prototype.hasOwnProperty.call(PRESETS, 'claude-oauth'), false, 'OAuth 不能出现在预设表');

	const claude = resolveProvider('claude-oauth', table, { ANTHROPIC_OAUTH_TOKEN: 'oauth-token' });
	assert.equal(claude.auth, 'oauth');
	assert.equal(claude.apiKey, 'oauth-token');

	const codex = resolveProvider('codex-oauth', table, { OPENAI_OAUTH_TOKEN: 'oauth-token-2' });
	assert.equal(codex.protocol, 'responses');
	assert.equal(codex.auth, 'codex-oauth');
	assert.equal(codex.apiKey, 'oauth-token-2');
});

test('loadConfig：未知 provider / 缺 key / baseUrl 为空 → 启动即报错', () => {
	assert.throws(() => loadConfig({ ANSWERER_CHAIN: 'nonexistent', ANSWERER_MODEL: 'm' }), /未知 provider/);
	assert.throws(
		() => loadConfig({ ANSWERER_CHAIN: 'openai', ANSWERER_MODEL: 'm' }),
		/缺少环境变量 OPENAI_API_KEY/
	);
	// 预设里没有空 baseUrl 的条目，用临时预设构造这个场景
	withTempProviderFiles(
		{ empty: { label: 'Empty', protocol: 'openai', baseUrl: '', keyEnv: null } },
		{},
		(dir) => {
			assert.throws(
				() =>
					loadConfig({
						ANSWERER_CHAIN: 'empty',
						ANSWERER_PROVIDERS_FILE: path.join(dir, 'providers.json'),
						ANSWERER_MODEL: 'm'
					}),
				/baseUrl 为空/
			);
		}
	);
});

test('loadConfig：ANSWERER_PROVIDERS_FILE 指向自定义预设 + local 覆盖', () => {
	withTempProviderFiles(
		{
			base: { label: 'Base', protocol: 'openai', baseUrl: 'https://base.test/v1', keyEnv: 'BASE_KEY' }
		},
		{
			base: { baseUrl: 'https://override.test/v1', model: 'override-model' }
		},
		(dir) => {
			const config = loadConfig({
				ANSWERER_CHAIN: 'base',
				ANSWERER_PROVIDERS_FILE: path.join(dir, 'providers.json'),
				BASE_KEY: 'k'
			});
			assert.equal(config.providers[0].baseUrl, 'https://override.test/v1');
			assert.equal(config.providers[0].model, 'override-model', 'provider 自己的 model 优先于 ANSWERER_MODEL');
			assert.equal(config.providers[0].apiKey, 'k');
		}
	);
});
