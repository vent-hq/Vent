FROM node:20-slim AS base
# LiveKit's native RTC library requires GLib/GIO (including on Linux ARM64).
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/runner/package.json packages/runner/package.json
COPY packages/platform-connections/package.json packages/platform-connections/package.json
COPY packages/artifacts/package.json packages/artifacts/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/worker apps/worker
COPY tsconfig.json tsconfig.json
RUN pnpm --filter @vent/worker build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app .
CMD ["node", "apps/worker/dist/index.js"]
