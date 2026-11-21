# 用 Docker 跑

镜像只拷源码，不装任何依赖（服务本身零依赖），体积就是 `node:22-alpine` 的大小。

## 快速开始

```bash
cp .env.example .env          # 填 OPENCODE_GO_API_KEY
docker compose up -d --build
docker compose logs -f baize  # 看到 listening 就行
```

浏览器打开 <http://127.0.0.1:8787/> 是状态页，`/dashboard` 是看板，`/settings` 是只读配置。

停止 / 更新：

```bash
docker compose down
git pull && docker compose up -d --build
```

## 端口与网络

| 项 | 值 | 说明 |
| --- | --- | --- |
| 容器内监听 | `0.0.0.0:8787` | `ANSWERER_HOST=0.0.0.0`，否则端口映射进不去 |
| 宿主机发布 | `127.0.0.1:8787` | **只绑回环**，局域网和公网都访问不到 |
| 出网 | 默认 bridge NAT | 直连 `opencode.ai` 即可 |

### 宿主机走代理时

容器里的 `127.0.0.1` 是容器自己，不是宿主机。compose 已经加了：

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

把 `.env` 或 compose 里的这两行取消注释，端口换成你自己的：

```yaml
environment:
  HTTPS_PROXY: http://host.docker.internal:7890
  HTTP_PROXY: http://host.docker.internal:7890
  NO_PROXY: 127.0.0.1,localhost
```

Docker Desktop（Windows/macOS）原生支持 `host.docker.internal`，不用 `extra_hosts`。

## 数据

| 宿主机 | 容器 | 内容 |
| --- | --- | --- |
| `./logs` | `/data` | `answers.jsonl` 埋点 |
| `config/go-quota.json` | 同路径（镜像内） | 额度表；想更新用 `node tools/quota.mjs` 后重建镜像，或挂载覆盖 |

看板在容器里也能生成：

```bash
docker compose exec baize node tools/dashboard.mjs --out /data/dashboard.html
```

然后把 `logs/dashboard.html` 拷出来打开即可（容器内没有浏览器）。

## 安全边界

- 没有鉴权：**只发布到 127.0.0.1** 是唯一防线。想给局域网用就自己加反向代理与认证，别直接把 `ports` 改成 `8787:8787`。
- `.env` 通过 `env_file` 注入，不会进镜像（`.dockerignore` 已排除）。
- `docker compose config` 会把 key **明文**打印出来，别把它的输出贴到任何地方。

## 常见问题

| 现象 | 原因 |
| --- | --- |
| 容器起来就退出 | `.env` 里缺 key，日志会有 `缺少环境变量` |
| 宿主机 curl 不通 | 端口被别的进程占用，或 compose 没起；`docker compose ps` 看状态 |
| 请求 502/超时 | 容器出不了网，按上面配 `HTTPS_PROXY` |
| 日志权限错误 | 镜像以 `node` 用户跑，`./logs` 需要可写（`chmod 777 logs` 或 `chown 1000`） |
