// Provider login sidecar — drives pi's own auth flows from outside the TUI.
//
// pi implements every OAuth flow (PKCE, callback servers, device codes) and
// owns writing `auth.json`. This script contributes nothing but an
// `AuthInteraction` whose `notify`/`prompt` are forwarded over stdio, so the
// desktop UI can host the same login pi's `/login` hosts. No OAuth protocol
// detail lives here.
//
// Invoked as: node <this> <pi-dist-index.js> <list|login|logout> [providerId] [oauth|api_key]
//
// stdout is strict JSONL (one message per line):
//   {"kind":"ready"}
//   {"kind":"providers","providers":[...]}
//   {"kind":"notify","event":{...}}          // pi's AuthEvent, forwarded verbatim
//   {"kind":"prompt","requestId":"p1","prompt":{...}}
//   {"kind":"done","ok":true,"credentialType":"oauth"}
//   {"kind":"cancelled"}
//   {"kind":"error","message":"..."}
// stdin is JSONL too:
//   {"kind":"answer","requestId":"p1","value":"..."}
//   {"kind":"cancel"}
//
// The auth-file location is deliberately left to pi's own resolution
// (`PI_CODING_AGENT_DIR`, else `~/.pi/agent`). Passing an explicit path would
// diverge from the pi RPC child that reads it whenever that variable is set.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const [distPath, subcommand, providerId, method] = process.argv.slice(2);

/** Write one JSONL message, resolving once it has been flushed to the pipe. */
function emit(message) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve());
  });
}

/** Emit a terminal message, then exit without truncating the pending write. */
async function exitWith(message, code) {
  await emit(message);
  process.exit(code);
}

function describe(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * Aborts the whole login when the host sends `cancel` or closes stdin.
 * pi treats this as the user cancelling: callback servers shut down and
 * `login()` rejects without writing a credential.
 */
const loginAbort = new AbortController();

/** requestId → resolver pair for the prompt currently awaiting an answer. */
const pending = new Map();
let nextPromptId = 1;

const stdin = createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // A malformed host line must not kill an in-flight browser login.
    return;
  }
  if (message?.kind === "cancel") {
    loginAbort.abort();
    return;
  }
  if (message?.kind !== "answer") return;
  const entry = pending.get(message.requestId);
  if (!entry) return;
  pending.delete(message.requestId);
  entry.resolve(typeof message.value === "string" ? message.value : "");
});
// Host died or closed the pipe — never leave a callback server running.
stdin.on("close", () => loginAbort.abort());

/**
 * pi's `AuthInteraction`. `notify` is fire-and-forget; `prompt` parks until the
 * host answers, the per-prompt signal fires, or the login is aborted.
 *
 * The per-prompt signal matters: providers with a loopback callback server race
 * a `manual_code` prompt against the browser redirect and abort that prompt when
 * the callback wins. Ignoring `prompt.signal` would hang such a login forever.
 */
const interaction = {
  signal: loginAbort.signal,
  notify(event) {
    void emit({ kind: "notify", event });
  },
  prompt(prompt) {
    const requestId = `p${nextPromptId++}`;
    return new Promise((resolve, reject) => {
      const settle = (reason) => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        reject(new Error(reason));
      };
      if (loginAbort.signal.aborted) return settle("login cancelled");
      if (prompt.signal?.aborted) return settle("prompt superseded");

      pending.set(requestId, { resolve });
      loginAbort.signal.addEventListener("abort", () => settle("login cancelled"), {
        once: true,
      });
      prompt.signal?.addEventListener("abort", () => settle("prompt superseded"), {
        once: true,
      });

      // `signal` is a live AbortSignal — strip it before it reaches JSON.
      const { signal: _signal, ...serializable } = prompt;
      void emit({ kind: "prompt", requestId, prompt: serializable });
    });
  },
};

/**
 * Provider inventory with login affordances.
 *
 * `storedCredentialType` is read straight from auth.json and is the only status
 * reported here, because it is exactly what login/logout mutate.
 *
 * Two rejected alternatives: `checkAuth()` refreshes expired OAuth tokens and
 * can execute `!command` API keys, so it is not safe for a plain listing; and
 * `hasConfiguredAuth()` reads a snapshot that only `runAvailabilityRefresh`
 * populates, so under `refreshOnCreate: false` it returns false for every
 * provider. Neither can answer "is this logged in" without side effects.
 *
 * Consequence the UI must respect: a provider usable through an ambient
 * `ANTHROPIC_API_KEY` still reports no stored credential. Status copy therefore
 * describes saved credentials, not overall reachability.
 */
async function runList(pi, runtime) {
  const providers = runtime.getProviders().flatMap((provider) => {
    const oauth = provider.auth?.oauth;
    const apiKey = provider.auth?.apiKey;
    // Ambient-only providers omit `login`; they have nothing to offer here.
    const canOAuth = typeof oauth?.login === "function";
    const canApiKey = typeof apiKey?.login === "function";
    if (!canOAuth && !canApiKey) return [];

    let stored;
    try {
      stored = pi.readStoredCredential(provider.id)?.type;
    } catch {
      stored = undefined;
    }
    return [
      {
        id: provider.id,
        name: provider.name,
        oauth: canOAuth
          ? {
              name: oauth.name,
              isSubscription: oauth.isSubscription === true,
              loginLabel: oauth.loginLabel ?? null,
            }
          : null,
        apiKey: canApiKey ? { name: apiKey.name } : null,
        storedCredentialType: stored ?? null,
      },
    ];
  });
  providers.sort((a, b) => a.name.localeCompare(b.name));
  await exitWith({ kind: "providers", providers }, 0);
}

async function runLogin(runtime) {
  if (method !== "oauth" && method !== "api_key") {
    await exitWith({ kind: "error", message: `unknown login method: ${method}` }, 1);
  }
  const credential = await runtime.login(providerId, method, interaction);
  await exitWith(
    { kind: "done", ok: true, credentialType: credential?.type ?? method },
    0,
  );
}

async function main() {
  if (!distPath || !subcommand) {
    await exitWith({ kind: "error", message: "usage: <dist> <list|login|logout> …" }, 1);
  }
  const pi = await import(pathToFileURL(distPath).href);
  // `refreshOnCreate: false` keeps startup offline and fast; login needs the
  // provider's auth methods, not a fresh model catalog.
  const runtime = await pi.ModelRuntime.create({ refreshOnCreate: false });
  await emit({ kind: "ready" });

  switch (subcommand) {
    case "list":
      return runList(pi, runtime);
    case "login":
      return runLogin(runtime);
    case "logout":
      await runtime.logout(providerId);
      return exitWith({ kind: "done", ok: true, credentialType: null }, 0);
    default:
      return exitWith({ kind: "error", message: `unknown subcommand: ${subcommand}` }, 1);
  }
}

try {
  await main();
} catch (error) {
  // A user-initiated cancel surfaces as pi's AbortError. Reporting that as a
  // failure would make the UI show "This operation was aborted" every time
  // someone closes the dialog, so it gets its own terminal kind.
  if (loginAbort.signal.aborted) {
    await exitWith({ kind: "cancelled" }, 0);
  }
  await exitWith({ kind: "error", message: describe(error) }, 1);
}
