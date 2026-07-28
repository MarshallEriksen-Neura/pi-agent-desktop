import { PROVIDER_DEFS, resolveProviderKey } from "./providers";

/** Normalize messy model ids so rules can match them cleanly. */
export function normalizeModelId(id: string): string {
  return id
    .toLowerCase()
    .replace(/^[^/]+\//, "") // strip "openai/" or "z-ai/" namespace prefixes
    .replace(/(:free|:cloud|:latest|@\d+)$/g, "") // strip :free / :cloud / @version
    .replace(/-\d{8}$/g, "") // strip trailing -20240806 date suffixes
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

interface ModelRule {
  test: RegExp;
  providerKey: keyof typeof PROVIDER_DEFS;
}

/**
 * Rules are ordered from most-specific to least-specific.
 * They run against the *normalized* model id.
 */
const MODEL_RULES: ModelRule[] = [
  // OpenAI — specific series
  { test: /^(gpt-4o|chatgpt-4o)/, providerKey: "openai" },
  { test: /^gpt-4/, providerKey: "openai" },
  { test: /^chatgpt/, providerKey: "openai" },
  { test: /^gpt-/, providerKey: "openai" },
  { test: /^(o1|o3)/, providerKey: "openai" },
  { test: /^dall-e/, providerKey: "openai" },

  // Anthropic
  { test: /^claude-3-5-sonnet/, providerKey: "anthropic" },
  { test: /^claude-3-opus/, providerKey: "anthropic" },
  { test: /^claude-3-haiku/, providerKey: "anthropic" },
  { test: /^claude/, providerKey: "anthropic" },

  // Google
  { test: /^gemini-1-5-pro/, providerKey: "google" },
  { test: /^gemini-1-5-flash/, providerKey: "google" },
  { test: /^gemini/, providerKey: "google" },

  // xAI
  { test: /^grok/, providerKey: "xai" },

  // DeepSeek
  { test: /^deepseek-r1/, providerKey: "deepseek" },
  { test: /^deepseek-v3/, providerKey: "deepseek" },
  { test: /^deepseek/, providerKey: "deepseek" },

  // Chinese providers
  { test: /^(qwen|tongyi)/, providerKey: "alibaba" },
  { test: /^(kimi|moonshot)/, providerKey: "moonshot" },
  { test: /^(glm|chatglm)/, providerKey: "zhipu" },
  { test: /^doubao/, providerKey: "bytedance" },
  { test: /^(ernie|wenxin)/, providerKey: "baidu" },
  { test: /^hunyuan/, providerKey: "tencent" },
  { test: /^spark/, providerKey: "iflytek" },
  { test: /^baichuan/, providerKey: "baichuan" },
  { test: /^(yi|01-yi)/, providerKey: "01ai" },
  { test: /^minimax/, providerKey: "minimax" },
  { test: /^step/, providerKey: "stepfun" },

  // International — open / startup
  { test: /^mistral/, providerKey: "mistral" },
  { test: /^mixtral/, providerKey: "mistral" },
  { test: /^command/, providerKey: "cohere" },
  { test: /^jamba/, providerKey: "ai21" },
  { test: /^llama/, providerKey: "meta" },
];

export interface ResolvedMeta {
  /** Provider display name. */
  label: string;
  /** Icon key for components/icons.tsx. */
  iconKey: string;
  /** Brand color. */
  color: string;
}

/**
 * Resolve a model's icon / color / label from its id and (optionally) its provider.
 *
 * Strategy:
 * 1. Normalize the model id.
 * 2. Try to match against MODEL_RULES.
 * 3. Fall back to the provider key lookup.
 * 4. Return undefined if nothing matched.
 */
export function resolveModelMeta(
  modelId: string,
  providerId?: string
): ResolvedMeta | undefined {
  const normalized = normalizeModelId(modelId);

  // 1. Model-id prefix rules
  const rule = MODEL_RULES.find((r) => r.test.test(normalized));
  if (rule) {
    const def = PROVIDER_DEFS[rule.providerKey];
    return { label: def.label, iconKey: def.iconKey, color: def.color };
  }

  // 2. Provider key lookup (includes aliases)
  if (providerId) {
    const key = resolveProviderKey(providerId);
    if (key) {
      const def = PROVIDER_DEFS[key];
      return { label: def.label, iconKey: def.iconKey, color: def.color };
    }
  }

  return undefined;
}

/**
 * Return a meta guaranteed to exist — for unknown providers we still show
 * a label and a color, but use the fallback icon key.
 */
export function resolveModelMetaOrFallback(
  modelId: string,
  providerId?: string
): ResolvedMeta {
  return (
    resolveModelMeta(modelId, providerId) ?? {
      label: providerId ?? modelId,
      iconKey: "fallback",
      color: hashColor(providerId ?? modelId),
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Fallback color helper (same algorithm as provider-meta.tsx)                */
/* -------------------------------------------------------------------------- */

const FALLBACK_PALETTE = [
  "#2c5aa0", // indigo
  "#c45c48", // cinnabar
  "#2e7d5a", // ink green
  "#b8860b", // ochre
  "#6e4e8f", // violet
  "#5f7a7a", // teal-grey
  "#a65e5e", // rouge
  "#4a7c8c", // stone blue
];

function hashColor(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = input.charCodeAt(i) + ((hash << 5) - hash);
  }
  const idx = Math.abs(hash) % FALLBACK_PALETTE.length;
  return FALLBACK_PALETTE[idx];
}
