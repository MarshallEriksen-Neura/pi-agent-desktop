"use client";

/**
 * Discover — the growth half of the plugins page.
 *
 * pi's "gallery" is just npm: every package tagged with the `pi-package`
 * keyword, the same set https://pi.dev/packages renders. We query the registry
 * search API directly and install through the pi CLI, which writes the entry
 * into settings.json and downloads it under ~/.pi/agent/npm/.
 *
 * The install-target control at the top governs every install on this panel —
 * the registry rows and the source field alike. Before the merge each of those
 * carried its own scope selector, on two different pages, with two different
 * sets of translations for the same two words.
 */

import { useEffect, useState, type FormEvent } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { Badge } from "@appica/ui-react/badge";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Download,
  Search,
} from "lucide-react";
import { getPort } from "@/lib/backend/composition/container";
import { normalizePackageSource } from "@/lib/pi/package-install";
import type { PackageManager, RegistryPkg } from "@/lib/pi/package-manager";
import { useT } from "@/lib/i18n";
import { InsetGroup, GroupRow, Segmented } from "@/components/settings-ui";
import { Skeleton } from "@/components/primitives";
import { PackageRow } from "./PackageRow";
import { DisclosureGroup } from "./DisclosureGroup";

const fieldStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "8px 12px",
  fontSize: 13.5,
  borderRadius: 9,
  border: "1px solid var(--separator)",
  background: "var(--bg-sunken)",
  color: "var(--text-primary)",
  outline: "none",
};

export function DiscoverPanel({ pm }: { pm: PackageManager }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");

  // the registry is a network round-trip, so it waits until this panel is
  // actually looked at rather than firing on every visit to plugin management
  useEffect(() => pm.loadRegistry(), [pm.loadRegistry]);

  const all = pm.registry;
  const q = query.trim().toLowerCase();
  const visible = !all
    ? []
    : !q
      ? all
      : all.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.description ?? "").toLowerCase().includes(q)
        );

  const submitSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await pm.install(source)) setSource("");
  };

  const openNpm = (pkg: RegistryPkg) => {
    const url = pkg.links?.npm ?? `https://www.npmjs.com/package/${pkg.name}`;
    void getPort("externalNavigation").open(url);
  };

  return (
    <>
      <InsetGroup
        header={t("plugins.installTarget")}
        footer={
          !pm.hasProject
            ? t("plugins.installFooterNoProject")
            : pm.activeScope === "global"
              ? t("plugins.installFooterGlobal")
              : t("plugins.installFooterProject")
        }
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["global", "project"] as const}
            value={pm.activeScope}
            onChange={pm.setScope}
            disabled={!pm.hasProject || pm.busy}
            labelOf={(scope) => t(`plugins.scope.${scope}`)}
          />
        </div>
      </InsetGroup>

      <InsetGroup
        header={
          all ? t("store.packagesCount", { n: visible.length }) : t("store.packages")
        }
        footer={t("store.packagesFooter")}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid var(--separator)",
          }}
        >
          <Search size={15} aria-hidden style={{ color: "var(--text-tertiary)", flexShrink: 0 }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("store.filterPlaceholder")}
            placeholder={t("store.filterPlaceholder")}
            style={{ ...fieldStyle, fontFamily: "var(--font-ui)" }}
          />
        </div>

        {pm.registryError ? (
          <GroupRow
            first
            icon={<AlertTriangle size={16} />}
            iconBg="var(--danger)"
            title={t("store.registryError")}
            detail={pm.registryError}
          />
        ) : !all ? (
          [0, 1, 2, 3, 4].map((i) => (
            <GroupRow
              key={i}
              first={i === 0}
              icon={<Skeleton width={16} height={16} radius={5} />}
              title={<Skeleton width="38%" height={13} />}
              detail={<Skeleton width="72%" height={12} />}
            />
          ))
        ) : visible.length === 0 ? (
          <GroupRow first title={t("store.noMatches")} detail={t("store.tryDifferent")} />
        ) : (
          visible.map((pkg, i) => {
            const installed = pm.installedNpmNames.has(pkg.name);
            return (
              <PackageRow
                key={pkg.name}
                first={i === 0}
                kind="npm"
                name={pkg.name}
                meta={[`v${pkg.version}`, pkg.publisher].filter(Boolean).join(" · ")}
                description={pkg.description}
                trailing={
                  <div
                    style={{ display: "flex", alignItems: "center", gap: 4, flexShrink: 0 }}
                  >
                    <motion.button
                      whileTap={{ scale: 0.88 }}
                      transition={{ type: "spring", stiffness: 500, damping: 24 }}
                      onClick={() => openNpm(pkg)}
                      aria-label={t("store.openOnNpm", { name: pkg.name })}
                      title={t("store.openOnNpm", { name: pkg.name })}
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 28,
                        height: 28,
                        border: "none",
                        borderRadius: 8,
                        background: "transparent",
                        color: "var(--text-tertiary)",
                        cursor: "pointer",
                      }}
                    >
                      <ArrowUpRight size={15} />
                    </motion.button>
                    {/* install → installed earns a bounce: it follows a commit */}
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
                          style={{ display: "inline-flex" }}
                        >
                          <Button
                            variant="primary"
                            size="sm"
                            onClick={() => void pm.install(`npm:${pkg.name}`)}
                            disabled={pm.busy}
                            style={{
                              borderRadius: 8,
                              opacity:
                                pm.installing && pm.installing !== `npm:${pkg.name}` ? 0.4 : 1,
                            }}
                          >
                            {pm.installing === `npm:${pkg.name}`
                              ? t("store.installing")
                              : t("store.install")}
                          </Button>
                        </motion.span>
                      )}
                    </AnimatePresence>
                  </div>
                }
              />
            );
          })
        )}
      </InsetGroup>

      {/* the escape hatch: anything the registry search can't reach */}
      <DisclosureGroup
        header={t("plugins.installHeader")}
        footer={t("plugins.installSourceFooter")}
      >
        <form
          onSubmit={submitSource}
          style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              id="plugin-package-source"
              name="packageSource"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label={t("plugins.installSourceLabel")}
              placeholder={t("plugins.installPlaceholder")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={pm.busy}
              style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
            />
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={pm.busy || !source.trim()}
              style={{ borderRadius: 8, flexShrink: 0, minWidth: 92 }}
            >
              <Download size={14} aria-hidden />
              {/* compare the normalized form: `pi-skills` installs as `npm:pi-skills` */}
              {pm.installing !== null && pm.installing === normalizePackageSource(source)
                ? t("plugins.installing")
                : t("plugins.install")}
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
      </DisclosureGroup>
    </>
  );
}
