import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_TERMINAL_SHELL_PROFILE,
  loadTerminalShellProfile,
  parseTerminalShellProfile,
  persistTerminalShellProfile,
} from "../../src/lib/terminal-shell-profile";

class MemoryStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

test("terminal shell profile parser accepts trimmed custom executables", () => {
  assert.deepEqual(
    parseTerminalShellProfile({
      kind: "custom",
      executable: "  C:/Program Files/PowerShell/7/pwsh.exe  ",
    }),
    { kind: "custom", executable: "C:/Program Files/PowerShell/7/pwsh.exe" }
  );
});

test("terminal shell profile parser falls back to Auto for corrupt persisted values", () => {
  for (const value of [
    null,
    "custom",
    {},
    { kind: "custom", executable: "  " },
    { kind: "future-profile" },
  ]) {
    assert.equal(parseTerminalShellProfile(value), AUTO_TERMINAL_SHELL_PROFILE);
  }
  assert.equal(
    parseTerminalShellProfile({ kind: "auto", executable: "ignored" }),
    AUTO_TERMINAL_SHELL_PROFILE
  );
});

test("terminal shell profile preference persists custom values and removes Auto", () => {
  const storage = new MemoryStorage();
  assert.deepEqual(
    persistTerminalShellProfile(storage, {
      kind: "custom",
      executable: "  /bin/zsh  ",
    }),
    { kind: "custom", executable: "/bin/zsh" }
  );
  assert.equal(
    storage.getItem("pi-desktop.terminalShellProfile"),
    JSON.stringify({ kind: "custom", executable: "/bin/zsh" })
  );

  storage.setItem("pi-desktop.terminalShellProfile", "corrupt");
  assert.equal(loadTerminalShellProfile(storage), AUTO_TERMINAL_SHELL_PROFILE);

  persistTerminalShellProfile(storage, { kind: "auto" });
  assert.equal(storage.getItem("pi-desktop.terminalShellProfile"), null);
});
