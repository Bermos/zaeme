# syntax=docker/dockerfile:1.7
#
# zäme ships as a Dockerfile rather than buildpacks, and the reason is a
# platform bug rather than a preference: on a Cloud Native Buildpacks image a
# declared process's `command` replaces the image ENTRYPOINT, which for a CNB
# image IS the launcher that puts the buildpack's Node on PATH. The migrate
# task therefore dies with `exec: "node": executable file not found in $PATH`,
# and the same build produces no `web` process type for the server to start
# from either. Both halves are Bermos/Kitchen#440. A Dockerfile image is
# unaffected: its ENTRYPOINT is ours, and `command` means what it says.
#
# If #440 is fixed and buildpacks becomes viable again, deleting this file and
# setting `build.strategy` back to `buildpacks` is the whole revert.
#
#   docker build -t zaeme .        # the build context is the repo root

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=1
RUN corepack enable
WORKDIR /app

# --- deps: the full install, lockfile-frozen, for the build ------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# --- prod-deps: what the migrate task needs at RUNTIME -----------------------
# The Nitro bundle carries its own dependencies, but `scripts/migrate.mjs` is
# not part of it — it is run by the deploy task as a plain script and needs
# `drizzle-orm` and `pg` present. Installing them separately keeps the runtime
# image free of the build toolchain.
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts

# --- build: the Nitro output -------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Cap V8's old space well under the platform's 4Gi build ceiling. Left alone,
# node grows the heap until the cgroup kills BuildKit (exit 137, OOMKilled)
# rather than collecting — the Nuxt/Vite build is comfortably able to finish in
# 2Gi once it is made to GC. Raise this only together with the operator raising
# `builds.resources.memory`, since the ceiling is what a build may take.
ENV NODE_OPTIONS=--max-old-space-size=2048
RUN pnpm build

# --- runtime -----------------------------------------------------------------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# The server, self-contained.
COPY --from=build /app/.output ./.output
# The deploy task: the runner, the migrations it applies, and the two packages
# it imports. Kitchen runs `node scripts/migrate.mjs` as a `task` process, so
# all three have to survive into this stage.
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/server/database/migrations ./server/database/migrations
# The DSN normaliser the task shares with the app (server/utils/dsn.mjs).
COPY --from=build /app/server/utils/dsn.mjs ./server/utils/dsn.mjs
COPY --from=prod-deps /app/node_modules ./node_modules

USER node
# Nitro honours PORT, which the platform sets in every environment ahead of the
# project's own variables; 3000 is only the fallback for a bare `docker run`.
ENV PORT=3000
EXPOSE 3000
CMD ["node", ".output/server/index.mjs"]
