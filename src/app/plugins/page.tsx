"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@appica/ui-react/button";
import { usePi } from "@/lib/pi/store";
import {
  usePiSettings,
  packageSource,
  type PackageEntry,
  type SettingsScope,
} from "@/lib/pi/settings";
import { useT } from "@/lib/i18n";
import { useWorkspace } from "@/lib/workspace";
import { cliError } from "@/lib/pi/cli-error";
import {
  normalizePackageSource,
  packageInstallRequest,
} from "@/lib/pi/package-install";
import {
  SettingsPage,
  InsetGroup,
  GroupRow,
  IOSSwitch,
  Segmented,
  StringListEditor,
} from "@/components/settings-ui";
import {
  Package,
  GitBranch,
  Layers,
  Command,
  RefreshCw,
  ChevronRight,
  Wand2,
  AlertTriangle,
  Download,
  CircleCheck,
  CircleX,
} from "lucide-react";

/** string-array resource keys of settings.json shown in "Local resources" */
const RESOURCE_KEYS = ["skills", "extensions", "prompts", "themes"] as const;

const EXT_COLORS = ["#6E56CF", "#C15F3C", "#10A37F", "#4285F4", "#E5484D"];

/** "npm:@scope/name@1.2.3" → { kind, name, version } for display */
function parseSource(src: string): { kind: string; name: string; version?: string } {
  if (src.startsWith("npm:")) {
    const spec = src.slice(4);
    const at = spec.lastIndexOf("@");
    if (at > 0) return { kind: "npm", name: spec.slice(0, at), version: spec.slice(at + 1) };
    return { kind: "npm", name: spec };
  }
  if (src.startsWith("git:") || src.startsWith("https://") || src.startsWith("ssh://")) {
    const spec = src.replace(/^git:/, "");
    const at = spec.lastIndexOf("@");
    const hasRef = at > spec.indexOf("/"); // don't split git@host
    if (hasRef) return { kind: "git", name: spec.slice(0, at), version: spec.slice(at + 1) };
    return { kind: "git", name: spec };
  }
  return { kind: "local", name: src };
}

export default function PluginsPage() {
  const { commands, mock, refresh } = usePi();
  const settings = usePiSettings();
  const [removing, setRemoving] = useState<string | null>(null);
  const [installSource, setInstallSource] = useState("");
  const [installScope, setInstallScope] = useState<SettingsScope>("global");
  const [installing, setInstalling] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [resScope, setResScope] = useState<SettingsScope>("global");
  const root = useWorkspace((state) => state.root);
  const activeInstallScope: SettingsScope = root ? installScope : "global";
  const t = useT();

  useEffect(() => {
    settings.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // status banners describe a pending restart — once pi restarted (via any
  // entry point), the "installed/removed" message is no longer actionable
  useEffect(() => {
    if (!settings.dirtyRestart) setStatus(null);
  }, [settings.dirtyRestart]);

  const globalPkgs = (settings.global.data?.packages ?? []) as PackageEntry[];
  const projectPkgs = (settings.project.data?.packages ?? []) as PackageEntry[];

  const extCommands = commands.filter((c) => c.source?.startsWith("extension:"));
  const builtins = commands.filter((c) => !c.source?.startsWith("extension:"));

  const installPackage = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const source = normalizePackageSource(installSource);
    const currentRoot = useWorkspace.getState().root;
    const requestedScope: SettingsScope = currentRoot ? installScope : "global";
    const request = source
      ? packageInstallRequest(source, requestedScope, currentRoot)
      : null;
    if (!source || !request) {
      setStatus({ ok: false, text: t("plugins.installSourceInvalid") });
      return;
    }

    setInstalling(true);
    setStatus(null);
    usePiSettings.setState({ lastError: null });
    try {
      const result = await settings.runPiCli(request.args, request.cwd);
      if (result.code !== 0) {
        setStatus({
          ok: false,
          text: t("plugins.installFailed", {
            code: result.code,
            err: cliError(result, t("plugins.noErrorDetail")),
          }),
        });
        return;
      }

      usePiSettings.setState({ dirtyRestart: true });
      await settings.load();
      void refresh();
      setInstallSource("");
      setStatus({
        ok: true,
        text: t("plugins.installed", { source }),
      });
    } catch (error) {
      setStatus({
        ok: false,
        text: t("plugins.installUnexpected", {
          err: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setInstalling(false);
    }
  };

  const remove = async (scope: "global" | "project", entry: PackageEntry) => {
    const src = packageSource(entry);
    const currentRoot = useWorkspace.getState().root;
    if (scope === "project" && !currentRoot) {
      usePiSettings.setState({ lastError: t("plugins.removeNoProject") });
      return;
    }

    setRemoving(src);
    setStatus(null);
    usePiSettings.setState({ lastError: null });
    try {
      // `pi remove` edits settings.json and cleans up ~/.pi/agent/npm|git
      const result = await settings.runPiCli(
        scope === "project" ? ["remove", src, "-l"] : ["remove", src],
        currentRoot
      );
      if (result.code !== 0) {
        usePiSettings.setState({
          lastError: t("plugins.removeFailed", {
            code: result.code,
            err: cliError(result, t("plugins.noErrorDetail")),
          }),
        });
        return;
      }
      usePiSettings.setState({ dirtyRestart: true });
      await settings.load();
      void refresh();
      setStatus({ ok: true, text: t("plugins.removed", { source: src }) });
    } catch (error) {
      usePiSettings.setState({
        lastError: t("plugins.removeUnexpected", {
          err: error instanceof Error ? error.message : String(error),
        }),
      });
    } finally {
      setRemoving(null);
    }
  };

  const renderPkgRows = (scope: "global" | "project", pkgs: PackageEntry[]) =>
    pkgs.map((entry, i) => {
      const src = packageSource(entry);
      const { kind, name, version } = parseSource(src);
      const filtered = typeof entry !== "string";
      return (
        <GroupRow
          key={src}
          first={i === 0}
          icon={kind === "npm" ? <Package size={16} /> : kind === "git" ? <GitBranch size={16} /> : <Layers size={16} />}
          iconBg={EXT_COLORS[i % EXT_COLORS.length]}
          title={name}
          detail={[
            kind,
            version && t("plugins.pinned", { version }),
            filtered && t("plugins.filteredResources"),
          ]
            .filter(Boolean)
            .join(" · ")}
          trailing={
            <Button
              variant="outline"
              size="sm"
              onClick={() => remove(scope, entry)}
              disabled={installing || settings.busy || removing !== null}
              style={{ color: "var(--danger)", borderRadius: 8 }}
            >
              {removing === src ? t("plugins.removing") : t("plugins.remove")}
            </Button>
          }
        />
      );
    });

  return (
    <SettingsPage
      title={t("plugins.title")}
      subtitle={mock ? t("plugins.subtitleMock") : t("plugins.subtitleLive")}
    >
      <InsetGroup
        header={t("plugins.installHeader")}
        footer={
          !root
            ? t("plugins.installFooterNoProject")
            : activeInstallScope === "global"
              ? t("plugins.installFooterGlobal")
              : t("plugins.installFooterProject")
        }
      >
        <form
          onSubmit={installPackage}
          style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}
        >
          <Segmented
            options={["global", "project"] as const}
            value={activeInstallScope}
            onChange={setInstallScope}
            disabled={!root || installing || settings.busy || removing !== null}
            labelOf={(scope) => t(`plugins.scope.${scope}`)}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              id="plugin-package-source"
              name="packageSource"
              value={installSource}
              onChange={(event) => setInstallSource(event.target.value)}
              aria-label={t("plugins.installSourceLabel")}
              placeholder={t("plugins.installPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={installing || settings.busy || removing !== null}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "8px 12px",
                fontSize: 13.5,
                borderRadius: 9,
                border: "1px solid var(--separator)",
                background: "var(--bg-sunken)",
                color: "var(--text-primary)",
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={
                installing ||
                settings.busy ||
                removing !== null ||
                !installSource.trim()
              }
              style={{ borderRadius: 8, flexShrink: 0, minWidth: 92 }}
            >
              <Download size={14} aria-hidden />
              {installing ? t("plugins.installing") : t("plugins.install")}
            </Button>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 7,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--text-tertiary)",
            }}
          >
            <AlertTriangle
              size={14}
              aria-hidden
              style={{ flexShrink: 0, marginTop: 2, color: "var(--warning)" }}
            />
            <span>{t("plugins.installSecurity")}</span>
          </div>
        </form>
      </InsetGroup>

      {status && (
        <div
          role={status.ok ? "status" : "alert"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 14,
            padding: "10px 14px",
            fontSize: 12.5,
            lineHeight: 1.5,
            borderRadius: "var(--radius-md)",
            border: `1px solid color-mix(in srgb, ${
              status.ok ? "var(--success)" : "var(--danger)"
            } 35%, transparent)`,
            background: `color-mix(in srgb, ${
              status.ok ? "var(--success)" : "var(--danger)"
            } 8%, transparent)`,
            color: "var(--text-primary)",
          }}
        >
          {status.ok ? (
            <CircleCheck size={15} aria-hidden style={{ flexShrink: 0, color: "var(--success)" }} />
          ) : (
            <CircleX size={15} aria-hidden style={{ flexShrink: 0, color: "var(--danger)" }} />
          )}
          <span style={{ flex: 1, minWidth: 0 }}>{status.text}</span>
        </div>
      )}
      <InsetGroup
        header={t("plugins.globalHeader")}
        footer={t("plugins.globalFooter")}
      >
        {globalPkgs.length === 0 ? (
          <GroupRow first title={t("plugins.noPackages")} detail={t("plugins.browseStore")} />
        ) : (
          renderPkgRows("global", globalPkgs)
        )}
      </InsetGroup>

      {projectPkgs.length > 0 && (
        <InsetGroup
          header={t("plugins.projectHeader")}
          footer={t("plugins.projectFooter")}
        >
          {renderPkgRows("project", projectPkgs)}
        </InsetGroup>
      )}

      <InsetGroup
        header={t("plugins.liveCommands")}
        footer={t("plugins.liveCommandsFooter")}
      >
        {extCommands.length === 0 ? (
          <GroupRow
            first
            title={t("plugins.noExtCommands")}
            detail={t("plugins.extLoadPath")}
          />
        ) : (
          extCommands.map((c, i) => (
            <GroupRow
              key={c.name}
              first={i === 0}
              icon={<Command size={16} />}
              iconBg={EXT_COLORS[i % EXT_COLORS.length]}
              title={`/${c.name}`}
              detail={`${c.description ?? ""}${c.source ? ` · ${c.source.replace("extension:", "")}` : ""}`}
            />
          ))
        )}
      </InsetGroup>

      {builtins.length > 0 && (
        <InsetGroup header={t("plugins.builtins")}>
          {builtins.map((c, i) => (
            <GroupRow
              key={c.name}
              first={i === 0}
              icon={<ChevronRight size={16} />}
              iconBg="var(--gray-1)"
              title={`/${c.name}`}
              detail={c.description}
            />
          ))}
        </InsetGroup>
      )}

      {/* local resource paths + skill commands — settings.json resource keys */}
      <InsetGroup
        header={t("plugins.localResources")}
        footer={t("plugins.localResourcesFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["global", "project"] as const}
            value={resScope}
            onChange={setResScope}
          />
        </div>
        {RESOURCE_KEYS.map((key) => (
          <div key={key} style={{ borderTop: "1px solid var(--separator)" }}>
            <div
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                padding: "10px 16px 0",
              }}
            >
              {t(`plugins.res.${key}`)}
            </div>
            <StringListEditor
              items={settings[resScope].data?.[key] as string[] | undefined}
              onChange={(items) => settings.setKey(resScope, key, items)}
              addPlaceholder={t("plugins.addPath")}
            />
          </div>
        ))}
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
          title={t("plugins.refresh")}
          detail={t("plugins.refreshDetail")}
          onClick={() => {
            settings.load();
            refresh();
          }}
        />
      </InsetGroup>

      {settings.lastError && (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--danger, #E5484D)" }}>
          {settings.lastError}
        </p>
      )}
    </SettingsPage>
  );
}
