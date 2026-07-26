"use client";

/**
 * Package store — pi's "gallery" is just npm packages tagged `pi-package`
 * (the same set https://pi.dev/packages renders). We query the npm registry
 * search API directly and install via the pi CLI, which writes the package
 * into settings.json and downloads it under ~/.pi/agent/npm/.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { Badge } from "@appica/ui-react/badge";
import { usePiSettings, packageSource } from "@/lib/pi/settings";
import { useT } from "@/lib/i18n";
import { SettingsPage, InsetGroup, GroupRow, Segmented } from "@/components/settings-ui";
import { AlertTriangle, Package, Check } from "lucide-react";

const SEARCH_URL =
  "https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=100";

const PKG_COLORS = ["#6E56CF", "#C15F3C", "#10A37F", "#4285F4", "#E5484D"];

interface StorePkg {
  name: string;
  version: string;
  description?: string;
  publisher?: string;
  date?: string;
  links?: { npm?: string; homepage?: string; repository?: string };
}

interface NpmSearchResult {
  objects: {
    package: {
      name: string;
      version: string;
      description?: string;
      publisher?: { username?: string };
      date?: string;
      links?: { npm?: string; homepage?: string; repository?: string };
    };
  }[];
}

const MOCK_RESULTS: StorePkg[] = [
  { name: "pi-skills", version: "1.4.0", description: "Curated skill collection for pi", publisher: "badlogic" },
  { name: "@juanibiapina/pi-powerbar", version: "0.9.2", description: "Status powerbar extension", publisher: "juanibiapina" },
  { name: "pi-mcp-adapter", version: "2.1.0", description: "Use MCP servers as pi tools", publisher: "community" },
];

export default function StorePage() {
  const settings = usePiSettings();
  const [all, setAll] = useState<StorePkg[] | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"global" | "project">("global");
  const [installing, setInstalling] = useState<string | null>(null);
  const [installLog, setInstallLog] = useState<{ ok: boolean; text: string } | null>(
    null
  );
  const t = useT();

  useEffect(() => {
    settings.load();
    if (settings.mock) {
      setAll(MOCK_RESULTS);
      return;
    }
    fetch(SEARCH_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`npm registry: HTTP ${r.status}`);
        return r.json() as Promise<NpmSearchResult>;
      })
      .then((json) =>
        setAll(
          json.objects.map((o) => ({
            name: o.package.name,
            version: o.package.version,
            description: o.package.description,
            publisher: o.package.publisher?.username,
            date: o.package.date,
            links: o.package.links,
          }))
        )
      )
      .catch((e) => setFetchError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const installedSources = useMemo(() => {
    const pkgs = [
      ...(settings.global.data?.packages ?? []),
      ...(settings.project.data?.packages ?? []),
    ];
    // normalize "npm:name@ver" → "name" for lookup
    return new Set(
      pkgs
        .map(packageSource)
        .filter((s) => s.startsWith("npm:"))
        .map((s) => s.slice(4).replace(/@[^@/]+$/, ""))
    );
  }, [settings.global.data, settings.project.data]);

  const visible = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.description ?? "").toLowerCase().includes(q)
    );
  }, [all, query]);

  const install = async (pkg: StorePkg) => {
    setInstalling(pkg.name);
    setInstallLog(null);
    try {
      const args = ["install", `npm:${pkg.name}`];
      if (scope === "project") args.push("-l");
      const r = await settings.runPiCli(args);
      setInstallLog(
        r.code === 0
          ? { ok: true, text: t("store.installedLog", { name: pkg.name }) }
          : {
              ok: false,
              text: t("store.installFailed", {
                code: r.code,
                err: (r.stderr || r.stdout).trim(),
              }),
            }
      );
      await settings.load();
      if (r.code === 0) usePiSettings.setState({ dirtyRestart: true });
    } finally {
      setInstalling(null);
    }
  };

  return (
    <SettingsPage
      title={t("store.title")}
      subtitle={settings.mock ? t("store.subtitleMock") : t("store.subtitleLive")}
    >
      {/* search + install scope */}
      <InsetGroup
        header={t("store.search")}
        footer={
          scope === "global"
            ? t("store.searchFooterGlobal")
            : t("store.searchFooterProject")
        }
      >
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("store.filterPlaceholder")}
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: 13.5,
              borderRadius: 9,
              border: "1px solid var(--separator)",
              background: "var(--bg-sunken)",
              color: "var(--text-primary)",
              outline: "none",
              fontFamily: "var(--font-ui)",
            }}
          />
          <Segmented
            options={["global", "project"] as const}
            value={scope}
            onChange={setScope}
          />
        </div>
      </InsetGroup>

      {installLog && (
        <motion.p
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          style={{
            marginTop: 14,
            fontSize: 12.5,
            lineHeight: 1.5,
            color: installLog.ok ? "var(--success)" : "var(--danger, #E5484D)",
          }}
        >
          {installLog.text}
          {installLog.ok && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => settings.restartPi()}
              disabled={settings.busy}
              style={{ marginLeft: 10, borderRadius: 7 }}
            >
              {settings.busy ? t("settings.restarting") : t("settings.restartPi")}
            </Button>
          )}
        </motion.p>
      )}

      <InsetGroup
        header={
          all
            ? t("store.packagesCount", { n: visible.length })
            : t("store.packages")
        }
        footer={t("store.packagesFooter")}
      >
        {fetchError ? (
          <GroupRow
            first
            icon={<AlertTriangle size={16} />}
            iconBg="var(--danger, #E5484D)"
            title={t("store.registryError")}
            detail={fetchError}
          />
        ) : !all ? (
          <GroupRow first title={t("common.loading")} detail={t("store.loadingDetail")} />
        ) : visible.length === 0 ? (
          <GroupRow first title={t("store.noMatches")} detail={t("store.tryDifferent")} />
        ) : (
          visible.map((p, i) => {
            const installed = installedSources.has(p.name);
            return (
              <GroupRow
                key={p.name}
                first={i === 0}
                icon={<Package size={16} />}
                iconBg={PKG_COLORS[i % PKG_COLORS.length]}
                title={p.name}
                detail={`v${p.version}${p.publisher ? ` · ${p.publisher}` : ""}${p.description ? ` · ${p.description}` : ""}`}
                trailing={
                  /* Install → Installed gets a small success bounce */
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
                          onClick={() => install(p)}
                          disabled={installing !== null}
                          style={{
                            borderRadius: 8,
                            opacity: installing && installing !== p.name ? 0.4 : 1,
                          }}
                        >
                          {installing === p.name ? t("store.installing") : t("store.install")}
                        </Button>
                      </motion.span>
                    )}
                  </AnimatePresence>
                }
              />
            );
          })
        )}
      </InsetGroup>
    </SettingsPage>
  );
}
