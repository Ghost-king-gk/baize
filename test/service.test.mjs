import test from 'node:test';
import assert from 'node:assert/strict';

import { InvalidOutputError } from '../src/format.mjs';
import { ProviderError } from '../src/provider.mjs';
import { createService } from '../src/service.mjs';

const OPTIONS = 'A. 1\nB. 2\nC. 3\nD. 4';

/**
 * 可编程 provider：handler(callIndex) 返回 ask 的结果。
 * @param {(call: number) => any} handler
 */
function stubProvider(handler) {
	const provider = {
		name: 'stub',
		model: 'stub-1',
		calls: 0,
		async ask(prompt, opts) {
			provider.calls += 1;
			return handler(provider.calls, prompt, opts);
		}
	};
	return provider;
}

function collectLogs() {
	const records = [];
	return { records, logger: (record) => records.push(record) };
}

test('单选：返回选项原文，埋点字段齐全且不含题干', async () => {
	const provider = stubProvider(() => ({ letters: [3] }));
	const { records, logger } = collectLogs();
	const service = createService({ provider, k: 1, logger });

	const result = await service({ title: '1+2 = ?', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: true, answer: 'C. 3' });
	assert.equal(provider.calls, 1);

	const record = records[0];
	assert.equal(record.type, 'single');
	assert.equal(record.title_len, 7);
	assert.equal(record.title_hash.length, 16);
	assert.equal(record.options_n, 4);
	assert.equal(record.provider, 'stub');
	assert.equal(record.model, 'stub-1');
	assert.deepEqual(record.letters, [3]);
	assert.equal(record.margin, null);
	assert.deepEqual(record.votes, { 3: 1 });
	assert.equal(record.outcome, 'ok');
	assert.equal(typeof record.ms, 'number');
	assert.ok(!JSON.stringify(record).includes('1+2'), '日志不能包含题干原文');
});

test('多选：多个原文用 # 连接（按选项位置升序）', async () => {
	const service = createService({ provider: stubProvider(() => ({ letters: [3, 1] })), k: 1 });
	const result = await service({ title: 't', type: 'multiple', options: OPTIONS });
	assert.deepEqual(result, { ok: true, answer: 'A. 1#C. 3' });
});

test('判断题：type=unknown 时按选项推断，返回词表 token', async () => {
	const service = createService({ provider: stubProvider(() => ({ letters: [2] })), k: 1 });
	const result = await service({ title: '地球是圆的', type: 'unknown', options: 'A. 对\nB. 错' });
	assert.deepEqual(result, { ok: true, answer: '错' });
});

test('填空：按空位顺序输出，# 连接，日志不记录答案正文', async () => {
	const { records, logger } = collectLogs();
	const service = createService({
		provider: stubProvider(() => ({ letters: [], answers: ['北京', '上海'] })),
		k: 1,
		logger
	});
	const result = await service({ title: '中国的首都与最大城市', type: 'completion', options: '' });
	assert.deepEqual(result, { ok: true, answer: '北京#上海' });
	assert.equal(records[0].letters, null);
	assert.deepEqual(records[0].votes, { sample_1: 1 });
	assert.ok(!JSON.stringify(records[0]).includes('北京'), '日志不能包含填空答案');
});

test('自洽采样：3 次里 2 次一致 → 多数票', async () => {
	const sequence = [[1], [1], [3]];
	const provider = stubProvider((call) => ({ letters: sequence[call - 1] }));
	const { records, logger } = collectLogs();
	const service = createService({ provider, k: 3, logger });

	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: true, answer: 'A. 1' });
	assert.equal(provider.calls, 3);
	assert.deepEqual(records[0].votes, { 1: 2, 3: 1 });
});

test('自洽采样：3 次各不相同 → low_confidence 弃权', async () => {
	const sequence = [[1], [2], [3]];
	const service = createService({ provider: stubProvider((call) => ({ letters: sequence[call - 1] })), k: 3 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: false, reason: 'low_confidence' });
});

test('解析失败：重试一次后成功', async () => {
	const provider = stubProvider((call) => {
		if (call === 1) throw new InvalidOutputError('bad');
		return { letters: [2] };
	});
	const service = createService({ provider, k: 1 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: true, answer: 'B. 2' });
	assert.equal(provider.calls, 2);
});

test('解析失败两次 → invalid_output，且只重试一次', async () => {
	const provider = stubProvider(() => {
		throw new InvalidOutputError('bad');
	});
	const service = createService({ provider, k: 1 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: false, reason: 'invalid_output' });
	assert.equal(provider.calls, 2);
});

test('provider 故障 → provider_error；重试仍失败只再试一次', async () => {
	const provider = stubProvider(() => {
		throw new ProviderError('boom');
	});
	const service = createService({ provider, k: 1 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: false, reason: 'provider_error' });
	assert.equal(provider.calls, 2);
});

test('provider 故障后转成解析失败 → 报根因 provider_error', async () => {
	const provider = stubProvider((call) => {
		if (call === 1) throw new ProviderError('boom');
		throw new InvalidOutputError('bad');
	});
	const service = createService({ provider, k: 1 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: false, reason: 'provider_error' });
});

test('图片题：v1 明确返回 unsupported_images，不调用模型', async () => {
	const provider = stubProvider(() => ({ letters: [1] }));
	const service = createService({ provider, k: 1 });
	const result = await service({
		title: '看图作答',
		type: 'single',
		options: OPTIONS,
		images: ['data:image/png;base64,AAAA']
	});
	assert.deepEqual(result, { ok: false, reason: 'unsupported_images' });
	assert.equal(provider.calls, 0);
});

test('margin 低于阈值 → low_confidence；高于阈值 → 正常作答', async () => {
	const low = createService({
		provider: stubProvider(() => ({ letters: [1], margin: 0.05 })),
		k: 1,
		marginThreshold: 0.15
	});
	assert.deepEqual(await low({ title: 't', type: 'single', options: OPTIONS }), {
		ok: false,
		reason: 'low_confidence'
	});

	const high = createService({
		provider: stubProvider(() => ({ letters: [1], margin: 0.5 })),
		k: 1,
		marginThreshold: 0.15
	});
	assert.deepEqual(await high({ title: 't', type: 'single', options: OPTIONS }), { ok: true, answer: 'A. 1' });
});

test('请求非法：空题干 / 选择题没有选项 → invalid_request', async () => {
	const provider = stubProvider(() => ({ letters: [1] }));
	const service = createService({ provider, k: 1 });
	assert.deepEqual(await service({ title: '   ', type: 'single', options: OPTIONS }), {
		ok: false,
		reason: 'invalid_request'
	});
	assert.deepEqual(await service({ title: 't', type: 'single', options: '' }), {
		ok: false,
		reason: 'invalid_request'
	});
	assert.equal(provider.calls, 0);
});

test('type 缺失或未知 → unknown 推断；非法 type 也按 unknown 处理', async () => {
	const service = createService({ provider: stubProvider(() => ({ letters: [1] })), k: 1 });
	assert.deepEqual(await service({ title: 't', options: OPTIONS }), { ok: true, answer: 'A. 1' });
	assert.deepEqual(await service({ title: 't', type: 'weird', options: OPTIONS }), { ok: true, answer: 'A. 1' });
});

test('模型给出超过单选数量的序号 → invalid_output（provider 已校验则直接透传）', async () => {
	const service = createService({ provider: stubProvider(() => ({ letters: [1, 2] })), k: 1 });
	const result = await service({ title: 't', type: 'single', options: OPTIONS });
	assert.deepEqual(result, { ok: false, reason: 'invalid_output' });
});
