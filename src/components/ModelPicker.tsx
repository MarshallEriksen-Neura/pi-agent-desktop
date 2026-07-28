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
  const { models, currentModel, setModel } = usePi();
  const settings = usePiSettings();
  const t = useT();

  useEffect(() => {
    settings.load();
  }, [settings]);

  // Honour settings.json `enabledModels`: if it's a non-empty explicit list,
  // only those models (matched as `provider/id` or bare `id`) appear here.
  // Empty/legacy glob values mean "show all".
  const enabled = settings.global.data?.enabledModels as string[] | undefined;
  const visibleModels = useMemo(() => {
    if (!enabled || enabled.length === 0) return models;
    const hasGlob = enabled.some((e) => e.includes("*") || e.includes("?") || !e.includes("/"));
    if (hasGlob) return models;
    const set = new Set(enabled);
    return models.filter((m) => set.has(`${m.provider}/${m.id}`) || set.has(m.id));
  }, [models, enabled]);

  const providers = [...new Set(visibleModels.map((m) => m.provider))];

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
            {t("modelPicker.none")}
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
                    key={`${m.provider}/${m.id}`}
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
