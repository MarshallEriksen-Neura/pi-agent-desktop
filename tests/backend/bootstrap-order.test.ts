import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appShellPath = path.join(process.cwd(), "src/components/AppShell.tsx");

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
    "useAppearance.getState().init()",
    "useChat.getState().init()",
    "useExtUi.getState().init()",
    "useSubagents.getState().initPiBridge()",
    "initAgentBridge()",
    ".load()",
    ".then(() => useWorkspace.getState().init())",
    "const root = useWorkspace.getState().root ?? undefined",
    "const resumePath = await peekLatestSessionPath(root ?? \"\")",
    "await connect({",
    "cwd: root",
    "resumePath: resumePath || undefined",
    ".then(() => useSessions.getState().init(useWorkspace.getState().root ?? \"\"))",
    ".then(() => useCliUpdate.getState().checkOnLaunch())",
  ]);
});

test("locks shell handler registration and cleanup order", () => {
  const source = appShellSource();
  assertInOrder(source, [
    'if (e.key === "Escape" && useSubagents.getState().focusedId)',
    'window.addEventListener("keydown", onKey, true)',
    "const preventDefaultCtx = (e: MouseEvent) => e.preventDefault()",
    'document.addEventListener("contextmenu", preventDefaultCtx)',
    'getPort("window")',
    ".onCloseRequested((event) =>",
    "event.preventDefault()",
    "requestClose()",
    'window.removeEventListener("keydown", onKey, true)',
    'document.removeEventListener("contextmenu", preventDefaultCtx)',
    "destroyAgentBridge()",
    "closeUnlisten?.()",
  ]);
});

test("locks desktop pet autolaunch behavior after main bootstrap effect", () => {
  const source = appShellSource();
  assertInOrder(source, [
    "const prefs = loadPetPreferences()",
    "if (!prefs.enabled || !prefs.petId) return",
    "loadBuiltinPet(prefs.petId)",
    "usePet.getState().loadPet(pet)",
    "void showPetWindow()",
    ".emitConfigUpdate({ petId: prefs.petId }",
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
