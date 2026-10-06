# Hardened Mode — Support for Providers Other Than Claude — Completed Plan

**Status:** Agent-runnable implementation complete and verified 2026-09-28. Authenticated provider
enablement checks are deferred to
[`2026-09-28-hardened-mode-provider-support_livetest.md`](2026-09-28-hardened-mode-provider-support_livetest.md).
**Created:** 2026-09-28
**Related:** WS13 live test [`2026-07-13-fable-ws13_livetest_completed.md`](2026-07-13-fable-ws13_livetest_completed.md),
LT-028 in [`livetest-remediation-register.md`](livetest-remediation-register.md).

## Why

Hardened mode runs a session's CLI inside the macOS Seatbelt sandbox, so it cannot write outside the
project and a few allowed folders. Only Claude has ever been shown to work that way. On 2026-09-27
two Codex sessions in `~/work/Dingley/dingley-kpi` failed because Hardened was left on for that folder,
and Codex is refused in hardened mode. Before the 2026-09-28 session-retention fix, those sessions
simply vanished from the session list.

## Where things stand (verified 2026-09-28)

| Provider | Hardened behaviour today | Evidence |
|---|---|---|
| Claude | Works | WS13 checks 2, 3 and 6 |
| Codex | Refused up front | LT-028 refusal added 2026-09-23 (`be5cce3b`). WS13 check 4 on 2026-09-20 **completed a turn** in exec mode (`codex-app-server-adapter.ts:372` forces exec when hardened), and the jail blocked a `~/Desktop` write. The same run spawned the adapter five times (the initial spawn plus four respawns) in about two minutes. |
| Grok | Refused up front (Phase 0) | Never run jailed. State in `~/.grok`, which is not a writable root. |
| Cursor | Refused up front (Phase 0) | Never run jailed. State in `~/.cursor`, not a writable root. |
| OpenCode | Refused up front (Phase 0) | Never run jailed. State in `~/.local/share/opencode` and `~/.config/opencode`, not writable roots. Its SQLite DB needs write access. |
| Copilot | Refused up front (Phase 0) | Never run jailed. AIO's Copilot home is `<userData>/copilot-cli-home` (or a per-account profile dir), not a writable root. |
| Antigravity | Refused up front (Phase 0) | Never run jailed. State is under `~/.gemini/antigravity-cli`, which **is** inside the `~/.gemini` root, so it is the likeliest to work unchanged. |
| Remote (any) | Refused | `adapter-factory.ts` remote guard; WS13 check 5 |
| Local model | Hardened flag has no effect | Chat is tool-free (`local-model-chat-adapter.ts:57`), so there is nothing to jail |

The installed app's logs (`app.log*`, 2026-09-23 → 2026-09-28) show no hardened spawn for any provider,
so the Phase 0 refusals removed nothing in use.

## Phase 0 — Refuse unproven providers up front (complete, uncommitted)

- `src/shared/hardened-mode-support.ts`: single allow-list (`claude` only), used by both main and renderer.
- `src/main/cli/adapters/adapter-factory.ts`: the Codex-only refusal became "refuse any provider not on the list".
- `src/main/providers/provider-runtime-service.ts`: Hardened instances bypass spawn-worker offload so
  every provider reaches the adapter factory's Seatbelt/refusal enforcement path.
- Ollama and local-model runtime targets remain tool-free no-op paths; they are not represented as
  jailed and are not rejected by the main-process provider guard.
- `welcome-coordinator.service.ts`: refuses the send, keeping the draft, when the chosen provider cannot run hardened.
- `input-panel.component.*`: the toggle reads `N/A` (disabled) for an unsupported provider. When a folder
  remembered Hardened ON, it reads `ON — unsupported` and can still be switched off.
- Tests: `adapter-factory-hardened-remote.spec.ts`, `provider-runtime-service.spawn-worker.spec.ts`,
  `welcome-coordinator.service.spec.ts`, and `input-panel.component.spec.ts`.

## Deferred live validation and evidence-gated enablement

The Codex re-test and the one-provider-at-a-time checks for Antigravity, Grok, Cursor, OpenCode,
and Copilot have moved to
[`2026-09-28-hardened-mode-provider-support_livetest.md`](2026-09-28-hardened-mode-provider-support_livetest.md).
They remain open and unverified. Every provider stays refused until its current jailed live evidence
passes; Grok remains refused even after denial discovery because granting its shared `~/.grok`
installer/state tree would weaken containment.

## Verification

- Focused tests: 4 files, 49 tests passed.
- Canonical gates passed: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, and `npm run build:renderer`.
- Full suite under the repository's Node v24.15.0: 2,249 files and 26,897 tests passed; log
  `_scratch/test-run.pid-81552.log`.
- A genuinely fresh completion-gate reviewer independently returned `VERDICT: PASS` with no
  findings after rerunning the focused tests, every canonical gate, and the full 26,897-test suite;
  independent full-suite log `_scratch/test-run.pid-3789.log`.
- The six authenticated provider checks require real provider CLIs under `sandbox-exec` in a
  rebuilt/restarted app. They are not claimed as verified; exact steps and evidence requirements
  remain in the linked `_livetest.md` document.
