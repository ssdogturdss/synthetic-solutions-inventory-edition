# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Synthetic Solutions – Inventory Edition  ·  API Server
# Multi-stage build: builder compiles, runner is a lean production image.
# ─────────────────────────────────────────────────────────────────────────────

# ── base: Node + pnpm ────────────────────────────────────────────────────────
FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@10.26.1 --activate

# ── builder: install all workspace deps, compile the API server ───────────────
FROM base AS builder
WORKDIR /workspace

# Copy workspace manifests first (better layer caching — invalidated only when
# package.json / lockfile changes, not when source changes).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY patches ./patches
COPY artifacts/api-server/package.json ./artifacts/api-server/package.json
COPY lib/db/package.json               ./lib/db/package.json
COPY lib/api-zod/package.json          ./lib/api-zod/package.json

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy source (after deps, so source changes don't bust the install layer)
COPY artifacts/api-server ./artifacts/api-server
COPY lib/db               ./lib/db
COPY lib/api-zod          ./lib/api-zod
COPY scripts              ./scripts

# Build: esbuild bundles everything into artifacts/api-server/dist/index.mjs
# esbuild-plugin-pino copies pino worker files alongside the bundle.
WORKDIR /workspace/artifacts/api-server
RUN pnpm run build

# ── migrate: one-shot schema push (used by docker-compose migrate service) ───
# Extends builder so drizzle-kit can read the TypeScript schema files.
FROM builder AS migrate
WORKDIR /workspace
ENTRYPOINT ["pnpm", "--filter", "@workspace/db", "run", "push-force"]

# ── seed: first-run admin bootstrap (profile-gated in docker-compose) ────────
# Extends builder so the seed script can reach bcryptjs and pg in node_modules.
FROM builder AS seed
WORKDIR /workspace
ENTRYPOINT ["node", "scripts/seed-admin.mjs"]

# ── runner: lean production image ────────────────────────────────────────────
# The esbuild bundle is fully self-contained — no node_modules needed at runtime.
FROM node:22-alpine AS runner
WORKDIR /app

# Copy only the compiled bundle (includes pino worker files output by the plugin)
COPY --from=builder /workspace/artifacts/api-server/dist ./dist

EXPOSE 8080
ENV PORT=8080
ENV NODE_ENV=production

# Run as non-root for security (node user is pre-created in node:22-alpine)
USER node

CMD ["node", "--enable-source-maps", "./dist/index.mjs"]
