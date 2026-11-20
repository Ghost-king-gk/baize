import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt, parseCompletion, parseLetters, shuffleOrder } from '../src/prompt.mjs';
import { InvalidOutputError } from '../src/format.mjs';

/** 可复现的伪随机数（仅测试用） */
function seeded(seed) {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x100000000;
	};
}

test('shuffleOrder：是一个排列，且带种子的 rng 可复现', () => {
	const first = shuffleOrder(6, seeded(42));
	assert.deepEqual([...first].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
	assert.deepEqual(shuffleOrder(6, seeded(42)), first);
	assert.notDeepEqual(shuffleOrder(6, seeded(7)), first);
	assert.deepEqual(shuffleOrder(0), []);
	assert.deepEqual(shuffleOrder(1), [0]);
});

test('buildPrompt 单选：按 order 展示、剥掉选项字母、要求只输出序号', () => {
	const options = ['A. 1', 'B. 2', 'C. 3', 'D. 4'];
	const prompt = buildPrompt({ type: 'single', title: '1+2 = ?', options, order: [2, 0, 1, 3] });

	assert.match(prompt.user, /题型：单选题/);
	assert.match(prompt.user, /1\+2 = \?/);
	assert.match(prompt.user, /1\) 3/);
	assert.match(prompt.user, /2\) 1/);
	assert.match(prompt.user, /3\) 2/);
	assert.match(prompt.user, /4\) 4/);
	assert.doesNotMatch(prompt.user, /A\. 1/);
	assert.match(prompt.user, /只输出 1 个正确选项的序号/);
	assert.deepEqual(prompt.order, [2, 0, 1, 3]);
	assert.equal(prompt.optionCount, 4);
	assert.match(prompt.system, /禁止输出解释/);
});

test('buildPrompt 多选/判断：指令与题型匹配', () => {
	const options = ['A. 甲', 'B. 乙', 'C. 丙'];
	const multiple = buildPrompt({ type: 'multiple', title: 't', options, order: [0, 1, 2] });
	assert.match(multiple.user, /题型：多选题/);
	assert.match(multiple.user, /用英文逗号分隔/);

	const judgement = buildPrompt({ type: 'judgement', title: 't', options: ['A. 对', 'B. 错'], order: [1, 0] });
	assert.match(judgement.user, /题型：判断题/);
	assert.match(judgement.user, /1\) 错/);
	assert.match(judgement.user, /2\) 对/);
});

test('buildPrompt 填空：不要选项、要求 JSON 数组', () => {
	const prompt = buildPrompt({ type: 'completion', title: '中国的首都是____', options: [], order: [0] });
	assert.match(prompt.user, /题型：填空题/);
	assert.match(prompt.user, /JSON 字符串数组/);
	assert.doesNotMatch(prompt.user, /选项/);
	assert.equal(prompt.optionCount, 0);
});

test('parseLetters：接受的格式', () => {
	assert.deepEqual(parseLetters('1', 4), [1]);
	assert.deepEqual(parseLetters(' 3 \n', 4), [3]);
	assert.deepEqual(parseLetters('1,3', 4), [1, 3]);
	assert.deepEqual(parseLetters('1，3', 4), [1, 3]);
	assert.deepEqual(parseLetters('1、3', 4), [1, 3]);
	assert.deepEqual(parseLetters('1 3', 4), [1, 3]);
	assert.deepEqual(parseLetters('3.', 4), [3]);
	assert.deepEqual(parseLetters('（2）', 4), [2]);
	assert.deepEqual(parseLetters('１', 4), [1]);
	assert.deepEqual(parseLetters('```\n2\n```', 4), [2]);
	assert.deepEqual(parseLetters('4,2,1', 4), [4, 2, 1]);
	assert.deepEqual(parseLetters('答案：3', 4), [3]);
	assert.deepEqual(parseLetters('答案是 1', 4), [1]);
	assert.deepEqual(parseLetters('正确选项: 2, 4', 4), [2, 4]);
});

test('parseLetters：拒绝散文、越界、重复、空串', () => {
	assert.throws(() => parseLetters('', 4), InvalidOutputError);
	assert.throws(() => parseLetters('A', 4), InvalidOutputError);
	assert.throws(() => parseLetters('1+2=3', 4), InvalidOutputError);
	assert.throws(() => parseLetters('答案是 1+2=3', 4), InvalidOutputError);
	assert.throws(() => parseLetters('5', 4), InvalidOutputError);
	assert.throws(() => parseLetters('0', 4), InvalidOutputError);
	assert.throws(() => parseLetters('1,1', 4), InvalidOutputError);
	assert.throws(() => parseLetters('1,,3', 4), InvalidOutputError);
});

test('parseCompletion：JSON 优先，逐行为回退，不吃掉小数点', () => {
	assert.deepEqual(parseCompletion('["北京","上海"]'), ['北京', '上海']);
	assert.deepEqual(parseCompletion('```json\n["甲","乙"]\n```'), ['甲', '乙']);
	assert.deepEqual(parseCompletion('正确答案是 ["甲","乙"]，请核对'), ['甲', '乙']);
	assert.deepEqual(parseCompletion('[1949]'), ['1949']);
	assert.deepEqual(parseCompletion('1. 北京\n2. 上海'), ['北京', '上海']);
	assert.deepEqual(parseCompletion('第1空：x²+y²=r²\n第2空：3.14'), ['x²+y²=r²', '3.14']);
	// "1.5" 没有跟空白，不能被当成行号剥掉
	assert.deepEqual(parseCompletion('1.5'), ['1.5']);
	assert.throws(() => parseCompletion(''), InvalidOutputError);
	assert.throws(() => parseCompletion('[]'), InvalidOutputError);
});
