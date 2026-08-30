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
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ProviderMeta, PROVIDER_META } from "@/components/provider-meta";
import { ModelIcon } from "@/components/icons";
import { resolveModelMetaOrFallback } from "@/lib/model-icon";
import { useT } from "@/lib/i18n";
import { usePi } from "@/lib/pi/store";
import { type SettingsScope, usePiSettings } from "@/lib/pi/settings";
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
  pruneModelsFromScope,
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

/**
 * What the confirm dialog is currently asking about. `null` = closed. Kept as
 * one piece of state so provider and model removal share a single dialog
 * instance instead of racing two.
 */
type PendingRemoval =
  | { kind: "provider"; providerId: string }
  | { kind: "model"; providerId: string; modelId: string };

/**
 * A fetched list diffed against what models.json already holds for the
 * provider. `stale` is the half that used to have nowhere to go: models we
 * store that the endpoint no longer serves.
 */
interface FetchDiff {
  providerId: string;
  /** how many models the endpoint reported — 0 means "don't trust the diff" */
  upstreamCount: number;
  /** upstream ids we don't store yet */
  fresh: string[];
  /** stored ids upstream no longer lists */
  stale: string[];
  selectedAdd: string[];
  selectedRemove: string[];
}

export default function ModelsPage() {
  const t = useT();

  const piStatus = usePi((s) => s.status);
  const piModels = usePi((s) => s.models);

  const piModelsStore = usePiModels();
  const customProviders = piModelsStore.data.providers;
  const customLoaded = piModelsStore.loaded;

  const piSettings = usePiSettings();
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
  const [fetchResult, setFetchResult] = useState<FetchDiff | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Per-provider inline model filter (handles the single-provider-with-hundreds
  // case: filter without losing your place in the page).
  const [cardFilter, setCardFilter] = useState<Record<string, string>>({});
  // Left rail: which provider is in view + element refs for scroll targets.
  const [activeProvider, setActiveProvider] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const providerEls = useRef<Record<string, HTMLElement | null>>({});
  const modelRowEls = useRef<Record<string, (HTMLElement | null)[]>>({});
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

  /**
   * Drop deleted models out of `enabledModels`. Both scope files are swept, not
   * just the global one we write toggles to — a project-level list can name the
   * same model, and a ref left behind there is just as invisible.
   *
   * Reads the store fresh per scope: the second write must see the first one's
   * result, not the snapshot this render closed over.
   */
  const pruneEnabled = async (removed: ModelRefLike[]) => {
    if (removed.length === 0) return;
    for (const scope of ["global", "project"] as SettingsScope[]) {
      const current = usePiSettings.getState()[scope].data?.enabledModels;
      if (!Array.isArray(current) || current.length === 0) continue;
      const next = pruneModelsFromScope(current, removed, scopeModels);
      if (next.length === current.length) continue; // nothing named here
      await usePiSettings
        .getState()
        .setKey(scope, "enabledModels", next.length > 0 ? next : undefined);
    }
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

  const confirmRemoval = async () => {
    const target = pendingRemoval;
    if (!target) return;
    if (target.kind === "provider") {
      const gone = (customProviders[target.providerId]?.models ?? []).map((m) => ({
        provider: target.providerId,
        id: m.id,
      }));
      await piModelsStore.removeProvider(target.providerId);
      await pruneEnabled(gone);
    } else {
      await piModelsStore.removeModel(target.providerId, target.modelId);
      await pruneEnabled([{ provider: target.providerId, id: target.modelId }]);
    }
    setPendingRemoval(null);
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

  /** Model count of the provider queued for removal — drives the warning copy. */
  const pendingProviderModelCount =
    pendingRemoval?.kind === "provider"
      ? customProviders[pendingRemoval.providerId]?.models?.length ?? 0
      : 0;

  const handleFetch = async (providerId: string) => {
    const provider = customProviders[providerId];
    if (!provider) return;
    setFetchingProviderId(providerId);
    setFetchError(null);
    try {
      const list = await piModelsStore.fetchModels(provider.baseUrl, provider.api, provider.apiKey);
      const upstream = new Set(list);
      const existing = new Set(provider.models.map((m) => m.id));
      const fresh = list.filter((id) => !existing.has(id));
      // An empty upstream list is far more often a bad key or a proxy that
      // doesn't implement /models than a provider that really dropped
      // everything — diffing against it would offer to delete the lot.
      const stale =
        list.length > 0
          ? provider.models.map((m) => m.id).filter((id) => !upstream.has(id))
          : [];
      setFetchResult({
        providerId,
        upstreamCount: list.length,
        fresh,
        stale,
        selectedAdd: fresh,
        // Removal is opt-in: plenty of endpoints under-report (per-key model
        // allowlists, gateways that only list what's warm), and a stale entry
        // may be a hand-tuned one worth keeping.
        selectedRemove: [],
      });
    } catch (e) {
      setFetchError(String(e));
    } finally {
      setFetchingProviderId(null);
    }
  };

  const handleApplyFetch = async () => {
    if (!fetchResult) return;
    const { providerId, selectedAdd, selectedRemove } = fetchResult;
    const provider = customProviders[providerId];
    if (!provider) return;
    await piModelsStore.syncModels(
      providerId,
      {
        baseUrl: provider.baseUrl,
        api: provider.api,
        apiKey: provider.apiKey,
      },
      selectedAdd.map((id) => ({ id, name: id })),
      selectedRemove
    );
    await pruneEnabled(selectedRemove.map((id) => ({ provider: providerId, id })));
    setFetchResult(null);
  };

  /**
   * Built-in providers rendered as provider cards alongside the models.json
   * ones, so a subscription signed in under Settings → Accounts is visible where
   * users already look instead of only in the list at the foot of the page.
   *
   * pi reports models.json providers too, so anything already in
   * `customProviders` is skipped — otherwise every custom provider would render
   * twice, and the editable card is the one worth keeping. That also settles the
   * overlap case (a provider both built in and overridden in models.json, like
   * `openrouter`): the override wins, matching pi's own resolution order.
   */
  const builtinProviders = useMemo<Record<string, CustomProvider>>(() => {
    const out: Record<string, CustomProvider> = {};
    for (const model of piModels) {
      if (customProviders[model.provider]) continue;
      const entry = (out[model.provider] ??= {
        // Built-in catalogs live in pi, not models.json: there is no baseUrl or
        // api to show, and nothing here is editable.
        baseUrl: "",
        api: "",
        models: [],
      });
      entry.models.push({
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        contextWindow: model.contextWindow,
      });
    }
    return out;
  }, [piModels, customProviders]);

  const filteredProviderEntries = useMemo(() => {
    const term = search.trim().toLowerCase();
    const entries: Array<{
      providerId: string;
      provider: CustomProvider;
      matchedModels: CustomModelDef[];
      providerMatch: boolean;
      builtin: boolean;
    }> = [];
    const collect = (source: Record<string, CustomProvider>, builtin: boolean) => {
      for (const [providerId, provider] of Object.entries(source)) {
        const providerMatch = providerId.toLowerCase().includes(term);
        const matchedModels = provider.models.filter(
          (m) =>
            providerMatch ||
            m.id.toLowerCase().includes(term) ||
            (m.name && m.name.toLowerCase().includes(term))
        );
        entries.push({ providerId, provider, matchedModels, providerMatch, builtin });
      }
    };
    // Custom first: these are the ones the user configured by hand.
    collect(customProviders, false);
    collect(builtinProviders, true);
    return entries.filter(
      ({ matchedModels, providerMatch }) => providerMatch || matchedModels.length > 0
    );
  }, [customProviders, builtinProviders, search]);

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
              onJump={jumpToProvider}
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
            {filteredProviderEntries.map(({ providerId, provider, matchedModels, builtin }) => {
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
                          className="flex items-center gap-1.5 truncate text-[15px] font-semibold"
                          style={{ color: "var(--ink-title)" }}
                        >
                          <span className="truncate">
                            {PROVIDER_META[providerId]?.label ?? providerId}
                          </span>
                          {builtin && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                              style={{
                                background: "rgba(44,90,160,0.1)",
                                color: "var(--ink-accent)",
                              }}
                            >
                              {t("models.builtinBadge")}
                            </span>
                          )}
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
                          {/* Provider actions — none apply to a built-in catalog,
                              which pi owns and models.json cannot edit. */}
                          {builtin ? (
                            <div
                              className="mb-4 rounded-xl px-3 py-2 text-xs"
                              style={{
                                background: "var(--input-bg)",
                                border: "1px solid var(--ink-border)",
                                color: "var(--muted-foreground)",
                              }}
                            >
                              {t("models.builtinProviderNote")}
                            </div>
                          ) : (
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
                              onClick={() =>
                                setPendingRemoval({ kind: "provider", providerId })
                              }
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
                          )}

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
                                      className={
                                        builtin
                                          ? "min-w-0 flex-1"
                                          : "min-w-0 flex-1 cursor-pointer"
                                      }
                                      title={model.id}
                                      onClick={
                                        builtin
                                          ? undefined
                                          : () => setEditingModel({ providerId, model })
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
                                    {!builtin && (
                                      <button
                                        onClick={() =>
                                          setPendingRemoval({
                                            kind: "model",
                                            providerId,
                                            modelId: model.id,
                                          })
                                        }
                                        className="opacity-0 transition-opacity group-hover:opacity-100"
                                        style={{ color: "var(--muted-foreground)" }}
                                      >
                                        <X size={13} />
                                      </button>
                                    )}
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

            {filteredProviderEntries.length === 0 &&
              customLoaded &&
              // Built-ins arrive with pi's model list; claiming "no providers"
              // before it lands would be wrong, not just early.
              piStatus === "ready" && (
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

          {/* Where custom models live — static note; restart hint is global */}
          <div
            className="rounded-2xl border px-4 py-3 text-xs"
            style={{
              background: "var(--bg-sunken)",
              borderColor: "var(--separator)",
              color: "var(--text-tertiary)",
            }}
          >
            {t("models.footer")}
          </div>
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
          onChangeAdd={(ids) => setFetchResult({ ...fetchResult, selectedAdd: ids })}
          onChangeRemove={(ids) => setFetchResult({ ...fetchResult, selectedRemove: ids })}
          onApply={handleApplyFetch}
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

      <ConfirmDialog
        open={pendingRemoval !== null}
        title={
          pendingRemoval?.kind === "model"
            ? t("models.removeModel")
            : t("models.removeProvider")
        }
        message={
          pendingRemoval?.kind === "model"
            ? t("models.removeModel.message")
            : t("models.removeProvider.message", {
                count: String(pendingProviderModelCount),
              })
        }
        detail={
          pendingRemoval?.kind === "model"
            ? pendingRemoval.modelId
            : pendingRemoval?.providerId
        }
        confirmLabel={t("common.delete")}
        icon={<Trash2 size={22} color="var(--danger)" />}
        onConfirm={confirmRemoval}
        onCancel={() => setPendingRemoval(null)}
      />
    </SettingsPage>
  );
}

function ProviderRail({
  entries,
  activeProvider,
  onJump,
  onExpandAll,
  onCollapseAll,
  onBackTop,
}: {
  entries: Array<{
    providerId: string;
    provider: CustomProvider;
    matchedModels: CustomModelDef[];
    providerMatch: boolean;
    builtin: boolean;
  }>;
  activeProvider: string | null;
  onJump: (id: string) => void;
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
  onChangeAdd,
  onChangeRemove,
  onApply,
}: {
  result: FetchDiff;
  onClose: () => void;
  onChangeAdd: (ids: string[]) => void;
  onChangeRemove: (ids: string[]) => void;
  onApply: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState("");
  const query = search.trim().toLowerCase();
  const match = (ids: string[]) =>
    query ? ids.filter((id) => id.toLowerCase().includes(query)) : ids;
  const visibleFresh = useMemo(() => match(result.fresh), [result.fresh, query]);
  const visibleStale = useMemo(() => match(result.stale), [result.stale, query]);

  const addCount = result.selectedAdd.length;
  const removeCount = result.selectedRemove.length;
  const inSync = result.fresh.length === 0 && result.stale.length === 0;

  return (
    <Dialog
      open
      title={t("models.reviewFetched")}
      maxWidth={520}
      onClose={onClose}
      actions={
        <>
          <GroupButton onClick={onClose}>{t("models.cancel")}</GroupButton>
          <GroupButton
            primary
            onClick={onApply}
            disabled={addCount === 0 && removeCount === 0}
          >
            {t("models.applyChanges", { add: addCount, remove: removeCount })}
          </GroupButton>
        </>
      }
    >
      <p className="mb-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
        {t("models.fetchSummary", {
          upstream: result.upstreamCount,
          fresh: result.fresh.length,
          stale: result.stale.length,
        })}
      </p>

      {inSync ? (
        <p className="py-6 text-center text-sm" style={{ color: "var(--muted-foreground)" }}>
          {t("models.alreadyInSync")}
        </p>
      ) : (
        <>
          <div
            className="mb-3 flex items-center gap-2 rounded-xl px-3 py-2"
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

          <div className="max-h-[46vh] overflow-y-auto pr-1">
            {result.fresh.length > 0 && (
              <FetchSection
                heading={t("models.newUpstream", { n: result.fresh.length })}
                ids={visibleFresh}
                selected={result.selectedAdd}
                onChange={onChangeAdd}
                tint="var(--ink-accent)"
              />
            )}

            {result.stale.length > 0 && (
              <FetchSection
                heading={t("models.staleLocal", { n: result.stale.length })}
                hint={t("models.staleLocalHint")}
                ids={visibleStale}
                selected={result.selectedRemove}
                onChange={onChangeRemove}
                tint="#c45c48"
              />
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

/**
 * One checkbox list inside the fetch dialog. `tint` is what separates the
 * additive half from the destructive one — same interaction, different weight.
 */
function FetchSection({
  heading,
  hint,
  ids,
  selected,
  onChange,
  tint,
}: {
  heading: string;
  hint?: string;
  ids: string[];
  selected: string[];
  onChange: (ids: string[]) => void;
  tint: string;
}) {
  const t = useT();
  const picked = useMemo(() => new Set(selected), [selected]);

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(Array.from(next));
  };

  const selectVisible = () => {
    const next = new Set(picked);
    ids.forEach((id) => next.add(id));
    onChange(Array.from(next));
  };

  const invertVisible = () => {
    const next = new Set(picked);
    ids.forEach((id) => {
      if (next.has(id)) next.delete(id);
      else next.add(id);
    });
    onChange(Array.from(next));
  };

  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-semibold" style={{ color: tint }}>
          {heading}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <MiniButton onClick={selectVisible} disabled={ids.length === 0}>
            {t("models.selectAll")}
          </MiniButton>
          <MiniButton onClick={invertVisible} disabled={ids.length === 0}>
            {t("models.invertSelection")}
          </MiniButton>
        </div>
      </div>
      {hint && (
        <p className="mb-2 text-[11px] leading-snug" style={{ color: "var(--muted-foreground)" }}>
          {hint}
        </p>
      )}
      {ids.length === 0 ? (
        <p className="py-3 text-center text-xs" style={{ color: "var(--muted-foreground)" }}>
          {t("models.noSearchResults")}
        </p>
      ) : (
        <div
          className="overflow-hidden rounded-xl"
          style={{ border: "1px solid var(--ink-border)" }}
        >
          {ids.map((id, i) => {
            const on = picked.has(id);
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors"
                style={{
                  background: on ? "var(--ink-row-open-bg)" : "transparent",
                  borderTop: i === 0 ? "none" : "1px solid var(--ink-border)",
                }}
              >
                <span
                  className="flex shrink-0 items-center justify-center rounded-md"
                  style={{
                    width: 19,
                    height: 19,
                    background: on ? tint : "transparent",
                    border: "1.5px solid",
                    borderColor: on ? tint : "var(--ink-border)",
                    color: "#fff",
                  }}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[13px]"
                  style={{ color: "var(--foreground)" }}
                  title={id}
                >
                  {id}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function MiniButton({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
      style={{
        background: "var(--input-bg)",
        border: "1px solid var(--ink-border)",
        color: "var(--foreground)",
      }}
    >
      {children}
    </button>
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
  maxWidth = 420,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  actions?: React.ReactNode;
  maxWidth?: number;
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
              maxWidth,
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
