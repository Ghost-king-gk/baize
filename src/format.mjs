// @ts-check
/**
 * 答案格式化：把「模型选择的序号」翻译成 OCS 能匹配的答案字符串。
 *
 * 规则来源（ocsjs 5.4.2 @ 09628b7，均为只读参考）：
 * - packages/core/src/core/worker/resolvers/single.ts:27   单选：选项原文
 * - packages/core/src/core/worker/resolvers/multiple.ts:42 多选：多个选项原文
 * - packages/core/src/core/worker/resolvers/judgement.ts:9-29 判断题词表
 * - packages/core/src/core/worker/resolvers/completion.ts:19 填空：按空位顺序
 * - packages/core/src/core/worker/utils.ts:139              分隔符全集（'#' 最先命中）
 * - packages/core/src/core/utils/string.ts:250             removeRedundant 剥离选项字母前缀
 */

/** OCS 的答案分隔符全集，顺序即 splitAnswer 的匹配顺序（utils.ts:139）。 */
export const ANSWER_SEPARATORS = ['===', '#', '---', '###', '|', ';', '；'];

/** 本项目统一使用的分隔符：在全集里排在 '===' 之后、其余之前，最安全。 */
export const ANSWER_SEPARATOR = '#';

/** 判断题「正确」词表，逐字复制自 judgement.ts:9。 */
export const CORRECT_WORDS = ['是', '对', '正确', '确定', '√', '对的', '是的', '正确的', 'true', 'True', 'T', 'yes', '1'];

/** 判断题「错误」词表，逐字复制自 judgement.ts:11-29。 */
export const INCORRECT_WORDS = [
	'非',
	'否',
	'错',
	'错误',
	'×',
	'X',
	'错的',
	'不对',
	'不正确的',
	'不正确',
	'不是',
	'不是的',
	'false',
	'False',
	'F',
	'no',
	'0'
];

export const QUESTION_TYPES = ['single', 'multiple', 'judgement', 'completion', 'unknown'];

/** 输出不合法（模型乱答 / 无法安全格式化）。上层据此重试或弃权。 */
export class InvalidOutputError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = 'InvalidOutputError';
		this.reason = 'invalid_output';
	}
}

/**
 * 逐字还原 OCS 的 clearString（string.ts:8-15）：去首尾空白、转小写，
 * 只保留中文、英文、数字与调用方指定的例外字符。
 * @param {unknown} input
 * @param {...string} exclude
 */
export function clearString(input, ...exclude) {
	const extra = ['①②③④⑤⑥⑦⑧⑨', ...exclude].join('');
	return String(input ?? '')
		.trim()
		.toLocaleLowerCase()
		.replace(new RegExp(`[^\\u2E80-\\u9FFFA-Za-z0-9${extra}]*`, 'g'), '');
}

/**
 * 逐字还原 OCS 的 removeRedundant（string.ts:250-256），只做标签剥离。
 * 注意：原函数会先 linearizeLatex，这里不需要（仅用于提示词与判断题 token）。
 *
 * 刻意保持与 OCS 完全一致的「怪癖」：`⺀-鿿` 覆盖 U+2E80–U+9FFF，
 * 顿号 U+3001 也在其中，所以 "B、正确" 会变成 "、正确" 而不是 "正确"。
 * OCS 自己也匹配不了这种选项，我们跟着它走，避免造出 OCS 认不出的 token。
 * @param {string} text
 */
export function stripOptionLabel(text) {
	return String(text ?? '')
		.trim()
		.replace(/^[A-Z]{1}[^A-Za-z0-9⺀-鿿]+([A-Za-z0-9⺀-鿿]+)/, '$1')
		.replace(/^[A-Z]{1}([⺀-鿿][A-Za-z0-9⺀-鿿]*)/, '$1');
}

/**
 * 判断题选项的极性。语义等价于 judgement.ts:65-69 的 matches()。
 * @param {string} text
 * @returns {'correct' | 'incorrect' | undefined}
 */
export function judgementPolarity(text) {
	const target = clearString(stripOptionLabel(text), '√', '×');
	if (!target) return undefined;
	if (CORRECT_WORDS.some((word) => clearString(stripOptionLabel(word), '√', '×') === target)) return 'correct';
	if (INCORRECT_WORDS.some((word) => clearString(stripOptionLabel(word), '√', '×') === target)) return 'incorrect';
	return undefined;
}

/**
 * 把 OCS 传来的 options 字符串切成选项数组。
 * OCS 侧是 innerText 以 '\n' 拼接（answer.wrapper.handler.ts:46-66），不是数组。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseOptions(raw) {
	if (Array.isArray(raw)) {
		return raw.map((item) => String(item ?? '').trim()).filter((item) => item.length > 0);
	}
	if (typeof raw !== 'string') return [];
	return raw
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * 校验序号数组：1-based、在范围内、无重复、至少一个。
 * @param {number[]} letters
 * @param {number} optionCount
 * @param {'single'|'multiple'|'judgement'|'completion'|'unknown'} type
 * @returns {null | 'empty' | 'range' | 'duplicate' | 'count'}
 */
export function validateLetters(letters, optionCount, type) {
	if (!Array.isArray(letters) || letters.length === 0) return 'empty';
	for (const letter of letters) {
		if (!Number.isInteger(letter) || letter < 1 || letter > optionCount) return 'range';
	}
	if (new Set(letters).size !== letters.length) return 'duplicate';
	if ((type === 'single' || type === 'judgement') && letters.length !== 1) return 'count';
	return null;
}

/**
 * OCS 传 type: 'unknown' 时的保守推断：
 * 两个选项且一正一误 → 判断题；有选项 → 按单选；无选项 → 按填空。
 * @param {string} type
 * @param {string[]} options
 */
export function inferType(type, options) {
	if (type !== 'unknown') return type;
	if (options.length === 2) {
		const polarities = options.map(judgementPolarity);
		if (polarities.includes('correct') && polarities.includes('incorrect')) return 'judgement';
	}
	return options.length > 0 ? 'single' : 'completion';
}

/**
 * @param {string[]} options
 * @param {number[]} letters
 */
export function formatSingle(options, letters) {
	const error = validateLetters(letters, options.length, 'single');
	if (error) throw new InvalidOutputError(`single_letters_${error}`);
	return options[letters[0] - 1];
}

/**
 * @param {string[]} options
 * @param {number[]} letters
 */
export function formatMultiple(options, letters) {
	const error = validateLetters(letters, options.length, 'multiple');
	if (error) throw new InvalidOutputError(`multiple_letters_${error}`);
	return [...letters]
		.sort((a, b) => a - b)
		.map((letter) => options[letter - 1])
		.join(ANSWER_SEPARATOR);
}

/**
 * 判断题必须返回词表 token，且不能带 'A.' 前缀：
 * 'A. 正确' 归一化后是 'a正确'，judgement.ts 的 matches() 只做整串相等比较，匹配不上。
 * @param {string[]} options
 * @param {number[]} letters
 */
export function formatJudgement(options, letters) {
	const error = validateLetters(letters, options.length, 'judgement');
	if (error) throw new InvalidOutputError(`judgement_letters_${error}`);
	const token = stripOptionLabel(options[letters[0] - 1]).trim();
	if (!token) throw new InvalidOutputError('judgement_empty_token');
	if (!judgementPolarity(token)) throw new InvalidOutputError('judgement_not_in_vocab');
	return token;
}

/**
 * 填空：按空位顺序用 '#' 连接。
 * 答案内含 '#' 或 '===' 会破坏 OCS 的 splitAnswer（'===' 排在 '#' 之前，'#' 又排在其后），
 * 宁可弃权也不返回会被切错的字符串。
 * @param {string[]} answers
 */
export function formatCompletion(answers) {
	if (!Array.isArray(answers) || answers.length === 0) throw new InvalidOutputError('completion_empty');
	const cleaned = answers.map((answer) => String(answer ?? '').trim());
	if (cleaned.some((answer) => answer.length === 0)) throw new InvalidOutputError('completion_blank_answer');
	for (const answer of cleaned) {
		if (answer.includes(ANSWER_SEPARATOR) || answer.includes('===')) {
			throw new InvalidOutputError('completion_separator_in_answer');
		}
	}
	return cleaned.join(ANSWER_SEPARATOR);
}

/**
 * @param {{
 *   type: 'single'|'multiple'|'judgement'|'completion',
 *   options: string[],
 *   letters?: number[],
 *   answers?: string[]
 * }} input
 */
export function formatAnswer(input) {
	const { type, options, letters = [], answers = [] } = input;
	switch (type) {
		case 'single':
			return formatSingle(options, letters);
		case 'multiple':
			return formatMultiple(options, letters);
		case 'judgement':
			return formatJudgement(options, letters);
		case 'completion':
			return formatCompletion(answers);
		default:
			throw new InvalidOutputError(`unsupported_type_${type}`);
	}
}
