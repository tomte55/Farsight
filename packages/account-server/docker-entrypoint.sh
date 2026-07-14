#!/bin/sh
# Apply the Prisma schema to the (mounted) SQLite database, then start the
# server. `db push` is idempotent and needs no migration files — pragmatic for a
# single-maintainer SQLite service (graduate to `prisma migrate` if versioned
# migrations are ever wanted).
set -e
npx prisma db push --skip-generate --schema=packages/account-server/prisma/schema.prisma
exec node packages/account-server/dist/main.js
