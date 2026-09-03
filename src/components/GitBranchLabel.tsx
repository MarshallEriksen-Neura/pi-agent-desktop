"use client";

import { useEffect } from "react";
import { GitBranch } from "lucide-react";
import { useWorkspace } from "@/lib/workspace";
import { usePi } from "@/lib/pi/store";
import { useGitBranch } from "@/lib/git-branch";
import { gitHeadLabel } from "@/lib/git-head";
import { LOCAL_WORKSPACE_TARGET } from "@/lib/workspace-target";
import { useT } from "@/lib/i18n";

/**
 * How often a local project re-reads `HEAD`.
 *
 * Local only, and that asymmetry is the point: the built-in terminal never gives
 * up window focus, so a `git checkout` typed there produces no event this
 * component could listen for, and one read of a 41-byte file is the cheapest way
 * to notice. A remote read is a fresh `ssh` process, so remote targets settle for
 * the event-driven refreshes below.
 */
const LOCAL_POLL_MS = 10_000;

/**
 * Below this rail width the branch is dropped entirely rather than shortened.
 *
 * It shares a row with four controls above a 280px floor, and it is the least
 * urgent thing in it: the icon on its own would name no branch, and a branch
 * clipped to three characters is worse than the space it costs. `TurnChangesChip`
 * degrades against the same width for the same reason.
 */
const MIN_WIDTH_FOR_BRANCH = 320;

/** Past this, the name gives up room before its neighbours have to. */
const COMPACT_WIDTH = 380;

/**
 * The branch the current project is on, beside the turn's change count.
 *
 * Renders nothing at all when the project is not a git working tree — including
 * on a remote target whose launcher cannot read the file. Styled as a peer of
 * `TurnChangesChip` rather than as text: they answer two halves of one question
 * ("what changed", "on what"), so they belong to the same visual group.
 *
 * Inert, unlike both chips around it. There is no branch switcher behind it, and
 * a pointer cursor over something that does nothing is a worse lie than a plain
 * label.
 */
export function GitBranchLabel({ width }: { width?: number }) {
  const root = useWorkspace((s) => s.root);
  const targetId = useWorkspace((s) => s.targetId);
  const mock = useWorkspace((s) => s.mock);
  const switching = useWorkspace((s) => s.switching);
  const piStatus = usePi((s) => s.status);
  const head = useGitBranch((s) => s.head);
  const ensure = useGitBranch((s) => s.ensure);
  const refresh = useGitBranch((s) => s.refresh);
  const t = useT();

  useEffect(() => {
    ensure({ root, targetId, mock });
  }, [ensure, root, targetId, mock]);

  // pi runs git itself, so a finished turn is the likeliest moment for HEAD to
  // have moved. `ready` also covers the first connect, which is a free refresh.
  useEffect(() => {
    if (piStatus !== "ready") return;
    refresh({ root, targetId, mock });
  }, [refresh, piStatus, root, targetId, mock]);

  // Coming back to the window: the branch may have been switched in a terminal
  // outside the app while it was in the background.
  useEffect(() => {
    const recheck = () => {
      if (document.visibilityState === "hidden") return;
      refresh({ root, targetId, mock });
    };
    window.addEventListener("focus", recheck);
    document.addEventListener("visibilitychange", recheck);
    return () => {
      window.removeEventListener("focus", recheck);
      document.removeEventListener("visibilitychange", recheck);
    };
  }, [refresh, root, targetId, mock]);

  useEffect(() => {
    if (mock || targetId !== LOCAL_WORKSPACE_TARGET) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "hidden") return;
      refresh({ root, targetId, mock });
    }, LOCAL_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, root, targetId, mock]);

  // Mid-switch the store still holds the branch of the project being left.
  if (head === null || switching) return null;
  if (width !== undefined && width < MIN_WIDTH_FOR_BRANCH) return null;

  const label = gitHeadLabel(head);
  return (
    <span
      title={
        head.kind === "branch"
          ? t("git.branch", { branch: label })
          : t("git.detached", { sha: label })
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        marginRight: 4,
        padding: "4px 7px",
        border: "1px solid var(--separator)",
        borderRadius: 99,
        color: "var(--text-tertiary)",
        fontFamily: "var(--font-mono)",
        fontSize: 10.5,
        lineHeight: 1,
        // Bounded rather than flexible: the target picker beside it is the control
        // that must stay legible, so a long branch name yields to it.
        maxWidth: width !== undefined && width < COMPACT_WIDTH ? 72 : 128,
        minWidth: 0,
      }}
    >
      <GitBranch size={12} strokeWidth={1.75} style={{ flexShrink: 0 }} />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </span>
    </span>
  );
}
