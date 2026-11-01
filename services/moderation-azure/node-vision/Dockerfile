FROM node:24-bullseye-slim AS runner
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json tsconfig.json pnpm-lock.yaml ./
RUN corepack enable && corepack pnpm install --frozen-lockfile
COPY src ./src
RUN corepack pnpm build
USER node
EXPOSE 8081
CMD ["node", "dist/index.js"]

