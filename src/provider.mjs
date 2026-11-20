// @ts-check
/**
 * 模型调用层。零依赖：只用全局 fetch。
 *
 * AnswerProvider 契约：
 *   name: string
 *   model: string
 *   ask(prompt, opts) => Promise<{ letters: number[], answers?: string[], margin?: number, raw?: string }>
 *   - letters 是「原始选项数组」的 1-based 下标（provider 内部已把打乱后的序号映射回去）
 *   - completion 题型返回 answers 而不是 letters
 */

import { InvalidOutputError, validateLetters } from './format.mjs';
import { parseCompletion, parseLetters } from './prompt.mjs';

/** 网络 / HTTP / 响应结构错误。 */
export class ProviderError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'ProviderError';
		this.reason = 'provider_error';
	}
}

/**
 * 从 OpenAI 兼容响应里取出文本。部分网关会把 content 返回为分段数组。
 * @param {unknown} content
 */
function extractContent(content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === 'string') return part;
				if (part && typeof part === 'object' && typeof (/** @type {any} */ (part).text) === 'string') {
					return /** @type {any} */ (part).text;
				}
				return '';
			})
			.join('');
	}
	return '';
}

/**
 * 从 logprobs 里估算置信度间隔：第一个含数字的 token 上，最高与次高「数字 token」的概率差。
 * provider 不返回 logprobs 时返回 undefined，ANSWERER_MARGIN 也就不生效。
 * @param {any} choice
 * @returns {number | undefined}
 */
export function marginFromLogprobs(choice) {
	const content = choice?.logprobs?.content;
	if (!Array.isArray(content)) return undefined;

	for (const token of content) {
		const tops = token?.top_logprobs;
		if (!Array.isArray(tops) || tops.length < 2) continue;

		const digits = [];
		for (const top of tops) {
			const text = String(top?.token ?? '');
			const match = text.match(/\d/);
			if (!match || typeof top.logprob !== 'number') continue;
			if (digits.some((entry) => entry.digit === match[0])) continue;
			digits.push({ digit: match[0], probability: Math.exp(top.logprob) });
		}
		if (digits.length < 2) continue;

		digits.sort((a, b) => b.probability - a.probability);
		return digits[0].probability - digits[1].probability;
	}
	return undefined;
}

/** OpenAI 兼容 chat/completions provider。 */
export class OpenAIProvider {
	/**
	 * @param {{
	 *   baseUrl: string,
	 *   apiKey: string,
	 *   model: string,
	 *   timeoutMs?: number,
	 *   logprobs?: boolean,
	 *   fetchImpl?: typeof fetch
	 * }} config
	 */
	constructor(config) {
		if (!config.baseUrl) throw new Error('OpenAIProvider 缺少 baseUrl');
		if (!config.model) throw new Error('OpenAIProvider 缺少 model');
		this.name = 'openai';
		this.model = config.model;
		this.baseUrl = config.baseUrl.replace(/\/+$/, '');
		this.apiKey = config.apiKey;
		this.timeoutMs = config.timeoutMs ?? 20000;
		this.logprobs = Boolean(config.logprobs);
		this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
	}

	/**
	 * @param {{system: string, user: string, order: number[], optionCount: number}} prompt
	 * @param {{type: string, optionCount: number}} opts
	 */
	async ask(prompt, opts) {
		const isCompletion = opts.type === 'completion';
		const body = {
			model: this.model,
			messages: [
				{ role: 'system', content: prompt.system },
				{ role: 'user', content: prompt.user }
			],
			temperature: 0,
			// 选择题只需 1~2 个数字；填空要完整答案，单独放宽。
			max_tokens: isCompletion ? 600 : 32,
			stream: false
		};

		if (this.logprobs && !isCompletion) {
			// 只有显式开启才带，避免不支持 logprobs 的网关直接 400。
			body.logprobs = true;
			body.top_logprobs = 5;
		}

		/** @type {Record<string, string>} */
		const headers = { 'Content-Type': 'application/json' };
		if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

		/** @type {Response} */
		let response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(this.timeoutMs)
			});
		} catch (error) {
			throw new ProviderError(`fetch_failed: ${/** @type {Error} */ (error)?.message ?? String(error)}`);
		}

		const text = await response.text();
		if (!response.ok) {
			throw new ProviderError(`http_${response.status}: ${text.slice(0, 300)}`);
		}

		let payload;
		try {
			payload = JSON.parse(text);
		} catch {
			throw new ProviderError('response_not_json');
		}

		const choice = payload?.choices?.[0];
		if (!choice) throw new ProviderError('response_without_choices');
		if (choice.finish_reason === 'length') throw new InvalidOutputError('finish_reason_length');

		const content = extractContent(choice.message?.content);

		if (isCompletion) {
			const answers = parseCompletion(content);
			return { letters: [], answers, margin: undefined, raw: content };
		}

		const displayLetters = parseLetters(content, prompt.order.length || opts.optionCount);
		const letters = displayLetters.map((letter) => prompt.order[letter - 1] + 1);
		const error = validateLetters(letters, opts.optionCount, opts.type);
		if (error) throw new InvalidOutputError(`letters_${error}`);

		return {
			letters,
			margin: this.logprobs ? marginFromLogprobs(choice) : undefined,
			raw: content
		};
	}
}

/**
 * 测试 / 演示用 provider：不联网，返回预置结果。
 * letters 是「原始选项」下标，天然不受打乱影响，因此自洽投票稳定。
 */
export class MockProvider {
	/**
	 * @param {{letters?: number[], answers?: string[], margin?: number, model?: string}} [config]
	 */
	constructor(config = {}) {
		this.name = 'mock';
		this.model = config.model ?? 'mock';
		this.letters = [...(config.letters ?? [])];
		this.answers = [...(config.answers ?? [])];
		this.margin = config.margin;
		this.calls = 0;
	}

	/**
	 * @param {{type: string}} prompt
	 * @param {{type?: string}} [opts]
	 */
	async ask(prompt, opts = {}) {
		this.calls += 1;
		const type = opts.type ?? prompt.type;
		if (type === 'completion') {
			return { letters: [], answers: [...this.answers], margin: this.margin, raw: 'mock' };
		}
		return { letters: [...this.letters], margin: this.margin, raw: 'mock' };
	}

	/**
	 * 从环境变量构造：ANSWERER_MOCK_LETTERS="3" / "1,3"，
	 * ANSWERER_MOCK_ANSWERS="答案1;答案2"（用 ';' 分，答案里可含 '|'）。
	 * @param {Record<string, string | undefined>} env
	 */
	static fromEnv(env) {
		const letters = String(env.ANSWERER_MOCK_LETTERS ?? '')
			.split(/[^0-9]+/)
			.filter(Boolean)
			.map(Number);
		const answers = String(env.ANSWERER_MOCK_ANSWERS ?? '')
			.split(';')
			.map((item) => item.trim())
			.filter(Boolean);
		const marginRaw = env.ANSWERER_MOCK_MARGIN;
		const margin = marginRaw === undefined || marginRaw === '' ? undefined : Number(marginRaw);
		return new MockProvider({
			letters,
			answers,
			margin: Number.isFinite(margin) ? margin : undefined,
			model: 'mock'
		});
	}
}

/**
 * @param {{
 *   provider: 'openai' | 'mock',
 *   baseUrl: string,
 *   apiKey: string,
 *   model: string,
 *   timeoutMs: number,
 *   logprobs: boolean
 * }} config
 * @param {Record<string, string | undefined>} [env]
 */
export function createProvider(config, env = process.env) {
	if (config.provider === 'mock') return MockProvider.fromEnv(env);
	return new OpenAIProvider({
		baseUrl: config.baseUrl,
		apiKey: config.apiKey,
		model: config.model,
		timeoutMs: config.timeoutMs,
		logprobs: config.logprobs
	});
}
