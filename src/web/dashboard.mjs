// @ts-check
/**
 * 看板生成器：读 answers.jsonl + 额度表，输出单文件 dashboard.html。
 *
 * 目的是「离线可读」：零外部资源、内联 CSS、SVG 在生成时算好，
 * 直接 file:// 打开或丢进任何静态托管都能看。
 */

import { byDay, byModel, latencyBuckets, loadRecords, outcomes, quotaUsage, summarize } from './aggregate.mjs';

const COLORS = ['#35C2A8', '#E0A458', '#8B7CF6', '#4EA1FF', '#E06A8B', '#8FD14F', '#C77DFF', '#61C9D6'];

/** @type {Record<string, string>} */
const OUTCOME_COLORS = {
	ok: '#35C2A8',
	low_confidence: '#E0A458',
	invalid_output: '#8B7CF6',
	provider_error: '#E06A8B',
	unsupported_images: '#4EA1FF',
	invalid_request: '#8B929C',
	unknown: '#5B6572'
};

/** @type {Record<string, string>} */
const OUTCOME_LABELS = {
	ok: '正常作答',
	low_confidence: '低置信弃权',
	invalid_output: '输出不合法',
	provider_error: '供应商故障',
	unsupported_images: '图片题未支持',
	invalid_request: '请求不合法',
	unknown: '未知'
};

/** @param {string} value */
/** @param {string} value */
const esc = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(/** @type {string} */ c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
	);

/** @param {number | null | undefined} value */
const fmtUsd = (value) =>
	value === null || value === undefined
		? '—'
		: value > 0 && value < 0.01
			? `$${value.toFixed(4)}`
			: `$${value.toFixed(2)}`;

/** @param {number | null | undefined} value */
const fmtMs = (value) => (value === null || value === undefined ? '—' : `${Math.round(value)} ms`);

/** @param {number | null | undefined} value */
const fmtPct = (value) => (value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}%`);

/**
 * 各模型固定配色：按题数排序后依次取色，保证同一份数据每次颜色一致。
 * @param {Array<{model: string}>} rows
 */
function colorMap(rows) {
	/** @type {Map<string, string>} */
	const map = new Map();
	rows.forEach((row, index) => map.set(row.model, COLORS[index % COLORS.length]));
	return map;
}

/**
 * 分层柱状图 + 累计折线。
 * @param {ReturnType<typeof byDay>} days
 * @param {Map<string, string>} colors
 * @param {'allowance' | 'cost' | 'count'} metric
 */
function stackedChart(days, colors, metric) {
	const width = 720;
	const height = 260;
	const pad = { left: 56, right: 48, top: 16, bottom: 30 };
	const plotW = width - pad.left - pad.right;
	const plotH = height - pad.top - pad.bottom;

	const totals = days.map((day) => day.perModel.reduce((sum, m) => sum + (m[metric] ?? 0), 0));
	const max = Math.max(1e-9, ...totals);
	const slot = days.length === 0 ? plotW : plotW / days.length;
	const barW = Math.max(4, Math.min(30, slot * 0.58));

	/** @type {string[]} */
	const parts = [];

	// 网格与左轴
	for (let i = 0; i <= 4; i += 1) {
		const y = pad.top + (plotH * i) / 4;
		const value = (max * (4 - i)) / 4;
		parts.push(`<line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#1F242B" stroke-width="1"/>`);
		parts.push(
			`<text x="${pad.left - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end" class="axis">${
				metric === 'count' ? Math.round(value) : fmtUsd(value)
			}</text>`
		);
	}

	let cumulative = 0;
	/** @type {Array<[number, number]>} */
	const cumulativePoints = [];
	// 累计线按「总量」归一化，否则多日累计会冲出画布，只剩第一根柱子旁边一截毛刺
	const grand = totals.reduce((sum, value) => sum + value, 0) || 1;

	days.forEach((day, index) => {
		const x = pad.left + slot * index + (slot - barW) / 2;
		let yCursor = pad.top + plotH;

		for (const item of day.perModel) {
			const value = item[metric] ?? 0;
			if (value <= 0) continue;
			const h = (value / max) * plotH;
			yCursor -= h;
			parts.push(
				`<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${
					colors.get(item.model) ?? '#5B6572'
				}" fill-opacity="0.92"><title>${esc(item.model)} · ${day.date} · ${
					metric === 'count' ? `${value} 题` : fmtUsd(value)
				}</title></rect>`
			);
		}

		cumulative += totals[index];
		cumulativePoints.push([pad.left + slot * index + slot / 2, pad.top + plotH - (cumulative / grand) * plotH]);

		// 日期标签：多了就隔几天标一个
		const every = Math.ceil(days.length / 8);
		if (index % Math.max(1, every) === 0 || index === days.length - 1) {
			parts.push(
				`<text x="${(pad.left + slot * index + slot / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" class="axis">${day.date.slice(5)}</text>`
			);
		}
	});

	if (cumulativePoints.length > 1) {
		parts.push(
			`<polyline points="${cumulativePoints.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="none" stroke="#E6E8EB" stroke-width="1.2" stroke-opacity="0.55" stroke-dasharray="3 3"/>`
		);
	}

	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日消耗">${parts.join('')}</svg>`;
}

/**
 * 结果分布环形图。
 * @param {ReturnType<typeof outcomes>} rows
 */
function donutChart(rows) {
	const size = 220;
	const radius = 78;
	const stroke = 22;
	const center = size / 2;
	const circumference = 2 * Math.PI * radius;
	const total = rows.reduce((sum, row) => sum + row.count, 0) || 1;

	/** @type {string[]} */
	const arcs = [];
	let offset = 0;
	for (const row of rows) {
		const length = (row.count / total) * circumference;
		arcs.push(
			`<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="${OUTCOME_COLORS[row.outcome] ?? '#5B6572'}" stroke-width="${stroke}" stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${center} ${center})"><title>${esc(OUTCOME_LABELS[row.outcome] ?? row.outcome)}: ${row.count}</title></circle>`
		);
		offset += length;
	}

	return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="结果分布">
		<circle cx="${center}" cy="${center}" r="${radius}" fill="none" stroke="#1F242B" stroke-width="${stroke}"/>
		${arcs.join('')}
		<text x="${center}" y="${center - 4}" text-anchor="middle" class="donut-total">${total}</text>
		<text x="${center}" y="${center + 16}" text-anchor="middle" class="axis">题</text>
	</svg>`;
}

/**
 * 延迟直方图，带 p50 / p95 参考线。
 * @param {ReturnType<typeof latencyBuckets>} buckets
 * @param {number | null} p50
 * @param {number | null} p95
 */
function histogram(buckets, p50, p95) {
	const width = 520;
	const height = 200;
	const pad = { left: 40, right: 12, top: 12, bottom: 26 };
	const plotW = width - pad.left - pad.right;
	const plotH = height - pad.top - pad.bottom;
	const max = Math.max(1, ...buckets.map((b) => b.count));
	const slot = plotW / buckets.length;
	const barW = Math.max(2, slot * 0.7);

	/** @type {string[]} */
	const parts = [];
	for (let i = 0; i <= 3; i += 1) {
		const y = pad.top + (plotH * i) / 3;
		parts.push(`<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="#1F242B"/>`);
	}

	buckets.forEach((bucket, index) => {
		const h = (bucket.count / max) * plotH;
		const x = pad.left + slot * index + (slot - barW) / 2;
		parts.push(
			`<rect x="${x.toFixed(1)}" y="${(pad.top + plotH - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="#4EA1FF" fill-opacity="0.85"><title>${bucket.lo}–${bucket.hi} ms: ${bucket.count}</title></rect>`
		);
	});

	for (const [value, color, label] of /** @type {Array<[number | null, string, string]>} */ ([
		[p50, '#35C2A8', 'p50'],
		[p95, '#E0A458', 'p95']
	])) {
		if (value === null || value > buckets.length * 500) continue;
		const x = pad.left + (value / 500) * slot;
		// 两条参考线可能只差几十像素，标签必须错行，否则近距时会压字
		const text = `${label} ${Math.round(value)}ms`;
		const labelW = text.length * 6.2;
		const overflow = x + 4 + labelW > width - pad.right;
		const textX = overflow ? x - 4 : x + 4;
		const anchor = overflow ? ' text-anchor="end"' : '';
		const textY = pad.top + 10 + (label === 'p50' ? 0 : 14);
		parts.push(`<line x1="${x.toFixed(1)}" y1="${pad.top}" x2="${x.toFixed(1)}" y2="${pad.top + plotH}" stroke="${color}" stroke-width="1" stroke-dasharray="3 3"/>`);
		parts.push(`<text x="${textX.toFixed(1)}" y="${textY}" class="axis"${anchor} fill="${color}">${text}</text>`);
	}

	for (let i = 0; i < buckets.length; i += 4) {
		parts.push(`<text x="${(pad.left + slot * i).toFixed(1)}" y="${height - 8}" class="axis">${buckets[i].lo / 1000}s</text>`);
	}

	return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="延迟分布">${parts.join('')}</svg>`;
}

/**
 * 模型表（含额度进度条）。
 * @param {ReturnType<typeof quotaUsage>} rows
 * @param {Map<string, string>} colors
 * @param {'allowance' | 'cost'} metric
 */
function modelTable(rows, colors, metric) {
	if (rows.length === 0) return '<p class="empty">还没有数据。</p>';
	const body = rows
		.map((row) => {
			const ratio = row.ratio;
			const width = ratio === null ? 0 : Math.min(100, ratio * 100);
			const fill = ratio !== null && ratio >= 1 ? '#E06A8B' : ratio !== null && ratio >= 0.8 ? '#E0A458' : colors.get(row.model) ?? '#35C2A8';
			const quotaCell =
				row.limit === null
					? '<span class="muted">无额度表</span>'
					: `<div class="bar"><i style="width:${width.toFixed(1)}%;background:${fill}"></i></div>
						<span class="muted">${fmtUsd(row.spent)} / ${fmtUsd(row.limit)}${ratio === null ? '' : ` · ${(ratio * 100).toFixed(1)}%`}</span>`;
			return `<tr>
				<td><span class="dot" style="background:${colors.get(row.model) ?? '#5B6572'}"></span>${esc(row.model)}</td>
				<td class="num">${row.count}</td>
				<td class="num">${fmtPct(row.okRate)}</td>
				<td class="num">${fmtMs(row.avgMs)}</td>
				<td class="num">${fmtUsd(metric === 'allowance' ? row.allowance : row.cost)}</td>
				<td>${quotaCell}</td>
			</tr>`;
		})
		.join('');

	return `<table>
		<thead><tr><th>模型</th><th class="num">题数</th><th class="num">成功率</th><th class="num">平均延迟</th><th class="num">${
			metric === 'allowance' ? '额度消耗' : '花费'
		}</th><th>月额度占用</th></tr></thead>
		<tbody>${body}</tbody>
	</table>`;
}

/**
 * 生成完整 HTML。
 * @param {{
 *   records: any[],
 *   quota?: {models?: Record<string, number>} | null,
 *   now?: Date,
 *   logPath?: string
 * }} input
 */
export function generateDashboard({ records, quota = null, now = new Date(), logPath = 'logs/answers.jsonl' }) {
	const summary = summarize(records);
	const models = byModel(records);
	const withQuota = quotaUsage(models, quota);
	const days = byDay(records);
	const outcomeRows = outcomes(records);
	const buckets = latencyBuckets(records);
	const colors = colorMap(models);

	// 订阅制下 cost 恒为 0，真正有意义的是 allowance；两者都没有就退回题数。
	const hasAllowance = summary.allowanceKnown > 0;
	const hasCost = summary.costKnown > 0 && (summary.totalCost ?? 0) > 0;
	const metric = hasAllowance ? 'allowance' : hasCost ? 'cost' : 'count';
	const metricLabel = metric === 'count' ? '题数' : metric === 'allowance' ? '额度消耗' : '花费';

	const range =
		records.length === 0
			? '无数据'
			: `${String(records[0].ts).slice(0, 10)} → ${String(records[records.length - 1].ts).slice(0, 10)}`;

	const kpis = [
		['题目数', String(summary.questions), `${summary.ok} 条正常作答`],
		['成功率', fmtPct(summary.okRate), `弃权 ${records.length - summary.ok} 条`],
		[metricLabel, metric === 'count' ? `${summary.questions}` : fmtUsd(metric === 'allowance' ? summary.totalAllowance : summary.totalCost), metric === 'allowance' ? '按 Go 月度额度计' : metric === 'cost' ? '按实际计费' : '暂无费用字段'],
		['延迟 p50 / p95', fmtMs(summary.p50ms), `p95 ${fmtMs(summary.p95ms)}`]
	]
		.map(
			([label, value, hint]) => `<article class="kpi">
				<span class="kpi-label">${esc(label)}</span>
				<strong class="kpi-value">${esc(value)}</strong>
				<span class="kpi-hint">${esc(hint)}</span>
			</article>`
		)
		.join('');

	const legend = models
		.slice(0, 8)
		.map((row) => `<span class="legend-item"><i style="background:${colors.get(row.model)}"></i>${esc(row.model)}</span>`)
		.join('');

	const emptyState =
		records.length === 0
			? `<section class="card empty-card">
				<h2>还没有答题记录</h2>
				<p class="muted">跑起来之后再生成一次：</p>
				<pre>node src/server.mjs
curl -X POST 127.0.0.1:8787/answer -H 'Content-Type: application/json' \\
  -d '{"title":"1+2=?","type":"single","options":"A. 1\\nB. 2\\nC. 3\\nD. 4"}'
node tools/dashboard.mjs</pre>
			</section>`
			: '';

	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>baize · 额度与耗时</title>
<style>
	:root {
		--bg: #0B0D10; --surface: #12151A; --border: #1F242B;
		--text: #E6E8EB; --muted: #8B929C; --accent: #35C2A8;
	}
	* { box-sizing: border-box; }
	body {
		margin: 0; background: var(--bg); color: var(--text);
		font: 13px/1.5 ui-sans-serif, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
		-webkit-font-smoothing: antialiased;
	}
	.wrap { max-width: 1180px; margin: 0 auto; padding: 28px 20px 48px; }
	header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 22px; flex-wrap: wrap; }
	h1 { font-size: 17px; font-weight: 600; margin: 0; letter-spacing: 0.01em; }
	h1 span { color: var(--muted); font-weight: 400; margin-left: 8px; font-size: 13px; }
	.meta { color: var(--muted); font-size: 12px; }
	.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 14px; }
	.card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; }
	.kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
	.kpi-label { color: var(--muted); font-size: 12px; letter-spacing: 0.04em; }
	.kpi-value { font-size: 32px; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
	.kpi-hint { color: var(--muted); font-size: 12px; }
	.row { display: grid; gap: 14px; margin-bottom: 14px; }
	.row.wide { grid-template-columns: 1.9fr 1fr; }
	.row.even { grid-template-columns: 1.35fr 1fr; }
	h2 { font-size: 12px; font-weight: 500; letter-spacing: 0.06em; color: var(--muted); margin: 0 0 14px; text-transform: uppercase; }
	svg { width: 100%; height: auto; display: block; overflow: visible; }
	.axis { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
	.donut-total { fill: var(--text); font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; }
	table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
	th { text-align: left; font-weight: 500; color: var(--muted); font-size: 11px; letter-spacing: 0.04em; padding: 0 8px 8px 0; border-bottom: 1px solid var(--border); }
	td { padding: 9px 8px 9px 0; border-bottom: 1px solid rgba(31, 36, 43, 0.7); vertical-align: middle; }
	tr:last-child td { border-bottom: 0; }
	.num { text-align: right; }
	.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; vertical-align: 1px; }
	.bar { height: 4px; background: var(--border); border-radius: 2px; overflow: hidden; margin-bottom: 4px; }
	.bar i { display: block; height: 100%; border-radius: 2px; }
	.muted { color: var(--muted); font-size: 11px; }
	.legend { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 10px; color: var(--muted); font-size: 11px; }
	.legend-item i { display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 5px; }
	.empty { color: var(--muted); margin: 0; }
	.empty-card pre { background: #0E1116; border: 1px solid var(--border); border-radius: 8px; padding: 12px; overflow-x: auto; font-size: 12px; color: #C9CFD6; }
	footer { color: var(--muted); font-size: 11px; margin-top: 22px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
	@media (max-width: 900px) {
		.kpis { grid-template-columns: repeat(2, 1fr); }
		.row.wide, .row.even { grid-template-columns: 1fr; }
	}
	@media (max-width: 560px) { .kpis { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
	<header>
		<h1>baize <span>额度与耗时</span></h1>
		<div class="meta">${esc(range)} · 生成于 ${esc(now.toISOString().replace('T', ' ').slice(0, 16))} UTC</div>
	</header>

	<section class="kpis">${kpis}</section>
	${emptyState}

	<section class="row wide">
		<div class="card">
			<h2>每日${esc(metricLabel)}${metric === 'count' ? '（暂无费用字段）' : ''}</h2>
			${stackedChart(days, colors, metric)}
			<div class="legend">${legend}</div>
		</div>
		<div class="card">
			<h2>结果分布</h2>
			${donutChart(outcomeRows)}
			<div class="legend">${outcomeRows
				.map(
					(row) =>
						`<span class="legend-item"><i style="background:${OUTCOME_COLORS[row.outcome] ?? '#5B6572'}"></i>${esc(
							OUTCOME_LABELS[row.outcome] ?? row.outcome
						)} ${row.count}</span>`
				)
				.join('')}</div>
		</div>
	</section>

	<section class="row even">
		<div class="card">
			<h2>按模型</h2>
			${modelTable(withQuota, colors, metric === 'count' ? 'cost' : metric)}
		</div>
		<div class="card">
			<h2>延迟分布（${esc('每格 500ms')}）</h2>
			${histogram(buckets, summary.p50ms, summary.p95ms)}
			<p class="muted">p50 ${fmtMs(summary.p50ms)} · p95 ${fmtMs(summary.p95ms)} · 样本 ${summary.questions} 条</p>
		</div>
	</section>

	<footer>
		<span>数据：${esc(logPath)} · 额度表：config/go-quota.json（缺失的额度显示为“无额度表”）</span>
		<span>空值表示字段缺失，不等于 0</span>
	</footer>
</div>
</body>
</html>
`;
}

/* ------------------------------------------------------------------ *
 * CLI：node tools/dashboard.mjs [--log logs/answers.jsonl]
 *        [--quota config/go-quota.json] [--out dashboard.html]
 * ------------------------------------------------------------------ */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** 极简参数解析：只认 --key value。 */
function parseArgs(argv) {
	/** @type {Record<string, string>} */
	const out = {};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith('--')) continue;
		const key = token.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			out[key] = next;
			i += 1;
		} else {
			out[key] = 'true';
		}
	}
	return out;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const logPath = args.log ?? 'logs/answers.jsonl';
	const quotaPath = args.quota ?? 'config/go-quota.json';
	const outPath = args.out ?? 'dashboard.html';

	const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
	/** @type {any[]} */
	const records = loadRecords(logText);
	const quota = existsSync(quotaPath) ? JSON.parse(readFileSync(quotaPath, 'utf8')) : null;

	const html = generateDashboard({ records, quota, now: new Date(), logPath });
	writeFileSync(outPath, html, 'utf8');

	const summary = summarize(records);
	const rows = quotaUsage(byModel(records), quota);
	const pad = (value, width) => String(value).padEnd(width);

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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main();
}
