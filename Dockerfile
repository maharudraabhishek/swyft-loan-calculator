# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS base
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /workspace

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/finance/package.json packages/finance/package.json
COPY packages/quoting/package.json packages/quoting/package.json
RUN pnpm install --frozen-lockfile --filter @swyft/api...
COPY tsconfig.base.json ./
COPY packages/contracts/src packages/contracts/src
COPY packages/finance/src packages/finance/src
COPY packages/quoting/src packages/quoting/src
COPY apps/api apps/api
# esbuild bundles the API with its workspace packages; npm dependencies stay external.
RUN pnpm --filter @swyft/api build
RUN pnpm --filter @swyft/api --prod deploy --legacy /production/api

FROM node:24.14.0-alpine3.23@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114 AS runtime
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0
WORKDIR /app
# Only runtime dependencies, the bundle and SQL migrations; owned by root, run as node.
COPY --from=build /production/api ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
# The same image runs migrations as a Cloud Run job: node dist/db-cli.js migrate
CMD ["node", "dist/server.js"]
