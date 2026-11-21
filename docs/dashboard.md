# 看板：额度与耗时

`tools/` 下有两个脚本，都只读本地数据、零依赖。

## 用法

```bash
# 1) 刷新 Go 额度表（可选；config/go-quota.json 已内置快照）
node tools/quota.mjs                 # 默认 go；也支持 --plan go-plus / go-teams

# 2) 生成看板
node tools/dashboard.mjs             # 读 logs/answers.jsonl，写 dashboard.html
```

打开 `dashboard.html` 即可（单文件，无需服务端、无外部资源，可直接 `file://` 打开）。

参数：

```bash
node tools/dashboard.mjs --log logs/answers.jsonl \
                        --quota config/go-quota.json \
                        --out dashboard.html
```

命令行同时会打印一张纯文本摘要：每个模型的题数、成功率、平均延迟、额度消耗与上限。

## 五个面板

| 面板 | 说明 |
| --- | --- |
| KPI | 题目数、成功率、总消耗（额度或花费）、延迟 p50/p95 |
| 每日消耗 | 按日堆叠柱，按模型分色；叠加累计折线 |
| 结果分布 | 环形图：ok / 低置信弃权 / 输出不合法 / 供应商故障 |
| 按模型 | 题数、成功率、平均延迟、消耗、月额度占用条（≥80% 转琥珀，≥100% 转红） |
| 延迟分布 | 500ms 一格的直方图，标出 p50 / p95 |

## 指标口径（重要）

- **`allowance` 才是额度**：Go 订阅内 `cost` 恒为 `0`，真正计入月度上限的是
  `usage.opencode.allowance`（OpenCode 返回的「本次请求占用了多少计划额度」）。
  看板优先用它；没有 `allowance` 时才退回 `cost`；两者都没有就改画题数。
- **`cost` / `list_cost` / `billing_source`**：实际计费 / 标价 / 计费来源
  （`go`、`go-plus`、`balance`、`free`、`byok`）。
- **空值不是 0**：字段缺失显示 `—`。`cost: 0` 表示「订阅内免费」，
  `cost: null` 表示「没有这个数据」，两者在图上必须能区分。
- **`quota` 表缺失**：模型行的额度列显示「无额度表」，不编造上限。

## 刷新额度表

`config/go-quota.json` 是 `GET https://opencode.ai/inference/go/v1/models` 的快照，
取每个模型的 `go.monthly_usage[plan]`。该接口无需 key；带 key 时只返回
workspace 可用的模型。

拉取失败时脚本**不会覆盖**已有文件，退出码非 0——宁可看板用旧表，也不要变成空表。

## 数据来源

`logs/answers.jsonl`，每题一行，由 `src/log.mjs` 追加写入。字段见 README「埋点」一节。
