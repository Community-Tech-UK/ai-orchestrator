# Codex Timeout & Auto-Title Fixes

**Date**: 2026-04-08
**Status**: Approved

## Problem

Two related Codex bugs:

1. **Codex CLI timeout kills sessions** — The `initAppServerMode()` path in `codex-cli-adapter.ts` calls `connectAppServer()`, `thread/start`, and `thread/resume` with zero timeout protection. If the Codex app-server hangs during initialization, the session blocks indefinitely (or until the 300s turn-level timeout fires much later), then dies with "Codex error: Codex CLI timeout".

2. **Auto-naming doesn't work with Codex** — Session tabs show the folder name and never update to an AI-generated title. The `AutoTitleService` spawns a separate Codex exec process with a 15s timeout for title generation, but Codex exec has significant cold-start overhead that exceeds 15s. The timeout is silently swallowed and the instant (Phase 1) title may not visually update in time.

## Solution

### Bug 1: Init-phase timeout

Wrap the `initAppServerMode()` call in `codex-cli-adapter.ts` (line 381) with a 30-second `Promise.race` timeout. On timeout, the existing catch block (line 384) handles fallback to exec mode gracefully.

**File**: `src/main/cli/adapters/codex-cli-adapter.ts`

- Add a `Promise.race` around `this.initAppServerMode()` with a 30s timer
- Timeout rejects with a descriptive error message
- No changes to `app-server-client.ts` or the turn-level timeout

### Bug 2: Fast-provider auto-title

Change `AutoTitleService` to always use the fastest available CLI provider for title generation, regardless of the session's provider. A 3-word tab title doesn't need provider consistency.

**File**: `src/main/instance/auto-title-service.ts`

- Replace provider resolution logic (line 131) with a fast-provider preference: try `claude` first, then `gemini`, then `copilot`, then `codex` as last resort
- Remove the `requestedProvider` parameter from `maybeGenerateTitle()` — it's no longer needed
- Check CLI availability before selecting (skip unavailable providers)

**File**: `src/main/instance/instance-lifecycle.ts`

- Remove the `instance.provider` argument from the `triggerAutoTitle` call

**File**: `src/main/instance/instance-manager.ts`

- No change needed (already doesn't pass provider)
