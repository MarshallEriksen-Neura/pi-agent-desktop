"use client";

import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { useT } from "@/lib/i18n";

interface ImageLightboxProps {
  src: string | null;
  onClose: () => void;
}

/**
 * Full-screen lightbox for previewing images (pasted attachments, sent images).
 * Click backdrop or press Escape to dismiss.
 */
export function ImageLightbox({ src, onClose }: ImageLightboxProps) {
  const t = useT();

  // Close on Escape
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, onClose]);

  return (
    <AnimatePresence>
      {src && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "rgba(0, 0, 0, 0.72)",
            backdropFilter: "blur(6px)",
          }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            aria-label={t("agent.closePreview")}
            style={{
              position: "absolute",
              top: 16,
              right: 16,
              width: 34,
              height: 34,
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 99,
              background: "rgba(0,0,0,0.45)",
              color: "#fff",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={16} />
          </button>

          {/* Image — stop click propagation so only backdrop click closes */}
          <motion.img
            src={src}
            alt=""
            initial={{ opacity: 0, scale: 0.88 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.92 }}
            transition={{ type: "spring", stiffness: 340, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            // eslint-disable-next-line @next/next/no-img-element
            style={{
              maxWidth: "min(92vw, 1200px)",
              maxHeight: "88vh",
              objectFit: "contain",
              borderRadius: 12,
              boxShadow: "0 8px 48px rgba(0,0,0,0.55)",
              /* checkerboard so transparent regions are visible */
              backgroundImage:
                "conic-gradient(rgba(128,128,128,0.22) 0 25%, transparent 0 50%, rgba(128,128,128,0.22) 0 75%, transparent 0)",
              backgroundSize: "20px 20px",
              cursor: "default",
            }}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
