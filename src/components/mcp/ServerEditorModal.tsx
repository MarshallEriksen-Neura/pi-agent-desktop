"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, ChevronUp, Info } from "lucide-react";
import { useT } from "@/lib/i18n";
import type { McpServerConfig } from "@/lib/pi/mcp";
import { BACKDROP, HAIRLINE, INK, PAPER, SEAL, SANS, SERIF } from "./mcp-tokens";
import { InkSwitch, PillSegmented } from "./mcp-ui";

export interface ServerForm {
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string;
  cwd: string;
  url: string;
  env: string;
  headers: string;
  lifecycle: "lazy" | "eager" | "keep-alive" | "lazy-keep-alive";
  directTools: boolean;
  directToolsList: string;
  includeTools: string;
  excludeTools: string;
  toolPrefix: "server" | "short" | "none" | "mcp";
  disabled: boolean;
  preserved?: McpServerConfig;
}

export const EMPTY_FORM: ServerForm = {
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  cwd: "",
  url: "",
  env: "",
  headers: "",
  lifecycle: "lazy",
  directTools: false,
  directToolsList: "",
  includeTools: "",
  excludeTools: "",
  toolPrefix: "server",
  disabled: false,
};

export function asLines(values: unknown): string {
  return Array.isArray(values) ? values.filter((value) => typeof value === "string").join("\n") : "";
}

export function asObjectText(value: unknown): string {
  return value && typeof value === "object" && !Array.isArray(value)
    ? JSON.stringify(value, null, 2)
    : "";
}

export function toForm(name: string, server: McpServerConfig): ServerForm {
  return {
    name,
    transport: server.url ? "http" : "stdio",
    command: server.command ?? "",
    args: asLines(server.args),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    env: asObjectText(server.env),
    headers: asObjectText(server.headers),
    lifecycle: server.lifecycle ?? "lazy",
    directTools: server.directTools === true || Array.isArray(server.directTools),
    directToolsList: asLines(server.directTools),
    includeTools: asLines(server.includeTools),
    excludeTools: asLines(server.excludeTools),
    toolPrefix: server.toolPrefix ?? "server",
    disabled: server.disabled === true,
    preserved: { ...server },
  };
}

function parseObject(text: string, label: string): Record<string, string> | undefined {
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") throw new Error(`${label}.${key} must be a string`);
  }
  return parsed as Record<string, string>;
}

export function toConfig(form: ServerForm): McpServerConfig {
  const config: McpServerConfig = {
    ...(form.preserved ?? {}),
    lifecycle: form.lifecycle,
    toolPrefix: form.toolPrefix,
    disabled: form.disabled,
  };
  delete config.command;
  delete config.args;
  delete config.cwd;
  delete config.url;
  delete config.directTools;
  delete config.env;
  delete config.headers;
  delete config.includeTools;
  delete config.excludeTools;
  if (form.transport === "stdio") {
    if (!form.command.trim()) throw new Error("A command is required for stdio servers");
    config.command = form.command.trim();
    const args = form.args.split("\n").map((arg) => arg.trim()).filter(Boolean);
    if (args.length) config.args = args;
    if (form.cwd.trim()) config.cwd = form.cwd.trim();
  } else {
    if (!form.url.trim()) throw new Error("A URL is required for HTTP servers");
    config.url = form.url.trim();
  }
  const env = parseObject(form.env, "Environment variables");
  const headers = parseObject(form.headers, "Headers");
  if (env) config.env = env;
  if (headers) config.headers = headers;
  const directTools = form.directToolsList.split("\n").map((value) => value.trim()).filter(Boolean);
  config.directTools = directTools.length ? directTools : form.directTools;
  const include = form.includeTools.split("\n").map((value) => value.trim()).filter(Boolean);
  const exclude = form.excludeTools.split("\n").map((value) => value.trim()).filter(Boolean);
  if (include.length) config.includeTools = include;
  if (exclude.length) config.excludeTools = exclude;
  return config;
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  border: `1px solid ${HAIRLINE}`,
  borderRadius: 12,
  background: PAPER.sunken,
  color: INK.ink900,
  fontFamily: SANS,
  fontSize: 13.5,
  padding: "9px 12px",
  resize: "vertical",
  outline: "none",
  caretColor: SEAL.red,
};

function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <label style={{ display: "grid", gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: INK.ink700 }}>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          rows={3}
          style={{ ...inputStyle, fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 }}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          style={{ ...inputStyle, ...(value ? {} : { color: INK.ink300 }) }}
        />
      )}
    </label>
  );
}

export function ServerEditorModal({
  title,
  initial,
  onSave,
  onCancel,
}: {
  title: string;
  initial: ServerForm;
  onSave: (form: ServerForm) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [form, setForm] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof ServerForm>(key: K, value: ServerForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setError(null);
    try {
      toConfig(form);
      setSaving(true);
      await onSave(form);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 60,
          background: BACKDROP,
          display: "flex",
          alignItems: "flex-end",
          justifyContent: "center",
        }}
        onClick={onCancel}
      >
        <motion.div
          initial={{ y: 48, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 48, opacity: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          onClick={(event) => event.stopPropagation()}
          style={{
            width: "min(560px, 100%)",
            maxHeight: "88vh",
            overflowY: "auto",
            background: PAPER.elevated,
            border: `1px solid ${HAIRLINE}`,
            borderBottom: "none",
            borderRadius: "18px 18px 0 0",
            display: "grid",
            gap: 0,
          }}
        >
          {/* sheet header */}
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: 12,
              padding: "20px 22px 12px",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontFamily: SERIF,
                fontSize: 22,
                fontWeight: 500,
                letterSpacing: "0.01em",
                color: INK.ink900,
              }}
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={onCancel}
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontFamily: SANS,
                fontSize: 13,
                color: INK.ink500,
                padding: "4px 0",
              }}
            >
              {t("mcp.cancel")}
            </button>
          </div>

          {/* form body */}
          <div style={{ padding: "6px 22px 10px", display: "grid", gap: 13 }}>
            <Field
              label={t("mcp.serverName")}
              value={form.name}
              onChange={(value) => set("name", value)}
              placeholder="chrome-devtools"
            />
            <div style={{ display: "grid", gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: INK.ink700 }}>{t("mcp.transport")}</span>
              <PillSegmented
                options={["stdio", "http"] as const}
                value={form.transport}
                onChange={(value) => set("transport", value)}
                labelOf={(value) => (value === "stdio" ? "stdio" : "http")}
              />
            </div>
            {form.transport === "stdio" ? (
              <>
                <Field label={t("mcp.command")} value={form.command} onChange={(value) => set("command", value)} placeholder="npx" />
                <Field label={t("mcp.arguments")} value={form.args} onChange={(value) => set("args", value)} placeholder={"-y\nchrome-devtools-mcp@1.6.0"} multiline />
                <Field label={t("mcp.cwd")} value={form.cwd} onChange={(value) => set("cwd", value)} placeholder="~/projects/docs" />
              </>
            ) : (
              <Field label={t("mcp.url")} value={form.url} onChange={(value) => set("url", value)} placeholder="https://mcp.example.com/mcp" />
            )}

            {/* advanced */}
            <div>
              <button
                type="button"
                onClick={() => setAdvanced((value) => !value)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  width: "fit-content",
                  border: "none",
                  background: "transparent",
                  color: INK.ink500,
                  cursor: "pointer",
                  padding: "4px 0",
                  fontFamily: SANS,
                  fontSize: 12.5,
                  fontWeight: 600,
                }}
              >
                {advanced ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                {t("mcp.advanced")}
                <span style={{ fontWeight: 400, color: INK.ink300 }}>{t("mcp.advancedHint")}</span>
              </button>
              {advanced && (
                <div style={{ display: "grid", gap: 13, paddingTop: 10 }}>
                  <Field label={t("mcp.envJson")} value={form.env} onChange={(value) => set("env", value)} placeholder={'{"TOKEN":"${TOKEN}"}'} multiline />
                  <Field label={t("mcp.headersJson")} value={form.headers} onChange={(value) => set("headers", value)} placeholder={'{"Authorization":"Bearer ${TOKEN}"}'} multiline />
                  <div style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: INK.ink700 }}>{t("mcp.lifecycle")}</span>
                    <select
                      value={form.lifecycle}
                      onChange={(event) => set("lifecycle", event.target.value as ServerForm["lifecycle"])}
                      style={{ ...inputStyle, width: "fit-content", minWidth: 180, cursor: "pointer" }}
                    >
                      <option value="lazy">lazy</option>
                      <option value="eager">eager</option>
                      <option value="keep-alive">keep-alive</option>
                      <option value="lazy-keep-alive">lazy-keep-alive</option>
                    </select>
                  </div>
                  <Field label={t("mcp.includeTools")} value={form.includeTools} onChange={(value) => set("includeTools", value)} placeholder="search\nfetch" multiline />
                  <Field label={t("mcp.excludeTools")} value={form.excludeTools} onChange={(value) => set("excludeTools", value)} placeholder="delete_*" multiline />
                  <div style={{ display: "grid", gap: 6 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: INK.ink700 }}>{t("mcp.toolPrefix")}</span>
                    <PillSegmented
                      options={["server", "short", "none", "mcp"] as const}
                      value={form.toolPrefix}
                      onChange={(value) => set("toolPrefix", value)}
                    />
                  </div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "10px 0 2px",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: 13.5, color: INK.ink900 }}>{t("mcp.directTools")}</div>
                      <div style={{ fontSize: 11.5, color: INK.ink500, marginTop: 2 }}>{t("mcp.directToolsDetail")}</div>
                    </div>
                    <InkSwitch checked={form.directTools} onChange={(value) => set("directTools", value)} />
                  </div>
                  {form.directTools && (
                    <Field label={t("mcp.directToolsList")} value={form.directToolsList} onChange={(value) => set("directToolsList", value)} placeholder="search\nfetch" multiline />
                  )}
                </div>
              )}
            </div>

            {/* enabled toggle */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "8px 0 2px",
              }}
            >
              <div>
                <div style={{ fontSize: 13.5, color: INK.ink900 }}>{t("mcp.enabled")}</div>
                <div style={{ fontSize: 11.5, color: INK.ink500, marginTop: 2 }}>{t("mcp.enabledDetail")}</div>
              </div>
              <InkSwitch checked={!form.disabled} onChange={(value) => set("disabled", !value)} />
            </div>

            {error && (
              <div role="alert" style={{ fontSize: 12.5, color: SEAL.red }}>
                {error}
              </div>
            )}

            {/* credential hint */}
            <div
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 7,
                fontSize: 11.5,
                color: INK.ink500,
                lineHeight: 1.5,
              }}
            >
              <Info size={13} style={{ flexShrink: 0, marginTop: 1, color: SEAL.red, opacity: 0.75 }} />
              <span>{t("mcp.credHint")}</span>
            </div>
          </div>

          {/* sheet footer — save bar */}
          <div style={{ padding: "14px 22px 20px", borderTop: `1px solid ${HAIRLINE}` }}>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              style={{
                width: "100%",
                height: 42,
                borderRadius: 99,
                border: "none",
                background: SEAL.red,
                color: SEAL.onSeal,
                fontFamily: SANS,
                fontSize: 14,
                fontWeight: 600,
                cursor: saving ? "wait" : "pointer",
                transition: "background 180ms",
              }}
              onMouseEnter={(event) => {
                if (!saving) event.currentTarget.style.background = SEAL.hover;
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = SEAL.red;
              }}
            >
              {saving ? t("mcp.saving") : t("mcp.save")}
            </button>
            <div
              style={{
                marginTop: 10,
                textAlign: "center",
                fontSize: 11,
                color: INK.ink500,
              }}
            >
              {t("mcp.trustHint")}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
