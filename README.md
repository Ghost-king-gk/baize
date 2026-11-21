兼容 ocsjs 5.4.2 @ 09628b7

# baize · 白泽

> 《山海经》里的白泽「知万物之情」，能言人语。这个服务做的是同一件事：听懂题目，给出人话的答案。

OCS（网课助手）的 **AI 题库兼容层**。它自己不做题库，只做三件事：

1. 接住 OCS 发来的 `POST /answer`（题干 + 题型 + 选项）；
2. 按 `ANSWERER_CHAIN` 依次问 OpenAI / Anthropic / Google（或任意 OpenAI 兼容网关）的 LLM，只让它输出选项序号；
3. 把序号翻译回 **OCS 匹配器认得的答案字符串**（选项原文 / `#` 分隔 / 判断题词表 token）。

零运行时依赖，只用 Node 内置模块（`node:http`、`node:test`、全局 `fetch`），没有 `npm install` 步骤。

## 一分钟启动

```bash
cd baize

# 1) 真实模型：复制配置并填 base url / key / model
cp .env.example .env
node src/server.mjs

# 2) 只想先看它跑起来（mock provider，不联网，固定回答第 3 个选项）
ANSWERER_PROVIDER=mock ANSWERER_MOCK_LETTERS=3 node src/server.mjs
```

看到这一行就成功了：

```
[baize] listening on http://127.0.0.1:8787  chain=openai  model=...  k=3
```

冒烟测试：

```bash
curl -s -X POST 127.0.0.1:8787/answer \
  -H 'Content-Type: application/json' \
  -d '{"title":"1+2=?","type":"single","options":"A. 1\nB. 2\nC. 3\nD. 4"}'
# {"ok":true,"answer":"C. 3"}
```

## 多 provider 与故障转移

供应商是**数据**：预设表在 [`config/providers.json`](config/providers.json)，本地覆盖放 `config/providers.local.json`（已 gitignore）。四种线格式（openai / anthropic / gemini / responses）都按官方 API 手写：

| id | 协议 | baseUrl | 密钥环境变量 | 需填 model |
| --- | --- | --- | --- | --- |
| `openai` | openai | `https://api.openai.com/v1` | `OPENAI_API_KEY` | 是 |
| `anthropic` | anthropic | `https://api.anthropic.com/v1` | `ANTHROPIC_API_KEY` | 是 |
| `google` | gemini | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` | 是 |
| `deepseek` | openai | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` | 是 |
| `glm` | openai | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPU_API_KEY` | 是 |
| `kimi` | openai | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` | 是 |
| `minimax` | openai | `https://api.minimax.chat/v1` | `MINIMAX_API_KEY` | 是 |
| `openrouter` | openai | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | 是 |
| `opencode-go` | openai | 空，必须自己填 | `OPENCODE_GO_API_KEY` | 是 |
| `ollama` | openai | `http://127.0.0.1:11434/v1` | 无（null） | 是 |
| `lmstudio` | openai | `http://127.0.0.1:1234/v1` | 无（null） | 是 |

预设表**绝不写模型 ID**：模型只能来自全局 `ANSWERER_MODEL`，或在 `providers.local.json` 里按 provider 覆盖（不同家的模型名通常不同）。

`ANSWERER_CHAIN` 是逗号分隔的 provider id，按顺序尝试；未设置时退回 `ANSWERER_PROVIDER`（兼容旧的单 provider 配置）：

```bash
# 各家的模型名不同：在 config/providers.local.json 里按 provider 写 model
ANSWERER_CHAIN=openai,deepseek node src/server.mjs
```

故障转移语义：

| 情况 | 行为 |
| --- | --- |
| 网络错误、超时、HTTP 408 / 429 / 5xx、响应不是 JSON | 记一次失败，换下一家 |
| HTTP 400 / 401 / 403 / 404 及其余 4xx | **立即抛出**，不继续烧别家额度 |
| HTTP 2xx 但内容截断 / 空输出 / 序号非法 | 不切下一家（供应商已经应答），按 `invalid_output` 重试一次 |
| 单 provider 连续失败 3 次 | 进程内熔断 60 秒，期间直接跳过；冷却后自动放行 |

切换日志只打印 provider id + 状态码，不打印 key / 请求体：

```
[baize] provider=openai status=429 -> fallback=deepseek
[baize] provider=deepseek status=network -> fallback=mock
[baize] provider=openai circuit=open
```

`/health` 返回当前链：`{"ok":true,"service":"baize","compat":"...","provider":"openai","chain":["openai","deepseek"],"model":"..."}`。

### 自定义 provider

在 `config/providers.local.json` 里写 JSON 对象，按 id **浅合并**到预设表（用户值优先），可以直接改写预设，也可以追加新网关：

```json
{
	"openai": {
		"baseUrl": "https://my-proxy.example.com/v1",
		"keyEnv": "MY_PROXY_KEY",
		"model": "gpt-4.1-mini"
	},
	"my-gateway": {
		"label": "我的网关",
		"protocol": "openai",
		"baseUrl": "https://gateway.example.com/v1",
		"keyEnv": "MY_GATEWAY_API_KEY",
		"model": "some-model"
	}
}
```

然后把 `my-gateway` 加进 `ANSWERER_CHAIN`。常规供应商的 `protocol` 只能是 `openai` / `anthropic` / `gemini`（OAuth 两种见下）；`keyEnv: null` 表示本地服务无需鉴权；`baseUrl` 留空会在启动时报错，而不是悄悄请求错误地址。

### 订阅 OAuth（实验性，默认关闭）

预设表里**没有** OAuth 供应商，只有你显式写进 `config/providers.local.json` 才会启用。它们直接读取已经登录的 Claude Code / Codex 凭据，用订阅额度调 API，不需要 API key。

#### Claude Code（Anthropic Messages API）

```json
{
	"claude-oauth": {
		"label": "Claude 订阅（Claude Code）",
		"protocol": "anthropic-oauth",
		"auth": "oauth",
		"baseUrl": "https://api.anthropic.com/v1",
		"keyEnv": null,
		"model": "<你的 Claude 订阅模型 id>",
		"impersonate": false
	}
}
```

- 请求头：`Authorization: Bearer <token>`（**不再发** `x-api-key`）、`anthropic-version: 2023-06-01`、`anthropic-beta: claude-code-20250219,oauth-2025-04-20`。两个 beta 标记都发，顺序固定。
- 凭据优先级：环境变量 `ANTHROPIC_OAUTH_TOKEN` → `~/.claude/.credentials.json` 的 `claudeAiOauth.accessToken`。
- `claudeAiOauth.expiresAt` 是毫秒时间戳；已过期会在启动时直接报错，并提示重新运行 `claude setup-token`，不会带着死 token 去换 401。
- `impersonate` 默认 `false`。设为 `true` 时额外发送 `x-app: cli` 和 Claude Code 风格的 `User-Agent`（默认 `claude-cli/1.0.0 (external, cli)`），并在 prompt 最前面注入一行 `You are Claude Code, Anthropic's official CLI for Claude.`，后接两个换行再接原 prompt。也可以把 `impersonate` 直接写成自定义 User-Agent 字符串，例如 `"impersonate": "claude-cli/2.0.0 (external, cli)"`。

#### Codex（OpenAI Responses API）

```json
{
	"codex-oauth": {
		"label": "ChatGPT 订阅（Codex）",
		"protocol": "openai-oauth",
		"auth": "codex-oauth",
		"baseUrl": "https://chatgpt.com/backend-api/codex",
		"keyEnv": null,
		"model": "<你的 Codex 模型 id>"
	}
}
```

- 端点固定 `POST {baseUrl}/responses`，走 Responses API，**不是** `chat/completions`。
- 请求头：`Authorization: Bearer <token>`、`chatgpt-account-id: <account_id>`、`originator: codex_cli_rs`。
- 请求体：`input: [{ role: "user", content: [{ type: "input_text", text: "<prompt>" }] }]`，配 `max_output_tokens` 与 `temperature: 0`。
- 响应解析：优先收集 `output[].content[]` 里 `type === "output_text"` 的 `text`；为空时回退便捷字段 `output_text`。`status === "incomplete"` 或 `incomplete_details.reason === "max_output_tokens"` 一律按截断处理（`invalid_output`），不会把半截答案交给 OCS。
- 凭据优先级：`OPENAI_OAUTH_TOKEN`（可选 `OPENAI_ACCOUNT_ID`）→ `~/.codex/auth.json` 的 `tokens.access_token` / `tokens.account_id`。文件里没有 account_id 时，从 JWT 的 `https://api.openai.com/auth.chatgpt_account_id` 解。
- JWT 解析只做 base64url decode，**不校验签名**（baize 不是签发方）。结构不对或 payload 不是 JSON 时会报出具体原因；如果用的是不透明 token，请显式设置 `OPENAI_ACCOUNT_ID`。

#### 凭据错误与日志

凭据读取会把「文件不存在」「无权限」「JSON 损坏」「字段缺失」「token 已过期」分开报错，并给出对应的登录命令提示。OAuth token 只存在于内存中的 provider 配置里，不写盘、不进日志；故障转移日志仍然只打印 provider id 与状态码，不打印 token、请求头或请求体。

**风险自负**：这类 token 属于订阅客户端（Claude Code / Codex），拿它驱动第三方服务可能违反供应商条款，也可能随时被吊销或改协议。baize 不代管账号、不刷新 token，出问题请自己承担。

**Gemini 没有等价路径**：Google 公开的 SDK 只有 API key 与 Vertex AI 两条路；Gemini CLI 的 OAuth 走的是 Code Assist 内部端点，不是可复用的公开接口面，所以本服务不实现 Gemini 订阅。

> **未在真实订阅上验证过**：以上实现按 cc-switch 的请求形态编写，并用离线假 token 验证了请求头、请求体与 JWT 解析；手头没有可用的 Claude / ChatGPT 订阅账号，真实网络行为未验证。

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

`GET /health` 用于探活：`{"ok":true,"service":"baize","compat":"ocsjs 5.4.2 @ 09628b7","provider":"...","chain":["..."],"model":"..."}`。`provider` 是链上第一家，不泄露任何密钥。

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

- 每家 provider 按自己的官方线格式发请求：OpenAI `POST {baseUrl}/chat/completions`、Anthropic `POST {baseUrl}/messages`、Gemini `POST {baseUrl}/models/{model}:generateContent`、Responses `POST {baseUrl}/responses`；统一 `temperature: 0`，`max_tokens` / `max_output_tokens` 为 32（填空 600），不流式、无工具。
- prompt 只要求输出序号：`3` 或 `1,3`；选项以 `1) 2) 3)` 展示，**模型看不到也不需要输出 A/B/C**。
- 同一题并行打 K 次（`Promise.all`，墙钟≈一次），每次**独立打乱选项顺序**（Fisher-Yates，同时消位置偏置），模型输出映射回原始下标后取多数票。
- K 次里没有过半共识（`winner.count * 2 <= K`）→ `low_confidence`。
- 任一次解析失败/越界/数量不符 → 该次重试一次；仍失败 → `invalid_output`。
- provider 返回 logprobs 时（需 `ANSWERER_LOGPROBS=1`），首个数字 token 的 top-2 概率差作为 margin，低于 `ANSWERER_MARGIN` → `low_confidence`。多数网关不返回 logprobs，此时 margin 为 `null`，只靠自洽投票。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ANSWERER_CHAIN` | 空 | 故障转移链，逗号分隔的 provider id（如 `openai,deepseek,ollama`）；优先于 `ANSWERER_PROVIDER` |
| `ANSWERER_PROVIDER` | `openai` | 单 provider 兼容写法；`mock` 不联网，返回预置答案 |
| `ANSWERER_PROVIDERS_FILE` | `config/providers.json` | 供应商预设表路径；同目录的 `providers.local.json` 会自动合并 |
| `ANSWERER_MODEL` | 空 | 全局模型名；provider 条目里的 `model` 优先 |
| `ANSWERER_BASE_URL` | 空 | 旧配置：只覆盖链上第一家的 baseUrl |
| `ANSWERER_API_KEY` | 空 | 旧配置：只覆盖链上第一家的 key；其余 provider 用各自的 `keyEnv` |
| `ANSWERER_PORT` | `8787` | 监听端口（地址固定 `127.0.0.1`，不可改） |
| `ANSWERER_K` | `3` | 自洽采样次数，1–10 |
| `ANSWERER_MARGIN` | `0.15` | 置信度阈值，仅 logprobs 可用时生效 |
| `ANSWERER_TIMEOUT_MS` | `20000` | 单次模型请求超时 |
| `ANSWERER_LOG` | `1` | `0` 关闭 JSONL 埋点 |
| `ANSWERER_LOG_FILE` | `logs/answers.jsonl` | 埋点文件 |
| `ANSWERER_LOGPROBS` | `0` | `1` 时请求 logprobs（只对 openai 协议生效；网关不支持会 400） |
| `ANTHROPIC_OAUTH_TOKEN` | 空 | Claude Code 订阅 token；设置后优先于 `~/.claude/.credentials.json` |
| `OPENAI_OAUTH_TOKEN` | 空 | Codex 订阅 token；设置后优先于 `~/.codex/auth.json` |
| `OPENAI_ACCOUNT_ID` | 空 | Codex 的 `chatgpt-account-id`；设置后覆盖凭据文件 / JWT 里的值 |

服务只读 `ANSWERER_*` 变量、预设表里 `keyEnv` 指定的变量，以及 OAuth 模式下的 `ANTHROPIC_OAUTH_TOKEN` / `OPENAI_OAUTH_TOKEN` / `OPENAI_ACCOUNT_ID`；宿主机上的其它 API key 不会被自动采用。`.env` 与 `config/providers.local.json` 都已在 `.gitignore` 里。

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
node --test                 # 86 个测试：格式化、prompt、protocols、router、config、provider、service、HTTP、契约
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
- **margin 通常不可用**：绝大多数供应商不返回 logprobs（Anthropic / Gemini 明确没有），`ANSWERER_MARGIN` 实际很少生效，置信度主要靠 K 次自洽投票。
- **LLM 仍可能「自信地答错」**：自洽投票只过滤不稳定输出，过滤不了稳定的错误知识。
- **故障转移不覆盖模型输出错误**：HTTP 2xx 但答案格式错只会重试一次，不会换供应商（避免把内容问题误判为供应商故障）。
- 没有指数退避、没有并发上限、没有响应缓存、没有多模态、没有流式。

## 目录结构

```
baize/
├── config/
│   └── providers.json  供应商预设表（数据，不含模型 ID）
├── src/
│   ├── format.mjs      答案格式化 + OCS 词表/前缀规则（核心算法）
│   ├── prompt.mjs      提示词构建、打乱顺序、序号/填空解析
│   ├── providers.mjs   预设表校验、providers.local.json 合并、key 解析
│   ├── oauth.mjs       订阅 OAuth 凭据读取、JWT payload 解析、Claude Code 指纹常量
│   ├── protocols/      openai / anthropic / gemini / responses 四种线格式 + 共用 HTTP
│   ├── router.mjs      故障转移链、可重试错误分类、进程内熔断
│   ├── provider.mjs    AnswerProvider：openai（单家兼容） / mock
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

## 为什么不引官方 SDK

- 三个 SDK（`openai` / `@anthropic-ai/sdk` / `@google/genai`）会拖进大量传递依赖，`npm install` 一装就违背「零依赖、复制即跑」，也没法 `bun build --compile` 成单文件。
- 本服务只需要「一次非流式 JSON 请求 + 取一段文本」，三家的线格式已经收敛在 `src/protocols/*.mjs` 的 `buildRequest` / `parseResponse` 两个纯函数里；新增协议只要实现同名接口，路由与业务层不用动。
- 官方 SDK 的流式、工具调用、自动重试等能力一个都用不上；故障转移需要看得见的错误分类（状态码 / 是否可重试），手写 fetch 反而更可控。

## 评测数据来源与许可

`eval/cases.json` 逐字节复制自 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs) `tests/cases.json`（commit `09628b7`，877 行），MIT License，Copyright (c) 2022 enncy。

sha256：`12feb6c638726e9238c1226f43f325b88b7af8734ea4f7768e8d6b8281665835`（`eval/format.test.mjs` 里有断言，防止 fixture 被悄悄改动）。
