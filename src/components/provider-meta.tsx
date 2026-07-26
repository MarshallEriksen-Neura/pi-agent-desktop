"use client";

import type { ReactNode } from "react";
import { Bot, Brain, Cloud, Zap } from "lucide-react";

/** Shared provider branding — used by the Models page and the ModelPicker. */
export const PROVIDER_META: Record<
  string,
  { icon: ReactNode; bg: string; label: string }
> = {
  anthropic: { icon: <Bot size={16} />, bg: "#C15F3C", label: "Anthropic" },
  openai: { icon: <Brain size={16} />, bg: "#10A37F", label: "OpenAI" },
  google: { icon: <Cloud size={16} />, bg: "#4285F4", label: "Google" },
  zai: { icon: <Zap size={16} />, bg: "#6E56CF", label: "Z.ai" },
};

export function fmtCtx(n?: number) {
  if (!n) return "";
  return n >= 1_000_000 ? `${n / 1_000_000}M ctx` : `${Math.round(n / 1000)}K ctx`;
}
