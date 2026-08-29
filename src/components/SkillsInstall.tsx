"use client";

/**
 * Install section of the skills page. All of the work happens in
 * lib/pi/skills-install.ts (which shells out to the Skills CLI); this file is
 * presentation plus the two text inputs.
 */

import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { Badge } from "@appica/ui-react/badge";
import { useSkills } from "@/lib/pi/skills";
import { usePiSettings } from "@/lib/pi/settings";
import {
  useSkillsInstall,
  looksLikeSource,
  normalizeSource,
  type CatalogHit,
} from "@/lib/pi/skills-install";
import { useWorkspace } from "@/lib/workspace";
import { useT, type TFunc } from "@/lib/i18n";
import { GroupRow, InsetGroup, Segmented } from "./settings-ui";
import { Skeleton } from "./primitives";
import { AlertTriangle, Check, RefreshCw, Search, Wand2 } from "lucide-react";

const SCOPES = ["global", "project"] as const;

/** 673399 → "673K", matching how the CLI itself reports install counts. */
function installCount(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 12px",
  fontSize: 13.5,
  borderRadius: 9,
  border: "1px solid var(--separator)",
  background: "var(--bg-sunken)",
  color: "var(--text-primary)",
  outline: "none",
  fontFamily: "var(--font-ui)",
};

/** Selection state for a row in the `--list` picker. */
function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        display: "grid",
        placeItems: "center",
        width: 18,
        height: 18,
        borderRadius: 5,
        flexShrink: 0,
        border: `1px solid ${on ? "var(--accent)" : "var(--separator)"}`,
        background: on ? "var(--accent)" : "transparent",
        color: "#fff",
      }}
    >
      {on && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

function skeletonRows() {
  return [0, 1, 2].map((i) => (
    <GroupRow
      key={i}
      first={i === 0}
      icon={<Skeleton width={16} height={16} radius={5} />}
      title={<Skeleton width="38%" height={13} />}
      detail={<Skeleton width="70%" height={12} />}
    />
  ));
}

/**
 * A catalog hit. The same skill name is published by many repos, so "installed"
 * means this source's copy is the one on disk — a different source under the
 * same name gets the install button plus a warning that it would replace it.
 */
function HitRow({
  hit,
  first,
  installed,
  conflict,
  busy,
  onInstall,
  t,
}: {
  hit: CatalogHit;
  first: boolean;
  installed: boolean;
  conflict: boolean;
  busy: string | null;
  onInstall: () => void;
  t: TFunc;
}) {
  return (
    <GroupRow
      first={first}
      icon={<Wand2 size={15} />}
      iconBg="var(--accent)"
      title={hit.name}
      detail={`${hit.source} · ${t("skillsInstall.installs", {
        n: installCount(hit.installs),
      })}`}
      trailing={
        <AnimatePresence mode="popLayout" initial={false}>
          {installed ? (
            <motion.span
              key="installed"
              initial={{ scale: 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
              style={{ display: "inline-flex" }}
            >
              <Badge variant="success" size="sm">
                <Check size={12} /> {t("store.installedBadge")}
              </Badge>
            </motion.span>
          ) : (
            <motion.span
              key="install"
              exit={{ scale: 0.9, opacity: 0 }}
              transition={{ duration: 0.12, ease: "easeOut" }}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {conflict && (
                <Badge
                  variant="warning"
                  size="sm"
                  title={t("skillsInstall.willReplaceHint", { name: hit.name })}
                >
                  {t("skillsInstall.willReplace")}
                </Badge>
              )}
              <Button
                variant="primary"
                size="sm"
                onClick={onInstall}
                disabled={busy !== null}
                style={{
                  borderRadius: 8,
                  opacity: busy && busy !== hit.id ? 0.4 : 1,
                }}
              >
                {busy === hit.id ? t("store.installing") : t("store.install")}
              </Button>
            </motion.span>
          )}
        </AnimatePresence>
      }
    />
  );
}

export function SkillsInstall() {
  const t = useT();
  const s = useSkillsInstall();
  const installed = useSkills((st) => st.skills);
  const settings = usePiSettings();
  const root = useWorkspace((w) => w.root);

  const typed = s.input.trim();
  /** `owner/repo`, a URL or a path — fetched on demand instead of as you type */
  const isSource = looksLikeSource(typed);

  useEffect(() => {
    useSkillsInstall.getState().loadLocks();
  }, []);

  // Without an open project there is no `<root>/.pi/skills` to install into.
  useEffect(() => {
    if (!root && useSkillsInstall.getState().scope === "project") {
      useSkillsInstall.getState().setScope("global");
    }
  }, [root]);

  /**
   * skill name → the source it came from, for the scope being installed into.
   * A name present with a `null` source is installed but unattributed (no lock
   * entry), which still means an install of that name would replace it.
   *
   * Scoped deliberately: a skill installed globally can still be worth adding to
   * a project, so this tracks the scope the user is installing into.
   */
  const installedHere = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const skill of installed) {
      if (skill.origin === s.scope) map.set(skill.name, s.locks?.[skill.name] ?? null);
    }
    return map;
  }, [installed, s.scope, s.locks]);

  return (
    <>
      <InsetGroup
        header={t("skillsInstall.header")}
        footer={
          !root
            ? t("skillsInstall.scopeFooterNoProject")
            : s.scope === "global"
              ? t("skillsInstall.scopeFooterGlobal")
              : t("skillsInstall.scopeFooterProject")
        }
      >
        <div
          style={{
            padding: "12px 14px",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <Segmented
            options={SCOPES}
            value={s.scope}
            onChange={s.setScope}
            disabled={!root}
            labelOf={(o) => t(`skills.origin.${o}`)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flex: 1,
                minWidth: 0,
                padding: "0 10px",
                borderRadius: 9,
                border: "1px solid var(--separator)",
                background: "var(--bg-sunken)",
              }}
            >
              <Search size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
              <input
                type="text"
                value={s.input}
                placeholder={t("skillsInstall.inputPlaceholder")}
                onChange={(e) => s.setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isSource) s.browse();
                }}
                style={{
                  ...inputStyle,
                  padding: "8px 0",
                  border: "none",
                  background: "transparent",
                }}
              />
            </div>
            {/* A source has to be cloned first, so it needs an explicit go. */}
            {isSource && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => s.browse()}
                disabled={s.listing}
                style={{ borderRadius: 8, flexShrink: 0 }}
              >
                {s.listing ? t("skillsInstall.browsing") : t("skillsInstall.browse")}
              </Button>
            )}
          </div>
        </div>
      </InsetGroup>

      {/* Catalogue results — a name query, answered as you type. */}
      {!isSource && typed.length >= 2 && (
        <InsetGroup
          header={
            s.hits && s.hits.length > 0
              ? t("skillsInstall.matches", { n: s.hits.length })
              : t("skillsInstall.catalogHeader")
          }
          footer={t("skillsInstall.catalogFooter")}
        >
          {s.searching ? (
            <>{skeletonRows()}</>
          ) : s.searchError ? (
            <GroupRow
              first
              icon={<AlertTriangle size={16} />}
              iconBg="var(--danger, #E5484D)"
              title={t("skillsInstall.searchFailed")}
              detail={s.searchError}
            />
          ) : !s.hits || s.hits.length === 0 ? (
            <GroupRow
              first
              title={t("skillsInstall.noHits", { query: typed })}
              detail={t("skillsInstall.noHitsDetail")}
            />
          ) : (
            s.hits.map((hit, i) => {
              // `undefined` = the name is free; a string = installed from there
              const from = installedHere.get(hit.name);
              const taken = installedHere.has(hit.name);
              const isThisOne = taken && from === normalizeSource(hit.source);
              return (
                <HitRow
                  key={hit.id}
                  hit={hit}
                  first={i === 0}
                  installed={isThisOne}
                  conflict={taken && !isThisOne}
                  busy={s.busy}
                  onInstall={() => s.install(hit.source, [hit.skillId], hit.id)}
                  t={t}
                />
              );
            })
          )}
        </InsetGroup>
      )}

      {/* Source enumeration — what `--list` found, pick what to install. */}
      {isSource && (s.listing || s.listError || s.sourceSkills || s.sourceOpaque) && (
        <InsetGroup header={t("skillsInstall.sourceSkillsHeader", { source: typed })}>
          {s.listing ? (
            <>{skeletonRows()}</>
          ) : s.listError ? (
            <GroupRow
              first
              icon={<AlertTriangle size={16} />}
              iconBg="var(--danger, #E5484D)"
              title={t("skillsInstall.browseFailed")}
              detail={s.listError}
            />
          ) : s.sourceOpaque ? (
            <GroupRow
              first
              icon={<Wand2 size={15} />}
              title={t("skillsInstall.opaqueSource")}
              detail={t("skillsInstall.opaqueSourceDetail")}
              trailing={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => s.install(typed, ["*"])}
                  disabled={s.busy !== null}
                  style={{ borderRadius: 8 }}
                >
                  {s.busy === "source"
                    ? t("store.installing")
                    : t("skillsInstall.installAll")}
                </Button>
              }
            />
          ) : (
            <>
              {s.sourceSkills?.map((sk, i) => (
                <GroupRow
                  key={sk.name}
                  first={i === 0}
                  title={
                    <span style={{ fontFamily: "var(--font-mono)" }}>{sk.name}</span>
                  }
                  detail={sk.description}
                  onClick={() => s.toggle(sk.name)}
                  trailing={<CheckMark on={s.selected.includes(sk.name)} />}
                />
              ))}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "11px 16px",
                  borderTop: "1px solid var(--separator)",
                }}
              >
                <span style={{ fontSize: 12.5, color: "var(--text-tertiary)" }}>
                  {t("skillsInstall.selectedCount", {
                    n: s.selected.length,
                    total: s.sourceSkills?.length ?? 0,
                  })}
                </span>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => s.install(typed, s.selected)}
                  disabled={s.busy !== null || s.selected.length === 0}
                  style={{ borderRadius: 8 }}
                >
                  {s.busy === "source"
                    ? t("store.installing")
                    : t("skillsInstall.installSelected", { n: s.selected.length })}
                </Button>
              </div>
            </>
          )}
        </InsetGroup>
      )}

      <InsetGroup footer={t("skillsInstall.updateFooter")}>
        <GroupRow
          first
          icon={<RefreshCw size={16} />}
          iconBg="var(--success)"
          title={
            s.busy === "update"
              ? t("skillsInstall.updating")
              : t("skillsInstall.updateAll", { scope: t(`skills.origin.${s.scope}`) })
          }
          detail={t("skillsInstall.updateAllDetail")}
          onClick={s.busy === null ? () => s.updateAll() : undefined}
        />
      </InsetGroup>

      <AnimatePresence initial={false}>
        {s.log && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              display: "flex",
              alignItems: "center",
              flexWrap: "wrap",
              gap: 10,
              marginTop: 14,
              fontSize: 12.5,
              lineHeight: 1.5,
              color: s.log.ok ? "var(--success)" : "var(--danger, #E5484D)",
            }}
          >
            {t(s.log.key, s.log.params)}
            {s.log.ok && settings.dirtyRestart && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => settings.restartPi()}
                disabled={settings.busy}
                style={{ borderRadius: 7 }}
              >
                {settings.busy ? t("settings.restarting") : t("settings.restartPi")}
              </Button>
            )}
          </motion.p>
        )}
      </AnimatePresence>
    </>
  );
}
