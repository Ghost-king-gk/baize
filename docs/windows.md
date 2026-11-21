# 在 Windows 上跑起来

服务是纯 Node 脚本，没有安装步骤、没有数据库、只监听本机回环地址。全程约五分钟。

## 0. 前提

- Windows 10/11
- Node.js **22 LTS**（低于 20.12 读不了 `.env`）
- 浏览器里已装 OCS 脚本（Scriptcat 或 Tampermonkey）

## 1. 装 Node

```powershell
winget install OpenJS.NodeJS.LTS
```

或从 <https://nodejs.org/> 下 LTS 安装包。装完**新开一个** PowerShell 验证：

```powershell
node -v      # 期望 v22.x
```

## 2. 拿代码

```powershell
cd $HOME\Documents
git clone https://github.com/Ghost-king-gk/baize.git
cd baize
```

没有 git 也可以直接在 GitHub 页面点 `Code → Download ZIP` 解压。

## 3. 填 key

```powershell
copy .env.example .env
notepad .env
```

把 `OPENCODE_GO_API_KEY=` 后面填上你的 key，保存。文件里默认已经设好：

```ini
ANSWERER_CHAIN=opencode-go
ANSWERER_MODEL=deepseek-v4.1-flash
```

`ANSWERER_MODEL` 换成你想用的模型即可（`glm-5.3-flash` 最快、`deepseek-v4.1-flash` 额度更大）。

> `.env` 已在 `.gitignore` 里，不会被提交。请不要把它贴到任何聊天或 issue 里。

## 4. 启动

双击 `scripts\start.bat`，或者：

```powershell
node src\server.mjs
```

看到这行就成了：

```
[baize] listening on http://127.0.0.1:8787  chain=opencode-go  model=deepseek-v4.1-flash  k=3
```

自检（另开一个窗口）：

```powershell
curl.exe -sS -X POST 127.0.0.1:8787/answer -H "Content-Type: application/json" -d "{\"title\":\"1+2=?\",\"type\":\"single\",\"options\":\"A. 1\nB. 2\nC. 3\nD. 4\"}"
```

期望 `{"ok":true,"answer":"C. 3"}`。

## 5. 接进 OCS

打开网课页面 → OCS 面板 → `⚙️ 全局设置` → `题库配置` → 选「自定义」→ 粘贴 `contract\answerer.json` 的内容 → 保存。

面板里会显示「白泽」。之后进入作业/考试页就会自动答题。

## 6. 开机自启（可选）

最省事：把 `scripts\start.bat` 的快捷方式丢进启动目录。

1. `Win + R` → 输入 `shell:startup` → 回车
2. 右键 `start.bat` → 创建快捷方式 → 把快捷方式移进打开的文件夹

想要不弹黑窗口、崩溃后自拉起，用任务计划程序：

- 触发器：登录时
- 操作：启动程序 `C:\Windows\System32\cmd.exe`，参数 `/c "C:\path\to\baize\scripts\start.bat"`
- 勾选「隐藏」和「如果任务失败，每 1 分钟重启一次」

## 7. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `EADDRINUSE` | 8787 被占用 | 改 `.env` 里的 `ANSWERER_PORT`，同时改 OCS 配置里的端口 |
| OCS 报「题库请求超时」 | 服务没起 / 端口不对 | 先在浏览器打开 `http://127.0.0.1:8787/health` 看是否返回 JSON |
| OCS 弹出跨域提示 | 用的是官方主脚本 | 用 `fetch` 模式即可（`contract/answerer.json` 默认就是），不需要 `@connect` |
| 返回 `provider_error` | key 错、额度耗尽、网络不通 | 看终端日志里的 `status=`；402/429 会自动切换下一家 |
| 答题全是「搜不到」 | 模型还没配、或题型判断失败 | 看 `logs\answers.jsonl` 的 `outcome` 字段 |
| 中文显示乱码 | 终端代码页 | `start.bat` 已做 `chcp 65001`；手动运行时先执行 `chcp 65001` |

## 8. 数据在哪

| 路径 | 内容 |
| --- | --- |
| `logs\answers.jsonl` | 每题的埋点（延迟、花费、额度、结果），**含题干长度与哈希，不含题干原文** |
| `dashboard.html` | `node tools\dashboard.mjs` 生成的看板，直接双击打开 |
| `config\go-quota.json` | Go 各模型月额度快照，`node tools\quota.mjs` 刷新 |

## 9. 卸载

删目录即可。服务不写注册表、不装服务、不改系统配置。
