# Multi-stage build for production
FROM node:22-alpine AS base
RUN npm install -g pnpm

# ---- deps ----
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml ./
COPY app/package.json ./app/
COPY packages/db/package.json ./packages/db/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS builder
COPY . .
RUN pnpm build

# ---- runner ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy built output
COPY --from=builder /app/app/.output ./app/.output
COPY --from=builder /app/packages/db/migrations ./packages/db/migrations

EXPOSE 3000

CMD ["node", "app/.output/server/index.mjs"]
