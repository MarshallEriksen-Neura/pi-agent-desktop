"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Dialog, DialogContent } from "@appica/ui-react/dialog";
import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";
import { Textarea } from "@appica/ui-react/textarea";
import { useExtUi, type QueuedExtRequest } from "@/lib/pi/ext-ui";
import { getSessionTitle, useTaskContext } from "@/lib/pi/task-context";
import { useT } from "@/lib/i18n";
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
        /* A modal request holds the extension's turn open until we answer, and
           the only answer a dismissal can send is `cancelled` — for a Plan-mode
           question that means the agent resumes under an assumption the user
           never made. Far too destructive to hang off a stray click on the
           transcript behind the sheet, so pointer dismissal is off; Escape and
           the explicit Cancel button stay as the deliberate ways out. */
        disablePointerDismissal
        onOpenChange={(open, details) => {
          if (open || !current) return;
          // Belt and braces: `disablePointerDismissal` should stop these from
          // ever arriving, but a library default flipping back would silently
          // reintroduce accidental cancellation, so refuse the reasons that are
          // not a deliberate act by the user.
          if (details.reason === "outside-press" || details.reason === "focus-out") {
            return;
          }
          respond(current, { cancelled: true }, { closing: true });
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
            {/* keyed by request: the sheet stays mounted while the queue
                advances, so without this the next prompt inherits the previous
                one's draft text and ignores its own `prefill` */}
            <SheetBody key={current.id} req={current} />
          </DialogContent>
        )}
      </Dialog>
      <NotifyToasts />
    </>
  );
}

function SheetBody({ req }: { req: QueuedExtRequest }) {
  const respond = useExtUi((s) => s.respond);
  const pending = useExtUi((s) => s.queue.length);
  const activeTaskId = useTaskContext((s) => s.activeTaskId);
  const [text, setText] = useState(req.prefill ?? "");
  const t = useT();

  /* Requests are queued across every conversation, so the one on screen may
     belong to a task the user is not looking at. Naming it is the difference
     between "why am I being asked this" and a legible prompt. */
  const foreign = req.taskId !== activeTaskId;
  const askedBy = foreign ? getSessionTitle(req.taskId) : "";

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
        {(askedBy || pending > 1) && (
          <div
            style={{
              display: "flex",
              gap: 8,
              margin: "6px 0 0",
              fontSize: 11,
              color: "var(--text-tertiary)",
            }}
          >
            {askedBy && <span>{t("ext.fromSession", { name: askedBy })}</span>}
            {pending > 1 && (
              <span>{t("ext.morePending", { count: pending - 1 })}</span>
            )}
          </div>
        )}
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

      {/* body per method — options only, deliberately no free-text field.
          `select` answers with one of `options`; anything else violates the
          contract. Callers reject it rather than accept it: pi-plan-mode maps
          the reply back with `choices.indexOf(answer)`, so typed text lands on
          index -1 and the whole question is discarded as *cancelled* — a
          carefully written answer read as "user gave up". Extensions that want
          free text already do it correctly, by offering an "Other" option and
          sending a follow-up `editor` request when it is picked. That follow-up
          arrives here as its own prompt, which is why an input appeared under
          the options: it was the second request, not part of this one. */}
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
                : { cancelled: true },
              // the user's way out: it must dismiss even if the write fails,
              // otherwise a dead pipe leaves the sheet with no exit at all
              { closing: true }
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
