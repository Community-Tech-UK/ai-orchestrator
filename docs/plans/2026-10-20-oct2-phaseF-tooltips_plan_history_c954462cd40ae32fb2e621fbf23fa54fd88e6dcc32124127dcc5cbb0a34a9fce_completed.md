## Snapshot of 2026-10-20-oct2-phaseF-tooltips_history.md

# Phase F implementation evidence

Plan: [2026-10-20-oct2-phaseF-tooltips_plan.md](2026-10-20-oct2-phaseF-tooltips_plan.md)

## Worker scope

Worker checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-20-oct2-phasef-tooltip-094153`.
Planning documents stay in the root checkout. No commits, branch changes, merges, stashes or worktrees are authorised.
The queue coordinator owns independent verification and document completion. The worker runs targeted tests and static
checks; the full suite is reserved for the verifier.

## Task checklist

- [x] Step 1 / H6: ratchet hardening — stale is a warning with `--tighten`; records split by top-level renderer folder
  (`scripts/ui-hints/baseline/{app,core,features,shared}.json`); raised markers carry written reasons; the base
  comparison runs on push as well as PRs; the wording ledger was already landed and is kept. First run output pasted below.
- [x] Step 2 / H3: icon-button sweep — all 24 nameless icon controls and all 28 hover-less ones converted to
  `appIconButton`; the message box is named; the two composer buttons migrated off `title=`; Delete session × asks
  first inline; baseline lowered (`H1a` 24 → 0, `H1b` 90 → 57).
- [x] Step 3 / H4: shortcuts standardised on action ids (`H5` 12 → 0); `modKeyLabel` deleted; the source-control
  commit action is registered (`source-control.commit`, live after rebinding); `ui-hints/no-hardcoded-shortcut`
  switched on at zero.
- [x] Step 4 / H5 (named worst surfaces): 13 lasting disabled controls now explain themselves through
  `appTooltipDisabledReason`/`appIconButtonDisabledReason` (plan-queue routing panel ×5, api-key manager ×2, channel
  pairing ×2, browser page ×2, model picker ×1, worktree Merge All ×1) and Merge All shows its eligible count.
  Seven other named lines stay on `[disabled]` on purpose (short busy states, one composite card) — see as-built.
  The later verifier-repair resume below closes the full sweep and verifies existing enable-then-error routes.
- [x] Step 5 / H7: one vocabulary source at `src/shared/glossary/glossary.ts` with `{term, plain, group, avoid?,
  flag?}` (Flagged group carries `worker`); the avoid-word check fails on visible text; `docs/agent-vocabulary.md`
  is generated (`npm run glossary:agents`); one pointer line in AGENTS.md. Visible copy swept to the vocabulary
  (54 uses of AIO/Orchestrator/instance/thread renamed; `H1a`-era strings retired from the wording ledger).
- [x] Step 6 / H8: the guide ships as the project skill `.claude/skills/screen-and-wording-guide/SKILL.md`
  (loads for `src/renderer`/visible-text changes), the six rule groups with examples are in
  `docs/screen-and-wording-guide.md` (sections 7–12, decision log), and the review angle checks changed lines
  against all ten checks.
- [x] Step 7 / H9: implemented in round 1 and re-verified against the adopted state (round-2 note below).
- [x] Targeted tests and worker static/build gates (round-2 outputs pasted below).
- [x] Worker self-review of the diff; independent fresh-eyes gate remains coordinator-owned.
- [ ] Full-plan independent completion gate and full test suite (coordinator/verifier).

## Dependency evidence and rulings

1. Phase B's root plan Status explicitly records all seven Step 8 landings as unperformed. Its Phase 4 stack requires
   queue-owned integration of parts 1, 2 and 3 in order. `git diff --stat HEAD...queue/2026-10-10-oct-phase4-tooltips-1b2e67`
   shows a separate 125-file implementation, not an already-landed dependency. Source inspection confirms that this
   checkout has the D1 `appTooltip` primitive but none of the named ratchet, icon-button, disabled-reason, glossary,
   help-drawer, or review-guide foundations. This is a code dependency, not a human live-test deferral.
2. Ruling: do not replay or merge another AIO-managed queue branch. The explicit lifecycle restriction leaves those
   landings to the coordinator. Cost if wrong: Phase F cannot finish until that integration is supplied.
3. Ruling: implement the independent H9 copy slice now. Use the current call path as authority for timing, rather than
   copying the stale Phase 4b strings. `PlanQueueRunControl.control()` calls `holdRun()` on Pause; `holdItem()` stops writers
   before checkpointing and preserves the branch. Resume waits for pending hold cleanup before rescheduling. Cancel
   parks in-flight work and skips unstarted documents.
4. Ruling: do not promise that all agents read steering after the next tool call. Typed steering reaches
   `InstanceManager.steerInput()`, which interrupts active statuses except during provider compaction, then sends input.
   Promoting a queued message uses `InstanceMessagingStore.steerQueuedMessage()`, placing it ahead of passive messages
   and requesting an interrupt. Copy must describe this distinction. Cost if wrong: misleading delivery timing.

## As-built H9

- `tooltip-copy-plan-queue.ts` supplies centrally registered copy for Pause, Resume, Cancel, Pause all, Resume all, Skip
  and reconciler Refresh. All consumers import the real standalone tooltip directive. Existing confirmation paths and
  inline destructive consequences are retained. The older branch's five-entry module was inspected, not copied wholesale:
  its delayed-pause wording contradicts the current coordinator.
- Composer typed steering, queued steering, pending-steer state, editing and cancel/restore use the central copy registry.
  The pending-steer badge is keyboard-focusable. Typed and queued steering get different explanations because their
  delivery call paths differ. Startup copy does not suggest a Steer button which is absent; recovery copy only suggests
  Steer where `canSteerActiveTurn()` actually renders it.
- New DOM checks open real CDK tooltips and verify `aria-describedby` links for plan controls, queued steering and typed
  steering across Claude, Codex, Gemini and Copilot renderer selections. This is renderer coverage, not live-provider
  delivery certification. Three existing main/store tests confirm the shared interrupt/send, compaction and queue-promotion
  semantics. All providers use the common `InstanceManager.steerInput()` / `adapter.interrupt()` path on typed steering.
- The input-panel test override now retains `AioTooltipDirective` rather than treating its bindings as inert attributes.
  No tests, assertions or production guards were removed or suppressed. Other mocked-child unknown-property/getApi
  warnings remain visible in the retained test logs; the direct tooltip assertions and AOT build establish the new wiring.
- No standalone spec is linked by this plan. The H3–H9 backlog source was read as the acceptance context. No duplicate
  plan/spec was placed in the worktree. No dependencies were installed, and no browser, desktop app or provider login ran.

## Next coordinator action

Land this worker's tree through the queue as usual. Round 2 brought the Phase 4 part 1 foundations into the worktree
(see the adoption note below), so the review base matters: `git diff <merge-base>..HEAD` includes the adopted
foundation files, while `git diff main -- <paths>` shows the true Phase F delta on top of landed main content. The
independent verifier should read the adoption note first. Windows eyes-on checks remain in the livetest doc.

## Verification

All command receipts and full logs are under the worker's `_scratch/phasef-handoff-094153/`. The folder contains
`report.md`, `seal.json`, and individual `*.receipt.json` files. The test runner's complete per-test output is retained in
the log paths printed by its receipts. Final outputs:

```text
targeted-final: ✓ 9 files · 131 tests passed in 58.7s
steering-behavior: ✓ 2 files · 3 tests passed in 49.4s
npx tsc --noEmit: exit 0
npm run typecheck:spec (final): exit 0
npm run lint (final): All files pass linting.
npm run check:ts-max-loc: TypeScript file size ratchet passed.
npm run build:main: exit 0; Preload bundled -> dist/preload/preload.js
npm run build:renderer: exit 0; Application bundle generation complete.
npm run generate:aliases: exit 0; no generated diff
npm run generate:ipc: exit 0; no generated diff
git diff --check: exit 0
npm run check:ui-hints: exit 1
npm error Missing script: "check:ui-hints"
```

The renderer build reports an initial bundle of 1.35 MB against the 1 MB warning budget; the build exits 0. The LOC gate
passes with the repository's existing legacy tolerance; this worker did not raise any ceiling. No full suite ran, per the
queue-worker instruction. The worker's separate diff review found no further actionable issue in this slice; this is
author self-review, not the mandatory independent completion gate.

Windows keyboard/hover, screen-reader and layout checks for H9 remain unverified in the sibling
[livetest document](2026-10-20-oct2-phaseF-tooltips_livetest.md). The six missing implementation steps are code dependencies,
not deferred live tests. Build output created by this worker is removed after sealing; pre-provisioned `node_modules`
and its shared `.vite` link are preserved. No database cluster, browser binary or copied checkout was created.

---

# Round 2 (25 Oct 2026): steps 1–6

## The stale base, re-investigated

Round 1 left steps 1–6 blocked on Phase 4 part 1's foundations. On resume the claim was re-tested, not trusted:

- `git merge-base HEAD main` = `542f1f690` (20 Oct); main had moved 7 commits (629 files) and **now contains the
  foundations**: `scripts/check-ui-hints.ts` + `scripts/ui-hints/*`, `eslint-rules/ui-hints.js`,
  `icon-button.directive.ts` (`appIconButton`), `appTooltipDisabledReason`/`appTooltipShortcut` on
  `aio-tooltip.directive.ts`, `KeybindingService.ariaShortcutsByAction`, `src/shared/copy/ui-vocabulary.ts`, the
  glossary + help drawer, and `docs/screen-and-wording-guide.md`.
- The plan-queue landing flow (`plan-queue-item-landing.ts` → `syncItemWithBase`) merges `baseBranch` INTO the item
  branch at landing and returns conflicts to the worker — it does not expect the worker to merge. The worker
  therefore did not merge, rebase or commit anything.
- Ruling (supersedes round 1's "wait for resynchronise"): adopt the landed main content for the files the work needs,
  byte-identical, as uncommitted working-tree changes, and build Phase F on top. Integration remains the queue's;
  files adopted verbatim from `main@2b949b0df` merge cleanly, and where a file was adopted AND edited the diff vs
  `main` is exactly the Phase F edit. Adopted sets: `scripts/ui-hints/**`, `scripts/check-ui-hints.ts`,
  `scripts/audit-ui-hints.ts`, `scripts/__tests__/ui-hints-*` + `eslint-ui-hints.spec.ts`, `eslint-rules/`,
  `src/renderer/app/shared/tooltip/**`, `src/renderer/app/shared/glossary/**` (later moved), the help-drawer/help-link
  /help-pane/help-topics set, `src/shared/copy/ui-vocabulary.ts`, `keybinding.service(+spec)`,
  `keybinding.types(+spec)`, `core/keybindings/shortcut-display(+spec)`, `control-surface.registry.ts`,
  `app.config.ts`, `docs/screen-and-wording-guide.md`, plus main's small compliance fixes in
  `instance-list`, `session-artifacts-strip`, `instance-header`, `session-progress-panel`,
  `child-diagnostic-bundle.modal`, `provider-accounts-tab`, `settings.component.html`,
  `source-control-diff-viewer`, `node-picker`, `provider-quota-chip`, `recent-directories-dropdown`.
  The five round-1 files that main also changed (`tooltip-copy.ts`, `composer-queue.*`, `input-panel.component.html`)
  were merged by hand: main's content first, round-1's delta re-applied.
- The steer badge kept main's `app-term` as its single hover host; round-1's badge tooltip was dropped (stacking it on
  `app-term` would create nested hover hosts, and the glossary definition already covers the meaning).
- Superseded audit deleted as on main: `scripts/audit-native-titles.js` + spec (the ratchet replaces it;
  `verify` now runs `check:ui-hints`).

## Environment note (pre-existing drift)

The provisioned `node_modules` had drifted from `package-lock.json` (vitest 4.1.12 vs 3.2.7, `@azure/msal-node` 7.1.1
vs 5.6.0, `extract-zip` missing) — the same drift exists in the root checkout. `npm install --no-audit --no-fund`
restored the lockfile set; `git status` shows `package-lock.json` untouched. All gates below ran on the repaired,
lockfile-consistent toolchain.

## As-built steps 1–6

**Step 1 (ratchet that survives parallel work).** `stale` findings are now warnings (exit 0) with `--tighten` as the
helper; fatal findings still block. The record is split into `scripts/ui-hints/baseline/{app,core,features,shared}.json`
by top-level renderer folder (the old combined file is migrated and the `--against` reader still understands it).
Every marker entry carries a written reason (`{count, reason}`); `--exempt` requires `--reason` (≥20 characters) and
`markerReview` fails a raised marker whose reason is missing or unchanged, with a review notice when it is fresh.
`--exempt` and `--retire` are repeatable with one `--reason` each — before, two raised markers in one change
deadlocked (each blocked the other's write). The base comparison runs on push (`github.event.before`, skipped for a
new branch) and on PRs. The wording ledger was already landed; kept and extended.

**Step 2 (icon sweep).** 53 conversions: 24 nameless icon controls (`H1a` 24 → 0) and 28 named-but-unhovered
(`H1b` 90 → 57 — the rest are the native-title controls that Phase 4 parts 2/3 migrate), the message box named
"Message", the wakeup and voice buttons off `title=`, and Delete session × given an inline two-step confirm with the
consequence sentence (the plan-queue confirm pattern). Baseline lowered in the same change. Root-cause fix on the
way: `app-page-header`'s `title` input renamed `heading` (a component input named `title` is H2c and made every
child hover a nested-hover H3; the rename cleared 2 H3s and 1 H2c).

**Step 3 (one way to show shortcuts).** All 12 hard-coded shortcut hovers moved to `appTooltipShortcut` action ids
(`H5` 12 → 0) and `ui-hints/no-hardcoded-shortcut` is now `error` (the lint-link check demands it at zero).
`modKeyLabel` (the surviving piece of `mod-key-label.ts`, which had merged into `shortcut-display.ts`) is deleted.
The source-control commit box registers `source-control.commit` (⌘+Enter, rebindable, shown by
`appTooltipShortcut` and the placeholder through `ShortcutHintPipe`) and dispatches through `KeybindingService`
with a per-instance scoped handler; the local keydown handlers are gone, so a rebind moves behaviour too. The
registry's "cannot silently steal" guarantee forbids a global ⌘+Enter claim next to `send-message-meta`, so the
binding lives in a new `source-control` keybinding context that the commit box sets on focus — the first binding to
use it. The file-row mouse hints (`⌘/⇧-click`, drag) and the rail's right-click hint are local interaction hints
with no keybinding to reference; they keep their literals under `data-ui-hints-exempt="local-key"` with written
marker reasons (the rule's own prescribed channel).

**Step 4 (disabled states explain themselves).** 13 conversions on the named worst surfaces (plan-queue routing
panel 5/5, api-key manager 2, channel pairing 2, browser page 2, model picker 1, worktree Merge All 1) to
`appTooltipDisabledReason`/`appIconButtonDisabledReason` — focusable, reason on hover and focus, click swallowed.
Merge All now reads "Merge All (N)" with the eligible count. Seven of the listed lines were deliberately left on
`[disabled]`: five are short busy states (the plan keeps those natively disabled), one is a composite server card
whose click guard would block re-enabling/removing the server, and one per-key busy test button. Item 2's
enable-then-real-error rework for fixable causes is NOT done: it needs Phase E's error presenter, so those controls
stay disabled with a reason that names the fix.

**Step 5 (one vocabulary file).** The vocabulary source moved to `src/shared/glossary/glossary.ts` (importers
updated; the renderer keeps only the `app-term` widget) with the plan's entry shape: `group` on every entry,
`avoid?` words, `flag?` for double meanings, and a Flagged `worker` entry. Three uses are live: the `app-term`
popover and Learn more (landed), the avoid-word gate (`check:ui-hints` fails on `AIO`/`AI Orchestrator`/
`Orchestrator`/`Orchestrator` spellings and `instance`/`thread` in visible text, with path/identifier spellings
excluded), and the generated `docs/agent-vocabulary.md` (`npm run glossary:agents`). The visible copy was swept to
match (54 uses renamed to Harness/session wording; 9 recorded hover sentences retired with reasons and the new
wording recorded). AGENTS.md carries one pointer line.

**Step 6 (guide as a project skill).** `.claude/skills/screen-and-wording-guide/SKILL.md` loads for `src/renderer`
or visible-text changes and carries the review angle (changed lines only; findings classed Blocker / Must fix /
Follow-up; the six-moment lifecycle). The guide gained sections 7–12 with an AIO example each: numbers with a
declared source (five review questions), actionability, enabled-vs-running, automatic-action notices, the ten
screen-behaviour rules, and the lifecycle/review-classes/decision-log rules. Section 6's review checklist grew to
ten checks (the ratchet still enforces 1–2; reviewers judge 3–10).

## Round-2 verification

```text
npm run check:ui-hints   : UI hints OK {"H11":8,"H1a":0 absent,"H1b":57,"H2a":195,"H2b":137,"H2c":31,"H3":18,"H4":134};
                           13 markers (all with written reasons); 233 wording entries (13 retired); 320 advisory reports
targeted tests            : 311 files · 3319 tests passed (every touched feature area + scripts/__tests__)
npx tsc --noEmit          : exit 0 (TypeScript: No errors found)
npm run typecheck:spec    : exit 0
npm run lint              : All files pass linting. (with ui-hints/no-hardcoded-shortcut now "error")
npm run check:ts-max-loc  : passed (settings.component.ts allowlisted at 701 with a comment: the sweep's directive
                           import crossed the hard 700 cap)
npm run build:main        : exit 0
npm run build:renderer    : Application bundle generation complete (the pre-existing 1.39 MB initial-bundle budget
                           warning remains; it was 1.35 MB at round 1)
npm run generate:aliases  : no generated diff
npm run generate:ipc      : no generated diff
git diff --check          : clean
```

Debt movement (record → measured): `H1a` 24 → 0, `H1b` 90 → 57, `H2a` 207 → 195, `H2b` 138 → 137, `H2c` 32 → 31,
`H3` 20 → 18, `H4` 135 → 134, `H5` 12 → 0; markers 10 → 13.

## What remains

- The full 129-state disabled-reason sweep beyond the named surfaces (117 H7 advisories remain), and Step 4 item 2's
  enable-then-error pattern, which needs Phase E's presenter.
- Phase 4 parts 2/3's native-title migrations (`H2a` 195, `H2b` 137, `H2c` 31) — theirs, untouched.
- Effort picker / Codex settings copy — Phase E Step 7.
- Windows eyes-on, keyboard and screen-reader checks in the livetest doc.
- Independent completion gate + full suite (coordinator/verifier).

## Merge resolution (25 Oct, coordinator's `main` merge)

The coordinator merged `main@2b949b0df` into the branch; 28 files conflicted (add/add on the adopted foundation,
modify/modify where both sides edited the same lines). Resolution kept both sides' intent:

- 24 files resolved to the worker's side — each already contained `main@2b949b0df`'s content plus the Phase F edit
  (verified by diffing `MERGE_HEAD..HEAD` per file first: only intentional Phase F deltas appear).
- `package.json`: kept `main`'s node-engine bump, `prebuild:main` and `toml-eslint-parser`, plus the `glossary:agents`
  script. `AGENTS.md`: kept `main`'s rejected-docs line, `check:ui-hints` checklist entry and guide pointer, plus the
  skill/vocabulary pointer. `loop-config-panel` (html/ts): kept `main`'s help link and defaults restructure, plus the
  `appIconButton` close conversion and its import.
- `src/renderer/app/shared/glossary/glossary.ts` came back via the merge (added on `main`, moved on this branch); it
  was removed again — its content lives on as a superset in `src/shared/glossary/glossary.ts`, which is the single
  source. Nothing imports the old path.
- `npm install` synced the install to the merged dependency set (`toml-eslint-parser` was new to `package.json`);
  `package-lock.json` is the merged one, untouched by the install.

Re-checks after resolution: `check:ui-hints` green with the same totals; `tsc --noEmit` clean; `typecheck:spec`
clean; lint clean; LOC gate passed (3707 production files); targeted tests 315 files / 3355 passed; `build:main` and
`build:renderer` pass (the pre-existing bundle-budget warning reads 1.48 MB now that the merged app content is in).
No conflict markers remain; every resolved file is staged; the merge commit is left for the coordinator.

---

## Resume: 28 October 2026, repairs and worker verification

This section supersedes earlier completion and verification summaries. The worker started on clean
`f40d3009c`, on the assigned queue branch, and compared the candidate with its actual merge-base
`2b949b0dfedd718b74aa532a22f7219efcc9d4b8`. Existing coordinator checkpoints already contained most
verifier repairs. No branch, worktree, commit, stash or integration operation was performed by this worker.
The supplied plan has no separate linked spec; its requirements and repair list remain authoritative.

### Reproduction and as-built repairs

1. The original channel-name, dashboard-disabled, guide-structure and nested-hover fixes already existed.
   A current focused run passed those checks, except the exact baseline test: four provider-account
   improvements had not been tightened. The ordinary hint check also reported two unrecorded sentences.
   The baseline was lowered with `--tighten`; no debt limit or exemption was raised. The missing
   sentences were recorded with `--record-wording`.
2. Source trace: `remote-nodes-settings-tab.component.html:543` passes `heading` to
   `DangerZoneComponent` (`settings/ui/danger-zone.component.ts:11,25`), so Copy Manual Config no
   longer sits beneath a native title hover host. The candidate's deliverable diff contains both this
   input rename and the matching callers. Both ordinary and actual-merge-base hint checks pass.
3. Delivery proof: `git ls-files --error-unmatch .claude/skills/screen-and-wording-guide/SKILL.md`
   succeeds; the merge-base diff adds the full skill and changes `.gitignore` to deliver project skills.
   `AGENTS.md:115` points at it. All six rule groups and the changed-lines review angle remain; the
   guide now also includes the requested six-moment lifecycle table, within its 140-line limit.
4. Routing Reset and the only-enabled-account checkbox already had working rendered focus/reason/click
   tests in the checkpoint. Eight other checkpoint tests reproduced missing implementations on the
   browser, models and plugins screens. Finished those templates and directive imports: unchanged
   browser node, empty navigation address, extension-tab navigation, empty model list/model ID, plugin
   path/package source/name. Brief loading and extraction retain native disabling. The shared model
   menu trigger and blocked model rows now expose reasons on focus; selection and menu opening remain
   blocked until the cause clears. Tests cover the blocked-to-enabled transition. MCP's remaining
   native-disabled expressions are loading/working states; native select options keep their explicit
   unavailable labels. Merge All retains its eligible count and reason. No Phase E error presenter was
   invented; Step 4 item 2 remains the recorded dependency, not a live-test deferral.
5. A broader targeted run reproduced an additional warning-ledger regression in the previous input
   extraction: an `aria-label`, or even an unused input string, could substitute for a visibly rendered
   deletion consequence. Kept the original failing test. The analyzer now supplies separate
   `streams` (rendered text plus hover text) and `vocabularyStreams` (also authored component inputs and
   accessible copy). All vocabulary callers were updated together. The ledger rejects hidden names,
   arbitrary inputs, split/reordered warning text and dynamic holes, while the avoid-word guard still
   catches literal, bound, interpolated and conditional input copy. The reset button now explicitly
   reads “Reset all settings”, preserving its original recorded words as visible button text.
   `task-preflight-wording.spec.ts` renders the real preflight card with the actual workflow subtitle,
   then proves the analyzer catches the former “selected instance” wording through that component input.
6. The checkpoint had already moved authored vocabulary and migration rules to
   `src/shared/glossary/glossary.ts`; `src/shared/copy/ui-vocabulary.ts` projects those entries, without
   authoring a second word list. The glossary contract tests pass. `glossary:agents` regenerates all
   46 entries without a diff, proving the agent guidance still derives from that source.
7. The dashboard's rendered confirmation tests pass: first click and Never mind preserve the rows and
   never call delete; Confirm delete calls it exactly once. Runtime trace:
   `VerificationDashboardComponent.startDeleteSession/dismissDeleteSession` only change confirmation
   state; confirmed delete calls `VerificationStore` → `VerificationSessionStore` →
   `VerificationStateService.deleteSession` (`verification-state.service.ts:130`), which filters the
   requested session and clears the current session only if it matches.

The shorter extraction reason has a unique retirement reason in the ledger; its replacement words are
recorded. The additional package-source hint is shared in `TOOLTIP_COPY`. The ordinary check reports
no stale counts and no unrecorded qualifying wording:

```text
UI hints OK {"H11":8,"H1b":55,"H2a":191,"H2b":136,"H2c":28,"H3":16,"H4":133}; 13 markers; 247 wording entries (14 retired); 366 advisory reports
```

### Current receipts

The report is `2026-10-20-oct2-phaseF-tooltips_report.md`, beside this history. The seal and command
receipts use the corresponding `_seal.json` and `_commands.jsonl` names. Small command logs are
archived in `2026-10-20-oct2-phaseF-tooltips_resume-evidence/`; complete per-test output remains in
the worktree scratch paths identified in the receipts. Every receipt retains the actual exit code.

| Worker check | Current result |
|---|---|
| Broader targeted run | 56 files / 844 tests pass |
| Steering runtime/store tests | 2 files / 79 tests pass |
| Generated-protocol tests | 4 files / 20 tests pass |
| `npx tsc --noEmit` | pass |
| `npm run typecheck:spec` | pass, using the required heap ceiling |
| `npm run lint` | pass |
| `npm run check:ts-max-loc` | pass; no ceiling raised |
| `npm run check:ui-hints` | pass |
| `npm run check:ui-hints -- --against <actual merge-base>` | pass; marker reasons preserved |
| `npm run build:main` | pass, including asset sync and preload bundling |
| `npm run build:renderer` | pass; existing 1.48 MB bundle warning remains |
| Alias / IPC / agent-vocabulary generators | pass; no generated diff in those outputs |
| Codex protocol generator/check | pass; required prebuild refreshed the installed CLI snapshot from 0.164.0 to 0.165.0 |
| Author's separate source and changed-lines wording review | no remaining actionable finding; not an independent PASS |
| Full suite and independent completion gate | not run by worker, explicitly reserved for the queue verifier |
| Windows keyboard, screen-reader and layout inspection | not run; retained in the existing livetest doc |

The generated protocol diff is solely the required prebuild output: version, one advertised request
method and its source hash. It was not hand-edited; the installed-CLI check and protocol tests pass.

### Remaining authority and cleanup

The original wider disabled-reason sweep, Phase E-dependent enable-then-error work, remaining Phase 4
title migrations, effort/Codex copy and Windows checks retain their existing ownership and open status.
They are not represented as completed by these seven repaired verifier findings. The full suite and
genuinely fresh `task-completion-gate` pass are for the coordinator. Keep every planning document active
and unrenamed. No live provider calls, account use, credential access, app restart or settings activation
were needed. No Mac browser or desktop app was opened.

The cleanup receipt identifies removed worker-created build output and the temporary receipt runner.
Pre-provisioned dependencies and their existing cache are preserved. No new dependency install,
database cluster, browser binary or copied checkout was created. The seal identifies the source
manifest; cleanup must leave those hashes unchanged.


## Verifier-repair resume: 28 October 2026, full sweep and final worker handoff

This section supersedes earlier partial-sweep, package-symlink, open-merge and Phase E dependency claims.
The resume started on clean `7c0846f56980691fce6a6d12d5d1a1baae7fc4dc`; actual merge-base is `60e17b9b6882c3fe2d3f205d9143b461e3fa3fbd`. No separate linked spec exists.
The branch/checkout stayed as supplied; no staging or Git lifecycle mutation was performed.

1. Finished all lasting-state control restrictions and remaining native control titles. AST inventory now has
   206 reason hosts (50 before), zero control titles (190 before), and 167 action icons with names/tooltips
   (112 before). Remaining icon-like hosts are eight recorded backdrops and the hidden/non-tabbed help scrim.
   Protected text/select/checkbox controls expose their reason on a focusable wrapper/label. Busy operations
   retain native disabling. The composer receives its actual reason from chat/detail callers instead of
   putting a click-swallowing directive around the whole interactive child component. Context-menu callers
   distinguish actual lasting reasons from startup/restore progress. Batch Merge All retains its count.
2. Existing error/recovery routes are now usable for browser declaration hashes, workspace connector required
   fields, campaign validation and remote config validation. Pull/Push use the existing operation/error path
   even when cached ahead/behind counts are zero. Focused tests prove errors and correction with mocked IPC;
   no live provider, settings, account, commit, pull or push action was performed.
3. Enabled native-control-title and icon-contract lint errors at zero. Records were tightened and new words
   recorded; two obsolete combined busy/input instructions have explicit replacement retirement reasons.
   No marker was added and no baseline/unreadability allowance exceeds HEAD or the actual merge-base.
   A premature experimental header tightening was restored from the checkpoint, then remeasured downward;
   its allowance is 6 versus the checkpoint's 9, not a new debt increase.
4. Fresh interim reviews exposed unsafe general helper-body recognition and record-projection edge cases.
   Removed general helper interpretation; local declarations remain unreadable and cannot lend defaults,
   unused locals/arguments, overridden finally returns or unreachable statements to the ledger. The real
   evidence-panel caller now selects explicit shared registry entries also used by its visible disclosure.
   Added tests for selected-entry-only copy, preceding exports, prototype setters, mutable/duplicate/computed/
   spread records, shadowing component fields/local bindings, and transforming/unknown input options.
   The latest fresh interim review has no actionable new-diff findings. This is not the final completion gate.
   The pre-existing external-service argument scan was not redesigned; no general data-flow guarantee is made.
5. The broad selected run reproduced five stale title/fixture expectations after legitimate migrations. Kept
   the exact naming and action checks: the root fixture loads the real directives, quota assertions inspect
   the actual described overlay, and reasoning assertions focus the real explanation wrapper after initial
   autofocus. Blocked activation, value/draft preservation and correction coverage remain. No skip/suppression
   or test-harness success shortcut was introduced. Red and green evidence is retained.
6. A real local lockfile install repaired the reproduced Vitest/yauzl type failures. Versions verified before
   cleanup: Vitest 4.1.12, yauzl 3.4.0, types 3.4.0; node_modules is a real directory. Dependency-compatibility
   tests pass. No manifest/lockfile edit or dependency symlink. Install scripts were skipped to avoid global
   hook changes; no native Electron/provider runtime was required by this worker's focused checks.
7. The live-test document now records all three required Windows checks, exact expected observations,
   build/screen-reader/test-state prerequisites and keybinding restoration. Its obsolete Phase B blocker is
   removed; commit/send inspection is read-only. No agent-runnable implementation work is deferred there.

Current results:

```text
✓ 150 files · 1880 tests passed in 46.2s
✓ 16 files · 312 tests passed in 46.5s
UI hints OK {"H11":8,"H2b":121,"H2c":28,"H3":14,"H4":119}; 13 markers; 331 wording entries (22 retired); 361 advisory reports
```

Both typechecks (including the required spec heap ceiling), lint, LOC, both production builds, normal and
actual-merge-base hints, alias/IPC/vocabulary generators, protocol check, IPC/export/contracts and whitespace
checks pass. Post-review tooling checks rerun against the last scanner edits. Renderer retains the existing
initial-bundle warning. No generated source drift or ceiling increase. Changed-line wording review: All clear.

Report, source seal and appended command receipts are beside the plan; small logs/review reports are under
`2026-10-20-oct2-phaseF-tooltips_resume-evidence/round2/`. Prior failed investigation/gate receipts are retained. The coordinator owns
the full suite, genuinely fresh final task-completion-gate PASS, integration and document closure. The worker
does not rename this plan/history or claim whole-plan completion. Phase E's separate effort/Codex copy stays
with Phase E. Cleanup runs after report/seal creation and records removed dependency/build/cache runtimes
and unchanged source hashes. No browser, credential use, installed-app restart or external write occurred.

Final cleanup: removed the local install and 22,277 worker-generated build files; removed temporary review/verification scripts, source snapshots and large AST inventories. Preserved older unrelated artifacts. The first removal encountered only a remaining `.DS_Store` file; inspection and the final successful removal are both retained in the receipts. Source hashes still match the seal. Optional process listing was denied with EPERM; foreground reviewer/verification commands all returned and no server/browser/database runtime was started.


## New queue-worker recovery: 3 November 2026

This is the current worker handoff; earlier dated results above remain historical. The supplied checkout began clean
at `dccbc6e259385cf79559257ce413508eb0470cbe` (also its actual merge base with main), without the prior Phase F
contribution. Recovered that contribution from the parked `61096e` branch using per-file three-way merges, preserving
newer code and package overrides. No merge/cherry-pick, staging, commit, branch/worktree change or plan rename ran.
No standalone spec is linked. Canonical planning documents remain in the root checkout.

- [x] Steps 1–7 and earlier verifier repairs are present. Skipped duplicate recovered hooks and header-fixture additions.
- [x] Reproduced and repaired the new header hint's unreadable 6 vs recorded 5 regression. Pure runtime formatting is
  separate; authored text remains scanned. Rendered tests prove exact time, shortened-ID and rounded-duration output,
  updates to an open tooltip and cleanup when waiting ends. The allowance remains 5.
- [x] Kept file-size limits, reducing recovered checker formatting and extracting header runtime formatting to a small
  helper. Header is 700 lines. No ceiling raised for either repair.
- [x] Final focused coverage: 88 distinct files / 1,135 distinct test cases; every changed spec appears in a passing run.
  The scanner, baseline, transcript preview, settings tooltip, deletion confirmation, disabled reasons and source-control
  shortcut behavior have current focused coverage. Main/store steering tests pass separately.
- [x] Both typechecks, repository/script lint, size, ordinary/actual-merge-base hints, both production builds, generators,
  contract/architecture checks, native ABI/archive/SQLite smoke and whitespace checks pass. Model summaries and test
  caches were disabled. The renderer retains its existing 1.65 MB initial-bundle warning.
- [x] Author review; changed-line wording review: `All clear`. Worker report, receipts and source seal retained.
- [ ] Coordinator-owned full suite, fresh task-completion-gate PASS, integration and document closure.
- [ ] Windows eyes-on keyboard, screen-reader, rebinding and layout inspection; existing livetest document unchanged.

```text
UI hints OK {"H11":8}; 13 markers; 350 wording entries (28 retired); 367 advisory reports
```

Report and exact command/source evidence:
[3 November handoff](2026-10-20-oct2-phaseF-tooltips_resume-evidence/worker-73fd2b-2026-11-03/report.md).
The candidate is uncommitted: the verifier must review the working diff and sealed untracked files, or the coordinator's
subsequent commit. Preserve provisioned dependencies and shared cache links. Worker-created build output and temporary
recovery/check scripts are removed after sealing, with unchanged-source evidence in the cleanup receipt. No browser,
provider/account/credential use, external write, installed-app restart or dependency install was performed.


## Worker pass on current main: 10 November 2026

Checkout: queue worktree `2026-10-20-oct2-phasef-tooltip-004b1b`, clean, with `a527bf04d` already an ancestor of HEAD
(`0eb7c3d97`). No Phase F implementation was missing, so no source was rewritten.

- `npm run check:ui-hints` exit 0 but printed "New qualifying wording ... plan-queue-item-list.component.ts" (a sentence
  from the later Plan Queue step-jobs commit `20464b2c2`). Ran `npx tsx scripts/check-ui-hints.ts --record-wording`: one
  entry added to `scripts/ui-hints/wording-ledger.json` (470 → 471 entries, 61 retired, no allowance changed).
- `npm run checks` exit 0 (ran on the Windows PC, 2m12s): typecheck, typecheck:spec, lint, check:ts-max-loc,
  check:ui-hints, build:main, build:renderer all passed.
- `npm run test:quiet -- scripts/__tests__/ui-hints-{baseline,wording,integrity,ratchet}.spec.ts scripts/screen-and-wording-guide.spec.ts`
  exit 0: 5 files, 54 tests.
- Livetest doc: gave the four untitled "Resume additions" checks bold titles so the reported list matches it. No check was run.
- Not run: full suite (coordinator), fresh independent gate (coordinator), generators (no generated source touched), any
  browser or Windows eyes-on check. No browser, credential or provider use. No commit, staging, rename or branch change.



  reason and rendered focus tests to its Check/Install controls; did not restore the removed provider-plugin UI.
- Kept the shared authored glossary, moved main's Connectors term and updated Tool servers definition there,
  and retained the vocabulary projection module. Removed the obsolete renderer glossary; all imports use the
  shared source. Generated agent guidance contains all 47 entries. Tooltip and glossary component imports
  coexist, as do the orchestration test's tooltip and workload-slider imports.
- Tightened the hint records for source improvements already in the merge. Recorded the three new ranked-list
  hints and retired the two checker-only boundary sentences with explicit replacement reasons. Existing
  retirement history was preserved; no debt or exemption count was raised.
- Current receipts: `_scratch/phaseF-merge-2026-10-28/` inside the queue worktree, including `report.md`,
  `commands.jsonl`, `seal.json` and `cleanup-receipt.json`. Generators for aliases, IPC and agent vocabulary ran.
  The focused tests, both typechecks, lint, LOC, both builds, ordinary hints and the comparison against the actual
  merge base passed. Renderer build reports the existing initial-bundle warning. Changed-line wording review:
  `All clear`.
- The worktree dependency folder predates the merged lockfile (Vitest 3 and yauzl/types 2). Verification reused
  the root checkout's installed Vitest 4 and yauzl/types 3, which match the merged lockfile, without installing
  dependencies. The original folder is restored after checks; the verifier must use current dependencies too.
  Newly created build output is removed; no worktree Angular cache was created. Cleanup evidence is in the receipt above.
- Full suite and independent gate remain coordinator-owned and were not run here, per the current worker
  instruction. No Windows browser, screen-reader or rebound-shortcut live check was attempted; the existing
  livetest document and all previously open scope/dependency items remain open. Item 8 remains unchecked.
- Whole-index whitespace checking flags existing incoming evidence logs outside this repair. Scoped source,
  scripts and generated agent guidance pass `git diff --cached --check`; those unrelated logs were preserved.

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items H3-H9 (H1 is Phase B, H2 is Phase A, H10 is
later). **Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · [C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) ·
[D](2026-10-20-oct2-phaseD-tokens_plan.md) · [E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · F (this) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

