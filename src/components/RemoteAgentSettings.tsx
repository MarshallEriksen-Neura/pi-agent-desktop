"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@appica/ui-react/button";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  Copy,
  Download,
  LoaderCircle,
  Pencil,
  Server,
  Trash2,
  XCircle,
} from "lucide-react";
import {
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
} from "@appica/ui-react/autocomplete";
import { Input } from "@appica/ui-react/input";
import { getPort } from "@/lib/backend/composition/container";
import type {
  RemotePiProfile,
  RemotePiProfileInput,
  RemoteReadinessCheck,
  RemoteReadinessCheckId,
  RemoteReadinessReport,
} from "@/lib/backend/ports/execution-target";
import { t } from "@/lib/i18n";
import { rememberRemoteHome } from "@/lib/remote-home-cache";
import { ProviderSyncSettings } from "./ProviderSyncSettings";
import { GroupRow, InsetGroup } from "./settings-ui";

/**
 * Setup is organized around "is this host ready", not around the stored fields:
 * two required inputs, everything else behind Advanced, and one checklist row
 * per prerequisite so a failure points at the thing that fixes it.
 */

const EMPTY_DRAFT: RemotePiProfileInput = { name: "", sshHost: "" };

/** Display order — mirrors CHECK_ORDER in `src-tauri/src/remote_profiles.rs`. */
const CHECK_IDS: RemoteReadinessCheckId[] = [
  "ssh",
  "launcher",
  "node",
  "workspace",
  "pi",
  "piAuth",
];

/**
 * The one command that tells the user what they need to know for this failure.
 * Auth and host-key problems are about the connection; a missing binary is
 * almost always a version manager putting it on the interactive PATH only, so
 * the useful probe is what a *login* shell resolves.
 */
function diagnosticCommand(code: string, host: string): string | undefined {
  switch (code) {
    case "ssh_auth_failed":
    case "ssh_host_key":
      return sshVerifyCommand(host);
    case "node_missing":
      return `ssh ${host} bash -lc 'command -v node'`;
    case "pi_not_found":
      return `ssh ${host} bash -lc 'command -v pi'`;
    default:
      return undefined;
  }
}
/**
 * Error codes the in-app installer can fix.
 *
 * `launcher_mode_unsupported` belongs here for the same reason as the other two: the
 * file is present and runnable, it is just an older build, and reinstalling replaces
 * it in place. Offering Install is the whole fix.
 */
const INSTALLABLE = new Set([
  "launcher_missing",
  "launcher_not_executable",
  "launcher_mode_unsupported",
]);
/**
 * Codes that have `settings.remoteAgent.fix.*` guidance. Transport and plumbing
 * failures (timeouts, malformed responses) deliberately have none — there is no
 * generic advice for them, and the row already shows the raw error. Rendering
 * unconditionally would print `t()`'s unknown-key fallback, i.e. a bare
 * `ssh_timeout`, as though it were instructions.
 */
const HAS_FIX_TEXT = new Set([
  "ssh_auth_failed",
  "ssh_host_key",
  "ssh_host_unknown",
  "ssh_unreachable",
  "launcher_missing",
  "launcher_not_executable",
  "launcher_mode_unsupported",
  "node_missing",
  "workspace_missing",
  "workspace_unavailable",
  "pi_not_found",
  "pi_timeout",
  "pi_unavailable",
  "pi_auth_missing",
]);

function sshVerifyCommand(host: string): string {
  return `ssh -o BatchMode=yes -o StrictHostKeyChecking=yes ${host} true`;
}

/** Suggests a display name from the host so the field can be left alone. */
function nameFromHost(host: string): string {
  const bare = host.includes("@") ? host.slice(host.indexOf("@") + 1) : host;
  return bare.split(":")[0] ?? bare;
}

export function RemoteAgentSettings() {
  const profilesPort = getPort("remoteProfiles");
  const [profiles, setProfiles] = useState<RemotePiProfile[]>([]);
  const [configHosts, setConfigHosts] = useState<string[]>([]);
  const [draft, setDraft] = useState<RemotePiProfileInput>(EMPTY_DRAFT);
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<RemoteReadinessReport | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  /** Whether the user took over the name field from the host-derived default. */
  const nameTouched = useRef(false);

  const reload = useCallback(async () => {
    setProfiles(await profilesPort.list());
  }, [profilesPort]);

  useEffect(() => {
    void reload().catch((error) => setNotice({ ok: false, text: String(error) }));
    void profilesPort
      .sshConfigHosts()
      .then(setConfigHosts)
      .catch(() => setConfigHosts([]));
  }, [profilesPort, reload]);

  const host = draft.sshHost.trim();
  const effectiveName = draft.name.trim() || (host ? nameFromHost(host) : "");
  // A host alone is checkable now. The workspace is a per-conversation choice made in
  // the project picker, so requiring one here would block setting up a machine before
  // knowing which of its projects you want.
  const browseDirectory = draft.remoteCwd?.trim() ?? "";
  const canCheck = Boolean(host);
  /** The report must belong to the current draft, or Save would persist untested values. */
  const reportMatchesDraft =
    report !== null && report.host === host && report.remoteCwd === browseDirectory;
  const canSave = canCheck && Boolean(effectiveName) && reportMatchesDraft && report.ok;
  const editingProfile = draft.id
    ? profiles.find((profile) => profile.id === draft.id)
    : undefined;

  const update = (field: keyof RemotePiProfileInput, value: string) => {
    if (field === "name") nameTouched.current = value.trim().length > 0;
    setDraft((current) => ({ ...current, [field]: value }));
    setNotice(null);
  };

  const pickHost = (value: string) => {
    setDraft((current) => ({
      ...current,
      sshHost: value,
      // Keep the name in step with the host until the user takes it over.
      name: nameTouched.current ? current.name : "",
    }));
    setNotice(null);
  };

  const resetDraft = () => {
    nameTouched.current = false;
    setDraft(EMPTY_DRAFT);
    setReport(null);
    setNotice(null);
    setAdvanced(false);
  };

  const edit = (profile: RemotePiProfile) => {
    nameTouched.current = true;
    setDraft({
      id: profile.id,
      name: profile.name,
      sshHost: profile.sshHost,
      remoteCwd: profile.remoteCwd,
      piExecutable: profile.piExecutable ?? undefined,
      launcherPath: profile.launcherPath,
      lifecycle: profile.lifecycle,
    });
    setReport(null);
    setNotice(null);
  };

  const runCheck = async (input: RemotePiProfileInput = draft) => {
    setBusy("check");
    setNotice(null);
    try {
      const next = await profilesPort.checkDraft({ ...input, name: effectiveName || "unnamed" });
      setReport(next);
      // A check is the cheapest place to learn the remote `$HOME`: it already paid for
      // the round trip, and the folder browser needs somewhere to open.
      if (input.id) rememberRemoteHome(input.id, next.home);
      setNotice({
        ok: next.ok,
        text: next.ok
          ? t("settings.remoteAgent.ready", { host: next.host })
          : t("settings.remoteAgent.notReady", { host: next.host }),
      });
      return next;
    } catch (error) {
      setReport(null);
      setNotice({ ok: false, text: String(error) });
      return null;
    } finally {
      setBusy(null);
    }
  };

  const installLauncher = async () => {
    setBusy("install");
    setNotice(null);
    try {
      const result = await profilesPort.installLauncher(host, draft.launcherPath);
      // The installer resolves `$HOME`; store the path it actually wrote.
      const next = { ...draft, launcherPath: result.launcherPath };
      setDraft(next);
      setNotice({
        ok: true,
        text: t("settings.remoteAgent.installed", { path: result.launcherPath }),
      });
      setBusy(null);
      await runCheck(next);
    } catch (error) {
      setNotice({
        ok: false,
        text: t("settings.remoteAgent.installFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      });
      setBusy(null);
    }
  };

  const save = async () => {
    setBusy("save");
    setNotice(null);
    try {
      const saved = await profilesPort.save({ ...draft, name: effectiveName });
      await reload();
      resetDraft();
      setNotice({ ok: true, text: t("settings.remoteAgent.saved", { name: saved.name }) });
    } catch (error) {
      setNotice({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (profile: RemotePiProfile) => {
    if (!window.confirm(t("settings.remoteAgent.deleteConfirm", { name: profile.name }))) return;
    setBusy(`delete:${profile.id}`);
    setNotice(null);
    try {
      await profilesPort.delete(profile.id);
      if (draft.id === profile.id) resetDraft();
      await reload();
    } catch (error) {
      setNotice({ ok: false, text: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      setNotice({ ok: true, text: t("settings.remoteAgent.commandCopied") });
    } catch {
      /* clipboard unavailable — the command stays visible and selectable */
    }
  };

  const rows = useMemo(() => {
    const byId = new Map(report?.checks.map((check) => [check.id, check]) ?? []);
    return CHECK_IDS.map<[RemoteReadinessCheckId, RemoteReadinessCheck | undefined]>((id) => [
      id,
      byId.get(id),
    ]);
  }, [report]);

  return (
    <>
      <InsetGroup
        header={t("settings.remoteAgent.profiles")}
        footer={t("settings.remoteAgent.profilesFooter")}
      >
        {profiles.length === 0 ? (
          <GroupRow
            first
            icon={<Server size={16} />}
            iconBg="var(--bg-secondary)"
            title={t("settings.remoteAgent.empty")}
            detail={t("settings.remoteAgent.emptyDetail")}
          />
        ) : profiles.map((profile, index) => (
          <GroupRow
            key={profile.id}
            first={index === 0}
            icon={<Server size={16} />}
            iconBg="var(--accent-soft)"
            title={profile.name}
            detail={(
              // The host, and the launcher it runs. A path here would suggest the
              // profile owns one project; it describes a machine, and projects are
              // chosen per conversation.
              <span
                title={`${profile.sshHost} · ${profile.launcherPath}`}
                style={{
                  display: "block",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {profile.sshHost}
              </span>
            )}
            trailing={(
              <div style={{ display: "flex", gap: 6 }}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("settings.remoteAgent.edit", { name: profile.name })}
                  title={t("settings.remoteAgent.edit", { name: profile.name })}
                  disabled={busy !== null}
                  onClick={() => edit(profile)}
                >
                  <Pencil size={15} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("settings.remoteAgent.delete", { name: profile.name })}
                  title={t("settings.remoteAgent.delete", { name: profile.name })}
                  disabled={busy !== null}
                  onClick={() => void remove(profile)}
                >
                  {busy === `delete:${profile.id}`
                    ? <LoaderCircle size={15} className="animate-spin" />
                    : <Trash2 size={15} />}
                </Button>
              </div>
            )}
          />
        ))}
      </InsetGroup>

      <InsetGroup
        header={draft.id
          ? t("settings.remoteAgent.editProfile")
          : t("settings.remoteAgent.addProfile")}
      >
        <div style={{ display: "grid", gap: 12, padding: 16 }}>
          <HostField value={draft.sshHost} options={configHosts} onChange={pickHost} />
          <Field
            label={t("settings.remoteAgent.name")}
            value={draft.name}
            placeholder={host ? nameFromHost(host) : t("settings.remoteAgent.namePlaceholder")}
            onChange={(value) => update("name", value)}
          />
          <LifecycleField
            value={draft.lifecycle ?? "attached"}
            editing={Boolean(draft.id)}
            onChange={(value) => update("lifecycle", value)}
          />
          <Disclosure
            open={advanced}
            label={t("settings.remoteAgent.advanced")}
            onToggle={() => setAdvanced((value) => !value)}
          >
            <Field
              label={t("settings.remoteAgent.launcherPath")}
              hint={t("settings.remoteAgent.launcherPathHint")}
              value={draft.launcherPath ?? ""}
              placeholder={t("settings.remoteAgent.launcherPathAuto")}
              onChange={(value) => update("launcherPath", value)}
            />
            <Field
              label={t("settings.remoteAgent.piExecutable")}
              hint={t("settings.remoteAgent.piExecutableHint")}
              value={draft.piExecutable ?? ""}
              placeholder="pi"
              onChange={(value) => update("piExecutable", value)}
            />
            {/* Demoted from a required top-level field to an optional hint. It is only
                where the folder browser opens; the workspace pi actually runs in is
                chosen per conversation in the project picker. Empty falls back to the
                remote `$HOME` that preflight reports. */}
            <Field
              label={t("settings.remoteAgent.browseDirectory")}
              hint={t("settings.remoteAgent.browseDirectoryHint")}
              value={draft.remoteCwd ?? ""}
              placeholder={report?.home ?? t("settings.remoteAgent.browseDirectoryAuto")}
              onChange={(value) => update("remoteCwd", value)}
            />
          </Disclosure>

          <div style={{ display: "grid", gap: 2, marginTop: 2 }}>
            {rows.map(([id, check]) => (
              <CheckRow
                key={id}
                id={id}
                check={check}
                host={host}
                busy={busy}
                onInstall={() => void installLauncher()}
                onCopyCommand={(command) => void copyCommand(command)}
              />
            ))}
          </div>

          {editingProfile && (
            <Callout icon={<AlertTriangle size={15} />} tone="var(--warning)">
              {t("settings.remoteAgent.editRevisionWarning")}
            </Callout>
          )}

          {notice && (
            <Callout
              icon={notice.ok ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
              tone={notice.ok ? "var(--success)" : "var(--danger)"}
            >
              {notice.text}
            </Callout>
          )}

          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            {(draft.id || host) && (
              <Button variant="ghost" size="sm" onClick={resetDraft} disabled={busy !== null}>
                {t("common.cancel")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runCheck()}
              disabled={!canCheck || busy !== null}
            >
              {busy === "check" && <LoaderCircle size={15} className="animate-spin" />}
              {report ? t("settings.remoteAgent.recheck") : t("settings.remoteAgent.check")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={!canSave || busy !== null}
              title={canSave ? undefined : t("settings.remoteAgent.checkFirst")}
            >
              {busy === "save" && <LoaderCircle size={15} className="animate-spin" />}
              {t("settings.remoteAgent.saveAndUse")}
            </Button>
          </div>
        </div>
      </InsetGroup>

      <ProviderSyncSettings profiles={profiles} />
    </>
  );
}

/** One checklist row: status, label, detail, and the fix for a failure. */
function CheckRow({
  id,
  check,
  host,
  busy,
  onInstall,
  onCopyCommand,
}: {
  id: RemoteReadinessCheckId;
  check: RemoteReadinessCheck | undefined;
  host: string;
  busy: string | null;
  onInstall: () => void;
  onCopyCommand: (command: string) => void;
}) {
  const status = check?.status ?? "pending";
  const failed = status === "failed";
  const warning = status === "warning";
  const tone = failed
    ? "var(--danger)"
    : warning
      ? "var(--warning)"
      : status === "ok"
        ? "var(--success)"
        : "var(--text-tertiary)";
  const icon = failed ? (
    <XCircle size={14} />
  ) : warning ? (
    <AlertTriangle size={14} />
  ) : status === "ok" ? (
    <Check size={14} />
  ) : (
    <Circle size={14} />
  );
  const code = check?.errorCode;
  const command = code && host ? diagnosticCommand(code, host) : undefined;
  const detail = status === "skipped"
    ? t("settings.remoteAgent.check.skipped")
    : status === "pending"
      ? t("settings.remoteAgent.check.pending")
      : check?.detail ?? check?.error;

  return (
    <div style={{ display: "grid", gap: 4, padding: "5px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ display: "grid", placeItems: "center", color: tone, flexShrink: 0 }}>
          {icon}
        </span>
        <span style={{ fontSize: 13, color: "var(--text-primary)", flexShrink: 0 }}>
          {t(`settings.remoteAgent.check.${id}`)}
        </span>
        {detail && (
          <span
            title={detail}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 11.5,
              color: failed || warning ? tone : "var(--text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {detail}
          </span>
        )}
        {code && INSTALLABLE.has(code) && (
          <Button
            variant="outline"
            size="sm"
            style={{ flexShrink: 0, height: 26 }}
            disabled={busy !== null || !host}
            onClick={onInstall}
          >
            {busy === "install"
              ? <LoaderCircle size={13} className="animate-spin" />
              : <Download size={13} />}
            {code === "launcher_missing"
              ? t("settings.remoteAgent.install")
              : t("settings.remoteAgent.reinstall")}
          </Button>
        )}
      </div>
      {code && (failed || warning) && HAS_FIX_TEXT.has(code) && (
        <div style={{ paddingLeft: 22, display: "grid", gap: 5 }}>
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.5 }}>
            {t(`settings.remoteAgent.fix.${code}`)}
          </span>
          {command && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: "4px 8px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--text-primary)",
                  background: "var(--bg-sunken)",
                  border: "1px solid var(--separator)",
                  borderRadius: 6,
                  overflowX: "auto",
                  whiteSpace: "nowrap",
                }}
              >
                {command}
              </code>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("settings.remoteAgent.copyCommand")}
                title={t("settings.remoteAgent.copyCommand")}
                onClick={() => onCopyCommand(command)}
              >
                <Copy size={14} />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Host picker over the `~/.ssh/config` aliases.
 *
 * Autocomplete rather than Select: the field must still accept a host that is
 * not in the config at all (`user@host`, or any host on a machine with no
 * config file), and a Select would make those unreachable. Root's `value` is the
 * input string, so free text is the normal path and the list is a shortcut.
 *
 * With no aliases to offer there is nothing to drop down, so it degrades to a
 * plain Input rather than a chevron that opens an empty popup.
 */
function HostField({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  const hint = options.length > 0
    ? `${t("settings.remoteAgent.sshAliasHint")} ${t("settings.remoteAgent.sshAliasFromConfig")}.`
    : t("settings.remoteAgent.sshAliasHint");

  return (
    <FieldShell label={t("settings.remoteAgent.sshAlias")} hint={hint}>
      {options.length === 0 ? (
        <Input
          inputSize="md"
          value={value}
          placeholder={t("settings.remoteAgent.sshAliasPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Autocomplete
          items={options}
          value={value}
          onValueChange={onChange}
          size="md"
          icon
          openOnInputClick
        >
          <AutocompleteInput
            placeholder={t("settings.remoteAgent.sshAliasPlaceholder")}
            autoComplete="off"
            spellCheck={false}
          />
          <AutocompleteContent>
            {/* Typing a host that is not an alias is expected, not an error. */}
            <AutocompleteEmpty>
              {t("settings.remoteAgent.sshAliasNotInConfig")}
            </AutocompleteEmpty>
            <AutocompleteList>
              {(item: string) => (
                <AutocompleteItem key={item} value={item}>
                  {item}
                </AutocompleteItem>
              )}
            </AutocompleteList>
          </AutocompleteContent>
        </Autocomplete>
      )}
    </FieldShell>
  );
}

/** Label + control + hint, so every row in the form lines up identically. */
function FieldShell({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <span style={{ color: "var(--text-secondary)", fontSize: 12, fontWeight: 600 }}>{label}</span>
      {children}
      {hint && (
        <span style={{ fontSize: 11.5, color: "var(--text-tertiary)" }}>{hint}</span>
      )}
    </div>
  );
}

/**
 * Attached or detached, as two labelled choices rather than a switch.
 *
 * A switch would need a name for the *off* state, and there isn't a good one — these are
 * two different execution models, not a feature being enabled. The consequence that
 * matters is in the description: detached work survives losing the connection, which is
 * also why closing the app stops being the way to stop it.
 */
function LifecycleField({
  value,
  editing,
  onChange,
}: {
  value: "attached" | "detached";
  editing: boolean;
  onChange: (value: "attached" | "detached") => void;
}) {
  return (
    <FieldShell
      label={t("settings.remoteAgent.lifecycle")}
      hint={
        editing
          ? // Bindings are persisted per conversation, so changing this cannot retroactively
            // move work that is already running. Saying so is better than silently
            // surprising someone who expected their open conversation to change.
            t("settings.remoteAgent.lifecycleExistingHint")
          : t(`settings.remoteAgent.lifecycle.${value}Hint`)
      }
    >
      <div style={{ display: "flex", gap: 8 }}>
        {(["attached", "detached"] as const).map((option) => {
          const active = value === option;
          return (
            <button
              key={option}
              onClick={() => onChange(option)}
              style={{
                flex: 1,
                display: "grid",
                gap: 2,
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: 8,
                border: `1px solid ${active ? "var(--accent)" : "var(--separator)"}`,
                background: active ? "var(--accent-muted)" : "transparent",
                cursor: "pointer",
                fontFamily: "var(--font-ui)",
              }}
            >
              <span style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                {t(`settings.remoteAgent.lifecycle.${option}`)}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                {t(`settings.remoteAgent.lifecycle.${option}Short`)}
              </span>
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

function Field({
  label,
  hint,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <FieldShell label={label} hint={hint}>
      <Input
        inputSize="md"
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </FieldShell>
  );
}

function Disclosure({
  open,
  label,
  onToggle,
  children,
}: {
  open: boolean;
  label: string;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-secondary)",
          font: "inherit",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
          justifySelf: "start",
        }}
      >
        <ChevronDown
          size={13}
          style={{ transform: open ? undefined : "rotate(-90deg)", transition: "transform 120ms" }}
        />
        {label}
      </button>
      {open && children}
    </div>
  );
}

function Callout({
  icon,
  tone,
  children,
}: {
  icon: React.ReactNode;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        color: tone,
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      <span style={{ flexShrink: 0, marginTop: 1 }}>{icon}</span>
      <span>{children}</span>
    </div>
  );
}
