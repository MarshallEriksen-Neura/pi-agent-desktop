import type {
  AuthProviderDto,
  ProviderAuthEventDto,
  ProviderAuthMethod,
  ProviderAuthPort,
} from "../ports/provider-auth";

/**
 * Browser-preview mock for {@link ProviderAuthPort}.
 *
 * `pnpm dev` runs without Tauri, so this drives the login UI from a scripted
 * flow instead of pi. The provider list mirrors the real inventory closely
 * enough to exercise every branch the UI has to render:
 *
 *  - `anthropic` — subscription OAuth with an API-key alternative, already
 *    logged in (so logout and the "signed in" badge are reachable)
 *  - `openai-codex` — subscription OAuth that opens with a `select` step
 *  - `github-copilot` — the device-code branch, which shows a user code
 *    instead of redirecting
 *  - `openrouter` — non-subscription OAuth with a provider-authored label
 *  - `deepseek` — API-key only, the shape most providers have
 *
 * Timings are short (150–400 ms) so loading states are visible without making
 * the preview feel slow.
 */

const PROVIDERS: AuthProviderDto[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    oauth: { name: "Anthropic (Claude Pro/Max)", isSubscription: true, loginLabel: null },
    apiKey: { name: "Anthropic API key" },
    storedCredentialType: "oauth",
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    oauth: { name: "GitHub Copilot", isSubscription: true, loginLabel: null },
    apiKey: null,
    storedCredentialType: null,
  },
  {
    id: "openai-codex",
    name: "OpenAI",
    oauth: { name: "OpenAI (ChatGPT Plus/Pro)", isSubscription: true, loginLabel: null },
    apiKey: { name: "OpenAI API key" },
    storedCredentialType: null,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    oauth: {
      name: "OpenRouter OAuth",
      isSubscription: false,
      loginLabel: "Sign in with OpenRouter",
    },
    apiKey: { name: "OpenRouter API key" },
    storedCredentialType: null,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    oauth: null,
    apiKey: { name: "DeepSeek API key" },
    storedCredentialType: "api_key",
  },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let providers: AuthProviderDto[] = PROVIDERS.map((provider) => ({ ...provider }));
const handlers = new Set<(event: ProviderAuthEventDto) => void>();
/** Request id of the prompt awaiting an answer, or null when none is. */
let awaiting: string | null = null;
let cancelled = false;
let promptCounter = 0;
/** Provider of the active flow, so a successful login updates the right row. */
let activeProvider: string | null = null;

function emit(event: ProviderAuthEventDto): void {
  handlers.forEach((handler) => handler(event));
}

function setStored(providerId: string, type: ProviderAuthMethod | null): void {
  providers = providers.map((provider) =>
    provider.id === providerId ? { ...provider, storedCredentialType: type } : provider
  );
}

/** Scripted flow, chosen so each provider exercises a different UI branch. */
async function runFlow(providerId: string, method: ProviderAuthMethod): Promise<void> {
  emit({ kind: "ready" });
  await sleep(150);
  if (cancelled) return;

  if (method === "api_key") {
    awaiting = `mock-${++promptCounter}`;
    emit({
      kind: "prompt",
      requestId: awaiting,
      prompt: { type: "secret", message: "Enter your API key:", placeholder: "sk-…" },
    });
    return;
  }

  if (providerId === "openai-codex") {
    awaiting = `mock-${++promptCounter}`;
    emit({
      kind: "prompt",
      requestId: awaiting,
      prompt: {
        type: "select",
        message: "Select OpenAI Codex login method:",
        options: [
          { id: "subscription", label: "Sign in with ChatGPT" },
          { id: "api_key", label: "Use an API key" },
        ],
      },
    });
    return;
  }

  if (providerId === "github-copilot") {
    emit({
      kind: "notify",
      event: {
        type: "device_code",
        userCode: "MOCK-C0DE",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    });
    await sleep(400);
    if (cancelled) return;
    emit({ kind: "notify", event: { type: "progress", message: "Waiting for authorization…" } });
    return;
  }

  emit({
    kind: "notify",
    event: {
      type: "auth_url",
      url: `https://example.test/oauth/authorize?provider=${providerId}&mock=1`,
      instructions: "Complete login in your browser, or paste the redirect URL here.",
    },
  });
  await sleep(250);
  if (cancelled) return;
  awaiting = `mock-${++promptCounter}`;
  emit({
    kind: "prompt",
    requestId: awaiting,
    prompt: {
      type: "manual_code",
      message: "Complete login in your browser, or paste the authorization code here:",
    },
  });
}

export const mockProviderAuthPort = {
  listProviders: async () => {
    await sleep(200);
    return providers.map((provider) => ({ ...provider }));
  },
  beginLogin: async (providerId: string, method: ProviderAuthMethod) => {
    cancelled = false;
    awaiting = null;
    activeProvider = providerId;
    void runFlow(providerId, method);
  },
  answerPrompt: async (requestId: string, value: string) => {
    if (awaiting !== requestId) return;
    awaiting = null;
    await sleep(300);
    if (cancelled) return;
    // An empty answer models the loopback callback winning the race: the flow
    // completes without the user pasting anything.
    emit({ kind: "notify", event: { type: "progress", message: "Exchanging credentials…" } });
    await sleep(250);
    if (cancelled) return;
    const method: ProviderAuthMethod = value.startsWith("sk-") ? "api_key" : "oauth";
    if (activeProvider) setStored(activeProvider, method);
    emit({ kind: "done", credentialType: method });
    activeProvider = null;
  },
  cancelLogin: async () => {
    cancelled = true;
    awaiting = null;
    activeProvider = null;
    emit({ kind: "cancelled" });
  },
  logout: async (providerId: string) => {
    await sleep(200);
    setStored(providerId, null);
  },
  onEvent: (handler: (event: ProviderAuthEventDto) => void) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
} satisfies ProviderAuthPort;
