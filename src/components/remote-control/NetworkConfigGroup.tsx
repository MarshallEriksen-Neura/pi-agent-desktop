"use client";

import { useEffect } from "react";
import { Wifi, RefreshCw, TriangleAlert, Power } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { InsetGroup, GroupRow, NumberRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { useRemoteControl } from "@/lib/remote-control/store";
import { useNetworkConfig } from "@/lib/remote-control/hooks";
import { PORT_MIN, PORT_MAX } from "@/lib/remote-control/constants";
import { AddressPicker } from "./primitives";

/** D-2 — bind address + port + enable action + safety footer. */
export function NetworkConfigGroup() {
  const t = useT();
  const { detected, selected, port, setPort, detecting, detect, toggle, addManual } =
    useNetworkConfig();
  const enabled = useRemoteControl((s) => s.status?.enabled ?? false);
  const enabling = useRemoteControl((s) => s.enabling);
  const enable = useRemoteControl((s) => s.enable);
  const lastError = useRemoteControl((s) => s.lastError);

  useEffect(() => {
    void detect();
  }, [detect]);

  const canEnable = !enabled && selected.length > 0 && !enabling;
  const blockedPublic =
    selected.length === 0 && !detecting && detected.length === 0;

  return (
    <InsetGroup
      header={t("settings.remoteControl.networkConfig")}
      footer={t("settings.remoteControl.networkFooter")}
    >
      <GroupRow
        first
        icon={<Wifi size={15} />}
        title={t("settings.remoteControl.privateInterface")}
        detail={
          detecting
            ? t("settings.remoteControl.detecting")
            : selected.length === 0
              ? t("settings.remoteControl.noInterface")
              : undefined
        }
        trailing={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void detect()}
            disabled={detecting}
            style={{ borderRadius: 8, padding: "2px 8px" }}
          >
            <RefreshCw size={13} className={detecting ? "pi-spin" : ""} />
          </Button>
        }
      />
      <AddressPicker
        available={detected}
        selected={selected}
        onToggle={toggle}
        onAddManual={addManual}
      />
      <NumberRow
        label={t("settings.remoteControl.port")}
        value={port}
        min={PORT_MIN}
        max={PORT_MAX}
        onCommit={(v) => {
          if (v !== undefined) setPort(v);
        }}
      />
      {!enabled && (
        <div style={{ padding: "11px 16px" }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void enable({ selectedAddresses: selected, port })}
            disabled={!canEnable}
            style={{ borderRadius: 8, width: "100%", opacity: canEnable ? 1 : 0.5 }}
          >
            <Power size={14} style={{ marginRight: 6 }} />
            {enabling
              ? t("settings.remoteControl.starting")
              : t("settings.remoteControl.enable")}
          </Button>
        </div>
      )}
      {blockedPublic && (
        <GroupRow
          icon={<TriangleAlert size={15} />}
          iconBg="var(--danger)"
          title={t("settings.remoteControl.publicBlocked")}
          detail={t("settings.remoteControl.publicBlockedDetail")}
        />
      )}
      {lastError && (
        <GroupRow
          icon={<TriangleAlert size={15} />}
          iconBg="var(--danger)"
          title={t("settings.remoteControl.recentError")}
          detail={lastError}
        />
      )}
      <style>{`@keyframes pi-spin{to{transform:rotate(360deg)}}.pi-spin{animation:pi-spin .8s linear infinite}`}</style>
    </InsetGroup>
  );
}
