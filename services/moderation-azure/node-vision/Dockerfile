FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS runner
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
