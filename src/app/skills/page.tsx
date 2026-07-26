"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { usePi } from "@/lib/pi/store";
import { usePiSettings, type SettingsScope } from "@/lib/pi/settings";
import { useSkills, type SkillInfo, type SkillOrigin } from "@/lib/pi/skills";
import { useT } from "@/lib/i18n";
import {
  SettingsPage,
  InsetGroup,
  GroupRow,
  IOSSwitch,
  Segmented,
  StringListEditor,
} from "@/components/settings-ui";
import {
  Search,
  Wand2,
  RefreshCw,
  RotateCcw,
  Copy,
  Check,
  FileText,
  ChevronRight,
} from "lucide-react";

const ORIGINS: readonly SkillOrigin[] = ["global", "project", "path"];

/** provenance colors — global/project/path, used by the ledger and legends */
const ORIGIN_COLOR: Record<SkillOrigin, string> = {
  global: "var(--accent)",
  project: "var(--success)",
  path: "var(--agent-thinking)",
};

/** stable identity tile — hue derives from the skill's own name */
const TILE_COLORS = [
  "#007aff", "#34c759", "#ff9500", "#af52de",
  "#30b0c7", "#ff3b30", "#5e5ce6", "#ff2d55",
];
function tileColor(name: string) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}

/**
 * Origin ledger — one segment per provenance, width ∝ skill count.
 * Clicking a segment (or its legend chip) filters the list below.
 */
function OriginLedger({
  counts,
  filter,
  onFilter,
}: {
  counts: Record<SkillOrigin, number>;
  filter: SkillOrigin | null;
  onFilter: (o: SkillOrigin | null) => void;
}) {
  const t = useT();
  const total = ORIGINS.reduce((n, o) => n + counts[o], 0);

  return (
    <div style={{ marginTop: 18 }}>
      <div
        style={{
          display: "flex",
          gap: 3,
          height: 12,
          borderRadius: 99,
          overflow: "hidden",
        }}
      >
        {total === 0 ? (
          <div
            style={{
              flex: 1,
              background: "var(--bg-sunken)",
              border: "1px solid var(--separator)",
              borderRadius: 99,
            }}
          />
        ) : (
          ORIGINS.filter((o) => counts[o] > 0).map((o) => (
            <motion.button
              key={o}
              type="button"
              aria-pressed={filter === o}
              title={`${t(`skills.origin.${o}`)} · ${counts[o]}`}
              onClick={() => onFilter(filter === o ? null : o)}
              initial={{ opacity: 0, scaleX: 0.6 }}
              animate={{
                opacity: filter && filter !== o ? 0.22 : 1,
                scaleX: 1,
              }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
              style={{
                flex: counts[o],
                minWidth: 14,
                border: "none",
                padding: 0,
                cursor: "pointer",
                background: ORIGIN_COLOR[o],
                transformOrigin: "left",
              }}
            />
          ))
        )}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 8 }}>
        {ORIGINS.map((o) => (
          <button
            key={o}
            type="button"
            aria-pressed={filter === o}
            onClick={() => onFilter(filter === o ? null : o)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "none",
              padding: 0,
              background: "transparent",
              cursor: "pointer",
              fontFamily: "var(--font-ui)",
              fontSize: 12,
              color:
                filter && filter !== o
                  ? "var(--text-tertiary)"
                  : "var(--text-secondary)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 99,
                background: ORIGIN_COLOR[o],
                opacity: filter && filter !== o ? 0.3 : 1,
                flexShrink: 0,
              }}
            />
            {t(`skills.origin.${o}`)}
            <span
              style={{
                fontVariantNumeric: "tabular-nums",
                fontWeight: 600,
                color:
                  filter && filter !== o
                    ? "var(--text-tertiary)"
                    : "var(--text-primary)",
              }}
            >
              {counts[o]}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** Expandable skill row: header → description, command, path, SKILL.md preview. */
function SkillRow({ skill, first }: { skill: SkillInfo; first: boolean }) {
  const t = useT();
  const readSource = useSkills((s) => s.readSource);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [source, setSource] = useState<string | null>(null);
  const [sourceErr, setSourceErr] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const command = `/skill:${skill.name}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — leave the button as-is */
    }
  };

  const toggleSource = async () => {
    if (showSource) return setShowSource(false);
    setShowSource(true);
    if (source !== null || sourceErr !== null) return;
    try {
      setSource(await readSource(skill.file));
    } catch (e) {
      setSourceErr(e instanceof Error ? e.message : String(e));
    }
  };

  const chipButton: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 10px",
    fontSize: 12,
    fontFamily: "var(--font-ui)",
    color: "var(--text-secondary)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--separator)",
    borderRadius: 8,
    cursor: "pointer",
  };

  return (
    <div style={{ borderTop: first ? "none" : "1px solid var(--separator)" }}>
      <motion.button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        whileTap={{ scale: 0.99 }}
        className="pi-row"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          width: "100%",
          padding: "11px 16px",
          border: "none",
          background: "transparent",
          textAlign: "left",
          cursor: "pointer",
          fontFamily: "var(--font-ui)",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "grid",
            placeItems: "center",
            width: 30,
            height: 30,
            borderRadius: 8,
            flexShrink: 0,
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            background: tileColor(skill.name),
          }}
        >
          {skill.name.charAt(0).toUpperCase()}
        </span>
        <span style={{ minWidth: 0, flex: 1 }}>
          <span
            style={{
              display: "block",
              fontSize: 13,
              fontFamily: "var(--font-mono)",
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {skill.name}
          </span>
          {skill.description && (
            <span
              style={{
                display: "block",
                fontSize: 12,
                color: "var(--text-tertiary)",
                marginTop: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {skill.description}
            </span>
          )}
        </span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          style={{ color: "var(--text-tertiary)", display: "grid", flexShrink: 0 }}
        >
          <ChevronRight size={15} />
        </motion.span>
      </motion.button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 38 }}
            style={{ overflow: "hidden" }}
          >
            <div style={{ padding: "2px 16px 13px 58px" }}>
              {skill.description && (
                <p
                  style={{
                    margin: "0 0 10px",
                    fontSize: 12.5,
                    lineHeight: 1.55,
                    color: "var(--text-secondary)",
                  }}
                >
                  {skill.description}
                </p>
              )}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  flexWrap: "wrap",
                }}
              >
                <code
                  style={{
                    padding: "4px 10px",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: "var(--text-primary)",
                    background: "var(--bg-sunken)",
                    border: "1px solid var(--separator)",
                    borderRadius: 8,
                  }}
                >
                  {command}
                </code>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={copy}
                  style={{
                    ...chipButton,
                    color: copied ? "var(--success)" : "var(--text-secondary)",
                  }}
                >
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? t("skills.copied") : t("skills.copy")}
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.94 }}
                  onClick={toggleSource}
                  aria-expanded={showSource}
                  style={chipButton}
                >
                  <FileText size={12} />
                  {showSource ? t("skills.hideSource") : t("skills.viewSource")}
                </motion.button>
              </div>
              <div
                title={skill.file}
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text-tertiary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {skill.file}
              </div>
              <AnimatePresence initial={false}>
                {showSource && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 400, damping: 38 }}
                    style={{ overflow: "hidden" }}
                  >
                    {sourceErr ? (
                      <p style={{ margin: "10px 0 0", fontSize: 12, color: "var(--danger)" }}>
                        {t("skills.sourceError", { err: sourceErr })}
                      </p>
                    ) : (
                      <pre
                        style={{
                          margin: "10px 0 0",
                          padding: "10px 12px",
                          maxHeight: 260,
                          overflow: "auto",
                          fontSize: 11.5,
                          lineHeight: 1.55,
                          fontFamily: "var(--font-mono)",
                          color: "var(--text-secondary)",
                          background: "var(--bg-sunken)",
                          border: "1px solid var(--separator)",
                          borderRadius: 8,
                          whiteSpace: "pre-wrap",
                          wordBreak: "break-word",
                        }}
                      >
                        {source ?? t("skills.sourceLoading")}
                      </pre>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export default function SkillsPage() {
  const t = useT();
  const { refresh } = usePi();
  const settings = usePiSettings();
  const sk = useSkills();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SkillOrigin | null>(null);
  const [resScope, setResScope] = useState<SettingsScope>("global");

  useEffect(() => {
    settings.load().then(() => useSkills.getState().scan());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const counts = useMemo(() => {
    const c: Record<SkillOrigin, number> = { global: 0, project: 0, path: 0 };
    for (const s of sk.skills) c[s.origin]++;
    return c;
  }, [sk.skills]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      sk.skills.filter(
        (s) =>
          (!filter || s.origin === filter) &&
          (!q ||
            s.name.toLowerCase().includes(q) ||
            s.description.toLowerCase().includes(q))
      ),
    [sk.skills, filter, q]
  );

  const groups = ORIGINS.map((o) => ({
    origin: o,
    skills: visible.filter((s) => s.origin === o),
  })).filter((g) => g.skills.length > 0);

  const rescan = async () => {
    await settings.load();
    await sk.scan();
    await refresh();
  };

  return (
    <SettingsPage
      title={t("skills.title")}
      subtitle={sk.mock ? t("skills.subtitleMock") : t("skills.subtitleLive")}
    >
      <OriginLedger counts={counts} filter={filter} onFilter={setFilter} />

      {/* search — filters name + description */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginTop: 16,
          padding: "7px 12px",
          background: "var(--bg-base)",
          border: "1px solid var(--separator)",
          borderRadius: 10,
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <Search size={14} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
        <input
          type="text"
          value={query}
          placeholder={t("skills.search")}
          onChange={(e) => setQuery(e.target.value)}
          style={{
            flex: 1,
            minWidth: 0,
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: 13,
            fontFamily: "var(--font-ui)",
            color: "var(--text-primary)",
          }}
        />
      </div>

      {sk.loading && !sk.scanned ? (
        <InsetGroup>
          <GroupRow first title={t("skills.scanning")} />
        </InsetGroup>
      ) : sk.skills.length === 0 ? (
        <InsetGroup>
          <GroupRow
            first
            icon={<Wand2 size={15} />}
            title={t("skills.none")}
            detail={t("skills.noneDetail")}
          />
        </InsetGroup>
      ) : visible.length === 0 ? (
        <InsetGroup>
          <GroupRow first title={t("skills.noMatch", { query })} />
        </InsetGroup>
      ) : (
        groups.map((g) => (
          <InsetGroup
            key={g.origin}
            header={t(`skills.origin.${g.origin}`)}
            footer={
              g.origin === "path" && sk.unscannable.length > 0
                ? t("skills.unscannable", { globs: sk.unscannable.join(", ") })
                : t(`skills.groupFooter.${g.origin}`)
            }
          >
            {g.skills.map((s, i) => (
              <SkillRow key={s.file} skill={s} first={i === 0} />
            ))}
          </InsetGroup>
        ))
      )}

      {/* loading controls — settings.json skills paths + slash-command toggle */}
      <InsetGroup header={t("skills.loadHeader")} footer={t("skills.loadFooter")}>
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["global", "project"] as const}
            value={resScope}
            onChange={setResScope}
          />
        </div>
        <div style={{ borderTop: "1px solid var(--separator)" }}>
          <StringListEditor
            items={settings[resScope].data?.skills as string[] | undefined}
            onChange={(items) => settings.setKey(resScope, "skills", items)}
            addPlaceholder={t("plugins.addPath")}
          />
        </div>
        <div style={{ borderTop: "1px solid var(--separator)" }}>
          <GroupRow
            first
            icon={<Wand2 size={15} />}
            title={t("plugins.skillCommands")}
            detail={t("plugins.skillCommandsDetail")}
            trailing={
              <IOSSwitch
                checked={
                  (settings.effective().enableSkillCommands as boolean | undefined) !==
                  false
                }
                onChange={(v) => settings.setKey(resScope, "enableSkillCommands", v)}
              />
            }
          />
        </div>
      </InsetGroup>

      <InsetGroup header={t("plugins.actions")}>
        <GroupRow
          first
          icon={<RefreshCw size={16} />}
          iconBg="var(--accent)"
          title={t("skills.rescan")}
          detail={t("skills.rescanDetail")}
          onClick={rescan}
        />
        {settings.dirtyRestart && (
          <GroupRow
            icon={<RotateCcw size={16} />}
            iconBg="var(--warning, #C15F3C)"
            title={t("plugins.restartTitle")}
            detail={t("plugins.restartDetail")}
            onClick={() => settings.restartPi()}
          />
        )}
      </InsetGroup>

      {(sk.error || settings.lastError) && (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--danger, #E5484D)" }}>
          {sk.error ?? settings.lastError}
        </p>
      )}
    </SettingsPage>
  );
}
