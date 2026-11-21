// @ts-check
/**
 * 答题主流程：校验请求 → K 次打乱选项自洽采样 → 多数票 → 格式化 → 埋点。
 * 弃权（ok:false）优于猜错：任何一环不可靠都返回 ok:false，让 OCS 走「搜不到」分支。
 */

import {
	InvalidOutputError,
	QUESTION_TYPES,
	formatAnswer,
	formatCompletion,
	inferType,
	parseOptions
} from './format.mjs';
import { buildPrompt, shuffleOrder } from './prompt.mjs';
import { ProviderError } from './provider.mjs';
import { hashTitle } from './log.mjs';

/** @typedef {'single'|'multiple'|'judgement'|'completion'|'unknown'} QuestionType */

export const REASONS = {
	lowConfidence: 'low_confidence',
	invalidOutput: 'invalid_output',
	providerError: 'provider_error',
	unsupportedImages: 'unsupported_images',
	invalidRequest: 'invalid_request'
};

/**
 * @param {{
 *   provider: { name: string, model: string, ask: Function },
 *   k?: number,
 *   marginThreshold?: number,
 *   logger?: (record: Record<string, unknown>) => Promise<void> | void,
 *   rng?: () => number,
 *   now?: () => number
 * }} config
 */
export function createService(config) {
	const { provider, k = 3, marginThreshold = 0.15, logger = async () => {}, rng = Math.random, now = Date.now } = config;
	if (!provider || typeof provider.ask !== 'function') throw new TypeError('createService 需要 provider.ask');

	const samplesPerQuestion = Math.max(1, Math.min(10, Math.floor(k) || 1));

	/**
	 * 一次采样：独立打乱选项顺序（消位置偏置），失败重试一次。
	 * @param {QuestionType} type
	 * @param {string} title
	 * @param {string[]} options
	 */
	async function sampleOnce(type, title, options) {
		const order = type === 'completion' ? [0] : shuffleOrder(options.length, rng);
		const prompt = buildPrompt({ type, title, options, order });
		const result = await provider.ask(prompt, { type, optionCount: options.length });
		return { order, result };
	}

	/**
	 * @param {QuestionType} type
	 * @param {string} title
	 * @param {string[]} options
	 */
	async function sampleWithRetry(type, title, options) {
		/** @type {unknown} */
		let firstError;
		/** @type {unknown} */
		let lastError;
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				return await sampleOnce(type, title, options);
			} catch (error) {
				if (!(error instanceof InvalidOutputError) && !(error instanceof ProviderError)) throw error;
				// 路由层标记的致命错误（400/401/403/404）不重试，避免重复烧额度。
				if (error instanceof ProviderError && /** @type {any} */ (error).retryable === false) throw error;
				if (attempt === 0) firstError = error;
				lastError = error;
			}
		}
		// 优先暴露根因：provider 挂了就不要报成 invalid_output
		throw firstError instanceof ProviderError ? firstError : lastError;
	}

	/**
	 * @param {any} payload
	 * @returns {Promise<{ok: true, answer: string} | {ok: false, reason: string}>}
	 */
	return async function answer(payload) {
		const startedAt = now();
		const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
		if (!title) return { ok: false, reason: REASONS.invalidRequest };

		const declaredType = /** @type {QuestionType} */ (
			QUESTION_TYPES.includes(payload?.type) ? payload.type : 'unknown'
		);
		const options = parseOptions(payload?.options);
		const images = Array.isArray(payload?.images)
			? payload.images.filter((image) => typeof image === 'string' && image.length > 0)
			: [];

		/** @type {Record<string, any>} */
		const record = {
			ts: new Date().toISOString(),
			type: declaredType,
			title_len: title.length,
			title_hash: hashTitle(title),
			options_n: options.length,
			provider: provider.name ?? 'unknown',
			model: provider.model ?? '',
			letters: null,
			margin: null,
			votes: {},
			ms: 0,
			outcome: REASONS.invalidRequest
		};

		/** @param {{ok: true, answer: string} | {ok: false, reason: string}} response */
		const finish = async (response) => {
			record.ms = Math.max(0, now() - startedAt);
			record.outcome = response.ok ? 'ok' : response.reason;
			try {
				await logger({ ...record });
			} catch (error) {
				console.error(`[baize] logger 异常: ${/** @type {Error} */ (error)?.message ?? error}`);
			}
			return response;
		};

		// v1 明确不支持图片题：多模态未实现时静默返回错误答案是最坏结果。
		if (images.length > 0) return finish({ ok: false, reason: REASONS.unsupportedImages });

		const effectiveType = /** @type {QuestionType} */ (inferType(declaredType, options));
		record.effective_type = effectiveType;

		if (effectiveType === 'unknown') return finish({ ok: false, reason: REASONS.invalidRequest });
		if (effectiveType !== 'completion' && options.length === 0) {
			return finish({ ok: false, reason: REASONS.invalidRequest });
		}

		const isCompletion = effectiveType === 'completion';

		/** @type {{order: number[], result: {letters: number[], answers?: string[], margin?: number}}[]} */
		let samples;
		try {
			samples = await Promise.all(
				Array.from({ length: samplesPerQuestion }, () => sampleWithRetry(effectiveType, title, options))
			);
		} catch (error) {
			const reason =
				error instanceof ProviderError
					? REASONS.providerError
					: error instanceof InvalidOutputError
						? REASONS.invalidOutput
						: REASONS.providerError;
			return finish({ ok: false, reason });
		}

		/** @param {{result: {letters?: number[], answers?: string[]}}} sample */
		const keyOf = (sample) => {
			if (isCompletion) return (sample.result.answers ?? []).join('\u0000');
			return [...(sample.result.letters ?? [])].sort((a, b) => a - b).join(',');
		};

		/** @type {Map<string, {count: number, sample: any}>} */
		const tally = new Map();
		for (const sample of samples) {
			const key = keyOf(sample);
			const existing = tally.get(key);
			if (existing) existing.count += 1;
			else tally.set(key, { count: 1, sample });
		}

		/** @type {{count: number, sample: any} | undefined} */
		let winner;
		for (const entry of tally.values()) {
			if (!winner || entry.count > winner.count) winner = entry;
		}
		if (!winner) return finish({ ok: false, reason: REASONS.invalidOutput });

		// 多 provider 路由：埋点里的 provider 必须是本次实际应答的那家（不是整条链）。
		if (winner.sample.result.provider) record.provider = winner.sample.result.provider;
		if (winner.sample.result.model) record.model = winner.sample.result.model;

		// 票数写入埋点：选择题记序号组合，填空题只记第几个样本（避免把答案正文写进日志）
		if (isCompletion) {
			const voteCounts = {};
			let index = 0;
			for (const entry of tally.values()) voteCounts[`sample_${++index}`] = entry.count;
			record.votes = voteCounts;
		} else {
			const sorted = [...tally.entries()].sort((a, b) => b[1].count - a[1].count);
			record.votes = Object.fromEntries(sorted.map(([key, entry]) => [key, entry.count]));
			record.letters = winner.sample.result.letters;
		}

		// K 次采样里没有过半共识 → 宁可弃权
		if (!isCompletion && samples.length > 1 && winner.count * 2 <= samples.length) {
			return finish({ ok: false, reason: REASONS.lowConfidence });
		}

		if (!isCompletion && marginThreshold > 0) {
			const margins = samples
				.filter((sample) => keyOf(sample) === keyOf(winner.sample))
				.map((sample) => sample.result.margin)
				.filter((margin) => typeof margin === 'number');
			if (margins.length > 0) {
				const average = margins.reduce((sum, margin) => sum + margin, 0) / margins.length;
				record.margin = average;
				if (average < marginThreshold) return finish({ ok: false, reason: REASONS.lowConfidence });
			}
		}

		try {
			const answerText = isCompletion
				? formatCompletion(winner.sample.result.answers)
				: formatAnswer({
						type: /** @type {any} */ (effectiveType),
						options,
						letters: winner.sample.result.letters
					});
			return finish({ ok: true, answer: answerText });
		} catch (error) {
			if (error instanceof InvalidOutputError) return finish({ ok: false, reason: REASONS.invalidOutput });
			throw error;
		}
	};
}
