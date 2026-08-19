"use client";

import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { AnimatePresence } from "motion/react";
import { Dialog, DialogContent } from "@appica/ui-react/dialog";
import { Button } from "@appica/ui-react/button";
import { Input } from "@appica/ui-react/input";
import { ArrowLeft, ArrowRight, RefreshCw, Shield, ShieldAlert, Trash2, X } from "lucide-react";
import { useBrowser, initBrowserEvents } from "@/lib/browser/store";
import { useT } from "@/lib/i18n";

/**
 * In-app browser pane (Codex `in_app_browser` analog).
 *
 * The live view is a CDP screenshot stream rendered into an <img>; the pane
 * forwards clicks as CDP Input events. Navigating to a host outside the
 * allowlist parks the navigation and pops the origin-approval dialog
 * (`access_browser_origin` analog).
 */
export function BrowserPanel() {
  const t = useT();
  const {
    status,
    loading,
    frame,
    frameStale,
    urlDraft,
    approval,
    allowlist,
    lastError,
    start,
    stop,
    go,
    navigate,
    approveOrigin,
    loadAllowlist,
    removeAllowedOrigin,
    click,
    setUrlDraft,
    reload,
    back,
    forward,
    refresh,
    clearError,
    dispose,
  } = useBrowser();
  const viewRef = useRef<HTMLImageElement | null>(null);
  const [starting, setStarting] = useState(false);
  const [showAllowlist, setShowAllowlist] = useState(false);

  useEffect(() => {
    void initBrowserEvents();
    void refresh();
    void loadAllowlist();
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = status?.running ?? false;

  const handleStart = async () => {
    setStarting(true);
    await start();
    setStarting(false);
  };

  const handleClick = (event: React.MouseEvent<HTMLImageElement>) => {
    const image = viewRef.current;
    if (!image) return;
    const rect = image.getBoundingClientRect();
    // Map click coordinates onto the rendered frame (CSS pixels → CDP CSS px).
    const scaleX = image.naturalWidth ? image.naturalWidth / rect.width : 1;
    const scaleY = image.naturalHeight ? image.naturalHeight / rect.height : 1;
    const x = (event.clientX - rect.left) * scaleX;
    const y = (event.clientY - rect.top) * scaleY;
    void click(x, y);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void go();
  };

  return (
    <div
      className="material-thin"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        borderRadius: "var(--radius-lg)",
        border: "1px solid var(--separator)",
        overflow: "hidden",
      }}
    >
      {/* Toolbar: back / forward / reload / address bar / stop */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 10px",
          borderBottom: "1px solid var(--separator)",
        }}
      >
        <ToolbarButton disabled={!running} onClick={back} title={t("browser.back")}>
          <ArrowLeft size={15} />
        </ToolbarButton>
        <ToolbarButton disabled={!running} onClick={forward} title={t("browser.forward")}>
          <ArrowRight size={15} />
        </ToolbarButton>
        <ToolbarButton disabled={!running} onClick={reload} title={t("browser.reload")}>
          <RefreshCw size={14} />
        </ToolbarButton>
        <Input
          value={urlDraft}
          onChange={(event) => setUrlDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("browser.addressPlaceholder")}
          disabled={!running}
          style={{
            flex: 1,
            height: 28,
            fontSize: 12,
            background: "var(--surface)",
            borderRadius: "var(--radius-sm)",
          }}
        />
        <ToolbarButton
          onClick={() => {
            void loadAllowlist();
            setShowAllowlist(true);
          }}
          title={t("browser.allowlistTitle")}
        >
          <Shield size={14} />
        </ToolbarButton>
        {running ? (
          <ToolbarButton onClick={stop} title={t("browser.stop")}>
            <X size={15} />
          </ToolbarButton>
        ) : (
          <Button
            size="sm"
            onClick={() => void handleStart()}
            disabled={starting}
            style={{ height: 28, fontSize: 12 }}
          >
            {starting ? t("browser.starting") : t("browser.start")}
          </Button>
        )}
      </div>

      {/* Live view */}
      <div
        style={{
          position: "relative",
          flex: 1,
          background: "var(--surface)",
          overflow: "hidden",
          display: "grid",
          placeItems: "center",
        }}
      >
        {loading && (
          <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
            {t("browser.loading")}
          </div>
        )}
        {running ? (
          frame ? (
            <>
              <img
                ref={viewRef}
                src={frame}
                alt={t("browser.liveView")}
                onClick={handleClick}
                draggable={false}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  cursor: "crosshair",
                  userSelect: "none",
                  opacity: frameStale ? 0.6 : 1,
                }}
              />
              {frameStale && (
                <div
                  style={{
                    position: "absolute",
                    bottom: 10,
                    left: "50%",
                    transform: "translateX(-50%)",
                    padding: "5px 12px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--material-regular)",
                    border: "1px solid var(--separator)",
                    fontSize: 11,
                    color: "var(--text-tertiary)",
                  }}
                >
                  {t("browser.frameStale")}
                </div>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              {t("browser.waitingFrame")}
            </div>
          )
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 10,
              padding: 24,
            }}
          >
            <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
              {t("browser.idleTitle")}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-tertiary)", maxWidth: 300, textAlign: "center" }}>
              {t("browser.idleHint")}
            </div>
            <Button size="sm" onClick={() => void handleStart()} disabled={starting}>
              {starting ? t("browser.starting") : t("browser.start")}
            </Button>
          </div>
        )}
      </div>

      {/* Origin approval dialog */}
      <AnimatePresence>
        {approval && (
          <Dialog open onOpenChange={() => void approveOrigin(false)}>
            <DialogContent
              closeButton={false}
              className="material"
              style={{
                width: 420,
                maxWidth: "86vw",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--separator)",
                boxShadow: "var(--shadow-lg)",
                padding: 0,
                background: "var(--material-regular)",
              }}
            >
              <div style={{ padding: "18px 20px 0", display: "flex", gap: 10 }}>
                <ShieldAlert size={20} style={{ color: "var(--warning)", flexShrink: 0, marginTop: 2 }} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t("browser.approveTitle")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 6 }}>
                    {t("browser.approveBody", { origin: approval.origin })}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      marginTop: 8,
                      padding: "6px 8px",
                      borderRadius: "var(--radius-sm)",
                      background: "var(--surface)",
                      wordBreak: "break-all",
                    }}
                  >
                    {approval.url}
                  </div>
                </div>
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "flex-end",
                  gap: 8,
                  padding: "14px 20px 18px",
                }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void approveOrigin(false)}
                >
                  {t("browser.approveDeny")}
                </Button>
                <Button size="sm" onClick={() => void approveOrigin(true)}>
                  {t("browser.approveAllow")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>

      {/* Approved-origins management dialog */}
      <AnimatePresence>
        {showAllowlist && (
          <Dialog open onOpenChange={() => setShowAllowlist(false)}>
            <DialogContent
              closeButton={false}
              className="material"
              style={{
                width: 420,
                maxWidth: "86vw",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--separator)",
                boxShadow: "var(--shadow-lg)",
                padding: 0,
                background: "var(--material-regular)",
              }}
            >
              <div style={{ padding: "18px 20px 12px", display: "flex", gap: 10, alignItems: "flex-start" }}>
                <Shield size={18} style={{ color: "var(--success)", flexShrink: 0, marginTop: 2 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t("browser.allowlistTitle")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>
                    {t("browser.allowlistHint")}
                  </div>
                </div>
              </div>
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  padding: "0 20px 12px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                {allowlist.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--text-tertiary)", padding: "8px 0" }}>
                    {t("browser.allowlistEmpty")}
                  </div>
                ) : (
                  allowlist.map((origin) => (
                    <div
                      key={origin}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: "var(--radius-sm)",
                        background: "var(--surface)",
                        fontSize: 12,
                      }}
                    >
                      <span style={{ flex: 1, wordBreak: "break-all" }}>{origin}</span>
                      <button
                        onClick={() => void removeAllowedOrigin(origin)}
                        title={t("browser.allowlistRemove")}
                        style={{
                          display: "grid",
                          placeItems: "center",
                          width: 22,
                          height: 22,
                          border: "none",
                          background: "transparent",
                          color: "var(--text-tertiary)",
                          cursor: "pointer",
                          borderRadius: "var(--radius-sm)",
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 20px 16px" }}>
                <Button size="sm" variant="ghost" onClick={() => setShowAllowlist(false)}>
                  {t("common.close")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        )}
      </AnimatePresence>

      {/* Error toast */}
      <AnimatePresence>
        {lastError && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            style={{
              position: "absolute",
              bottom: 14,
              left: "50%",
              transform: "translateX(-50%)",
              padding: "8px 14px",
              borderRadius: "var(--radius-md)",
              background: "var(--material-regular)",
              border: "1px solid var(--separator)",
              boxShadow: "var(--shadow-md)",
              fontSize: 12,
              color: "var(--danger)",
              zIndex: 30,
              cursor: "pointer",
            }}
            onClick={clearError}
          >
            {lastError}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ToolbarButton({
  children,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.9 }}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: "grid",
        placeItems: "center",
        width: 26,
        height: 26,
        borderRadius: "var(--radius-sm)",
        border: "none",
        background: "transparent",
        color: disabled ? "var(--text-tertiary)" : "var(--text-secondary)",
        cursor: disabled ? "default" : "pointer",
        flexShrink: 0,
      }}
    >
      {children}
    </motion.button>
  );
}
