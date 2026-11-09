FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY demos/livekit/package.json demos/livekit/package.json
RUN pnpm install --frozen-lockfile --filter @vent/demo-livekit...
COPY demos/livekit demos/livekit
WORKDIR /app/demos/livekit
RUN DEMO_BACKEND_URL=https://vent-demo-backend.fly.dev node --import tsx agent.ts download-files
CMD ["node", "--import", "tsx", "agent.ts", "start"]
