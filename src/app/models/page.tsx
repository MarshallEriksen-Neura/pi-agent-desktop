"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Check,
  ChevronDown,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  X,
} from "lucide-react";

import {
  GroupRow,
  InsetGroup,
  SettingsPage,
} from "@/components/settings-ui";
import { ProviderMeta, PROVIDER_META } from "@/components/provider-meta";
import { ModelIcon } from "@/components/icons";
import { resolveModelMetaOrFallback } from "@/lib/model-icon";
import { useT } from "@/lib/i18n";
import { isTauri } from "@/lib/pi/client";
import { usePi } from "@/lib/pi/store";
import { usePiSettings } from "@/lib/pi/settings";
import {
  API_TYPES,
  type CustomModelDef,
  type CustomProvider,
  usePiModels,
} from "@/lib/pi/models";
import {
  type ModelRefLike,
  isModelEnabled,
  modelRef,
  toggleModelEnabled,
} from "@/lib/pi/model-scope";

const spring = { type: "spring" as const, stiffness: 320, damping: 28 };

async function confirmRemoval(message: string): Promise<boolean> {
  if (!isTauri()) return window.confirm(message);
  const { confirm } = await import("@tauri-apps/plugin-dialog");
  return confirm(message);
}

export default function ModelsPage() {
  const t = useT();

  const piStatus = usePi((s) => s.status);
  const piModels = usePi((s) => s.models);

  const piModelsStore = usePiModels();
  const customProviders = piModelsStore.data.providers;
  const customLoaded = piModelsStore.loaded;

  const piSettings = usePiSettings();
  const dirtyRestart = piSettings.dirtyRestart;
  const enabledModels = piSettings.effective().enabledModels ?? [];

  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [addingProvider, setAddingProvider] = useState(false);
  const [editingProvider, setEditingProvider] = useState<{ id: string; provider: CustomProvider } | null>(null);
  const [addingModelProviderId, setAddingModelProviderId] = useState<string | null>(null);
  const [editingModel, setEditingModel] = useState<
    { providerId: string; model: CustomModelDef } | null
  >(null);
  const [fetchingProviderId, setFetchingProviderId] = useState<string | null>(null);
  const [fetchResult, setFetchResult] = useState<{
    providerId: string;
    models: string[];
    selected: string[];
  } | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    piModelsStore.load();
    piSettings.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ids = Object.keys(customProviders);
    if (ids.length > 0) {
      setExpanded((prev) => {
        const next = { ...prev };
        let changed = false;
        ids.forEach((id) => {
          if (next[id] === undefined) {
            next[id] = true;
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }
  }, [customProviders]);

  /**
   * Every model we can name in a scope entry: what pi reports plus the
   * models.json definitions (a freshly added provider isn't in pi's list until
   * it restarts). Used to rewrite a legacy bare-id entry into per-provider refs.
   */
  const scopeModels = useMemo<ModelRefLike[]>(() => {
    const list = piModels.map((m) => ({ provider: m.provider, id: m.id }));
    const seen = new Set(list.map((m) => modelRef(m.provider, m.id)));
    for (const [providerId, provider] of Object.entries(customProviders)) {
      for (const m of provider.models ?? []) {
        const ref = modelRef(providerId, m.id);
        if (seen.has(ref)) continue;
        seen.add(ref);
        list.push({ provider: providerId, id: m.id });
      }
    }
    return list;
  }, [piModels, customProviders]);

  const setEnabled = async (providerId: string, modelId: string) => {
    const next = toggleModelEnabled(enabledModels, providerId, modelId, scopeModels);
    await piSettings.setKey(
      "global",
      "enabledModels",
      next.length > 0 ? next : undefined
    );
  };

  const toggleExpanded = (providerId: string) => {
    setExpanded((prev) => ({ ...prev, [providerId]: !prev[providerId] }));
  };
  const handleSaveProvider = async (providerId: string, provider: CustomProvider) => {
    await piModelsStore.updateProvider(providerId, {
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: provider.apiKey,
    });
    setAddingProvider(false);
    setEditingProvider(null);
  };

  const handleRemoveProvider = async (providerId: string) => {
    if (!(await confirmRemoval(t("models.removeProvider") + "?"))) return;
    await piModelsStore.removeProvider(providerId);
  };

  const handleSaveModel = async (
    providerId: string,
    model: CustomModelDef,
    original?: { providerId: string; modelId: string }
  ) => {
    if (original) {
      await piModelsStore.updateModel(
        original.providerId,
        original.modelId,
        providerId,
        {
          baseUrl: customProviders[providerId]?.baseUrl ?? "",
          api: customProviders[providerId]?.api ?? API_TYPES[0],
          apiKey: customProviders[providerId]?.apiKey,
        },
        model
      );
    } else {
      await piModelsStore.addModel(providerId, {
        baseUrl: customProviders[providerId]?.baseUrl ?? "",
        api: customProviders[providerId]?.api ?? API_TYPES[0],
        apiKey: customProviders[providerId]?.apiKey,
      }, model);
    }
    setAddingModelProviderId(null);
    setEditingModel(null);
  };

  const handleRemoveModel = async (providerId: string, modelId: string) => {
    if (!(await confirmRemoval(t("models.removeModel") + "?"))) return;
    await piModelsStore.removeModel(providerId, modelId);
  };

  const handleFetch = async (providerId: string) => {
    const provider = customProviders[providerId];
    if (!provider) return;
    setFetchingProviderId(providerId);
    setFetchError(null);
    try {
      const list = await piModelsStore.fetchModels(provider.baseUrl, provider.api, provider.apiKey);
      const existing = new Set(provider.models.map((m) => m.id));
      const selectable = list.filter((id) => !existing.has(id));
      setFetchResult({
        providerId,
        models: selectable,
        selected: selectable,
      });
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setFetchingProviderId(null);
    }
  };

  const handleAddFetched = async () => {
    if (!fetchResult) return;
    const provider = customProviders[fetchResult.providerId];
    if (!provider) return;
    await piModelsStore.addModels(
      fetchResult.providerId,
      {
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKey: provider.apiKey,
      },
      fetchResult.selected.map((id) => ({ id, name: id }))
    );
    setFetchResult(null);
  };

  const filteredProviderEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    return Object.entries(customProviders)
      .map(([providerId, provider]) => {
        const providerMatch = providerId.toLowerCase().includes(term);
        const matchedModels = provider.models.filter(
          (m) =>
            providerMatch ||
            m.id.toLowerCase().includes(term) ||
            (m.name && m.name.toLowerCase().includes(term))
        );
        return { providerId, provider, matchedModels, providerMatch };
      })
      .filter(({ matchedModels, providerMatch }) => providerMatch || matchedModels.length > 0);
  }, [customProviders, search]);

  const paperBg = "var(--ink-paper-bg)";

  return (
    <SettingsPage title={t("models.title")} subtitle={t("models.customModelsHelp")}>
      <div
        className="min-h-full"
        style={{
          background: paperBg,
          padding: "8px 0 48px",
        }}
      >
        <div style={{ display: "grid", gap: 20 }}>
          {/* Toolbar */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.05 }}
            className="flex items-center gap-3"
          >
            <div
              className="flex flex-1 items-center gap-2 rounded-2xl px-3.5 py-2.5"
              style={{
                background: "var(--input-bg)",
                border: "1px solid var(--ink-border)",
                boxShadow: "inset 0 1px 2px rgba(0,0,0,0.04)",
              }}
            >
              <Search size={16} style={{ color: "var(--muted-foreground)" }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("models.searchModels")}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
                style={{ color: "var(--foreground)" }}
              />
              {search && (
                <button onClick={() => setSearch("")} style={{ color: "var(--muted-foreground)" }}>
                  <X size={14} />
                </button>
              )}
            </div>
            <button
              onClick={() => setAddingProvider(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-2xl px-4 py-2.5 text-sm font-medium transition-transform active:scale-95"
              style={{
                background: "var(--ink-accent)",
                color: "#fff",
                boxShadow: "0 6px 20px rgba(44,90,160,0.28)",
              }}
            >
              <Plus size={16} />
              {t("models.addProvider")}
            </button>
          </motion.div>

          {/* Provider cards */}
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...spring, delay: 0.1 }}
            style={{ display: "grid", gap: 14 }}
          >
            {filteredProviderEntries.map(({ providerId, provider, matchedModels }) => {
              const isOpen = !!expanded[providerId];
              const enabledCount = provider.models.filter((m) =>
                isModelEnabled(enabledModels, providerId, m.id)
              ).length;
              return (
                <div
                  key={providerId}
                  className="overflow-hidden"
                  style={{
                    borderRadius: 24,
                    background: "var(--card-bg)",
                    border: "1px solid var(--ink-border)",
                    boxShadow: "0 12px 40px rgba(0,0,0,0.06)",
                  }}
                >
                  <button
                    onClick={() => toggleExpanded(providerId)}
                    className="flex w-full items-center justify-between p-4 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ProviderMeta provider={providerId} size={22} />
                      <div className="min-w-0">
                        <p
                          className="truncate text-[15px] font-semibold"
                          style={{ color: "var(--ink-title)" }}
                        >
                          {PROVIDER_META[providerId]?.label ?? providerId}
                        </p>
                        <p
                          className="truncate text-xs"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {t("models.modelCount", { n: provider.models.length })}
                          {enabledCount > 0 && (
                            <>
                              {" · "}
                              {t("models.enabledInChat")}: {enabledCount}
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {provider.models.length > 0 && (
                        <span
                          className="hidden text-xs sm:inline"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {isOpen ? t("models.configure") : t("models.configure")}
                        </span>
                      )}
                      <motion.div
                        animate={{ rotate: isOpen ? 180 : 0 }}
                        transition={{ duration: 0.25 }}
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        <ChevronDown size={18} />
                      </motion.div>
                    </div>
                  </button>

                  <AnimatePresence initial={false}>
                    {isOpen && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: [0.25, 0.46, 0.45, 0.94] }}
                        className="overflow-hidden"
                      >
                        <div
                          style={{
                            borderTop: "1px solid var(--ink-border)",
                            padding: "16px",
                            background: "var(--ink-row-open-bg)",
                          }}
                        >
                          {/* Provider actions */}
                          <div className="mb-4 flex flex-wrap gap-2">
                            <button
                              onClick={() => setEditingProvider({ id: providerId, provider })}
                              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors"
                              style={{
                                background: "var(--input-bg)",
                                border: "1px solid var(--ink-border)",
                                color: "var(--foreground)",
                              }}
                            >
                              <Settings2 size={13} />
                              {t("models.providerSettings")}
                            </button>
                            <button
                              onClick={() => handleFetch(providerId)}
                              disabled={fetchingProviderId === providerId}
                              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                              style={{
                                background: "var(--input-bg)",
                                border: "1px solid var(--ink-border)",
                                color: "var(--foreground)",
                              }}
                            >
                              <RefreshCw
                                size={13}
                                className={fetchingProviderId === providerId ? "animate-spin" : ""}
                              />
                              {t("models.fetchModels")}
                            </button>
                            <button
                              onClick={() => setAddingModelProviderId(providerId)}
                              className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors"
                              style={{
                                background: "var(--input-bg)",
                                border: "1px solid var(--ink-border)",
                                color: "var(--foreground)",
                              }}
                            >
                              <Plus size={13} />
                              {t("models.addModel")}
                            </button>
                            <button
                              onClick={() => handleRemoveProvider(providerId)}
                              className="ml-auto inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium transition-colors"
                              style={{
                                background: "rgba(196,92,72,0.08)",
                                color: "#c45c48",
                                border: "1px solid rgba(196,92,72,0.18)",
                              }}
                            >
                              <Trash2 size={13} />
                              {t("models.removeProvider")}
                            </button>
                          </div>

                          {/* Models grid */}
                          {matchedModels.length === 0 ? (
                            <div
                              className="rounded-2xl py-8 text-center text-sm"
                              style={{
                                background: "var(--input-bg)",
                                color: "var(--muted-foreground)",
                              }}
                            >
                              {t("models.noSearchResults")}
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                              {matchedModels.map((model) => {
                                const enabled = isModelEnabled(
                                  enabledModels,
                                  providerId,
                                  model.id
                                );
                                const meta = resolveModelMetaOrFallback(model.id, providerId);
                                return (
                                  <motion.div
                                    key={model.id}
                                    layout
                                    whileTap={{ scale: 0.98 }}
                                    className="group flex items-center gap-2.5 rounded-2xl border p-3 transition-shadow"
                                    style={{
                                      background: "var(--input-bg)",
                                      borderColor: enabled
                                        ? "rgba(44,90,160,0.35)"
                                        : "var(--ink-border)",
                                      boxShadow: enabled
                                        ? "0 0 0 1px rgba(44,90,160,0.1)"
                                        : "none",
                                    }}
                                  >
                                    <button
                                      onClick={() => setEnabled(providerId, model.id)}
                                      className="flex shrink-0 items-center justify-center rounded-lg transition-colors"
                                      style={{
                                        width: 22,
                                        height: 22,
                                        background: enabled
                                          ? "var(--ink-accent)"
                                          : "var(--card-bg)",
                                        border: "1.5px solid",
                                        borderColor: enabled
                                          ? "var(--ink-accent)"
                                          : "var(--ink-border)",
                                        color: enabled ? "#fff" : "transparent",
                                      }}
                                    >
                                      <Check size={13} strokeWidth={3} />
                                    </button>
                                    <span style={{ flexShrink: 0, display: "inline-flex" }}>
                                      <ModelIcon iconKey={meta.iconKey} size={16} color={meta.color} />
                                    </span>
                                    <div
                                      className="min-w-0 flex-1 cursor-pointer"
                                      onClick={() =>
                                        setEditingModel({ providerId, model })
                                      }
                                    >
                                      <p
                                        className="truncate text-sm font-medium"
                                        style={{ color: "var(--ink-title)" }}
                                      >
                                        {model.name || model.id}
                                      </p>
                                      <p
                                        className="truncate text-[11px]"
                                        style={{ color: "var(--muted-foreground)" }}
                                      >
                                        {model.id}
                                      </p>
                                    </div>
                                    <button
                                      onClick={() => handleRemoveModel(providerId, model.id)}
                                      className="opacity-0 transition-opacity group-hover:opacity-100"
                                      style={{ color: "var(--muted-foreground)" }}
                                    >
                                      <X size={14} />
                                    </button>
                                  </motion.div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            {filteredProviderEntries.length === 0 && customLoaded && (
              <div
                className="rounded-3xl border py-12 text-center"
                style={{
                  background: "var(--card-bg)",
                  borderColor: "var(--ink-border)",
                }}
              >
                <div
                  className="mx-auto mb-3 flex items-center justify-center rounded-2xl"
                  style={{
                    width: 56,
                    height: 56,
                    background: "rgba(44,90,160,0.08)",
                    color: "var(--ink-accent)",
                  }}
                >
                  <Bot size={24} strokeWidth={1.5} />
                </div>
                <p
                  className="px-6 text-sm"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {search ? t("models.noSearchResults") : t("models.noProviders")}
                </p>
                {!search && (
                  <button
                    onClick={() => setAddingProvider(true)}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium"
                    style={{ background: "var(--ink-accent)", color: "#fff" }}
                  >
                    <Plus size={16} />
                    {t("models.addProvider")}
                  </button>
                )}
              </div>
            )}
          </motion.section>

          {/* Enabled in chat note */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2 }}
            className="rounded-2xl border px-4 py-3 text-xs"
            style={{
              background: "rgba(44,90,160,0.05)",
              borderColor: "rgba(44,90,160,0.18)",
              color: "var(--muted-foreground)",
            }}
          >
            {t("models.enabledInChatFooter")}
          </motion.div>

          {/* All models reported by pi */}
          {piStatus === "ready" && (
            <AllModelsSection
              enabledModels={enabledModels}
              onToggle={setEnabled}
            />
          )}

          {/* Restart hint */}
          {dirtyRestart && (
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="rounded-2xl border px-4 py-3 text-sm"
              style={{
                background: "rgba(196,92,72,0.08)",
                borderColor: "rgba(196,92,72,0.2)",
                color: "#c45c48",
              }}
            >
              {t("models.footer")}
            </motion.div>
          )}
        </div>
      </div>

      {/* Dialogs */}
      <ProviderDialog
        open={addingProvider}
        onClose={() => setAddingProvider(false)}
        onSave={handleSaveProvider}
      />
      {editingProvider && (
        <ProviderDialog
          open
          providerId={editingProvider.id}
          provider={editingProvider.provider}
          onClose={() => setEditingProvider(null)}
          onSave={handleSaveProvider}
        />
      )}
      {addingModelProviderId && (
        <ModelDialog
          open
          providerId={addingModelProviderId}
          onClose={() => setAddingModelProviderId(null)}
          onSave={(m) => handleSaveModel(addingModelProviderId, m)}
        />
      )}
      {editingModel && (
        <ModelDialog
          open
          providerId={editingModel.providerId}
          model={editingModel.model}
          onClose={() => setEditingModel(null)}
          onSave={(m) =>
            handleSaveModel(editingModel.providerId, m, {
              providerId: editingModel.providerId,
              modelId: editingModel.model.id,
            })
          }
        />
      )}
      {fetchResult && (
        <FetchDialog
          result={fetchResult}
          onClose={() => setFetchResult(null)}
          onChangeSelected={(ids) => setFetchResult({ ...fetchResult, selected: ids })}
          onAdd={handleAddFetched}
        />
      )}
      {fetchError && (
        <Dialog
          open
          title={t("models.fetchFailed", { error: "" })}
          onClose={() => setFetchError(null)}
          actions={
            <GroupButton onClick={() => setFetchError(null)}>{t("models.cancel")}</GroupButton>
          }
        >
          <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
            {fetchError}
          </p>
        </Dialog>
      )}
    </SettingsPage>
  );
}

function ProviderDialog({
  open,
  providerId,
  provider,
  onClose,
  onSave,
}: {
  open: boolean;
  providerId?: string;
  provider?: CustomProvider;
  onClose: () => void;
  onSave: (id: string, p: CustomProvider) => void;
}) {
  const t = useT();
  const isEdit = !!provider;
  const [id, setId] = useState(providerId ?? "");
  const [api, setApi] = useState(provider?.api ?? API_TYPES[0]);
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? "");

  useEffect(() => {
    if (open) {
      setId(providerId ?? "");
      setApi(provider?.api ?? API_TYPES[0]);
      setBaseUrl(provider?.baseUrl ?? "");
      setApiKey(provider?.apiKey ?? "");
    }
  }, [open, provider, providerId]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onSave(id.trim(), {
      baseUrl: baseUrl.trim(),
      api,
      apiKey: apiKey.trim() || undefined,
      models: provider?.models ?? [],
    });
  };

  return (
    <Dialog
      open={open}
      title={isEdit ? t("models.providerSettings") : t("models.addProvider")}
      onClose={onClose}
      actions={
        <>
          <GroupButton onClick={onClose}>{t("models.cancel")}</GroupButton>
          <GroupButton primary onClick={() => submit()} disabled={!id.trim()}>
            {isEdit ? t("models.saveProvider") : t("models.createProvider")}
          </GroupButton>
        </>
      }
    >
      <form id="provider-form" onSubmit={submit} className="space-y-3">
        <Field label={t("models.providerId")}>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit}
            placeholder="openai"
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          />
        </Field>
        <Field label={t("models.apiType")}>
          <select
            value={api}
            onChange={(e) => setApi(e.target.value)}
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          >
            {API_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("models.baseUrl")}>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          />
        </Field>
        <Field label={t("models.apiKey")}>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("models.apiKeyPlaceholder")}
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          />
        </Field>
      </form>
    </Dialog>
  );
}

function ModelDialog({
  open,
  providerId,
  model,
  onClose,
  onSave,
}: {
  open: boolean;
  providerId: string;
  model?: CustomModelDef;
  onClose: () => void;
  onSave: (m: CustomModelDef) => void;
}) {
  const t = useT();
  const isEdit = !!model;
  const [id, setId] = useState(model?.id ?? "");
  const [name, setName] = useState(model?.name ?? "");
  const [contextWindow, setContextWindow] = useState(model?.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(model?.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(model?.reasoning ?? false);

  useEffect(() => {
    if (open) {
      setId(model?.id ?? "");
      setName(model?.name ?? "");
      setContextWindow(model?.contextWindow?.toString() ?? "");
      setMaxTokens(model?.maxTokens?.toString() ?? "");
      setReasoning(model?.reasoning ?? false);
    }
  }, [open, model]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    onSave({
      id: id.trim(),
      name: name.trim() || undefined,
      contextWindow: contextWindow ? Number(contextWindow) : undefined,
      maxTokens: maxTokens ? Number(maxTokens) : undefined,
      reasoning,
    });
  };

  return (
    <Dialog
      open={open}
      title={isEdit ? t("models.editModel") : t("models.addModel")}
      onClose={onClose}
      actions={
        <>
          <GroupButton onClick={onClose}>{t("models.cancel")}</GroupButton>
          <GroupButton primary onClick={() => submit()} disabled={!id.trim()}>
            {isEdit ? t("models.editConfirm") : t("models.addConfirm")}
          </GroupButton>
        </>
      }
    >
      <form id="model-form" onSubmit={submit} className="space-y-3">
        <Field label={t("models.modelId")}>
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={isEdit}
            placeholder="gpt-4o"
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          />
        </Field>
        <Field label={t("models.modelName")}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("models.namePlaceholder")}
            className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("models.contextWindow")}>
            <input
              value={contextWindow}
              onChange={(e) => setContextWindow(e.target.value)}
              type="number"
              placeholder="128000"
              className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
              style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
            />
          </Field>
          <Field label={t("models.maxTokens")}>
            <input
              value={maxTokens}
              onChange={(e) => setMaxTokens(e.target.value)}
              type="number"
              placeholder="4096"
              className="w-full rounded-xl border bg-transparent px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
              style={{ borderColor: "var(--ink-border)", color: "var(--foreground)" }}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--foreground)" }}>
          <input
            type="checkbox"
            checked={reasoning}
            onChange={(e) => setReasoning(e.target.checked)}
            className="h-4 w-4 rounded border"
            style={{ accentColor: "var(--ink-accent)" }}
          />
          {t("models.reasoningToggle")}
        </label>
      </form>
    </Dialog>
  );
}

function FetchDialog({
  result,
  onClose,
  onChangeSelected,
  onAdd,
}: {
  result: { providerId: string; models: string[]; selected: string[] };
  onClose: () => void;
  onChangeSelected: (ids: string[]) => void;
  onAdd: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const selected = useMemo(() => new Set(result.selected), [result.selected]);
  const filteredModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return result.models;
    return result.models.filter((id) => id.toLowerCase().includes(query));
  }, [result.models, search]);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChangeSelected(Array.from(next));
  };

  const selectVisible = () => {
    const next = new Set(selected);
    filteredModels.forEach((id) => next.add(id));
    onChangeSelected(Array.from(next));
  };

  const invertVisible = () => {
    const next = new Set(selected);
    filteredModels.forEach((id) => {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    });
    onChangeSelected(Array.from(next));
  };

  return (
    <Dialog
      open
      title={t("models.selectModelsToAdd")}
      onClose={onClose}
      actions={
        <>
          <GroupButton onClick={onClose}>{t("models.cancel")}</GroupButton>
          <GroupButton primary onClick={onAdd} disabled={result.selected.length === 0}>
            {t("models.addAllSelected", { n: result.selected.length })}
          </GroupButton>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-2">
        <div
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl px-3 py-2"
          style={{
            background: "var(--input-bg)",
            border: "1px solid var(--ink-border)",
          }}
        >
          <Search size={15} className="shrink-0" style={{ color: "var(--muted-foreground)" }} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("models.searchModels")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
            style={{ color: "var(--foreground)" }}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              aria-label={t("models.clearSearch")}
              className="shrink-0"
              style={{ color: "var(--muted-foreground)" }}
            >
              <X size={14} />
            </button>
          )}
        </div>
        <GroupButton onClick={selectVisible} disabled={filteredModels.length === 0}>
          {t("models.selectAll")}
        </GroupButton>
        <GroupButton onClick={invertVisible} disabled={filteredModels.length === 0}>
          {t("models.invertSelection")}
        </GroupButton>
      </div>
      <div className="max-h-72 overflow-y-auto pr-1">
        {filteredModels.length === 0 ? (
          <p className="py-4 text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
            {t("models.noSearchResults")}
          </p>
        ) : (
          <InsetGroup>
            {filteredModels.map((id) => (
              <GroupRow
                key={id}
                onClick={() => toggle(id)}
                title={
                  <span className="text-sm" style={{ color: "var(--foreground)" }}>
                    {id}
                  </span>
                }
                trailing={
                  <div
                    className="flex items-center justify-center rounded-md"
                    style={{
                      width: 20,
                      height: 20,
                      background: selected.has(id)
                        ? "var(--ink-accent)"
                        : "transparent",
                      border: "1.5px solid",
                      borderColor: selected.has(id)
                        ? "var(--ink-accent)"
                        : "var(--ink-border)",
                      color: "#fff",
                    }}
                  >
                    {selected.has(id) && <Check size={12} strokeWidth={3} />}
                  </div>
                }
              />
            ))}
          </InsetGroup>
        )}
      </div>
    </Dialog>
  );
}

function AllModelsSection({
  enabledModels,
  onToggle,
}: {
  enabledModels: string[];
  onToggle: (providerId: string, modelId: string) => void | Promise<void>;
}) {
  const t = useT();
  const piModels = usePi((s) => s.models);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    piModels.forEach((m) => {
      const list = map.get(m.provider) ?? [];
      list.push(m.id);
      map.set(m.provider, list);
    });
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [piModels]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: 0.25 }}
      className="overflow-hidden"
      style={{
        borderRadius: 24,
        background: "var(--card-bg)",
        border: "1px solid var(--ink-border)",
      }}
    >
      <div className="border-b px-5 py-4" style={{ borderColor: "var(--ink-border)" }}>
        <h3 className="font-semibold" style={{ color: "var(--ink-title)" }}>
          {t("models.allModels")}
        </h3>
        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          {t("models.allModelsFooter")}
        </p>
      </div>
      <div className="p-4">
        {groups.map(([providerId, modelIds]) => (
          <div key={providerId} className="mb-4 last:mb-0">
            <div className="mb-2 flex items-center gap-2">
              <ProviderMeta provider={providerId} />
              <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                {t("models.modelCount", { n: modelIds.length })}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {modelIds.map((id) => {
                const enabled = isModelEnabled(enabledModels, providerId, id);
                return (
                  <button
                    key={modelRef(providerId, id)}
                    onClick={() => onToggle(providerId, id)}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors"
                    style={{
                      background: enabled
                        ? "rgba(44,90,160,0.12)"
                        : "var(--input-bg)",
                      color: enabled ? "var(--ink-accent)" : "var(--foreground)",
                      border: "1px solid",
                      borderColor: enabled
                        ? "rgba(44,90,160,0.3)"
                        : "var(--ink-border)",
                    }}
                  >
                    {enabled && <Check size={11} strokeWidth={3} />}
                    {id}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {groups.length === 0 && (
          <p className="py-4 text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
            {t("models.noSearchResults")}
          </p>
        )}
      </div>
    </motion.div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="mb-1.5 block text-xs font-medium"
        style={{ color: "var(--muted-foreground)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

function Dialog({
  open,
  title,
  onClose,
  actions,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="dialog-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(0,0,0,0.35)", backdropFilter: "blur(6px)" }}
          onClick={onClose}
        >
          <motion.div
            key="dialog-panel"
            initial={{ opacity: 0, scale: 0.94, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 10 }}
            transition={spring}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 420,
              maxHeight: "80vh",
              overflow: "hidden",
              borderRadius: 22,
              background: "var(--card-bg)",
              border: "1px solid var(--ink-border)",
              boxShadow: "0 24px 80px rgba(0,0,0,0.22)",
            }}
          >
            <div
              className="flex items-center justify-between border-b px-5 py-4"
              style={{ borderColor: "var(--ink-border)" }}
            >
              <h3
                className="text-base font-semibold"
                style={{ color: "var(--ink-title)" }}
              >
                {title}
              </h3>
              <button
                onClick={onClose}
                className="rounded-full p-1 transition-colors"
                style={{ color: "var(--muted-foreground)" }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="p-5">{children}</div>
            {actions && (
              <div
                className="flex justify-end gap-2 border-t px-5 py-4"
                style={{ borderColor: "var(--ink-border)" }}
              >
                {actions}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function GroupButton({
  primary,
  disabled,
  onClick,
  children,
}: {
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-xl px-4 py-2 text-sm font-medium transition-transform active:scale-95 disabled:opacity-50"
      style={{
        background: primary ? "var(--ink-accent)" : "transparent",
        color: primary ? "#fff" : "var(--foreground)",
        border: primary ? "none" : "1px solid var(--ink-border)",
      }}
    >
      {children}
    </button>
  );
}
