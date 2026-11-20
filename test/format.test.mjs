import test from 'node:test';
import assert from 'node:assert/strict';

import {
	ANSWER_SEPARATOR,
	InvalidOutputError,
	formatAnswer,
	formatCompletion,
	formatJudgement,
	formatMultiple,
	formatSingle,
	inferType,
	judgementPolarity,
	parseOptions,
	stripOptionLabel,
	validateLetters
} from '../src/format.mjs';

test('parseOptions：按 \\n 切分、去空白、丢空行、兼容 \\r\\n', () => {
	assert.deepEqual(parseOptions('A. 1\nB. 2\nC. 3\nD. 4'), ['A. 1', 'B. 2', 'C. 3', 'D. 4']);
	assert.deepEqual(parseOptions('A. 1\r\n\r\n  B. 2  \r\n'), ['A. 1', 'B. 2']);
	assert.deepEqual(parseOptions(''), []);
	assert.deepEqual(parseOptions(undefined), []);
	assert.deepEqual(parseOptions(['A. 1', ' ', 'B. 2']), ['A. 1', 'B. 2']);
});

test('stripOptionLabel：只剥前缀，不误伤 TCP/IP、CPU 这类字母串', () => {
	assert.equal(stripOptionLabel('A. 3'), '3');
	assert.equal(stripOptionLabel('C) 错误'), '错误');
	assert.equal(stripOptionLabel('D．4'), '4');
	assert.equal(stripOptionLabel('A对'), '对');
	assert.equal(stripOptionLabel('TCP/IP 协议'), 'TCP/IP 协议');
	assert.equal(stripOptionLabel('CPU 使用率'), 'CPU 使用率');
	// 与 OCS 保持一致的怪癖：顿号在 ⺀-鿿 区间内，不会被当作分隔符
	assert.equal(stripOptionLabel('B、正确'), '、正确');
});

test('formatSingle：返回选项原文（含 A. 前缀）', () => {
	const options = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];
	assert.equal(formatSingle(options, [3]), 'C. 3');
	assert.equal(formatSingle(options, [1]), 'A. 1');
	assert.throws(() => formatSingle(options, [1, 3]), InvalidOutputError);
	assert.throws(() => formatSingle(options, [0]), InvalidOutputError);
	assert.throws(() => formatSingle(options, [5]), InvalidOutputError);
});

test('formatMultiple：多个选项原文用 # 连接，按原始顺序', () => {
	const options = ['A. 甲', 'B. 乙', 'C. 丙', 'D. 丁'];
	assert.equal(formatMultiple(options, [3, 1]), 'A. 甲#C. 丙');
	assert.equal(formatMultiple(options, [2]), 'B. 乙');
	assert.equal(formatMultiple(options, [4, 2, 1]), 'A. 甲#B. 乙#D. 丁');
	assert.throws(() => formatMultiple(options, [1, 1]), InvalidOutputError);
});

test('formatJudgement：输出词表 token，带前缀的选项会被剥掉', () => {
	assert.equal(formatJudgement(['A. 正确', 'B. 错误'], [1]), '正确');
	assert.equal(formatJudgement(['A. 正确', 'B. 错误'], [2]), '错误');
	assert.equal(formatJudgement(['A. 对', 'B. 错'], [1]), '对');
	assert.equal(formatJudgement(['√', '×'], [2]), '×');
	assert.equal(formatJudgement(['True', 'False'], [1]), 'True');
	// 极端情况下按 removeRedundant 的规则剥成 '正确'，绝不能留下 'A. 正确'
	assert.equal(formatJudgement(['A.正确', 'B.错误'], [1]), '正确');
	// 不在词表内的选项 → 弃权，而不是猜一个极性词
	assert.throws(() => formatJudgement(['A. 同意', 'B. 不同意'], [1]), InvalidOutputError);
});

test('judgementPolarity：与 judgement.ts 的词表语义一致', () => {
	assert.equal(judgementPolarity('A. 正确'), 'correct');
	assert.equal(judgementPolarity('√'), 'correct');
	assert.equal(judgementPolarity('T'), 'correct');
	assert.equal(judgementPolarity('×'), 'incorrect');
	assert.equal(judgementPolarity('False'), 'incorrect');
	assert.equal(judgementPolarity('不正确'), 'incorrect');
	assert.equal(judgementPolarity('A选项'), undefined);
	assert.equal(judgementPolarity(''), undefined);
});

test('formatCompletion：按空位顺序 # 连接，拒绝会破坏分隔的答案', () => {
	assert.equal(formatCompletion(['北京', '上海']), '北京#上海');
	assert.equal(formatCompletion([' 答案一 ']), '答案一');
	assert.equal(formatCompletion(['x;y', 'a|b']), 'x;y#a|b');
	assert.throws(() => formatCompletion([]), InvalidOutputError);
	assert.throws(() => formatCompletion(['']), InvalidOutputError);
	assert.throws(() => formatCompletion(['a#b']), InvalidOutputError);
	assert.throws(() => formatCompletion(['a===b']), InvalidOutputError);
});

test('validateLetters：范围、重复、单选/判断数量', () => {
	assert.equal(validateLetters([1], 4, 'single'), null);
	assert.equal(validateLetters([], 4, 'single'), 'empty');
	assert.equal(validateLetters([0], 4, 'single'), 'range');
	assert.equal(validateLetters([5], 4, 'single'), 'range');
	assert.equal(validateLetters([1, 1], 4, 'multiple'), 'duplicate');
	assert.equal(validateLetters([1, 2], 4, 'single'), 'count');
	assert.equal(validateLetters([1, 2], 4, 'multiple'), null);
	assert.equal(validateLetters([1.5], 4, 'multiple'), 'range');
});

test('formatAnswer 分发', () => {
	const options = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];
	assert.equal(formatAnswer({ type: 'single', options, letters: [2] }), 'B. 2');
	assert.equal(formatAnswer({ type: 'multiple', options, letters: [1, 4] }), 'A. 1#D. 4');
	assert.equal(formatAnswer({ type: 'judgement', options: ['A. 对', 'B. 错'], letters: [2] }), '错');
	assert.equal(formatAnswer({ type: 'completion', options: [], answers: ['a', 'b'] }), 'a#b');
});

test('分隔符：OCS 的 splitAnswer 会先命中 #（utils.ts:139 的顺序）', () => {
	const answer = formatMultiple(['A. 甲', 'B. 乙'], [1, 2]);
	// 模拟 OCS splitAnswer：按分隔符全集顺序，'===' 之后第一个出现的分隔符即 '#'
	const separators = ['===', '#', '---', '###', '|', ';', '；'];
	const used = separators.find((separator) => answer.split(separator).length > 1);
	assert.equal(used, ANSWER_SEPARATOR);
	assert.deepEqual(answer.split(ANSWER_SEPARATOR), ['A. 甲', 'B. 乙']);
});

test('inferType：unknown 的保守推断', () => {
	assert.equal(inferType('single', ['A. 1', 'B. 2']), 'single');
	assert.equal(inferType('unknown', ['A. 对', 'B. 错']), 'judgement');
	assert.equal(inferType('unknown', ['A. 1', 'B. 2', 'C. 3']), 'single');
	assert.equal(inferType('unknown', []), 'completion');
	assert.equal(inferType('unknown', ['A. 是', 'B. 否']), 'judgement');
});
