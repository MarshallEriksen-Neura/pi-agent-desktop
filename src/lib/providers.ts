/**
 * Pure provider metadata (no JSX) — used by both UI components and model-icon
 * resolution. Add new providers here; components will pick them up automatically.
 */
export interface ProviderMetaDef {
  /** Display name. */
  label: string;
  /** Icon registry key from components/icons.tsx. */
  iconKey: string;
  /** Brand color used behind the icon / provider badge. */
  color: string;
  /** Additional keys that may appear as provider ids (e.g. "qwen" -> "alibaba"). */
  aliases?: string[];
}

export const PROVIDER_DEFS = {
  // International — closed / frontier
  openai: {
    label: "OpenAI",
    iconKey: "openai",
    color: "#10A37F",
  },
  anthropic: {
    label: "Anthropic",
    iconKey: "claude",
    color: "#C15F3C",
  },
  google: {
    label: "Google",
    iconKey: "gemini",
    color: "#4285F4",
  },
  xai: {
    label: "xAI",
    iconKey: "xai",
    color: "#000000",
  },

  // International — open / startup
  meta: {
    label: "Meta",
    iconKey: "meta",
    color: "#0081FB",
  },
  mistral: {
    label: "Mistral",
    iconKey: "mistral",
    color: "#F7D486",
  },
  cohere: {
    label: "Cohere",
    iconKey: "cohere",
    color: "#D18EE2",
  },
  ai21: {
    label: "AI21",
    iconKey: "cohere",
    color: "#4353FF",
  },
  perplexity: {
    label: "Perplexity",
    iconKey: "perplexity",
    color: "#22B8CF",
  },

  // Chinese
  deepseek: {
    label: "DeepSeek",
    iconKey: "deepseek",
    color: "#4D6BFA",
  },
  alibaba: {
    label: "Alibaba",
    iconKey: "qwen",
    color: "#FF6A00",
    aliases: ["qwen", "tongyi"],
  },
  moonshot: {
    label: "Moonshot",
    iconKey: "kimi",
    color: "#000000",
    aliases: ["kimi"],
  },
  zhipu: {
    label: "Zhipu",
    iconKey: "zhipu",
    color: "#1E64E6",
    aliases: ["glm", "chatglm"],
  },
  bytedance: {
    label: "ByteDance",
    iconKey: "doubao",
    color: "#3C8CFF",
    aliases: ["doubao"],
  },
  baidu: {
    label: "Baidu",
    iconKey: "baidu",
    color: "#2932E1",
    aliases: ["ernie", "wenxin"],
  },
  tencent: {
    label: "Tencent",
    iconKey: "hunyuan",
    color: "#00A3FF",
    aliases: ["hunyuan"],
  },
  iflytek: {
    label: "iFlytek",
    iconKey: "spark",
    color: "#E60012",
    aliases: ["spark"],
  },
  baichuan: {
    label: "Baichuan",
    iconKey: "baichuan",
    color: "#FF6B35",
  },
  "01ai": {
    label: "01.AI",
    iconKey: "yi",
    color: "#4D6BFA",
    aliases: ["yi"],
  },
  minimax: {
    label: "MiniMax",
    iconKey: "minimax",
    color: "#FF4D6D",
  },
  stepfun: {
    label: "Stepfun",
    iconKey: "stepfun",
    color: "#7B61FF",
  },

  // Aggregators / cloud
  openrouter: {
    label: "OpenRouter",
    iconKey: "openrouter",
    color: "#3578E5",
  },
  azure: {
    label: "Azure",
    iconKey: "openai",
    color: "#0078D4",
    aliases: ["azure-openai"],
  },
  aws: {
    label: "AWS",
    iconKey: "claude",
    color: "#FF9900",
    aliases: ["bedrock"],
  },
  groq: {
    label: "Groq",
    iconKey: "openai",
    color: "#F55036",
  },
  together: {
    label: "Together",
    iconKey: "openai",
    color: "#3B82F6",
  },
  fireworks: {
    label: "Fireworks",
    iconKey: "openai",
    color: "#FF5A36",
  },

  // Legacy / project-specific
  zai: {
    label: "Z.ai",
    iconKey: "openai",
    color: "#6E56CF",
    aliases: ["z-ai"],
  },
} satisfies Record<string, ProviderMetaDef>;

export type ProviderKey = keyof typeof PROVIDER_DEFS;

const ALIAS_TO_KEY: Record<string, ProviderKey> = Object.entries(
  PROVIDER_DEFS
).reduce((acc, [key, def]: [string, ProviderMetaDef]) => {
  def.aliases?.forEach((alias) => {
    acc[alias] = key as ProviderKey;
  });
  return acc;
}, {} as Record<string, ProviderKey>);

/** Resolve a raw provider id to a known provider key, using aliases. */
export function resolveProviderKey(id: string): ProviderKey | undefined {
  const normalized = id.toLowerCase().trim();
  if (normalized in PROVIDER_DEFS) return normalized as ProviderKey;
  return ALIAS_TO_KEY[normalized];
}
