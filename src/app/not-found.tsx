"use client";

import { usePathname, useRouter } from "next/navigation";
import { PillButton, StatusScreen } from "@/components/StatusScreen";
import { useT } from "@/lib/i18n";

/** Global 404 — unknown routes render inside the app shell. */
export default function NotFound() {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname();

  return (
    <StatusScreen
      code="404"
      command={`open ${pathname ?? "/…"}`}
      result="route not found"
      title={t("state.notFound.title")}
      body={t("state.notFound.body")}
    >
      <PillButton onClick={() => router.push("/")}>
        {t("state.notFound.home")}
      </PillButton>
    </StatusScreen>
  );
}
