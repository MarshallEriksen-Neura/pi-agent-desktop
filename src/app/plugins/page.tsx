"use client";

import { useEffect, useState } from "react";
import { Button } from "@appica/ui-react/button";
import { usePi } from "@/lib/pi/store";
import {
  usePiSettings,
  packageSource,
  type PackageEntry,
  type SettingsScope,
} from "@/lib/pi/settings";
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
  Package,
  GitBranch,
  Layers,
  Command,
  RefreshCw,
  RotateCcw,
  ChevronRight,
  Wand2,
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
  const [resScope, setResScope] = useState<SettingsScope>("global");
  const t = useT();

  useEffect(() => {
    settings.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const globalPkgs = (settings.global.data?.packages ?? []) as PackageEntry[];
  const projectPkgs = (settings.project.data?.packages ?? []) as PackageEntry[];

  const extCommands = commands.filter((c) => c.source?.startsWith("extension:"));
  const builtins = commands.filter((c) => !c.source?.startsWith("extension:"));

  const remove = async (scope: "global" | "project", entry: PackageEntry) => {
    const src = packageSource(entry);
    setRemoving(src);
    try {
      // `pi remove` edits settings.json and cleans up ~/.pi/agent/npm|git
      const r = await settings.runPiCli(
        scope === "project" ? ["remove", src, "-l"] : ["remove", src]
      );
      if (r.code !== 0) {
        usePiSettings.setState({
          lastError: t("plugins.removeFailed", {
            code: r.code,
            err: (r.stderr || r.stdout).trim(),
          }),
        });
      }
      await settings.load();
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
              disabled={removing === src}
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

      {settings.lastError && (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--danger, #E5484D)" }}>
          {settings.lastError}
        </p>
      )}
    </SettingsPage>
  );
}
