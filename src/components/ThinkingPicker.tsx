"use client";

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
import { useT } from "@/lib/i18n";
import { Brain, Check, ChevronDown, SlidersHorizontal } from "lucide-react";

/**
 * Composer thinking-level selector — sibling of ModelPicker.
 *
 * This drives pi's live `set_thinking_level` (via usePi.setThinking), *not* the
 * `defaultThinkingLevel` setting: the level is a per-session knob users want to
 * flip between turns, and writing settings.json would mark the config dirty and
 * ask for a pi restart. The menu links to Settings for the persisted default.
 */
export function ThinkingPicker({ compact = false }: { compact?: boolean }) {
  const level = usePi((s) => s.thinkingLevel);
  const availableLevels = usePi((s) => s.availableThinkingLevels);
  const levelsStatus = usePi((s) => s.thinkingLevelsStatus);
  const levelsModelKey = usePi((s) => s.thinkingLevelsModelKey);
  const currentModel = usePi((s) => s.currentModel);
  const setThinking = usePi((s) => s.setThinking);
  const t = useT();

  const labelOf = (l: string) => t(`thinking.level.${l}`);
  const currentModelKey = currentModel ? `${currentModel.provider}/${currentModel.id}` : null;
  const levelsCurrent = levelsModelKey === currentModelKey;
  const levelsReady = levelsStatus === "ready" && levelsCurrent;
  const statusText =
    levelsStatus === "error" && levelsCurrent
      ? t("thinking.capabilityError")
      : t("thinking.capabilityLoading");
  // Glanceable signal that extra reasoning is on, without adding a badge.
  const tint =
    level === "off"
      ? "var(--text-tertiary)"
      : level === "high" || level === "xhigh" || level === "max"
        ? "var(--accent)"
        : "var(--text-secondary)";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <motion.button
            whileTap={{ scale: 0.95 }}
            transition={{ type: "spring", stiffness: 500, damping: 24 }}
            aria-label={t("thinking.select", { level: labelOf(level) })}
            title={t("thinking.select", { level: labelOf(level) })}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: compact ? "2px 6px" : "3px 9px",
              fontSize: 11.5,
              fontWeight: 500,
              fontFamily: "var(--font-ui)",
              color: level === "off" ? "var(--text-tertiary)" : "var(--text-secondary)",
              background: compact ? "transparent" : "var(--bg-base)",
              border: compact ? "none" : "1px solid var(--separator)",
              borderRadius: 99,
              cursor: "pointer",
              whiteSpace: "nowrap",
              // Short label — keep it whole and let the model chip take the squeeze.
              flexShrink: 0,
            }}
          />
        }
      >
        <span style={{ flexShrink: 0, display: "inline-flex", color: tint }}>
          <Brain size={11} />
        </span>
        {/* Same iOS-clock roll as ModelPicker so both chips behave alike */}
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={level}
            initial={{ y: 6, opacity: 0, filter: "blur(2px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
            exit={{ y: -6, opacity: 0, filter: "blur(2px)" }}
            transition={{ type: "spring", stiffness: 500, damping: 30 }}
            style={{ display: "inline-block" }}
          >
            {labelOf(level)}
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
          minWidth: 210,
          padding: 6,
          border: "1px solid var(--separator)",
          borderRadius: "var(--radius-md)",
          boxShadow: "var(--shadow-lg)",
          zIndex: 60,
        }}
      >
        <DropdownMenuGroup>
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
            {t("models.thinkingLevel")}
          </DropdownMenuGroupLabel>

          {!levelsReady && (
            <DropdownMenuItem
              disabled
              style={{
                padding: "7px 10px",
                borderRadius: 8,
                fontSize: 12.5,
                color: "var(--text-tertiary)",
              }}
            >
              {statusText}
            </DropdownMenuItem>
          )}

          {(levelsReady ? availableLevels : []).map((l) => {
            const active = l === level;
            return (
              <DropdownMenuItem
                key={l}
                onClick={() => void setThinking(l)}
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
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    whiteSpace: "nowrap",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {labelOf(l)}
                </span>
                <span
                  style={{
                    fontSize: 10.5,
                    color: "var(--text-tertiary)",
                    flexShrink: 0,
                  }}
                >
                  {t(`thinking.hint.${l}`)}
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

        <DropdownMenuSeparator
          style={{ height: 1, margin: "5px 4px", background: "var(--separator)" }}
        />
        <DropdownMenuItem
          render={
            <Link
              href="/settings/"
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
          {t("thinking.setDefault")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
