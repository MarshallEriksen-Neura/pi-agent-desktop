"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog, DialogContent } from "@appica/ui-react/dialog";
import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";
import { Textarea } from "@appica/ui-react/textarea";
import { useExtUi } from "@/lib/pi/ext-ui";
import { useT } from "@/lib/i18n";
import type { ExtensionUiRequest } from "@/lib/pi/protocol";
import { Command } from "lucide-react";

/**
 * pi extension UI requests rendered with Appica UI primitives:
 *   confirm/select/input/editor → Dialog styled as an iOS sheet,
 *   notify → capsule toasts (kept custom for the Dynamic-Island look).
 */
export function ExtensionSheet() {
  const queue = useExtUi((s) => s.queue);
  const respond = useExtUi((s) => s.respond);
  const current = queue[0];

  return (
    <>
      <Dialog
        open={!!current}
        onOpenChange={(open) => {
          if (!open && current) respond(current, { cancelled: true });
        }}
      >
        {current && (
          <DialogContent
            closeButton={false}
            className="material"
            style={{
              width: 480,
              maxWidth: "88vw",
              borderRadius: "var(--radius-lg)",
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-lg)",
              padding: 0,
              background: "var(--material-regular)",
            }}
          >
            <SheetBody req={current} />
          </DialogContent>
        )}
      </Dialog>
      <NotifyToasts />
    </>
  );
}

function SheetBody({ req }: { req: ExtensionUiRequest }) {
  const respond = useExtUi((s) => s.respond);
  const [text, setText] = useState(req.prefill ?? "");
  const t = useT();

  return (
    <div>
      {/* header */}
      <div style={{ padding: "16px 20px 6px" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 13.5,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          <span style={{ color: "var(--agent-thinking)" }}><Command size={14} /></span>
          {req.title ?? t("ext.request")}
        </div>
        {req.message && (
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              lineHeight: 1.55,
              margin: "8px 0 0",
            }}
          >
            {req.message}
          </p>
        )}
      </div>

      {/* body per method */}
      {req.method === "select" && (
        <div style={{ padding: "10px 10px 6px" }}>
          {(req.options ?? []).map((opt) => (
            <Button
              key={opt}
              variant="ghost"
              onClick={() => respond(req, { value: opt })}
              className="w-full justify-start"
              style={{ color: "var(--accent)", fontSize: 13.5 }}
            >
              {opt}
            </Button>
          ))}

          {/* Free-text escape hatch. The RPC carries no "this option means type
              your own" flag — options are plain strings — so rather than
              pattern-matching a phrase pi might reword or localize, every
              select offers its own input. An answer the model did not think of
              goes back as the response value, same as a picked option. */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              margin: "8px 6px 2px",
              paddingTop: 10,
              borderTop: "1px solid var(--separator)",
            }}
          >
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && text.trim()) {
                  respond(req, { value: text.trim() });
                }
              }}
              placeholder={t("ext.selectCustomPlaceholder")}
              style={{ flex: 1, borderRadius: 99, fontSize: 13 }}
            />
            <Button
              variant="primary"
              disabled={!text.trim()}
              onClick={() => respond(req, { value: text.trim() })}
              style={{ borderRadius: 99 }}
            >
              {t("ext.selectCustomSend")}
            </Button>
          </div>
        </div>
      )}

      {(req.method === "input" || req.method === "editor") && (
        <div style={{ padding: "12px 16px 4px" }}>
          {req.method === "editor" ? (
            <Textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={req.placeholder}
              rows={5}
              style={{ fontFamily: "var(--font-mono)", fontSize: 13 }}
            />
          ) : (
            <Input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) =>
                e.key === "Enter" && respond(req, { value: text })
              }
              placeholder={req.placeholder}
              style={{ borderRadius: 99 }}
            />
          )}
        </div>
      )}

      {/* actions */}
      <div
        style={{
          display: "flex",
          gap: 10,
          justifyContent: "flex-end",
          padding: "12px 16px 16px",
        }}
      >
        <Button
          variant="outline"
          onClick={() =>
            respond(
              req,
              req.method === "confirm"
                ? { confirmed: false }
                : { cancelled: true }
            )
          }
          style={{ borderRadius: 99 }}
        >
          {t("common.cancel")}
        </Button>
        {req.method === "confirm" && (
          <Button
            variant="primary"
            autoFocus
            onClick={() => respond(req, { confirmed: true })}
            style={{ borderRadius: 99 }}
          >
            {t("common.confirm")}
          </Button>
        )}
        {(req.method === "input" || req.method === "editor") && (
          <Button
            variant="primary"
            onClick={() => respond(req, { value: text })}
            style={{ borderRadius: 99 }}
          >
            {t("common.done")}
          </Button>
        )}
      </div>
    </div>
  );
}

const TOAST_COLOR = {
  info: "var(--accent)",
  warning: "var(--warning)",
  error: "var(--danger)",
} as const;

/** iOS Dynamic-Island-ish capsule toasts, top center (custom by design). */
function NotifyToasts() {
  const toasts = useExtUi((s) => s.toasts);
  const dismiss = useExtUi((s) => s.dismissToast);

  return (
    <div
      style={{
        position: "fixed",
        top: 14,
        left: 0,
        right: 0,
        zIndex: 95,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.button
            key={t.id}
            initial={{ opacity: 0, y: -24, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.92 }}
            transition={{ type: "spring", stiffness: 420, damping: 28 }}
            onClick={() => dismiss(t.id)}
            className="material"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 18px",
              borderRadius: 99,
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-md)",
              fontSize: 12.5,
              color: "var(--text-primary)",
              cursor: "pointer",
              pointerEvents: "auto",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: 99,
                background: TOAST_COLOR[t.kind],
              }}
            />
            {t.message}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}
