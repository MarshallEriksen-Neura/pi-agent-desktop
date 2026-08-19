"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronsDown,
  ChevronsUp,
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
import { getPort } from "@/lib/backend/composition/container";
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

/** First grouping letter of a model id — A–Z, everything else folds into "#". */
function firstLetter(id: string): string {
  const c = id.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(c) ? c : "#";
}

const ALPHA_INDEX = [
  "#", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J",
  "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U",
  "V", "W", "X", "Y", "Z",
];

/** A–Z letters actually present in a provider's models (plus "#"). */
function providerLetterIndex(models: CustomModelDef[]): string[] {
  const set = new Set<string>();
  models.forEach((m) => set.add(firstLetter(m.id)));
  return ALPHA_INDEX.filter((l) => set.has(l));
}

async function confirmRemoval(message: string): Promise<boolean> {
  try {
    return await getPort("window").confirm(message);
  } catch {
    return window.confirm(message);
  }
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

  // Per-provider inline model filter (handles the single-provider-with-hundreds
  // case: filter without losing your place in the page).
  const [cardFilter, setCardFilter] = useState<Record<string, string>>({});
  // Left rail: which provider is in view + element refs for scroll targets.
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const providerEls = useRef<Record<string, HTMLElement | null>>({});
  const modelRowEls = useRef<Record<string, (HTMLElement | null)[]>>({});
  const allModelsEl = useRef<HTMLDivElement | null>(null);
  const scrollerEl = useRef<HTMLDivElement | null>(null);

  const setCardFilterFor = useCallback((providerId: string, value: string) => {
    setCardFilter((prev) => ({ ...prev, [providerId]: value }));
  }, []);

  /** Expand (and scroll to) a provider card — the rail's "jump" action. */
  const jumpToProvider = useCallback((providerId: string) => {
    setExpanded((prev) => ({ ...prev, [providerId]: true }));
    // Give the layout one frame to expand before scrolling to the card.
    requestAnimationFrame(() => {
      providerEls.current[providerId]?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    });
  }, []);

  const jumpToAllModels = useCallback(() => {
    allModelsEl.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const scrollToTop = useCallback(() => {
    scrollerEl.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const expandAll = useCallback(() => {
    setExpanded((prev) => {
      const next = { ...prev };
      Object.keys(customProviders).forEach((providerId) => {
        next[providerId] = true;
      });
      return next;
    });
  }, [customProviders]);

  const collapseAll = useCallback(() => {
    setExpanded({});
  }, []);

  /** Scroll a provider card's model list to the first model at a letter. */
  const jumpToLetter = useCallback(
    (providerId: string, letter: string) => {
      const rows = modelRowEls.current[providerId];
      if (!rows) return;
      const target = rows.find(
        (el) => el?.dataset.letter === letter || (letter === "#" && el?.dataset.letter === "#")
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    },
    []
  );

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

  // Scroll-spy: highlight the provider whose card is nearest the top of the
  // viewport — the rail's "where am I" cue (Wayfinding).
  useEffect(() => {
    const cards = filteredProviderEntries
      .map(({ providerId }) => providerEls.current[providerId])
      .filter((el): el is HTMLElement => Boolean(el));
    if (cards.length === 0) return;
    const observer = new IntersectionObserver(
      (items) => {
        const visible = items
          .filter((item) => item.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) {
          setActiveProvider(visible[0].target.getAttribute("data-provider-id"));
        }
      },
      { rootMargin: "-72px 0px -70% 0px", threshold: 0 }
    );
    cards.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [filteredProviderEntries]);

  const paperBg = "var(--ink-paper-bg)";

  return (
    <SettingsPage
      title={t("models.title")}
      subtitle={t("models.customModelsHelp")}
      maxWidth={1040}
      scrollRef={scrollerEl}
    >
      <div
        className="min-h-full"
        style={{
          background: paperBg,
          padding: "8px 0 48px",
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns:
              filteredProviderEntries.length > 0 ? "216px minmax(0, 1fr)" : "minmax(0, 1fr)",
            gap: 24,
            alignItems: "start",
          }}
        >
          {/* Left rail — provider quick-jump navigation */}
          {filteredProviderEntries.length > 0 && (
            <ProviderRail
              entries={filteredProviderEntries}
              activeProvider={activeProvider}
              allModelsVisible={piStatus === "ready"}
              onJump={jumpToProvider}
              onJumpAllModels={jumpToAllModels}
              onExpandAll={expandAll}
              onCollapseAll={collapseAll}
              onBackTop={scrollToTop}
            />
          )}
          {/* Main content */}
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
              const cardQuery = (cardFilter[providerId] ?? "").trim().toLowerCase();
              const localModels = cardQuery
                ? matchedModels.filter(
                    (m) =>
                      (m.name || m.id).toLowerCase().includes(cardQuery) ||
                      m.id.toLowerCase().includes(cardQuery)
                  )
                : matchedModels;
              const cardLetters = providerLetterIndex(provider.models);
              const cardLettersPresent = new Set(
                localModels.map((m) => firstLetter(m.id))
              );
              return (
                <div
                  key={providerId}
                  ref={(el) => {
                    providerEls.current[providerId] = el;
                  }}
                  data-provider-id={providerId}
                  className="overflow-hidden"
                  style={{
                    borderRadius: 24,
                    background: "var(--card-bg)",
                    border: "1px solid var(--ink-border)",
                    boxShadow: "0 12px 40px rgba(0,0,0,0.06)",
                    scrollMarginTop: 88,
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

                          {/* In-card filter + A–Z jump — keeps large providers navigable */}
                          {provider.models.length > 12 && (
                            <CardModelIndex
                              filter={cardFilter[providerId] ?? ""}
                              onFilterChange={(v) => setCardFilterFor(providerId, v)}
                              letters={cardLetters}
                              present={cardLettersPresent}
                              onJumpLetter={(l) => jumpToLetter(providerId, l)}
                            />
                          )}

                          {/* Models grid */}
                          {localModels.length === 0 ? (
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
                            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                              {localModels.map((model, rowIndex) => {
                                const enabled = isModelEnabled(
                                  enabledModels,
                                  providerId,
                                  model.id
                                );
                                const meta = resolveModelMetaOrFallback(model.id, providerId);
                                return (
                                  <div
                                    key={model.id}
                                    ref={(el) => {
                                      (modelRowEls.current[providerId] ??= [])[rowIndex] = el;
                                    }}
                                    data-letter={firstLetter(model.id)}
                                    className="group flex items-center gap-2 rounded-xl border px-2.5 py-1.5 transition-colors"
                                    style={{
                                      background: enabled
                                        ? "rgba(44,90,160,0.06)"
                                        : "var(--input-bg)",
                                      borderColor: enabled
                                        ? "rgba(44,90,160,0.35)"
                                        : "var(--ink-border)",
                                      scrollMarginTop: 8,
                                    }}
                                  >
                                    <button
                                      onClick={() => setEnabled(providerId, model.id)}
                                      className="flex shrink-0 items-center justify-center rounded-md transition-colors"
                                      style={{
                                        width: 19,
                                        height: 19,
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
                                      <Check size={11} strokeWidth={3} />
                                    </button>
                                    <span style={{ flexShrink: 0, display: "inline-flex" }}>
                                      <ModelIcon iconKey={meta.iconKey} size={13} color={meta.color} />
                                    </span>
                                    <div
                                      className="min-w-0 flex-1 cursor-pointer"
                                      title={model.id}
                                      onClick={() =>
                                        setEditingModel({ providerId, model })
                                      }
                                    >
                                      <p
                                        className="truncate text-[13px] font-medium leading-tight"
                                        style={{ color: "var(--ink-title)" }}
                                      >
                                        {model.name || model.id}
                                      </p>
                                      <p
                                        className="truncate text-[10.5px] leading-tight"
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
                                      <X size={13} />
                                    </button>
                                  </div>
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
              innerRef={allModelsEl}
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

function ProviderRail({
  entries,
  activeProvider,
  allModelsVisible,
  onJump,
  onJumpAllModels,
  onExpandAll,
  onCollapseAll,
  onBackTop,
}: {
  entries: Array<{
    providerId: string;
    provider: CustomProvider;
    matchedModels: CustomModelDef[];
    providerMatch: boolean;
  }>;
  activeProvider: string | null;
  allModelsVisible: boolean;
  onJump: (id: string) => void;
  onJumpAllModels: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  onBackTop: () => void;
}) {
  const t = useT();
  return (
    <motion.aside
      initial={{ opacity: 0, x: -12 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ ...spring, delay: 0.1 }}
      className="rounded-2xl border p-2"
      style={{
        position: "sticky",
        top: 16,
        background: "var(--card-bg)",
        borderColor: "var(--ink-border)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.06)",
        maxHeight: "calc(100vh - 150px)",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
      <div className="flex items-center justify-between px-2 pb-2 pt-1">
        <span
          className="text-[11px] font-semibold uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          {t("models.providers")}
        </span>
        <div className="flex items-center gap-0.5">
          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={onExpandAll}
            title={t("models.expandAll")}
            aria-label={t("models.expandAll")}
            style={{ padding: 4, color: "var(--muted-foreground)", cursor: "pointer" }}
          >
            <ChevronsDown size={15} />
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.85 }}
            onClick={onCollapseAll}
            title={t("models.collapseAll")}
            aria-label={t("models.collapseAll")}
            style={{ padding: 4, color: "var(--muted-foreground)", cursor: "pointer" }}
          >
            <ChevronsUp size={15} />
          </motion.button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 2 }}>
        {entries.map(({ providerId, provider }) => {
          const active = activeProvider === providerId;
          return (
            <motion.button
              key={providerId}
              whileTap={{ scale: 0.98 }}
              onClick={() => onJump(providerId)}
              className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
              style={{
                background: active ? "rgba(44,90,160,0.12)" : "transparent",
                cursor: "pointer",
              }}
            >
              <ProviderMeta provider={providerId} size={16} />
              <span
                className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
                style={{ color: active ? "var(--ink-accent)" : "var(--foreground)" }}
              >
                {PROVIDER_META[providerId]?.label ?? providerId}
              </span>
              <span
                className="text-[10.5px] tabular-nums"
                style={{ color: "var(--muted-foreground)" }}
              >
                {provider.models.length}
              </span>
            </motion.button>
          );
        })}
      </div>

      <div
        className="mt-2 border-t pt-2"
        style={{ borderColor: "var(--ink-border)" }}
      >
        {allModelsVisible && (
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={onJumpAllModels}
            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
            style={{ cursor: "pointer" }}
          >
            <Bot size={15} style={{ color: "var(--muted-foreground)" }} />
            <span
              className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
              style={{ color: "var(--foreground)" }}
            >
              {t("models.allModels")}
            </span>
          </motion.button>
        )}
        <motion.button
          whileTap={{ scale: 0.98 }}
          onClick={onBackTop}
          className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
          style={{ cursor: "pointer" }}
        >
          <ArrowUp size={15} style={{ color: "var(--muted-foreground)" }} />
          <span
            className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
            style={{ color: "var(--foreground)" }}
          >
            {t("models.backToTop")}
          </span>
        </motion.button>
      </div>
    </motion.aside>
  );
}

function CardModelIndex({
  filter,
  onFilterChange,
  letters,
  present,
  onJumpLetter,
}: {
  filter: string;
  onFilterChange: (v: string) => void;
  letters: string[];
  present: Set<string>;
  onJumpLetter: (l: string) => void;
}) {
  const t = useT();
  return (
    <div
      className="mb-3 rounded-2xl border px-3 py-2.5"
      style={{
        background: "var(--input-bg)",
        borderColor: "var(--ink-border)",
      }}
    >
      <div className="flex items-center gap-2">
        <Search size={14} style={{ color: "var(--muted-foreground)" }} />
        <input
          value={filter}
          onChange={(e) => onFilterChange(e.target.value)}
          placeholder={t("models.filterModels")}
          className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-[var(--muted-foreground)]"
          style={{ color: "var(--foreground)" }}
        />
        {filter && (
          <button
            onClick={() => onFilterChange("")}
            aria-label={t("models.clearSearch")}
            style={{ color: "var(--muted-foreground)", cursor: "pointer" }}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-0.5">
        {letters.map((l) => {
          const active = present.has(l);
          return (
            <button
              key={l}
              onClick={() => active && onJumpLetter(l)}
              disabled={!active}
              className="grid h-6 w-6 place-items-center rounded-md text-[10.5px] font-semibold transition-colors"
              style={{
                color: active ? "var(--ink-accent)" : "var(--muted-foreground)",
                background: active ? "rgba(44,90,160,0.1)" : "transparent",
                opacity: active ? 1 : 0.35,
                cursor: active ? "pointer" : "default",
              }}
            >
              {l}
            </button>
          );
        })}
      </div>
    </div>
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
            className="pi-native-select w-full rounded-xl border px-3 py-2 text-sm outline-none focus:border-[var(--ink-accent)]"
            style={{ borderColor: "var(--ink-border)" }}
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
  innerRef,
  enabledModels,
  onToggle,
}: {
  innerRef?: React.Ref<HTMLDivElement>;
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
      ref={innerRef}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...spring, delay: 0.25 }}
      className="overflow-hidden"
      style={{
        borderRadius: 24,
        background: "var(--card-bg)",
        border: "1px solid var(--ink-border)",
        scrollMarginTop: 88,
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
