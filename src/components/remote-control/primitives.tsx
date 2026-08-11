"use client";

import { memo } from "react";
import { motion } from "motion/react";
import {
  Smartphone,
  Tablet,
  Monitor,
  Folder,
  Trash2,
  ShieldCheck,
  TriangleAlert,
  Wifi,
} from "lucide-react";
import type {
  PairingDeviceMetadata,
  RemoteProjectSummary,
} from "@pi/remote-control-contracts";
import { GroupRow } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import type { RemoteControlPhase } from "@/lib/remote-control/types";

/* ------------------------------------------------------------------ */
/* StatusBadge — overview phase pill                                   */
/* ------------------------------------------------------------------ */

const PHASE_BADGE: Record<
  RemoteControlPhase,
  { bg: string; color: string; dot: string; pulse: boolean }
> = {
  normal: {
    bg: "color-mix(in srgb, var(--success) 16%, transparent)",
    color: "var(--success)",
    dot: "var(--success)",
    pulse: false,
  },
  starting: {
    bg: "var(--accent-muted)",
    color: "var(--accent)",
    dot: "var(--accent)",
    pulse: true,
  },
  degraded: {
    bg: "color-mix(in srgb, #e8a33d 18%, transparent)",
    color: "#e8a33d",
    dot: "#e8a33d",
    pulse: false,
  },
  fault: {
    bg: "color-mix(in srgb, var(--danger) 16%, transparent)",
    color: "var(--danger)",
    dot: "var(--danger)",
    pulse: false,
  },
  disabled: {
    bg: "var(--bg-sunken)",
    color: "var(--text-tertiary)",
    dot: "var(--text-tertiary)",
    pulse: false,
  },
};

export const StatusBadge = memo(function StatusBadge({
  phase,
}: {
  phase: RemoteControlPhase;
}) {
  const t = useT();
  const s = PHASE_BADGE[phase];
  return (
    <span
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        flex: "0 0 auto",
        minHeight: 24,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: "16px",
        whiteSpace: "nowrap",
        padding: "3px 9px 3px 8px",
        borderRadius: 999,
        border: `1px solid color-mix(in srgb, ${s.color} 18%, transparent)`,
        background: s.bg,
        color: s.color,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          flex: "0 0 7px",
          borderRadius: "50%",
          background: s.dot,
          animation: s.pulse ? "pi-rc-pulse 1.2s infinite" : undefined,
        }}
      />
      {t(`settings.remoteControl.phase.${phase}`)}
      <style>{`@keyframes pi-rc-pulse{0%,100%{opacity:1}50%{opacity:.35}}`}</style>
    </span>
  );
});

/* ------------------------------------------------------------------ */
/* DeviceRow — paired device entry with revoke                         */
/* ------------------------------------------------------------------ */

function platformIcon(platform: PairingDeviceMetadata["platform"]) {
  if (platform === "ios" || platform === "android") return Smartphone;
  if (platform === "desktop") return Monitor;
  return Tablet;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export const DeviceRow = memo(function DeviceRow({
  device,
  first = false,
  onRevoke,
}: {
  device: PairingDeviceMetadata;
  first?: boolean;
  onRevoke: (deviceId: string) => void;
}) {
  const t = useT();
  const Icon = platformIcon(device.platform);
  return (
    <GroupRow
      first={first}
      icon={<Icon size={15} />}
      iconBg="var(--accent)"
      title={device.displayName}
      detail={`${t(`settings.remoteControl.platform.${device.platform}`)} · ${shortId(device.deviceId)}`}
      trailing={
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label={t("settings.remoteControl.deviceRevoke")}
          onClick={() => onRevoke(device.deviceId)}
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            border: "none",
            borderRadius: 7,
            background: "transparent",
            color: "var(--danger)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Trash2 size={14} />
        </motion.button>
      }
    />
  );
});

/* ------------------------------------------------------------------ */
/* ProjectRow — authorized project entry with remove                   */
/* ------------------------------------------------------------------ */

export const ProjectRow = memo(function ProjectRow({
  project,
  first = false,
  onRemove,
}: {
  project: RemoteProjectSummary;
  first?: boolean;
  onRemove: (projectId: string) => void;
}) {
  const t = useT();
  return (
    <GroupRow
      first={first}
      icon={<Folder size={15} />}
      iconBg="var(--gray-1)"
      title={project.name}
      detail={shortId(project.projectId)}
      trailing={
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label={t("settings.remoteControl.projectRemove")}
          onClick={() => onRemove(project.projectId)}
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            border: "none",
            borderRadius: 7,
            background: "transparent",
            color: "var(--danger)",
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          <Trash2 size={14} />
        </motion.button>
      }
    />
  );
});

/* ------------------------------------------------------------------ */
/* AddressPicker — multi-select private LAN addresses                  */
/* ------------------------------------------------------------------ */

export const AddressPicker = memo(function AddressPicker({
  available,
  selected,
  onToggle,
  onAddManual,
}: {
  available: string[];
  selected: string[];
  onToggle: (addr: string) => void;
  onAddManual: (addr: string) => void;
}) {
  const t = useT();
  const all = Array.from(new Set([...available, ...selected]));
  return (
    <div style={{ padding: "8px 16px 11px" }}>
      {all.map((addr) => {
        const on = selected.includes(addr);
        return (
          <label
            key={addr}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 0",
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <input
              type="checkbox"
              checked={on}
              onChange={() => onToggle(addr)}
              style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
            />
            <span
              style={{
                flex: 1,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12.5,
                color: "var(--text-primary)",
              }}
            >
              {addr}
            </span>
            <Wifi size={13} color="var(--text-tertiary)" />
          </label>
        );
      })}
      <ManualAddressInput onSubmit={onAddManual} placeholder={t("settings.remoteControl.addAddressPlaceholder")} />
    </div>
  );
});

function ManualAddressInput({
  onSubmit,
  placeholder,
}: {
  onSubmit: (addr: string) => void;
  placeholder: string;
}) {
  return (
    <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
      <input
        type="text"
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const v = (e.target as HTMLInputElement).value.trim();
            if (v) {
              onSubmit(v);
              (e.target as HTMLInputElement).value = "";
            }
          }
        }}
        style={{
          flex: 1,
          padding: "6px 10px",
          fontSize: 12.5,
          fontFamily: "var(--font-mono, monospace)",
          color: "var(--text-primary)",
          background: "var(--bg-sunken)",
          border: "1px solid var(--separator)",
          borderRadius: 8,
          outline: "none",
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* DangerActionRow — red-tinted destructive action entry               */
/* ------------------------------------------------------------------ */

export const DangerActionRow = memo(function DangerActionRow({
  title,
  detail,
  icon,
  onClick,
  first = false,
}: {
  title: string;
  detail?: string;
  icon?: React.ReactNode;
  onClick: () => void;
  first?: boolean;
}) {
  return (
    <GroupRow
      first={first}
      icon={icon ?? <ShieldCheck size={15} />}
      iconBg="var(--danger)"
      title={title}
      detail={detail}
      onClick={onClick}
    />
  );
});

export { TriangleAlert };
