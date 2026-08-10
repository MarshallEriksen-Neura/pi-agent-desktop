"use client";

import { ShieldAlert } from "lucide-react";
import { InsetGroup } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { DangerActionRow } from "./primitives";

/** D-6 — destructive actions. Reset identity is separated from ordinary disable. */
export function DangerZoneGroup({ onReset }: { onReset: () => void }) {
  const t = useT();
  return (
    <InsetGroup
      header={t("settings.remoteControl.dangerZone")}
      footer={t("settings.remoteControl.dangerZoneFooter")}
    >
      <DangerActionRow
        first
        icon={<ShieldAlert size={15} />}
        title={t("settings.remoteControl.resetIdentity")}
        detail={t("settings.remoteControl.resetIdentityDetail")}
        onClick={onReset}
      />
    </InsetGroup>
  );
}
