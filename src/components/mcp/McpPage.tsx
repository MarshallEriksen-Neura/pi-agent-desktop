"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Braces,
  ChevronRight,
  FileJson,
  FolderOpen,
  Globe,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  Terminal,
  Trash2,
} from "lucide-react";
import { useT } from "@/lib/i18n";
import {
  type McpScope,
  type McpImportConflictMode,
  parseMcpImportSource,
  useMcp,
} from "@/lib/pi/mcp";
import {
  EMPTY_FORM,
  ServerEditorModal,
  toForm,
  toConfig,
  type ServerForm,
} from "./ServerEditorModal";
import { AMBER, HAIRLINE, INK, PAPER, SEAL, SANS } from "./mcp-tokens";
import { InkSwitch, PillSegmented } from "./mcp-ui";

const EMPTY_MCP_JSON = '{\n  "mcpServers": {}\n}\n';

function editorContent(file: { raw: string; data: unknown; migrationWarning: boolean }): string {
  if (file.migrationWarning && file.data) return JSON.stringify(file.data, null, 2) + "\n";
  return file.raw || (file.data ? JSON.stringify(file.data, null, 2) + "\n" : EMPTY_MCP_JSON);
}

/** inset grouped paper card — hairline border, no shadows. */
function PaperCard({
  header,
  children,
}: {
  header?: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 20 }}>
      {header && (
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            color: INK.ink500,
            padding: "0 16px 8px",
            fontFamily: SANS,
          }}
        >
          {header}
        </div>
      )}
      <div
        style={{
          background: PAPER.elevated,
          borderRadius: 16,
          border: `1px solid ${HAIRLINE}`,
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </section>
  );
}

function RowDivider() {
  return <div style={{ height: 1, background: HAIRLINE, margin: 0 }} />;
}

function McpImportPanel({
  scope,
  currentNames,
  sources,
  busy,
  onImport,
}: {
  scope: McpScope;
  currentNames: string[];
  sources: ReturnType<typeof useMcp.getState>["sources"];
  busy: boolean;
  onImport: (sourceId: string, mode: McpImportConflictMode, selectedNames: string[]) => Promise<void>;
}) {
  const t = useT();
  const [mode, setMode] = useState<McpImportConflictMode>("skip");
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const currentNamesKey = currentNames.join("\u0000");
  const previews = useMemo(
    () => sources.map((source) => {
      const preview = parseMcpImportSource(source);
      return {
        ...preview,
        conflicts: Object.keys(preview.servers).filter((name) => currentNames.includes(name)),
      };
    }),
    [currentNamesKey, sources]
  );
  useEffect(() => {
    setSelected((current) => {
      const next: Record<string, string[]> = {};
      for (const preview of previews) {
        const available = Object.keys(preview.servers);
        next[preview.source.id] = (current[preview.source.id] ?? available).filter((name) => available.includes(name));
      }
      return next;
    });
  }, [previews]);
  return (
    <PaperCard header={t("mcp.importTitle")}>
      <div style={{ padding: "14px 16px", display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: INK.ink700 }}>{t("mcp.conflictMode")}</span>
          <PillSegmented
            options={["skip", "replace"] as const}
            value={mode}
            onChange={setMode}
            labelOf={(value) => (value === "skip" ? t("mcp.skipConflicts") : t("mcp.replaceConflicts"))}
          />
        </div>
        <div style={{ fontSize: 12.5, color: INK.ink500, lineHeight: 1.5 }}>
          {t("mcp.importHint", { scope: scope === "global" ? t("mcp.global") : t("mcp.project") })}
        </div>
        {previews.length === 0 && <div style={{ color: INK.ink300, fontSize: 12.5 }}>{t("mcp.noSources")}</div>}
      </div>
      {previews.map((preview) => {
        const names = Object.keys(preview.servers);
        const selectedNames = selected[preview.source.id] ?? names;
        const importableCount = selectedNames.filter((name) => mode === "replace" || !preview.conflicts.includes(name)).length;
        return (
          <div key={preview.source.id}>
            <RowDivider />
            <div style={{ padding: "12px 16px", display: "flex", alignItems: "flex-start", gap: 10 }}>
              <FileJson size={16} style={{ flexShrink: 0, marginTop: 2, color: INK.ink500 }} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 13, color: INK.ink900 }}>{preview.source.label}</div>
                <div style={{ fontSize: 11.5, color: INK.ink300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{preview.source.path}</div>
                <div style={{ fontSize: 11.5, color: preview.error ? SEAL.red : INK.ink500, marginTop: 1 }}>
                  {preview.error ?? `${Object.keys(preview.servers).length} ${t("mcp.importedServers")}${preview.conflicts.length ? ` · ${preview.conflicts.length} ${t("mcp.conflicts")}` : ""}`}
                </div>
                {!preview.error && names.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 12px", marginTop: 8 }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: INK.ink700 }}>
                      <input
                        type="checkbox"
                        checked={selectedNames.length === names.length}
                        onChange={(event) => setSelected((current) => ({ ...current, [preview.source.id]: event.target.checked ? names : [] }))}
                      />
                      {t("mcp.selectAll")}
                    </label>
                    {names.map((name) => (
                      <label key={name} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: INK.ink700 }}>
                        <input
                          type="checkbox"
                          checked={selectedNames.includes(name)}
                          onChange={(event) => setSelected((current) => {
                            const values = new Set(current[preview.source.id] ?? names);
                            if (event.target.checked) values.add(name); else values.delete(name);
                            return { ...current, [preview.source.id]: [...values] };
                          })}
                        />
                        {name}
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                disabled={busy || Boolean(preview.error) || importableCount === 0}
                onClick={() => onImport(preview.source.id, mode, selectedNames)}
                style={{
                  flexShrink: 0,
                  border: `1px solid ${HAIRLINE}`,
                  borderRadius: 99,
                  padding: "6px 16px",
                  background: busy ? PAPER.sunken : PAPER.elevated,
                  color: busy || Boolean(preview.error) || importableCount === 0 ? INK.ink300 : INK.ink700,
                  fontFamily: SANS,
                  fontSize: 12.5,
                  fontWeight: 600,
                  cursor: busy || Boolean(preview.error) || importableCount === 0 ? "default" : "pointer",
                }}
              >
                {t("mcp.import")}
              </button>
            </div>
          </div>
        );
      })}
    </PaperCard>
  );
}

export function McpPage() {
  const t = useT();
  const mcp = useMcp();
  const [scope, setScope] = useState<McpScope>("global");
  const [editing, setEditing] = useState<ServerForm | null>(null);
  const [rawOpen, setRawOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const file = scope === "global" ? mcp.global : mcp.project;
  const servers = useMemo(() => Object.entries(file.data?.mcpServers ?? {}), [file.data]);

  useEffect(() => {
    if (!mcp.loaded) void mcp.load();
  }, [mcp.loaded, mcp.load]);

  useEffect(() => {
    setRaw(editorContent(file));
  }, [file.data, file.migrationWarning, file.path, file.raw]);

  const add = () => setEditing({ ...EMPTY_FORM });
  const startEdit = (name: string, server: unknown) =>
    setEditing(toForm(name, server as Parameters<typeof toForm>[1]));
  const cancelEdit = () => setEditing(null);
  const saveServer = async (form: ServerForm) => {
    const originalName = editing?.preserved ? editing.name : undefined;
    await mcp.upsertServer(scope, form.name, toConfig(form), originalName || undefined);
    if (!useMcp.getState().lastError) setEditing(null);
  };
  const openRaw = () => {
    setRaw(editorContent(file));
    setRawOpen((value) => !value);
  };
  const saveRaw = async () => {
    await mcp.setRaw(scope, raw);
    if (!useMcp.getState().lastError) setRawOpen(false);
  };
  const discover = async () => {
    setImportOpen(true);
    await mcp.discoverSources();
  };

  return (
    <>
      {/* scope + adapter banner */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <PillSegmented
          options={["global", "project"] as const}
          value={scope}
          onChange={setScope}
          labelOf={(value) => (value === "global" ? t("mcp.global") : t("mcp.project"))}
        />
        <button
          type="button"
          onClick={() => mcp.load()}
          disabled={mcp.busy}
          title={t("mcp.refresh")}
          style={{
            border: "none",
            background: "transparent",
            color: INK.ink300,
            cursor: mcp.busy ? "wait" : "pointer",
            padding: 6,
            display: "grid",
            placeItems: "center",
          }}
        >
          <RefreshCw size={15} style={{ animation: mcp.busy ? "mcp-spin 1s linear infinite" : "none" }} />
        </button>
      </div>

      {!mcp.adapter.installed && (
        <div
          style={{
            marginTop: 14,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "11px 14px",
            borderRadius: 12,
            background: PAPER.sunken,
          }}
        >
          <ShieldAlert size={16} style={{ flexShrink: 0, color: SEAL.red }} />
          <span style={{ flex: 1, fontSize: 13, color: INK.ink700, lineHeight: 1.45 }}>
            {t("mcp.adapterMissing")}
          </span>
          <button
            type="button"
            onClick={() => mcp.installAdapter()}
            disabled={mcp.busy}
            style={{
              flexShrink: 0,
              border: "none",
              borderRadius: 99,
              padding: "6px 14px",
              background: SEAL.muted,
              color: INK.ink700,
              fontFamily: SANS,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: mcp.busy ? "wait" : "pointer",
            }}
          >
            {mcp.busy ? t("mcp.installing") : t("mcp.install")}
          </button>
        </div>
      )}

      {mcp.adapter.otherConfigPaths.length > 0 && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            fontSize: 12,
            color: INK.ink500,
            lineHeight: 1.5,
          }}
        >
          <Info size={13} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{t("mcp.otherSources", { count: mcp.adapter.otherConfigPaths.length })}</span>
        </div>
      )}

      {/* servers card */}
      <PaperCard header={t("mcp.serverList")}>
        {file.migrationWarning && (
          <div style={{ padding: "11px 16px", fontSize: 12.5, color: AMBER, lineHeight: 1.5 }}>
            {t("mcp.migrationWarning")}
          </div>
        )}
        {file.parseError ? (
          <>
            <RowDivider />
            <div style={{ padding: "14px 16px", fontSize: 12.5, color: SEAL.red, lineHeight: 1.5 }}>
              {t("mcp.invalidJson")} — {file.parseError}
            </div>
          </>
        ) : servers.length === 0 ? (
          <>
            <RowDivider />
            <div style={{ padding: "22px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 13, color: INK.ink500 }}>{t("mcp.empty")}</div>
              <div style={{ marginTop: 6, fontSize: 12, color: INK.ink300 }}>{t("mcp.addServerHint")}</div>
            </div>
          </>
        ) : (
          servers.map(([name, server], index) => (
            <div key={name}>
              {index === 0 && <RowDivider />}
              <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 16px" }}>
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    background: PAPER.sunken,
                    color: INK.ink700,
                    flexShrink: 0,
                  }}
                >
                  {server.url ? <Globe size={15} /> : <Terminal size={15} />}
                </span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600, color: INK.ink900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {name}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: INK.ink500, marginTop: 1 }}>
                    <span
                      style={{
                        border: `1px solid ${INK.ink100}`,
                        borderRadius: 99,
                        padding: "0 6px",
                        fontSize: 10.5,
                        color: INK.ink500,
                        lineHeight: "16px",
                      }}
                    >
                      {server.url ? "http" : "stdio"}
                    </span>
                    {server.disabled ? t("mcp.disabled") : t("mcp.enabled")}
                  </span>
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  <InkSwitch checked={!server.disabled} onChange={(value) => mcp.setDisabled(scope, name, !value)} />
                  <button
                    type="button"
                    aria-label={t("mcp.edit")}
                    onClick={() => startEdit(name, server)}
                    style={{ border: "none", background: "transparent", color: INK.ink500, cursor: "pointer", padding: 6 }}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={t("mcp.delete")}
                    onClick={() => mcp.removeServer(scope, name)}
                    style={{ border: "none", background: "transparent", color: SEAL.red, cursor: "pointer", padding: 6, opacity: 0.8 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
        <RowDivider />
        <motion.button
          type="button"
          whileTap={{ scale: 0.99 }}
          onClick={add}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            padding: "12px 16px",
            border: "none",
            background: "transparent",
            color: INK.ink700,
            fontFamily: SANS,
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          <Plus size={14} />
          {t("mcp.addServer")}
        </motion.button>
      </PaperCard>

      {/* config sources card */}
      <PaperCard header={t("mcp.configSource")}>
        <motion.button
          type="button"
          whileTap={{ scale: 0.99 }}
          onClick={openRaw}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "12px 16px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <Braces size={15} style={{ color: INK.ink500, flexShrink: 0 }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, color: INK.ink900 }}>{t("mcp.rawJson")}</span>
            <span style={{ display: "block", fontSize: 11.5, color: INK.ink300, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {file.path || (scope === "global" ? "~/.pi/agent/mcp.json" : ".pi/mcp.json")}
            </span>
          </span>
          <ChevronRight size={14} style={{ color: INK.ink100, flexShrink: 0 }} />
        </motion.button>
        <RowDivider />
        <motion.button
          type="button"
          whileTap={{ scale: 0.99 }}
          onClick={() => mcp.openConfigDirectory(scope)}
          disabled={mcp.busy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "12px 16px",
            border: "none",
            background: "transparent",
            cursor: mcp.busy ? "wait" : "pointer",
            textAlign: "left",
          }}
        >
          <FolderOpen size={15} style={{ color: INK.ink500, flexShrink: 0 }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, color: INK.ink900 }}>{t("mcp.openDirectory")}</span>
            <span style={{ display: "block", fontSize: 11.5, color: INK.ink300, marginTop: 1 }}>{t("mcp.scopeFooter", { path: file.path || (scope === "global" ? "~/.pi/agent/mcp.json" : ".pi/mcp.json") })}</span>
          </span>
          <ChevronRight size={14} style={{ color: INK.ink100, flexShrink: 0 }} />
        </motion.button>
        <RowDivider />
        <motion.button
          type="button"
          whileTap={{ scale: 0.99 }}
          onClick={discover}
          disabled={mcp.busy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            width: "100%",
            padding: "12px 16px",
            border: "none",
            background: "transparent",
            cursor: mcp.busy ? "wait" : "pointer",
            textAlign: "left",
          }}
        >
          <Search size={15} style={{ color: INK.ink500, flexShrink: 0 }} />
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={{ display: "block", fontSize: 13.5, color: INK.ink900 }}>
              {mcp.busy ? t("mcp.discovering") : t("mcp.discover")}
            </span>
            <span style={{ display: "block", fontSize: 11.5, color: INK.ink300, marginTop: 1 }}>{t("mcp.importTitle")}</span>
          </span>
          <ChevronRight size={14} style={{ color: INK.ink100, flexShrink: 0 }} />
        </motion.button>
      </PaperCard>

      {/* footnote */}
      <p
        style={{
          margin: "14px 16px 0",
          fontSize: 12,
          color: INK.ink300,
          lineHeight: 1.6,
        }}
      >
        {t("mcp.lazyNote")}
      </p>

      {importOpen && (
        <div style={{ marginBottom: 12 }}>
          <McpImportPanel
            scope={scope}
            currentNames={servers.map(([name]) => name)}
            sources={mcp.sources}
            busy={mcp.busy}
            onImport={(sourceId, mode, selectedNames) => mcp.importSource(scope, sourceId, mode, selectedNames)}
          />
        </div>
      )}

      {/* raw JSON editor */}
      {rawOpen && (
        <div
          style={{
            marginTop: 14,
            borderRadius: 16,
            border: `1px solid ${HAIRLINE}`,
            background: PAPER.elevated,
            overflow: "hidden",
          }}
        >
          <textarea
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            spellCheck={false}
            style={{
              display: "block",
              width: "100%",
              boxSizing: "border-box",
              border: "none",
              outline: "none",
              background: PAPER.sunken,
              color: INK.ink900,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              lineHeight: 1.6,
              padding: 14,
              resize: "vertical",
              minHeight: 180,
            }}
          />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "10px 14px", borderTop: `1px solid ${HAIRLINE}` }}>
            <button
              type="button"
              onClick={() => setRawOpen(false)}
              style={{
                border: `1px solid ${HAIRLINE}`,
                borderRadius: 99,
                padding: "7px 18px",
                background: "transparent",
                color: INK.ink700,
                fontFamily: SANS,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("mcp.cancel")}
            </button>
            <button
              type="button"
              onClick={saveRaw}
              style={{
                border: "none",
                borderRadius: 99,
                padding: "7px 20px",
                background: SEAL.fill,
                color: SEAL.onSeal,
                fontFamily: SANS,
                fontSize: 12.5,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {t("mcp.save")}
            </button>
          </div>
        </div>
      )}

      {/* server editor sheet */}
      {editing && (
        <ServerEditorModal
          title={editing.preserved ? t("mcp.editServerTitle") : t("mcp.addServerTitle")}
          initial={editing}
          onSave={saveServer}
          onCancel={cancelEdit}
        />
      )}

      {/* docked restart bar — the view's single focal point */}
      {mcp.dirtyRestart && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ type: "spring", stiffness: 320, damping: 30 }}
          style={{
            position: "sticky",
            bottom: 0,
            marginTop: 22,
            padding: "12px 0 14px",
            background: `linear-gradient(180deg, transparent, ${PAPER.bottom} 26%)`,
          }}
        >
          <button
            type="button"
            onClick={() => mcp.restartPi()}
            disabled={mcp.busy}
            style={{
              width: "100%",
              height: 42,
              borderRadius: 99,
              border: "none",
              background: SEAL.fill,
              color: SEAL.onSeal,
              fontFamily: SANS,
              fontSize: 14,
              fontWeight: 600,
              cursor: mcp.busy ? "wait" : "pointer",
              transition: "background 180ms",
            }}
            onMouseEnter={(event) => {
              if (!mcp.busy) event.currentTarget.style.background = SEAL.fillHover;
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = SEAL.fill;
            }}
          >
            {mcp.busy ? t("mcp.restarting") : t("mcp.restartRequired")}
          </button>
          <div style={{ marginTop: 8, textAlign: "center", fontSize: 11.5, color: INK.ink500 }}>
            {t("mcp.restartDetail")}
          </div>
        </motion.div>
      )}

      {mcp.lastError && (
        <p role="alert" style={{ marginTop: 14, fontSize: 12.5, color: SEAL.red, lineHeight: 1.5 }}>
          {mcp.lastError}
        </p>
      )}
    </>
  );
}
