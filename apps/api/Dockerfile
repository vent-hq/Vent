FROM node:20-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* .npmrc ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/voice/package.json packages/voice/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/platform-connections/package.json packages/platform-connections/package.json
COPY packages/artifacts/package.json packages/artifacts/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile
COPY packages packages
COPY apps/api apps/api
COPY tsconfig.json tsconfig.json
RUN pnpm --filter @vent/api build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app .
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
