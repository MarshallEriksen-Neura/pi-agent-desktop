"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { useUI } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { Sparkles, Check, X, CornerDownLeft } from "lucide-react";

/**
 * iOS-style review sheet: springs up from the bottom when the agent
 * finishes an edit and awaits the user's verdict. Reject reverts the change.
 * The verdict gets one visible beat (✓ Applied / ✕ Reverted) before dismissal.
 */
export function DiffReviewCard() {
  const { pendingReview, resolveReview } = useUI();
  const [verdict, setVerdict] = useState<null | boolean>(null);
  const t = useT();

  // new review → reset verdict state
  useEffect(() => {
    if (pendingReview) setVerdict(null);
  }, [pendingReview]);

  const decide = (accepted: boolean) => {
    if (verdict !== null) return; // one verdict per review
    setVerdict(accepted);
    setTimeout(() => resolveReview(accepted), 350); // let the beat land, then exit
  };

  return (
    <AnimatePresence>
      {pendingReview && (
        <motion.div
          key="review"
          initial={{ opacity: 0, y: 64, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 64, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 340, damping: 28 }}
          className="material"
          style={{
            position: "fixed",
            bottom: 32,
            left: "50%",
            x: "-50%",
            width: 560,
            maxWidth: "86vw",
            borderRadius: "var(--radius-lg)",
            border: "1px solid var(--separator)",
            boxShadow: "var(--shadow-lg)",
            zIndex: 60,
            overflow: "hidden",
          }}
        >
          {/* header */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "14px 18px 10px",
            }}
          >
            <span style={{ color: "var(--agent-thinking)", fontSize: 14 }}>
              <Sparkles size={14} />
            </span>
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {t("review.edited", { file: pendingReview.file.split("/").pop() ?? "" })}
            </span>
            <span
              style={{
                marginLeft: "auto",
                fontSize: 11.5,
                fontFamily: "var(--font-mono)",
                color: "var(--text-tertiary)",
              }}
            >
              +1 −1
            </span>
          </div>

          {/* mini diff */}
          <div
            style={{
              margin: "0 14px",
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--separator)",
              overflow: "hidden",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 10,
                padding: "3px 12px",
                background: "var(--diff-remove-bg)",
                color: "var(--diff-remove-text)",
              }}
            >
              <span style={{ userSelect: "none" }}>−</span>
              <span style={{ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
                {pendingReview.oldLine.trim()}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 10,
                padding: "3px 12px",
                background: "var(--diff-add-bg)",
                color: "var(--diff-add-text)",
              }}
            >
              <span style={{ userSelect: "none" }}>+</span>
              <span style={{ whiteSpace: "pre", overflow: "hidden", textOverflow: "ellipsis" }}>
                {pendingReview.newLine.trim()}
              </span>
            </div>
          </div>

          {/* actions — one beat of ✓/✕ feedback before the sheet exits */}
          <div
            style={{
              display: "flex",
              gap: 10,
              justifyContent: "flex-end",
              alignItems: "center",
              padding: "12px 14px 14px",
            }}
          >
            {verdict !== null && (
              <motion.span
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 500, damping: 22 }}
                style={{
                  marginRight: "auto",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: verdict ? "var(--success)" : "var(--danger)",
                }}
              >
                {verdict ? (
                <>
                  <Check size={13} /> {t("review.applied")}
                </>
              ) : (
                <>
                  <X size={13} /> {t("review.reverted")}
                </>
              )}
              </motion.span>
            )}
            <Button
              variant="outline"
              onClick={() => decide(false)}
              disabled={verdict !== null}
              style={{ borderRadius: 99, color: "var(--text-secondary)" }}
            >
              {t("review.reject")}
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => decide(true)}
              disabled={verdict !== null}
              style={{ borderRadius: 99 }}
            >
              {t("review.accept")} <CornerDownLeft size={13} style={{ verticalAlign: "middle" }} />
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
