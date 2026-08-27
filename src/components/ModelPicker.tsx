"use client";

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@appica/ui-react/dropdown-menu";
import { usePi } from "@/lib/pi/store";
import { usePiSettings } from "@/lib/pi/settings";
import { hasGlobEntry, isModelEnabled, modelRef } from "@/lib/pi/model-scope";
import { useT } from "@/lib/i18n";
import { PROVIDER_META, fmtCtx } from "./provider-meta";
import { resolveModelMetaOrFallback } from "@/lib/model-icon";
import { ModelIcon } from "./icons";
import { Check, ChevronDown, SlidersHorizontal } from "lucide-react";

/**
 * Composer model selector — iOS-style chip that opens a menu of the user's
 * configured models (grouped by provider). Selecting one calls pi's
 * set_model via usePi (optimistic, instant).
 */
export function ModelPicker({ compact = false }: { compact?: boolean }) {
  const {
    models,
    currentModel,
    setModel,
    modelsError,
    refresh,
  } = usePi();
  const loadSettings = usePiSettings((s) => s.load);
  const enabled = usePiSettings((s) => s.effective().enabledModels);
  const t = useT();

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  // Honour the merged settings view so project overrides behave the same here
  // as they do on the Models page. Entries are canonical `provider/id` refs;
  // legacy bare ids still match (every provider serving that id), and glob
  // patterns remain delegated to pi and therefore show all here.
  const visibleModels = useMemo(() => {
    if (!enabled || enabled.length === 0) return models;
    if (hasGlobEntry(enabled)) return models;
    return models.filter((m) => isModelEnabled(enabled, m.provider, m.id));
  }, [models, enabled]);

  const providers = [...new Set(visibleModels.map((m) => m.provider))];

  /**
   * Two providers can serve the same model id (`anthropic/claude-opus-5` and a
   * proxy's `claude-opus-5`). The group header names the provider, but the rows
   * would read identically — so tag the ambiguous ones with their provider.
   */
  const ambiguousIds = useMemo(() => {
    const byId = new Map<string, number>();
    for (const m of visibleModels) byId.set(m.id, (byId.get(m.id) ?? 0) + 1);
    return new Set([...byId].filter(([, n]) => n > 1).map(([id]) => id));
  }, [visibleModels]);

  const currentMeta = resolveModelMetaOrFallback(
    currentModel?.id ?? "none",
    currentModel?.provider
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <motion.button
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            aria-label={t("modelPicker.select")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              maxWidth: compact ? 140 : 200,
              // Shrinkable: sharing the composer row with the thinking chip, this
              // is the item that yields — model names ellipsize legibly.
              minWidth: 0,
              padding: compact ? "2px 6px" : "3px 9px",
              fontSize: 11.5,
              fontWeight: 500,
              fontFamily: "var(--font-ui)",
              color: "var(--text-secondary)",
              background: compact ? "transparent" : "var(--bg-base)",
              border: compact ? "none" : "1px solid var(--separator)",
              borderRadius: 99,
              cursor: "pointer",
              whiteSpace: "nowrap",
            }}
          />
        }
      >
        <span style={{ flexShrink: 0, display: "inline-flex" }}>
          <ModelIcon
            iconKey={currentMeta.iconKey}
            size={11}
            color={currentMeta.color}
          />
        </span>
        {/* iOS-clock-style roll when the model changes (same as TopBar) */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={
              currentModel
                ? `${currentModel.provider}/${currentModel.id}`
                : "none"
            }
            initial={{ y: 6, opacity: 0, filter: "blur(2px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            exit={{ y: -6, opacity: 0, filter: "blur(2px)" }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            style={{
              display: "inline-block",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {currentModel ? (currentModel.name ?? currentModel.id) : t("modelPicker.choose")}
          </motion.span>
        </AnimatePresence>
        <ChevronDown size={11} style={{ flexShrink: 0, opacity: 0.6 }} />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="material-thick"
        style={{
          minWidth: 240,
          maxHeight: 340,
          overflowY: "auto",
          padding: 6,
          border: "1px solid var(--separator)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 60,
        }}
      >
        {visibleModels.length === 0 && (
          <div
            style={{
              padding: "10px 12px",
              fontSize: 12,
              color: "var(--text-tertiary)",
            }}
          >
            {/* An empty list means one of two very different things: pi answered
                with nothing configured, or the query never came back. Saying
                "none configured" for a failed query sends the user to the wrong
                place — offer a retry instead. */}
            {models.length === 0 && modelsError ? (
              <>
                <div style={{ color: "var(--danger)", marginBottom: 6 }}>
                  {t("modelPicker.loadFailed")}
                </div>
                <button
                  onClick={() => void refresh()}
                  style={{
                    border: "1px solid var(--separator)",
                    background: "var(--bg-base)",
                    color: "var(--text-primary)",
                    borderRadius: 6,
                    padding: "3px 9px",
                    fontSize: 11.5,
                    cursor: "pointer",
                  }}
                >
                  {t("modelPicker.retry")}
                </button>
              </>
            ) : models.length > 0 ? (
              // pi has models but `enabledModels` filtered them all out
              t("modelPicker.allFiltered")
            ) : (
              t("modelPicker.none")
            )}
          </div>
        )}

        {providers.map((p) => (
          <DropdownMenuGroup key={p}>
            <DropdownMenuGroupLabel
              style={{
                padding: "6px 10px 3px",
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--text-tertiary)",
              }}
            >
              {PROVIDER_META[p]?.label ?? p}
            </DropdownMenuGroupLabel>

            {visibleModels
              .filter((m) => m.provider === p)
              .map((m) => {
                const active =
                  currentModel?.id === m.id &&
                  currentModel?.provider === m.provider;
                const meta = resolveModelMetaOrFallback(m.id, m.provider);
                return (
                  <DropdownMenuItem
                    key={modelRef(m.provider, m.id)}
                    onClick={() => setModel(m)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      padding: "7px 10px",
                      borderRadius: 8,
                      fontSize: 12.5,
                      color: "var(--text-primary)",
                      cursor: "pointer",
                    }}
                  >
                    <span style={{ flexShrink: 0, display: "inline-flex" }}>
                      <ModelIcon
                        iconKey={meta.iconKey}
                        size={14}
                        color={meta.color}
                      />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: active ? 600 : 400,
                      }}
                    >
                      {m.name ?? m.id}
                      {ambiguousIds.has(m.id) && (
                        <span style={{ color: "var(--text-tertiary)" }}>
                          {" · "}
                          {m.provider}
                        </span>
                      )}
                    </span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontFamily: "var(--font-mono)",
                        color: "var(--text-tertiary)",
                        flexShrink: 0,
                      }}
                    >
                      {fmtCtx(m.contextWindow)}
                      {m.reasoning ? " ·R" : ""}
                    </span>
                    {active && (
                      <motion.span
                        initial={{ scale: 0.5, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        transition={{ type: "spring", stiffness: 500, damping: 22 }}
                        style={{
                          display: "inline-flex",
                          color: "var(--accent)",
                          flexShrink: 0,
                        }}
                      >
                        <Check size={13} />
                      </motion.span>
                    )}
                  </DropdownMenuItem>
                );
              })}
          </DropdownMenuGroup>
        ))}

        <DropdownMenuSeparator
          style={{
            height: 1,
            margin: "5px 4px",
            background: "var(--separator)",
          }}
        />
        <DropdownMenuItem
          render={
            <Link
              href="/models/"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--text-secondary)",
                textDecoration: "none",
                cursor: "pointer",
              }}
            />
          }
        >
          <SlidersHorizontal size={13} style={{ opacity: 0.7 }} />
          {t("modelPicker.manage")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
