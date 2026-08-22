import assert from "node:assert/strict";
import test from "node:test";
import {
  parseProviderAuthLine,
  parseProviderList,
} from "../../src/lib/backend/desktop/provider-auth";
import { applyEvent, type ActiveLogin } from "../../src/lib/provider-auth/store";
import { mockProviderAuthPort } from "../../src/lib/backend/mock/provider-auth";

test("parses each terminal message the sidecar can emit", () => {
  assert.deepEqual(parseProviderAuthLine('{"kind":"ready"}'), { kind: "ready" });
  assert.deepEqual(parseProviderAuthLine('{"kind":"cancelled"}'), { kind: "cancelled" });
  assert.deepEqual(parseProviderAuthLine('{"kind":"done","credentialType":"oauth"}'), {
    kind: "done",
    credentialType: "oauth",
  });
  // An unrecognized credential type must not be passed through as-is.
  assert.deepEqual(parseProviderAuthLine('{"kind":"done","credentialType":"weird"}'), {
    kind: "done",
    credentialType: null,
  });
  assert.deepEqual(parseProviderAuthLine('{"kind":"error","message":"boom"}'), {
    kind: "error",
    message: "boom",
  });
});

test("ignores lines a future pi or a broken pipe could produce", () => {
  // Non-JSON: pi's ModelRuntime is silent on stdout, but a Node warning or a
  // partially flushed line must not abort an in-flight browser login.
  assert.equal(parseProviderAuthLine("not json at all"), null);
  assert.equal(parseProviderAuthLine("null"), null);
  assert.equal(parseProviderAuthLine('{"kind":"future_message"}'), null);
  assert.equal(parseProviderAuthLine('{"kind":"notify","event":{"type":"unknown"}}'), null);
  // A prompt without a request id could never be answered.
  assert.equal(parseProviderAuthLine('{"kind":"prompt","prompt":{"type":"text","message":"x"}}'), null);
});

test("keeps every auth notification branch the UI renders", () => {
  assert.deepEqual(
    parseProviderAuthLine('{"kind":"notify","event":{"type":"auth_url","url":"https://a.test","instructions":"go"}}'),
    { kind: "notify", event: { type: "auth_url", url: "https://a.test", instructions: "go" } }
  );
  // Copilot's flow: a user code instead of a redirect.
  assert.deepEqual(
    parseProviderAuthLine(
      '{"kind":"notify","event":{"type":"device_code","userCode":"AB-CD","verificationUri":"https://g.test","intervalSeconds":5}}'
    ),
    {
      kind: "notify",
      event: {
        type: "device_code",
        userCode: "AB-CD",
        verificationUri: "https://g.test",
        intervalSeconds: 5,
      },
    }
  );
  assert.deepEqual(
    parseProviderAuthLine('{"kind":"notify","event":{"type":"progress","message":"exchanging"}}'),
    { kind: "notify", event: { type: "progress", message: "exchanging" } }
  );
  assert.deepEqual(
    parseProviderAuthLine(
      '{"kind":"notify","event":{"type":"info","message":"hi","links":[{"url":"https://l.test","label":"docs"},{"bad":1}]}}'
    ),
    {
      kind: "notify",
      event: { type: "info", message: "hi", links: [{ url: "https://l.test", label: "docs" }] },
    }
  );
});

test("rejects prompts the dialog could not render or answer", () => {
  // Missing `message` would render an empty dialog with no way forward.
  assert.equal(parseProviderAuthLine('{"kind":"prompt","requestId":"p1","prompt":{"type":"text"}}'), null);
  // A select with no usable options is unanswerable.
  assert.equal(
    parseProviderAuthLine('{"kind":"prompt","requestId":"p1","prompt":{"type":"select","message":"m","options":[]}}'),
    null
  );
  assert.equal(
    parseProviderAuthLine('{"kind":"prompt","requestId":"p1","prompt":{"type":"select","message":"m"}}'),
    null
  );

  const manual = parseProviderAuthLine(
    '{"kind":"prompt","requestId":"p1","prompt":{"type":"manual_code","message":"paste","placeholder":"code"}}'
  );
  assert.deepEqual(manual, {
    kind: "prompt",
    requestId: "p1",
    prompt: { type: "manual_code", message: "paste", placeholder: "code" },
  });

  const select = parseProviderAuthLine(
    '{"kind":"prompt","requestId":"p2","prompt":{"type":"select","message":"pick","options":[{"id":"a","label":"A"},{"id":"b","label":"B","description":"d"}]}}'
  );
  assert.deepEqual(select, {
    kind: "prompt",
    requestId: "p2",
    prompt: {
      type: "select",
      message: "pick",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B", description: "d" },
      ],
    },
  });
});

test("extracts the provider inventory and drops unusable rows", () => {
  const providers = parseProviderList([
    '{"kind":"ready"}',
    "garbage",
    JSON.stringify({
      kind: "providers",
      providers: [
        {
          id: "anthropic",
          name: "Anthropic",
          oauth: { name: "Anthropic (Claude Pro/Max)", isSubscription: true, loginLabel: null },
          apiKey: { name: "Anthropic API key" },
          storedCredentialType: "oauth",
        },
        // No login method at all — nothing the user could act on.
        { id: "ambient", name: "Ambient", oauth: null, apiKey: null, storedCredentialType: null },
        // Malformed row.
        { name: "No id", apiKey: { name: "k" } },
        {
          id: "deepseek",
          name: "DeepSeek",
          oauth: null,
          apiKey: { name: "DeepSeek API key" },
          storedCredentialType: "bogus",
        },
      ],
    }),
  ]);

  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["anthropic", "deepseek"]
  );
  assert.equal(providers[0].oauth?.isSubscription, true);
  // An unrecognized stored type degrades to "nothing saved" rather than leaking.
  assert.equal(providers[1].storedCredentialType, null);
});

test("surfaces a helper error instead of returning an empty list", () => {
  assert.throws(
    () => parseProviderList(['{"kind":"ready"}', '{"kind":"error","message":"pi missing"}']),
    /pi missing/
  );
  assert.throws(() => parseProviderList(['{"kind":"ready"}']), /no provider list/);
});

function activeLogin(): ActiveLogin {
  return {
    providerId: "anthropic",
    method: "oauth",
    phase: "starting",
    authUrl: null,
    deviceCode: null,
    progress: null,
    info: null,
    prompt: null,
    answering: false,
    error: null,
  };
}

test("folds flow events into the active login", () => {
  const started = applyEvent(activeLogin(), { kind: "ready" });
  assert.equal(started?.phase, "starting");

  const browsing = applyEvent(activeLogin(), {
    kind: "notify",
    event: { type: "auth_url", url: "https://a.test" },
  });
  assert.equal(browsing?.phase, "waiting-browser");
  assert.equal(browsing?.authUrl, "https://a.test");

  const asking = applyEvent(browsing!, {
    kind: "prompt",
    requestId: "p1",
    prompt: { type: "manual_code", message: "paste" },
  });
  assert.equal(asking?.phase, "awaiting-input");
  assert.equal(asking?.prompt?.requestId, "p1");
  // The URL survives so it stays copyable while the prompt is open.
  assert.equal(asking?.authUrl, "https://a.test");

  const done = applyEvent(asking!, { kind: "done", credentialType: "oauth" });
  assert.equal(done?.phase, "done");
  assert.equal(done?.prompt, null);

  const failed = applyEvent(asking!, { kind: "error", message: "nope" });
  assert.equal(failed?.phase, "error");
  assert.equal(failed?.error, "nope");
  assert.equal(failed?.prompt, null);

  // Cancellation closes the dialog rather than showing pi's raw AbortError.
  assert.equal(applyEvent(asking!, { kind: "cancelled" }), null);

  // Progress must not clobber the phase the dialog is rendering.
  const progressed = applyEvent(browsing!, {
    kind: "notify",
    event: { type: "progress", message: "exchanging" },
  });
  assert.equal(progressed?.phase, "waiting-browser");
  assert.equal(progressed?.progress, "exchanging");
});

test("mock port satisfies the flow the UI drives", async () => {
  const events: string[] = [];
  const unsubscribe = mockProviderAuthPort.onEvent((event) => events.push(event.kind));

  const providers = await mockProviderAuthPort.listProviders();
  assert.ok(providers.length > 0);
  // Each row must offer at least one way in, or the UI renders a dead entry.
  assert.ok(providers.every((provider) => provider.oauth || provider.apiKey));
  assert.ok(providers.some((provider) => provider.oauth?.isSubscription));

  await mockProviderAuthPort.beginLogin("anthropic", "oauth");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(events.includes("notify"), `expected a notify, got ${events.join(",")}`);
  assert.ok(events.includes("prompt"), `expected a prompt, got ${events.join(",")}`);

  await mockProviderAuthPort.cancelLogin();
  assert.ok(events.includes("cancelled"));

  await mockProviderAuthPort.logout("anthropic");
  const after = await mockProviderAuthPort.listProviders();
  assert.equal(
    after.find((provider) => provider.id === "anthropic")?.storedCredentialType,
    null
  );
  unsubscribe();
});
