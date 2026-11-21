// @ts-check
/**
 * 看板 CLI：逻辑在 src/web/dashboard.mjs，这里只负责读写文件与打印摘要。
 *
 *   node tools/dashboard.mjs [--log logs/answers.jsonl] [--quota config/go-quota.json] [--out dashboard.html]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { byModel, loadRecords, quotaUsage, summarize } from '../src/web/aggregate.mjs';
import { generateDashboard } from '../src/web/dashboard.mjs';

/** @param {string[]} argv */
function parseArgs(argv) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		if (!argv[i].startsWith('--')) continue;
		const key = argv[i].slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i += 1;
		} else out[key] = 'true';
	}
	return out;
}

const fmtUsd = (/** @type {number | null} */ v) =>
	v === null ? '—' : v > 0 && v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
const fmtMs = (/** @type {number | null} */ v) => (v === null ? '—' : `${Math.round(v)} ms`);
const fmtPct = (/** @type {number | null} */ v) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const pad = (/** @type {any} */ v, /** @type {number} */ w) => String(v).padEnd(w);

const args = parseArgs(process.argv.slice(2));
const logPath = args.log ?? 'logs/answers.jsonl';
const quotaPath = args.quota ?? 'config/go-quota.json';
const outPath = args.out ?? 'dashboard.html';

const records = loadRecords(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
const quota = existsSync(quotaPath) ? JSON.parse(readFileSync(quotaPath, 'utf8')) : null;
const html = generateDashboard({ records, quota, now: new Date(), logPath });
writeFileSync(outPath, html, 'utf8');

const summary = summarize(records);
const rows = quotaUsage(byModel(records), quota);
console.log(`\n${pad('模型', 24)}${pad('题数', 8)}${pad('成功率', 10)}${pad('平均延迟', 12)}${pad('额度消耗', 14)}额度上限`);
console.log('-'.repeat(82));
for (const row of rows) {
	console.log(
		`${pad(row.model.slice(0, 22), 24)}${pad(row.count, 8)}${pad(fmtPct(row.okRate), 10)}${pad(fmtMs(row.avgMs), 12)}${pad(
			fmtUsd(row.allowance),
			14
		)}${row.limit === null ? '—' : fmtUsd(row.limit)}`
	);
}
console.log('-'.repeat(82));
console.log(
	`合计 ${summary.questions} 题 · 成功 ${summary.ok} (${fmtPct(summary.okRate)}) · p50 ${fmtMs(summary.p50ms)} · p95 ${fmtMs(
		summary.p95ms
	)} · 额度消耗 ${fmtUsd(summary.totalAllowance)}`
);
console.log(`\n已生成 ${outPath}（${(html.length / 1024).toFixed(1)} KB）· 直接浏览器打开即可\n`);
