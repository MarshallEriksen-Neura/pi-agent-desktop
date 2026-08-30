"use client";

/**
 * The Shortcuts settings section — one place that answers "what is bound to what".
 *
 * Every chord in `SHORTCUT_REGISTRY` gets a row, rebindable or not. The fixed ones
 * are listed read-only with the reason they cannot move (xterm's clipboard
 * handling, the ARIA separator protocol, CodeMirror's keymaps, dialog
 * conventions) rather than hidden, because a reference that omits half the app's
 * keys sends the user hunting through the source for the other half.
 */

import { useEffect, useState } from "react";
import { Keyboard, CornerDownLeft, RotateCcw } from "lucide-react";
import { Button } from "@appica/ui-react/button";
import { SEND_SHORTCUTS } from "@/lib/composer-shortcut";
import {
  SHORTCUT_REGISTRY,
  SHORTCUT_SCOPES,
  bindingFromEvent,
  bindingsEqual,
  effectiveBindings,
  findConflict,
  formatBindings,
  isMacPlatform,
  type Binding,
  type ShortcutCommand,
  type ShortcutScope,
} from "@/lib/shortcuts";
import { useUI } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { InsetGroup, GroupRow, Segmented } from "./settings-ui";
import { Kbd } from "./primitives";

/** Chord chip. Dimmed for chords the app cannot hand over. */
function BindingChip({ label, fixed }: { label: string; fixed?: boolean }) {
  return (
    <Kbd
      style={{
        fontSize: 11,
        padding: "3px 8px",
        opacity: fixed ? 0.55 : 1,
        color: fixed ? "var(--text-tertiary)" : "var(--text-primary)",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </Kbd>
  );
}

/**
 * Click to capture the next chord.
 *
 * The listener runs in the capture phase and cancels everything it sees, so the
 * chord being recorded cannot also fire the command it is being taken from —
 * pressing ⌘J while rebinding would otherwise open the terminal over the panel.
 */
function KeyCaptureButton({
  label,
  capturing,
  onStart,
  onCapture,
  onCancel,
}: {
  label: string;
  capturing: boolean;
  onStart: () => void;
  onCapture: (binding: Binding) => void;
  onCancel: () => void;
}) {
  const t = useT();

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      const binding = bindingFromEvent(e, isMacPlatform());
      if (binding) onCapture(binding);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, onCapture, onCancel]);

  return (
    <button
      type="button"
      onClick={capturing ? onCancel : onStart}
      style={{
        minWidth: 108,
        padding: "5px 10px",
        borderRadius: "var(--radius-md)",
        border: `1px solid ${capturing ? "var(--accent)" : "var(--separator)"}`,
        background: capturing ? "var(--accent-muted)" : "var(--bg-sunken)",
        color: capturing ? "var(--accent)" : "var(--text-primary)",
        fontFamily: capturing ? "var(--font-ui)" : "var(--font-mono)",
        fontSize: capturing ? 12 : 11.5,
        cursor: "pointer",
      }}
    >
      {capturing ? t("shortcuts.capturing") : label}
    </button>
  );
}

/** One editable command: chord button, plus a revert affordance once changed. */
function RebindableRow({
  command,
  mac,
  first,
  capturing,
  setCapturing,
}: {
  command: ShortcutCommand;
  mac: boolean;
  first: boolean;
  capturing: string | null;
  setCapturing: (id: string | null) => void;
}) {
  const t = useT();
  const { shortcutOverrides, setShortcutBinding, resetShortcutBinding } = useUI();
  const [conflict, setConflict] = useState<string | null>(null);

  const bindings = effectiveBindings(command, shortcutOverrides);
  const overridden = shortcutOverrides[command.id] !== undefined;
  const isCapturing = capturing === command.id;

  const commit = (binding: Binding) => {
    const clash = findConflict(command.id, binding, shortcutOverrides, mac);
    if (clash) {
      // Refuse rather than silently shadowing: the loser would be a chord the
      // user never sees again, in a panel whose whole job is showing them.
      setConflict(t(`shortcuts.cmd.${clash.id}`));
      setCapturing(null);
      return;
    }
    setConflict(null);
    // Landing back on the shipped chord is a reset, not an override — otherwise
    // the row keeps a "changed" marker for a binding identical to the default.
    if (command.defaults.some((d) => bindingsEqual(d, binding, mac))) {
      resetShortcutBinding(command.id);
    } else {
      setShortcutBinding(command.id, binding);
    }
    setCapturing(null);
  };

  return (
    <GroupRow
      first={first}
      title={t(`shortcuts.cmd.${command.id}`)}
      detail={
        conflict
          ? t("shortcuts.conflict", { command: conflict })
          : isCapturing
            ? t("shortcuts.captureHint")
            : undefined
      }
      trailing={
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <KeyCaptureButton
            label={formatBindings(bindings, mac)}
            capturing={isCapturing}
            onStart={() => {
              setConflict(null);
              setCapturing(command.id);
            }}
            onCapture={commit}
            onCancel={() => setCapturing(null)}
          />
          {overridden && (
            <button
              type="button"
              aria-label={t("shortcuts.reset")}
              title={t("shortcuts.reset")}
              onClick={() => {
                setConflict(null);
                resetShortcutBinding(command.id);
              }}
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: 7,
                border: "1px solid var(--separator)",
                background: "var(--bg-sunken)",
                color: "var(--text-secondary)",
                cursor: "pointer",
              }}
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      }
    />
  );
}

/** One chord the app cannot hand over — listed with the reason it is pinned. */
function FixedRow({
  command,
  mac,
  first,
}: {
  command: ShortcutCommand;
  mac: boolean;
  first: boolean;
}) {
  const t = useT();
  return (
    <GroupRow
      first={first}
      title={t(`shortcuts.cmd.${command.id}`)}
      detail={command.reason ? t(`shortcuts.reason.${command.reason}`) : undefined}
      trailing={
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <BindingChip label={formatBindings(command.defaults, mac)} fixed />
          <span
            style={{
              fontSize: 10.5,
              color: "var(--text-tertiary)",
              border: "1px solid var(--separator)",
              borderRadius: 5,
              padding: "1px 5px",
              whiteSpace: "nowrap",
            }}
          >
            {t("shortcuts.fixed")}
          </span>
        </div>
      }
    />
  );
}

/**
 * The composer's send key — a three-way choice, not a free chord.
 *
 * Send and newline compete for the same key inside a textarea, so picking one
 * implies the other; any key outside the Enter family would either shadow text
 * entry or collide with a global chord. See `composer-shortcut.ts`.
 */
function SendShortcutRow() {
  const t = useT();
  const { sendShortcut, setSendShortcut } = useUI();
  return (
    <GroupRow
      first
      icon={<CornerDownLeft size={15} />}
      iconBg="var(--accent)"
      title={t("settings.sendShortcut")}
      detail={t(`settings.sendShortcut.${sendShortcut}.detail`)}
      trailing={
        <div style={{ width: 300, flexShrink: 0 }}>
          <Segmented
            options={SEND_SHORTCUTS}
            value={sendShortcut}
            onChange={setSendShortcut}
            labelOf={(v) => t(`settings.sendShortcut.${v}`)}
          />
        </div>
      }
    />
  );
}

export function ShortcutsSettings() {
  const t = useT();
  const { shortcutOverrides, resetAllShortcuts } = useUI();
  // Resolved after mount on purpose: the static export prerenders without a
  // navigator, so reading it during render would mismatch on hydration.
  const [mac, setMac] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => setMac(isMacPlatform()), []);

  const changed = Object.keys(shortcutOverrides).length;

  return (
    <>
      {SHORTCUT_SCOPES.map((scope: ShortcutScope) => {
        const commands = SHORTCUT_REGISTRY.filter((c) => c.scope === scope);
        if (commands.length === 0) return null;
        // The send row heads the chat group, so nothing from the registry can
        // claim the borderless first slot there.
        const sendFirst = scope === "chat";
        return (
          <InsetGroup
            key={scope}
            header={t(`shortcuts.scope.${scope}`)}
            footer={t(`shortcuts.scope.${scope}Footer`)}
          >
            {sendFirst && <SendShortcutRow />}
            {commands.map((command, index) =>
              command.rebindable ? (
                <RebindableRow
                  key={command.id}
                  command={command}
                  mac={mac}
                  first={!sendFirst && index === 0}
                  capturing={capturing}
                  setCapturing={setCapturing}
                />
              ) : (
                <FixedRow
                  key={command.id}
                  command={command}
                  mac={mac}
                  first={!sendFirst && index === 0}
                />
              )
            )}
          </InsetGroup>
        );
      })}

      <InsetGroup header={t("shortcuts.manage")} footer={t("shortcuts.resetAllFooter")}>
        <GroupRow
          first
          icon={<Keyboard size={15} />}
          iconBg="var(--accent)"
          title={t("shortcuts.resetAll")}
          detail={
            changed > 0
              ? t("shortcuts.changedCount", { count: changed })
              : t("shortcuts.allDefault")
          }
          trailing={
            <Button
              variant="outline"
              size="sm"
              disabled={changed === 0}
              onClick={resetAllShortcuts}
            >
              {t("shortcuts.reset")}
            </Button>
          }
        />
      </InsetGroup>
    </>
  );
}
