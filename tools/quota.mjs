// @ts-check
/**
 * 刷新额度表：拉 OpenCode 的模型目录，把每个模型的月度额度写成 config/go-quota.json。
 *
 *   node tools/quota.mjs                # Go（默认）
 *   node tools/quota.mjs --plan go-plus
 *
 * 该目录无需 API key 也能读到公开模型；带 key 时只返回该 workspace 可用的模型。
 * 网络失败不会覆盖已有文件——宁可看板用旧表，也不要变成空表。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const URL = 'https://opencode.ai/inference/go/v1/models';
const OUT = 'config/go-quota.json';

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
		} else {
			out[key] = 'true';
		}
	}
	return out;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const plan = args.plan ?? 'go';
	if (!['go', 'go-plus', 'go-teams'].includes(plan)) {
		console.error(`plan 必须是 go | go-plus | go-teams，收到: ${plan}`);
		process.exit(2);
	}

	/** @type {Record<string, string>} */
	const headers = { 'User-Agent': 'baize/0.1.0' };
	const key = process.env.OPENCODE_GO_API_KEY;
	if (key) headers.Authorization = `Bearer ${key}`;

	/** @type {any} */
	let payload;
	try {
		const response = await fetch(URL, { headers, signal: AbortSignal.timeout(15000) });
		if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
		payload = await response.json();
	} catch (error) {
		const message = /** @type {Error} */ (error)?.message ?? String(error);
		console.error(`[quota] 拉取失败，保留已有 ${OUT}：${message}`);
		process.exit(1);
	}

	const models = /** @type {Record<string, number>} */ ({});
	let skipped = 0;
	for (const model of payload?.data ?? []) {
		const limit = model?.go?.monthly_usage?.[plan];
		if (typeof limit === 'number' && Number.isFinite(limit)) models[model.id] = limit;
		else skipped += 1;
	}

	if (Object.keys(models).length === 0) {
		console.error(`[quota] 目录里没有 ${plan} 额度数据，保留已有 ${OUT}`);
		process.exit(1);
	}

	const sorted = Object.fromEntries(Object.entries(models).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
	const output = {
		fetchedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		source: URL,
		plan,
		models: sorted
	};

	if (existsSync(OUT)) {
		try {
			const previous = JSON.parse(readFileSync(OUT, 'utf8'));
			if (previous?.plan && previous.plan !== plan) {
				console.log(`[quota] 注意：覆盖 ${previous.plan} 的计划表，换成 ${plan}`);
			}
		} catch {
			// 旧文件损坏就直接覆盖
		}
	}

	writeFileSync(OUT, `${JSON.stringify(output, null, '\t')}\n`, 'utf8');
	console.log(`[quota] 已写入 ${OUT}：${Object.keys(sorted).length} 个模型（plan=${plan}，跳过 ${skipped} 个无额度模型）`);
	const top = Object.entries(sorted).slice(0, 5);
	console.log(`[quota] 额度最高：${top.map(([id, limit]) => `${id}=$${limit}`).join(' · ')}`);
}

main();
