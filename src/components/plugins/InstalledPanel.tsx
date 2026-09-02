"use client";

/**
 * Installed — the maintenance half of the plugins page.
 *
 * One list for both scopes. The old page had a "global" group and a "project"
 * group rendered by the same row builder, which meant a package declared in
 * both scopes showed up as two rows in two places connected only by a sentence
 * of small print. Here the scope is a fact on the row, the two entries sit next
 * to each other, and the duplicate warning has somewhere to point.
 */

import { useState } from "react";
import { Button } from "@appica/ui-react/button";
import { Command, Copy, RefreshCw, Terminal, Trash2, Wand2 } from "lucide-react";
import { usePi } from "@/lib/pi/store";
import { usePiSettings, type SettingsScope } from "@/lib/pi/settings";
import type { InstalledPackage, PackageManager } from "@/lib/pi/package-manager";
import { useT } from "@/lib/i18n";
import {
  InsetGroup,
  GroupRow,
  IOSSwitch,
  Segmented,
  StringListEditor,
} from "@/components/settings-ui";
import { PackageRow } from "./PackageRow";
import { RowMenu } from "./RowMenu";
import { DisclosureGroup } from "./DisclosureGroup";

/** string-array resource keys of settings.json shown under "local resources" */
const RESOURCE_KEYS = ["skills", "extensions", "prompts", "themes"] as const;

/** trailing text that reports state rather than offering an action */
const stateStyle: React.CSSProperties = {
  padding: "0 6px",
  fontSize: 11.5,
  color: "var(--text-tertiary)",
};

export function InstalledPanel({
  pm,
  onBrowse,
}: {
  pm: PackageManager;
  /** hand the user to Discover — the empty state's only useful next step */
  onBrowse: () => void;
}) {
  const { commands } = usePi();
  const settings = usePiSettings();
  const t = useT();
  const [resScope, setResScope] = useState<SettingsScope>("global");

  const extCommands = commands.filter((c) => c.source?.startsWith("extension:"));
  const builtins = commands.filter((c) => !c.source?.startsWith("extension:"));

  const copySource = async (pkg: InstalledPackage) => {
    try {
      await navigator.clipboard.writeText(pkg.source);
      pm.notify(true, t("plugins.copiedSource", { source: pkg.source }));
    } catch {
      pm.notify(false, t("plugins.copyFailed"));
    }
  };

  const metaOf = (pkg: InstalledPackage) => {
    const { info } = pkg;
    const pinned =
      info.updateMode === "npm-pinned" && info.version
        ? t("plugins.pinned", { version: info.version })
        : info.updateMode === "git-pinned" && info.ref
          ? t("plugins.pinned", { version: info.ref })
          : null;
    // The version on disk is the one that proves an update landed — the source
    // string only carries a version when it was pinned or range-tagged, and it
    // does not move when `pi update` does its job.
    const version =
      pinned ??
      (pkg.outdated && pkg.installedVersion && pkg.latestVersion
        ? t("plugins.versionUpgrade", {
            current: pkg.installedVersion,
            latest: pkg.latestVersion,
          })
        : (pkg.installedVersion ??
          (info.kind === "npm" && info.version ? info.version : null)));
    return [
      t(`plugins.scope.${pkg.scope}`),
      version,
      info.updateMode === "local" && t("plugins.localPackage"),
      pkg.duplicate && t("plugins.duplicateIdentity"),
      pkg.filtered && t("plugins.filteredResources"),
    ]
      .filter(Boolean)
      .join(" · ");
  };

  return (
    <>
      <InsetGroup
        header={t("plugins.packagesHeader")}
        footer={t("plugins.packagesFooter")}
        action={
          pm.hasPackages && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void pm.updateAll()}
              disabled={pm.busy}
              style={{ color: "var(--accent)", borderRadius: 8 }}
            >
              <RefreshCw size={13} aria-hidden />
              {pm.updatingAll ? t("plugins.updating") : t("plugins.updateAll")}
            </Button>
          )
        }
      >
        {!pm.hasPackages ? (
          <GroupRow
            first
            title={t("plugins.noPackages")}
            detail={t("plugins.noPackagesDetail")}
            onClick={onBrowse}
          />
        ) : (
          pm.packages.map((pkg, i) => (
            <PackageRow
              key={`${pkg.scope}:${pkg.source}`}
              first={i === 0}
              kind={pkg.info.kind}
              name={pkg.info.name}
              meta={metaOf(pkg)}
              trailing={
                <div style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  {/* removal is started from a menu that closes on select, so the
                      row has to say what is happening to it on its own */}
                  {pm.removing === pkg.source ? (
                    <span style={stateStyle}>{t("plugins.removing")}</span>
                  ) : pkg.upToDate ? (
                    // nothing to offer, and saying so is the only way the list
                    // can distinguish a finished update from one never run
                    <span title={t("plugins.upToDateHint")} style={stateStyle}>
                      {t("plugins.upToDate")}
                    </span>
                  ) : pkg.updatable ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pm.requestUpdate(pkg)}
                      disabled={pm.busy}
                      style={{ color: "var(--accent)", borderRadius: 8 }}
                    >
                      {pm.updating === pkg.source
                        ? t("plugins.updating")
                        : pkg.info.updateMode === "git-pinned"
                          ? t("plugins.sync")
                          : t("plugins.update")}
                    </Button>
                  ) : (
                    <span title={t("plugins.updateUnavailable")} style={stateStyle}>
                      {pkg.info.updateMode === "local"
                        ? t("plugins.localStatus")
                        : t("plugins.pinnedStatus")}
                    </span>
                  )}
                  <RowMenu
                    label={t("plugins.rowMenu", { name: pkg.info.name })}
                    items={[
                      {
                        label: t("plugins.copySource"),
                        icon: <Copy size={13} />,
                        onSelect: () => void copySource(pkg),
                      },
                      {
                        label: t("plugins.remove"),
                        icon: <Trash2 size={13} />,
                        onSelect: () => void pm.remove(pkg),
                        disabled: pm.busy,
                        danger: true,
                      },
                    ]}
                  />
                </div>
              }
            />
          ))
        )}
      </InsetGroup>

      <DisclosureGroup
        header={t("plugins.liveCommands")}
        count={extCommands.length}
        footer={t("plugins.liveCommandsFooter")}
      >
        {extCommands.length === 0 ? (
          <GroupRow first title={t("plugins.noExtCommands")} detail={t("plugins.extLoadPath")} />
        ) : (
          extCommands.map((c, i) => (
            <GroupRow
              key={c.name}
              first={i === 0}
              icon={<Command size={15} />}
              iconBg="var(--accent)"
              title={`/${c.name}`}
              detail={[c.description, c.source?.replace("extension:", "")]
                .filter(Boolean)
                .join(" · ")}
            />
          ))
        )}
      </DisclosureGroup>

      {/* settings.json resource path arrays — loaded from disk, not from a package */}
      <DisclosureGroup
        header={t("plugins.localResources")}
        footer={t("plugins.localResourcesFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["global", "project"] as const}
            value={resScope}
            onChange={setResScope}
            labelOf={(scope) => t(`plugins.scope.${scope}`)}
          />
        </div>
        {RESOURCE_KEYS.map((key) => (
          <div key={key} style={{ borderTop: "1px solid var(--separator)" }}>
            <div
              style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "10px 16px 0" }}
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
                  (settings.effective().enableSkillCommands as boolean | undefined) !== false
                }
                onChange={(v) => settings.setKey(resScope, "enableSkillCommands", v)}
              />
            }
          />
        </div>
      </DisclosureGroup>

      {builtins.length > 0 && (
        <DisclosureGroup
          header={t("plugins.builtins")}
          count={builtins.length}
          footer={t("plugins.builtinsFooter")}
        >
          {builtins.map((c, i) => (
            <GroupRow
              key={c.name}
              first={i === 0}
              icon={<Terminal size={15} />}
              iconBg="var(--gray-1)"
              title={`/${c.name}`}
              detail={c.description}
            />
          ))}
        </DisclosureGroup>
      )}
    </>
  );
}
