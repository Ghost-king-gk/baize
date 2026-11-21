// @ts-check
/**
 * 多 provider 路由：按 ANSWERER_CHAIN 顺序尝试，可切换错误换下一家、致命错误立即停。
 *
 * 借鉴 cc-switch v4 的本地路由思路：
 * - 供应商是数据（config/providers.json + providers.local.json）；
 * - 协议转换交给 src/protocols/*；
 * - 故障转移 + 进程内熔断；
 * - 只替换必要字段，其余原样透传。
 */

import { InvalidOutputError } from './format.mjs';
import { ProviderError, interpretAnswer } from './provider.mjs';
import { ProtocolError, fetchJson } from './protocols/http.mjs';
import * as anthropic from './protocols/anthropic.mjs';
import * as gemini from './protocols/gemini.mjs';
import * as openai from './protocols/openai.mjs';
import * as responses from './protocols/responses.mjs';

const ADAPTERS = { openai, anthropic, gemini, responses };

/**
 * 显式协议映射：不要再按 `-oauth` 后缀粗暴剥离。
 * `openai-oauth` 走 Responses API，而不是 chat/completions。
 * @type {Record<string, keyof typeof ADAPTERS>}
 */
const PROTOCOL_ADAPTERS = {
	openai: 'openai',
	anthropic: 'anthropic',
	gemini: 'gemini',
	'anthropic-oauth': 'anthropic',
	'openai-oauth': 'responses',
	responses: 'responses'
};

/** 这些 finishReason 表示输出被截断，答案不可信。 */
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'MAX_TOKENS']);

/** 默认熔断参数：3 次连续失败 → 60 秒内跳过。 */
export const DEFAULT_FAILURE_THRESHOLD = 3;
export const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * 进程内熔断器（内存态，不落盘）。
 */
export class CircuitBreaker {
	/**
	 * @param {{failureThreshold?: number, cooldownMs?: number, now?: () => number}} [options]
	 */
	constructor(options = {}) {
		this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
		this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
		this.now = options.now ?? Date.now;
		/** @type {Map<string, {failures: number, openUntil: number}>} */
		this.states = new Map();
	}

	/** @param {string} id */
	#state(id) {
		let state = this.states.get(id);
		if (!state) {
			state = { failures: 0, openUntil: 0 };
			this.states.set(id, state);
		}
		return state;
	}

	/**
	 * 是否处于熔断期。冷却时间到了就自动半开（重置计数，放行一次）。
	 * @param {string} id
	 */
	isOpen(id) {
		const state = this.#state(id);
		if (state.openUntil === 0) return false;
		if (this.now() >= state.openUntil) {
			state.openUntil = 0;
			state.failures = 0;
			return false;
		}
		return true;
	}

	/**
	 * @param {string} id
	 * @returns {boolean} 本次失败是否刚好触发熔断
	 */
	recordFailure(id) {
		const state = this.#state(id);
		state.failures += 1;
		if (state.failures >= this.failureThreshold && state.openUntil === 0) {
			state.openUntil = this.now() + this.cooldownMs;
			return true;
		}
		return false;
	}

	/** @param {string} id */
	recordSuccess(id) {
		this.states.set(id, { failures: 0, openUntil: 0 });
	}
}

/**
 * @param {{
 *   event: string,
 *   provider: string,
 *   status?: number | null,
 *   next?: string | null,
 *   until?: number
 * }} event
 */
export function defaultRouterLog(event) {
	if (event.event === 'provider_fallback') {
		const status = event.status ?? 'network';
		const suffix = event.next ? ` -> fallback=${event.next}` : '';
		console.error(`[baize] provider=${event.provider} status=${status}${suffix}`);
		return;
	}
	if (event.event === 'provider_auth_failed') {
		// 401/403/404 单独一个事件：便于区分「key 过期」和普通限流/宕机。
		const suffix = event.next ? ` -> fallback=${event.next}` : '';
		console.error(`[baize] provider=${event.provider} status=${event.status ?? 'auth'} provider_auth_failed${suffix}`);
		return;
	}
	if (event.event === 'provider_fatal') {
		console.error(`[baize] provider=${event.provider} status=${event.status ?? 'network'} fatal`);
		return;
	}
	if (event.event === 'circuit_open') {
		console.error(`[baize] provider=${event.provider} circuit=open`);
		return;
	}
	if (event.event === 'circuit_skip') {
		console.error(`[baize] provider=${event.provider} circuit=open skip`);
	}
}

/**
 * @param {{
 *   providers: Array<any>,
 *   chain: string[],
 *   timeoutMs?: number,
 *   logprobs?: boolean,
 *   fetchImpl?: typeof fetch,
 *   mockProvider?: {ask: Function, name?: string, model?: string},
 *   log?: (event: any) => void,
 *   now?: () => number,
 *   failureThreshold?: number,
 *   cooldownMs?: number
 * }} config
 */
export function createRouter(config) {
	const {
		providers,
		chain,
		timeoutMs = 20_000,
		logprobs = false,
		fetchImpl = globalThis.fetch,
		mockProvider,
		log = defaultRouterLog,
		now = Date.now,
		failureThreshold = DEFAULT_FAILURE_THRESHOLD,
		cooldownMs = DEFAULT_COOLDOWN_MS
	} = config;

	if (!Array.isArray(chain) || chain.length === 0) throw new Error('createRouter 需要非空 chain');

	/** @type {Map<string, any>} */
	const byId = new Map(providers.map((provider) => [provider.id, provider]));
	const queue = chain.map((id) => {
		const provider = byId.get(id);
		if (!provider) throw new Error(`chain 里的 provider "${id}" 没有配置`);
		return provider;
	});

	const breaker = new CircuitBreaker({ failureThreshold, cooldownMs, now });

	/**
	 * 尝试单个 provider。HTTP 层错误向上抛 ProtocolError；内容层错误抛 InvalidOutputError。
	 * @param {any} provider
	 * @param {any} prompt
	 * @param {{type: 'single'|'multiple'|'judgement'|'completion'|'unknown', optionCount: number}} opts
	 */
	async function askOne(provider, prompt, opts) {
		if (provider.protocol === 'mock') {
			if (!mockProvider) throw new ProviderError('mock provider 未初始化');
			const result = await mockProvider.ask(prompt, opts);
			return { ...result, provider: provider.id, model: provider.model ?? 'mock' };
		}

		const adapterName = PROTOCOL_ADAPTERS[/** @type {keyof typeof PROTOCOL_ADAPTERS} */ (provider.protocol)];
		const adapter = adapterName ? ADAPTERS[adapterName] : undefined;
		if (!adapter) {
			throw new ProviderError(
				`未知协议: ${provider.protocol}（支持: ${Object.keys(PROTOCOL_ADAPTERS).join(', ')}）`
			);
		}

		if (!provider.baseUrl) throw new ProviderError(`provider "${provider.id}" 缺少 baseUrl`);
		if (!provider.model) throw new ProviderError(`provider "${provider.id}" 缺少 model`);

		const isCompletion = opts.type === 'completion';
		const request = adapter.buildRequest({
			provider,
			model: provider.model,
			// 协议适配器只接受单段 prompt：把 system 与 user 用空行拼接。
			prompt: prompt.system ? `${prompt.system}\n\n${prompt.user}` : prompt.user,
			maxTokens: isCompletion ? 600 : 32,
			temperature: 0,
			signal: AbortSignal.timeout(timeoutMs),
			logprobs
		});

		const json = await fetchJson(request, fetchImpl);
		const parsed = adapter.parseResponse(json);

		if (parsed.finishReason && TRUNCATED_REASONS.has(parsed.finishReason)) {
			throw new InvalidOutputError(`finish_reason_${parsed.finishReason}`);
		}
		if (!parsed.text || !parsed.text.trim()) throw new InvalidOutputError('empty_content');

		const interpreted = interpretAnswer(parsed.text, prompt, opts);
		return {
			...interpreted,
			margin: parsed.margin ?? undefined,
			raw: parsed.text,
			usage: parsed.usage,
			provider: provider.id,
			model: provider.model
		};
	}

	/** @type {any} */
	const router = {
		name: chain.join('>'),
		model: queue[0]?.model ?? '',
		chain: [...chain],
		breaker,

		/**
		 * @param {any} prompt
		 * @param {{type: 'single'|'multiple'|'judgement'|'completion'|'unknown', optionCount: number}} opts
		 */
		async ask(prompt, opts) {
			/** @type {string[]} */
			const failures = [];

			for (let index = 0; index < queue.length; index++) {
				const provider = queue[index];
				const next = queue[index + 1]?.id ?? null;

				if (breaker.isOpen(provider.id)) {
					log({ event: 'circuit_skip', provider: provider.id });
					failures.push(`${provider.id}: circuit_open`);
					continue;
				}

				try {
					const result = await askOne(provider, prompt, opts);
					breaker.recordSuccess(provider.id);
					return result;
				} catch (error) {
					// 内容层错误（截断/空输出/序号非法）说明 provider 已经应答，交给 service 重试；
					// 不在这里切下一家，避免把「模型没按格式输出」误判成供应商故障。
					if (error instanceof InvalidOutputError) throw error;

					if (!(error instanceof ProtocolError) && !(error instanceof ProviderError)) throw error;

					const status = /** @type {any} */ (error).status ?? null;
					const retryable = /** @type {any} */ (error).retryable === true;
					const authFailure = /** @type {any} */ (error).authFailure === true;

					if (!retryable) {
						// 400 及其余 4xx 是请求体或配置问题：直接抛出，且不计入熔断，
						// 避免「重试到熔断」后反而切到下一家。
						log({ event: 'provider_fatal', provider: provider.id, status });
						const fatal = new ProviderError(`provider ${provider.id} failed: ${/** @type {Error} */ (error).message}`);
						// @ts-ignore 保留状态码，便于上层/日志复盘
						fatal.status = status;
						// @ts-ignore 致命错误不重试
						fatal.retryable = false;
						// @ts-ignore
						fatal.provider = provider.id;
						throw fatal;
					}

					// 408/429/5xx/网络错误，以及 401/403/404（key 过期、无权限、模型不存在）都切换下一家。
					// 401/403/404 同样计入熔断：连续 3 次后跳过 60 秒。
					const tripped = breaker.recordFailure(provider.id);
					log({
						event: authFailure ? 'provider_auth_failed' : 'provider_fallback',
						provider: provider.id,
						status,
						next
					});
					if (tripped) {
						log({
							event: 'circuit_open',
							provider: provider.id,
							until: now() + cooldownMs
						});
					}
					failures.push(`${provider.id}: ${status ?? 'network'}`);
				}
			}

			const final = new ProviderError(`all_providers_failed: ${failures.join(', ') || 'empty_chain'}`);
			// @ts-ignore
			final.attempts = failures;
			throw final;
		}
	};

	return router;
}
