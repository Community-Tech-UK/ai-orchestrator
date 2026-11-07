# Phase F verifier-repair handoff, 28 October 2026

All three supplied verifier findings are addressed in the assigned checkout. Worker verification passed.
The coordinator still owns the full suite, final independent completion gate, integration and document closure.
Keep the plan active and unrenamed. No commits, staging, stashes, merges, branch switches or worktrees were made.

Plan: [2026-10-20-oct2-phaseF-tooltips_plan.md](2026-10-20-oct2-phaseF-tooltips_plan.md).
Candidate checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phasef-tooltip-094153`. Current checkpoint: `7c0846f56980691fce6a6d12d5d1a1baae7fc4dc`; actual merge-base: `60e17b9b6882c3fe2d3f205d9143b461e3fa3fbd`.
The plan has no separate linked spec. Earlier partial-sweep claims and dependency blockers are superseded by this handoff.

## Acceptance checklist

- [x] Finding 1: finished the full lasting-state sweep, including composer, session/menu actions, browser,
  model/reasoning controls, MCP/connectors, plugins, routing/accounts and remaining feature pages.
  AST inventory measures 50 → 206 reason hosts, 190 → 0 native titles on controls, and 112 → 167 icon
  controls meeting the name/tooltip contract. The other nine icon-like elements are scrims/backdrops;
  eight retain their recorded backdrop marker and accessible name, and the help scrim is hidden from
  assistive technology and removed from the tab order. There are no unhandled action icons or inert directives.
- [x] Short in-flight states retain native protection. Lasting restrictions on editable inputs/selects retain
  native protection with a keyboard-reachable label/wrapper. Context-menu callers supply actual reasons;
  protected controls and blocked actions preserve values/drafts and recover when the cause clears.
- [x] Step 4 item 2: existing real-error paths are reachable on declaration approval, workspace connector Save,
  campaign Run, remote-config Save and source-control Pull/Push. Validation/recovery tests run with mocks and
  never approve a real campaign, save real settings, call providers, commit, pull or push. No missing Phase E
  presenter blocks this work; no competing presenter was invented. Merge All retains its eligible count.
- [x] The zero-debt icon and native-control-title lint rules are now errors. Ratchet counts only decreased,
  no marker was added, and every allowance is at or below the checkpoint. Two obsolete combined busy/input
  instructions were retired with specific replacement reasons; new qualifying wording is recorded.
- [x] Finding 2: the live-test document explicitly includes keyboard-reachable reasons, screen-reader names
  for Message and swept icons, and a rebound/restored sidebar shortcut. It records the Windows build,
  screen reader and test-state prerequisites and expected results. Phase B is not a remaining code blocker.
  Commit/send shortcut inspection is read-only; no live commit or provider message is authorised.
- [x] Finding 3: reproduced stale Vitest/yauzl type failures, replaced the stale directory with a real local
  `npm ci --ignore-scripts --no-audit --no-fund`, and verified Vitest 4.1.12, yauzl 3.4.0 and types 3.4.0.
  No dependency symlink, package or lockfile change. Dependency-compatibility tests pass against that install.
- [x] Targeted checks, both typechecks, lint, LOC, both builds, generators and contract checks passed.
- [x] Author review and fresh interim reviews completed; actionable new scanner findings were repaired and
  tested. Latest fresh interim review has no actionable findings within its scope. This is not the final
  independent gate or a whole-plan PASS.
- [ ] Full suite and fresh `task-completion-gate` PASS, reserved for the coordinator/verifier by the worker instruction.
- [ ] Windows live checks in [2026-10-20-oct2-phaseF-tooltips_livetest.md](2026-10-20-oct2-phaseF-tooltips_livetest.md).

## Current evidence

Source references below are relative to the candidate checkout above, not the root checkout:

- Composer reason wiring: `src/renderer/app/features/instance-detail/input-panel.component.ts:191`; `src/renderer/app/features/chats/chat-detail.component.html:177`.
- Protected reasoning host: `src/renderer/app/features/models/model-selection-panel.component.ts:197`.
- Existing declaration validation: `src/renderer/app/features/browser/browser-campaign-list.component.ts:207`.
- Existing connector validation: `src/renderer/app/features/mcp/workspace-mcp-connectors-panel.component.ts:76`.
- Menu activation guard: `src/renderer/app/shared/components/context-menu/context-menu.component.ts:213`.
- Literal-copy safety: `scripts/ui-hints/static-hover-text.ts:18`; `scripts/ui-hints/hover-strings.ts:89`.

```text
✓ 150 files · 1880 tests passed in 46.2s
✓ 16 files · 312 tests passed in 46.5s
UI hints OK {"H11":8,"H2b":121,"H2c":28,"H3":14,"H4":119}; 13 markers; 331 wording entries (22 retired); 361 advisory reports
```

Both `npx tsc --noEmit` and `npm run typecheck:spec`, lint, LOC, normal hints and `--against 60e17b9b6882c3fe2d3f205d9143b461e3fa3fbd`
exit zero. Both production builds exit zero; renderer retains its existing initial-bundle warning.
Aliases, IPC, agent vocabulary and the required Codex protocol generation/check are current with no generated drift.
IPC, export and contract checks pass. The post-review checks rerun tooling tests and both typechecks after the last
scanner-only edits; renderer source is unchanged from the successful production builds.

The wording scanner reads selected immutable shared copy without executing modules. It rejects mutable, duplicate,
computed/spread/prototype-setter records, shadowing component/local bindings and transforming/unknown input options.
An experimental general local-function evaluator was removed after fresh reviews proved it could preserve unused
defaults or overridden returns. Those regressions remain covered. The evidence panel now selects explicit registry
keys for both its tooltip and visible disclosure. Unchanged external-service argument scanning is outside this repair;
no claim of a complete JavaScript data-flow analysis is made.

The app test fixture now imports its actual icon/tooltip directives. Model reasoning tests focus the real wrapper
after initial autofocus settles. Quota tests inspect the rendered described tooltip rather than the removed native
title. Existing blocked-click, value/draft, navigation and recovery assertions are preserved.

Command receipts: [2026-10-20-oct2-phaseF-tooltips_commands.jsonl](2026-10-20-oct2-phaseF-tooltips_commands.jsonl). Source seal:
[2026-10-20-oct2-phaseF-tooltips_seal.json](2026-10-20-oct2-phaseF-tooltips_seal.json). Small logs, interim findings and audit evidence:
`2026-10-20-oct2-phaseF-tooltips_resume-evidence/round2/`. Failed investigation/gate runs remain alongside passing final receipts.

No Windows browser, screen-reader inspection, installed-app restart, credential access, provider call or external
write ran. Phase E's separate effort/Codex copy remains owned by Phase E. Cleanup follows the written report/seal;
its receipt records removal of this worker's dependency install, generated outputs, compile caches and temporary
review/verification runtimes. The verifier must provision its own matching local dependencies; no stale folder or
root symlink is restored. Pre-existing unrelated artifacts are preserved.

Cleanup completed. The temporary install and generated build files are removed, and candidate source hashes still match the seal. [Cleanup receipt](2026-10-20-oct2-phaseF-tooltips_resume-evidence/round2/cleanup-receipt.json).
