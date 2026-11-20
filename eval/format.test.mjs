/**
 * 评测：用 ocsjs 的真实题库用例（eval/cases.json，逐字节复制自
 * ocsjs 5.4.2 @ 09628b7 的 tests/cases.json，MIT License）反向驱动格式化器。
 *
 * 对每个用例，用 expect 里的 1-based 下标当作「模型的正确答案」，跑格式化器，
 * 再按 OCS 的分隔符切分，断言切出来的就是期望的选项原文（判断题为词表 token）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
	CORRECT_WORDS,
	INCORRECT_WORDS,
	InvalidOutputError,
	clearString,
	formatCompletion,
	formatJudgement,
	formatMultiple,
	formatSingle,
	judgementPolarity,
	stripOptionLabel
} from '../src/format.mjs';

const fixtureUrl = new URL('./cases.json', import.meta.url);
const raw = readFileSync(fixtureUrl, 'utf8');
const cases = JSON.parse(raw);

/** 选项编号：0 → A，1 → B ... */
function label(index) {
	return String.fromCharCode(65 + index);
}

/** 加上真实网页里常见的 'A. ' 前缀 */
function withLabels(options) {
	return options.map((option, index) => `${label(index)}. ${option}`);
}

/** 判断题匹配，逐字复刻 judgement.ts:65-69 的 matches() */
function ocsMatches(target, words) {
	return words.some(
		(word) =>
			clearString(stripOptionLabel(word), '√', '×') === clearString(stripOptionLabel(target), '√', '×')
	);
}

/** 判断题解析，逐字复刻 judgement.ts:40-63 的单答案分支 */
function ocsResolveJudgement(answer, options) {
	const showCorrect = ocsMatches(answer, CORRECT_WORDS);
	const showIncorrect = ocsMatches(answer, INCORRECT_WORDS);
	if (!showCorrect && !showIncorrect) return undefined;
	for (const option of options) {
		if (showCorrect && ocsMatches(option, CORRECT_WORDS)) return option;
		if (showIncorrect && ocsMatches(option, INCORRECT_WORDS)) return option;
	}
	return undefined;
}

test('fixture 与 ocsjs 09628b7 的 tests/cases.json 逐字节一致（MIT）', () => {
	const digest = createHash('sha256').update(raw, 'utf8').digest('hex');
	assert.equal(digest, '12feb6c638726e9238c1226f43f325b88b7af8734ea4f7768e8d6b8281665835');
	assert.equal(raw.split('\n').length - 1, 877);
	assert.equal(cases.single.length, 80);
	assert.equal(cases.multiple.length, 24);
	assert.equal(cases.judgement.length, 32);
	assert.equal(cases.completion.length, 23);
});

test('单选：expect 下标 → 选项原文，加 A. 前缀后依然命中', () => {
	let checked = 0;
	let skipped = 0;

	for (const item of cases.single) {
		const context = `答案=${JSON.stringify(item.a)} 选项=${JSON.stringify(item.opts)}`;
		if (item.expect.length === 0) {
			skipped += 1;
			continue;
		}

		const expected = item.opts[item.expect[0] - 1];
		assert.deepEqual(formatSingle(item.opts, item.expect).split('#'), [expected], context);

		const prefixed = withLabels(item.opts);
		assert.deepEqual(formatSingle(prefixed, item.expect).split('#'), [prefixed[item.expect[0] - 1]], context);

		// OCS 对答案与选项做同一套 removeRedundant，前缀因此是对称剥离的
		assert.equal(
			stripOptionLabel(formatSingle(prefixed, item.expect)),
			stripOptionLabel(prefixed[item.expect[0] - 1]),
			context
		);
		checked += 1;
	}

	assert.equal(checked, 68);
	assert.equal(skipped, 12);
});

test('多选：expect 下标集合 → 选项原文用 # 连接，切分后逐项相等', () => {
	let checked = 0;
	let skipped = 0;

	for (const item of cases.multiple) {
		const context = `答案=${JSON.stringify(item.a)} 选项=${JSON.stringify(item.opts)}`;
		if (item.expect.length === 0) {
			skipped += 1;
			continue;
		}

		const indices = [...item.expect].sort((a, b) => a - b);
		const expected = indices.map((index) => item.opts[index - 1]);
		assert.deepEqual(formatMultiple(item.opts, item.expect).split('#'), expected, context);

		const prefixed = withLabels(item.opts);
		const expectedPrefixed = indices.map((index) => prefixed[index - 1]);
		assert.deepEqual(formatMultiple(prefixed, item.expect).split('#'), expectedPrefixed, context);

		checked += 1;
	}

	assert.equal(checked, 22);
	assert.equal(skipped, 2);
});

test('判断：expect 下标 → 词表 token，且 OCS 的 resolveJudgement 能选中该选项', () => {
	let checked = 0;
	let skipped = 0;
	let prefixedSkipped = 0;

	for (const item of cases.judgement) {
		const context = `答案=${JSON.stringify(item.a)} 选项=${JSON.stringify(item.opts)}`;
		if (item.expect.length === 0) {
			skipped += 1;
			continue;
		}

		const expected = item.opts[item.expect[0] - 1];
		const token = formatJudgement(item.opts, item.expect);
		assert.equal(token, expected, context);
		assert.equal(ocsResolveJudgement(token, item.opts), expected, context);

		const prefixed = withLabels(item.opts);
		const prefixedOption = prefixed[item.expect[0] - 1];
		if (judgementPolarity(prefixedOption) === undefined) {
			// OCS 的 removeRedundant 处理不了 "A. √" 这类「字母 + 标点 + 符号」，
			// 它自己都匹配不上；我们跟着弃权，而不是编一个 token。
			assert.throws(() => formatJudgement(prefixed, item.expect), InvalidOutputError, context);
			prefixedSkipped += 1;
		} else {
			const prefixedToken = formatJudgement(prefixed, item.expect);
			assert.equal(prefixedToken, expected, context);
			assert.equal(ocsResolveJudgement(prefixedToken, prefixed), prefixedOption, context);
		}

		checked += 1;
	}

	assert.equal(checked, 27);
	assert.equal(skipped, 5);
	// √/× 这类符号选项加前缀后连 OCS 自己都无法归一化，这些变体按弃权断言
	assert.ok(prefixedSkipped > 0);
});

test('填空：expect 各空答案 → # 连接，切分后保序相等', () => {
	let checked = 0;
	let skipped = 0;

	for (const item of cases.completion) {
		const context = `答案=${JSON.stringify(item.a)} 空数=${item.blanks}`;
		if (item.expect.length === 0) {
			skipped += 1;
			continue;
		}

		const answer = formatCompletion(item.expect);
		assert.deepEqual(answer.split('#'), item.expect, context);
		assert.ok(answer.length > 0, context);

		checked += 1;
	}

	assert.equal(checked, 20);
	assert.equal(skipped, 3);
});

test('汇总：137 个可作答用例全部通过，22 个 expect 为空的无解用例不参与', () => {
	const total = cases.single.length + cases.multiple.length + cases.judgement.length + cases.completion.length;
	assert.equal(total, 159);
	assert.equal(159 - 22, 137);
});
