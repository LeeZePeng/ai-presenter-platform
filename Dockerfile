FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY web ./web
COPY server ./server
COPY tests ./tests
COPY scripts ./scripts
RUN pnpm run build && pnpm prune --prod

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
  && npm install -g @openai/codex \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV PORT=4317 HOST=0.0.0.0 DATA_DIR=/app/data
EXPOSE 4317
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
