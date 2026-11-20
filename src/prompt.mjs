// @ts-check
/**
 * 提示词构建与模型输出解析。
 *
 * 模型只被要求输出「序号」（1-based，对应提示词里 1) 2) ... 的位置），
 * 由服务端映射回原始选项下标，因此模型永远看不到也不需要输出 A/B/C。
 */

import { InvalidOutputError, stripOptionLabel, validateLetters } from './format.mjs';

/** @typedef {'single'|'multiple'|'judgement'|'completion'} EffectiveType */

const TYPE_LABEL = {
	single: '单选题',
	multiple: '多选题',
	judgement: '判断题',
	completion: '填空题'
};

const CHOICE_RULE = {
	single: '只输出 1 个正确选项的序号，例如：3',
	multiple: '输出所有正确选项的序号，用英文逗号分隔，例如：1,3',
	judgement: '只输出 1 个正确选项的序号，例如：2'
};

const SYSTEM_CHOICE = '你是严谨的答题助手。你只能输出选项序号（数字），禁止输出解释、选项原文或选项字母。';
const SYSTEM_COMPLETION = '你是严谨的答题助手。你只能输出 JSON 字符串数组，禁止输出解释或 Markdown。';

/**
 * Fisher-Yates。每次采样独立打乱选项顺序，既做自洽投票，也消位置偏置。
 * @param {number} length
 * @param {() => number} rng
 * @returns {number[]} order[displayIndex] = originalIndex
 */
export function shuffleOrder(length, rng = Math.random) {
	const order = Array.from({ length }, (_, index) => index);
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		const tmp = order[i];
		order[i] = order[j];
		order[j] = tmp;
	}
	return order;
}

/**
 * @param {{
 *   type: EffectiveType,
 *   title: string,
 *   options: string[],
 *   order: number[]
 * }} input
 */
export function buildPrompt(input) {
	const { type, title, options, order } = input;
	if (type === 'completion') {
		return {
			system: SYSTEM_COMPLETION,
			user: [
				'题型：填空题',
				`题干：\n${title}`,
				'',
				`请按空位顺序给出每个空的答案（空数以题干为准）。`,
				'只输出 JSON 字符串数组，例如：["答案1","答案2"]。不要输出解释。'
			].join('\n'),
			order: [0],
			optionCount: 0
		};
	}

	const lines = order.map((originalIndex, displayIndex) => {
		return `${displayIndex + 1}) ${stripOptionLabel(options[originalIndex])}`;
	});

	return {
		system: SYSTEM_CHOICE,
		user: [
			`题型：${TYPE_LABEL[type]}`,
			`题干：\n${title}`,
			'',
			'选项（编号表示位置，不是选项字母）：',
			lines.join('\n'),
			'',
			CHOICE_RULE[type]
		].join('\n'),
		order,
		optionCount: options.length
	};
}

/**
 * 去掉 ```json ... ``` 包裹。
 * @param {string} text
 */
function stripCodeFence(text) {
	const trimmed = String(text ?? '').trim();
	const match = trimmed.match(/^```[A-Za-z]*\s*\r?\n([\s\S]*?)\r?\n?```$/);
	return match ? match[1].trim() : trimmed;
}

/**
 * 解析「1」/「1,3」这类序号输出。
 * 严格拒绝散文，避免 "1+2=3" 被读成 [1,2,3]；解析失败由上层重试一次。
 * @param {string} text
 * @param {number} optionCount
 * @returns {number[]}
 */
export function parseLetters(text, optionCount) {
	if (typeof text !== 'string') throw new InvalidOutputError('letters_no_text');
	let first = stripCodeFence(text)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)[0] ?? '';

	first = first.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
	first = first.replace(/^[（(]\s*/, '').replace(/\s*[)）]$/, '');
	// 容忍 "答案：3" / "选项 3" 这类前缀；后面仍必须只剩数字与分隔符，
	// 所以 "答案是 1+2=3" 依旧会被拒绝。
	first = first.replace(/^(?:正确)?(?:答案|选项|序号)\s*(?:是|为)?\s*[:：]?\s*/, '');
	first = first.replace(/[.。]$/, '').trim();

	if (!first) throw new InvalidOutputError('letters_empty_text');
	if (!/^\d+(?:\s*[,，、;；/]\s*\d+|\s+\d+)*$/.test(first)) {
		throw new InvalidOutputError('letters_not_a_letter_list');
	}

	const letters = first.split(/\D+/).filter(Boolean).map(Number);
	const error = validateLetters(letters, optionCount, 'multiple');
	if (error) throw new InvalidOutputError(`letters_${error}`);
	return letters;
}

/**
 * 把 JSON 数组里的字符串/数字整理成非空字符串数组。
 * @param {unknown} value
 * @returns {string[]}
 */
function toStringAnswers(value) {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : ''))
		.map((item) => item.trim())
		.filter(Boolean);
}

/**
 * 解析填空题答案：优先 JSON 数组，其次逐行回退。
 * 空位数量 OCS 不会传，所以这里只保证「至少一个非空答案」。
 * @param {string} text
 * @returns {string[]}
 */
export function parseCompletion(text) {
	const body = stripCodeFence(text);
	if (!body) throw new InvalidOutputError('completion_empty_text');

	try {
		const parsed = JSON.parse(body);
		if (Array.isArray(parsed)) {
			const answers = toStringAnswers(parsed);
			if (answers.length === 0) throw new InvalidOutputError('completion_empty_answers');
			return answers;
		}
	} catch (error) {
		if (error instanceof InvalidOutputError) throw error;

		// 模型偶尔会在数组前后加一句说明；只截取最外层方括号再试一次
		const bracket = body.match(/\[[\s\S]*\]/);
		if (bracket) {
			try {
				const answers = toStringAnswers(JSON.parse(bracket[0]));
				if (answers.length > 0) return answers;
			} catch {
				// 继续走逐行解析
			}
		}
	}

	const answers = body
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		// 只剥离 "1. " / "第1空： " 这类行首编号；'.' 后必须跟空白，避免把 "1.5" 切成 "5"
		.map((line) => line.replace(/^(?:第\s*)?\d+\s*(?:空)?\s*(?:[.．]\s+|[、)）:：]\s*)/, '').trim())
		.filter(Boolean);

	if (answers.length === 0) throw new InvalidOutputError('completion_empty_answers');
	return answers;
}
