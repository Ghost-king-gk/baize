// @ts-check
/**
 * 模型目录：运行时拉取 OpenAI list 形状的 `/models`，把「模型 id」解析成
 * 「线协议 + baseUrl」。用户因此只需要填模型 id，不必手写 baseUrl。
 *
 * 目录里每个模型的 `api` 对象可能带多个键（例如 `generate-content` 与
 * `interactions` 并存）。只有本文件支持的四个键参与判断；其余键（交互式
 * 会话、未知实验协议）一律忽略。过滤后：
 * - 恰好 1 个 → 用它；
 * - 0 个 → 报错并列出原始键名，便于用户判断是不是选错了模型；
 * - ≥2 个 → 报歧义，让用户显式指定，绝不猜。
 *
 * 缓存只在内存里，键是 URL；token 不写入缓存、不进日志、不进错误信息。
 */

import { fetchJson } from './protocols/http.mjs';

/** `api` 键 → 本项目 protocol。文档里的四种 API 族，顺序即优先级（不用于自动挑选）。 */
export const API_PROTOCOLS = Object.freeze({
	'chat-completions': 'openai',
	responses: 'responses',
	messages: 'anthropic',
	'generate-content': 'gemini'
});

/** 参与解析的 `api` 键，用于报错提示。 */
export const SUPPORTED_API_KEYS = Object.freeze(Object.keys(API_PROTOCOLS));

/**
 * 目录错误。router 依据 `retryable` 决定「换下一家」还是「立即抛」：
 * - 拉取失败（网络、超时、非 2xx、不是 JSON、缺 data[]）→ retryable: true；
 * - 模型不存在、`api` 结构/协议不明确、`type` 不是 chat → retryable: false。
 */
export class CatalogError extends Error {
	/**
	 * @param {string} message
	 * @param {{retryable?: boolean, status?: number | null, modelId?: string | null, cause?: unknown}} [options]
	 */
	constructor(message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = 'CatalogError';
		this.retryable = Boolean(options.retryable);
		this.status = options.status ?? null;
		this.modelId = options.modelId ?? null;
	}
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** @param {string} value */
function trimBaseUrl(value) {
	return value.trim().replace(/\/+$/, '');
}

/**
 * 单个目录实例。同一实例内按 TTL 缓存整份目录；并发 resolve 只发一次请求。
 */
export class Catalog {
	/**
	 * @param {{
	 *   url: string,
	 *   apiKey: string,
	 *   fetchImpl?: typeof fetch,
	 *   timeoutMs?: number,
	 *   ttlMs?: number,
	 *   now?: () => number
	 * }} options
	 */
	constructor(options) {
		if (!options || typeof options.url !== 'string' || !options.url.trim()) {
			throw new Error('createCatalog 需要 url');
		}
		this.url = trimBaseUrl(options.url);
		this.apiKey = String(options.apiKey ?? '');
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
		this.now = options.now ?? Date.now;

		/** @type {{models: Map<string, any>, expiresAt: number} | null} */
		this.#cache = null;
		/** @type {Promise<Map<string, any>> | null} */
		this.#inflight = null;
	}

	/** @type {{models: Map<string, any>, expiresAt: number} | null} */
	#cache;
	/** @type {Promise<Map<string, any>> | null} */
	#inflight;
	/** clear() 之后到达的旧响应不得写回缓存。 */
	#generation = 0;

	/** 最近一次成功拉取到的模型数；尚未拉取时为 0。 */
	get size() {
		return this.#cache?.models.size ?? 0;
	}

	/** 清空缓存，下一次 resolve 强制重新拉取。 */
	clear() {
		this.#generation += 1;
		this.#cache = null;
		this.#inflight = null;
	}

	/**
	 * @param {string} modelId
	 * @returns {Promise<{protocol: string, baseUrl: string, ownedBy: string | null, modelId: string}>}
	 */
	async resolve(modelId) {
		const id = String(modelId ?? '').trim();
		if (!id) throw new CatalogError('resolve 需要模型 id', { retryable: false });

		const models = await this.#models();
		const item = models.get(id);
		if (!item) throw this.#notFound(id, models);

		return this.#describe(item, id);
	}

	/**
	 * TTL 内复用缓存；并发调用共享同一个 in-flight 请求。
	 * @returns {Promise<Map<string, any>>}
	 */
	#models() {
		const cached = this.#cache;
		if (cached && this.now() < cached.expiresAt) return Promise.resolve(cached.models);
		if (this.#inflight) return this.#inflight;

		const generation = this.#generation;
		const promise = this.#download()
			.then((json) => {
				const models = this.#index(json);
				if (generation === this.#generation) {
					this.#cache = { models, expiresAt: this.now() + this.ttlMs };
				}
				return models;
			})
			.finally(() => {
				if (this.#inflight === promise) this.#inflight = null;
			});
		this.#inflight = promise;
		return promise;
	}

	/**
	 * 拉目录。这里的失败都算「拿不到目录」，router 会切下一家。
	 * @returns {Promise<any>}
	 */
	async #download() {
		/** @type {Record<string, string>} */
		const headers = { Accept: 'application/json' };
		// 空 key 不发 Authorization，避免出现只有前缀的假头；缺 key 在启动时已拦下。
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

		/** @type {any} */
		let json;
		try {
			json = await fetchJson(
				{
					url: this.url,
					init: {
						method: 'GET',
						headers,
						signal: AbortSignal.timeout(this.timeoutMs)
					}
				},
				this.fetchImpl
			);
		} catch (error) {
			const status = /** @type {{status?: number | null}} */ (error)?.status ?? null;
			throw new CatalogError(`拉取模型目录失败 ${this.url}: ${/** @type {Error} */ (error)?.message ?? error}`, {
				retryable: true,
				status,
				cause: error
			});
		}

		if (!isPlainObject(json) || !Array.isArray(json.data)) {
			throw new CatalogError(`模型目录结构不对 ${this.url}: 缺少 data[] 数组`, {
				retryable: false,
				status: 200
			});
		}
		return json;
	}

	/**
	 * @param {any} json
	 * @returns {Map<string, any>}
	 */
	#index(json) {
		/** @type {Map<string, any>} */
		const models = new Map();
		for (const item of json.data) {
			if (!isPlainObject(item) || typeof item.id !== 'string' || !item.id.trim()) continue;
			models.set(item.id, item);
		}
		return models;
	}

	/**
	 * 模型不存在：给出前 10 个候选 id 和自查方式。
	 * @param {string} id
	 * @param {Map<string, any>} models
	 */
	#notFound(id, models) {
		const available = [...models.keys()];
		const preview = available.slice(0, 10).join(', ');
		const more = available.length > 10 ? ` … 共 ${available.length} 个` : '';
		return new CatalogError(
			`模型目录里没有 "${id}"。可用（前 ${Math.min(10, available.length)} 个）: ${preview || '（空）'}${more}。可以 GET ${this.url} 自查。`,
			{ retryable: false, modelId: id }
		);
	}

	/**
	 * 把一个目录条目解析成协议 + baseUrl。
	 * @param {any} item
	 * @param {string} id
	 * @returns {{protocol: string, baseUrl: string, ownedBy: string | null, modelId: string}}
	 */
	#describe(item, id) {
		if (item.type !== 'chat') {
			throw new CatalogError(
				`模型 "${id}" 的 type=${JSON.stringify(item.type)}，只有 type="chat" 的模型能用于问答（目录: ${this.url}）`,
				{ retryable: false, modelId: id }
			);
		}

		if (!isPlainObject(item.api)) {
			throw new CatalogError(`模型 "${id}" 的 api 字段缺失或不是对象（目录: ${this.url}）`, {
				retryable: false,
				modelId: id
			});
		}

		const rawKeys = Object.keys(item.api);
		const keys = rawKeys.filter((key) => Object.prototype.hasOwnProperty.call(API_PROTOCOLS, key));

		if (keys.length === 0) {
			throw new CatalogError(
				`模型 "${id}" 没有可用的 API 协议：api 键为 [${rawKeys.join(', ')}]，本项目支持 ${SUPPORTED_API_KEYS.join(', ')}`,
				{ retryable: false, modelId: id }
			);
		}

		if (keys.length > 1) {
			throw new CatalogError(
				`模型 "${id}" 的 api 有多个可用协议 [${keys.join(', ')}]，无法确定用哪个。请在 config/providers.local.json 里另建一个条目，显式写 protocol 与 baseUrl（目录形态的条目不允许同时写这两项）`,
				{ retryable: false, modelId: id }
			);
		}

		const key = keys[0];
		const spec = item.api[key];
		const baseUrl = isPlainObject(spec) && typeof spec.base_url === 'string' ? trimBaseUrl(spec.base_url) : '';
		if (!baseUrl) {
			throw new CatalogError(`模型 "${id}" 的 api.${key} 缺少 base_url（目录: ${this.url}）`, {
				retryable: false,
				modelId: id
			});
		}

		return {
			protocol: API_PROTOCOLS[/** @type {keyof typeof API_PROTOCOLS} */ (key)],
			baseUrl,
			ownedBy: typeof item.owned_by === 'string' ? item.owned_by : null,
			modelId: id
		};
	}
}

/**
 * @param {{
 *   url: string,
 *   apiKey: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 *   ttlMs?: number,
 *   now?: () => number
 * }} options
 */
export function createCatalog(options) {
	return new Catalog(options);
}
