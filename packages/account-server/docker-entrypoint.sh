#!/bin/sh
# Apply the Prisma schema to the (mounted) SQLite database, then start the
# server. `db push` is idempotent and needs no migration files — pragmatic for a
# single-maintainer SQLite service (graduate to `prisma migrate` if versioned
# migrations are ever wanted).
#
# --accept-data-loss is REQUIRED here: `db push` cannot prompt in a non-interactive
# container, so any change its data-loss heuristic flags (e.g. ADDING A UNIQUE INDEX,
# which it flags even when it's safe) makes an un-flagged push ERROR under `set -e` and
# crash-loop the container — taking the whole service down (this happened on the SP3
# contacts deploy, 2026-07-16). A no-op sync never triggers the guard, so the flag is
# inert in normal operation. TRADE-OFF: a genuinely destructive schema edit (dropping a
# column/table with data) will now proceed SILENTLY. The safeguard is REVIEWING every
# `packages/account-server/prisma/schema.prisma` diff before deploy. If reviewed
# migrations are ever wanted, switch to `prisma migrate deploy` (needs a prod baseline).
set -e
npx prisma db push --skip-generate --accept-data-loss --schema=packages/account-server/prisma/schema.prisma
exec node packages/account-server/dist/main.js
