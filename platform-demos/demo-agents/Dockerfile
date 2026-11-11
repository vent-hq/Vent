FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY platform-demos/demo-agents/package.json platform-demos/demo-agents/package.json
RUN pnpm install --frozen-lockfile --filter @vent/demo-backend...
COPY platform-demos/demo-agents platform-demos/demo-agents
WORKDIR /app/platform-demos/demo-agents
ENV PORT=3001
EXPOSE 3001
CMD ["sh", "-c", "node src/seed.js && exec node src/index.js"]
