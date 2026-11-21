# 零依赖镜像：只拷源码，不装包
FROM node:22-alpine

WORKDIR /app

# 运行所需的最小集合
COPY package.json ./
COPY src ./src
COPY config ./config
COPY contract ./contract
COPY tools ./tools
COPY README.md LICENSE ./

# 容器里必须监听 0.0.0.0 才能被端口映射到；
# 宿主机侧只发布 127.0.0.1，外部仍不可达。
ENV ANSWERER_HOST=0.0.0.0 \
    ANSWERER_PORT=8787 \
    ANSWERER_LOG_FILE=/data/answers.jsonl \
    NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.mjs"]
