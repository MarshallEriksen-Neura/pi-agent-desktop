"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@appica/ui-react/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appica/ui-react/dropdown-menu";
import { AlertTriangle, Check, ChevronDown, HardDrive, LoaderCircle, Server } from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import type { ExecutionBinding, RemotePiProfile } from "@/lib/backend/ports/execution-target";
import { t } from "@/lib/i18n";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useSessions } from "@/lib/pi/sessions";
import { usePi } from "@/lib/pi/store";
import { useWorkspace } from "@/lib/workspace";

const LOCAL_BINDING: ExecutionBinding = { kind: "local", targetId: "local" };

export function ExecutionTargetPicker() {
  const profilesPort = getPort("remoteProfiles");
  const [profiles, setProfiles] = useState<RemotePiProfile[]>([]);
  const [switching, setSwitching] = useState(false);
  const binding = useSessions((state) => state.executionBinding);
  const switchTarget = useSessions((state) => state.switchExecutionTarget);
  const workspaceRoot = useWorkspace((state) => state.root) ?? "";
  const status = usePi((state) => state.status);

  const reload = useCallback(async () => {
    setProfiles(await profilesPort.list());
    setProfilesLoaded(true);
  }, [profilesPort]);

  useEffect(() => {
    void reload().catch(() => undefined);
  }, [reload]);

  // The profile the current binding points at. Absent once the profile is
  // deleted out from under a live conversation, which the row reports rather
  // than silently falling back to a stale label.
  const currentProfile =
    binding.kind === "ssh"
      ? profiles.find((profile) => profile.id === binding.profileId)
      : undefined;

  // Until the first list() resolves, "deleted" and "not loaded yet" look the
  // same, and warning on the latter puts a triangle on every cold start.
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const profileMissing =
    binding.kind === "ssh" && profilesLoaded && currentProfile === undefined;
  const revisionMismatch = binding.kind === "ssh"
    && currentProfile !== undefined
    && currentProfile.revision !== binding.profileRevision;
  const label = binding.kind === "ssh"
    ? currentProfile?.name ?? binding.hostAlias
    : t("remoteAgent.target.local");
  const unknown = binding.kind === "ssh" && status === "disconnected";
  const needsAttention = unknown || profileMissing || revisionMismatch;
  const targetTitle = profileMissing
    ? t("remoteAgent.target.profileMissing")
    : revisionMismatch
      ? t("remoteAgent.target.profileChanged")
      : unknown
        ? t("remoteAgent.target.statusUnknown")
        : t("remoteAgent.target.select");

  const selectLocal = async () => {
    if (binding.kind === "local" || switching) return;
    setSwitching(true);
    try {
      await switchTarget(LOCAL_BINDING, workspaceRoot);
    } catch (error) {
      useExtUi.getState().pushToast(String(error), "error", 7000);
    } finally {
      setSwitching(false);
    }
  };

  const selectRemote = async (profile: RemotePiProfile) => {
    if (switching) return;
    setSwitching(true);
    useExtUi.getState().pushToast(t("remoteAgent.target.connecting"), "info", 2500);
    try {
      const preflight = await profilesPort.preflight(profile.id);
      if (!preflight.ok) {
        // Report the first failed row: it is the one that caused the cascade,
        // and its fix is spelled out on the settings page.
        const failed = preflight.checks.find((check) => check.status === "failed");
        throw new Error(
          failed
            ? `${t(`settings.remoteAgent.check.${failed.id}`)} — ${failed.error ?? failed.errorCode ?? ""}`.trim()
            : t("remoteAgent.target.notReady", { host: preflight.host }),
        );
      }
      await switchTarget({
        kind: "ssh",
        profileId: profile.id,
        profileRevision: profile.revision,
        hostAlias: profile.sshHost,
        remoteCwd: profile.remoteCwd,
        launcherProtocolVersion: profile.launcherProtocolVersion,
      }, workspaceRoot);
    } catch (error) {
      useExtUi.getState().pushToast(
        t("remoteAgent.target.unavailable", { error: error instanceof Error ? error.message : String(error) }),
        "error",
        8000,
      );
    } finally {
      setSwitching(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("remoteAgent.target.select")}
            title={targetTitle}
            disabled={switching}
            style={{
              minWidth: 0,
              maxWidth: 148,
              height: 30,
              paddingInline: 8,
              color: needsAttention ? "var(--warning)" : binding.kind === "ssh" ? "var(--accent)" : "var(--text-secondary)",
            }}
          />
        )}
      >
        {switching ? (
          <LoaderCircle size={14} className="animate-spin" />
        ) : profileMissing || revisionMismatch ? (
          <AlertTriangle size={14} />
        ) : binding.kind === "ssh" ? (
          <Server size={14} />
        ) : (
          <HardDrive size={14} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        <ChevronDown size={12} style={{ flexShrink: 0, opacity: 0.65 }} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" style={{ minWidth: 220 }}>
        <DropdownMenuGroup>
          <DropdownMenuGroupLabel>{t("remoteAgent.target.select")}</DropdownMenuGroupLabel>
          <DropdownMenuItem onClick={() => void selectLocal()}>
            <HardDrive size={14} />
            <span style={{ flex: 1 }}>{t("remoteAgent.target.local")}</span>
            {binding.kind === "local" && <Check size={14} />}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {profiles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>{t("settings.remoteAgent.profiles")}</DropdownMenuGroupLabel>
              {profiles.map((profile) => {
                const active = binding.kind === "ssh"
                  && binding.profileId === profile.id
                  && binding.profileRevision === profile.revision;
                return (
                  <DropdownMenuItem key={profile.id} onClick={() => void selectRemote(profile)}>
                    <Server size={14} />
                    <span style={{ display: "grid", flex: 1, minWidth: 0 }}>
                      <span>{profile.name}</span>
                      <span
                        style={{
                          color: "var(--text-tertiary)",
                          fontSize: 11,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {profile.sshHost} · {profile.remoteCwd}
                      </span>
                    </span>
                    {active && <Check size={14} />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
