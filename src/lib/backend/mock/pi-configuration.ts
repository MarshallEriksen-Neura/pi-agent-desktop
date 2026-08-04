import type {
  CliResultDto,
  PiConfigurationPort,
  PiSkillDirectoryEntryDto,
  SettingsScopeFileDto,
} from "../ports";
import type { ProviderConfig } from "../../pi/models";
import type { SettingsScope } from "../../pi/settings";
import type { PiCliUpdateInfo } from "../../pi/cli-update";

export interface MockPiConfigurationOptions {
  settings?: Partial<Record<SettingsScope | "models", SettingsScopeFileDto>>;
  skillFiles?: Record<string, string>;
  skillDirectories?: Record<string, PiSkillDirectoryEntryDto[]>;
}

const DEFAULT_SETTINGS: Record<SettingsScope | "models", SettingsScopeFileDto> = {
  global: {
    path: "~/.pi/agent/settings.json",
    exists: true,
    content:
      JSON.stringify(
        {
          defaultProvider: "anthropic",
          defaultModel: "claude-sonnet-4-5",
          defaultThinkingLevel: "medium",
          theme: "dark",
          defaultProjectTrust: "ask",
          compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
          packages: [
            "npm:pi-skills",
            "npm:@juanibiapina/pi-powerbar",
            "git:github.com/user/pi-tools@v1",
          ],
        },
        null,
        2
      ) + "\n",
  },
  project: {
    path: ".pi/settings.json",
    exists: false,
    content: "",
  },
  models: {
    path: "~/.pi/agent/models.json",
    exists: true,
    content:
      JSON.stringify(
        {
          providers: {
            "my-proxy": {
              baseUrl: "https://api.example.com/v1",
              api: "openai-completions",
              apiKey: "sk-mock",
              models: [
                {
                  id: "gpt-5-mini",
                  name: "GPT-5 Mini (proxy)",
                  reasoning: true,
                  input: ["text", "image"],
                  contextWindow: 200000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
        null,
        2
      ) + "\n",
  },
};

const MOCK_MODEL_IDS = [
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4-turbo",
  "o3-mini",
  "text-embedding-3-small",
];

export function createMockPiConfigurationPort(
  options: MockPiConfigurationOptions = {}
): PiConfigurationPort {
  const settings = new Map<SettingsScope | "models", SettingsScopeFileDto>(
    (["global", "project", "models"] as const).map((scope) => [
      scope,
      { ...DEFAULT_SETTINGS[scope], ...options.settings?.[scope] },
    ])
  );
  const skillFiles = new Map(Object.entries(options.skillFiles ?? {}));
  const skillDirectories = new Map(Object.entries(options.skillDirectories ?? {}));

  return {
    readSettings: async (scope) => ({ ...(settings.get(scope) ?? DEFAULT_SETTINGS[scope]) }),

    writeSettings: async (scope, content) => {
      const current = settings.get(scope) ?? DEFAULT_SETTINGS[scope];
      settings.set(scope, { ...current, exists: true, content });
    },

    fetchModels: async (_config: ProviderConfig) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [...MOCK_MODEL_IDS];
    },

    runPiCli: async (args: string[]): Promise<CliResultDto> => ({
      code: 0,
      stdout: `(mock) pi ${args.join(" ")}\n`,
      stderr: "",
    }),

    checkPiCliUpdate: async (): Promise<PiCliUpdateInfo> => ({
      installed: null,
      latest: null,
      updateAvailable: false,
    }),

    readSkillFile: async (path: string) => {
      const content = skillFiles.get(path);
      if (content === undefined) throw new Error(`Mock skill file not found: ${path}`);
      return content;
    },

    listSkillDirectory: async (path: string) => skillDirectories.get(path) ?? [],
  };
}
