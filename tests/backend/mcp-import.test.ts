import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import test from "node:test";
import { parseMcpImportSource } from "../../src/lib/pi/mcp";
import type { McpDiscoverySourceDto } from "../../src/lib/backend/ports/pi-configuration";
import { mcpAuthCompleteExample, mcpAuthUrl, toolTitle } from "../../src/lib/pi/tool-label";
import { configurePiClientForTests, resetPiClientForTests } from "../../src/lib/pi/client";
import { useChat } from "../../src/lib/pi/chat";
import type { PiProcessPort } from "../../src/lib/backend/ports/pi-process";
import type { PiCommand } from "../../src/lib/pi/protocol";
import { usePi } from "../../src/lib/pi/store";

function source(content: unknown, overrides: Partial<McpDiscoverySourceDto> = {}): McpDiscoverySourceDto {
  return {
    id: "test-source",
    label: "Test source",
    path: "test.json",
    scope: "global",
    format: "json",
    supported: true,
    content: typeof content === "string" ? content : JSON.stringify(content),
    reason: null,
    ...overrides,
  };
}

class FakePiProcess implements PiProcessPort {
  readonly sent: PiCommand[] = [];
  private readonly lineHandlers = new Set<(line: string) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private readonly exitHandlers = new Set<(exit: { code: number | null }) => void>();
  async start(): Promise<void> {}
  async send(command: PiCommand): Promise<void> {
    this.sent.push(command);
    const requestId = (command as PiCommand & { id?: string }).id;
    if (requestId) {
      queueMicrotask(() => this.emit({ type: "response", command: command.type, success: true, id: requestId }));
    }
  }
  async stop(): Promise<void> {}
  onLine(handler: (line: string) => void): () => void { this.lineHandlers.add(handler); return () => this.lineHandlers.delete(handler); }
  onStderr(handler: (line: string) => void): () => void { this.stderrHandlers.add(handler); return () => this.stderrHandlers.delete(handler); }
  onExit(handler: (exit: { code: number | null }) => void): () => void { this.exitHandlers.add(handler); return () => this.exitHandlers.delete(handler); }
  emit(event: unknown): void {
    const line = JSON.stringify(event);
    for (const handler of this.lineHandlers) handler(line);
  }
}

test("imports standard and VS Code server maps", () => {
  const standard = parseMcpImportSource(source({ mcpServers: { docs: { command: "npx", args: ["-y", "docs"] } } }));
  assert.equal(standard.error, null);
  assert.deepEqual(standard.servers.docs, { command: "npx", args: ["-y", "docs"] });

  const vscode = parseMcpImportSource(source({ servers: { docs: { command: "node", args: ["server.js"] } } }));
  assert.equal(vscode.error, null);
  assert.equal(vscode.servers.docs.command, "node");
});

test("normalizes OpenCode local and remote MCP entries", () => {
  const preview = parseMcpImportSource(source({
    mcp: {
      local: { type: "local", command: ["npx", "-y", "local-mcp"], environment: { TOKEN: "${TOKEN}" } },
      remote: { type: "remote", url: "https://example.test/mcp", enabled: false },
    },
  }));
  assert.equal(preview.error, null);
  assert.deepEqual(preview.servers.local.command, "npx");
  assert.deepEqual(preview.servers.local.args, ["-y", "local-mcp"]);
  assert.deepEqual(preview.servers.local.env, { TOKEN: "${TOKEN}" });
  assert.equal(preview.servers.remote.url, "https://example.test/mcp");
  assert.equal(preview.servers.remote.disabled, true);
});

test("imports Codex MCP TOML without exposing unrelated settings", () => {
  const preview = parseMcpImportSource(source([
    "[mcp_servers.docs]",
    'command = "npx"',
    'args = ["-y", "docs"]',
    "enabled = false",
    "",
    "[mcp_servers.docs.env]",
    'TOKEN = "${TOKEN}"',
    "",
    "[mcp_servers.remote]",
    'url = "https://example.test/mcp"',
  ].join("\n"), { format: "toml" }));
  assert.equal(preview.error, null);
  assert.equal(preview.servers.docs.command, "npx");
  assert.deepEqual(preview.servers.docs.args, ["-y", "docs"]);
  assert.equal(preview.servers.docs.disabled, true);
  assert.deepEqual(preview.servers.docs.env, { TOKEN: "${TOKEN}" });
  assert.equal(preview.servers.remote.url, "https://example.test/mcp");
});

test("rejects malformed server maps", () => {
  const preview = parseMcpImportSource(source({ servers: { broken: { command: [1, 2] } } }));
  assert.match(preview.error ?? "", /command array|empty command/);
});

test("labels MCP activity and surfaces OAuth authorization URLs", () => {
  assert.equal(toolTitle("mcp__github__search", {}), "MCP · github/search");
  assert.equal(
    mcpAuthUrl("mcp", {
      content: [{ type: "text", text: "MCP OAuth required for \\\"github\\\"." }],
      details: { mode: "auth-start", server: "github", authorizationUrl: "https://auth.example.test/authorize?state=abc" },
    }, { action: "auth-start", server: "github" }),
    "https://auth.example.test/authorize?state=abc"
  );
  assert.equal(
    mcpAuthCompleteExample("mcp", { action: "auth-start", server: "github" }),
    'mcp({ action: "auth-complete", server: "github", args: { code: "PASTE_CODE_HERE" } })'
  );
  assert.equal(mcpAuthUrl("mcp", { details: { mode: "auth-complete", authorizationUrl: "https://should-not-show.test" } }, { action: "auth-complete", server: "github" }), undefined);
  assert.equal(mcpAuthUrl("read", "https://auth.example.test/authorize"), undefined);
});

test("propagates MCP auth-start results into the chat activity model", () => {
  const process = new FakePiProcess();
  configurePiClientForTests(process);
  useChat.setState({ messages: [], initialized: false, streaming: false, queue: [], activeRetries: new Map() });
  useChat.getState().init();
  process.emit({ type: "tool_execution_start", toolCallId: "mcp-auth-1", toolName: "mcp", args: { action: "auth-start", server: "github" } });
  process.emit({
    type: "tool_execution_end",
    toolCallId: "mcp-auth-1",
    toolName: "mcp",
    result: {
      content: [{ type: "text", text: "MCP OAuth required for \\\"github\\\"." }],
      details: { mode: "auth-start", server: "github", authorizationUrl: "https://auth.example.test/authorize?state=abc" },
    },
    isError: false,
  });
  const tool = useChat.getState().messages.at(-1)?.tools[0];
  assert.equal(tool?.status, "done");
  assert.equal(tool?.authUrl, "https://auth.example.test/authorize?state=abc");
  resetPiClientForTests();
});

test("closes a local OAuth fixture from auth-start through auth-complete", async () => {
  const oauth = createServer((request, response) => {
    if (request.url?.startsWith("/authorize")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("authorized: local-code");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => oauth.listen(0, "127.0.0.1", resolve));
  const address = oauth.address();
  assert.ok(address && typeof address === "object");
  const authUrl = `http://127.0.0.1:${address.port}/authorize?state=local-test`;
  const process = new FakePiProcess();
  configurePiClientForTests(process);
  usePi.setState({ status: "ready", lastError: null });
  useChat.setState({ messages: [], initialized: false, streaming: false, queue: [], activeRetries: new Map() });
  useChat.getState().init();

  try {
    process.emit({ type: "tool_execution_start", toolCallId: "oauth-e2e", toolName: "mcp", args: { action: "auth-start" } });
    process.emit({ type: "tool_execution_end", toolCallId: "oauth-e2e", toolName: "mcp", result: { message: `Open ${authUrl}` }, isError: false });
    const tool = useChat.getState().messages.at(-1)?.tools[0];
    assert.equal(tool?.authUrl, authUrl);
    const page = await new Promise<string>((resolve, reject) => {
      httpGet(tool?.authUrl ?? "", (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => { body += chunk; });
        response.on("end", () => resolve(body));
        response.on("error", reject);
      }).on("error", reject);
    });
    assert.equal(page, "authorized: local-code");

    await useChat.getState().send("auth-complete local-code");
    const prompt = process.sent.at(-1) as PiCommand & { id?: string };
    assert.equal(prompt.type, "prompt");
    assert.equal(prompt.message, "auth-complete local-code");
    assert.ok(prompt.id);
  } finally {
    resetPiClientForTests();
    await new Promise<void>((resolve, reject) => oauth.close((error) => error ? reject(error) : resolve()));
  }
});
