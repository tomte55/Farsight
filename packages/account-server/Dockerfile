# packages/account-server/Dockerfile
# Two-stage build. node:20-slim (Debian, glibc) rather than alpine — Prisma's
# query engine is far less fiddly on glibc+openssl than on musl. Built ON the
# server (see CLAUDE.local.md redeploy flow); the schema is applied to the
# mounted SQLite volume at container start (idempotent `prisma db push`).

# ---- build: install all deps, generate the Prisma client, compile TS ----
FROM node:20-slim AS build
WORKDIR /app
# OpenSSL BEFORE npm ci so Prisma detects it and bakes in the correct
# (debian-openssl-3.0.x) engines — otherwise it defaults to the wrong engine and
# tries to download the right one at runtime (which fails as a non-root user).
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/account-server/package.json packages/account-server/package.json
RUN npm ci --workspace @farsight/account-server --include-workspace-root
COPY packages/account-server packages/account-server
RUN npm run prisma:generate -w @farsight/account-server \
 && npm run build -w @farsight/account-server

# ---- runtime ----
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
# Reuse the built node_modules (includes the generated @prisma/client AND the
# prisma CLI, which the entrypoint needs for `db push` at startup).
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json package.json
COPY --from=build /app/packages/account-server/package.json packages/account-server/package.json
COPY --from=build /app/packages/account-server/dist packages/account-server/dist
COPY --from=build /app/packages/account-server/prisma packages/account-server/prisma
COPY packages/account-server/docker-entrypoint.sh ./docker-entrypoint.sh
# Own the app dir as node so the runtime (prisma db push, SQLite on /data) can
# write without needing root.
RUN chmod +x docker-entrypoint.sh && mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 8090
ENTRYPOINT ["./docker-entrypoint.sh"]
