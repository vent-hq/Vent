FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libglib2.0-0 && rm -rf /var/lib/apt/lists/*
RUN corepack enable
RUN adduser --disabled-password --gecos "" --home /app --shell /sbin/nologin --uid 10001 appuser
USER appuser
WORKDIR /app
ENV DEMO_BACKEND_URL=https://vent-demo-backend.fly.dev
COPY --chown=appuser:appuser package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY --chown=appuser:appuser . .
RUN node --import tsx agent.ts download-files
CMD ["node", "--import", "tsx", "agent.ts", "start"]
