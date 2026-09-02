/**
 * Provider login — OAuth subscriptions (Claude Pro/Max, ChatGPT Plus/Pro,
 * Copilot, xAI, Kimi, OpenRouter, Radius) and API keys.
 *
 * The flow is interactive and long-lived: pi emits notifications and asks
 * questions while the user is in a browser, so this port is event-driven like
 * {@link PiProcessPort} rather than request/response like
 * {@link PiConfigurationPort}.
 */

/** How a provider can be logged into. */
export type ProviderAuthMethod = "oauth" | "api_key";

/** OAuth affordances, present only when the provider implements a flow. */
export interface ProviderOAuthInfoDto {
  /** Display name, e.g. "Anthropic (Claude Pro/Max)". */
  name: string;
  /** True when access is backed by a paid subscription rather than credits. */
  isSubscription: boolean;
  /** Provider-authored button label, e.g. "Sign in with SuperGrok or X Premium". */
  loginLabel: string | null;
}

export interface ProviderApiKeyInfoDto {
  /** Display name, e.g. "Anthropic API key". */
  name: string;
}

export interface AuthProviderDto {
  id: string;
  name: string;
  oauth: ProviderOAuthInfoDto | null;
  apiKey: ProviderApiKeyInfoDto | null;
  /**
   * Credential type currently saved in pi's auth.json, or null when none is.
   *
   * This reflects saved credentials only — a provider reachable through an
   * ambient environment variable reports null, because there is nothing here to
   * log out of. Status copy must not present it as overall reachability.
   */
  storedCredentialType: ProviderAuthMethod | null;
}

/** A question pi needs answered to continue. Mirrors pi's `AuthPrompt`. */
export interface AuthPromptDto {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: { id: string; label: string; description?: string }[];
}

/** A link pi wants shown alongside an informational message. */
export interface AuthInfoLinkDto {
  url: string;
  label?: string;
}

/** Progress notification. Mirrors pi's `AuthEvent`. */
export type AuthNotifyDto =
  | { type: "info"; message: string; links?: AuthInfoLinkDto[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | {
      type: "device_code";
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: "progress"; message: string };

/** Normalized login-flow event. */
export type ProviderAuthEventDto =
  | { kind: "ready" }
  | { kind: "notify"; event: AuthNotifyDto }
  | { kind: "prompt"; requestId: string; prompt: AuthPromptDto }
  | { kind: "done"; credentialType: ProviderAuthMethod | null }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface ProviderAuthPort {
  /** Providers that support an interactive login, with saved-credential status. */
  listProviders(): Promise<AuthProviderDto[]>;
  /**
   * Start a login. Resolves once the flow has started; progress arrives through
   * {@link onEvent}.
   */
  beginLogin(providerId: string, method: ProviderAuthMethod): Promise<void>;
  /** Answer a `prompt` event. `requestId` must match the one received. */
  answerPrompt(requestId: string, value: string): Promise<void>;
  /** Abort the active login. Safe to call when none is running. */
  cancelLogin(): Promise<void>;
  /** Remove a saved credential. */
  logout(providerId: string): Promise<void>;
  /** Subscribe to login-flow events. Returns an unsubscribe function. */
  onEvent(handler: (event: ProviderAuthEventDto) => void): () => void;
}
