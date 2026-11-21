// @ts-check
/**
 * 看板聚合：全部纯函数，输入是 logs/answers.jsonl 的行，输出是各图表要的数据。
 *
 * 约定：字段缺失或非有限数一律视为「未知」（null），不能当 0——
 * 「免费」和「没有数据」在额度看板上是两件事。
 */

/**
 * @typedef {{
 *   ts?: string, provider?: string, model?: string, outcome?: string, ms?: number,
 *   cost?: number | null, list_cost?: number | null, allowance?: number | null, billing_source?: string | null,
 *   input_tokens?: number | null, output_tokens?: number | null,
 *   reasoning_tokens?: number | null, cached_tokens?: number | null
 * }} LogRecord
 */

/** @param {unknown} value @returns {number | null} */
export function num(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * 解析 JSONL；坏行直接跳过，不抛错（日志是边写边读的）。
 * @param {string} text
 * @returns {LogRecord[]}
 */
export function loadRecords(text) {
	/** @type {LogRecord[]} */
	const out = [];
	for (const line of String(text ?? '').split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const record = JSON.parse(trimmed);
			if (record && typeof record === 'object' && typeof record.ts === 'string') out.push(record);
		} catch {
			// 忽略写入中途被截断的行
		}
	}
	return out;
}

/**
 * 已知值求和：一个都没有时返回 null，而不是 0。
 * @param {Array<number | null | undefined>} values
 */
export function sumKnown(values) {
	let sum = 0;
	let known = 0;
	for (const value of values) {
		const n = num(value);
		if (n === null) continue;
		sum += n;
		known += 1;
	}
	return { sum: known > 0 ? sum : null, known, total: values.length };
}

/**
 * 最近秩百分位（不插值），空数组返回 null。
 * @param {number[]} sorted
 * @param {number} p 0..1
 */
export function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index];
}

const modelKey = (record) => String(record.model ?? record.provider ?? 'unknown');
const dayKey = (record) => String(record.ts ?? '').slice(0, 10);

/**
 * 全量摘要。
 * @param {LogRecord[]} records
 */
export function summarize(records) {
	const ms = records.map((r) => num(r.ms)).filter((v) => v !== null).sort((a, b) => a - b);
	const ok = records.filter((r) => r.outcome === 'ok').length;
	const cost = sumKnown(records.map((r) => r.cost));
	const allowance = sumKnown(records.map((r) => r.allowance));
	const tokens = {
		input: sumKnown(records.map((r) => r.input_tokens)).sum,
		output: sumKnown(records.map((r) => r.output_tokens)).sum,
		reasoning: sumKnown(records.map((r) => r.reasoning_tokens)).sum,
		cached: sumKnown(records.map((r) => r.cached_tokens)).sum
	};
	return {
		questions: records.length,
		ok,
		okRate: records.length === 0 ? null : ok / records.length,
		totalCost: cost.sum,
		costKnown: cost.known,
		totalAllowance: allowance.sum,
		allowanceKnown: allowance.known,
		p50ms: percentile(ms, 0.5),
		p95ms: percentile(ms, 0.95),
		tokens
	};
}

/**
 * 按模型聚合，题数降序。
 * @param {LogRecord[]} records
 */
export function byModel(records) {
	/** @type {Map<string, LogRecord[]>} */
	const groups = new Map();
	for (const record of records) {
		const key = modelKey(record);
		const bucket = groups.get(key);
		if (bucket) bucket.push(record);
		else groups.set(key, [record]);
	}

	return [...groups.entries()]
		.map(([model, rows]) => {
			const ms = rows.map((r) => num(r.ms)).filter((v) => v !== null).sort((a, b) => a - b);
			const cost = sumKnown(rows.map((r) => r.cost));
			const allowance = sumKnown(rows.map((r) => r.allowance));
			const sources = new Set(rows.map((r) => r.billing_source).filter((v) => typeof v === 'string'));
			return {
				model,
				provider: String(rows[0]?.provider ?? ''),
				count: rows.length,
				ok: rows.filter((r) => r.outcome === 'ok').length,
				okRate: rows.length === 0 ? null : rows.filter((r) => r.outcome === 'ok').length / rows.length,
				cost: cost.sum,
				allowance: allowance.sum,
				avgMs: ms.length === 0 ? null : ms.reduce((a, b) => a + b, 0) / ms.length,
				p50ms: percentile(ms, 0.5),
				billingSources: [...sources]
			};
		})
		.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));
}

/**
 * 按日聚合（UTC 日期），升序。
 * @param {LogRecord[]} records
 */
export function byDay(records) {
	/** @type {Map<string, Map<string, {cost: number, allowance: number, count: number}>>} */
	const days = new Map();
	for (const record of records) {
		const date = dayKey(record);
		if (!date) continue;
		let day = days.get(date);
		if (!day) {
			day = new Map();
			days.set(date, day);
		}
		const model = modelKey(record);
		const cell = day.get(model) ?? { cost: 0, allowance: 0, count: 0 };
		cell.cost += num(record.cost) ?? 0;
		cell.allowance += num(record.allowance) ?? 0;
		cell.count += 1;
		day.set(model, cell);
	}

	return [...days.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([date, perModelMap]) => {
			const perModel = [...perModelMap.entries()].map(([model, cell]) => ({ model, ...cell }));
			return {
				date,
				count: perModel.reduce((a, m) => a + m.count, 0),
				cost: perModel.reduce((a, m) => a + m.cost, 0),
				allowance: perModel.reduce((a, m) => a + m.allowance, 0),
				perModel: perModel.sort((a, b) => b.count - a.count || a.model.localeCompare(b.model))
			};
		});
}

/**
 * 结果分布，数量降序。
 * @param {LogRecord[]} records
 */
export function outcomes(records) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const record of records) {
		const key = String(record.outcome ?? 'unknown');
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return [...counts.entries()].map(([outcome, count]) => ({ outcome, count })).sort((a, b) => b.count - a.count);
}

/**
 * 延迟直方图。
 * @param {LogRecord[]} records
 * @param {number} [bucketMs]
 * @param {number} [maxMs]
 */
export function latencyBuckets(records, bucketMs = 500, maxMs = 10000) {
	const count = Math.ceil(maxMs / bucketMs);
	const buckets = Array.from({ length: count }, (_, i) => ({ lo: i * bucketMs, hi: (i + 1) * bucketMs, count: 0 }));
	for (const record of records) {
		const ms = num(record.ms);
		if (ms === null || ms < 0) continue;
		// 超过上限的统一落入最后一桶，避免出现看不到的长尾
		const index = Math.min(count - 1, Math.floor(ms / bucketMs));
		buckets[index].count += 1;
	}
	return buckets;
}

/**
 * 把模型行与额度表合并，算出占用率。
 * @param {ReturnType<typeof byModel>} rows
 * @param {{models?: Record<string, number>} | null} quota
 */
export function quotaUsage(rows, quota) {
	const limits = quota?.models ?? {};
	return rows.map((row) => {
		const limit = num(limits[row.model]);
		const spent = num(row.allowance);
		return {
			...row,
			limit,
			spent,
			ratio: limit && limit > 0 && spent !== null ? spent / limit : null
		};
	});
}
