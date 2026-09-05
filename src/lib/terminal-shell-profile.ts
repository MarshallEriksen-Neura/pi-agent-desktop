export type LocalTerminalShellProfile =
  | { kind: "auto" }
  | { kind: "custom"; executable: string };

export const TERMINAL_SHELL_PROFILE_STORAGE_KEY = "pi-desktop.terminalShellProfile";

export const AUTO_TERMINAL_SHELL_PROFILE: LocalTerminalShellProfile = Object.freeze({
  kind: "auto",
});

/** Parse the app-local persisted preference without trusting localStorage contents. */
export function parseTerminalShellProfile(value: unknown): LocalTerminalShellProfile {
  if (typeof value !== "object" || value === null) return AUTO_TERMINAL_SHELL_PROFILE;
  const candidate = value as { kind?: unknown; executable?: unknown };
  if (candidate.kind === "auto") return AUTO_TERMINAL_SHELL_PROFILE;
  if (candidate.kind !== "custom" || typeof candidate.executable !== "string") {
    return AUTO_TERMINAL_SHELL_PROFILE;
  }
  const executable = candidate.executable.trim();
  return executable ? { kind: "custom", executable } : AUTO_TERMINAL_SHELL_PROFILE;
}

export function loadTerminalShellProfile(
  storage: Pick<Storage, "getItem">
): LocalTerminalShellProfile {
  const saved = storage.getItem(TERMINAL_SHELL_PROFILE_STORAGE_KEY);
  if (saved === null) return AUTO_TERMINAL_SHELL_PROFILE;
  try {
    return parseTerminalShellProfile(JSON.parse(saved));
  } catch {
    return AUTO_TERMINAL_SHELL_PROFILE;
  }
}

export function persistTerminalShellProfile(
  storage: Pick<Storage, "setItem" | "removeItem">,
  profile: LocalTerminalShellProfile
): LocalTerminalShellProfile {
  const normalized = parseTerminalShellProfile(profile);
  if (normalized.kind === "auto") {
    storage.removeItem(TERMINAL_SHELL_PROFILE_STORAGE_KEY);
  } else {
    storage.setItem(TERMINAL_SHELL_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
  }
  return normalized;
}
