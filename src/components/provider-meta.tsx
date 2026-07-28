"use client";

import type { ReactNode } from "react";
import { PROVIDER_DEFS, resolveProviderKey } from "@/lib/providers";
import { ICON_COMPONENTS } from "./icons";

/** Shared provider branding — used by the Models page and the ModelPicker. */
export const PROVIDER_META: Record<
  string,
  { icon: ReactNode; bg: string; label: string }
> = Object.fromEntries(
  Object.entries(PROVIDER_DEFS).map(([key, def]) => {
    const Icon = ICON_COMPONENTS[def.iconKey] ?? ICON_COMPONENTS.fallback;
    return [key, { icon: <Icon size={16} />, bg: def.color, label: def.label }];
  })
);

/** Ink-wash inspired fallback palette for unknown providers. */
const FALLBACK_PALETTE = [
  "#2c5aa0", // indigo
  "#c45c48", // cinnabar
  "#2e7d5a", // ink green
  "#b8860b", // ochre
  "#6e4e8f", // violet
  "#5f7a7a", // teal-grey
  "#a65e5e", // rouge
  "#4a7c8c", // stone blue
];

function hashColor(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % FALLBACK_PALETTE.length;
  return FALLBACK_PALETTE[idx];
}

function providerInitials(provider: string): string {
  const parts = provider
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export function fmtCtx(n?: number) {
  if (!n) return "";
  return n >= 1_000_000 ? `${n / 1_000_000}M ctx` : `${Math.round(n / 1000)}K ctx`;
}

export function ProviderMeta({
  provider,
  size = 16,
}: {
  provider: string;
  size?: number;
}) {
  // Try the raw provider key first, then known aliases.
  const key = resolveProviderKey(provider);
  const meta = key ? PROVIDER_META[key] : PROVIDER_META[provider];
  const label = meta?.label ?? provider;
  const bg = meta?.bg ?? hashColor(provider);
  const fontSize = Math.max(10, Math.round(size * 0.55));

  return (
    <span
      title={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size + 8,
        height: size + 8,
        borderRadius: 999,
        background: bg,
        color: "#fff",
        flexShrink: 0,
        fontSize,
        fontWeight: 600,
        letterSpacing: "0.02em",
        fontFamily: "var(--font-ui)",
      }}
    >
      {meta?.icon ?? providerInitials(provider)}
    </span>
  );
}
