FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.6.3 --activate \
  && apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages/automation/package.json packages/automation/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/connections/package.json packages/connections/package.json
COPY packages/console/package.json packages/console/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/credentials/package.json packages/credentials/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/http/package.json packages/http/package.json
COPY packages/i18n/package.json packages/i18n/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/integration-demo/package.json packages/integration-demo/package.json
COPY packages/integration-http/package.json packages/integration-http/package.json
COPY packages/integration-schedule/package.json packages/integration-schedule/package.json
COPY packages/resources/package.json packages/resources/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/scheduler/package.json packages/scheduler/package.json
COPY packages/triggers/package.json packages/triggers/package.json
COPY packages/webui/package.json packages/webui/package.json
COPY packages/components/package.json packages/components/package.json
COPY packages/workbench/package.json packages/workbench/package.json
COPY examples/components-plugin/package.json examples/components-plugin/package.json
RUN --mount=type=cache,id=numen-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile
COPY packages ./packages
COPY examples ./examples
RUN pnpm build

FROM node:24-alpine AS runtime

ARG NUMEN_VERSION=development
ARG NUMEN_REVISION=unknown
ARG NUMEN_SOURCE
LABEL org.opencontainers.image.title="Numen" \
  org.opencontainers.image.description="Cordis-native personal automation runtime" \
  org.opencontainers.image.version=$NUMEN_VERSION \
  org.opencontainers.image.revision=$NUMEN_REVISION \
  org.opencontainers.image.source=$NUMEN_SOURCE

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY deploy/numen.config.yml /etc/numen/numen.config.yml

RUN mkdir -p /var/lib/numen && chown node:node /var/lib/numen /etc/numen

USER node
EXPOSE 5140
VOLUME ["/var/lib/numen"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5140/api/ready').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["node", "packages/cli/dist/bin.js"]
CMD ["start", "--config", "/etc/numen/numen.config.yml", "--print-launch-url"]
