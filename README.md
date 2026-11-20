兼容 ocsjs 5.4.2 @ 09628b7

# ocs-answerer

OCS（网课助手）的 **AI 题库兼容层**。它自己不做题库，只做三件事：

1. 接住 OCS 发来的 `POST /answer`（题干 + 题型 + 选项）；
2. 问一个 OpenAI 兼容的 LLM，只让它输出选项序号；
3. 把序号翻译回 **OCS 匹配器认得的答案字符串**（选项原文 / `#` 分隔 / 判断题词表 token）。

零运行时依赖，只用 Node 内置模块（`node:http`、`node:test`、全局 `fetch`），没有 `npm install` 步骤。

## 一分钟启动

```bash
cd ocs-answerer

# 1) 真实模型：复制配置并填 base url / key / model
cp .env.example .env
node src/server.mjs

# 2) 只想先看它跑起来（mock provider，不联网，固定回答第 3 个选项）
ANSWERER_PROVIDER=mock ANSWERER_MOCK_LETTERS=3 node src/server.mjs
```

看到这一行就成功了：

```
[ocs-answerer] listening on http://127.0.0.1:8787  provider=openai  model=...
```

冒烟测试：

```bash
curl -s -X POST 127.0.0.1:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"title":"1+2=?","type":"single","options":"A. 1\nB. 2\nC. 3\nD. 4"}'
# {"ok":true,"answer":"C. 3"}
```

## 接入 OCS

把 [`contract/answerer.json`](contract/answerer.json) 的内容整段粘进 OCS 面板的「题库配置」：

```json
[
	{
		"name": "MyAI",
		"homepage": "http://127.0.0.1:8787",
		"url": "http://127.0.0.1:8787/answer",
		"method": "post",
		"type": "fetch",
		"responseType": "json",
		"headers": { "Content-Type": "application/json" },
		"data": {
			"title": "${title}",
			"type": "${type}",
			"options": "${options}"
		},
		"handler": "return (res)=> res && res.ok ? [undefined, res.answer] : undefined"
	}
]
```

`[undefined, res.answer]` 是 OCS 官方支持的写法：题目留空，由 OCS 自动回填当前题。

## 请求与响应

请求（字段与 `packages/core/src/core/answer-wrapper/answer.wrapper.handler.ts:46-66` 的 `env` 一致）：

```json
{
	"title": "【单选题】1+2 = ?",
	"type": "single",
	"options": "A. 1\nB. 2\nC. 3\nD. 4",
	"images": ["data:image/png;base64,..."],
	"suggestion_title": "...",
	"suggestion_options": "..."
}
```

- `options` 是**一个用 `\n` 分隔的字符串**，不是数组；填空题可能为空串。
- `type` ∈ `single` / `multiple` / `judgement` / `completion` / `unknown`。
- `images` 非空时，v1 直接返回 `unsupported_images`（见「已知限制」）。

响应：

```json
{ "ok": true, "answer": "C. 3" }
{ "ok": false, "reason": "low_confidence" }
```

`ok:false` 时 OCS 会走「搜不到」分支，**这是期望行为**：弃权优于猜错。`reason` 取值：

| reason | 含义 |
| --- | --- |
| `low_confidence` | K 次采样没有过半共识，或 logprobs margin 低于阈值 |
| `invalid_output` | 模型输出无法解析 / 序号越界 / 重复 / 数量不符，重试一次仍失败 |
| `provider_error` | 网络、HTTP 非 2xx、响应结构异常，重试一次仍失败 |
| `unsupported_images` | 请求带图片，v1 不支持多模态 |
| `invalid_request` | 请求本身不合法（HTTP 400），如空题干、选择题没有选项 |

`ok:false` 的业务弃权仍返回 HTTP 200；只有 `invalid_request` 返回 400。

`GET /health` 用于探活：`{"ok":true,"service":"ocs-answerer","compat":"ocsjs 5.4.2 @ 09628b7","provider":"...","model":"..."}`。

## 答案格式（本项目最核心的部分）

OCS 的匹配器对答案字符串有硬性要求，格式错了就是「搜不到」，甚至选错：

| 题型 | 返回什么 | ocsjs 依据 |
| --- | --- | --- |
| `single` | 选中选项的**原文**（从请求的 options 里原样取出，含 `A.` 前缀） | `packages/core/src/core/worker/resolvers/single.ts:27-45` 先 `answerNormalizedMatch` 再 `answerSimilar`；两侧都过 `removeRedundant`（`packages/core/src/core/utils/string.ts:250-256`），前缀被对称剥离，所以回原文能命中自己 |
| `multiple` | 多个选项原文，用 `#` 连接 | `packages/core/src/core/worker/resolvers/multiple.ts:42`；分隔符全集 `['===','#','---','###','|',';','；']`（`packages/core/src/core/worker/utils.ts:139`），`#` 排在 `===` 之后、其余之前，最安全 |
| `judgement` | **词表 token**（`正确`/`错误`/`对`/`错`/`√`/`×`/`True`/`False`…），不能带 `A.` 前缀 | `packages/core/src/core/worker/resolvers/judgement.ts:9-29` 定义词表，`:40-63` 做**整串相等**比较：`A. 正确` 归一化后是 `a正确`，匹配不上 |
| `completion` | 各空答案用 `#` 连接，按空位顺序 | `packages/core/src/core/worker/resolvers/completion.ts:19-27` 用 `splitAnswer` 切分后依次填 |

几个容易踩的点：

- **绝不返回 `A`/`B` 纯字母**（除非题目本来就是纯字母选项，走 `multiple.ts:162` 的 `plainOptions` 兜底，优先级更低）。
- **绝不返回模型自己的措辞**，那会去撞 0.6 的相似度阈值。
- 判断题返回的 token 必须来自**选项自身**：`resolveJudgement` 是词表整串相等，不是语义映射。选项是 `√` 就返回 `√`，不能返回 `正确`——`正确` 匹配不上 `√`。
- 选项含 `#` 会破坏多答案切分：填空题答案里出现 `#` 或 `===` 时直接 `invalid_output` 弃权，不返回会被切错的字符串。

## 模型调用与自洽采样

- `POST {ANSWERER_BASE_URL}/chat/completions`，`temperature: 0`，`max_tokens: 32`（填空 600），不流式、无工具。
- prompt 只要求输出序号：`3` 或 `1,3`；选项以 `1) 2) 3)` 展示，**模型看不到也不需要输出 A/B/C**。
- 同一题并行打 K 次（`Promise.all`，墙钟≈一次），每次**独立打乱选项顺序**（Fisher-Yates，同时消位置偏置），模型输出映射回原始下标后取多数票。
- K 次里没有过半共识（`winner.count * 2 <= K`）→ `low_confidence`。
- 任一次解析失败/越界/数量不符 → 该次重试一次；仍失败 → `invalid_output`。
- provider 返回 logprobs 时（需 `ANSWERER_LOGPROBS=1`），首个数字 token 的 top-2 概率差作为 margin，低于 `ANSWERER_MARGIN` → `low_confidence`。多数网关不返回 logprobs，此时 margin 为 `null`，只靠自洽投票。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ANSWERER_PROVIDER` | `openai` | `openai` 或 `mock`（不联网，返回预置答案） |
| `ANSWERER_BASE_URL` | 空 | OpenAI 兼容接口，填到 `/v1` 这一层 |
| `ANSWERER_API_KEY` | 空 | 只从环境读，不落盘、不进日志 |
| `ANSWERER_MODEL` | 空 | 模型名 |
| `ANSWERER_PORT` | `8787` | 监听端口（地址固定 `127.0.0.1`，不可改） |
| `ANSWERER_K` | `3` | 自洽采样次数，1–10 |
| `ANSWERER_MARGIN` | `0.15` | 置信度阈值，仅 logprobs 可用时生效 |
| `ANSWERER_TIMEOUT_MS` | `20000` | 单次模型请求超时 |
| `ANSWERER_LOG` | `1` | `0` 关闭 JSONL 埋点 |
| `ANSWERER_LOG_FILE` | `logs/answers.jsonl` | 埋点文件 |
| `ANSWERER_LOGPROBS` | `0` | `1` 时请求 logprobs（网关不支持会 400） |

服务只读 `ANSWERER_*` 变量，宿主机上的其它 API key 不会被自动采用；要么显式写进 `.env` 的 `ANSWERER_API_KEY`，要么在启动时导出。`.env` 已在 `.gitignore` 里。

## 埋点

每题一行 JSONL，追加到 `logs/answers.jsonl`（已 gitignore）：

```json
{"ts":"2026-11-20T12:00:00.000Z","type":"single","title_len":7,"title_hash":"9f2c...","options_n":4,"provider":"openai","model":"...","letters":[3],"margin":null,"votes":{"3":3},"ms":812,"outcome":"ok","effective_type":"single"}
```

- 只记题干长度 + sha256 前 16 位，**不记题干原文**。
- 填空题的 `votes` 只记「第几个样本出现几次」，避免把答案正文写进日志。
- 写日志失败不会影响答题主流程。

## 测试与评测

```bash
node --test                 # 58 个测试：格式化、prompt、provider、service、HTTP、契约
node --test eval/format.test.mjs   # 真实用例评测（也在 node --test 里）
```

评测用 `eval/cases.json`（逐字节复制自 ocsjs 的 `tests/cases.json`），把每个用例的 `expect` 下标当作「模型的正确答案」，反向跑格式化器，再按 OCS 的 `#` 切分，断言切出来就是期望的选项原文；判断题还会用复刻的 `resolveJudgement` 验证 token 真的能选中目标选项。

- 159 个用例中 137 个可作答（22 个 `expect: []` 是「本就无解」的负例，跳过）。
- 单选/多选/判断额外跑一遍「加 `A. ` 前缀」的变体，验证前缀剥离的对称性。

## 安全

- **只绑 `127.0.0.1`**，代码里写死，没有环境变量能改成 `0.0.0.0`。
- OCS 的题库配置里 `type: "fetch"` 走的是**页面原生 fetch**（`answer.wrapper.handler.ts:75-97`），属于跨域请求。本服务返回 `Access-Control-Allow-Origin: *` 并处理 `OPTIONS` 预检，否则真实网课页面一个请求都发不出去。
- 官方用户脚本的 `@connect` 已包含 `127.0.0.1`（`scripts/build-core.js:91-99`）。如果你用的是旧版或自行编译的脚本，改用「全域名通用版」——它在 `@connect` 里追加了 `*`（`scripts/build-core.js:176-178`）。
- **题库配置里的 `handler` 等价于在页面里执行代码**（`answer.wrapper.handler.ts:168-190` 用 `new Function(handler)()`）。所以服务地址要固定、只贴你自己审查过的 `contract/answerer.json`；不要做「从远端动态拉题库配置」这类功能。
- API key 只存在服务端环境变量里，永远不进用户脚本配置、不进日志。
- 已知边界：任何网页都能向 `127.0.0.1:8787` 发跨域 POST（这是兼容任意网课域名的代价）。它只监听回环、不暴露公网；若介意被无关网页消耗 token，可在浏览器/防火墙层限制，或自行加 token 校验。
- 无鉴权、无限流：这是本机单用户工具，不要直接反代到公网。

## 已知限制

- **图片题未实现**：`images` 非空一律 `unsupported_images`，不会静默返回错误答案。
- **OCS 自带按题干精确匹配的缓存**：重复题不会打到模型，所以日志里看到的请求数会少于实际题数。
- **填空题不知道空位数量**：OCS 的请求不带 blank 数，只能让模型按题干给数组；答案里含 `#`/`===` 时弃权。
- **`unknown` 题型靠推断**：两个选项且一正一误 → 判断题；有选项 → 单选；无选项 → 填空。推断错会答错，日志里 `effective_type` 可复盘。
- **margin 通常不可用**：绝大多数 OpenAI 兼容网关不返回 logprobs，`ANSWERER_MARGIN` 实际很少生效，置信度主要靠 K 次自洽投票。
- **LLM 仍可能「自信地答错」**：自洽投票只过滤不稳定输出，过滤不了稳定的错误知识。
- 没有重试退避、没有并发上限、没有响应缓存、没有多模态、没有流式。

## 目录结构

```
ocs-answerer/
├── src/
│   ├── format.mjs      答案格式化 + OCS 词表/前缀规则（核心算法）
│   ├── prompt.mjs      提示词构建、打乱顺序、序号/填空解析
│   ├── provider.mjs    AnswerProvider：openai / mock
│   ├── service.mjs     自洽采样、多数票、重试、弃权、埋点
│   ├── server.mjs      node:http + CORS + 路由
│   ├── config.mjs      环境变量与 .env
│   └── log.mjs         JSONL 埋点
├── test/               单元 + HTTP 测试（node:test）
├── eval/               cases.json（ocsjs MIT）+ 评测
├── contract/answerer.json   OCS 侧要贴的题库配置
└── logs/               answers.jsonl（gitignore）
```

## 为什么是 `.mjs` 而不是 `.ts`

任务书允许「TypeScript + `--experimental-strip-types`」或「纯 ESM `.mjs`」二选一。本机 Node v22.22.1 **编译时未启用 TypeScript 支持**：

```
$ node --experimental-strip-types -e "1"
Error [ERR_NO_TYPESCRIPT]: Node.js is not compiled with TypeScript support
```

所以选了 `.mjs` 分支：启动是 `node src/server.mjs`，`node --test` 也不需要任何 flag。代价是没有静态类型，用 JSDoc 注解补足。

## 评测数据来源与许可

`eval/cases.json` 逐字节复制自 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs) `tests/cases.json`（commit `09628b7`，877 行），MIT License，Copyright (c) 2022 enncy。

sha256：`12feb6c638726e9238c1226f43f325b88b7af8734ea4f7768e8d6b8281665835`（`eval/format.test.mjs` 里有断言，防止 fixture 被悄悄改动）。
