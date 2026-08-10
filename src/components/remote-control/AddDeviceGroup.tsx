"use client";

import { QrCode, ChevronRight } from "lucide-react";
import { InsetGroup, GroupRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { useRemoteControl } from "@/lib/remote-control/store";

/** Entry point that opens the pairing-QR modal. Disabled while the gateway is off. */
export function AddDeviceGroup({ onOpenQr }: { onOpenQr: () => void }) {
  const t = useT();
  const enabled = useRemoteControl((s) => s.status?.enabled ?? false);

  return (
    <InsetGroup
      header={t("settings.remoteControl.addDevice")}
      footer={
        enabled
          ? t("settings.remoteControl.addDeviceFooter")
          : t("settings.remoteControl.addDeviceDisabled")
      }
    >
      <GroupRow
        first
        icon={<QrCode size={15} />}
        iconBg={enabled ? "var(--accent)" : "var(--gray-1)"}
        title={t("settings.remoteControl.generateQr")}
        detail={t("settings.remoteControl.generateQrDetail")}
        trailing={<ChevronRight size={15} color="var(--text-tertiary)" />}
        onClick={enabled ? onOpenQr : undefined}
      />
    </InsetGroup>
  );
}
