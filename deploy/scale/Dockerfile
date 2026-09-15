# Build with --build-arg NODE_IMAGE=node:20-bookworm-slim@sha256:<approved digest>.
ARG NODE_IMAGE=node:20-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
COPY scripts ./scripts
COPY config ./config
RUN npm run build && npm prune --omit=dev
FROM ${NODE_IMAGE}
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/scripts/worker-health.mjs ./scripts/worker-health.mjs
USER node
EXPOSE 3000
CMD ["node", "build/server.js"]
