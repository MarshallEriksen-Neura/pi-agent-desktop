/**
 * The one place that owns plugin-package lifecycle: what is installed, what the
 * npm registry offers, and every mutation (`pi install` / `remove` / `update`).
 *
 * Both halves of the plugins page — Installed and Discover — drive the same
 * instance of this hook, which is why they can share one status banner, one
 * install-scope control, and one set of in-flight guards. Before the merge the
 * two pages each carried their own copy of all three, and the store page had to
 * reach into the plugins page's data anyway just to know which rows to badge as
 * already installed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePi } from "./store";
import {
  usePiSettings,
  packageSource,
  type PackageEntry,
  type SettingsScope,
} from "./settings";
import { normalizePackageSource, packageInstallRequest } from "./package-install";
import {
  packageSourceInfo,
  packageUpdateAllRequest,
  packageUpdateRequest,
  type PackageSourceInfo,
} from "./package-update";
import {
  fetchLatestVersions,
  isOutdated,
  npmLockPath,
  parseLockVersions,
} from "./package-versions";
import { cliError } from "./cli-error";
import { getPort } from "../backend/composition/container";
import { useWorkspace } from "../workspace";
import { useT, type TFunc } from "../i18n";

/** npm's own gallery: every package tagged with the `pi-package` keyword. */
const SEARCH_URL =
  "https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=100";

export interface RegistryPkg {
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

const MOCK_REGISTRY: RegistryPkg[] = [
  {
    name: "pi-skills",
    version: "1.4.0",
    description: "Curated skill collection for pi",
    publisher: "badlogic",
  },
  {
    name: "@juanibiapina/pi-powerbar",
    version: "0.9.2",
    description: "Status powerbar extension",
    publisher: "juanibiapina",
  },
  {
    name: "pi-mcp-adapter",
    version: "2.1.0",
    description: "Use MCP servers as pi tools",
    publisher: "community",
  },
];

/**
 * npm name → `dist-tags.latest`, shared across mounts. What the registry
 * publishes does not change between two visits to the plugins page, and the
 * page is navigated away from and back to constantly; without this every visit
 * re-asked the registry about every installed package.
 */
const latestVersionCache = new Map<string, string>();
/** names already looked up, successfully or not, so a mount does not re-ask. */
const latestVersionsRequested = new Set<string>();

/** One row of the installed list — a settings entry plus everything derived. */
export interface InstalledPackage {
  scope: SettingsScope;
  entry: PackageEntry;
  source: string;
  info: PackageSourceInfo;
  /** the same package identity is also declared in the other scope */
  duplicate: boolean;
  /** the settings entry is an object with a resource filter, not a bare string */
  filtered: boolean;
  /** the source type permits `pi update` at all — not that an update exists */
  updatable: boolean;
  /** version on disk, read from the scope's npm lock (npm packages only) */
  installedVersion?: string;
  /** `dist-tags.latest` from the registry (npm packages only) */
  latestVersion?: string;
  /** both versions are known and the registry has a newer one */
  outdated: boolean;
  /**
   * Provably current, so the row has nothing to offer. False whenever either
   * version is unknown: a package we cannot assess keeps its update button
   * rather than being declared current on evidence we do not have.
   */
  upToDate: boolean;
}

/** A row before version data is layered on — everything settings.json can tell. */
type BasePackage = Omit<
  InstalledPackage,
  "installedVersion" | "latestVersion" | "outdated" | "upToDate"
>;

export interface PackageManager {
  scope: SettingsScope;
  setScope: (scope: SettingsScope) => void;
  /** `scope`, forced back to global when no project is open */
  activeScope: SettingsScope;
  hasProject: boolean;

  packages: InstalledPackage[];
  hasPackages: boolean;
  /** bare npm names of everything installed, for Discover's installed badges */
  installedNpmNames: Set<string>;

  installing: string | null;
  removing: string | null;
  updating: string | null;
  updatingAll: boolean;
  /** any mutation in flight — every action is mutually exclusive */
  busy: boolean;

  status: { ok: boolean; text: string } | null;
  clearStatus: () => void;
  /** post to the shared banner from a row-level action (copy, etc.) */
  notify: (ok: boolean, text: string) => void;

  install: (rawSource: string) => Promise<boolean>;
  remove: (pkg: InstalledPackage) => Promise<void>;
  requestUpdate: (pkg: InstalledPackage) => void;
  updateAll: () => Promise<void>;

  pendingUpdate: InstalledPackage | null;
  confirmPendingUpdate: () => Promise<void>;
  cancelPendingUpdate: () => void;

  registry: RegistryPkg[] | null;
  registryError: string | null;
  loadRegistry: () => void;
}

/** `{err}` for a failed `pi` invocation, in the caller's wording. */
function failure(
  t: TFunc,
  key: "plugins.installFailed" | "plugins.removeFailed" | "plugins.updateFailed",
  result: { code: number; stdout: string; stderr: string }
) {
  return t(key, { code: result.code, err: cliError(result, t("plugins.noErrorDetail")) });
}

/** `{err}` for a throw on the way to `pi` — the CLI never ran. */
function thrown(
  t: TFunc,
  key: "plugins.installUnexpected" | "plugins.removeUnexpected" | "plugins.updateUnexpected",
  error: unknown
) {
  return t(key, { err: error instanceof Error ? error.message : String(error) });
}

export function usePackageManager(): PackageManager {
  const { refresh } = usePi();
  const settings = usePiSettings();
  const t = useT();
  const root = useWorkspace((state) => state.root);

  const [scope, setScope] = useState<SettingsScope>("global");
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<InstalledPackage | null>(null);
  const [registry, setRegistry] = useState<RegistryPkg[] | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const registryRequested = useRef(false);
  /** `<scope>:<npm name>` → version on disk */
  const [installedVersions, setInstalledVersions] = useState<Map<string, string>>(new Map());
  /** npm name → `dist-tags.latest`; the registry is scope-independent */
  const [latestVersions, setLatestVersions] = useState<Map<string, string>>(
    () => new Map(latestVersionCache)
  );

  const activeScope: SettingsScope = root ? scope : "global";
  const busy =
    settings.busy ||
    installing !== null ||
    removing !== null ||
    updating !== null ||
    updatingAll;

  const globalData = settings.global.data;
  const projectData = settings.project.data;

  const basePackages = useMemo<BasePackage[]>(() => {
    const bySc: [SettingsScope, PackageEntry[]][] = [
      ["global", (globalData?.packages ?? []) as PackageEntry[]],
      ["project", (projectData?.packages ?? []) as PackageEntry[]],
    ];

    // identity, not source string: `npm:x` and `npm:x@2` are the same package
    // declared twice, and `pi update` would touch both
    const identityScopes = new Map<string, Set<SettingsScope>>();
    for (const [sc, entries] of bySc) {
      for (const entry of entries) {
        const { identity } = packageSourceInfo(packageSource(entry));
        const seen = identityScopes.get(identity) ?? new Set<SettingsScope>();
        seen.add(sc);
        identityScopes.set(identity, seen);
      }
    }

    return bySc.flatMap(([sc, entries]) =>
      entries.map((entry) => {
        const source = packageSource(entry);
        const info = packageSourceInfo(source);
        return {
          scope: sc,
          entry,
          source,
          info,
          duplicate: (identityScopes.get(info.identity)?.size ?? 0) > 1,
          filtered: typeof entry !== "string",
          updatable: info.updateMode !== "local" && info.updateMode !== "npm-pinned",
        };
      })
    );
  }, [globalData, projectData]);

  const installedNpmNames = useMemo(
    () =>
      new Set(
        basePackages
          .filter((pkg) => pkg.info.kind === "npm")
          .map((pkg) => pkg.info.name)
      ),
    [basePackages]
  );

  /**
   * Layer the two version sources onto each row. Both are best-effort: a
   * missing lock file, an unpublished package, or a failed registry lookup
   * leaves the row exactly as it behaved before — offering an update — instead
   * of asserting it is current.
   */
  const packages = useMemo<InstalledPackage[]>(
    () =>
      basePackages.map((pkg) => {
        const isNpm = pkg.info.kind === "npm";
        const installedVersion = isNpm
          ? installedVersions.get(`${pkg.scope}:${pkg.info.name}`)
          : undefined;
        const latestVersion = isNpm ? latestVersions.get(pkg.info.name) : undefined;
        const comparable = installedVersion !== undefined && latestVersion !== undefined;
        const outdated =
          installedVersion !== undefined &&
          latestVersion !== undefined &&
          isOutdated(installedVersion, latestVersion);
        return {
          ...pkg,
          installedVersion,
          latestVersion,
          outdated,
          upToDate: pkg.updatable && comparable && !outdated,
        };
      }),
    [basePackages, installedVersions, latestVersions]
  );

  const globalLock = npmLockPath(settings.global.path);
  const projectLock = npmLockPath(settings.project.path);

  /**
   * Re-read both scopes' npm locks. Cheap enough to redo after every mutation:
   * two file reads, and it is what makes a finished update visible — the
   * version on the row moves.
   */
  const refreshInstalledVersions = useCallback(async () => {
    const scopes = ([
      ["global", globalLock],
      ["project", projectLock],
    ] as const).filter(
      (pair): pair is readonly [SettingsScope, string] => pair[1] !== null
    );
    // both paths are empty until the settings store has loaded once; asking the
    // container for a port before then would throw by design
    if (scopes.length === 0) return;

    const port = getPort("piConfiguration");
    const next = new Map<string, string>();
    await Promise.all(
      scopes.map(async ([scope, path]) => {
        const raw = await port.readPackageLock(path).catch(() => null);
        if (!raw) return;
        for (const [name, version] of parseLockVersions(raw)) {
          next.set(`${scope}:${name}`, version);
        }
      })
    );
    setInstalledVersions(next);
  }, [globalLock, projectLock]);

  /** Look up `dist-tags.latest` for names not asked about yet. */
  const refreshLatestVersions = useCallback(async (names: string[]) => {
    const pending = names.filter((name) => !latestVersionsRequested.has(name));
    if (pending.length === 0) return;
    for (const name of pending) latestVersionsRequested.add(name);

    const record = (found: Map<string, string>) => {
      if (found.size === 0) return;
      for (const [name, version] of found) latestVersionCache.set(name, version);
      setLatestVersions((prev) => new Map([...prev, ...found]));
    };

    if (usePiSettings.getState().mock) {
      const mocked = new Map(MOCK_REGISTRY.map((pkg) => [pkg.name, pkg.version]));
      record(
        new Map(
          pending
            .map((name) => [name, mocked.get(name)] as const)
            .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
        )
      );
      return;
    }

    const fetched = await fetchLatestVersions(pending);
    // drop names that did not resolve so a later settings change retries them;
    // the guard exists to stop refetching what is already known, not to make a
    // transient network failure permanent
    for (const name of pending) {
      if (!fetched.has(name)) latestVersionsRequested.delete(name);
    }
    record(fetched);
  }, []);

  useEffect(() => {
    void refreshInstalledVersions();
  }, [refreshInstalledVersions]);

  // a joined key rather than the Set itself: the memo's identity changes on
  // every settings reload, its contents rarely do, and each change would
  // otherwise be another round of registry lookups
  const npmNameKey = useMemo(() => [...installedNpmNames].sort().join("\n"), [installedNpmNames]);
  useEffect(() => {
    if (!npmNameKey) return;
    void refreshLatestVersions(npmNameKey.split("\n"));
  }, [npmNameKey, refreshLatestVersions]);

  /** settings.json changed on disk — re-read it and re-query pi's live state. */
  const afterMutation = useCallback(async () => {
    usePiSettings.setState({ dirtyRestart: true });
    await usePiSettings.getState().load();
    void refreshInstalledVersions();
    void refresh();
  }, [refresh, refreshInstalledVersions]);

  const install = useCallback(
    async (rawSource: string) => {
      // read the workspace at call time: the form can outlive the project that
      // was open when it was first rendered
      const currentRoot = useWorkspace.getState().root;
      const source = normalizePackageSource(rawSource);
      const request = source
        ? packageInstallRequest(source, currentRoot ? scope : "global", currentRoot)
        : null;
      if (!source || !request) {
        setStatus({ ok: false, text: t("plugins.installSourceInvalid") });
        return false;
      }

      setInstalling(source);
      setStatus(null);
      usePiSettings.setState({ lastError: null });
      try {
        const result = await usePiSettings.getState().runPiCli(request.args, request.cwd);
        if (result.code !== 0) {
          setStatus({ ok: false, text: failure(t, "plugins.installFailed", result) });
          return false;
        }
        await afterMutation();
        setStatus({ ok: true, text: t("plugins.installed", { source }) });
        return true;
      } catch (error) {
        setStatus({ ok: false, text: thrown(t, "plugins.installUnexpected", error) });
        return false;
      } finally {
        setInstalling(null);
      }
    },
    [afterMutation, scope, t]
  );

  const remove = useCallback(
    async (pkg: InstalledPackage) => {
      const currentRoot = useWorkspace.getState().root;
      if (pkg.scope === "project" && !currentRoot) {
        usePiSettings.setState({ lastError: t("plugins.removeNoProject") });
        return;
      }

      setRemoving(pkg.source);
      setStatus(null);
      usePiSettings.setState({ lastError: null });
      try {
        // `pi remove` edits settings.json *and* cleans up ~/.pi/agent/npm|git
        const result = await usePiSettings
          .getState()
          .runPiCli(
            pkg.scope === "project" ? ["remove", pkg.source, "-l"] : ["remove", pkg.source],
            currentRoot
          );
        if (result.code !== 0) {
          usePiSettings.setState({ lastError: failure(t, "plugins.removeFailed", result) });
          return;
        }
        await afterMutation();
        setStatus({ ok: true, text: t("plugins.removed", { source: pkg.source }) });
      } catch (error) {
        usePiSettings.setState({
          lastError: thrown(t, "plugins.removeUnexpected", error),
        });
      } finally {
        setRemoving(null);
      }
    },
    [afterMutation, t]
  );

  const performUpdate = useCallback(
    async (pkg: InstalledPackage) => {
      if (!pkg.updatable) return;
      const request = packageUpdateRequest(pkg.source, useWorkspace.getState().root);
      if (!request) {
        setStatus({ ok: false, text: t("plugins.updateSourceInvalid") });
        return;
      }

      setUpdating(pkg.source);
      setStatus(null);
      usePiSettings.setState({ lastError: null });
      try {
        const result = await usePiSettings.getState().runPiCli(request.args, request.cwd);
        if (result.code !== 0) {
          setStatus({ ok: false, text: failure(t, "plugins.updateFailed", result) });
          return;
        }
        await afterMutation();
        setStatus({ ok: true, text: t("plugins.updated", { source: pkg.source }) });
      } catch (error) {
        setStatus({ ok: false, text: thrown(t, "plugins.updateUnexpected", error) });
      } finally {
        setUpdating(null);
      }
    },
    [afterMutation, t]
  );

  const requestUpdate = useCallback(
    (pkg: InstalledPackage) => {
      if (busy) return;
      // one `pi update <source>` rewrites every entry sharing that identity, so
      // a package declared in both scopes needs the user to agree to both
      if (pkg.duplicate) {
        setPendingUpdate(pkg);
        return;
      }
      void performUpdate(pkg);
    },
    [busy, performUpdate]
  );

  const confirmPendingUpdate = useCallback(async () => {
    const pending = pendingUpdate;
    if (!pending) return;
    await performUpdate(pending);
    setPendingUpdate(null);
  }, [pendingUpdate, performUpdate]);

  const updateAll = useCallback(async () => {
    if (busy || packages.length === 0) return;
    setUpdatingAll(true);
    setStatus(null);
    usePiSettings.setState({ lastError: null });
    try {
      const request = packageUpdateAllRequest(useWorkspace.getState().root);
      const result = await usePiSettings.getState().runPiCli(request.args, request.cwd);
      if (result.code !== 0) {
        setStatus({ ok: false, text: failure(t, "plugins.updateFailed", result) });
        return;
      }
      await afterMutation();
      setStatus({ ok: true, text: t("plugins.updatedAll") });
    } catch (error) {
      setStatus({ ok: false, text: thrown(t, "plugins.updateUnexpected", error) });
    } finally {
      setUpdatingAll(false);
    }
  }, [afterMutation, busy, packages.length, t]);

  /**
   * Fetched on Discover's first paint, not on page load: the registry is a
   * network round-trip, and the page now opens on Installed. Idempotent so
   * switching tabs back and forth neither refetches nor drops the list.
   */
  const loadRegistry = useCallback(() => {
    if (registryRequested.current) return;
    registryRequested.current = true;

    if (usePiSettings.getState().mock) {
      setRegistry(MOCK_REGISTRY);
      return;
    }
    fetch(SEARCH_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`npm registry: HTTP ${response.status}`);
        return response.json() as Promise<NpmSearchResult>;
      })
      .then((json) =>
        setRegistry(
          json.objects.map((object) => ({
            name: object.package.name,
            version: object.package.version,
            description: object.package.description,
            publisher: object.package.publisher?.username,
            date: object.package.date,
            links: object.package.links,
          }))
        )
      )
      .catch((error) => {
        registryRequested.current = false; // a retry is worth allowing
        setRegistryError(error instanceof Error ? error.message : String(error));
      });
  }, []);

  return {
    scope,
    setScope,
    activeScope,
    hasProject: root !== null,

    packages,
    hasPackages: packages.length > 0,
    installedNpmNames,

    installing,
    removing,
    updating,
    updatingAll,
    busy,

    status,
    clearStatus: useCallback(() => setStatus(null), []),
    notify: useCallback((ok: boolean, text: string) => setStatus({ ok, text }), []),

    install,
    remove,
    requestUpdate,
    updateAll,

    pendingUpdate,
    confirmPendingUpdate,
    cancelPendingUpdate: useCallback(() => setPendingUpdate(null), []),

    registry,
    registryError,
    loadRegistry,
  };
}

