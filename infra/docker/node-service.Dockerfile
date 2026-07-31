# Shared Dockerfile for the Fastify services (gateway, matchmaker, realtime).
#
# Build from the repo root and pass the package name:
#   docker build -f infra/docker/node-service.Dockerfile \
#     --build-arg PACKAGE=@arena/gateway --build-arg APP_DIR=gateway .
#
# `turbo prune` is what keeps these images small and their layers cacheable: it
# emits a workspace containing only the target package and its transitive
# dependencies, so an unrelated change in apps/web does not bust the layer cache
# for the gateway image.

ARG NODE_VERSION=22.22.1

# ---- base -------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
RUN apk add --no-cache libc6-compat tini
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

# ---- pruner -----------------------------------------------------------------
FROM base AS pruner
ARG PACKAGE
WORKDIR /repo
COPY . .
RUN pnpm dlx turbo@2.10.7 prune "${PACKAGE}" --docker

# ---- installer --------------------------------------------------------------
FROM base AS installer
ARG PACKAGE
WORKDIR /repo

# Lockfile + manifests only, so dependency installation caches independently of
# source changes.
#
# No `--mount=type=cache` for the pnpm store: Railway's builder requires cache
# mount ids to be literally prefixed `s/<service id>-` and does not expand
# variables, so a shared id cannot be valid for all four services built from
# this file. Layer caching still covers the common case.
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /repo/out/full/ .
RUN pnpm turbo run build --filter="${PACKAGE}"

# Strip dev dependencies from the layer that gets copied into the runtime image.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# ---- runner -----------------------------------------------------------------
FROM base AS runner
ARG APP_DIR
WORKDIR /repo

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 arena \
 && adduser --system --uid 1001 --ingroup arena arena

COPY --from=installer --chown=arena:arena /repo/node_modules ./node_modules
COPY --from=installer --chown=arena:arena /repo/packages ./packages
COPY --from=installer --chown=arena:arena /repo/apps/${APP_DIR} ./apps/${APP_DIR}

USER arena
WORKDIR /repo/apps/${APP_DIR}

# tini reaps zombies and forwards SIGTERM, which the graceful-drain path needs.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
