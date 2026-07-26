"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Badge } from "@appica/ui-react/badge";
import { Button } from "@appica/ui-react/button";
import { usePi, THINKING_LEVELS } from "@/lib/pi/store";
import { usePiSettings } from "@/lib/pi/settings";
import { usePiModels, API_TYPES, type CustomModelDef } from "@/lib/pi/models";
import {
  SettingsPage,
  InsetGroup,
  GroupRow,
  Segmented,
  StringListEditor,
} from "@/components/settings-ui";
import { PROVIDER_META, fmtCtx } from "@/components/provider-meta";
import { useT } from "@/lib/i18n";
import { Settings, Check, Plus, X, Boxes } from "lucide-react";

const fieldInput: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  fontSize: 13,
  fontFamily: "var(--font-mono, monospace)",
  color: "var(--text-primary)",
  background: "var(--bg-sunken)",
  border: "1px solid var(--separator)",
  borderRadius: 8,
  outline: "none",
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "block", minWidth: 0 }}>
      <span
        style={{
          display: "block",
          fontSize: 12,
          color: "var(--text-tertiary)",
          margin: "0 0 4px 2px",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

/** Inline "add custom model" form — writes to ~/.pi/agent/models.json. */
function AddModelForm({ onDone }: { onDone: () => void }) {
  const t = useT();
  const custom = usePiModels();

  const [providerId, setProviderId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [api, setApi] = useState<string>(API_TYPES[0]);
  const [apiKey, setApiKey] = useState("");
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [contextWindow, setContextWindow] = useState("");
  const [maxTokens, setMaxTokens] = useState("");
  const [reasoning, setReasoning] = useState(false);

  const existingProvider = custom.data.providers[providerId.trim()];
  // an existing provider already carries baseUrl/apiKey — only new ones need them
  const valid =
    providerId.trim() !== "" &&
    modelId.trim() !== "" &&
    (existingProvider !== undefined || baseUrl.trim() !== "");

  const submit = async () => {
    if (!valid) return;
    const model: CustomModelDef = { id: modelId.trim() };
    if (name.trim()) model.name = name.trim();
    model.reasoning = reasoning;
    model.input = ["text", "image"];
    const ctx = Number(contextWindow);
    if (contextWindow.trim() && Number.isFinite(ctx) && ctx > 0) model.contextWindow = ctx;
    const max = Number(maxTokens);
    if (maxTokens.trim() && Number.isFinite(max) && max > 0) model.maxTokens = max;

    await custom.addModel(
      providerId.trim(),
      { baseUrl: baseUrl.trim(), api, apiKey: apiKey.trim() || undefined },
      model
    );
    onDone();
  };

  return (
    <div
      style={{
        padding: "12px 16px 14px",
        borderTop: "1px solid var(--separator)",
        display: "grid",
        gap: 10,
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("models.providerId")}>
          <input
            type="text"
            value={providerId}
            placeholder="my-provider"
            onChange={(e) => setProviderId(e.target.value)}
            style={fieldInput}
          />
        </Field>
        <Field label={t("models.apiType")}>
          <select
            value={api}
            onChange={(e) => setApi(e.target.value)}
            style={{ ...fieldInput, height: 32 }}
          >
            {API_TYPES.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label={t("models.baseUrl")}>
        <input
          type="text"
          value={baseUrl}
          placeholder={
            existingProvider
              ? existingProvider.baseUrl
              : "https://api.example.com/v1"
          }
          onChange={(e) => setBaseUrl(e.target.value)}
          style={fieldInput}
        />
      </Field>
      <Field label={t("models.apiKey")}>
        <input
          type="password"
          value={apiKey}
          placeholder={existingProvider?.apiKey ? "••••••" : "sk-…"}
          onChange={(e) => setApiKey(e.target.value)}
          style={fieldInput}
        />
      </Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("models.modelId")}>
          <input
            type="text"
            value={modelId}
            placeholder="gpt-5-mini"
            onChange={(e) => setModelId(e.target.value)}
            style={fieldInput}
          />
        </Field>
        <Field label={t("models.modelName")}>
          <input
            type="text"
            value={name}
            placeholder="GPT-5 Mini"
            onChange={(e) => setName(e.target.value)}
            style={fieldInput}
          />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label={t("models.contextWindow")}>
          <input
            type="text"
            inputMode="numeric"
            value={contextWindow}
            placeholder="200000"
            onChange={(e) => setContextWindow(e.target.value)}
            style={fieldInput}
          />
        </Field>
        <Field label={t("models.maxTokens")}>
          <input
            type="text"
            inputMode="numeric"
            value={maxTokens}
            placeholder="16384"
            onChange={(e) => setMaxTokens(e.target.value)}
            style={fieldInput}
          />
        </Field>
      </div>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 13,
          color: "var(--text-primary)",
          cursor: "pointer",
        }}
      >
        <input
          type="checkbox"
          checked={reasoning}
          onChange={(e) => setReasoning(e.target.checked)}
          style={{ accentColor: "var(--accent)" }}
        />
        {t("models.reasoningToggle")}
      </label>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 }}>
        <Button variant="ghost" size="sm" onClick={onDone} style={{ borderRadius: 8 }}>
          {t("models.cancel")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={!valid}
          style={{ borderRadius: 8, opacity: valid ? 1 : 0.5 }}
        >
          {t("models.addConfirm")}
        </Button>
      </div>
    </div>
  );
}

export default function ModelsPage() {
  const { models, currentModel, thinkingLevel, setModel, setThinking, mock, status } =
    usePi();
  const settings = usePiSettings();
  const custom = usePiModels();
  const t = useT();
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    settings.load();
    custom.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const providers = [...new Set(models.map((m) => m.provider))];

  const customEntries = Object.entries(custom.data.providers).flatMap(
    ([pid, p]) => (p.models ?? []).map((m) => ({ pid, provider: p, model: m }))
  );

  return (
    <SettingsPage
      title={t("models.title")}
      subtitle={
        mock
          ? t("models.subtitleMock")
          : t("models.subtitleLive", { status: t(`status.${status}`) })
      }
    >
      {/* restart-needed banner — model edits apply after a pi restart */}
      <AnimatePresence>
        {settings.dirtyRestart && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: 16,
                padding: "10px 14px",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--separator)",
                background: "var(--accent-muted)",
                fontSize: 13,
                color: "var(--text-primary)",
              }}
            >
              <span style={{ flex: 1 }}>{t("settings.saved")}</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => settings.restartPi()}
                disabled={settings.busy}
                style={{ borderRadius: 8, opacity: settings.busy ? 0.6 : 1 }}
              >
                {settings.busy ? t("settings.restarting") : t("settings.restartPi")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* active model hero card */}
      <InsetGroup header={t("models.activeModel")}>
        {currentModel ? (
          <GroupRow
            first
            icon={PROVIDER_META[currentModel.provider]?.icon ?? <Settings size={16} />}
            iconBg={PROVIDER_META[currentModel.provider]?.bg}
            title={
              <span style={{ fontWeight: 600 }}>
                {currentModel.name ?? currentModel.id}
              </span>
            }
            detail={`${PROVIDER_META[currentModel.provider]?.label ?? currentModel.provider} · ${fmtCtx(currentModel.contextWindow)}${currentModel.reasoning ? ` · ${t("models.reasoning")}` : ""}`}
            trailing={
              <motion.span
                key={currentModel.id}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 24 }}
              >
                <Badge variant="success" size="sm">
                  {t("models.activeBadge")}
                </Badge>
              </motion.span>
            }
          />
        ) : (
          <GroupRow first title={t("models.noModel")} detail={t("models.pickBelow")} />
        )}
      </InsetGroup>

      {/* thinking level */}
      <InsetGroup
        header={t("models.thinkingLevel")}
        footer={t("models.thinkingFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={THINKING_LEVELS}
            value={thinkingLevel}
            onChange={setThinking}
          />
        </div>
      </InsetGroup>

      {/* custom models — ~/.pi/agent/models.json */}
      <InsetGroup
        header={t("models.custom")}
        footer={
          custom.parseError
            ? t("models.customParseError", { error: custom.parseError })
            : t("models.customFooter")
        }
      >
        {customEntries.length === 0 && !adding && (
          <GroupRow
            first
            icon={<Boxes size={16} />}
            iconBg="var(--text-tertiary)"
            title={t("models.customEmpty")}
          />
        )}
        {customEntries.map(({ pid, provider, model }, i) => (
          <GroupRow
            key={`${pid}/${model.id}`}
            first={i === 0}
            icon={PROVIDER_META[pid]?.icon ?? <Boxes size={16} />}
            iconBg={PROVIDER_META[pid]?.bg}
            title={model.name ?? model.id}
            detail={`${pid} · ${model.id} · ${fmtCtx(model.contextWindow)}${model.reasoning ? ` · ${t("models.reasoning")}` : ""} · ${provider.baseUrl}`}
            trailing={
              <motion.button
                whileTap={{ scale: 0.85 }}
                aria-label={t("models.removeModel")}
                title={t("models.removeModel")}
                onClick={() => custom.removeModel(pid, model.id)}
                style={{
                  display: "grid",
                  placeItems: "center",
                  width: 24,
                  height: 24,
                  border: "none",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--danger)",
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                <X size={14} />
              </motion.button>
            }
          />
        ))}
        {adding ? (
          <AddModelForm onDone={() => setAdding(false)} />
        ) : (
          <GroupRow
            first={false}
            icon={<Plus size={16} />}
            iconBg="var(--accent)"
            title={
              <span style={{ color: "var(--accent)", fontWeight: 500 }}>
                {t("models.addModel")}
              </span>
            }
            onClick={custom.parseError ? undefined : () => setAdding(true)}
          />
        )}
      </InsetGroup>

      {/* model cycling — enabledModels patterns in global settings.json */}
      <InsetGroup
        header={t("models.cycling")}
        footer={t("models.cyclingFooter")}
      >
        <StringListEditor
          items={settings.global.data?.enabledModels as string[] | undefined}
          onChange={(items) => settings.setKey("global", "enabledModels", items)}
          addPlaceholder={t("models.cyclingPlaceholder")}
        />
      </InsetGroup>

      {/* all models, grouped by provider */}
      {providers.map((p) => (
        <InsetGroup key={p} header={PROVIDER_META[p]?.label ?? p}>
          {models
            .filter((m) => m.provider === p)
            .map((m, i) => {
              const active =
                currentModel?.id === m.id && currentModel?.provider === m.provider;
              return (
                <GroupRow
                  key={`${m.provider}/${m.id}`}
                  first={i === 0}
                  icon={PROVIDER_META[p]?.icon ?? <Settings size={16} />}
                  iconBg={PROVIDER_META[p]?.bg}
                  title={m.name ?? m.id}
                  detail={`${m.id} · ${fmtCtx(m.contextWindow)}${m.reasoning ? ` · ${t("models.reasoning")}` : ""}`}
                  onClick={() => setModel(m)}
                  trailing={
                    active ? (
                      <motion.span
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 22 }}
                        style={{ color: "var(--accent)", fontSize: 15, fontWeight: 700 }}
                      >
                        <Check size={14} />
                      </motion.span>
                    ) : undefined
                  }
                />
              );
            })}
        </InsetGroup>
      ))}
    </SettingsPage>
  );
}
