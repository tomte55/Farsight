# packages/signaling-server/Dockerfile
FROM node:20-alpine
WORKDIR /app
# Copy workspace manifests for shared + server, install prod deps only.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/signaling-server/package.json packages/signaling-server/package.json
RUN npm ci --omit=dev --workspace @farsight/signaling-server --include-workspace-root
COPY packages/shared packages/shared
COPY packages/signaling-server packages/signaling-server
USER node
EXPOSE 8080
CMD ["node", "packages/signaling-server/src/server.js"]
