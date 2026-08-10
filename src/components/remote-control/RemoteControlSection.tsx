"use client";

import { memo, useCallback, useEffect, useState } from "react";
import type { PairingDeviceMetadata } from "@pi/remote-control-contracts";
import { useRemoteControl } from "@/lib/remote-control/store";
import { OverviewGroup } from "./OverviewGroup";
import { NetworkConfigGroup } from "./NetworkConfigGroup";
import { AddDeviceGroup } from "./AddDeviceGroup";
import { PairedDevicesGroup } from "./PairedDevicesGroup";
import { AuthorizedProjectsGroup } from "./AuthorizedProjectsGroup";
import { DangerZoneGroup } from "./DangerZoneGroup";
import { PairingQrModal } from "./PairingQrModal";
import { RevokeDeviceConfirm } from "./RevokeDeviceConfirm";
import { ResetIdentityConfirm } from "./ResetIdentityConfirm";

/**
 * Composition root for the remote-control settings surface (design §D).
 * Mounts the six inset groups in the spec's vertical order and owns the three
 * modal lifecycles:
 *
 *  - **PairingQrModal** — opened by {@link AddDeviceGroup}, closed by Esc /
 *    backdrop / auto-dismiss on `paired`.
 *  - **RevokeDeviceConfirm** — opened per-device from {@link PairedDevicesGroup};
 *    `device` doubles as the open flag (null = closed).
 *  - **ResetIdentityConfirm** — opened from {@link DangerZoneGroup}; requires
 *    typed confirmation before the destructive call fires.
 *
 * The initial `refresh()` runs on mount so the overview reflects persisted
 * gateway state even if the user scrolled straight here from another page.
 */
export const RemoteControlSection = memo(function RemoteControlSection() {
  const refresh = useRemoteControl((s) => s.refresh);
  const revokeDevice = useRemoteControl((s) => s.revokeDevice);
  const resetIdentity = useRemoteControl((s) => s.resetIdentity);

  // Modal open state — kept here so the groups stay presentational.
  const [qrOpen, setQrOpen] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<PairingDeviceMetadata | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  // Hydrate the gateway snapshot once on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRevokeConfirm = useCallback(
    async (deviceId: string) => {
      await revokeDevice(deviceId);
      setRevokeTarget(null);
    },
    [revokeDevice],
  );

  const onResetConfirm = useCallback(async () => {
    const ok = await resetIdentity();
    if (ok) setResetOpen(false);
  }, [resetIdentity]);

  return (
    <>
      <OverviewGroup />
      <NetworkConfigGroup />
      <AddDeviceGroup onOpenQr={() => setQrOpen(true)} />
      <PairedDevicesGroup onRevoke={setRevokeTarget} />
      <AuthorizedProjectsGroup />
      <DangerZoneGroup onReset={() => setResetOpen(true)} />

      <PairingQrModal open={qrOpen} onClose={() => setQrOpen(false)} />
      <RevokeDeviceConfirm
        device={revokeTarget}
        onConfirm={onRevokeConfirm}
        onCancel={() => setRevokeTarget(null)}
      />
      <ResetIdentityConfirm
        open={resetOpen}
        onConfirm={onResetConfirm}
        onClose={() => setResetOpen(false)}
      />

      {/* Shared spinner keyframes — used by the modals above. Injected here so
          the spin animation works even if NetworkConfigGroup is hidden. */}
      <style>{`@keyframes pi-spin{to{transform:rotate(360deg)}}.pi-spin{animation:pi-spin .8s linear infinite}`}</style>
    </>
  );
});
