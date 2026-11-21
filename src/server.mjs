// @ts-check
/**
 * HTTP 入口。只绑 127.0.0.1。
 *
 * 注意 CORS：OCS 的题库配置是 "type": "fetch"（answer.wrapper.handler.ts:27,75-97），
 * 走页面里的原生 fetch，属于跨域请求，浏览器会先发 OPTIONS 预检。
 * 因此必须返回 Access-Control-Allow-*，否则真实网课页面里一个请求都发不出去。
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOST, loadConfig, loadDotenv } from './config.mjs';
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
export function createServer(options) {
	const { answer, provider = 'unknown', chain, model = '', maxBodyBytes = MAX_BODY_BYTES } = options;
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

			if (url.pathname === '/') {
				res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
				res.end(
					[
						`baize (${COMPAT})`,
						'',
						'POST /answer   OCS 题库接口（JSON）',
						'GET  /health   健康检查',
						'',
						'日志：logs/answers.jsonl'
					].join('\n')
				);
				return;
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
		model: provider.model
	});

	server.on('error', (error) => {
		console.error(`[baize] 启动失败: ${error.message}`);
		process.exitCode = 1;
	});

	server.listen(config.port, HOST, () => {
		console.log(
			`[baize] listening on http://${HOST}:${config.port}  chain=${config.chain.join('>')}  model=${provider.model}  k=${config.k}`
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
