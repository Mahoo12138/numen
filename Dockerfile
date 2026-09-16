FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@10.6.3 --activate \
  && apk add --no-cache python3 make g++

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json vitest.config.ts ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:24-alpine AS runtime

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
