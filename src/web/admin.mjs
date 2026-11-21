// @ts-check
/**
 * 管理页：只读。三个页面共用一套深色样式，不引外部资源。
 *
 * - `/`          服务状态 + 最近答题记录
 * - `/dashboard` 由 src/web/dashboard.mjs 生成的看板
 * - `/settings`  当前配置（敏感值打码）+ OCS 题库配置（可复制）
 *
 * 刻意不做写操作：改配置走 .env + 重启，避免把「浏览器里能改服务」变成新的攻击面。
 */

/** @param {unknown} value */
const esc = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(/** @type {string} */ c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c
	);

const BASE_CSS = `
	:root { --bg:#0B0D10; --surface:#12151A; --border:#1F242B; --text:#E6E8EB; --muted:#8B929C; --ok:#35C2A8; --warn:#E0A458; --bad:#E06A8B; }
	* { box-sizing: border-box; }
	body { margin:0; background:var(--bg); color:var(--text); font:13px/1.55 ui-sans-serif,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; -webkit-font-smoothing:antialiased; }
	.wrap { max-width:1080px; margin:0 auto; padding:26px 20px 44px; }
	header { display:flex; align-items:baseline; justify-content:space-between; gap:14px; flex-wrap:wrap; margin-bottom:20px; }
	h1 { font-size:17px; margin:0; font-weight:600; }
	h1 span { color:var(--muted); font-weight:400; font-size:13px; margin-left:8px; }
	nav a { color:var(--muted); text-decoration:none; margin-left:16px; font-size:12px; }
	nav a:hover, nav a.active { color:var(--text); }
	.grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:14px; }
	.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:16px 18px; }
	.kpi-label { color:var(--muted); font-size:11px; letter-spacing:.04em; }
	.kpi-value { display:block; font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; margin-top:4px; word-break:break-all; }
	h2 { font-size:12px; color:var(--muted); letter-spacing:.06em; text-transform:uppercase; margin:0 0 12px; font-weight:500; }
	table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
	th { text-align:left; font-weight:500; color:var(--muted); font-size:11px; padding:0 8px 8px 0; border-bottom:1px solid var(--border); }
	td { padding:8px 8px 8px 0; border-bottom:1px solid rgba(31,36,43,.7); }
	tr:last-child td { border-bottom:0; }
	.num { text-align:right; }
	.muted { color:var(--muted); }
	.pill { display:inline-block; padding:1px 7px; border-radius:999px; font-size:11px; border:1px solid var(--border); }
	.pill.ok { color:var(--ok); border-color:rgba(53,194,168,.4); }
	.pill.bad { color:var(--bad); border-color:rgba(224,106,139,.4); }
	.pill.warn { color:var(--warn); border-color:rgba(224,164,88,.4); }
	.banner { border:1px solid rgba(224,164,88,.45); background:rgba(224,164,88,.08); color:var(--warn); border-radius:8px; padding:10px 12px; margin-bottom:14px; font-size:12px; }
	pre { background:#0E1116; border:1px solid var(--border); border-radius:8px; padding:12px; overflow:auto; font-size:12px; color:#C9CFD6; margin:0; }
	button { background:#1A1F26; color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 10px; font-size:12px; cursor:pointer; }
	button:hover { border-color:#3A424C; }
	.row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
	a.plain { color:var(--text); text-decoration:none; border-bottom:1px dashed #39414B; }
	@media (max-width:900px) { .grid { grid-template-columns:repeat(2,1fr); } .row { grid-template-columns:1fr; } }
	@media (max-width:560px) { .grid { grid-template-columns:1fr; } }
`;

/** @param {{title: string, active: string, body: string}} input */
function layout({ title, active, body }) {
	/** @param {string} href @param {string} label @param {string} key */
	const link = (href, label, key) =>
		`<a href="${href}" class="${active === key ? 'active' : ''}">${label}</a>`;
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>baize · ${esc(title)}</title><style>${BASE_CSS}</style></head>
<body><div class="wrap">
<header>
	<h1>baize <span>${esc(title)}</span></h1>
	<nav>${link('/', '状态', 'home')}${link('/dashboard', '看板', 'dashboard')}${link('/settings', '配置', 'settings')}${link('/health', 'health', 'health')}</nav>
</header>
${body}
</div></body></html>`;
}

/** 敏感值打码：保留前 4 位与长度，足够确认填对了，又不泄露内容。 */
export function maskValue(/** @type {string} */ key, /** @type {string} */ value) {
	if (!/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) return value;
	if (!value) return '';
	return `${value.slice(0, 4)}…（${value.length} 字符）`;
}

/** @param {number} ms */
const fmtTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

/**
 * 首页：状态 + 最近记录。
 * @param {{
 *   compat: string, chain: string[], model: string, host: string, port: number,
 *   k: number, startedAt: number, records: any[], logFile: string, hasQuota: boolean
 * }} input
 */
export function renderHome(input) {
	const { compat, chain, model, host, port, k, startedAt, records, logFile, hasQuota } = input;
	const uptime = Math.round((Date.now() - startedAt) / 1000);
	const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
	const recent = records.slice(-10).reverse();

	const rows =
		recent.length === 0
			? `<tr><td colspan="6" class="muted">还没有答题记录。接入 OCS 后这里会实时出现。</td></tr>`
			: recent
					.map((r) => {
						const ok = r.outcome === 'ok';
						const cls = ok ? 'ok' : r.outcome === 'provider_error' ? 'bad' : 'warn';
						return `<tr>
							<td class="muted">${esc(String(r.ts ?? '').slice(11, 19))}</td>
							<td>${esc(r.model ?? '—')}</td>
							<td>${esc(r.effective_type ?? r.type ?? '—')}</td>
							<td><span class="pill ${cls}">${esc(r.outcome ?? '—')}</span></td>
							<td class="num">${r.ms ?? '—'} ms</td>
							<td class="num">${typeof r.allowance === 'number' ? `$${r.allowance.toFixed(6)}` : '—'}</td>
						</tr>`;
					})
					.join('');

	return layout({
		title: '服务状态',
		active: 'home',
		body: `
		${loopback ? '' : `<div class="banner">当前监听 ${esc(host)}，不是回环地址。管理页与 /answer 对该网络可达，请确认这是你要的。</div>`}
		<section class="grid">
			<article class="card"><span class="kpi-label">链路</span><strong class="kpi-value">${esc(chain.join(' → '))}</strong></article>
			<article class="card"><span class="kpi-label">模型</span><strong class="kpi-value">${esc(model || '—')}</strong></article>
			<article class="card"><span class="kpi-label">监听</span><strong class="kpi-value">${esc(host)}:${port}</strong></article>
			<article class="card"><span class="kpi-label">运行 / 自洽采样</span><strong class="kpi-value">${uptime}s · K=${k}</strong></article>
		</section>
		<section class="card" style="margin-bottom:14px">
			<h2>最近答题</h2>
			<table><thead><tr><th>时间</th><th>模型</th><th>题型</th><th>结果</th><th class="num">耗时</th><th class="num">额度</th></tr></thead>
			<tbody>${rows}</tbody></table>
			<p class="muted" style="margin:10px 0 0">共 ${records.length} 条 · 日志 ${esc(logFile)} · 额度表${hasQuota ? '已加载' : '未找到'} · 详见 <a class="plain" href="/dashboard">看板</a></p>
		</section>
		<section class="card">
			<h2>接进 OCS</h2>
			<p class="muted">把下面这段贴进 OCS 面板的「题库配置」，具体字段见 <a class="plain" href="/settings">配置页</a>。</p>
			<pre>POST http://127.0.0.1:${port}/answer   （${esc(compat)}）</pre>
		</section>`
	});
}

/**
 * 配置页：只读展示。
 * @param {{
 *   envRows: Array<{key: string, value: string, source?: string}>,
 *   contractText: string, host: string, port: number, providersFile: string, quotaFile: string
 * }} input
 */
export function renderSettings({ envRows, contractText, host, port, providersFile, quotaFile }) {
	const rows = envRows
		.map(
			(row) => `<tr><td>${esc(row.key)}</td><td>${esc(maskValue(row.key, row.value)) || '<span class="muted">未设置</span>'}</td></tr>`
		)
		.join('');

	return layout({
		title: '配置（只读）',
		active: 'settings',
		body: `
		<div class="banner">这一页只读。改动请编辑仓库根目录的 <code>.env</code>，然后重启服务。</div>
		<section class="row">
			<div class="card">
				<h2>环境变量</h2>
				<table><thead><tr><th>变量</th><th>值</th></tr></thead><tbody>${rows}</tbody></table>
				<p class="muted" style="margin:10px 0 0">provider 预设：${esc(providersFile)}<br>额度表：${esc(quotaFile)}</p>
			</div>
			<div class="card">
				<h2>OCS 题库配置</h2>
				<p class="muted">复制后贴进面板「题库配置」。url 已按当前端口 ${port} 生成。</p>
				<pre id="contract">${esc(contractText)}</pre>
				<p style="margin:10px 0 0"><button onclick="navigator.clipboard.writeText(document.getElementById('contract').textContent).then(()=>{this.textContent='已复制';setTimeout(()=>this.textContent='复制',1200)})">复制</button></p>
			</div>
		</section>`
	});
}
