import { listen } from "@tauri-apps/api/event";
import type {
  AuthNotifyDto,
  AuthPromptDto,
  AuthProviderDto,
  ProviderAuthEventDto,
  ProviderAuthMethod,
  ProviderAuthPort,
} from "../ports/provider-auth";
import { desktopInvoke } from "./invoke";

type Unlisten = () => void;

/** Payload of the `provider-auth://event` Tauri event. */
interface SidecarEventPayload {
  line: string;
}

function isSidecarPayload(value: unknown): value is SidecarEventPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as SidecarEventPayload).line === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PROMPT_TYPES = ["text", "secret", "select", "manual_code"] as const;

/**
 * Validate a prompt rather than trusting it.
 *
 * The UI switches on `type` and renders `message`, so a message missing either
 * would render an empty dialog with no way forward. Rejecting it here surfaces
 * as "unrecognized message" instead.
 */
function toPrompt(value: unknown): AuthPromptDto | null {
  if (!isRecord(value)) return null;
  const type = PROMPT_TYPES.find((candidate) => candidate === value.type);
  if (!type || typeof value.message !== "string") return null;

  const prompt: AuthPromptDto = { type, message: value.message };
  if (typeof value.placeholder === "string") prompt.placeholder = value.placeholder;
  if (type === "select") {
    if (!Array.isArray(value.options)) return null;
    const options = value.options.flatMap((option) =>
      isRecord(option) && typeof option.id === "string" && typeof option.label === "string"
        ? [
            {
              id: option.id,
              label: option.label,
              ...(typeof option.description === "string"
                ? { description: option.description }
                : {}),
            },
          ]
        : []
    );
    // A select with nothing selectable is unanswerable.
    if (options.length === 0) return null;
    prompt.options = options;
  }
  return prompt;
}

/** Validate a progress notification, discarding shapes the UI cannot render. */
function toNotify(value: unknown): AuthNotifyDto | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case "info": {
      if (typeof value.message !== "string") return null;
      const links = Array.isArray(value.links)
        ? value.links.flatMap((link) =>
            isRecord(link) && typeof link.url === "string"
              ? [
                  {
                    url: link.url,
                    ...(typeof link.label === "string" ? { label: link.label } : {}),
                  },
                ]
              : []
          )
        : undefined;
      return { type: "info", message: value.message, ...(links?.length ? { links } : {}) };
    }
    case "auth_url":
      return typeof value.url === "string"
        ? {
            type: "auth_url",
            url: value.url,
            ...(typeof value.instructions === "string"
              ? { instructions: value.instructions }
              : {}),
          }
        : null;
    case "device_code":
      return typeof value.userCode === "string" && typeof value.verificationUri === "string"
        ? {
            type: "device_code",
            userCode: value.userCode,
            verificationUri: value.verificationUri,
            ...(typeof value.intervalSeconds === "number"
              ? { intervalSeconds: value.intervalSeconds }
              : {}),
            ...(typeof value.expiresInSeconds === "number"
              ? { expiresInSeconds: value.expiresInSeconds }
              : {}),
          }
        : null;
    case "progress":
      return typeof value.message === "string"
        ? { type: "progress", message: value.message }
        : null;
    default:
      return null;
  }
}

/**
 * Parse one sidecar JSONL line into a port event.
 *
 * Returns null for anything unrecognized so a future pi/helper message, or a
 * stray non-JSON line, cannot break an in-flight login. Exported for tests.
 */
export function parseProviderAuthLine(line: string): ProviderAuthEventDto | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;

  switch (raw.kind) {
    case "ready":
      return { kind: "ready" };
    case "notify": {
      const event = toNotify(raw.event);
      return event ? { kind: "notify", event } : null;
    }
    case "prompt": {
      if (typeof raw.requestId !== "string") return null;
      const prompt = toPrompt(raw.prompt);
      return prompt ? { kind: "prompt", requestId: raw.requestId, prompt } : null;
    }
    case "done":
      return { kind: "done", credentialType: toCredentialType(raw.credentialType) };
    case "cancelled":
      return { kind: "cancelled" };
    case "error":
      return {
        kind: "error",
        message: typeof raw.message === "string" ? raw.message : "login failed",
      };
    default:
      return null;
  }
}

function toCredentialType(value: unknown): ProviderAuthMethod | null {
  return value === "oauth" || value === "api_key" ? value : null;
}

/**
 * Validate one provider row. A row with no login method is dropped rather than
 * rendered as a dead entry the user cannot act on.
 */
function toProvider(value: unknown): AuthProviderDto | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") return null;

  const oauth = isRecord(value.oauth) && typeof value.oauth.name === "string"
    ? {
        name: value.oauth.name,
        isSubscription: value.oauth.isSubscription === true,
        loginLabel:
          typeof value.oauth.loginLabel === "string" ? value.oauth.loginLabel : null,
      }
    : null;
  const apiKey =
    isRecord(value.apiKey) && typeof value.apiKey.name === "string"
      ? { name: value.apiKey.name }
      : null;
  if (!oauth && !apiKey) return null;

  return {
    id: value.id,
    name: value.name,
    oauth,
    apiKey,
    storedCredentialType: toCredentialType(value.storedCredentialType),
  };
}

/**
 * Pull the provider inventory out of a one-shot helper run.
 *
 * The helper emits `ready` before the payload, and surfaces failures as an
 * `error` message rather than a non-zero exit alone. Exported for tests.
 */
export function parseProviderList(lines: string[]): AuthProviderDto[] {
  let providers: AuthProviderDto[] | null = null;
  for (const line of lines) {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(raw)) continue;
    if (raw.kind === "error") {
      throw new Error(typeof raw.message === "string" ? raw.message : "login helper failed");
    }
    if (raw.kind === "providers" && Array.isArray(raw.providers)) {
      providers = raw.providers.flatMap((entry) => {
        const provider = toProvider(entry);
        return provider ? [provider] : [];
      });
    }
  }
  if (!providers) throw new Error("the login helper returned no provider list");
  return providers;
}

class DesktopProviderAuthPort implements ProviderAuthPort {
  private readonly handlers = new Set<(event: ProviderAuthEventDto) => void>();
  private unlisten: Unlisten | null = null;
  /** Guards against concurrent `ensureListener` calls double-subscribing. */
  private subscribing: Promise<void> | null = null;

  async listProviders(): Promise<AuthProviderDto[]> {
    const lines = await desktopInvoke<string[]>("provider_auth_list");
    return parseProviderList(lines);
  }

  async beginLogin(providerId: string, method: ProviderAuthMethod): Promise<void> {
    // Subscribe first: the helper can emit before `beginLogin` resolves.
    await this.ensureListener();
    await desktopInvoke("provider_auth_begin", { providerId, method });
  }

  async answerPrompt(requestId: string, value: string): Promise<void> {
    await desktopInvoke("provider_auth_answer", { requestId, value });
  }

  async cancelLogin(): Promise<void> {
    await desktopInvoke("provider_auth_cancel");
  }

  async logout(providerId: string): Promise<void> {
    const lines = await desktopInvoke<string[]>("provider_auth_logout", { providerId });
    // Surfaces a helper-reported failure that the command itself reported as ok.
    for (const line of lines) {
      const event = parseProviderAuthLine(line);
      if (event?.kind === "error") throw new Error(event.message);
    }
  }

  onEvent(handler: (event: ProviderAuthEventDto) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  private async ensureListener(): Promise<void> {
    if (this.unlisten) return;
    if (this.subscribing) return this.subscribing;
    this.subscribing = listen<unknown>("provider-auth://event", (event) => {
      if (!isSidecarPayload(event.payload)) return;
      const parsed = parseProviderAuthLine(event.payload.line);
      if (!parsed) return;
      this.handlers.forEach((handler) => handler(parsed));
    })
      .then((unlisten) => {
        this.unlisten = unlisten;
      })
      .finally(() => {
        this.subscribing = null;
      });
    return this.subscribing;
  }
}

export function createDesktopProviderAuthPort(): ProviderAuthPort {
  return new DesktopProviderAuthPort();
}
