import { Component } from "react";
import { t } from "@/i18n";
import { buildDiagnostics, errorNameOf, isStaleChunkError } from "@/lib/crash-report";
import { ErrorStateView } from "./ErrorStateView";

interface State {
  error: Error | null;
}

/**
 * GlobalErrorBoundary — 最后一道兜底,包住 <RouterProvider>。
 *
 * 这是移动端对标 Next `global-error` 的一层,但走的是标准 React 手段:移动端
 * 是 Vite + React Router,没有 App Router 的文件约定(桌面端那条
 * 「global-error.tsx 破坏 output:export」的坑在这里不存在)。
 *
 * 它接管 router / AppShell 自身的渲染崩溃——即 routes.tsx 的 errorElement
 * 接不到的那部分。在 Capacitor WebView 里这一层格外重要:白屏之后没有地址栏、
 * 没有刷新按钮、没有 devtools,用户只能强杀进程。
 *
 * 依赖纪律见 ErrorStateView。t() 是安全的:纯静态字典读取,无 store、无异步。
 * 文案兜底写了中文硬编码,万一 i18n 模块本身是崩因也还能读。
 */
export class GlobalErrorBoundary extends Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("[fatal] app shell crashed", error, info.componentStack);
  }

  private reload = () => {
    location.reload();
  };

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const stale = isStaleChunkError(error);

    return (
      <ErrorStateView
        variant="fatal"
        tone={stale ? "stale" : "crashed"}
        errorName={stale ? t("crash.staleChunkName") : errorNameOf(error)}
        title={stale ? t("crash.staleChunkTitle") : t("crash.fatalTitle")}
        detail={stale ? t("crash.staleChunkDetail") : t("crash.fatalDetail")}
        diagnostics={buildDiagnostics(error, { layer: "shell" })}
        actions={
          stale
            ? // chunk 失效只有重载能修,不给「重试」——重试必然再次失败
              [{ label: t("crash.reload"), onClick: this.reload, variant: "primary" }]
            : [
                { label: t("crash.reload"), onClick: this.reload, variant: "primary" },
                { label: t("crash.retry"), onClick: this.reset, variant: "outline" },
              ]
        }
      />
    );
  }
}
