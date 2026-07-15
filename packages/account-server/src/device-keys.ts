// Device public-key persistence (SP2 §4.4, connect-from-console). The account-
// issued device keypair's PUBLIC half is stored here at enrollment; the private
// half never leaves the device's safeStorage. Peers verify a connector's key is
// in the owner's device set (via GET /devices) before trusting it end-to-end.

import type { PrismaClient } from '@prisma/client';

export interface DeviceKeysDeps {
  prisma: PrismaClient;
}

// Store (or replace) the calling device's public key. Scoped by deviceId — the
// HTTP layer takes deviceId from the caller's own access token, so a device can
// only ever set its own key.
export async function setDevicePublicKey(
  deps: DeviceKeysDeps,
  input: { deviceId: string; publicKey: string },
): Promise<void> {
  await deps.prisma.device.update({
    where: { id: input.deviceId },
    data: { publicKey: input.publicKey },
  });
}
