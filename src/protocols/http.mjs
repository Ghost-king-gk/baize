// @ts-check
/** 三个协议适配器共用的 HTTP 细节：超时/网络错误、非 2xx、JSON 解析。 */

/** 401/403/404：密钥过期、无权限、模型/路径不存在。换下一家，而不是让整题失败。 */
export const AUTH_FAILURE_STATUSES = new Set([401, 403, 404]);

/**
 * 协议层错误。router 依据 retryable 决定「换下一家」还是「立即抛出」。
 * - retryable: 网络错误、超时、HTTP 408/429/5xx、401/403/404、响应不是 JSON
 * - authFailure: 401/403/404，router 会打独立的 provider_auth_failed 日志
 * - 致命: 其余 4xx（400 等）以及本地配置错误
 */
export class ProtocolError extends Error {
	/**
	 * @param {string} message
	 * @param {{status?: number | null, retryable?: boolean, authFailure?: boolean, body?: string, cause?: unknown}} [options]
	 */
	constructor(message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'ProtocolError';
		this.status = options.status ?? null;
		this.retryable = Boolean(options.retryable);
		this.authFailure = Boolean(options.authFailure);
		this.body = options.body ?? '';
	}
}

/**
 * 发请求并解析 JSON。非 2xx 时错误信息带状态码与响应体前 200 字。
 * @param {{url: string, init: RequestInit}} request
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<any>}
 */
export async function fetchJson(request, fetchImpl = globalThis.fetch) {
	/** @type {Response} */
	let response;
	try {
		response = await fetchImpl(request.url, request.init);
	} catch (error) {
		const cause = /** @type {{name?: string, message?: string}} */ (error);
		const timeout = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
		throw new ProtocolError(`${timeout ? 'timeout' : 'network_error'}: ${cause?.message ?? String(error)}`, {
			retryable: true,
			cause: error
		});
	}

	let text = '';
	try {
		text = await response.text();
	} catch (error) {
		throw new ProtocolError(`read_failed: ${/** @type {Error} */ (error)?.message ?? error}`, {
			status: response.status,
			retryable: true,
			cause: error
		});
	}

	if (!response.ok) {
		const body = text.slice(0, 200);
		const status = response.status;
		const authFailure = AUTH_FAILURE_STATUSES.has(status);
		throw new ProtocolError(`http_${status}: ${body}`, {
			status,
			// 401/403/404 与 408/429/5xx 一样换下一家；400 等其余 4xx 仍立即抛出。
			retryable: authFailure || status === 408 || status === 429 || status >= 500,
			authFailure,
			body
		});
	}

	try {
		return JSON.parse(text);
	} catch (error) {
		throw new ProtocolError('response_not_json', {
			status: response.status,
			retryable: true,
			body: text.slice(0, 200),
			cause: error
		});
	}
}
