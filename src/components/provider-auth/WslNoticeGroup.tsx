"use client";

import { InsetGroup } from "@/components/settings-ui";
import { useT } from "@/lib/i18n";
import { CopyableValue } from "./primitives";

/**
 * Shown when pi runs inside a WSL distro.
 *
 * pi resolves its credential file from the distro's home directory, so a login
 * started on the Windows side would write a file the agent never reads. Rather
 * than fail silently, point at the one path that does work: run pi inside the
 * distro and use its own `/login`.
 */
export function WslNoticeGroup() {
  const t = useT();
  return (
    <InsetGroup header={t("providerAuth.wslTitle")} footer={t("providerAuth.wslDetail")}>
      <div style={{ padding: "12px 14px" }}>
        <CopyableValue
          value="pi"
          copyLabel={t("providerAuth.copyUrl")}
          copiedLabel={t("providerAuth.copied")}
        />
      </div>
    </InsetGroup>
  );
}
