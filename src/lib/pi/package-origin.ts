import { FolderOpen, GitBranch, Package, type LucideIcon } from "lucide-react";
import type { PackageSourceKind } from "./package-update";

/**
 * A package's sigil — the tinted glyph in front of every package row.
 *
 * The tint is *data*: it says where the package came from, so the same package
 * looks identical while you are browsing it in Discover and after it lands in
 * Installed. This replaces the two identical five-colour rotations that used to
 * live in the plugins and store pages (`EXT_COLORS` / `PKG_COLORS`), where the
 * colour was picked by list index and therefore meant nothing — and shifted
 * whenever the list was filtered or reordered.
 *
 * npm keeps its own brand red. git deliberately does *not* use git's brand
 * orange: at 30px it is indistinguishable from npm red, so it takes the app's
 * accent purple instead. Local paths are neutral — they came from your disk,
 * not from a registry.
 */
const SIGILS: Record<PackageSourceKind, { tint: string; Icon: LucideIcon }> = {
  npm: { tint: "#CB3837", Icon: Package },
  git: { tint: "#6E56CF", Icon: GitBranch },
  local: { tint: "var(--gray-1)", Icon: FolderOpen },
};

export function packageSigil(kind: PackageSourceKind) {
  return SIGILS[kind];
}
