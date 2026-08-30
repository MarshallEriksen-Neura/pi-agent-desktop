"use client";

import { create } from "zustand";
import {
  getBackendKind,
  getPort,
} from "../backend/composition/container";
import type {
  McpAdapterStatusDto,
  McpDiscoverySourceDto,
  SettingsScopeFileDto,
} from "../backend/ports/pi-configuration";
import { useWorkspace } from "../workspace";

export type McpScope = "global" | "project";
export type McpTransport = "stdio" | "http";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  auth?: "bearer" | "oauth";
  bearerTokenEnv?: string;
  lifecycle?: "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
  idleTimeout?: number;
  directTools?: boolean | string[];
  includeTools?: string[];
  excludeTools?: string[];
  toolPrefix?: "server" | "short" | "none" | "mcp";
  disabled?: boolean;
  [key: string]: unknown;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  settings?: {
    toolPrefix?: McpServerConfig["toolPrefix"];
    idleTimeout?: number;
    approveTools?: boolean | string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface McpScopeFile {
  path: string;
  exists: boolean;
  raw: string;
  data: McpConfigFile | null;
  parseError: string | null;
  migrationWarning: boolean;
}

export type McpImportConflictMode = "skip" | "replace";

export interface McpImportPreview {
  source: McpDiscoverySourceDto;
  servers: Record<string, McpServerConfig>;
  conflicts: string[];
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function looksLikeServerConfig(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && [
    "command", "url", "type", "args", "environment", "env", "headers", "enabled",
  ].some((key) => key in value);
}

function findImportServers(object: Record<string, unknown>): Record<string, unknown> | null {
  const direct = [
    object.mcpServers,
    object.servers,
    isRecord(object.mcp) ? object.mcp.servers : undefined,
    isRecord(object.mcp) ? object.mcp.server : undefined,
  ];
  for (const candidate of direct) {
    if (isRecord(candidate)) return candidate;
  }
  // OpenCode stores named entries directly under `mcp` rather than under a
  // `servers` wrapper. Only accept objects whose entries look like server
  // definitions so unrelated OpenCode settings are never imported.
  if (isRecord(object.mcp) && Object.keys(object.mcp).length > 0 && Object.values(object.mcp).every(looksLikeServerConfig)) {
    return object.mcp;
  }
  return null;
}

function normalizeImportedServer(value: unknown, name: string): McpServerConfig {
  if (!isRecord(value)) throw new Error(`Server ${name} is not an object`);
  const normalized: McpServerConfig = { ...value };
  const command = value.command;
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    if (parts.length === 0) throw new Error(`Server ${name} has an empty command`);
    const existingArgs = value.args === undefined
      ? []
      : Array.isArray(value.args) && value.args.every((part): part is string => typeof part === "string")
        ? value.args
        : null;
    if (!existingArgs) throw new Error(`Server ${name} args must be a string array`);
    normalized.command = parts[0];
    normalized.args = [...existingArgs, ...parts.slice(1)];
    delete normalized.type;
  } else if (command !== undefined && typeof command !== "string") {
    throw new Error(`Server ${name} command must be a string or string array`);
  }
  if (value.environment !== undefined && normalized.env === undefined) {
    if (!isRecord(value.environment) || Object.values(value.environment).some((entry) => typeof entry !== "string")) {
      throw new Error(`Server ${name} environment must be a string object`);
    }
    normalized.env = value.environment as Record<string, string>;
    delete normalized.environment;
  }
  if (value.enabled === false) normalized.disabled = true;
  delete normalized.enabled;
  return normalized;
}

function splitTomlPath(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote = "";
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = "";
      else current += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ".") {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (quote) throw new Error("Unclosed quote in Codex MCP TOML section");
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseTomlString(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return JSON.parse(trimmed) as string;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  throw new Error("Expected a TOML string");
}

function parseTomlArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error("Expected a TOML string array");
  const body = trimmed.slice(1, -1);
  const values: string[] = [];
  let token = "";
  let quote = "";
  const flush = () => {
    if (token.trim()) values.push(parseTomlString(token.trim()));
    token = "";
  };
  for (const character of body) {
    if (quote) {
      token += character;
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
      token += character;
    } else if (character === ",") {
      flush();
    } else {
      token += character;
    }
  }
  if (quote) throw new Error("Unclosed quote in TOML array");
  flush();
  return values;
}

function parseCodexMcpToml(content: string): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};
  let current: { name: string; section: "server" | "env" | "headers" } | null = null;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const path = splitTomlPath(line.slice(1, -1));
      if (path[0] !== "mcp_servers" || !path[1]) {
        current = null;
      } else {
        const section = path[2] === "env" ? "env" : path[2] === "http_headers" ? "headers" : "server";
        current = { name: path[1], section };
        if (!servers[path[1]]) servers[path[1]] = {};
        if (section === "env") servers[path[1]].env ??= {};
        if (section === "headers") servers[path[1]].headers ??= {};
      }
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    const server = servers[current.name];
    if (current.section === "env" || current.section === "headers") {
      const target = current.section === "env" ? server.env! : server.headers!;
      target[key] = parseTomlString(value);
      continue;
    }
    if (key === "command" || key === "url" || key === "type") {
      const parsed = parseTomlString(value);
      if (key === "command" || key === "url") server[key] = parsed;
    } else if (key === "args") {
      server.args = parseTomlArray(value);
    } else if (key === "enabled") {
      if (value === "false") server.disabled = true;
      else if (value !== "true") throw new Error(`Server ${current.name} enabled must be a boolean`);
    }
  }
  return servers;
}

const EMPTY_SCOPE: McpScopeFile = {
  path: "",
  exists: false,
  raw: "",
  data: null,
  parseError: null,
  migrationWarning: false,
};

interface McpStore {
  mock: boolean;
  loaded: boolean;
  busy: boolean;
  dirtyRestart: boolean;
  lastError: string | null;
  adapter: McpAdapterStatusDto;
  sources: McpDiscoverySourceDto[];
  global: McpScopeFile;
  project: McpScopeFile;

  load: () => Promise<void>;
  refreshAdapter: () => Promise<void>;
  discoverSources: () => Promise<void>;
  openConfigDirectory: (scope: McpScope) => Promise<void>;
  importSource: (scope: McpScope, sourceId: string, mode: McpImportConflictMode, selectedNames?: string[]) => Promise<void>;
  installAdapter: () => Promise<void>;
  upsertServer: (
    scope: McpScope,
    name: string,
    config: McpServerConfig,
    previousName?: string
  ) => Promise<void>;
  removeServer: (scope: McpScope, name: string) => Promise<void>;
  setDisabled: (scope: McpScope, name: string, disabled: boolean) => Promise<void>;
  setRaw: (scope: McpScope, content: string) => Promise<void>;
}

function projectRoot(): string | null {
  return useWorkspace.getState().root || null;
}

function parseScope(raw: SettingsScopeFileDto): McpScopeFile {
  if (!raw.exists || !raw.content.trim()) {
    return {
      path: raw.path,
      exists: raw.exists,
      raw: raw.content,
      data: raw.exists ? {} : null,
      parseError: null,
      migrationWarning: false,
    };
  }
  try {
    const value = JSON.parse(raw.content) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("MCP config must be a JSON object");
    }
    const object = value as Record<string, unknown>;
    const flatServerMap =
      !Object.prototype.hasOwnProperty.call(object, "mcpServers") &&
      Object.keys(object).length > 0 &&
      Object.values(object).every((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
        return ["command", "url", "socket", "args", "env", "headers", "lifecycle", "directTools"].some(
          (key) => key in (entry as Record<string, unknown>)
        );
      });
    const data = flatServerMap ? { mcpServers: object as Record<string, McpServerConfig> } : (value as McpConfigFile);
    return {
      path: raw.path,
      exists: true,
      raw: raw.content,
      data,
      parseError: null,
      migrationWarning: flatServerMap,
    };
  } catch (error) {
    return {
      path: raw.path,
      exists: true,
      raw: raw.content,
      data: null,
      parseError: error instanceof Error ? error.message : String(error),
      migrationWarning: false,
    };
  }
}

function cloneConfig(file: McpScopeFile): McpConfigFile {
  return structuredClone(file.data ?? {});
}

function serverMap(config: McpConfigFile): Record<string, McpServerConfig> {
  const servers = config.mcpServers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? servers
    : {};
}

export function parseMcpImportSource(source: McpDiscoverySourceDto): McpImportPreview {
  if (!source.supported) {
    return { source, servers: {}, conflicts: [], error: source.reason ?? "This source format is not supported yet." };
  }
  try {
    if (source.format === "toml") {
      return { source, servers: parseCodexMcpToml(source.content), conflicts: [], error: null };
    }
    const value = JSON.parse(source.content) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Source must contain a JSON object");
    }
    const object = value as Record<string, unknown>;
    const candidate = findImportServers(object);
    if (!candidate) throw new Error("No supported MCP server map was found in this source");
    const servers: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(candidate)) {
      servers[name] = normalizeImportedServer(config, name);
    }
    return { source, servers, conflicts: [], error: null };
  } catch (error) {
    return {
      source,
      servers: {},
      conflicts: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export const useMcp = create<McpStore>((set, get) => {
  const writeScope = async (scope: McpScope, next: McpConfigFile) => {
    const current = get()[scope];
    const content = JSON.stringify(next, null, 2) + "\n";
    const parsed = parseScope({
      path: current.path,
      exists: true,
      content,
    });
    set({ [scope]: parsed } as never);
    try {
      await getPort("piConfiguration").writeMcpConfig(
        scope,
        content,
        scope === "project" ? projectRoot() : null
      );
      set({ dirtyRestart: true, lastError: null });
    } catch (error) {
      set({ [scope]: current, lastError: error instanceof Error ? error.message : String(error) } as never);
    }
  };

  return {
    mock: false,
    loaded: false,
    busy: false,
    dirtyRestart: false,
    lastError: null,
    adapter: { installed: false, otherConfigPaths: [] },
    sources: [],
    global: EMPTY_SCOPE,
    project: EMPTY_SCOPE,

    load: async () => {
      set({ busy: true });
      try {
        const port = getPort("piConfiguration");
        const [global, project, adapter] = await Promise.all([
          port.readMcpConfig("global"),
          port.readMcpConfig("project", projectRoot()),
          port.checkMcpAdapter(projectRoot()),
        ]);
        set({
          mock: getBackendKind() === "browser-preview",
          loaded: true,
          global: parseScope(global),
          project: parseScope(project),
          adapter,
          lastError: null,
        });
      } catch (error) {
        set({ loaded: true, lastError: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ busy: false });
      }
    },

    refreshAdapter: async () => {
      try {
        const adapter = await getPort("piConfiguration").checkMcpAdapter(projectRoot());
        set({ adapter, lastError: null });
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : String(error) });
      }
    },

    discoverSources: async () => {
      set({ busy: true, lastError: null });
      try {
        const sources = await getPort("piConfiguration").discoverMcpSources(projectRoot());
        set({ sources });
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ busy: false });
      }
    },

    openConfigDirectory: async (scope) => {
      try {
        await getPort("piConfiguration").openMcpConfigDirectory(
          scope,
          scope === "project" ? projectRoot() : null
        );
        set({ lastError: null });
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : String(error) });
      }
    },

    importSource: async (scope, sourceId, mode, selectedNames) => {
      const source = get().sources.find((entry) => entry.id === sourceId);
      if (!source) {
        set({ lastError: "MCP source is no longer available" });
        return;
      }
      const preview = parseMcpImportSource(source);
      if (preview.error) {
        set({ lastError: preview.error });
        return;
      }
      const next = cloneConfig(get()[scope]);
      const currentServers = serverMap(next);
      const selected = selectedNames ? new Set(selectedNames) : null;
      const imported = Object.fromEntries(
        Object.entries(preview.servers).filter(([name]) =>
          (!selected || selected.has(name)) && (mode === "replace" || !currentServers[name])
        )
      );
      if (Object.keys(imported).length === 0) {
        set({ lastError: "All discovered MCP servers already exist in this scope" });
        return;
      }
      next.mcpServers = { ...currentServers, ...imported };
      await writeScope(scope, next);
    },

    installAdapter: async () => {
      set({ busy: true, lastError: null });
      try {
        const result = await getPort("piConfiguration").runPiCli([
          "install",
          "npm:pi-mcp-adapter",
        ], projectRoot());
        if (result.code !== 0) {
          throw new Error(result.stderr || result.stdout || "pi-mcp-adapter installation failed");
        }
        await get().refreshAdapter();
        set({ dirtyRestart: true });
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : String(error) });
      } finally {
        set({ busy: false });
      }
    },

    upsertServer: async (scope, name, config, previousName) => {
      const normalized = name.trim();
      if (!normalized) {
        set({ lastError: "MCP server name is required" });
        return;
      }
      const next = cloneConfig(get()[scope]);
      const servers = { ...serverMap(next) };
      if (previousName !== normalized && servers[normalized]) {
        set({ lastError: `MCP server \"${normalized}\" already exists` });
        return;
      }
      if (previousName && previousName !== normalized) delete servers[previousName];
      next.mcpServers = { ...servers, [normalized]: config };
      await writeScope(scope, next);
    },

    removeServer: async (scope, name) => {
      const next = cloneConfig(get()[scope]);
      const servers = { ...serverMap(next) };
      delete servers[name];
      if (Object.keys(servers).length === 0) delete next.mcpServers;
      else next.mcpServers = servers;
      await writeScope(scope, next);
    },

    setDisabled: async (scope, name, disabled) => {
      const current = serverMap(get()[scope].data ?? {});
      const server = current[name];
      if (!server) return;
      const next = { ...server };
      if (disabled) next.disabled = true;
      else if (scope === "project") next.disabled = false;
      else delete next.disabled;
      await get().upsertServer(scope, name, next);
    },

    setRaw: async (scope, content) => {
      const current = get()[scope];
      const normalizedContent = content.endsWith("\n") ? content : `${content}\n`;
      const parsed = parseScope({ path: current.path, exists: true, content: normalizedContent });
      if (parsed.parseError || !parsed.data) {
        set({ lastError: parsed.parseError ?? "MCP config must be a JSON object" });
        return;
      }
      const contentToWrite = parsed.migrationWarning
        ? JSON.stringify(parsed.data, null, 2) + "\n"
        : normalizedContent;
      const stored = parsed.migrationWarning
        ? parseScope({ path: current.path, exists: true, content: contentToWrite })
        : parsed;
      try {
        await getPort("piConfiguration").writeMcpConfig(
          scope,
          contentToWrite,
          scope === "project" ? projectRoot() : null
        );
        set({ [scope]: stored, dirtyRestart: true, lastError: null } as never);
      } catch (error) {
        set({ lastError: error instanceof Error ? error.message : String(error) });
      }
    },
  };
});
