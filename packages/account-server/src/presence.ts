// S2.5 — presence (vision §4.2), Option D: heartbeat-based, account-server-only
// (see specs/2026-07-14-sp2-presence-design.md). A running device refreshes its
// own lastSeenAt + appVersion; the owner lists the fleet with a computed online
// flag. The signaling server is untouched. Every read is scoped to the owner, so
// no other account — and not the signaling registry — ever leaks.

import type { PrismaClient } from '@prisma/client';

export interface PresenceDeps {
  prisma: PrismaClient;
  now: number; // epoch ms
}

// A device is "online" if it checked in within this window. Tune against the
// client heartbeat interval (heartbeat should be comfortably shorter than this).
export const DEFAULT_ONLINE_WINDOW_MS = 90_000;

// A device reports its own liveness (and, optionally, its current app version).
// Reachable only by an authenticated live device, so no ownership check here.
export async function heartbeat(
  deps: PresenceDeps,
  input: { deviceId: string; version?: string; signalingId?: string },
): Promise<void> {
  await deps.prisma.device.update({
    where: { id: input.deviceId },
    data: {
      lastSeenAt: new Date(deps.now),
      ...(input.version ? { appVersion: input.version } : {}),
      // Connect-from-console rendezvous: refresh where this device can be dialed.
      ...(input.signalingId ? { signalingId: input.signalingId } : {}),
    },
  });
}

export interface DevicePresence {
  id: string;
  name: string;
  appVersion: string | null;
  lastSeenAt: Date | null;
  online: boolean;
  // Connect-from-console: where to dial this device now, and the key to verify it.
  // Both null until the device enrolls a key / reports a signaling id (owner-only).
  signalingId: string | null;
  publicKey: string | null;
}

// The owner's fleet: non-revoked devices under their account, each with a
// computed online flag. Scoped to userId — the anti-leak rule.
export async function listFleet(
  deps: PresenceDeps,
  input: { userId: string; onlineWindowMs?: number },
): Promise<DevicePresence[]> {
  const windowMs = input.onlineWindowMs ?? DEFAULT_ONLINE_WINDOW_MS;
  const devices = await deps.prisma.device.findMany({
    where: { userId: input.userId, revokedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    appVersion: d.appVersion,
    lastSeenAt: d.lastSeenAt,
    online: d.lastSeenAt !== null && deps.now - d.lastSeenAt.getTime() <= windowMs,
    signalingId: d.signalingId,
    publicKey: d.publicKey,
  }));
}
