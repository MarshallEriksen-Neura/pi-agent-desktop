"use client";

/**
 * The store folded into `/plugins/` — browsing npm for packages and managing the
 * ones you installed were always the same job. Kept as a redirect rather than
 * deleted so a window left open on this route (or an older build's deep link)
 * lands somewhere useful after an update instead of on the error boundary.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function StorePage() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/plugins/");
  }, [router]);
  return null;
}
