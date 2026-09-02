"use client";

/**
 * The package row shared by both halves of the plugins page.
 *
 * Installed and Discover render the *same* row so a package does not change
 * appearance when it crosses from one to the other: same sigil, same name
 * treatment, same meta line. Only the trailing control differs — Install on one
 * side, Update plus an overflow menu on the other.
 */

import { GroupRow } from "@/components/settings-ui";
import { packageSigil } from "@/lib/pi/package-origin";
import type { PackageSourceKind } from "@/lib/pi/package-update";

export function PackageRow({
  first,
  kind,
  name,
  meta,
  description,
  trailing,
}: {
  first?: boolean;
  kind: PackageSourceKind;
  name: string;
  /** short facts under the name — origin, scope, pinned ref */
  meta: string;
  /** registry blurb; clamped to two lines so long ones can't stretch the row */
  description?: string;
  trailing?: React.ReactNode;
}) {
  const { tint, Icon } = packageSigil(kind);
  return (
    <GroupRow
      first={first}
      icon={<Icon size={16} />}
      iconBg={tint}
      title={name}
      detail={
        <>
          <span style={{ display: "block" }}>{meta}</span>
          {description && (
            <span
              style={{
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
                marginTop: 2,
                color: "var(--text-secondary)",
                lineHeight: 1.45,
              }}
            >
              {description}
            </span>
          )}
        </>
      }
      trailing={trailing}
    />
  );
}
