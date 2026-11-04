# Command Centre server: API, WebSocket hub, scheduler, agent runner, and the built PWA.

FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/email/package.json packages/email/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/brain/package.json packages/brain/
COPY packages/odoo/package.json packages/odoo/
COPY packages/sendcloud/package.json packages/sendcloud/
COPY packages/social/package.json packages/social/
COPY packages/triage/package.json packages/triage/
COPY packages/verticals/package.json packages/verticals/
COPY packages/video/package.json packages/video/
COPY packages/voice/package.json packages/voice/
RUN pnpm install --frozen-lockfile
COPY . .
# Railway passes the commit being built; it becomes the web build id (dist/version.json).
ARG RAILWAY_GIT_COMMIT_SHA
RUN pnpm --filter @cc/web build && pnpm --filter @cc/server build
RUN pnpm --filter @cc/server deploy --prod --legacy /out

FROM node:22-slim
# git: the brain's optional git mirror. ca-certificates: HTTPS for git and the Claude API.
# bsdutils: `script`, the terminal "Connect Claude" runs `claude setup-token` in.
# bzip2: unpacks the self-hosted speech models (downloaded once into /data/models/voice).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates bsdutils bzip2 \
  && rm -rf /var/lib/apt/lists/*
# Claude Code CLI, the agent driver. Pin with --build-arg CLAUDE_CODE_VERSION=x.y.z.
ARG CLAUDE_CODE_VERSION=latest
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force

WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/web/dist ./web
COPY skills ./skills

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    SKILLS_DIR=/app/skills \
    WEB_DIST_DIR=/app/web \
    HOME=/data/home
# Runs as root: Railway mounts volumes root-owned. /data holds the brain and Claude config;
# mount a volume there (Railway volume, or the named volume in docker-compose.yml).
# No VOLUME instruction: Railway rejects it.
RUN mkdir -p /data/home
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
