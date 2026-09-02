"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { Switch } from "@appica/ui-react/switch";
import { ToggleGroup } from "@appica/ui-react/toggle-group";
import { Toggle } from "@appica/ui-react/toggle";
import { Plus, X } from "lucide-react";
import { WindowControls } from "./WindowControls";

/** iOS Settings-style page scaffold: centered column, large title. */
export function SettingsPage({
  title,
  subtitle,
  children,
  maxWidth = 640,
  scrollRef,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: number | string;
  /** optional ref to the scroll container (for "scroll to top" affordances) */
  scrollRef?: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={scrollRef}
      style={{
        height: "100%",
        overflowY: "auto",
        background: "var(--bg-elevated)",
      }}
    >
      <div
        data-tauri-drag-region
        style={{
          height: 44,
          position: "sticky",
          top: 0,
          zIndex: 5,
          display: "flex",
          justifyContent: "flex-end",
          padding: "0 12px",
        }}
      >
        <WindowControls />
      </div>
      <div style={{ maxWidth, margin: "0 auto", padding: "0 24px 64px" }}>
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: "spring", stiffness: 300, damping: 28 }}
          style={{
            fontSize: 32,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            color: "var(--text-primary)",
            margin: "8px 0 4px",
          }}
        >
          {title}
        </motion.h1>
        {subtitle && (
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              margin: "0 0 20px",
            }}
          >
            {subtitle}
          </p>
        )}
        {children}
      </div>
    </div>
  );
}

/** iOS inset grouped list. */
export function InsetGroup({
  header,
  footer,
  action,
  children,
}: {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  /** trailing control on the header line — for a bulk action that owns the group */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 22 }}>
      {(header || action) && (
        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 10,
            padding: "0 16px 7px",
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-tertiary)",
            }}
          >
            {header}
          </div>
          {action}
        </div>
      )}
      <div
        style={{
          background: "var(--bg-base)",
          borderRadius: "var(--radius-lg)",
          border: "1px solid var(--separator)",
          overflow: "hidden",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        {children}
      </div>
      {footer && (
        <div
          style={{
            fontSize: 12,
            color: "var(--text-tertiary)",
            padding: "7px 16px 0",
            lineHeight: 1.5,
          }}
        >
          {footer}
        </div>
      )}
    </section>
  );
}

/** A row inside an InsetGroup — hairline separators between siblings. */
export function GroupRow({
  icon,
  iconBg,
  title,
  detail,
  trailing,
  onClick,
  first = false,
}: {
  icon?: React.ReactNode;
  iconBg?: string;
  title: React.ReactNode;
  detail?: React.ReactNode;
  trailing?: React.ReactNode;
  onClick?: () => void;
  first?: boolean;
}) {
  const Comp = onClick ? motion.button : motion.div;
  return (
    <Comp
      onClick={onClick}
      whileTap={onClick ? { scale: 0.99 } : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "100%",
        padding: "11px 16px",
        border: "none",
        borderTop: first ? "none" : "1px solid var(--separator)",
        background: "transparent",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
        fontFamily: "var(--font-ui)",
      }}
      className={onClick ? "pi-row" : undefined}
    >
      {icon && (
        <span
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 8,
            fontSize: 15,
            flexShrink: 0,
            color: "#fff",
            background: iconBg ?? "var(--accent)",
          }}
        >
          {icon}
        </span>
      )}
      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: "block",
            fontSize: 14,
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {detail && (
          <span
            style={{
              display: "block",
              fontSize: 12,
              color: "var(--text-tertiary)",
              marginTop: 1,
            }}
          >
            {detail}
          </span>
        )}
      </span>
      {trailing}
    </Comp>
  );
}

/** iOS toggle switch — Appica Switch, tinted with our success green. */
export function IOSSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={onChange}
      size="md"
      className="data-checked:bg-(--success)"
      disabled={disabled}
    />
  );
}

/** Round color swatch strip: "default" slot + presets + custom color picker. */
export function ColorSwatches({
  value,
  onChange,
  presets,
  defaultLabel,
  customLabel,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  presets: readonly string[];
  defaultLabel: string;
  customLabel: string;
}) {
  const SIZE = 26;
  const isPreset = (c: string) =>
    value !== null && value.toLowerCase() === c.toLowerCase();
  const isCustom =
    value !== null && !presets.some((p) => p.toLowerCase() === value.toLowerCase());

  const circle = (selected: boolean): React.CSSProperties => ({
    width: SIZE,
    height: SIZE,
    borderRadius: "50%",
    border: "none",
    padding: 0,
    cursor: "pointer",
    flexShrink: 0,
    boxShadow: selected
      ? "0 0 0 2px var(--bg-base), 0 0 0 4px var(--accent)"
      : "inset 0 0 0 1px var(--separator)",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      {/* default — crossed-out swatch, clears the override */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        aria-label={defaultLabel}
        title={defaultLabel}
        onClick={() => onChange(null)}
        style={{
          ...circle(value === null),
          background:
            "linear-gradient(135deg, transparent 44%, var(--danger) 46%, var(--danger) 54%, transparent 56%), var(--bg-elevated)",
        }}
      />
      {presets.map((c) => (
        <motion.button
          key={c}
          whileTap={{ scale: 0.9 }}
          aria-label={c}
          title={c}
          onClick={() => onChange(c)}
          style={{ ...circle(isPreset(c)), background: c }}
        />
      ))}
      {/* custom — native color picker behind a rainbow swatch */}
      <label
        aria-label={customLabel}
        title={customLabel}
        style={{
          ...circle(isCustom),
          position: "relative",
          display: "block",
          background: isCustom
            ? (value as string)
            : "conic-gradient(#ff3b30, #ff9500, #ffcc00, #34c759, #30b0c7, #007aff, #af52de, #ff3b30)",
        }}
      >
        <input
          type="color"
          value={value ?? "#808080"}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0,
            cursor: "pointer",
          }}
        />
      </label>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text-primary)",
  background: "var(--bg-sunken)",
  border: "1px solid var(--separator)",
  borderRadius: 8,
  outline: "none",
};

/**
 * Single-line text setting row. Commits on blur/Enter; committing an empty
 * string calls onCommit(undefined) so the key is removed (pi default applies).
 */
export function TextRow({
  label,
  detail,
  value,
  placeholder,
  onCommit,
  first = false,
  dimmed = false,
}: {
  label: string;
  detail?: string;
  value: string | undefined;
  placeholder?: string;
  onCommit: (v: string | undefined) => void;
  first?: boolean;
  dimmed?: boolean;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  const commit = () => {
    const v = draft.trim();
    if (v === (value ?? "")) return;
    onCommit(v === "" ? undefined : v);
  };

  return (
    <div
      style={{
        padding: "11px 16px",
        borderTop: first ? "none" : "1px solid var(--separator)",
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <div style={{ fontSize: 13.5, color: "var(--text-primary)" }}>{label}</div>
      {detail && (
        <div style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "1px 0 0" }}>
          {detail}
        </div>
      )}
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(value ?? "");
        }}
        style={{ ...inputStyle, marginTop: 7 }}
      />
    </div>
  );
}

/**
 * Numeric setting row — TextRow semantics with validation. Empty commits
 * undefined (key removed); invalid or out-of-range input reverts.
 */
export function NumberRow({
  label,
  detail,
  value,
  placeholder,
  min,
  max,
  onCommit,
  first = false,
  dimmed = false,
}: {
  label: string;
  detail?: string;
  value: number | undefined;
  /** shown when unset — usually pi's built-in default */
  placeholder?: string;
  min?: number;
  max?: number;
  onCommit: (v: number | undefined) => void;
  first?: boolean;
  dimmed?: boolean;
}) {
  const asText = value === undefined ? "" : String(value);
  const [draft, setDraft] = useState(asText);
  useEffect(() => setDraft(asText), [asText]);

  const commit = () => {
    const v = draft.trim();
    if (v === asText) return;
    if (v === "") return onCommit(undefined);
    const n = Number(v);
    const bad =
      !Number.isFinite(n) ||
      (min !== undefined && n < min) ||
      (max !== undefined && n > max);
    if (bad) return setDraft(asText); // revert, never write invalid input
    onCommit(n);
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "11px 16px",
        borderTop: first ? "none" : "1px solid var(--separator)",
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 13.5, color: "var(--text-primary)" }}>
          {label}
        </span>
        {detail && (
          <span
            style={{ display: "block", fontSize: 12, color: "var(--text-tertiary)", marginTop: 1 }}
          >
            {detail}
          </span>
        )}
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(asText);
        }}
        style={{ ...inputStyle, width: 110, textAlign: "right", flexShrink: 0 }}
      />
    </div>
  );
}

/**
 * Editor for string-array settings (enabledModels, skills, npmCommand, …).
 * Deleting the last item commits undefined so the key is removed.
 */
export function StringListEditor({
  items,
  onChange,
  addPlaceholder,
  dimmed = false,
}: {
  items: string[] | undefined;
  onChange: (items: string[] | undefined) => void;
  addPlaceholder?: string;
  dimmed?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const list = items ?? [];

  const commitList = (next: string[]) => onChange(next.length === 0 ? undefined : next);

  const add = () => {
    const v = draft.trim();
    if (!v) return;
    commitList([...list, v]);
    setDraft("");
  };

  return (
    <div style={{ padding: "8px 16px 11px", opacity: dimmed ? 0.45 : 1 }}>
      {list.map((item, i) => (
        <div
          key={`${item}-${i}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "5px 0",
            borderBottom: "1px solid var(--separator)",
          }}
        >
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12.5,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={item}
          >
            {item}
          </span>
          <motion.button
            whileTap={{ scale: 0.85 }}
            aria-label={`remove ${item}`}
            onClick={() => commitList(list.filter((_, j) => j !== i))}
            style={{
              display: "grid",
              placeItems: "center",
              width: 22,
              height: 22,
              border: "none",
              borderRadius: 6,
              background: "transparent",
              color: "var(--text-tertiary)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <X size={13} />
          </motion.button>
        </div>
      ))}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          value={draft}
          placeholder={addPlaceholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          style={inputStyle}
        />
        <motion.button
          whileTap={{ scale: 0.9 }}
          aria-label="add"
          onClick={add}
          disabled={!draft.trim()}
          style={{
            display: "grid",
            placeItems: "center",
            width: 28,
            height: 28,
            border: "1px solid var(--separator)",
            borderRadius: 8,
            background: "var(--bg-base)",
            color: draft.trim() ? "var(--accent)" : "var(--text-tertiary)",
            cursor: draft.trim() ? "pointer" : "default",
            flexShrink: 0,
          }}
        >
          <Plus size={14} />
        </motion.button>
      </div>
    </div>
  );
}

/**
 * Chip multi-select over a fixed option set — for settings whose value is a
 * subset of known keys (`defaultTools`).
 *
 * Deliberately does *not* collapse the empty selection to `undefined` the way
 * `StringListEditor` does: for `defaultTools` an empty array is a meaningful
 * value (start with no built-in tools), distinct from "key absent" (use pi's
 * defaults). Callers own that distinction — see the `defaultTools` row.
 */
export function ChipMultiSelect({
  options,
  value,
  onChange,
  labelOf,
  dimmed = false,
}: {
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  labelOf?: (opt: string) => string;
  dimmed?: boolean;
}) {
  const toggle = (opt: string) =>
    onChange(
      value.includes(opt)
        ? value.filter((v) => v !== opt)
        : // keep the canonical option order rather than click order, so the
          // written array reads the same regardless of how it was assembled
          options.filter((o) => o === opt || value.includes(o))
    );

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: "10px 16px 12px",
        opacity: dimmed ? 0.45 : 1,
      }}
    >
      {options.map((opt) => {
        const active = value.includes(opt);
        return (
          <motion.button
            key={opt}
            whileTap={{ scale: 0.94 }}
            role="checkbox"
            aria-checked={active}
            onClick={() => toggle(opt)}
            style={{
              padding: "4px 11px",
              fontSize: 12.5,
              fontWeight: active ? 600 : 400,
              fontFamily: "var(--font-mono, monospace)",
              borderRadius: 999,
              border: `1px solid ${active ? "var(--accent)" : "var(--separator)"}`,
              background: active ? "var(--accent)" : "var(--bg-base)",
              color: active ? "#fff" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {labelOf ? labelOf(opt) : opt}
          </motion.button>
        );
      })}
    </div>
  );
}

/** Labeled range slider with a live value readout. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
      <span
        style={{
          fontSize: 12,
          color: "var(--text-tertiary)",
          minWidth: 96,
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: "var(--accent)", minWidth: 0 }}
      />
      <span
        style={{
          fontSize: 11.5,
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-secondary)",
          minWidth: 42,
          textAlign: "right",
          flexShrink: 0,
        }}
      >
        {format ? format(value) : value}
      </span>
    </div>
  );
}

/**
 * Multi-line code editor for pasted CSS. Changes apply live (debounced) and
 * commit immediately on blur.
 */
export function CodeArea({
  value,
  onChange,
  placeholder,
  rows = 8,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => setDraft(value), [value]);

  const push = (v: string) => {
    setDraft(v);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => onChange(v), 250);
  };

  return (
    <textarea
      value={draft}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      onChange={(e) => push(e.target.value)}
      onBlur={() => {
        window.clearTimeout(timer.current);
        onChange(draft);
      }}
      style={{
        ...inputStyle,
        display: "block",
        resize: "vertical",
        minHeight: 120,
        lineHeight: 1.55,
        whiteSpace: "pre",
        tabSize: 2,
      }}
    />
  );
}

/** iOS segmented control — Appica ToggleGroup in single-select mode. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  labelOf,
  disabled,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  /** optional display label mapper — falls back to the raw option value */
  labelOf?: (opt: T) => string;
  /** dim and stop responding — for a choice another control has overridden */
  disabled?: boolean;
}) {
  // layoutId must be unique per instance or thumbs animate across controls
  const thumbId = useId();
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(groupValue: unknown[]) => {
        const next = groupValue[0] as T | undefined;
        if (next) onChange(next); // ignore deselect — segmented always has one active
      }}
      aria-disabled={disabled || undefined}
      style={{
        display: "flex",
        gap: 2,
        padding: 3,
        borderRadius: 10,
        background: "var(--bg-sunken)",
        border: "1px solid var(--separator)",
        width: "100%",
        // the thumb keeps its own contrast, so dim the whole control rather than
        // each label — a half-faded thumb reads as a rendering bug
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {options.map((opt) => {
        const active = opt === value;
        const label = labelOf ? labelOf(opt) : opt;
        return (
          <Toggle
            key={opt}
            value={opt}
            aria-label={label}
            disabled={disabled}
            style={{
              position: "relative",
              flex: 1,
              padding: "5px 10px",
              fontSize: 12.5,
              fontWeight: active ? 600 : 400,
              border: "none",
              borderRadius: 8,
              cursor: disabled ? "default" : "pointer",
              background: "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
              zIndex: 1,
              height: "auto",
            }}
          >
            {active && (
              <motion.span
                layoutId={thumbId}
                transition={{ type: "spring", stiffness: 500, damping: 34 }}
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 8,
                  background: "var(--bg-base)",
                  boxShadow: "var(--shadow-sm)",
                  border: "1px solid var(--separator)",
                  zIndex: -1,
                }}
              />
            )}
            {label}
          </Toggle>
        );
      })}
    </ToggleGroup>
  );
}
