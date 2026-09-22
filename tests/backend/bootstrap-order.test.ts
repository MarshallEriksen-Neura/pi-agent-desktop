import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appShellPath = path.join(process.cwd(), "src/components/AppShell.tsx");
const petWindowPath = path.join(process.cwd(), "src-tauri/src/pet_window.rs");

function appShellSource(): string {
  return fs.readFileSync(appShellPath, "utf8");
}

function assertInOrder(source: string, labels: string[]) {
  let cursor = -1;
  for (const label of labels) {
    const index = source.indexOf(label, cursor + 1);
    assert.notEqual(index, -1, `missing bootstrap marker: ${label}`);
    assert.ok(index > cursor, `${label} should appear after the previous bootstrap marker`);
    cursor = index;
  }
}

test("keeps pet route outside the main desktop bootstrap chain", () => {
  const source = appShellSource();
  assertInOrder(source, [
    'pathname?.startsWith("/pet")',
    "return <>{children}</>",
    "return <MainShell>{children}</MainShell>",
  ]);
});

test("locks AppShell synchronous setup and async desktop startup order", () => {
  const source = appShellSource();
  assertInOrder(source, [
    "useI18n.getState().initLocale()",
    "useUI.getState().initTheme()",
    "useUI.getState().initCloseBehavior()",
    // the layout has to be restored before EditorCanvas can mount, or a
    // chat-layout launch builds the editor and immediately tears it down
    "useUI.getState().initLayout()",
    "useAppearance.getState().init()",
    "useExtUi.getState().init()",
    "useSubagents.getState().initPiBridge()",
    "initAgentBridge()",
    /* No runtime pre-load here any more: the WSL runtime mode is gone, so there
       is no shell bridge that had to be loaded before the first agent command.
       The workspace init is now the first await in the chain. */
    "void useWorkspace",
    ".then(() => useSessions.getState().init(useWorkspace.getState().root ?? \"\"))",
    ".then(() => useCliUpdate.getState().checkOnLaunch())",
  ]);
});

test("locks shell handler registration and cleanup order", () => {
  const source = appShellSource();
  assertInOrder(source, [
    // Not capture-phase, and an early return rather than a positive test: Esc
    // belongs to whatever input is focused, so the shell only claims it when a
    // subagent is actually focused (0.8.0 dropped the global `capture: true`).
    'if (e.key !== "Escape" || !useSubagents.getState().focusedId) return',
    'window.addEventListener("keydown", onKey)',
    "const preventDefaultCtx = (e: MouseEvent) => e.preventDefault()",
    'document.addEventListener("contextmenu", preventDefaultCtx)',
    'window.removeEventListener("keydown", onKey)',
    'document.removeEventListener("contextmenu", preventDefaultCtx)',
    "destroyAgentBridge()",
  ]);
});

/*
 * The close listener moved out of the setup effect and behind closeBehavior, so
 * it needs its own ordering: only ask/minimize register it. In quit mode there
 * must be no JS listener at all — a registered one puts the renderer on the
 * close path, and a hung renderer then blocks the native close before Rust ever
 * sees ExitRequested.
 */
test("registers the close listener only when the saved behavior needs one", () => {
  const source = appShellSource();
  assertInOrder(source, [
    'if (getBackendKind() !== "desktop-tauri" || closeBehavior === "quit") return',
    "let closeUnlisten: (() => void) | undefined",
    'getPort("window")',
    ".onCloseRequested((event) =>",
    "event.preventDefault()",
    "requestClose()",
    "closeUnlisten?.()",
    "}, [closeBehavior])",
  ]);
});

test("locks desktop pet autolaunch behavior after main bootstrap effect", () => {
  const source = appShellSource();
  assertInOrder(source, [
    "const prefs = loadPetPreferences()",
    "if (!prefs.enabled || !prefs.petId) return",
    // petId is destructured off prefs before the idle callback, so the calls
    // read `petId`, not `prefs.petId` — and the config update precedes the
    // reveal, which rides the pet window's ready event.
    "void loadBuiltinPet(petId)",
    "usePet.getState().loadPet(pet)",
    ".emitConfigUpdate({ petId }",
    "void showPetWindow()",
  ]);
});

test("creates the pet webview outside synchronous IPC with a single-flight guard", () => {
  const source = fs.readFileSync(petWindowPath, "utf8");

  for (const command of ["pet_window_prewarm", "pet_window_show", "pet_window_toggle"]) {
    assert.match(
      source,
      new RegExp(`#\\[tauri::command\\]\\s+pub async fn ${command}\\b`),
      `${command} must be async so Tauri does not create WebView2 inside the invoking IPC callback`,
    );
  }

  assert.ok(
    source.includes("static PET_WINDOW_CREATION_LOCK: Mutex<()> = Mutex::new(())"),
  );
  assert.match(source, /fn create_pet_window\([\s\S]*?WebviewWindowBuilder::new/);

  const ensureStart = source.indexOf("fn ensure_pet_window(");
  const ensureEnd = source.indexOf("\n}\n\n/// Load the pet window", ensureStart);
  assert.notEqual(ensureStart, -1, "missing ensure_pet_window helper");
  assert.notEqual(ensureEnd, -1, "missing end of ensure_pet_window helper");
  assertInOrder(source.slice(ensureStart, ensureEnd), [
    "PET_WINDOW_CREATION_LOCK",
    "create_pet_window(app)",
  ]);
});

test("locks Pi activity hooks to one registration across restarts", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "src/lib/pi/store.ts"), "utf8");
  assertInOrder(source, [
    "let activityHooked = false",
    "if (!activityHooked)",
    "activityHooked = true",
    'client.on("agent_start"',
    'client.on("agent_settled"',
    'client.on("agent_end"',
  ]);
});
