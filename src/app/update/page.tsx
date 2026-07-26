"use client";

import { useEffect } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { GitBranch, Tag, RefreshCw, GitCommitHorizontal } from "lucide-react";
import {
  useUpdate,
  APP_VERSION,
  MOCK_APPLY_ERROR,
  type UpdatePhase,
} from "@/lib/update";
import { useI18n, useT } from "@/lib/i18n";
import { PiMark } from "@/components/PiMark";
import { SettingsPage, InsetGroup, GroupRow } from "@/components/settings-ui";

const RING = 132;
const R = 62;
const CIRC = 2 * Math.PI * R;

/**
 * State ring around the app-icon medallion — the page's one signature
 * element. Dashed while the update source is unconfigured (dormant),
 * a spinning arc while checking/installing, and a drawn-in closed ring
 * once the answer is known (green = current, accent = update waiting).
 */
function StateRing({ phase }: { phase: UpdatePhase }) {
  const reduce = useReducedMotion();
  const busy = phase === "idle" || phase === "checking" || phase === "applying";
  const done = phase === "upToDate" || phase === "available";
  const doneColor = phase === "upToDate" ? "var(--success)" : "var(--accent)";

  return (
    <svg
      width={RING}
      height={RING}
      style={{ position: "absolute", inset: 0 }}
      aria-hidden
    >
      {/* base track — dashed = update source dormant */}
      <circle
        cx={RING / 2}
        cy={RING / 2}
        r={R}
        fill="none"
        stroke="var(--separator)"
        strokeWidth={3}
        strokeLinecap="round"
        strokeDasharray={phase === "unconfigured" ? "3 10" : undefined}
      />
      {busy && (
        <motion.g
          style={{ transformOrigin: "50% 50%" }}
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
        >
          <circle
            cx={RING / 2}
            cy={RING / 2}
            r={R}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={`${CIRC * 0.22} ${CIRC}`}
          />
        </motion.g>
      )}
      {done && (
        <motion.circle
          cx={RING / 2}
          cy={RING / 2}
          r={R}
          fill="none"
          stroke={doneColor}
          strokeWidth={3}
          strokeLinecap="round"
          transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
          initial={{ pathLength: reduce ? 1 : 0 }}
          animate={{ pathLength: 1 }}
          transition={{ type: "spring", stiffness: 60, damping: 16 }}
        />
      )}
    </svg>
  );
}

const mono: React.CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
};

export default function UpdatePage() {
  const u = useUpdate();
  const t = useT();
  const { locale } = useI18n();

  // Auto-check when the page opens, like iOS Software Update.
  useEffect(() => {
    u.check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phase = u.phase;
  const version = u.info?.currentVersion ?? APP_VERSION;
  const latest = u.info?.latestVersion ?? undefined;
  const busy = phase === "idle" || phase === "checking";
  const applying = phase === "applying";

  const status: { text: string; color: string } =
    phase === "upToDate"
      ? { text: t("update.upToDate"), color: "var(--success)" }
      : phase === "available" || applying
        ? {
            text: t("update.availableStatus", { version: latest ?? "?" }),
            color: "var(--accent)",
          }
        : phase === "unconfigured"
          ? {
              text: t("update.notConfiguredStatus"),
              color: "var(--text-secondary)",
            }
          : phase === "error"
            ? { text: t("update.checkFailed"), color: "var(--danger, #E5484D)" }
            : { text: t("update.checking"), color: "var(--text-secondary)" };

  const applyError =
    u.error === MOCK_APPLY_ERROR ? t("update.mockApply") : u.error;

  return (
    <SettingsPage title={t("update.title")} subtitle={t("update.subtitle")}>
      {/* medallion hero — version identity + live state ring */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          padding: "26px 0 4px",
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 300, damping: 24 }}
          style={{ position: "relative", width: RING, height: RING }}
        >
          <StateRing phase={phase} />
          <PiMark
            size={92}
            withBackground
            style={{
              position: "absolute",
              inset: 20,
              borderRadius: 21,
              boxShadow: "var(--shadow-sm)",
            }}
          />
          {/* iOS-style badge while an update is waiting */}
          <AnimatePresence>
            {(phase === "available" || applying) && (
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                exit={{ scale: 0 }}
                transition={{ type: "spring", stiffness: 500, damping: 22 }}
                style={{
                  position: "absolute",
                  top: 6,
                  right: 6,
                  minWidth: 22,
                  height: 22,
                  borderRadius: 99,
                  background: "var(--danger, #E5484D)",
                  color: "#fff",
                  fontSize: 12,
                  fontWeight: 700,
                  display: "grid",
                  placeItems: "center",
                  boxShadow: "0 0 0 3px var(--bg-elevated)",
                }}
              >
                1
              </motion.span>
            )}
          </AnimatePresence>
        </motion.div>

        <div
          style={{
            marginTop: 16,
            fontSize: 16,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Pi Desktop
        </div>
        <div
          style={{
            ...mono,
            marginTop: 2,
            fontSize: 13,
            color: "var(--text-tertiary)",
          }}
        >
          v{version}
        </div>

        {/* status line swaps with a soft fade */}
        <AnimatePresence mode="wait">
          <motion.div
            key={status.text}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.18 }}
            style={{
              marginTop: 12,
              fontSize: 13,
              fontWeight: 500,
              color: status.color,
            }}
          >
            {status.text}
          </motion.div>
        </AnimatePresence>

        <Button
          variant="outline"
          size="sm"
          onClick={() => u.check()}
          disabled={busy || applying}
          style={{
            marginTop: 16,
            borderRadius: 10,
            color: "var(--accent)",
            fontWeight: 600,
            opacity: busy || applying ? 0.55 : 1,
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <RefreshCw size={13} />
          {busy ? t("update.checking") : t("update.check")}
        </Button>
      </div>

      {/* update waiting — slides in only when the remote is ahead */}
      <AnimatePresence>
        {(phase === "available" || applying) && (
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ type: "spring", stiffness: 300, damping: 28 }}
          >
            <InsetGroup
              header={t("update.availableTitle")}
              footer={t("update.installFooter")}
            >
              <GroupRow
                first
                icon={<Tag size={15} />}
                title={<span style={mono}>{latest}</span>}
                detail={t("update.latestTag")}
                trailing={
                  u.info?.latestCommit ? (
                    <span
                      style={{
                        ...mono,
                        fontSize: 12,
                        color: "var(--text-tertiary)",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <GitCommitHorizontal size={13} />
                      {u.info.latestCommit}
                    </span>
                  ) : undefined
                }
              />
              <div
                style={{
                  padding: "12px 16px",
                  borderTop: "1px solid var(--separator)",
                }}
              >
                <Button
                  variant="primary"
                  onClick={() => u.apply()}
                  disabled={applying}
                  style={{
                    width: "100%",
                    borderRadius: 12,
                    fontWeight: 600,
                    opacity: applying ? 0.7 : 1,
                  }}
                >
                  {applying ? t("update.installing") : t("update.install")}
                </Button>
                {applyError && (
                  <p
                    style={{
                      margin: "8px 2px 0",
                      fontSize: 12,
                      color: "var(--danger, #E5484D)",
                    }}
                  >
                    {applyError}
                  </p>
                )}
              </div>
            </InsetGroup>
          </motion.div>
        )}
      </AnimatePresence>

      {phase === "error" && u.error && (
        <InsetGroup header={t("update.problem")}>
          <GroupRow
            first
            icon={<RefreshCw size={15} />}
            iconBg="var(--danger, #E5484D)"
            title={t("update.checkFailed")}
            detail={u.error}
            onClick={() => u.check()}
          />
        </InsetGroup>
      )}

      {/* current install */}
      <InsetGroup header={t("update.currentVersion")}>
        <GroupRow
          first
          title={t("update.version")}
          trailing={
            <span style={{ ...mono, fontSize: 13, color: "var(--text-secondary)" }}>
              {version}
            </span>
          }
        />
        <GroupRow
          title={t("update.channel")}
          trailing={
            <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {t("update.channelStable")}
            </span>
          }
        />
      </InsetGroup>

      {/* update source — honest empty state until the repo is published */}
      <InsetGroup
        header={t("update.source")}
        footer={
          u.info?.configured
            ? t("update.sourceFooter")
            : t("update.notConfiguredFooter")
        }
      >
        <GroupRow
          first
          icon={<GitBranch size={15} />}
          iconBg={u.info?.configured ? undefined : "var(--gray-1, #8E8E93)"}
          title={t("update.sourceRepo")}
          detail={
            u.info?.configured ? (
              <span style={mono}>{u.info.repoUrl}</span>
            ) : (
              t("update.notConfigured")
            )
          }
        />
      </InsetGroup>

      {u.lastCheckedAt && (
        <p
          style={{
            marginTop: 20,
            textAlign: "center",
            fontSize: 12,
            color: "var(--text-tertiary)",
          }}
        >
          {t("update.lastChecked", {
            time: new Date(u.lastCheckedAt).toLocaleTimeString(
              locale === "zh" ? "zh-CN" : "en-US",
              { hour: "2-digit", minute: "2-digit" }
            ),
          })}
        </p>
      )}
    </SettingsPage>
  );
}
