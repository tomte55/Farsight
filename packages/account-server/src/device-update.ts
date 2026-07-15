// Remote update directive (SP2 S2.7, vision §4.3). The owner sets a target version
// on one of their devices; the host learns it via the heartbeat response and
// converges to the official GitHub-feed release (never an arbitrary binary — the
// directive is a version STRING, so a compromised account can at most trigger a
// converge-to-latest or a no-op). Declarative + idempotent: once the host reaches
// the target it does nothing, so there's no flag to clear.

import type { PrismaClient } from '@prisma/client';

export interface DeviceUpdateDeps {
  prisma: PrismaClient;
}

// Set (or clear, when targetVersion is null) the device's target version. Scoped
// by deviceId — the HTTP layer enforces the caller owns the device.
export async function setTargetVersion(
  deps: DeviceUpdateDeps,
  input: { deviceId: string; targetVersion: string | null },
): Promise<void> {
  await deps.prisma.device.update({
    where: { id: input.deviceId },
    data: { targetVersion: input.targetVersion },
  });
}
