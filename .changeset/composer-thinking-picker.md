---
title: "Composer thinking-level picker"
---

## Changes

**New component** ([ThinkingPicker.tsx](../src/components/ThinkingPicker.tsx)):
- Composer chip that switches pi's thinking level in place — sibling of `ModelPicker`, same trigger geometry and the same iOS-clock roll on change so the two read as one control cluster
- Drives the **live** `set_thinking_level` RPC, deliberately not settings.json's `defaultThinkingLevel`: `setKey` flips `dirtyRestart`, which raises a "restart pi" banner on the settings pages — but the running process is already correct via RPC, so that prompt would be a lie. The menu footer links to Settings for the persisted default instead
- Brain icon takes the accent colour at `high` / `xhigh` / `max` and the whole chip dims at `off`, so the level is glanceable without adding a badge

**Persistence** ([store.ts](../src/lib/pi/store.ts)):
- `readRememberedThinking` / `rememberThinking` / `clearRememberedThinking` over `localStorage` (`pi-desktop.thinkingLevel`), following the convention already used for `sendShortcut` / `agentPanelWidth`. One value shared by every task, so a **new conversation inherits it** — each task spawns its own pi process, and a process has no memory of the level
- `refresh` re-applies the remembered level **once per process**, gated on `appliedRemembered` (reset in `connect`, which `restart` routes through). Only once is load-bearing: `/thinking` uses pi's own `cycle_thinking_level`, so re-pushing on every refresh would snap the user's cycle straight back. Past the first refresh the direction reverses — pi owns the level and storage mirrors what it reports, which keeps the slash command and the chip in step
- `thinkingInFlight` guards the pre-existing clobber race: a refresh landing mid-change reports the old level, which would both flicker the chip back and persist a stale value
- `setThinking` persists only after pi *agrees*, so a level pi rejects (a model without it) does not come back next launch
- Store init seeds from storage rather than hardcoding `"medium"` — the chip animates on change, so a fixed default made every launch visibly roll from Medium to the restored level

**Precedence** ([settings/page.tsx](../src/app/settings/page.tsx)):
- Changing `defaultThinkingLevel` clears the remembered value. Last explicit intent wins; without this the remembered level would always outrank the control and make it look inert

**Composer layout** ([ComposerInput.tsx](../src/components/ComposerInput.tsx), [ModelPicker.tsx](../src/components/ModelPicker.tsx), [store.ts](../src/lib/store.ts)):
- `AGENT_PANEL_WIDTH_MIN` (280) was calibrated for **one** chip, and the bottom row is absolutely positioned with no `flexWrap` — anything that does not fit overflows sideways under the send/stop buttons rather than wrapping. Tightest case is a streaming turn, when the row also carries the delivery toggle
- Rather than raise the minimum, the model chip is made the designated yielder (`minWidth: 0` on its button and label span, which already had `textOverflow: ellipsis`); the thinking chip takes `flexShrink: 0` since its label is short. Left cluster wrapped in a `minWidth: 0, overflow: hidden` flex div
- The stale comment on `AGENT_PANEL_WIDTH_MIN` now names both pickers and points at `ComposerInput`

**i18n** ([en.ts](../src/lib/i18n/en.ts), [zh.ts](../src/lib/i18n/zh.ts)):
- `thinking.select` / `thinking.setDefault`, plus `thinking.level.*` and `thinking.hint.*` for all seven levels in both dictionaries

## Verification

Root `tsc --noEmit`: 0 errors. Backend tsconfig unchanged at its pre-existing 9-error baseline (unresolved `@pi/remote-control-contracts`, `BackendPorts` drift), none in touched files — that baseline is also what blocks `npm run test:backend` from compiling locally. Behaviour confirmed end-to-end in the running app by the user; `next build` OOMs this machine, so CI is the build gate.
