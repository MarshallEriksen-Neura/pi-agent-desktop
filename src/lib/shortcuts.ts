/**
 * The desktop app's keyboard shortcut registry.
 *
 * Every chord the app owns is described here — the ones a user can rebind and
 * the ones that are structurally fixed alike. The settings panel renders this
 * list, and the handlers that used to hard-code their own chords match against
 * it instead, so "what is bound to ⌘K" has exactly one answer.
 *
 * Pure on purpose: no React, no zustand, no `"use client"`. The matcher is the
 * part that has to be right across three platforms and two keyboard layouts, and
 * `tests/backend` can only import modules that stay out of the tsx graph. State
 * (the user's overrides) lives in the UI store — the same split `sendShortcut`
 * already uses between `composer-shortcut.ts` and `store.ts`.
 */

/**
 * One chord: a main key plus the modifiers held with it.
 *
 * `mod` is the platform's command modifier — ⌘ on macOS, Ctrl everywhere else.
 * `ctrl` is a *literal* Ctrl on every platform, which is a different thing: the
 * terminal's Ctrl+L and Ctrl+C are bytes sent to a shell rather than app
 * commands, so on macOS they stay on Ctrl while every app command moves to ⌘.
 */
export interface Binding {
  /** normalized main key — see `normalizeKey` */
  key: string;
  /** ⌘ on macOS, Ctrl elsewhere */
  mod?: boolean;
  /** literal Ctrl, on every platform */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/**
 * Canonical form of `KeyboardEvent.key`.
 *
 * Single characters fold to lower case, because a shifted letter arrives as
 * `"C"` and an unshifted one as `"c"` — comparing them raw is how a ⌘⇧C binding
 * ends up depending on the shift state twice. Named keys ("Enter", "ArrowDown")
 * are already canonical and pass through.
 */
export function normalizeKey(raw: string): string {
  return raw.length === 1 ? raw.toLowerCase() : raw;
}

/**
 * Whether Shift modifies this key or is part of typing it.
 *
 * For letters and named keys it is a modifier: ⌘K and ⌘⇧K are two chords. For
 * punctuation it is how the character is produced, and *which* characters need
 * it depends on the layout — `/` is unshifted on a US keyboard and shifted on
 * AZERTY. `event.key` already reports the resulting character, so the shift flag
 * carries no extra information there, and comparing it anyway would leave ⌘/
 * dead across half of Europe.
 */
function shiftMatters(key: string): boolean {
  return key.length > 1 || /^[a-z]$/.test(key);
}

/** Canonical binding: key folded, Shift dropped where it is not a modifier. */
export function normalizeBinding(binding: Binding): Binding {
  const key = normalizeKey(binding.key);
  const out: Binding = { key };
  if (binding.mod) out.mod = true;
  if (binding.ctrl) out.ctrl = true;
  if (binding.shift && shiftMatters(key)) out.shift = true;
  if (binding.alt) out.alt = true;
  return out;
}

/** The slice of a keyboard event the matcher reads — keeps it testable in node. */
export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** The concrete modifier flags a binding expects on this platform. */
function resolveModifiers(binding: Binding, mac: boolean) {
  return {
    meta: mac && binding.mod === true,
    // Off macOS, `mod` *is* Ctrl, so the two flags collapse onto one key.
    ctrl: binding.ctrl === true || (!mac && binding.mod === true),
    shift: binding.shift === true,
    alt: binding.alt === true,
  };
}

/**
 * Exact match, not "at least these modifiers".
 *
 * The hand-rolled checks this replaces tested `mod && key === "k"`, which also
 * fired on ⌘⇧K and ⌘⌥K — so those chords silently aliased the palette and could
 * never be handed to anything else. Exact comparison is what makes conflict
 * detection mean something.
 */
export function matchesBinding(
  event: ShortcutKeyEvent,
  binding: Binding,
  mac: boolean
): boolean {
  const key = normalizeKey(event.key);
  if (key !== binding.key) return false;
  const want = resolveModifiers(binding, mac);
  if (event.metaKey !== want.meta) return false;
  if (event.ctrlKey !== want.ctrl) return false;
  if (event.altKey !== want.alt) return false;
  return shiftMatters(key) ? event.shiftKey === want.shift : true;
}

/**
 * Do two bindings occupy the same physical chord *on this platform*?
 *
 * Platform-dependent by necessity: `{mod:true}` and `{ctrl:true}` are the same
 * key on Windows and Linux and different keys on macOS, so ⌘L and Ctrl+L collide
 * in one place and coexist in the other.
 */
export function bindingsEqual(a: Binding, b: Binding, mac: boolean): boolean {
  if (a.key !== b.key) return false;
  const x = resolveModifiers(a, mac);
  const y = resolveModifiers(b, mac);
  if (x.meta !== y.meta || x.ctrl !== y.ctrl || x.alt !== y.alt) return false;
  return shiftMatters(a.key) ? x.shift === y.shift : true;
}

/** Glyphs for the keys that read badly as their `event.key` name. */
const KEY_GLYPHS: Record<string, string> = {
  Enter: "↩",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  " ": "Space",
  Backspace: "⌫",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

function formatKey(key: string): string {
  return KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/**
 * Human label for a chord: `⌘⇧C` on macOS, `Ctrl+Shift+C` elsewhere.
 *
 * Modifier order follows each platform's convention — ⌃⌥⇧⌘ on macOS (the key
 * closest to the space bar last), Ctrl first everywhere else.
 */
export function formatBinding(binding: Binding, mac: boolean): string {
  const parts: string[] = [];
  if (mac) {
    if (binding.ctrl) parts.push("⌃");
    if (binding.alt) parts.push("⌥");
    if (binding.shift) parts.push("⇧");
    if (binding.mod) parts.push("⌘");
    return parts.join("") + formatKey(binding.key);
  }
  if (binding.mod || binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  parts.push(formatKey(binding.key));
  return parts.join("+");
}

/** Several chords for one command, e.g. the diff's ⌥↓ · ⌥↑. */
export function formatBindings(bindings: readonly Binding[], mac: boolean): string {
  return bindings.map((b) => formatBinding(b, mac)).join(" · ");
}

/**
 * Which surface listens for a command — it decides both where the panel groups
 * a row and whether two identical chords actually collide. The chat's ⌘⇧C and
 * the terminal's ⌘⇧C coexist today because one is bound to the transcript
 * container and the other inside xterm; only one of them can have focus.
 */
export type ShortcutScope =
  | "global"
  | "chat"
  | "terminal"
  | "editor"
  | "diff"
  | "panel"
  | "dialog";

/** Group render order in the settings panel — broadest surface first. */
export const SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  "global",
  "chat",
  "terminal",
  "editor",
  "diff",
  "panel",
  "dialog",
];

export interface ShortcutCommand {
  /** stable id; also the i18n key tail (`shortcuts.cmd.<id>`) */
  id: string;
  scope: ShortcutScope;
  /** shipped chord(s). Rebindable commands have exactly one. */
  defaults: readonly Binding[];
  /**
   * `false` means the chord is structurally fixed — the row is listed read-only
   * with `reason` explaining why, rather than omitted. A shortcut panel that
   * hides half the app's keys is a worse reference than one that admits which
   * keys it cannot move.
   */
  rebindable: boolean;
  /** i18n key tail for the fixed-row explanation (`shortcuts.reason.<reason>`) */
  reason?: string;
}

/**
 * Every chord the app owns.
 *
 * `chat.send` is deliberately absent: it is a three-way choice between ↩, ⇧↩ and
 * ⌘↩ rather than a free chord (see `composer-shortcut.ts` for why an arbitrary
 * key cannot work inside a textarea), so the panel renders it as its own control
 * instead of forcing a sentinel shape into this model.
 */
export const SHORTCUT_REGISTRY: readonly ShortcutCommand[] = [
  // ── global: the window-level listener in app/page.tsx ──────────────────────
  { id: "commandPalette", scope: "global", defaults: [{ key: "k", mod: true }], rebindable: true },
  { id: "zenMode", scope: "global", defaults: [{ key: ".", mod: true }], rebindable: true },
  { id: "workMode", scope: "global", defaults: [{ key: "/", mod: true }], rebindable: true },
  { id: "toggleTerminal", scope: "global", defaults: [{ key: "j", mod: true }], rebindable: true },

  // ── chat ──────────────────────────────────────────────────────────────────
  {
    id: "copyLastReply",
    scope: "chat",
    defaults: [{ key: "c", mod: true, shift: true }],
    rebindable: true,
  },
  {
    id: "altSend",
    scope: "chat",
    defaults: [{ key: "Enter", mod: true, shift: true }],
    rebindable: false,
    reason: "sendDesign",
  },
  {
    id: "slashMenu",
    scope: "chat",
    defaults: [
      { key: "ArrowUp" },
      { key: "ArrowDown" },
      { key: "Tab" },
      { key: "Enter" },
      { key: "Escape" },
    ],
    rebindable: false,
    reason: "menuConvention",
  },
  {
    id: "remoteFollowUp",
    scope: "chat",
    defaults: [{ key: "Enter", mod: true }],
    rebindable: false,
    reason: "sendDesign",
  },

  // ── terminal: xterm's own key handler, plus bytes bound for the shell ──────
  {
    id: "terminalCopy",
    scope: "terminal",
    defaults: [
      { key: "c", mod: true },
      { key: "c", mod: true, shift: true },
    ],
    rebindable: false,
    reason: "xtermClipboard",
  },
  {
    id: "terminalPaste",
    scope: "terminal",
    defaults: [
      { key: "v", mod: true },
      { key: "v", mod: true, shift: true },
    ],
    rebindable: false,
    reason: "xtermClipboard",
  },
  {
    id: "terminalClear",
    scope: "terminal",
    defaults: [{ key: "l", ctrl: true }],
    rebindable: false,
    reason: "shellByte",
  },
  {
    id: "terminalInterrupt",
    scope: "terminal",
    defaults: [{ key: "c", ctrl: true }],
    rebindable: false,
    reason: "shellByte",
  },
  {
    id: "terminalRun",
    scope: "terminal",
    defaults: [{ key: "Enter" }],
    rebindable: false,
    reason: "shellByte",
  },

  // ── editor: ⌘S is ours, the rest comes from CodeMirror's standard keymaps ───
  {
    id: "editorSave",
    scope: "editor",
    defaults: [{ key: "s", mod: true }],
    rebindable: false,
    reason: "codemirror",
  },
  {
    id: "editorFind",
    scope: "editor",
    defaults: [{ key: "f", mod: true }],
    rebindable: false,
    reason: "codemirror",
  },
  {
    id: "editorUndoRedo",
    scope: "editor",
    defaults: [
      { key: "z", mod: true },
      { key: "z", mod: true, shift: true },
    ],
    rebindable: false,
    reason: "codemirror",
  },
  {
    id: "editorIndent",
    scope: "editor",
    defaults: [{ key: "Tab" }],
    rebindable: false,
    reason: "codemirror",
  },

  // ── diff: window-level listeners in FileDiffView ───────────────────────────
  {
    id: "nextHunk",
    scope: "diff",
    defaults: [{ key: "ArrowDown", alt: true }],
    rebindable: true,
  },
  {
    id: "prevHunk",
    scope: "diff",
    defaults: [{ key: "ArrowUp", alt: true }],
    rebindable: true,
  },

  // ── panel dividers: the ARIA `separator` keyboard protocol ─────────────────
  {
    id: "panelResize",
    scope: "panel",
    defaults: [{ key: "ArrowLeft" }, { key: "ArrowRight" }],
    rebindable: false,
    reason: "ariaSeparator",
  },
  {
    id: "panelResizeFine",
    scope: "panel",
    defaults: [
      { key: "ArrowLeft", shift: true },
      { key: "ArrowRight", shift: true },
    ],
    rebindable: false,
    reason: "ariaSeparator",
  },
  {
    id: "panelResizeReset",
    scope: "panel",
    defaults: [{ key: "Home" }],
    rebindable: false,
    reason: "ariaSeparator",
  },

  // ── dialogs, menus, overlays ───────────────────────────────────────────────
  {
    id: "dialogConfirm",
    scope: "dialog",
    defaults: [{ key: "Enter" }],
    rebindable: false,
    reason: "a11yConvention",
  },
  {
    id: "dialogDismiss",
    scope: "dialog",
    defaults: [{ key: "Escape" }],
    rebindable: false,
    reason: "a11yConvention",
  },
];

/** Registry lookup by id. */
export function shortcutById(id: string): ShortcutCommand | undefined {
  return SHORTCUT_REGISTRY.find((c) => c.id === id);
}

/** The ids a user may rebind — the settings panel's editable rows. */
export const REBINDABLE_IDS: readonly string[] = SHORTCUT_REGISTRY.filter(
  (c) => c.rebindable
).map((c) => c.id);

/** Only the chords a user actually changed; everything else falls back to the registry. */
export type ShortcutOverrides = Readonly<Record<string, Binding>>;

/** What is bound to this command right now. */
export function effectiveBindings(
  command: ShortcutCommand,
  overrides: ShortcutOverrides
): readonly Binding[] {
  const override = command.rebindable ? overrides[command.id] : undefined;
  return override ? [override] : command.defaults;
}

/**
 * Whether two scopes can have focus at the same moment, and therefore whether an
 * identical chord in both is a real collision. `global` listens on the window, so
 * it overlaps everything; `dialog` chords (Esc, ⏎) are live under every surface.
 */
function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  if (a === b) return true;
  return a === "global" || b === "global" || a === "dialog" || b === "dialog";
}

/**
 * The command already holding this chord, or `null` if it is free.
 *
 * Fixed commands are searched too — that is what stops a global binding from
 * landing on ⌘S or on the terminal's clipboard keys, which would shadow them
 * with no way for the user to see why.
 */
export function findConflict(
  id: string,
  binding: Binding,
  overrides: ShortcutOverrides,
  mac: boolean
): ShortcutCommand | null {
  const self = shortcutById(id);
  if (!self) return null;
  const candidate = normalizeBinding(binding);
  for (const other of SHORTCUT_REGISTRY) {
    if (other.id === id) continue;
    if (!scopesOverlap(self.scope, other.scope)) continue;
    for (const held of effectiveBindings(other, overrides)) {
      if (bindingsEqual(candidate, held, mac)) return other;
    }
  }
  return null;
}

/** Keys that are only ever half of a chord — capture keeps waiting on these. */
const MODIFIER_KEYS = new Set([
  "Meta",
  "Control",
  "Shift",
  "Alt",
  "AltGraph",
  "CapsLock",
  "OS",
  "Dead",
]);

/**
 * Turn a captured keypress into a binding, or `null` if it is not usable yet.
 *
 * Rejects chords with no command modifier and no Alt. Shift alone does not
 * qualify — ⇧K is just K, and a shortcut reachable by typing a letter would fire
 * in the middle of a sentence.
 *
 * Off macOS a captured Ctrl becomes `mod` rather than `ctrl`, so the stored chord
 * means "the platform's command modifier" and still reads as ⌘ if the config
 * later opens on a Mac.
 */
export function bindingFromEvent(
  event: ShortcutKeyEvent,
  mac: boolean
): Binding | null {
  const key = normalizeKey(event.key);
  if (MODIFIER_KEYS.has(key)) return null;
  const mod = mac ? event.metaKey : event.ctrlKey;
  const ctrl = mac ? event.ctrlKey : false;
  if (!mod && !ctrl && !event.altKey) return null;
  const binding: Binding = { key };
  if (mod) binding.mod = true;
  if (ctrl) binding.ctrl = true;
  if (event.shiftKey) binding.shift = true;
  if (event.altKey) binding.alt = true;
  return normalizeBinding(binding);
}

function isBinding(value: unknown): value is Binding {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  if (typeof b.key !== "string" || b.key.length === 0) return false;
  for (const flag of ["mod", "ctrl", "shift", "alt"]) {
    if (b[flag] !== undefined && typeof b[flag] !== "boolean") return false;
  }
  return true;
}

/**
 * Read overrides back from storage, dropping anything unrecognizable — a chord
 * for a command that no longer exists, one that has since been made fixed, or
 * hand-edited JSON. A bad entry falls back to the shipped default instead of
 * leaving a command with no working key.
 */
export function parseShortcutOverrides(raw: string | null): ShortcutOverrides {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, Binding> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const command = shortcutById(id);
    if (!command?.rebindable) continue;
    if (!isBinding(value)) continue;
    out[id] = normalizeBinding(value);
  }
  return out;
}

/**
 * Display label for a command's current chord — what to print next to a menu
 * item or in a hint pill. Empty string for an unknown id, so a stale caller
 * renders nothing rather than a wrong key.
 *
 * Every surface that shows a chord has to go through this: a hint hard-coded as
 * "⌘J" keeps claiming ⌘J after the user has moved the command somewhere else.
 */
export function bindingLabel(
  id: string,
  overrides: ShortcutOverrides,
  mac: boolean
): string {
  const command = shortcutById(id);
  if (!command) return "";
  return formatBindings(effectiveBindings(command, overrides), mac);
}

/** True on macOS, where the command modifier is ⌘ rather than Ctrl. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /mac/i.test(navigator.platform || navigator.userAgent);
}
