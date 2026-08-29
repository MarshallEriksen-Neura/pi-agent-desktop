import type {
  CliResultDto,
  McpAdapterStatusDto,
  McpDiscoverySourceDto,
  PiConfigurationPort,
  PiSkillDirectoryEntryDto,
  SettingsScopeFileDto,
  SkillCatalogHitDto,
} from "../ports";
import type { ProviderConfig } from "../../pi/models";
import type { SettingsScope } from "../../pi/settings";
import type { PiCliUpdateInfo } from "../../pi/cli-update";

export interface MockPiConfigurationOptions {
  settings?: Partial<Record<SettingsScope | "models", SettingsScopeFileDto>>;
  skillFiles?: Record<string, string>;
  skillDirectories?: Record<string, PiSkillDirectoryEntryDto[]>;
  mcpAdapterInstalled?: boolean;
  mcpOtherConfigPaths?: string[];
  mcpSources?: McpDiscoverySourceDto[];
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

/** Catalogue hits for browser preview — a name that several repos publish. */
const MOCK_CATALOG: SkillCatalogHitDto[] = [
  {
    id: "vercel-labs/agent-skills/frontend-design",
    skillId: "frontend-design",
    name: "frontend-design",
    source: "vercel-labs/agent-skills",
    installs: 673399,
  },
  {
    id: "anthropics/skills/pdf",
    skillId: "pdf",
    name: "pdf",
    source: "anthropics/skills",
    installs: 412800,
  },
  {
    id: "some-fork/skills/pdf",
    skillId: "pdf",
    name: "pdf",
    source: "some-fork/skills",
    installs: 1820,
  },
];

/** `skills add <source> --list` output, box-drawing prefixes and all. */
const MOCK_SKILLS_LIST = [
  "│",
  "◇  Found 3 skills",
  "",
  "◇  Available Skills",
  "Document Skills",
  "│",
  "│    pdf",
  "│",
  "│      Read, merge, split, and fill PDF files.",
  "│",
  "│    docx",
  "│",
  "│      Create and edit Word documents.",
  "",
  "General",
  "│",
  "│    frontend-design",
  "│",
  "│      Distinctive, intentional visual design guidance.",
  "",
  "└  Use --skill <name> to install specific skills",
  "",
].join("\n");

export function createMockPiConfigurationPort(
  options: MockPiConfigurationOptions = {}
): PiConfigurationPort {
  const settings = new Map<SettingsScope | "models", SettingsScopeFileDto>(
    (["global", "project", "models"] as const).map((scope) => [
      scope,
      { ...DEFAULT_SETTINGS[scope], ...options.settings?.[scope] },
    ])
  );
  const mcpSettings = new Map<SettingsScope, SettingsScopeFileDto>([
    [
      "global",
      {
        path: "~/.pi/agent/mcp.json",
        exists: false,
        content: "",
      },
    ],
    ["project", { path: ".pi/mcp.json", exists: false, content: "" }],
  ]);
  const skillFiles = new Map(Object.entries(options.skillFiles ?? {}));
  const skillDirectories = new Map(Object.entries(options.skillDirectories ?? {}));
  const mcpAdapterStatus: McpAdapterStatusDto = {
    installed: options.mcpAdapterInstalled ?? false,
    otherConfigPaths: options.mcpOtherConfigPaths ?? [],
  };

  return {
    readSettings: async (scope) => ({ ...(settings.get(scope) ?? DEFAULT_SETTINGS[scope]) }),

    writeSettings: async (scope, content) => {
      const current = settings.get(scope) ?? DEFAULT_SETTINGS[scope];
      settings.set(scope, { ...current, exists: true, content });
    },

    readMcpConfig: async (scope) => ({ ...(mcpSettings.get(scope) as SettingsScopeFileDto) }),

    writeMcpConfig: async (scope, content) => {
      const current = mcpSettings.get(scope) as SettingsScopeFileDto;
      mcpSettings.set(scope, {
        ...current,
        path: scope === "global" ? "~/.pi/agent/mcp.json" : ".pi/mcp.json",
        exists: true,
        content,
      });
    },

    openMcpConfigDirectory: async () => {},

    checkMcpAdapter: async () => ({ ...mcpAdapterStatus }),

    discoverMcpSources: async () => [...(options.mcpSources ?? [
      {
        id: "standard-global",
        label: "Standard MCP",
        path: "~/.config/mcp/mcp.json",
        scope: "global",
        format: "json",
        supported: true,
        content: JSON.stringify({ mcpServers: { docs: { command: "npx", args: ["-y", "example-mcp-server"] } } }),
        reason: null,
      },
    ])],

    fetchModels: async (_config: ProviderConfig) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [...MOCK_MODEL_IDS];
    },

    runPiCli: async (args: string[]): Promise<CliResultDto> => ({
      code: 0,
      stdout: `(mock) pi ${args.join(" ")}\n`,
      stderr: "",
    }),

    runSkillsCli: async (args: string[]): Promise<CliResultDto> => ({
      code: 0,
      // `--list` drives the source picker, so the mock has to answer in the
      // real CLI's shape (see parseSkillList) rather than a bare echo.
      stdout: args.includes("--list")
        ? MOCK_SKILLS_LIST
        : `(mock) skills ${args.join(" ")}\n`,
      stderr: "",
    }),

    searchSkills: async (query: string) => {
      const needle = query.trim().toLowerCase();
      return MOCK_CATALOG.filter(
        (hit) =>
          hit.name.includes(needle) || hit.source.toLowerCase().includes(needle)
      );
    },

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
