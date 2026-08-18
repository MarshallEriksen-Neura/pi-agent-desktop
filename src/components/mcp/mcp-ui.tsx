"use client";

import { HAIRLINE, INK, PAPER, SEAL, SANS } from "./mcp-tokens";

/** ink-wash iOS switch — ON is seal red (朱砂). */
export function InkSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 46,
        height: 28,
        borderRadius: 99,
        border: "none",
        cursor: "pointer",
        padding: 0,
        position: "relative",
        background: checked ? SEAL.red : INK.ink100,
        transition: "background 200ms",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: checked ? 20 : 2,
          width: 24,
          height: 24,
          borderRadius: 99,
          background: PAPER.elevated,
          transition: "left 200ms",
          boxShadow: "0 1px 3px rgba(38,36,32,0.25)",
        }}
      />
    </button>
  );
}

/** pill segmented control — selected = seal-red-muted fill. */
export function PillSegmented<T extends string>({
  options,
  value,
  onChange,
  labelOf,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  labelOf?: (value: T) => string;
}) {
  return (
    <div
      style={{
        display: "flex",
        gap: 4,
        padding: 3,
        borderRadius: 99,
        border: `1px solid ${HAIRLINE}`,
        background: PAPER.sunken,
        width: "fit-content",
      }}
    >
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            style={{
              border: "none",
              borderRadius: 99,
              padding: "5px 16px",
              fontSize: 12.5,
              fontWeight: 600,
              fontFamily: SANS,
              cursor: "pointer",
              background: active ? SEAL.muted : "transparent",
              color: active ? INK.ink900 : INK.ink500,
              transition: "background 180ms, color 180ms",
            }}
          >
            {labelOf ? labelOf(option) : option}
          </button>
        );
      })}
    </div>
  );
}
