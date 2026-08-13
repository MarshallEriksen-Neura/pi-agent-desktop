import { memo } from "react";
import { t } from "@/i18n";

/**
 * ErrorStateView — 崩溃屏 / 路由错误屏的共享呈现层。
 *
 * 设计论点(见 .crashview CSS):手机外壳崩溃时,桌面端的 pi agent 仍在跑
 * 任务。所以这一屏不是道歉,而是一份**非对称报告**:这一端断了,那一端好
 * 着,你的任务没丢。视觉由 Secure Tether 的第五态 `crashed` 承担——产品
 * 标志本身讲出这件事,而不是靠一段安慰文案。
 *
 * 依赖纪律:本文件只用 React + t() + CSS 类。不引 store(import 即触发
 * 副作用)、不引 motion(动画走 CSS)、不引 lucide。兜底组件自己崩掉是最
 * 难看的失败模式,所以它的依赖面必须小到不可能崩。
 */

/**
 * tone 决定「视觉说的是不是实话」,这是本组件唯一的分支理由:
 *
 *  - crashed:确实断了。断口 + 死链 + 红锁。
 *  - stale:链路和证书锁都好着,坏的只是已加载的那份 JS。画成断裂是在说谎,
 *    所以链路保持绿流光,只把手机端标成 accent 并给一个刷新记号,全程无红色。
 *  - neutral:与链路无关(如 404 地址不存在)。干脆不画 tether——为一个拼错
 *    的地址展示产品标志的故障态,是把无关的事说成故障。
 */
export type ErrorTone = "crashed" | "stale" | "neutral";

/**
 * 崩溃态 tether — 与 SecureTether.tsx 的 TetherSvg 共用几何与 CSS 类,但
 * 独立成一份内联 SVG:layer 1 必须能在「模块图任意一处崩了」的情况下渲染,
 * 不能 import 产品标志组件(它引了 motion 和 connection.store)。
 *
 * 几何对齐原件:desktop 6..62,link 64→116(apex ≈90),lock 在 83,
 * phone 124..158。断口落在 link 的手机侧(x≈100)。
 */
const StateTether = memo(function StateTether({ tone }: { tone: "crashed" | "stale" }) {
  return (
    <div
      className="tether"
      data-state={tone === "stale" ? "stale" : "crashed"}
      role="img"
      aria-label={tone === "stale" ? t("crash.tetherAltStale") : t("crash.tetherAlt")}
    >
      <svg width="180" height="64" viewBox="0 0 180 64" aria-hidden="true">
        {/* desktop glyph — 保持正常描边:那一端没事 */}
        <rect className="desktop-glyph" x="6" y="10" width="56" height="40" rx="6" />
        <line className="desktop-glyph" x1="24" y1="54" x2="44" y2="54" />

        {/* crashed:死链虚线打底,活链盖在上面只亮桌面侧一半 */}
        {tone === "crashed" && <path className="link-dead" d="M64 30 Q90 8 116 30" />}
        <path className="link" d="M64 30 Q90 8 116 30" />

        {/* crashed:断口折断标记(手机侧) */}
        {tone === "crashed" && (
          <g className="fracture">
            <path d="M99 13 l5 5" />
            <path d="M104 12 l-5 6" />
          </g>
        )}

        {/* lock node — Certificate Pin。stale 下保持绿:证书锁定没出问题 */}
        <g transform="translate(83,8)">
          <rect className="lock" x="0" y="6" width="14" height="11" rx="2.5" />
          <path className="lock" d="M3 6 V4 a4 4 0 0 1 8 0 V6" />
        </g>

        {/* phone glyph */}
        <rect className="phone-glyph" x="124" y="8" width="34" height="50" rx="8" />
        <line className="phone-glyph" x1="135" y1="14" x2="147" y2="14" />

        {/* stale:手机端的刷新记号 — 要动的是这一端 */}
        {tone === "stale" && (
          <g className="refresh-mark" transform="translate(133,26)">
            <path d="M0 5 a5 5 0 1 1 1.6 3.7" />
            <path d="M0 0.5 V5 H4.2" />
          </g>
        )}
      </svg>
    </div>
  );
});

export interface ErrorAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "outline";
}

/**
 * @param variant `fatal` 全屏(壳崩了);`inline` 卡片(壳还活着,底部 tab 可用)
 * @param tone 见 ErrorTone —— 决定 tether 画成什么样、标签用什么颜色
 * @param deskAlive 是否显示「桌面端仍在运行」。仅当确实与桌面无关时关掉
 * @param diagnostics mono 诊断文本,折叠在 details 里,长按可复制
 */
export const ErrorStateView = memo(function ErrorStateView({
  errorName,
  title,
  detail,
  actions,
  diagnostics,
  variant = "fatal",
  tone = "crashed",
  deskAlive = true,
}: {
  errorName: string;
  title: string;
  detail: string;
  actions: ErrorAction[];
  diagnostics?: string;
  variant?: "fatal" | "inline";
  tone?: ErrorTone;
  deskAlive?: boolean;
}) {
  return (
    <div
      className={variant === "inline" ? "crashview inline" : "crashview"}
      data-tone={tone}
      role="alert"
    >
      {tone !== "neutral" && <StateTether tone={tone} />}

      <div className="fracture-label">
        {tone === "crashed" ? "✗ " : ""}
        {errorName}
      </div>

      <h1>{title}</h1>
      <p>{detail}</p>

      {deskAlive && (
        <div className="desk-alive">
          <span className="dot" aria-hidden="true" />
          {t("crash.deskAlive")}
        </div>
      )}

      {diagnostics && (
        <details className="diag">
          <summary>{t("crash.diagnostics")}</summary>
          <pre>{diagnostics}</pre>
          <button
            type="button"
            className="copy"
            onClick={() => {
              // clipboard 在 WebView 里可能不可用(非安全上下文 / 权限),
              // 失败时静默:诊断文本本身已经可长按选中,复制只是便利。
              void navigator.clipboard?.writeText(diagnostics).catch(() => {});
            }}
          >
            {t("crash.copy")}
          </button>
        </details>
      )}

      <div className="actions">
        {actions.map((a) => (
          <button
            key={a.label}
            type="button"
            className={`btn-block ${a.variant ?? "outline"}`}
            onClick={a.onClick}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
});
