import test from 'node:test';
import assert from 'node:assert/strict';

import {
	byDay,
	byModel,
	latencyBuckets,
	loadRecords,
	quotaUsage,
	summarize
} from '../tools/aggregate.mjs';
import { generateDashboard } from '../tools/dashboard.mjs';

/** 造一批覆盖 5 天、3 个模型、含 null 与旧行的记录。 */
function fixture() {
	const records = [];
	const days = ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
	let i = 0;
	for (const day of days) {
		for (const model of ['glm-5.3-flash', 'deepseek-v4.1-flash', 'claude-haiku-5-5']) {
			i += 1;
			const ok = i % 7 !== 0;
			records.push({
				ts: `${day}T0${i % 9}:12:00.000Z`,
				provider: 'opencode-go',
				model,
				outcome: ok ? 'ok' : 'low_confidence',
				ms: 600 + i * 40,
				cost: 0,
				list_cost: 0.00001 * i,
				allowance: 0.000002 * i,
				billing_source: 'go',
				input_tokens: 200,
				output_tokens: 4,
				reasoning_tokens: model.startsWith('deepseek') ? 20 : 0,
				cached_tokens: 0
			});
		}
	}
	// 旧行：没有费用字段，必须按未知处理
	records.push({ ts: '2026-11-21T10:00:00.000Z', provider: 'mock', model: 'mock', outcome: 'ok', ms: 12 });
	// 坏行：解析失败应被跳过
	return { records, text: `${records.map((r) => JSON.stringify(r)).join('\n')}\n{broken json\n` };
}

test('loadRecords：跳过坏行，保留合法记录', () => {
	const { records, text } = fixture();
	const loaded = loadRecords(text);
	assert.equal(loaded.length, records.length);
	assert.equal(loaded.at(-1)?.model, 'mock');
});

test('summarize：成功率、p50/p95、额度与 token 汇总', () => {
	const { records } = fixture();
	const summary = summarize(records);
	assert.equal(summary.questions, records.length);
	assert.equal(summary.ok, records.filter((r) => r.outcome === 'ok').length);
	assert.equal(summary.allowanceKnown, 15, '只有 15 条带 allowance');
	assert.ok(summary.totalAllowance > 0);
	assert.ok(summary.p50ms > 0 && summary.p95ms >= summary.p50ms);
	assert.equal(summary.tokens.input, 15 * 200);
});

test('byModel：按题数降序，cost=0 与 null 都不算未知', () => {
	const { records } = fixture();
	const rows = byModel(records);
	assert.equal(rows.length, 4);
	assert.equal(rows[0].count, 5);
	const mock = rows.find((r) => r.model === 'mock');
	assert.equal(mock.cost, null, '旧行没有 cost → null');
	assert.equal(mock.allowance, null);
	const glm = rows.find((r) => r.model === 'glm-5.3-flash');
	assert.equal(glm.cost, 0, 'cost=0 是已知的自由额度，不是 null');
	assert.ok(glm.allowance > 0);
});

test('byDay：升序、按模型分组、跨天不串', () => {
	const { records } = fixture();
	const days = byDay(records);
	assert.equal(days.length, 5);
	assert.deepEqual(
		days.map((d) => d.date),
		['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']
	);
	assert.equal(days[0].perModel.length, 3);
	assert.equal(days[4].perModel.length, 4, '最后一天多一条 mock');
});

test('latencyBuckets：超过上限归入最后一桶', () => {
	const buckets = latencyBuckets(
		[
			{ ts: 'x', ms: 12 },
			{ ts: 'x', ms: 700 },
			{ ts: 'x', ms: 999999 }
		],
		500,
		2000
	);
	assert.equal(buckets.length, 4);
	assert.equal(buckets[0].count, 1);
	assert.equal(buckets[1].count, 1);
	assert.equal(buckets[3].count, 1, '超上限落最后一桶');
});

test('quotaUsage：有额度算比例，没额度为 null', () => {
	const { records } = fixture();
	const rows = quotaUsage(byModel(records), { models: { 'glm-5.3-flash': 60 } });
	const glm = rows.find((r) => r.model === 'glm-5.3-flash');
	assert.equal(glm.limit, 60);
	assert.ok(glm.ratio !== null && glm.ratio > 0);
	const other = rows.find((r) => r.model === 'claude-haiku-5-5');
	assert.equal(other.limit, null);
	assert.equal(other.ratio, null);
});

test('generateDashboard：包含 KPI、SVG 与模型名，且不引用外部资源', () => {
	const { records } = fixture();
	const html = generateDashboard({
		records,
		quota: { models: { 'glm-5.3-flash': 60, 'deepseek-v4.1-flash': 100 } },
		now: new Date('2026-11-21T12:00:00Z'),
		logPath: 'logs/answers.jsonl'
	});
	assert.ok(html.startsWith('<!doctype html>'));
	assert.ok((html.match(/<svg/g) ?? []).length >= 3, '至少三张图');
	assert.ok(html.includes('glm-5.3-flash'));
	assert.ok(html.includes('$60.00'), '额度上限出现在表里');
	assert.ok(!/https?:\/\//.test(html.replace(/https:\/\/opencode\.ai[^\s"']*/g, '')), '不引外部资源');
});

test('generateDashboard：空日志给出空状态而不是崩溃', () => {
	const html = generateDashboard({ records: [], quota: null, logPath: 'logs/answers.jsonl' });
	assert.ok(html.includes('还没有答题记录'));
	assert.ok(html.includes('<svg'));
});
