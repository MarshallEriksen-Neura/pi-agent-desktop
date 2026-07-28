"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@appica/ui-react/button";
import { useUI } from "@/lib/store";
import { useT } from "@/lib/i18n";
import { minimizeToTray, quitApp } from "@/lib/window-close";

/**
 * Shown when the close behavior is "ask". Lets the user choose to quit or
 * minimize to tray, with an option to remember the choice for next time.
 */
export function CloseConfirmDialog() {
  const open = useUI((s) => s.closeDialogOpen);
  const setOpen = useUI((s) => s.setCloseDialogOpen);
  const setCloseBehavior = useUI((s) => s.setCloseBehavior);
  const t = useT();
  const [remember, setRemember] = useState(false);

  const cancel = () => {
    setOpen(false);
    setRemember(false);
  };

  const onMinimize = () => {
    if (remember) setCloseBehavior("minimize");
    setOpen(false);
    setRemember(false);
    void minimizeToTray();
  };

  const onQuit = () => {
    if (remember) setCloseBehavior("quit");
    setOpen(false);
    setRemember(false);
    void quitApp();
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={cancel}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            display: "grid",
            placeItems: "center",
            background: "rgba(0,0,0,0.45)",
            backdropFilter: "blur(2px)",
          }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ type: "spring", stiffness: 320, damping: 28 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 360,
              maxWidth: "calc(100vw - 32px)",
              background: "var(--bg-base)",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-lg)",
              padding: 22,
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: 17,
                fontWeight: 650,
                color: "var(--text-primary)",
              }}
            >
              {t("closeDialog.title")}
            </h2>
            <p
              style={{
                margin: "10px 0 16px",
                fontSize: 13.5,
                lineHeight: 1.5,
                color: "var(--text-secondary)",
              }}
            >
              {t("closeDialog.message")}
            </p>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 18,
                cursor: "pointer",
                userSelect: "none",
              }}
            >
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: "var(--accent)" }}
              />
              {t("closeDialog.remember")}
            </label>

            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={cancel}>
                {t("common.cancel")}
              </Button>
              <Button variant="outline" onClick={onMinimize}>
                {t("closeDialog.minimize")}
              </Button>
              <Button variant="primary" onClick={onQuit}>
                {t("closeDialog.quit")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
