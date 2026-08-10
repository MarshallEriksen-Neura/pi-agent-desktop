"use client";

import { Smartphone } from "lucide-react";
import type { PairingDeviceMetadata } from "@pi/remote-control-contracts";
import { InsetGroup, GroupRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { usePairedDevices } from "@/lib/remote-control/hooks";
import { DeviceRow } from "./primitives";

/** D-4 — paired device list with revoke (opens a confirm dialog). */
export function PairedDevicesGroup({
  onRevoke,
}: {
  onRevoke: (device: PairingDeviceMetadata) => void;
}) {
  const t = useT();
  const { devices, count } = usePairedDevices();

  return (
    <InsetGroup
      header={t("settings.remoteControl.pairedDevices")}
      footer={t("settings.remoteControl.pairedDevicesFooter")}
    >
      {count === 0 ? (
        <GroupRow
          first
          icon={<Smartphone size={15} />}
          iconBg="var(--gray-1)"
          title={t("settings.remoteControl.emptyDevices")}
          detail={t("settings.remoteControl.emptyDevicesDetail")}
        />
      ) : (
        devices.map((d, i) => (
          <DeviceRow
            key={d.deviceId}
            device={d}
            first={i === 0}
            onRevoke={() => onRevoke(d)}
          />
        ))
      )}
    </InsetGroup>
  );
}
