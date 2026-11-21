// @ts-check
/**
 * HTTP 入口。只绑 127.0.0.1。
 *
 * 注意 CORS：OCS 的题库配置是 "type": "fetch"（answer.wrapper.handler.ts:27,75-97），
 * 走页面里的原生 fetch，属于跨域请求，浏览器会先发 OPTIONS 预检。
 * 因此必须返回 Access-Control-Allow-*，否则真实网课页面里一个请求都发不出去。
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST, ROOT, loadConfig, loadDotenv } from './config.mjs';
import { renderHome, renderSettings } from './web/admin.mjs';
import { loadRecords } from './web/aggregate.mjs';
import { generateDashboard } from './web/dashboard.mjs';
import { createJsonlLogger } from './log.mjs';
import { MockProvider } from './provider.mjs';
import { createRouter } from './router.mjs';
import { createService } from './service.mjs';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
export const COMPAT = 'ocsjs 5.4.2 @ 09628b7';

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store'
	});
	res.end(body);
}

/**
 * @param {http.ServerResponse} res
 */
function applyCors(res) {
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
	res.setHeader('Access-Control-Max-Age', '600');
}

/**
 * @param {http.IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<string>}
 */
function readBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let tooLarge = false;

		req.on('data', (chunk) => {
			if (tooLarge) return;
			size += chunk.length;
			if (size > limit) {
				tooLarge = true;
				chunks.length = 0;
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (tooLarge) {
				const error = new Error('body_too_large');
				// @ts-ignore
				error.code = 'body_too_large';
				reject(error);
				return;
			}
			resolve(Buffer.concat(chunks).toString('utf8'));
		});
		req.on('error', reject);
	});
}

/**
 * @param {{
 *   answer: (payload: any) => Promise<{ok: true, answer: string} | {ok: false, reason: string}>,
 *   provider?: string,
 *   chain?: string[],
 *   model?: string,
 *   maxBodyBytes?: number
 * }} options
 */

/**
 * 读取日志尾部；文件不存在或损坏时返回空数组（管理页不该因为日志缺失而 500）。
 * @param {string} file
 * @param {number} [limit]
 */
function readLogRecords(file, limit = 5000) {
	if (!file) return [];
	try {
		const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
		return loadRecords(lines.slice(-limit).join('\n'));
	} catch {
		return [];
	}
}

/** @param {string} file */
function readJsonFile(file) {
	if (!file) return null;
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

/**
 * 生成 OCS 侧配置文本，端口/地址按当前监听重写。
 * @param {string} file
 * @param {number} port
 */
function readContract(file, port) {
	const table = readJsonFile(file);
	const first = Array.isArray(table) ? table[0] : null;
	if (!first) return '[]';
	return JSON.stringify(
		[{ ...first, url: `http://127.0.0.1:${port}/answer`, homepage: `http://127.0.0.1:${port}` }],
		null,
		2
	);
}

/**
 * 管理页展示的环境变量：ANSWERER_* 与 provider 表里用到的 keyEnv。
 * @param {Record<string, string | undefined>} env
 * @param {string} providersFile
 */
function envRows(env, providersFile) {
	const table = /** @type {Record<string, any> | null} */ (readJsonFile(providersFile));
	const keys = new Set(Object.keys(env).filter((key) => key.startsWith('ANSWERER_')));
	for (const entry of Object.values(table ?? {})) {
		if (entry && typeof entry.keyEnv === 'string' && entry.keyEnv) keys.add(entry.keyEnv);
	}
	keys.add('OPENCODE_GO_API_KEY');
	return [...keys].sort().map((key) => ({ key, value: String(env[key] ?? '') }));
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string} html
 */
function sendHtml(res, status, html) {
	res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
	res.end(html);
}

/**
 * @param {{
 *   answer: (payload: any) => Promise<any>, provider?: string, chain?: string[], model?: string,
 *   maxBodyBytes?: number, host?: string, port?: number, k?: number, startedAt?: number,
 *   logFile?: string, quotaFile?: string, providersFile?: string, contractFile?: string,
 *   env?: Record<string, string | undefined>
 * }} options
 */
export function createServer(options) {
	const {
		answer,
		provider = 'unknown',
		chain,
		model = '',
		maxBodyBytes = MAX_BODY_BYTES,
		host = HOST,
		port = 8787,
		k = 3,
		startedAt = Date.now(),
		logFile = '',
		quotaFile = '',
		providersFile = '',
		contractFile = '',
		env = {}
	} = options;
	const chainList = Array.isArray(chain) && chain.length > 0 ? [...chain] : [provider];

	return http.createServer((req, res) => {
		applyCors(res);

		const handle = async () => {
			const url = new URL(req.url ?? '/', `http://${HOST}`);

			if (req.method === 'OPTIONS') {
				res.writeHead(204);
				res.end();
				return;
			}

			if (url.pathname === '/health') {
				if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
				return sendJson(res, 200, {
					ok: true,
					service: 'baize',
					compat: COMPAT,
					provider: chainList[0],
					chain: chainList,
					model
				});
			}

			if (url.pathname === '/answer') {
				if (req.method !== 'POST') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });

				let raw;
				try {
					raw = await readBody(req, maxBodyBytes);
				} catch (error) {
					if (/** @type {any} */ (error)?.code === 'body_too_large') {
						return sendJson(res, 413, { ok: false, reason: 'body_too_large' });
					}
					return sendJson(res, 400, { ok: false, reason: 'invalid_request' });
				}

				let payload;
				try {
					payload = JSON.parse(raw);
				} catch {
					return sendJson(res, 400, { ok: false, reason: 'invalid_request' });
				}

				const result = await answer(payload);
				const status = !result.ok && result.reason === 'invalid_request' ? 400 : 200;
				return sendJson(res, status, result);
			}

			if (url.pathname === '/' || url.pathname === '/dashboard' || url.pathname === '/settings') {
				if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
				const records = readLogRecords(logFile);
				let html;
				if (url.pathname === '/dashboard') {
					const quota = readJsonFile(quotaFile);
					html = generateDashboard({ records, quota, now: new Date(), logPath: logFile || 'logs/answers.jsonl' });
				} else if (url.pathname === '/settings') {
					html = renderSettings({
						envRows: envRows(env, providersFile),
						contractText: readContract(contractFile, port),
						host,
						port,
						providersFile,
						quotaFile
					});
				} else {
					html = renderHome({
						compat: COMPAT,
						chain: chainList,
						model,
						host,
						port,
						k,
						startedAt,
						records,
						logFile: logFile || 'logs/answers.jsonl',
						hasQuota: Boolean(readJsonFile(quotaFile))
					});
				}
				sendHtml(res, 200, html);
				return;
			}

			if (url.pathname === '/api/status') {
				if (req.method !== 'GET') return sendJson(res, 405, { ok: false, reason: 'method_not_allowed' });
				const records = readLogRecords(logFile);
				const last = records[records.length - 1];
				return sendJson(res, 200, {
					ok: true,
					service: 'baize',
					compat: COMPAT,
					chain: chainList,
					model,
					host,
					port,
					k,
					uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
					records: records.length,
					lastOutcome: last?.outcome ?? null,
					lastTs: last?.ts ?? null
				});
			}

			return sendJson(res, 404, { ok: false, reason: 'not_found' });
		};

		handle().catch((error) => {
			console.error('[baize] 请求处理失败:', error);
			if (!res.headersSent) sendJson(res, 500, { ok: false, reason: 'provider_error' });
			else res.end();
		});
	});
}

/**
 * @param {Record<string, string | undefined>} env
 */
export function start(env = process.env) {
	loadDotenv();
	const startedAt = Date.now();
	const config = loadConfig(env);
	const provider = createRouter({
		providers: config.providers,
		chain: config.chain,
		timeoutMs: config.timeoutMs,
		logprobs: config.logprobs,
		mockProvider: MockProvider.fromEnv(env)
	});
	const logger = createJsonlLogger({ file: config.logFile, enabled: config.logEnabled });
	const answer = createService({
		provider,
		k: config.k,
		marginThreshold: config.marginThreshold,
		logger
	});

	const server = createServer({
		answer,
		provider: config.chain[0],
		chain: config.chain,
		model: provider.model,
		host: config.host,
		port: config.port,
		k: config.k,
		startedAt,
		logFile: config.logFile,
		quotaFile: path.join(ROOT, 'config', 'go-quota.json'),
		providersFile: path.join(ROOT, 'config', 'providers.json'),
		contractFile: path.join(ROOT, 'contract', 'answerer.json'),
		env
	});

	server.on('error', (error) => {
		console.error(`[baize] 启动失败: ${error.message}`);
		process.exitCode = 1;
	});

	server.listen(config.port, config.host, () => {
		console.log(
			`[baize] listening on http://${config.host}:${config.port}  chain=${config.chain.join('>')}  model=${provider.model}  k=${config.k}`
		);
		return server;
	});

	return server;
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
	/** @type {ReturnType<typeof start>} */
	let server;
	try {
		server = start();
	} catch (error) {
		// 配置错误（缺 key、混合链缺 model 等）在监听端口之前就拒绝启动。
		console.error(`[baize] 启动失败: ${/** @type {Error} */ (error)?.message ?? error}`);
		process.exit(1);
	}

	const shutdown = () => {
		server.close(() => process.exit(0));
		// 兜底：连接迟迟不关也别卡住
		setTimeout(() => process.exit(0), 2000).unref();
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}
