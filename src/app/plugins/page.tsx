"use client";

/**
 * Plugins — one page for the whole package lifecycle.
 *
 * This used to be two nav entries. `/plugins/` listed what was installed and
 * `/store/` browsed npm for more, but they wrote the same `packages[]` array
 * through the same `pi install`, kept their own copy of the same scope selector,
 * and the store could not even render its own rows without reading the installed
 * list to decide which ones to badge. They were one feature split across two
 * screens, so they are one screen now: Installed maintains, Discover adds.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { RefreshCw, RotateCcw } from "lucide-react";
import { usePi } from "@/lib/pi/store";
import { usePiSettings } from "@/lib/pi/settings";
import { usePackageManager } from "@/lib/pi/package-manager";
import { useT } from "@/lib/i18n";
import { SettingsPage, Segmented } from "@/components/settings-ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { InstalledPanel } from "@/components/plugins/InstalledPanel";
import { DiscoverPanel } from "@/components/plugins/DiscoverPanel";
import { StatusBanner } from "@/components/plugins/StatusBanner";

type Mode = "installed" | "discover";

export default function PluginsPage() {
  const { commands, mock, refresh } = usePi();
  const settings = usePiSettings();
  const pm = usePackageManager();
  const t = useT();
  const [mode, setMode] = useState<Mode>("installed");
  const routed = useRef(false);

  useEffect(() => {
    settings.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Nothing installed yet? Open on Discover instead. An empty maintenance list
   * is not a screen anyone came here for, and the only useful thing to do from
   * it is exactly what the other half does. Decided once, after settings land,
   * so it can never yank the panel out from under someone mid-session.
   */
  useEffect(() => {
    if (routed.current || settings.global.data == null) return;
    routed.current = true;
    if (!pm.hasPackages) setMode("discover");
  }, [settings.global.data, pm.hasPackages]);

  // the banner reports a pending restart; once pi has restarted (from any entry
  // point) the "installed/removed" line is no longer telling the user anything
  useEffect(() => {
    if (!settings.dirtyRestart) pm.clearStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dirtyRestart]);

  const extCommandCount = commands.filter((c) => c.source?.startsWith("extension:")).length;

  return (
    <SettingsPage
      title={t("plugins.title")}
      subtitle={
        mock
          ? t("plugins.subtitleMock")
          : t("plugins.subtitleCount", {
              pkgs: pm.packages.length,
              cmds: extCommandCount,
            })
      }
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Segmented
            options={["installed", "discover"] as const}
            value={mode}
            onChange={setMode}
            labelOf={(option) => t(`plugins.mode.${option}`)}
          />
        </div>
        <motion.button
          whileTap={{ scale: 0.9 }}
          transition={{ type: "spring", stiffness: 500, damping: 24 }}
          onClick={() => {
            settings.load();
            refresh();
          }}
          disabled={pm.busy}
          aria-label={t("plugins.refreshDetail")}
          title={t("plugins.refreshDetail")}
          style={{
            display: "grid",
            placeItems: "center",
            width: 32,
            height: 32,
            flexShrink: 0,
            border: "1px solid var(--separator)",
            borderRadius: 9,
            background: "var(--bg-base)",
            color: "var(--text-secondary)",
            cursor: pm.busy ? "default" : "pointer",
            opacity: pm.busy ? 0.45 : 1,
          }}
        >
          <RefreshCw size={14} />
        </motion.button>
      </div>

      <StatusBanner status={pm.status} />

      {mode === "installed" ? (
        <InstalledPanel pm={pm} onBrowse={() => setMode("discover")} />
      ) : (
        <DiscoverPanel pm={pm} />
      )}

      <ConfirmDialog
        open={pm.pendingUpdate !== null}
        title={t("plugins.updateDuplicateTitle")}
        message={t("plugins.updateDuplicateConfirm")}
        detail={pm.pendingUpdate?.source}
        confirmLabel={t("plugins.updateBoth")}
        danger={false}
        icon={<RotateCcw size={22} color="var(--accent)" />}
        onConfirm={pm.confirmPendingUpdate}
        onCancel={pm.cancelPendingUpdate}
      />

      {settings.lastError && (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--danger)" }}>
          {settings.lastError}
        </p>
      )}
    </SettingsPage>
  );
}
