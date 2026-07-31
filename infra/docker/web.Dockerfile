# Next.js 15 web app.
#
#   docker build -f infra/docker/web.Dockerfile .
#
# Uses `output: 'standalone'` so the runtime image carries only the traced
# server bundle rather than the full node_modules tree.

ARG NODE_VERSION=22.22.1

FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache libc6-compat
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

FROM base AS pruner
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.10.7 prune @arena/web --docker

FROM base AS installer
WORKDIR /repo
COPY --from=pruner /repo/out/json/ .
# See node-service.Dockerfile: Railway rejects non-service-scoped cache mount ids.
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .

# NEXT_PUBLIC_* values are inlined at build time, so they must be present here
# rather than injected at container start.
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_GATEWAY_URL
ARG NEXT_PUBLIC_MATCHMAKER_URL
ARG NEXT_PUBLIC_SOLANA_CLUSTER
ARG NEXT_PUBLIC_SOLANA_RPC_URL
ARG NEXT_PUBLIC_ARENA_PROGRAM_ID
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm turbo run build --filter=@arena/web

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs nextjs

COPY --from=installer --chown=nextjs:nodejs /repo/apps/web/.next/standalone ./
COPY --from=installer --chown=nextjs:nodejs /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=installer --chown=nextjs:nodejs /repo/apps/web/public ./apps/web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/web/server.js"]
