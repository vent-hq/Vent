FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY demos/safetyspect-server/package.json demos/safetyspect-server/package.json
RUN pnpm install --frozen-lockfile --filter @vent/demo-backend...
COPY demos/safetyspect-server demos/safetyspect-server
WORKDIR /app/demos/safetyspect-server
ENV PORT=3001
EXPOSE 3001
CMD ["sh", "-c", "node src/seed.js && exec node src/index.js"]
