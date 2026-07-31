# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Pi Desktop — an iOS-inspired desktop client for the `pi` coding agent CLI. Tauri 2 (Rust) shell around a Next.js 15 static-export frontend (React 19, Tailwind 4, zustand). Package manager is pnpm.

## Commands

```bash
pnpm dev            # Next.js dev server in the browser (uses the mock pi transport)
pnpm tauri:dev      # Full desktop app: starts pnpm dev + Tauri window (real pi process)
pnpm build          # Next.js static export to out/
pnpm tauri:build    # Production desktop bundle (runs pnpm build first)
pnpm lint           # next lint
npx tsc --noEmit    # Typecheck (frontend only; tsconfig excludes src-tauri)
cargo check         # Rust check — run inside src-tauri/
```

There is no test suite.

## Architecture

The app is a thin GUI over the `pi` CLI running in RPC mode. Data flows in one loop:

1. **Rust side** ([src-tauri/src/pi_bridge.rs](src-tauri/src/pi_bridge.rs)) spawns `pi --mode rpc` with piped stdio. It is a dumb pipe: each stdout JSONL line is emitted to the frontend as a `pi://line` Tauri event (stderr → `pi://stderr`, exit → `pi://exit`); `pi_send` writes command lines back to the child's stdin. Protocol logic lives entirely in TypeScript.
2. **Transport layer** ([src/lib/pi/client.ts](src/lib/pi/client.ts)) abstracts where JSONL lines come from: `TauriTransport` (real process) or `MockTransport` (browser dev without Tauri or a pi binary). `isTauri()` picks at runtime — this is why `pnpm dev` in a plain browser is fully navigable with fake models/responses.
3. **Protocol types** ([src/lib/pi/protocol.ts](src/lib/pi/protocol.ts)) define every RPC command and event (source of truth: pi-mono `packages/coding-agent/docs/rpc.md`). Strict JSONL — one JSON object per LF-delimited line.
4. **State** is zustand stores: [src/lib/pi/store.ts](src/lib/pi/store.ts) (`usePi` — connection status, models, thinking level), [src/lib/pi/chat.ts](src/lib/pi/chat.ts) (messages), and [src/lib/store.ts](src/lib/store.ts) (`useUI` — theme, panels, agent task display). [src/lib/pi/agent-bridge.ts](src/lib/pi/agent-bridge.ts) translates pi tool events into UI agent-task state.

Other Rust commands registered in [src-tauri/src/lib.rs](src-tauri/src/lib.rs): `chat_store` (SQLite chat persistence via rusqlite), `fs_bridge` (workspace file listing/read/write), `pi_settings` (read/write pi CLI settings + invoke `pi` subcommands), `projects` (recent-projects list, folder picker), `updater`.

### Frontend structure

- App Router pages under [src/app/](src/app/) (`/`, `/settings`, `/models`, `/plugins`, `/skills`, `/store`) — all client-rendered; Next.js is configured for `output: "export"` in [next.config.ts](next.config.ts) because Tauri serves static assets. Don't add server-only features (API routes, SSR, next/image optimization).
- Components in [src/components/](src/components/) — [AppShell.tsx](src/components/AppShell.tsx) owns layout; the window is frameless/transparent (mica/acrylic) with custom [WindowControls.tsx](src/components/WindowControls.tsx), so window chrome is app code.
- Shared UI primitives in [src/components/primitives.tsx](src/components/primitives.tsx); editor is CodeMirror 6, terminal is xterm, animations use `motion`.
- Path alias: `@/*` → `src/*`.

### i18n

All user-facing strings go through `t()` from [src/lib/i18n/](src/lib/i18n/) — flat dot-notation keys in `en.ts` and `zh.ts` (en is the fallback). When adding UI text, add the key to both dictionaries.

1. Constructive Pushback: If a user's prompt instructions are mathematically flawed, systemically bottlenecked, or inherently self-destructive to their system architecture, push back firmly. State the technical limitation objectively and immediately pivot to the closest viable alternative.
2. 在进行编码前思考接下来的工作是否有开源库可以很好的解决 而不是重复造轮子.
3. 测试不要全量测试 只在受影响的测试文件进行测试，只有进行发布后才需测试
4. 如果用户给的方案不完美，你可以拒绝立马动手而是和用户讨论
5. 任务结束后及时利用ragcode-memory 记录下任务的总结和经验 任务开始前主动查看历史总结
6. 利用ragcode-agent 使用GPT-5.6 Sol (NovoL) 或 Grok 4.5 (FengWind) 等具备强大reasoning能力的模型处理复杂逻辑和决策任务，确保推理过程透明可追溯。
7. 代码检索: 当需要查找特定实现或参考代码时，先使用RAG技术在已有代码库中检索相关片段，避免重复实现并快速定位最佳实践。
