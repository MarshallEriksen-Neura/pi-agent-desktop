"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, Folder, LoaderCircle, Server } from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import type { FsEntryDto } from "@/lib/backend/ports/workspace-fs";
import { isRemoteWorkspaceLauncherOutdated } from "@/lib/backend/ports/remote-workspace-fs";
import { remoteHome } from "@/lib/remote-home-cache";
import {
  draftForDir,
  filterRemoteEntries,
  normalizeRemoteDir,
  resolveRemoteDraftPath,
  splitRemoteDraft,
} from "@/lib/remote-path-draft";
import type { WorkspaceTargetId } from "@/lib/workspace-target";
import { useT } from "@/lib/i18n";

/**
 * Choosing a directory on a remote host.
 *
 * The app has to draw this itself: `pick()` returns a path from a native OS dialog, and
 * no version of that call can enumerate a directory over SSH. That is the gap the
 * `browse(targetId)` port exists to fill.
 *
 * Every level is one SSH round trip, so this deliberately does not pretend to be a
 * native dialog. Navigation shows its own loading state and only ever fetches the level
 * being opened — a dialog that felt instant and then stalled would be worse than one
 * that looks like what it is.
 *
 * The path is an editable field rather than a breadcrumb, because clicking down a tree
 * is the slow way to reach a path the user already knows, and each click costs a round
 * trip. Typing works like an editor's path input: the field is the destination, the list
 * below is the completion for whatever segment is being typed. Both halves stay in sync
 * — clicking a folder rewrites the field, and typing past a `/` lists that directory —
 * so neither is a mode the user has to leave.
 */

interface RemoteFolderPickerProps {
  targetId: WorkspaceTargetId;
  /** Host label for the header — the profile's display name, not the alias. */
  hostLabel: string;
  onCancel: () => void;
  onChoose: (path: string) => void;
}

const parentOf = (path: string): string | null => {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed.length === 0) return null;
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : trimmed.slice(0, cut);
};

/**
 * How long typing settles before its directory is listed.
 *
 * Not cosmetic: without it, pasting `/srv/www/html` would fire a listing for `/s`,
 * `/sr`, `/srv`… — an SSH round trip per keystroke, arriving out of order.
 */
const TYPING_SETTLE_MS = 260;

export function RemoteFolderPicker({
  targetId,
  hostLabel,
  onCancel,
  onChoose,
}: RemoteFolderPickerProps) {
  const t = useT();
  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<FsEntryDto[]>([]);
  const [draft, setDraft] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * Youngest request wins. Typing can have a listing in flight when the next one
   * starts, and an older reply landing last would leave the field pointing at one
   * directory and the list showing another.
   */
  const requestId = useRef(0);
  /**
   * The directory a listing is currently in flight for.
   *
   * Without it, clicking a folder costs two SSH round trips: the click issues the
   * listing and *also* rewrites the field, and the field pointing somewhere unlisted is
   * exactly the condition the typing timer fires on — which then asks for the same
   * directory again, because a round trip takes longer than the timer.
   */
  const inFlightDir = useRef<string | null>(null);
  /** Rows by index, so a keyboard walk can keep the highlight inside the scroll box. */
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const home = useMemo(
    () => (targetId.startsWith("ssh:") ? remoteHome(targetId.slice(4)) : undefined),
    [targetId],
  );

  const load = useCallback(
    async (next?: string, options?: { quiet?: boolean }): Promise<string | null> => {
      // `quiet` is the typing-driven path: no error banner, and the field is left alone.
      // A half-typed path is *expected* to miss, and rewriting the field mid-word would
      // move the caret out from under the user.
      const quiet = options?.quiet === true;
      const id = (requestId.current += 1);
      inFlightDir.current = next ?? null;
      setLoading(true);
      if (!quiet) setError(null);
      try {
        const result = await getPort("projectCatalog").browse(targetId, next);
        if (requestId.current !== id) return null;
        // Normalized here so the comparison against the typed directory is exact: the
        // port echoes back whatever it was given, and a configured browse directory
        // written as `/srv/` would otherwise read as "not the directory we listed" and
        // spend a second round trip re-listing it.
        const opened = normalizeRemoteDir(result.path);
        setPath(opened);
        setEntries(result.entries.filter((entry) => entry.isDir));
        if (!quiet) setDraft(draftForDir(opened));
        return opened;
      } catch (cause) {
        if (requestId.current !== id) return null;
        // A quiet failure keeps the last good listing: the user is mid-path, and
        // emptying the list under them would hide the folders they are typing towards.
        if (quiet) return null;
        // An out-of-date launcher gets prose naming the fix, because the raw string is
        // a transport code that reads like a broken connection — the connection is
        // fine, and no amount of retrying or SSH debugging will change the outcome.
        // Every host enrolled before V2 lands here on its first browse.
        //
        // Otherwise: surfaced, not swallowed. The launcher's codes distinguish "no
        // permission" from "gone", and a browser that silently showed an empty
        // directory for both would be indistinguishable from a directory that really
        // is empty.
        if (isRemoteWorkspaceLauncherOutdated(cause)) {
          setError(t("remoteAgent.browse.launcherOutdated"));
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
        return null;
      } finally {
        // Cleared once settled, not on success only: a directory that failed is worth
        // one more attempt if the user types their way back to it.
        if (requestId.current === id) {
          setLoading(false);
          inFlightDir.current = null;
        }
      }
    },
    [targetId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const location = splitRemoteDraft(draft, home);
  const drafted = location?.dir ?? null;
  const filter = location?.filter ?? "";
  // True while the field names a directory that has not been listed yet — the window
  // between a keystroke and its settled listing. The rows still describe `path`, so they
  // stay unfiltered until the listing they belong to arrives.
  const pending = drafted !== null && path !== null && drafted !== path;

  useEffect(() => {
    if (!pending || drafted === null) return;
    if (inFlightDir.current === drafted) return;
    const timer = setTimeout(() => void load(drafted, { quiet: true }), TYPING_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [pending, drafted, load]);

  const suggestions = useMemo(() => {
    if (!pending) return filterRemoteEntries(entries, filter);
    // Mid-transition the rows still belong to `path`, so the typed filter does not apply
    // to them. Filtering by the name of the directory being entered instead keeps the
    // list still: closing a segment with `/` would otherwise flash the whole parent
    // listing back for the length of a round trip, right after narrowing it to one row.
    const entering =
      drafted !== null && parentOf(drafted) === path
        ? drafted.slice(drafted.lastIndexOf("/") + 1)
        : "";
    return filterRemoteEntries(entries, entering);
  }, [pending, entries, filter, drafted, path]);

  // The arrow keys own the highlight, but only until the candidate set changes under
  // them — an index into a list that no longer exists points at the wrong folder.
  useEffect(() => setHighlight(-1), [path, filter]);
  /**
   * A typed filter preselects its best match, so typing a name and pressing Enter opens
   * it. With no filter nothing is preselected: Enter then means "this directory", which
   * is the whole point of having typed a path in the first place.
   */
  const active =
    highlight >= 0
      ? Math.min(highlight, suggestions.length - 1)
      : filter.length > 0 && suggestions.length > 0
        ? 0
        : -1;

  // `nearest` so this is a no-op when the row is already on screen — the highlight also
  // moves as the filter narrows, and a list that jumped on every keystroke would be
  // harder to read than one that does not move.
  useEffect(() => {
    if (active < 0) return;
    rowRefs.current[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const openDir = (dir: string) => {
    setDraft(draftForDir(dir));
    void load(normalizeRemoteDir(dir));
    inputRef.current?.focus();
  };

  /**
   * Commit what the field says, listing it first when it has not been listed yet.
   *
   * Never commits an unverified string: a typo would otherwise become a project root
   * that fails later, somewhere with less to say about why.
   */
  const commit = async () => {
    const target = resolveRemoteDraftPath(draft, home);
    if (target === null) return;
    if (target === path) {
      onChoose(target);
      return;
    }
    const opened = await load(target);
    if (opened !== null) onChoose(opened);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (suggestions.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setHighlight(Math.min(Math.max(active + step, -1), suggestions.length - 1));
      return;
    }
    if (event.key === "Tab") {
      // Completion rather than focus movement: the field and the list are one control,
      // and there is nothing else in this popover Tab could usefully reach.
      const candidate = suggestions[active >= 0 ? active : 0];
      if (candidate === undefined) return;
      event.preventDefault();
      setDraft(draftForDir(candidate.path));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const candidate = active >= 0 ? suggestions[active] : undefined;
      if (candidate !== undefined) {
        openDir(candidate.path);
        return;
      }
      void commit();
      return;
    }
    if (event.key === "Escape") {
      // Two meanings, cheapest first: abandon the edit, then abandon the picker. A
      // single Escape that closed everything would throw away a typed path on a
      // keystroke the user reaches for to undo one.
      if (path !== null && draft !== draftForDir(path)) {
        event.preventDefault();
        event.stopPropagation();
        setDraft(draftForDir(path));
        return;
      }
      onCancel();
    }
  };

  // `..` is a navigation row, not a completion, so it drops out while filtering — it
  // matches nothing the user typed and would sit above the real matches.
  const parentRow =
    path !== null && filter.length === 0 && !pending ? parentOf(path) : null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
        minHeight: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <Server size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-primary)" }}>
          {hostLabel}
        </span>
        {loading && (
          <LoaderCircle size={12} className="animate-spin" style={{ color: "var(--text-tertiary)" }} />
        )}
      </div>

      <div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("remoteAgent.browse.pathPlaceholder")}
          aria-label={t("remoteAgent.browse.pathLabel")}
          title={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          // Autofocused because the field is the fast path: the picker opens ready to
          // take a path, and the arrow keys drive the list from here.
          autoFocus
          style={{
            width: "100%",
            padding: "6px 8px",
            fontSize: 11.5,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--text-primary)",
            background: "var(--bg-sunken)",
            border: "1px solid var(--separator)",
            borderRadius: 7,
            outline: "none",
          }}
        />
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            color: "var(--text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {t("remoteAgent.browse.keyboardHint")}
        </div>
      </div>

      {error !== null && (
        <div
          style={{
            fontSize: 11.5,
            color: "var(--danger)",
            background: "var(--danger-muted, transparent)",
            borderRadius: 6,
            padding: "6px 8px",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          maxHeight: 240,
          overflowY: "auto",
          border: "1px solid var(--separator)",
          borderRadius: 8,
        }}
      >
        {parentRow !== null && (
          <button
            className="pi-row"
            onClick={() => openDir(parentRow)}
            disabled={loading}
            style={rowStyle}
          >
            <Folder size={13} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
            <span style={{ flex: 1, textAlign: "left" }}>..</span>
          </button>
        )}
        {!loading && suggestions.length === 0 && error === null && (
          <div style={{ padding: "10px 12px", fontSize: 11.5, color: "var(--text-tertiary)" }}>
            {filter.length > 0
              ? t("remoteAgent.browse.noMatch", { filter })
              : t("remoteAgent.browse.empty")}
          </div>
        )}
        {suggestions.map((entry, index) => (
          <button
            key={entry.path}
            ref={(node) => {
              rowRefs.current[index] = node;
            }}
            className="pi-row"
            onClick={() => openDir(entry.path)}
            disabled={loading}
            title={entry.path}
            // Same fill the class gives on hover, so a keyboard walk and a mouse walk
            // look like the same gesture.
            style={
              index === active
                ? { ...rowStyle, background: "var(--separator)" }
                : rowStyle
            }
          >
            <Folder size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "left",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {entry.name}
            </span>
            <ChevronRight size={12} style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={buttonStyle(false)}>
          {t("common.cancel")}
        </button>
        <button
          onClick={() => void commit()}
          disabled={path === null || loading}
          style={buttonStyle(true)}
        >
          {t("remoteAgent.browse.useThis")}
        </button>
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "7px 10px",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12.5,
  color: "var(--text-primary)",
  fontFamily: "var(--font-ui)",
};

const buttonStyle = (primary: boolean): React.CSSProperties => ({
  padding: "6px 12px",
  borderRadius: 7,
  border: primary ? "none" : "1px solid var(--separator)",
  background: primary ? "var(--accent)" : "transparent",
  color: primary ? "var(--accent-contrast, #fff)" : "var(--text-secondary)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "var(--font-ui)",
});
