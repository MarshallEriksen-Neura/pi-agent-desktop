"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Button } from "@appica/ui-react/button";
import {
  TriangleAlert,
  Gem,
  SunMoon,
  Zap,
  Ellipsis,
  Shrink,
  RotateCw,
  RotateCcw,
  Braces,
  Activity,
  GitBranch,
  Image as ImageIcon,
  ImageOff,
  Radio,
  FileText,
  ArrowDownToLine,
  ChevronRight,
  Bell,
} from "lucide-react";
import { APP_VERSION } from "@/lib/update";
import { usePiSettings, type SettingsScope, type PiSettings } from "@/lib/pi/settings";
import { usePi, THINKING_LEVELS } from "@/lib/pi/store";
import { useRuntime } from "@/lib/pi/runtime";
import { isTauri } from "@/lib/pi/client";
import { useWorkspace } from "@/lib/workspace";
import { useI18n, useT } from "@/lib/i18n";
import type { ThinkingLevel } from "@/lib/pi/protocol";
import {
  useAppearance,
  imageFileToDataUrl,
  ACCENT_PRESETS,
  BG_PRESETS,
  TEXT_PRESETS,
  FONT_SCALES,
} from "@/lib/appearance";
import {
  requestNotificationPermission,
  refreshNotificationPermission,
  type NotificationPermissionState,
} from "@/lib/notifications";
import { useUI } from "@/lib/store";
import {
  SettingsPage,
  InsetGroup,
  GroupRow,
  IOSSwitch,
  Segmented,
  ColorSwatches,
  TextRow,
  NumberRow,
  SliderRow,
  CodeArea,
} from "@/components/settings-ui";
import { PetSettings } from "@/components/PetSettings";

const TRUST_OPTIONS = ["ask", "always", "never"] as const;
const BUILTIN_THEMES = ["dark", "light"] as const;
const THEME_OPTIONS = ["dark", "light", "custom"] as const;
const DELIVERY_OPTIONS = ["one-at-a-time", "all"] as const;
const TRANSPORT_OPTIONS = ["auto", "sse", "websocket", "websocket-cached"] as const;
/** thinkingBudgets levels with pi's built-in defaults (docs/settings.md) */
const THINKING_BUDGET_DEFAULTS = {
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 32768,
} as const;

/** read a dotted path ("retry.provider.timeoutMs") off a settings object */
function getPath(obj: PiSettings, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (o, k) =>
        o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined,
      obj
    );
}

/** display labels for the UI text-scale steps (locale-neutral) */
const FONT_SCALE_LABELS = FONT_SCALES.map((s) => `${Math.round(s * 100)}%`);

export default function PiSettingsPage() {
  const s = usePiSettings();
  const { currentModel } = usePi();
  const [scope, setScope] = useState<SettingsScope>("global");
  const { locale, setLocale } = useI18n();
  const ap = useAppearance();
  const t = useT();
  const router = useRouter();
  const { notificationSettings, setNotificationEnabled, closeBehavior, setCloseBehavior } =
    useUI();
  const [notifPermission, setNotifPermission] =
    useState<NotificationPermissionState>("default");

  useEffect(() => {
    s.load();
    // Check notification permission on mount (async on the Tauri path)
    void refreshNotificationPermission().then(setNotifPermission);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const file = scope === "global" ? s.global : s.project;
  const own: PiSettings = useMemo(() => file.data ?? {}, [file]);
  // effective() deep-merges global+project on every call; only recompute when
  // the underlying data actually changes (already subscribed via `s`).
  const effective = useMemo(
    () => s.effective(),
    [s.global.data, s.project.data]
  );

  /** where a displayed value comes from: this scope's file, or inherited (dotted paths OK) */
  const inherited = (key: string) =>
    scope === "project" &&
    getPath(own, key) === undefined &&
    getPath(effective, key) !== undefined;

  const dim = (key: string): React.CSSProperties =>
    inherited(key) ? { opacity: 0.45 } : {};

  /** effective value helpers for the input rows */
  const num = (key: string) => getPath(effective, key) as number | undefined;
  const str = (key: string) => getPath(effective, key) as string | undefined;

  const compaction = (effective.compaction ?? {}) as { enabled?: boolean };
  const retry = (effective.retry ?? {}) as { enabled?: boolean };

  /** background image picker — reads the file, downscales, applies instantly */
  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!f) return;
    try {
      ap.set({ bgImage: await imageFileToDataUrl(f) });
    } catch {
      // undecodable file — leave the current background untouched
    }
  };

  /** theme segmented state — "custom" keeps the name input visible before commit */
  const themeVal = effective.theme;
  const isCustomTheme =
    themeVal !== undefined &&
    !(BUILTIN_THEMES as readonly string[]).includes(themeVal);
  const [themeCustomMode, setThemeCustomMode] = useState(false);
  const themeSeg: (typeof THEME_OPTIONS)[number] =
    isCustomTheme || themeCustomMode
      ? "custom"
      : ((themeVal as (typeof BUILTIN_THEMES)[number]) ?? "dark");

  return (
    <SettingsPage
      title={t("settings.title")}
      subtitle={s.mock ? t("settings.subtitleMock") : t("settings.subtitleLive")}
    >
      {/* restart-needed banner */}
      <AnimatePresence>
        {s.dirtyRestart && (
          <motion.div
            initial={{ opacity: 0, y: -8, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -8, height: 0 }}
            style={{ overflow: "hidden" }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginTop: 16,
                padding: "10px 14px",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--separator)",
                background: "var(--accent-muted)",
                fontSize: 13,
                color: "var(--text-primary)",
              }}
            >
              <span style={{ flex: 1 }}>{t("settings.saved")}</span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => s.restartPi()}
                disabled={s.busy}
                style={{ borderRadius: 8, opacity: s.busy ? 0.6 : 1 }}
              >
                {s.busy ? t("settings.restarting") : t("settings.restartPi")}
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* UI language — app-local, not part of pi's settings.json */}
      <InsetGroup
        header={t("settings.language")}
        footer={t("settings.languageFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["English", "中文"] as const}
            value={locale === "zh" ? "中文" : "English"}
            onChange={(v) => setLocale(v === "中文" ? "zh" : "en")}
          />
        </div>
      </InsetGroup>

      {/* command environment — Windows only: route Pi's Bash through WSL */}
      <RuntimeSection />

      {/* user-customizable UI — app-local, not part of pi's settings.json */}
      <InsetGroup
        header={t("settings.customUi")}
        footer={t("settings.customUiFooter")}
      >
        {(
          [
            {
              key: "accent",
              label: t("settings.accentColor"),
              value: ap.accent,
              presets: ACCENT_PRESETS,
              set: (v: string | null) => ap.set({ accent: v }),
            },
            {
              key: "background",
              label: t("settings.bgColor"),
              value: ap.background,
              presets: BG_PRESETS,
              set: (v: string | null) => ap.set({ background: v }),
            },
            {
              key: "text",
              label: t("settings.textColor"),
              value: ap.textColor,
              presets: TEXT_PRESETS,
              set: (v: string | null) => ap.set({ textColor: v }),
            },
          ] as const
        ).map((row, i) => (
          <div
            key={row.key}
            style={{
              padding: "12px 14px",
              borderTop: i === 0 ? "none" : "1px solid var(--separator)",
            }}
          >
            <div
              style={{
                fontSize: 12,
                color: "var(--text-tertiary)",
                marginBottom: 8,
              }}
            >
              {row.label}
            </div>
            <ColorSwatches
              value={row.value}
              onChange={row.set}
              presets={row.presets}
              defaultLabel={t("settings.defaultOption")}
              customLabel={t("settings.customColor")}
            />
          </div>
        ))}

        {/* background image — full-window picture behind translucent surfaces */}
        <div
          style={{ padding: "12px 14px", borderTop: "1px solid var(--separator)" }}
        >
          <div
            style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}
          >
            {t("settings.bgImage")} — {t("settings.bgImageDetail")}
          </div>
          {ap.bgImage && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={ap.bgImage}
              alt=""
              style={{
                display: "block",
                width: "100%",
                height: 96,
                objectFit: "cover",
                borderRadius: 10,
                border: "1px solid var(--separator)",
                marginBottom: 10,
              }}
            />
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="outline" size="sm" style={{ borderRadius: 8, position: "relative", overflow: "hidden" }}>
              {ap.bgImage ? t("settings.replaceImage") : t("settings.chooseImage")}
              <input
                type="file"
                accept="image/*"
                onChange={onPickImage}
                aria-label={t("settings.chooseImage")}
                style={{
                  position: "absolute",
                  inset: 0,
                  opacity: 0,
                  cursor: "pointer",
                }}
              />
            </Button>
            {ap.bgImage && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => ap.set({ bgImage: null })}
                style={{ borderRadius: 8, color: "var(--danger, #E5484D)" }}
              >
                {t("settings.removeImage")}
              </Button>
            )}
          </div>
          {ap.bgImage && (
            <>
              <SliderRow
                label={t("settings.surfaceOpacity")}
                value={Math.round(ap.bgSurfaceOpacity * 100)}
                min={20}
                max={100}
                onChange={(v) => ap.set({ bgSurfaceOpacity: v / 100 })}
                format={(v) => `${v}%`}
              />
              <SliderRow
                label={t("settings.imageBlur")}
                value={ap.bgImageBlur}
                min={0}
                max={24}
                onChange={(v) => ap.set({ bgImageBlur: v })}
                format={(v) => `${v}px`}
              />
            </>
          )}
        </div>

        <div
          style={{ padding: "12px 14px", borderTop: "1px solid var(--separator)" }}
        >
          <div
            style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}
          >
            {t("settings.fontSize")} — {t("settings.fontSizeDetail")}
          </div>
          <Segmented
            options={FONT_SCALE_LABELS}
            value={
              FONT_SCALE_LABELS[
                Math.max(0, FONT_SCALES.indexOf(ap.fontScale as (typeof FONT_SCALES)[number]))
              ]
            }
            onChange={(v) =>
              ap.set({ fontScale: FONT_SCALES[FONT_SCALE_LABELS.indexOf(v)] })
            }
          />
        </div>

        {ap.customized() && (
          <GroupRow
            icon={<RotateCcw size={15} />}
            iconBg="var(--gray-1)"
            title={t("settings.resetAppearance")}
            detail={t("settings.resetAppearanceDetail")}
            onClick={() => ap.reset()}
          />
        )}
      </InsetGroup>

      {/* custom CSS — pasted styles injected live into the app */}
      <InsetGroup
        header={t("settings.customCss")}
        footer={t("settings.customCssFooter")}
      >
        <div style={{ padding: "12px 14px" }}>
          <CodeArea
            value={ap.customCss}
            onChange={(css) => ap.set({ customCss: css })}
            placeholder={t("settings.customCssPlaceholder")}
          />
        </div>
      </InsetGroup>

      {/* scope switch — mirrors `pi config` (Tab toggles global/project) */}
      <InsetGroup
        header={t("settings.scope")}
        footer={
          scope === "global"
            ? t("settings.scopeGlobalFooter", {
                path: s.global.path || "~/.pi/agent/settings.json",
              })
            : t("settings.scopeProjectFooter", {
                path: s.project.path || ".pi/settings.json",
              })
        }
      >
        <div style={{ padding: "12px 14px" }}>
          <Segmented
            options={["global", "project"] as const}
            value={scope}
            onChange={setScope}
          />
        </div>
      </InsetGroup>

      {file.parseError ? (
        <InsetGroup header={t("settings.problem")}>
          <GroupRow
            first
            icon={<TriangleAlert size={15} />}
            iconBg="var(--danger, #E5484D)"
            title={t("settings.invalidJson")}
            detail={file.parseError}
          />
        </InsetGroup>
      ) : (
        <>
          {/* model defaults — pointer to Models page for the picker */}
          <InsetGroup
            header={t("settings.modelDefaults")}
            footer={t("settings.modelDefaultsFooter")}
          >
            <div style={dim("defaultModel")}>
              <GroupRow
                first
                icon={<Gem size={15} />}
                title={t("settings.defaultModel")}
                detail={
                  effective.defaultModel
                    ? `${effective.defaultProvider ?? "?"} / ${effective.defaultModel}`
                    : t("settings.defaultModelUnset")
                }
                trailing={
                  currentModel &&
                  (currentModel.id !== effective.defaultModel ||
                    currentModel.provider !== effective.defaultProvider) ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        s.setKey(scope, "defaultProvider", currentModel.provider);
                        s.setKey(scope, "defaultModel", currentModel.id);
                      }}
                      style={{ borderRadius: 8, color: "var(--accent)", fontWeight: 600 }}
                    >
                      {t("settings.useCurrent")}
                    </Button>
                  ) : undefined
                }
              />
            </div>
            <div style={{ padding: "12px 14px", ...dim("defaultThinkingLevel") }}>
              <div
                style={{
                  fontSize: 12,
                  color: "var(--text-tertiary)",
                  marginBottom: 8,
                }}
              >
                {t("settings.defaultThinkingLevel")}
              </div>
              <Segmented
                options={THINKING_LEVELS}
                value={(effective.defaultThinkingLevel as ThinkingLevel) ?? "medium"}
                onChange={(v) => s.setKey(scope, "defaultThinkingLevel", v)}
              />
            </div>
            <div style={dim("showCacheMissNotices")}>
              <GroupRow
                icon={<Activity size={15} />}
                title={t("settings.cacheMissNotices")}
                detail={t("settings.cacheMissNoticesDetail")}
                trailing={
                  <IOSSwitch
                    checked={effective.showCacheMissNotices === true}
                    onChange={(v) => s.setKey(scope, "showCacheMissNotices", v)}
                  />
                }
              />
            </div>
          </InsetGroup>

          {/* thinking budgets — token budget per thinking level */}
          <InsetGroup
            header={t("settings.thinkingBudgets")}
            footer={t("settings.thinkingBudgetsFooter")}
          >
            {(
              Object.entries(THINKING_BUDGET_DEFAULTS) as [
                keyof typeof THINKING_BUDGET_DEFAULTS,
                number,
              ][]
            ).map(([level, def], i) => (
              <NumberRow
                key={level}
                first={i === 0}
                label={level}
                value={num(`thinkingBudgets.${level}`)}
                placeholder={String(def)}
                min={1}
                dimmed={inherited(`thinkingBudgets.${level}`)}
                onCommit={(v) => s.setPath(scope, `thinkingBudgets.${level}`, v)}
              />
            ))}
          </InsetGroup>

          {/* appearance & startup */}
          <InsetGroup header={t("settings.appearance")}>
            <div style={dim("theme")}>
              <GroupRow
                first
                icon={<SunMoon size={15} />}
                title={t("settings.theme")}
                trailing={
                  <div style={{ width: 220 }}>
                    <Segmented
                      options={THEME_OPTIONS}
                      value={themeSeg}
                      onChange={(v) => {
                        if (v === "custom") {
                          setThemeCustomMode(true);
                        } else {
                          setThemeCustomMode(false);
                          s.setKey(scope, "theme", v);
                        }
                      }}
                    />
                  </div>
                }
              />
              {themeSeg === "custom" && (
                <TextRow
                  label={t("settings.customTheme")}
                  detail={t("settings.customThemeDetail")}
                  value={isCustomTheme ? themeVal : undefined}
                  placeholder="e.g. catppuccin-mocha"
                  onCommit={(v) => {
                    if (v === undefined) setThemeCustomMode(false);
                    s.setKey(scope, "theme", v);
                  }}
                />
              )}
            </div>
            <TextRow
              label={t("settings.externalEditor")}
              detail={t("settings.externalEditorDetail")}
              value={own.externalEditor as string | undefined}
              placeholder={str("externalEditor") ?? "code --wait"}
              dimmed={inherited("externalEditor")}
              onCommit={(v) => s.setKey(scope, "externalEditor", v)}
            />
            <div style={dim("quietStartup")}>
              <GroupRow
                icon={<Zap size={15} />}
                title={t("settings.quietStartup")}
                detail={t("settings.quietStartupDetail")}
                trailing={
                  <IOSSwitch
                    checked={effective.quietStartup === true}
                    onChange={(v) => s.setKey(scope, "quietStartup", v)}
                  />
                }
              />
            </div>
            <div style={dim("hideThinkingBlock")}>
              <GroupRow
                icon={<Ellipsis size={15} />}
                title={t("settings.hideThinking")}
                detail={t("settings.hideThinkingDetail")}
                trailing={
                  <IOSSwitch
                    checked={effective.hideThinkingBlock === true}
                    onChange={(v) => s.setKey(scope, "hideThinkingBlock", v)}
                  />
                }
              />
            </div>
          </InsetGroup>

          {/* behavior */}
          <InsetGroup
            header={t("settings.agentBehavior")}
            footer={t("settings.agentBehaviorFooter")}
          >
            <div style={dim("compaction")}>
              <GroupRow
                first
                icon={<Shrink size={15} />}
                title={t("settings.autoCompaction")}
                trailing={
                  <IOSSwitch
                    checked={compaction.enabled !== false}
                    onChange={(v) => s.setPath(scope, "compaction.enabled", v)}
                  />
                }
              />
            </div>
            <NumberRow
              label={t("settings.reserveTokens")}
              detail={t("settings.reserveTokensDetail")}
              value={num("compaction.reserveTokens")}
              placeholder="16384"
              min={0}
              dimmed={inherited("compaction.reserveTokens")}
              onCommit={(v) => s.setPath(scope, "compaction.reserveTokens", v)}
            />
            <NumberRow
              label={t("settings.keepRecentTokens")}
              detail={t("settings.keepRecentTokensDetail")}
              value={num("compaction.keepRecentTokens")}
              placeholder="20000"
              min={0}
              dimmed={inherited("compaction.keepRecentTokens")}
              onCommit={(v) => s.setPath(scope, "compaction.keepRecentTokens", v)}
            />
            <div style={dim("retry")}>
              <GroupRow
                icon={<RotateCw size={15} />}
                title={t("settings.autoRetry")}
                trailing={
                  <IOSSwitch
                    checked={retry.enabled !== false}
                    onChange={(v) => s.setPath(scope, "retry.enabled", v)}
                  />
                }
              />
            </div>
            <NumberRow
              label={t("settings.maxRetries")}
              value={num("retry.maxRetries")}
              placeholder="3"
              min={0}
              dimmed={inherited("retry.maxRetries")}
              onCommit={(v) => s.setPath(scope, "retry.maxRetries", v)}
            />
            <NumberRow
              label={t("settings.baseDelayMs")}
              detail={t("settings.baseDelayMsDetail")}
              value={num("retry.baseDelayMs")}
              placeholder="2000"
              min={0}
              dimmed={inherited("retry.baseDelayMs")}
              onCommit={(v) => s.setPath(scope, "retry.baseDelayMs", v)}
            />
          </InsetGroup>

          {/* provider-level retry — advanced */}
          <InsetGroup
            header={t("settings.providerRetry")}
            footer={t("settings.providerRetryFooter")}
          >
            <NumberRow
              first
              label={t("settings.providerTimeoutMs")}
              detail={t("settings.providerTimeoutMsDetail")}
              value={num("retry.provider.timeoutMs")}
              placeholder={t("settings.sdkDefault")}
              min={0}
              dimmed={inherited("retry.provider.timeoutMs")}
              onCommit={(v) => s.setPath(scope, "retry.provider.timeoutMs", v)}
            />
            <NumberRow
              label={t("settings.providerMaxRetries")}
              detail={t("settings.providerMaxRetriesDetail")}
              value={num("retry.provider.maxRetries")}
              placeholder="0"
              min={0}
              dimmed={inherited("retry.provider.maxRetries")}
              onCommit={(v) => s.setPath(scope, "retry.provider.maxRetries", v)}
            />
            <NumberRow
              label={t("settings.providerMaxRetryDelayMs")}
              detail={t("settings.providerMaxRetryDelayMsDetail")}
              value={num("retry.provider.maxRetryDelayMs")}
              placeholder="60000"
              min={0}
              dimmed={inherited("retry.provider.maxRetryDelayMs")}
              onCommit={(v) => s.setPath(scope, "retry.provider.maxRetryDelayMs", v)}
            />
          </InsetGroup>

          {/* message delivery & transport */}
          <InsetGroup
            header={t("settings.messageDelivery")}
            footer={t("settings.messageDeliveryFooter")}
          >
            <div style={{ padding: "12px 14px", ...dim("steeringMode") }}>
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
                {t("settings.steeringMode")}
              </div>
              <Segmented
                options={DELIVERY_OPTIONS}
                value={
                  (effective.steeringMode as (typeof DELIVERY_OPTIONS)[number]) ??
                  "one-at-a-time"
                }
                onChange={(v) => s.setKey(scope, "steeringMode", v)}
              />
            </div>
            <div
              style={{
                padding: "12px 14px",
                borderTop: "1px solid var(--separator)",
                ...dim("followUpMode"),
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
                {t("settings.followUpMode")}
              </div>
              <Segmented
                options={DELIVERY_OPTIONS}
                value={
                  (effective.followUpMode as (typeof DELIVERY_OPTIONS)[number]) ??
                  "one-at-a-time"
                }
                onChange={(v) => s.setKey(scope, "followUpMode", v)}
              />
            </div>
            <div
              style={{
                padding: "12px 14px",
                borderTop: "1px solid var(--separator)",
                ...dim("transport"),
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 8 }}>
                {t("settings.transport")}
              </div>
              <Segmented
                options={TRANSPORT_OPTIONS}
                value={
                  (effective.transport as (typeof TRANSPORT_OPTIONS)[number]) ?? "auto"
                }
                onChange={(v) => s.setKey(scope, "transport", v)}
              />
            </div>
            <NumberRow
              label={t("settings.httpIdleTimeoutMs")}
              detail={t("settings.zeroDisables")}
              value={num("httpIdleTimeoutMs")}
              placeholder="300000"
              min={0}
              dimmed={inherited("httpIdleTimeoutMs")}
              onCommit={(v) => s.setKey(scope, "httpIdleTimeoutMs", v)}
            />
            <NumberRow
              label={t("settings.websocketConnectTimeoutMs")}
              detail={t("settings.zeroDisables")}
              value={num("websocketConnectTimeoutMs")}
              placeholder="15000"
              min={0}
              dimmed={inherited("websocketConnectTimeoutMs")}
              onCommit={(v) => s.setKey(scope, "websocketConnectTimeoutMs", v)}
            />
          </InsetGroup>

          {/* network — global only, like project trust */}
          {scope === "global" && (
            <InsetGroup
              header={t("settings.network")}
              footer={t("settings.networkFooter")}
            >
              <TextRow
                first
                label={t("settings.httpProxy")}
                detail={t("settings.httpProxyDetail")}
                value={effective.httpProxy as string | undefined}
                placeholder="http://127.0.0.1:7890"
                onCommit={(v) => s.setKey("global", "httpProxy", v)}
              />
            </InsetGroup>
          )}

          {/* desktop pet */}
          <InsetGroup header="Desktop Pet" footer="A companion that shows your agent's status">
            <div style={{ padding: "14px" }}>
              <PetSettings />
            </div>
          </InsetGroup>

          {/* desktop notifications */}
          <InsetGroup
            header={t("settings.notifications")}
            footer={t("settings.notificationsDetail")}
          >
            <div style={dim("notifications")}>
              <GroupRow
                first
                icon={<Bell size={15} />}
                iconBg="var(--accent)"
                title={t("settings.notifications")}
                detail={
                  notifPermission === "denied"
                    ? t("settings.notifications.denied")
                    : notifPermission === "unsupported"
                      ? t("settings.notifications.unsupported")
                      : notifPermission === "granted"
                        ? t("settings.notifications.granted")
                        : t("settings.notifications.prompt")
                }
                trailing={
                  <IOSSwitch
                    checked={notificationSettings.enabled && notifPermission === "granted"}
                    disabled={notifPermission === "unsupported"}
                    onChange={async (enabled) => {
                      if (enabled && notifPermission !== "granted") {
                        const granted = await requestNotificationPermission();
                        setNotifPermission(await refreshNotificationPermission());
                        if (granted) {
                          setNotificationEnabled(true);
                        }
                      } else {
                        setNotificationEnabled(enabled);
                      }
                    }}
                  />
                }
              />
            </div>
          </InsetGroup>

          {/* what happens when the main window is closed */}
          <InsetGroup
            header={t("settings.closeBehavior")}
            footer={t("settings.closeBehaviorFooter")}
          >
            <GroupRow
              first
              icon={<ArrowDownToLine size={15} />}
              iconBg="var(--accent)"
              title={t("settings.closeBehavior")}
              trailing={
                <div style={{ width: 300, flexShrink: 0 }}>
                      <Segmented
                        options={["ask", "minimize", "quit"] as const}
                        value={closeBehavior}
                        onChange={setCloseBehavior}
                        labelOf={(v) => t(`settings.closeBehavior.${v}`)}
                      />
                </div>
              }
            />
          </InsetGroup>

          {/* images sent to the LLM */}
          <InsetGroup header={t("settings.images")} footer={t("settings.imagesFooter")}>
            <div style={dim("images.autoResize")}>
              <GroupRow
                first
                icon={<ImageIcon size={15} />}
                title={t("settings.imagesAutoResize")}
                detail={t("settings.imagesAutoResizeDetail")}
                trailing={
                  <IOSSwitch
                    checked={getPath(effective, "images.autoResize") !== false}
                    onChange={(v) => s.setPath(scope, "images.autoResize", v)}
                  />
                }
              />
            </div>
            <div style={dim("images.blockImages")}>
              <GroupRow
                icon={<ImageOff size={15} />}
                title={t("settings.imagesBlock")}
                detail={t("settings.imagesBlockDetail")}
                trailing={
                  <IOSSwitch
                    checked={getPath(effective, "images.blockImages") === true}
                    onChange={(v) => s.setPath(scope, "images.blockImages", v)}
                  />
                }
              />
            </div>
          </InsetGroup>

          {/* branch summary — /tree navigation */}
          <InsetGroup
            header={t("settings.branchSummary")}
            footer={t("settings.branchSummaryFooter")}
          >
            <div style={dim("branchSummary.skipPrompt")}>
              <GroupRow
                first
                icon={<GitBranch size={15} />}
                title={t("settings.branchSkipPrompt")}
                detail={t("settings.branchSkipPromptDetail")}
                trailing={
                  <IOSSwitch
                    checked={getPath(effective, "branchSummary.skipPrompt") === true}
                    onChange={(v) => s.setPath(scope, "branchSummary.skipPrompt", v)}
                  />
                }
              />
            </div>
            <NumberRow
              label={t("settings.branchReserveTokens")}
              value={num("branchSummary.reserveTokens")}
              placeholder="16384"
              min={0}
              dimmed={inherited("branchSummary.reserveTokens")}
              onCommit={(v) => s.setPath(scope, "branchSummary.reserveTokens", v)}
            />
          </InsetGroup>

          {/* shell & sessions */}
          <InsetGroup
            header={t("settings.shellSessions")}
            footer={t("settings.shellSessionsFooter")}
          >
            <TextRow
              first
              label={t("settings.shellPath")}
              detail={t("settings.shellPathDetail")}
              value={own.shellPath as string | undefined}
              placeholder={str("shellPath")}
              dimmed={inherited("shellPath")}
              onCommit={(v) => s.setKey(scope, "shellPath", v)}
            />
            <TextRow
              label={t("settings.shellCommandPrefix")}
              detail={t("settings.shellCommandPrefixDetail")}
              value={own.shellCommandPrefix as string | undefined}
              placeholder={str("shellCommandPrefix")}
              dimmed={inherited("shellCommandPrefix")}
              onCommit={(v) => s.setKey(scope, "shellCommandPrefix", v)}
            />
            <TextRow
              label={t("settings.npmCommand")}
              detail={t("settings.npmCommandDetail")}
              value={
                Array.isArray(own.npmCommand) ? own.npmCommand.join(" ") : undefined
              }
              placeholder={
                Array.isArray(effective.npmCommand)
                  ? effective.npmCommand.join(" ")
                  : "mise exec node@20 -- npm"
              }
              dimmed={inherited("npmCommand")}
              onCommit={(v) =>
                s.setKey(scope, "npmCommand", v === undefined ? undefined : v.split(/\s+/))
              }
            />
            <TextRow
              label={t("settings.sessionDir")}
              detail={t("settings.sessionDirDetail")}
              value={own.sessionDir as string | undefined}
              placeholder={str("sessionDir") ?? ".pi/sessions"}
              dimmed={inherited("sessionDir")}
              onCommit={(v) => s.setKey(scope, "sessionDir", v)}
            />
          </InsetGroup>

          {/* privacy & updates */}
          <InsetGroup
            header={t("settings.privacy")}
            footer={t("settings.privacyFooter")}
          >
            <GroupRow
              first
              icon={<ArrowDownToLine size={15} />}
              iconBg="var(--success)"
              title={t("settings.softwareUpdate")}
              detail={t("settings.softwareUpdateDetail", { version: APP_VERSION })}
              trailing={<ChevronRight size={15} color="var(--text-tertiary)" />}
              onClick={() => router.push("/update/")}
            />
            <div style={dim("enableInstallTelemetry")}>
              <GroupRow
                icon={<Radio size={15} />}
                title={t("settings.installTelemetry")}
                detail={t("settings.installTelemetryDetail")}
                trailing={
                  <IOSSwitch
                    checked={effective.enableInstallTelemetry !== false}
                    onChange={(v) => s.setKey(scope, "enableInstallTelemetry", v)}
                  />
                }
              />
            </div>
            <div style={dim("collapseChangelog")}>
              <GroupRow
                icon={<FileText size={15} />}
                title={t("settings.collapseChangelog")}
                detail={t("settings.collapseChangelogDetail")}
                trailing={
                  <IOSSwitch
                    checked={effective.collapseChangelog === true}
                    onChange={(v) => s.setKey(scope, "collapseChangelog", v)}
                  />
                }
              />
            </div>
            <div style={dim("warnings.anthropicExtraUsage")}>
              <GroupRow
                icon={<TriangleAlert size={15} />}
                title={t("settings.anthropicExtraUsage")}
                detail={t("settings.anthropicExtraUsageDetail")}
                trailing={
                  <IOSSwitch
                    checked={getPath(effective, "warnings.anthropicExtraUsage") !== false}
                    onChange={(v) => s.setPath(scope, "warnings.anthropicExtraUsage", v)}
                  />
                }
              />
            </div>
          </InsetGroup>

          {/* trust — global only, per pi docs */}
          {scope === "global" && (
            <InsetGroup
              header={t("settings.projectTrust")}
              footer={t("settings.projectTrustFooter")}
            >
              <div style={{ padding: "12px 14px" }}>
                <Segmented
                  options={TRUST_OPTIONS}
                  value={
                    (effective.defaultProjectTrust as (typeof TRUST_OPTIONS)[number]) ??
                    "ask"
                  }
                  onChange={(v) => s.setKey("global", "defaultProjectTrust", v)}
                />
              </div>
            </InsetGroup>
          )}

          {/* raw file escape hatch */}
          <InsetGroup
            header={t("settings.advanced")}
            footer={t("settings.advancedFooter")}
          >
            <GroupRow
              first
              icon={<Braces size={15} />}
              iconBg="var(--gray-1)"
              title={t("settings.settingsFile")}
              detail={
                file.exists
                  ? file.path
                  : t("settings.fileWillBeCreated", { path: file.path })
              }
            />
          </InsetGroup>
        </>
      )}

      {s.lastError && (
        <p style={{ marginTop: 16, fontSize: 12.5, color: "var(--danger, #E5484D)" }}>
          {s.lastError}
        </p>
      )}
    </SettingsPage>
  );
}

/**
 * Command environment — Windows-only section for routing agent and terminal
 * Bash commands through a WSL distro. Pi itself remains native so its settings,
 * credentials, and packages do not move. Hidden on non-Windows / browser.
 */
function RuntimeSection() {
  const t = useT();
  const {
    config,
    persistedConfig,
    distros,
    lastError,
    load,
    loadDistros,
    setConfig,
    save,
  } = useRuntime();
  const piSettings = usePiSettings();
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const isWindows =
    isTauri() &&
    typeof navigator !== "undefined" &&
    /win/i.test(navigator.userAgent);

  useEffect(() => {
    if (isWindows) {
      void load();
      void loadDistros();
    }
  }, [isWindows, load, loadDistros]);

  if (!isWindows) return null;

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      if (!piSettings.loaded) await piSettings.load();
      const settings = usePiSettings.getState().global.data ?? {};
      const nextConfig =
        config.mode === "wsl" && persistedConfig.mode !== "wsl"
          ? {
              ...config,
              nativeShellPath:
                typeof settings.shellPath === "string" ? settings.shellPath : null,
              nativeShellCommandPrefix:
                typeof settings.shellCommandPrefix === "string"
                  ? settings.shellCommandPrefix
                  : null,
              nativeShellSaved: true,
            }
          : config;

      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("wsl_runtime_validate", {
        config: nextConfig,
        cwd: useWorkspace.getState().root ?? null,
      });

      if (nextConfig.mode === "wsl") {
        // Persist first: every bridge process reads the selected distro from
        // desktop.json when Pi invokes `<desktop.exe> -c <command>`.
        await save(nextConfig);
        const bridgePath = await invoke<string>("wsl_shell_bridge_path");
        await piSettings.setKey("global", "shellPath", bridgePath);
        // Older builds wrote an argument array here, but Pi only accepts a
        // command-prefix string. The bridge needs no prefix at all.
        await piSettings.setKey("global", "shellCommandPrefix", undefined);
      } else {
        await piSettings.setKey(
          "global",
          "shellPath",
          nextConfig.nativeShellPath ?? undefined
        );
        await piSettings.setKey(
          "global",
          "shellCommandPrefix",
          nextConfig.nativeShellCommandPrefix ?? undefined
        );
        await save(nextConfig);
      }

      const writeError = usePiSettings.getState().lastError;
      if (writeError) throw new Error(writeError);
      await piSettings.restartPi();
      const restartError =
        usePiSettings.getState().lastError ?? usePi.getState().lastError;
      if (restartError) throw new Error(restartError);
      setConfig(nextConfig);
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  };

  const distroOptions = ["", ...distros];
  const distroLabel = (d: string) =>
    d === "" ? t("settings.runtimeDistroDefault") : d;

  return (
    <InsetGroup header={t("settings.runtime")} footer={t("settings.runtimeFooter")}>
      <div style={{ padding: "12px 14px" }}>
        <div style={{ fontSize: 13.5, marginBottom: 7 }}>
          {t("settings.runtimeMode")}
        </div>
        <Segmented
          options={["native", "wsl"] as const}
          value={config.mode}
          onChange={(v) => setConfig({ ...config, mode: v })}
          labelOf={(v) =>
            v === "wsl" ? t("settings.runtimeWsl") : t("settings.runtimeNative")
          }
        />
      </div>

      {config.mode === "wsl" && (
        <>
          {distros.length === 0 ? (
            <div style={{ padding: "0 14px 12px", fontSize: 12.5, color: "var(--text-tertiary)" }}>
              {t("settings.runtimeNoDistros")}
            </div>
          ) : (
            <div style={{ padding: "0 14px 12px" }}>
              <div style={{ fontSize: 13.5, marginBottom: 7 }}>
                {t("settings.runtimeDistro")}
              </div>
              <Segmented
                options={distroOptions}
                value={config.distro}
                onChange={(v) => setConfig({ ...config, distro: v })}
                labelOf={distroLabel}
              />
            </div>
          )}
        </>
      )}

      <div style={{ padding: "0 14px 14px" }}>
        <Button
          variant="primary"
          size="sm"
          onClick={apply}
          disabled={applying}
          style={{ borderRadius: 8, opacity: applying ? 0.6 : 1 }}
        >
          {applying ? t("settings.restarting") : t("settings.runtimeApply")}
        </Button>
        {(applyError || lastError) && (
          <div
            role="alert"
            style={{ marginTop: 8, fontSize: 12.5, color: "var(--danger, #E5484D)" }}
          >
            {applyError || lastError}
          </div>
        )}
      </div>
    </InsetGroup>
  );
}
