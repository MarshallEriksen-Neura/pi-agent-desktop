"use client";

import { Activity, Radio, Globe, Smartphone, Folder, TriangleAlert } from "lucide-react";
import { InsetGroup, GroupRow, IOSSwitch } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { useRemoteControl } from "@/lib/remote-control/store";
import { useRemoteControlPhase, useRemoteControlToggle } from "@/lib/remote-control/hooks";
import { StatusBadge } from "./primitives";

/** D-1 — gateway overview: phase, listen address, port, device/project counts, toggle. */
export function OverviewGroup() {
  const t = useT();
  const phase = useRemoteControlPhase();
  const { enabled, enabling, toggle } = useRemoteControlToggle();
  const status = useRemoteControl((s) => s.status);
  const operationError = useRemoteControl((s) => s.lastError);

  const addresses = status?.selectedAddresses ?? [];
  const port = status?.port;
  const deviceCount = status?.pairedDevices.length ?? 0;
  const projectCount = status?.projects.length ?? 0;
  const lastError = operationError ?? status?.lastError;

  return (
    <InsetGroup header={t("settings.remoteControl.overview")}>
      <GroupRow
        first
        icon={<Radio size={15} />}
        iconBg="var(--accent)"
        title={t("settings.remoteControl.title")}
        detail={t("settings.remoteControl.overviewFooter")}
        trailing={
          <IOSSwitch checked={enabled} onChange={toggle} disabled={enabling} />
        }
      />
      <GroupRow
        icon={<Activity size={15} />}
        title={t("settings.remoteControl.status")}
        trailing={<StatusBadge phase={phase} />}
      />
      <GroupRow
        icon={<Globe size={15} />}
        title={t("settings.remoteControl.listenAddress")}
        detail={
          addresses.length > 0
            ? addresses.join(", ")
            : t("settings.remoteControl.notListening")
        }
      />
      <GroupRow
        icon={<Radio size={15} />}
        title={t("settings.remoteControl.port")}
        detail={port ? String(port) : "—"}
      />
      <GroupRow
        icon={<Smartphone size={15} />}
        title={t("settings.remoteControl.pairedDevices")}
        detail={t("settings.remoteControl.deviceCount", { n: deviceCount })}
      />
      <GroupRow
        icon={<Folder size={15} />}
        title={t("settings.remoteControl.authorizedProjects")}
        detail={t("settings.remoteControl.projectCount", { n: projectCount })}
      />
      {lastError && (
        <GroupRow
          icon={<TriangleAlert size={15} />}
          iconBg="var(--danger)"
          title={t("settings.remoteControl.recentError")}
          detail={lastError}
        />
      )}
    </InsetGroup>
  );
}
