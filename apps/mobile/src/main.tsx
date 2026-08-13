import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";
import { GlobalErrorBoundary } from "@/components/GlobalErrorBoundary";
import { installCrashHandlers } from "@/lib/crash-report";
import "@/styles/global.css";
import "@/styles/components.css";

// 在建树之前安装:早于 React 的异步错误(模块顶层、插件初始化)也要被记录。
installCrashHandlers();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 应用级最后兜底 — 接管 router / AppShell 自身的渲染崩溃 */}
    <GlobalErrorBoundary>
      <App />
    </GlobalErrorBoundary>
  </StrictMode>,
);
