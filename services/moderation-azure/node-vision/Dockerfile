FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json tsconfig.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile
COPY scripts/download-models.sh ./scripts/download-models.sh
RUN chmod +x ./scripts/download-models.sh && ./scripts/download-models.sh models
COPY src ./src
COPY test_smoke.mjs test_fixture.jpg ./
RUN corepack pnpm build
USER node
EXPOSE 8081
CMD ["node", "dist/index.js"]
