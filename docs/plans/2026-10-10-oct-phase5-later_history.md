# October Phase 5: later items — history

Moved verbatim from [2026-10-10-oct-phase5-later_plan.md](2026-10-10-oct-phase5-later_plan.md) during the
Oct-2 Phase B plan diet (Step 3). No text deleted.

## Dated status blocks (preamble)


**Status (23 October 2026, verifier round-5 remediation): all three verifier findings (high / medium / low, confidence
100) fixed in the assigned checkout, and the required full test-suite gate is re-run green unpinned (2,786 files /
35,232 passed | 8 skipped, 0 failed) under the pinned self-contained Node. Awaiting the coordinator verifier. Do not
rename this plan.**
Finding 1 (the full-suite gate failing in the verifier's environment — two SEA repeatability cases under a fuse-less
Homebrew Node 26.12.1 and three stable-version fallback cases exceeding the global 5s `testTimeout`) is fixed at the
toolchain/timeout-budget layer, with no check weakened: the SEA build now runs on the SEA-capable Node pinned in
`.nvmrc` (resolved by the spec, `AIO_SEA_NODE` override, ambient `process.execPath` first when it carries the fuse;
the build's own `assertSeaBuildSupported` still refuses incapable runtimes — never skipped), and the spawn-bound login
cases declare per-case budgets sized to their process work with every assertion untouched. The full suite is re-run
unpinned and green. Finding 2 (Escape dropping keyboard focus when closing the cold Review workbench, whose chip leaves
with its panel) is fixed with a verified focus ladder — the surface's original opener, then a remaining chip, the
composer input, then the always-mounted dock host — pinned by four new step-16 guard cases including the verifier's two
probe shapes. Finding 3 (the dead `hasOptionalSessionInspectors` helper and its obsolete predicate tests) is removed;
the active dock path keeps its guard coverage. Evidence:
[verifier round-5 remediation notes](#as-built-notes-23-october-2026-verifier-round-5-remediation).

**Status (23 October 2026, verifier round-4 remediation): both verifier findings (medium, confidence 100) fixed in the
assigned checkout; the verifier's own boundary probes and the extended step-16 guard pass. Awaiting the coordinator
verifier. Do not rename this plan.**
Finding 1 (the status dock staying rendered after its last content-bearing chip disappeared while its panel was open) is
fixed by making `hasContent` exactly `chipViews().length > 0`, content-gating panel mounting (`isChipOpen` and
`hasOpenChipPanel` only honour chips that currently declare content), and closing — without silently reopening — any
panel whose chip loses content; the review chip keeps its presentation while its panel is open so `openReviewPanel`'s
Cmd/Ctrl+Shift+V workbench stays reachable before the first review under the strict empty-strip rule. Finding 2 (Escape
not returning keyboard focus after closing a chip panel opened from the overflow list) is fixed at its stated mechanism —
overflow chip activation no longer unmounts the panel's trigger — plus an Escape ladder that dismisses the dock's
topmost surface (an open panel first with focus on its chip, else the expanded "+N more" row with focus on the toggle),
so the dock always consumes the Escape and a stray Escape never interrupts a turn mid-ladder. Evidence:
[verifier round-4 remediation notes](#as-built-notes-23-october-2026-verifier-round-4-remediation).


**Status (23 October 2026, verifier round-3 remediation): both verifier findings (high, confidence 100) fixed in the
assigned checkout; worker-level targeted tests and every fast static/build/generator check re-run green. Awaiting the
coordinator verifier's full suite and fresh-eyes gate. Do not rename this plan.**
Finding 1 (file-size gate — `output-stream.component.ts` grew 23 lines to 1,291, over the 1,228 + 50 ratchet) is fixed by
moving the additions' logic out of the file instead of raising the ceiling: the reply-menu actions (Ask Council open,
second-opinion request, fork-at-message) now live in the new `reply-menu-actions.ts` and the pick gate in `table-pick.ts`'s
`tablePicksDisabled`; the file is 1,271 lines under the unchanged ratchet. Finding 2 (UI-hint ratchet — `check:ui-hints`
exited 1 with the dock's two native titles, two hover-only hosts, stale baseline counts, two unreadable measurements and
22 unrecorded qualifying sentences; `ui-hints-baseline.spec.ts` failed with 12 discrepancies) is fixed: the dock's chip
titles use `appTooltip`, the activity-status and MCP cost hints are keyboard reachable (`tabindex="0"`), the sidebar
header's shortcut moved to `appTooltipShortcut` (the sanctioned channel, dropping the unreadable pipe binding), the MCP
cost hint composes from the `TOOLTIP_COPY.mcpServerCost` wording plus a plain template figure so the wording reader can
measure it, and `check:ui-hints -- --tighten --record-wording` reconciled the records (every baseline count lowered or
kept, 22 wording entries added, none removed or edited; `--against HEAD` shows no increase). Evidence:
[verifier round-3 remediation notes](#as-built-notes-23-october-2026-verifier-round-3-remediation).


**Status (23 October 2026, verifier round-2 remediation): all five verifier findings fixed in the assigned checkout;
targeted tests and fast static/build gates re-run green. Awaiting independent re-verification (round 3). Do not rename this plan.**
Finding 1 (high — live loop-question controls inside the collapsible status dock's Outstanding chip) is fixed by removing
the `outstanding` chip from the strip and mounting `app-loop-outstanding-panel` beside the approvals in
`InstanceDetailComponent`, with the four-case guard extended to open every registered chip and to recognise the
transitive loop-question surfaces. Finding 2 (Enter on the focused Cancel button confirming a non-danger dialog) is fixed
by routing Enter to the focused button's meaning in `confirm-dialog.component.ts`. Finding 3 (table picks enabled in hosts
without an "Add to reply" destination) is fixed by gating `areTablePicksDisabled` on the new `tablePicksToComposer` input.
Finding 4 (keyboard Undo falling back through older action kinds) is fixed by the single newest-action slot in
`UndoService`. Finding 5 (compact-preview tip's availability hard-coded false) is fixed by deriving
`compactPreviewAvailable` from the real compaction-preview control's live availability. Evidence:
[verifier round-2 remediation notes](#as-built-notes-23-october-2026-verifier-round-2-remediation).

**Status (23 October 2026, verifier round-1 remediation): all three verifier findings fixed in the assigned checkout;
targeted tests and fast static/build gates re-run green. Awaiting independent re-verification. Do not rename this plan.**
Finding 1 (relayed cross-session provenance dropped by the continuity round trip, turning a relayed `@session` reference
into a cross-project read grant after hibernate/wake) is fixed by carrying `crossSessionMessage` through
`ConversationEntry` both ways plus a relay-wrapper fallback in the grant scan. Finding 2 (step 16's strip/registry/
overflow/acceptance guard absent) is fixed by delivering `session-status-dock.*` in this branch's running path with the
typed `DOCK_CHIPS` registry, `splitDockChips`/`DOCK_CHIP_VISIBLE_CAP = 5` overflow, `resolveEscapeRouting` Esc routing
and the green four-case guard `session-status-dock.rules.spec.ts`. Finding 3 (activity view losing tool names after
restore) is fixed in `session-transcript-view.ts` (`metadata.toolName`). Evidence:
[verifier round-1 remediation notes](#as-built-notes-23-october-2026-verifier-round-1-remediation).

**Status (23 October 2026, merge-conflict resume): all 10 coordinator-reported conflicts resolved and staged; the merge remains in progress for the coordinator.**
Phase 5's recovery pointer now flows through Phase 0's named-block continuity package in the staged merge.
Focused verification passes: 26 spec files / 233 tests, both typechecks, lint, file-size check, IPC/export/contract checks,
and main/renderer production builds. This is worker evidence, not an independent verification PASS. Step 16 remains open
on Phase 3 integration. Do not rename this plan. See
[the merge-resolution notes](#merge-resolution-notes-23-october-2026) and the earlier
[restored-checkout checklist](#restored-checkout-acceptance-checklist-23-october). *(Superseded on step 16 by the
round-1 remediation above: the strip and guard are now delivered in this branch.)*

**Restoration checkpoint (22 October 2026, coordinator): restoration DONE — re-verify from the restored checkout.**
The recorded Phase 5 work is restored: branch `queue/2026-10-10-oct-phase5-later-da028b` now points at the recorded
checkpoint `6c6a73f90` (the branch held no commits of its own — it sat at `542f1f690` on main — so the pointer move
lost nothing; `queue/2026-10-10-oct-phase5-later-3e8047` is unchanged and still holds the same three checkpoints).
The reader, Undo service, shared confirm dialog, table picker, tips and the other Phase 5 modules are therefore
present in the assigned checkout again. Base is behind current main; reconciling the moved base, the landed Phase 0
continuity package and Phase 3's status strip is the next worker's job as normal queue work. A separate older draft
of the same modules lives only on `queue/2026-10-10-oct-phase5-later-e9f577` (a superseded worker-error checkpoint
on a pre-October base); do not merge it — it is a parallel implementation and is parked as a leftover. Do not close
or rename until verification and landing pass.

**Pre-restoration observation (20 October 2026 retry):** the supplied checkout then started at `542f1f690` and did not
contain checkpoint `6c6a73f90`, so no active step was certified complete in it; the checked entries and verification
counts below describe the historical 12–16 October branch only. See the current as-built notes below.

**Historical status (16 October 2026, prior checkout):** active implementation in queue worktree; verifier round-1 findings addressed 2026-10-16. Steps 1–15 and 17
are implemented and their focused checks pass in this branch (round-1 test-sync defects in the forwarder tool-inventory
assertion and the browser approval-routing spec are fixed). Step 16 (C13.12) is **delivered but not integrated in this
branch**: its two rules and the four-case guard spec were built into Phase 3's C2b status strip (`session-status-dock.*`
on branch `queue/2026-10-10-oct-phase3-calm-scr-a4427f`) via the recorded handoff, and are green there — but this plan
forbids a second strip and the queue rules forbid importing another AIO worktree, so the guard **cannot run in this
branch's code path**. Step 16's acceptance therefore runs only at the **coordinator's Phase 3 + Phase 5 integration**
(the worker cannot close it here; see Finishing's carry-over option). Step 10 meets its Done-when; the snooze-state
relocation into Phase 3's root needs-you store is Phase 3 step 6c's own specified work. Coordinator gates remain: full
suite, fresh-eyes PASS, and the step-16 guard at integration. The live campaign remains. Written 2026-10-10. Keep this
file untracked until every step is implemented and verified (see [Finishing](#finishing)). *(Superseded 23 Oct 2026:
the verifier rejected the step-16 deferral; the strip and its guard are now delivered in this branch — see the top
status and the [remediation notes](#as-built-notes-23-october-2026-verifier-round-1-remediation).)*


## Coordinator handover (13 Oct 2026)

> **Coordinator handover (13 Oct 2026, Plan Queue parent).** Done: the parked branch
> `queue/2026-10-10-oct-phase5-later-e9f577` was merged into this queue worktree on 15 Oct 2026 (squash merge, base
> `4d175e55b`, three content conflicts resolved by union; see the 15 Oct queue ledger below). The as-built notes are
> reconciled against it.

## Dated as-built, remediation and verification sections

## Merge-resolution notes (23 October 2026)

This resume resolves the coordinator's in-progress merge of `main` (`1ee52cbd8c24d7bec80c161c03595e0d77d27f02`)
into queue HEAD `6c6a73f90f0bb4de246958cde1fc97cd90536cc4`. Both pointers remain unchanged. The worker did not
start, finish or abort the merge, commit, stash, switch branches, or create a branch/worktree. Existing staged incoming-main
changes were preserved. All ten reported paths and their required companion changes are staged; the unmerged index is empty.

- **Compaction:** retain main's isolated, budgeted `prepareRestartCompaction`, active-window selection, summary sampling,
  wait rule, continuity stats and restart archive metadata. Pass the verified complete-transcript message count through
  to `buildContinuityPackage`; it calls the existing recovery builder after `identifier_index`, identifies the recovery
  block as reference data, and inserts the lookup instruction before the final tools sentence. Local bridge checks and
  omission for missing tooling, Gemini, Antigravity or remote placement survive. The pointer/read-back integration tests pass.
  This resolves the Phase 0/Phase 5 recovery-pointer reconciliation noted in the earlier restored-checkout ledger.
- **Lifecycle and providers:** retain task-tool registry configuration/cleanup and warm-adapter/worker restrictions alongside
  main's OpenCode warm-start exclusion, signal-fence gates and registry cleanup. Both sets of tests survive.
- **Tool inventory:** retain `read_session`, `list_host_processes` and `stop_leftover_processes` in runtime order.
- **Reply menus:** retain both distinct routes: reply-specific Council prefill/navigation and the session second-opinion IPC.
  Added coexistence and callback-isolation coverage so one action cannot silently replace the other.
- **Generated code:** regenerated IPC channels from merged contracts (1,203 synchronized channels) and aliases; the alias
  generator leaves its tracked output unchanged. The generated channel file is staged.
- **Static-check remediation:** the initial spec typecheck exposed three TS2493 tuple-index errors in two specs byte-identical
  to incoming main: `storage/low-disk-space-watcher.spec.ts` and `storage/scratch-sweep-scheduler.spec.ts`. Typed the notification
  mock functions with their real argument contracts; production behavior and every assertion remain unchanged. Their 13 tests
  and the canonical spec typecheck now pass. Compact import formatting keeps lifecycle within its existing size tolerance;
  no file-size ceiling, test threshold, suppression or build configuration was relaxed.

| Requested handoff item | Evidence/status |
|---|---|
| Resolve every listed conflict | **10/10 resolved and staged**; no conflict markers in staged changed text files |
| Preserve both sides' intent | Compaction, lifecycle, tool inventories and both reply routes retained and reviewed |
| Focused tests | **24 files / 220 tests PASS**, plus **2 storage files / 13 tests PASS**; cache disabled |
| Static checks | `npx --no-install tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` all exit 0 |
| Contracts/generators | `generate:ipc`, `generate:aliases`, `verify:ipc`, `verify:exports`, `check:contracts` all exit 0 |
| Production builds | `build:main` and `build:renderer` exit 0; renderer warns about its 1.39 MB initial bundle against the 1.00 MB warning budget |
| Whitespace | Diff against incoming main passes. Whole staged diff reports six inherited blank-at-EOF warnings, all byte-identical to incoming main and left untouched |
| Merge lifecycle | `MERGE_HEAD` retained, HEAD unchanged; coordinator must finish merge and run independent verification |
| Plan lifecycle | Root plan updated in place, never copied into worktree or renamed; step 16 and existing live checks remain open |

Evidence: `_scratch/phase5-merge-2026-10-23/` in the assigned worktree contains the report, source seal, full command logs,
raw focused-test logs and SHA-256 command receipts. The initial focused run reproduced one stale old-inline-package ordering
assertion (132/133 passed); it now checks the required named-block placement and final wait-rule order. The implementer's own
review found no unresolved actionable defect in these resolutions; this does not substitute for the coordinator's fresh agent.
The full test suite was deliberately not run, per this worker's instruction. Existing rebuilt-app/provider/keyboard checks
remain in [the live-test document](2026-10-10-oct-phase5-later_livetest.md); no new live-only acceptance was invented or closed.
After evidence sealing, remove this run's `dist/` and `.angular/` outputs and record cleanup; preserve the pre-existing dependency
installation. No browser, desktop app, external service, credential lookup, database cluster or copied checkout was needed.

## As-built notes (23 October 2026, verifier round-5 remediation)

An independent verifier (this queue cycle's second verification round; "round 5" in this document's cumulative numbering)
failed the delivered work with one high, one medium and one low finding (all confidence 100). All three are reproduced
where applicable and fixed in the assigned checkout
(`.worktrees/queue/2026-10-10-oct-phase5-later-da028b`, branch `queue/2026-10-10-oct-phase5-later-da028b`, on top of the
coordinator's merge checkpoint `8db862494`). No commits, branch changes, stash or document renames were made by this
worker. No separate spec exists to update.

1. **Finding 1 (high) — the required full test-suite gate failed in the verifier's environment** (5 of 35,249:
   `sea-build-repeatability.spec.ts` ×2 because `/opt/homebrew/Cellar/node/26.12.1/bin/node` lacks the Node SEA fuse and
   `assertSeaBuildSupported` refused the build, and `opencode-account-login-command.spec.ts`'s three stable-version
   fallback cases timing out against the 5,000 ms global `testTimeout`). Both spec files are unchanged by this plan's
   diff, so this is a toolchain/timeout-budget problem, not a plan defect — but the gate must be green without weakening
   any check. Fixes:
   - `scripts/__tests__/sea-build-repeatability.spec.ts`: the spawned build now runs on a SEA-capable Node resolved by
     the new `resolveSeaBuildNode()` — `AIO_SEA_NODE` when set, else `process.execPath` when its image carries the fuse
     (a `nvm use` shell), else the self-contained Node pinned in `.nvmrc` (the nvm/mise install paths that
     `assertSeaBuildSupported`'s own remediation message names). A SEA embeds the runtime that builds it, so the build
     must run on the pinned toolchain regardless of which distribution runs vitest; the failure was the test inheriting
     a fuse-less host Node. Every check is unchanged: build exit 0, the read-only previous executable replaced at mode
     0755, and the produced SEA running the fixture. With no capable runtime the build's own assertion still fails the
     case with its remediation message — the check is never skipped. Verified in both directions: under the verifier's
     exact fuse-less Homebrew Node 26.12.1 (2/2 pass — the same two cases that failed there) and under the pinned Node
     (inside the full suite below).
   - `src/shared/utils/opencode-account-login-command.spec.ts`: the spawn-bound cases in `generated login version
     boundary` now declare per-case budgets sized to their process work — `prefers stable …` 60s, `falls back to stable
     version 1` 30s, `refuses unsupported …` 30s, `rechecks a copied selected command` 20s — following the file's own
     existing `15s` idiom on the `__hang__`/`__overflow__` case. These cases run the real generated shell command per
     profile (a `/bin/sh` wrapper, a Node eval, and freshly written CLI fakes that each cold-start a Node process); calm
     runtime is under ~1s per case but the work is process-spawn-bound and the full suite runs on a shared host (macOS
     first-exec tails plus CPU starvation — the documented "specs that shell out under a timeout" class in
     `docs/testing.md`). No assertion was edited, weakened or removed.
   - **Investigation evidence for the timeouts:** calm `--reporter=verbose` timing puts the three failing cases at
     0.84–1.0s each (≈5× under the 5s default with little headroom), while the verifier's full run put the whole file at
     71.4s versus 16.3s calm — Homebrew Node 26 process-startup cost multiplied by full-suite fork contention. The
     5s default is a unit-test budget; these are mini-integration flows. Home remedy matches `docs/testing.md`
     (`rtk-runtime`'s patient second probe, the FIFO spec's diagnosis) and this file's own precedent.
   - **The required gate, re-run unpinned and green:** `npm run test:quiet` under the pinned self-contained Node
     (`v24.22.1`, `.nvmrc`) — **Test Files 2786 passed (2786); Tests 35,232 passed | 8 skipped (35,240); 0 failed;
     3,469s.** Evidence `_scratch/test-run.pid-50260.log`, `_scratch/test-results.pid-50260.json`,
     `_scratch/phase5-round5/full-suite-console.log`. The count reconciles exactly with the verifier's 35,249: minus
     the 13 tests of the removed obsolete spec (finding 3) plus the 4 new guard cases (finding 2). Nothing skipped, no
     assertion/ceiling/threshold/lint change; the only timeouts added are per-case budgets on tests whose assertions are
     untouched.

2. **Finding 2 (medium) — Escape dropped keyboard focus when closing Review before any review has run.** Reproduced
   2/2 with the verifier's own probe (`_scratch/verifier-411208c2-round5/focus.spec.ts`) before the fix. Root cause
   exactly as stated: `dismissOpenSurface` focused the Review trigger after closing, but `reviewChip.describe` returns
   null once `!reviewHasContent && !open`, so the next render removed the focused element and focus fell to `<body>`.
   (The round-4 notes had recorded this as an "accepted edge"; the verifier rejected that disposition — recorded here so
   the history stays honest.) Fix in `session-status-dock.component.ts`:
   - `dismissOpenSurface` now chooses its focus target by whether the closing chip's trigger survives the close
     (`chipTriggerSurvivesClose`: `describe(ctx, false) !== null`). A surviving trigger keeps the pinned behaviour
     (focus the chip); a trigger that leaves with its panel runs the new `focusAfterTriggerGone` ladder:
     1. the surface's **original opener** — `surfaceOpener`, the element holding focus when the surface opened
        (`rememberSurfaceOpener` records it on `toggleChip`-to-open and `openReviewPanel`, excluding body/document
        element) — unless that opener is the dying trigger itself;
     2. a **remaining chip** that still declares content;
     3. the **composer input** (`app-input-panel textarea`, resolved from the dock's own region outward so a composer
        belonging to another feature sharing the document can never be picked);
     4. the **dock host**, which survives even when the strip renders nothing (gained `tabindex="-1"`, programmatic-only
        focus).
   - Every step is verified (`tryFocus`): a candidate that cannot actually take focus (disconnected, disabled,
     unmounted on the next render) falls through to the next, so keyboard focus never lands on `<body>`.
   - **Guard coverage** (step 16's acceptance artifact `session-status-dock.rules.spec.ts`, 26 → 30 cases): the
     verifier's two probe shapes — cold Review with no other chip (focus survives on the host) and with an Agents chip
     (focus lands on the Agents chip) — plus the two named fallbacks: the composer input when the strip vanishes, and
     the original opener outranking the remaining-chip/composer fallbacks. The verifier's probe passes 2/2 after the
     fix (`_scratch/phase5-round5/`).

3. **Finding 3 (low) — the new inspector-visibility helper was dead production code.** Removed
   `session-inspector-visibility.ts` (`hasOptionalSessionInspectors`; the repository-wide search found no production
   caller) and `instance-detail-inspectors.spec.ts` — its predicate cases exercised only the removed helper, and its
   remaining cases manipulated bare local signals without touching production code. The active dock path
   (`SessionStatusDockComponent.chipViews`/`hasContent`) keeps its coverage in the guard's "renders nothing when no chip
   has content", "shows the strip only through registered chips declaring content" and the new focus cases. Also fixed
   the one stale code comment naming the deleted spec (`input-panel-edit-mode.spec.ts`); historical plan documents
   mentioning it are left as history. `npm run check:dead` exits 0 (its 21 unbaselined helper candidates are pre-existing
   `_resetForTesting` shapes from the merged main, unrelated to this diff).

**Verification after the fixes (this worker, not an independent PASS):**
- Verifier probe `_scratch/verifier-411208c2-round5/focus.spec.ts`: 2/2 fail before the fix, 2/2 pass after
  (`_scratch/phase5-round5/`).
- Guard `session-status-dock.rules.spec.ts`: 30/30 (the plan's original cases unchanged and still passing).
- Neighbourhood sweep `src/renderer/app/features/instance-detail`: 87 files / 901 tests (−13 from the removed obsolete
  spec, all else unchanged).
- Both previously failing spec files re-run under the verifier's exact Homebrew Node 26.12.1: SEA repeatability 2/2
  (build executed on the resolved pinned Node), login-command 37/37 (23.6s, inside the new budgets). Also in the full
  suite under the pinned Node: SEA repeatability 2/2 (17.8s), login-command 37/37 (15.0s under full-suite load),
  sea-build-support 10/10, guard 30/30.
- Sibling families (`opencode-account-login-activation`, `opencode-account-login-repair`, `check-node`): 3 files /
  29 tests.
- Fast static/build gates all exit 0: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run
  check:ts-max-loc` (no ceiling or tolerance changed), `npm run check:ui-hints`, `npm run check:dead`,
  `npm run build:main`, `npm run build:renderer` (the renderer build keeps its pre-existing initial-bundle budget
  warning).
- **Full suite: 2,786 files / 35,232 passed | 8 skipped / 0 failed** (evidence in finding 1). This supersedes the
  earlier rounds' "full suite assigned to the coordinator verifier" note for this remediation: the verifier's finding
  directed this worker to re-run it, and it is green.
- Generators: `build:main`'s `prebuild:main` refreshed
  `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` for this machine's codex-cli 0.164.0 (snapshot
  pinned at 0.163.0); that toolchain-version artifact is outside this plan's scope and was reverted, exactly as the
  round-3 notes record.
- Runtime cleanup: this run's `dist/` build outputs removed after the evidence logs were written; the pre-existing
  `node_modules` dependency installation is preserved. No database cluster, browser binary, copied checkout or external
  service was needed.

**Worker handoff (23 Oct, after verifier round 5):** all three verifier findings fixed and re-verified (probe 2/2,
guard 30/30, both previously failing specs green under the verifier's own Homebrew Node 26.12.1 and in the full suite,
full `npm run test:quiet` 0 failed). No commits, branch changes or document renames by this worker. Parked steps 18–21
unchanged in the follow-up plan. Awaiting the coordinator verifier only: the fresh-eyes gate (`task-completion-gate`),
the Phase 3 C2b merge reconciliation against the delivered strip, and the live campaign in
[the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## As-built notes (23 October 2026, verifier round-4 remediation)

An independent verifier (this queue cycle's first verification round; "round 4" in this document's cumulative numbering)
failed the delivered work with two medium findings (both confidence 100) against step 16's strip rules. Both are
reproduced and fixed in the assigned checkout
(`.worktrees/queue/2026-10-10-oct-phase5-later-da028b`, branch `queue/2026-10-10-oct-phase5-later-da028b`, on top of the
coordinator's round-3 checkpoint `8b7c082d6`). No commits, branch changes, stash or document renames were made by this
worker. No separate spec exists to update. The verifier's probe file
(`_scratch/verifier-411208c2/boundaries.spec.ts`, retained) failed 2/2 before and passes 2/2 after.

1. **Finding 1 (medium) — the strip stayed rendered after its last content-bearing chip disappeared while its panel was
   open.** `hasContent` ORed `chipViews().length` with stale `openPanels` state and the panel template still mounted
   Agents, leaving `.session-status-dock` with a child panel and no chip button to close it. Fix in
   `session-status-dock.component.ts`:
   - `hasContent` is exactly `chipViews().length > 0` — step 16's "renders nothing when no chip has content", with no
     open-panel escape hatch.
   - `isChipOpen(id)` and `hasOpenChipPanel` now require the chip to currently declare content (`chipViews()`), so a
     panel whose chip empties unmounts (`app-child-instances-panel` included) even when other chips keep the strip alive.
   - New `stalePanelSync` effect drops `openPanels` entries whose chip lost content, so the panel is genuinely closed and
     cannot silently reopen when the chip regains content (guarded by the new "does not silently reopen" case).
   - **Companion rule so the fix does not break the review workbench:** `reviewChip.describe` in
     `session-status-dock.rules.ts` keeps its presentation while its panel is open (`!ctx.reviewHasContent && !open`).
     The review panel is a workbench the user opens with Cmd/Ctrl+Shift+V (`openReviewPanel`) *before* any review exists;
     under the strict empty-strip rule the open panel's trigger chip is what the chip has to show. Content-list chips
     (Agents, Checkpoints) deliberately do **not** do this — they hide when their list empties even while open, which is
     exactly the verifier's probe-1 case. The new guard case "keeps openReviewPanel reachable before the first review
     runs" pins both halves (open with no review renders the panel and its chip; closing it renders nothing).
2. **Finding 2 (medium) — Escape failed to return keyboard focus after closing a panel opened from the overflow list.**
   `onOverflowChipClick` set `overflowOpen=false`, unmounting the overflow chip's button, so `closeOpenChipPanel`'s
   `data-chip-id` lookup silently skipped focus restoration. Fix in `session-status-dock.component.ts`:
   - **Mechanism removed:** chip activation from the overflow row no longer collapses the row. The activated chip is the
     panel's trigger and stays mounted and focused exactly like a visible chip (the row is an in-flow chip row, not an
     overlay; `.dock-overflow-list` is plain flex layout). The row still collapses from its "+N more" toggle or Escape.
   - `closeOpenChipPanel` became `dismissOpenSurface` (call sites updated in `instance-detail.component.ts` and the
     dock's own `handleEscapeKey`): it dismisses the topmost open dock surface and returns focus to its trigger — an
     open chip panel first (focus its `[data-chip-id]` button, falling back to the overflow toggle), else the expanded
     overflow row (focus "+N more"). Returning `true` means the dock consumed the Escape, so `resolveEscapeRouting`'s
     `dockPanelWasOpen: true` path prevents the default and never interrupts an in-flight turn mid-ladder; the ladder is
     panel → overflow row → the existing interrupt routing. `resolveEscapeRouting` itself is unchanged (its pinned
     behaviour and spec are untouched); only its doc comment now names both dock surfaces.
   - Guard cases added: the verifier's probe-2 shape ("Escape closes a panel opened from the overflow list and returns
     focus to its chip", asserting `document.activeElement` is the chip **and** inside the dock) and the ladder step
     ("Escape collapses an expanded overflow row and returns focus to the '+N more' control").
3. **Guard spec extension (step 16's acceptance artifact).** `session-status-dock.rules.spec.ts` grew from 21 to 26
   cases; the five new cases are the two verifier probes (verbatim shapes), the stale-panel close/no-silent-reopen case,
   the overflow-row Escape step, and the `openReviewPanel` bootstrap case. The plan's original four cases are unchanged
   and still pass.
4. **Verification evidence (this checkout, `_scratch/phase5-round4/`):**
   - Verifier's own boundary probes: `npx vitest run --config _scratch/verifier-411208c2/vitest.config.ts --no-cache`
     — 2/2 pass (both failed before the fix).
   - Guard spec `session-status-dock.rules.spec.ts`: 26/26 pass.
   - Neighbourhood sweep `src/renderer/app/features/instance-detail`: 88 files / 910 tests pass
     (`_scratch/phase5-round4/instance-detail-sweep.log`).
   - `npx tsc --noEmit` exit 0 (`tsc.log`); `npm run typecheck:spec` exit 0 (`typecheck-spec.log`); `npm run lint`
     exit 0 ("All files pass linting", `lint.log`); `npm run check:ts-max-loc` exit 0 (`loc.log`, no ceiling or
     tolerance changed); `npm run check:ui-hints` exit 0 (`ui-hints.log`); `npm run build:renderer` exit 0
     (`build-renderer.log`; the pre-existing initial-bundle budget warning remains and is not from this change).
   - Fresh self-review of the four-file diff (`review.diff`): no unresolved actionable defect. One accepted edge, stated
     for the reviewer: Escape closing the review-bootstrap panel (no review ever run) also removes the whole strip under
     the empty-strip rule, so focus has no dock control left to land on; the dock does not reach outside itself for a
     fallback. Everything else returns focus to a live dock trigger. *(Superseded 23 Oct 2026, verifier round-5
     remediation: the verifier rejected that accepted edge as a medium finding; the dock now restores focus through the
     opener / remaining-chip / composer / host ladder — see
     [the round-5 notes](#as-built-notes-23-october-2026-verifier-round-5-remediation).)*
   - **Full suite intentionally not run:** the Plan Queue worker instructions assign `npm run test:quiet` to the
     independent coordinator verifier. No live-only acceptance was introduced: both findings are unit-verifiable and are
     verified in-loop here.
   - Runtime cleanup: this run's build outputs (`dist/`, 150 MB; `.angular/` was never created) removed after the
     evidence logs were written; the pre-existing `node_modules` dependency installation is preserved. No database
     cluster, browser binary, copied checkout or external service was needed.

**Worker handoff (23 Oct, after verifier round 4):** both verifier findings fixed and re-verified (the verifier's own
probes 2/2, guard 26/26, instance-detail sweep 910 tests, all fast static/build gates green). No commits, branch
changes or document renames by this worker. Parked steps 18–21 unchanged in the follow-up plan. Awaiting the
coordinator verifier only: `npm run test:quiet` (full suite), the fresh-eyes gate (`task-completion-gate`), the Phase 3
C2b merge reconciliation against the delivered strip, and the live campaign in
[the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## As-built notes (23 October 2026, verifier round-3 remediation)

An independent verifier (round 3) failed the delivered work with two high findings. Both are fixed in the assigned
checkout (`.worktrees/queue/2026-10-10-oct-phase5-later-da028b`, branch `queue/2026-10-10-oct-phase5-later-da028b`,
building on the coordinator's round-3 checkpoint `8940eb287`, which contains the finished main merge). No commits,
branch changes, stash or document renames were made by this worker. No separate spec exists to update.

1. **Finding 1 (high) — `output-stream.component.ts` over the file-size ratchet (1,291 vs 1,228 + 50).** The plan's rules
   forbid raising ceilings, so the additions' logic moved out of the file; the recorded 1,228 ceiling is untouched:
   - New `reply-menu-actions.ts` (`ReplyMenuActions`, `providedIn: 'root'`) owns the reply menu's non-UI actions: the
     Ask Council open (prefill + `/ask-council` navigation), the session second-opinion request, and fork-at-message
     (`IpcFacadeService.forkSession` + selecting the forked session). `output-stream.component.ts` drops the
     `Router`, `CouncilPrefillService`, `CrossModelReviewIpcService` and `IpcFacadeService` imports/injects and its
     private `forkFromMessage`; its menu closures call the service.
   - `table-pick.ts` gains the pure `tablePicksDisabled(message, picksToComposer, status)`; the component's
     `areTablePicksDisabled` (name, shape and pinned behaviour unchanged) delegates to it.
   - Result: 1,271 lines, under the ratchet; `npm run check:ts-max-loc` exits 0.
   - **Behaviour notes:** the "Fork from here" closure now closes the menu before the service's no-id/no-index guard
     (previously guard-then-close); the item is only rendered when the index exists and `instanceId` is a required
     input, so the change is unobservable on reachable paths. `output-stream-council.spec.ts` keeps its two isolation
     and prompt-content assertions at the menu seam (`replyActions.openAskCouncil` receives the built prompt; the
     second-opinion action never opens Council); the prefill/navigate and fork chains are covered by the new
     `reply-menu-actions.spec.ts` (4 tests). The fork integration path
     (`instance-detail-history-preview-restore.spec.ts`, real `IpcFacadeService` stub) passes unchanged.

2. **Finding 2 (high) — UI-hint ratchet (`check:ui-hints` exit 1; `ui-hints-baseline.spec.ts` 12 discrepancies).**
   Source fixes first, records reconciled afterwards with the sanctioned CLI; no assertion was weakened
   (`ui-hints-baseline.spec.ts` and `check:ts-max-loc.ts` are untouched):
   - `session-status-dock.component.ts`: both chip buttons' native `[title]` bindings are now `[appTooltip]` with
     `AioTooltipDirective` imported — the same `chip.presentation.title` words, on the Harness tooltip channel.
   - `activity-status.component.ts` and `mcp-server-cost.component.ts`: the explanatory hint hosts are keyboard
     reachable (`tabindex="0"`, the focusable path house rule 4 names; `context-bar.component.ts`'s cost span is the
     existing precedent). This clears both H4 hover-only findings and means the hints open on keyboard focus.
   - `sidebar-header.component.ts`: the New-session hint's `('new-instance' | shortcutHint)` concat (an unreadable pipe
     binding and a hand-assembled shortcut) is replaced by `appTooltipShortcut="new-instance"` — H5's sanctioned
     channel; the panel renders the live binding as its `<kbd>` chip and the button gains `aria-keyshortcuts`. The
     `ShortcutHintPipe` import is gone; the spec's `KeybindingService` fixture gained the directive's
     `ariaShortcutsByAction` reader.
   - `mcp-server-cost.component.ts` + `TOOLTIP_COPY.mcpServerCost`: the `copyFor(...).replace('{tokens}', String(...))`
     computed (the second unreadable measurement: a non-`this` `.replace` call) is now
     `serverCostHint(nameTokens)`, a concat of the registry wording and the figure, with the figure supplied as a plain
     template value (`@let nameTokens = cost().nameTokens;`). The rendered hint is unchanged ("…tool names, about N
     tokens."); the registry meaning now ends at "…tool names," and the figure clause composes at the call site. The
     spec pins the filled figure (`serverCostHint(2)` contains "about 2 tokens.") as well as "Claude". The reader can
     now fold the wording, so the owner's unreadable count returns to zero instead of being recorded as new debt
     (the ratchet forbids an unreadable count rise).
   - Records: `check:ui-hints -- --tighten --record-wording` recorded the stale decreases (workspace-rail H1b/H2a,
     sidebar-header H1b/H2a/H5, instance-list H2a, instance-detail H2a) and added 22 qualifying wording entries
     (sidebar-header 2, workspace-rail 1, activity-status 1, composer-autocomplete 1, wake-management 15,
     mcp-server-cost 1); nothing was removed or edited. `check:ui-hints` and `--against HEAD` now exit 0, and
     `scripts/__tests__/ui-hints-baseline.spec.ts` passes (the 12 discrepancies are gone). The check's advisory
     reports (H1c/H7/H8) are unchanged report-only debt.

**Verification after the fixes (this worker, not an independent PASS):**
- Targeted tests: the touched families pass — 79 files / 685 tests (scripts `__tests__`, `shared/tooltip`, mcp,
  knowledge, the output-stream/council/table-pick/dock/activity specs), plus 8 files / 51 tests (dashboard,
  history-preview-restore, edit-resend — includes the fork integration), plus 8 files / 95 tests (the three other
  `app-output-stream` hosts: side-chat, chats, compare), plus the two named settings specs
  (`claude-task-list-settings`, `working-tips`, 4 tests). Logs: `_scratch/phase5-round3/`.
- `npx --no-install tsc --noEmit`, `npm run typecheck:spec` (canonical 8 GiB command), `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run check:dead`, `npm run build:main`,
  `npm run build:renderer` (the Angular template gate for the `@let` and the tooltip bindings): all exit 0. The
  renderer build keeps its existing initial-bundle warning (1.49 MB against the 1.00 MB budget).
- Generators/contracts: `generate:ipc`, `verify:ipc`, `verify:ipc-usage`, `generate:aliases`, `verify:exports`,
  `check:contracts` all exit 0 and leave the tracked outputs unchanged for this plan's surfaces. One caveat: this
  machine's installed codex-cli is 0.164.0, so `generate:ipc` refreshes
  `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` (pinned here at 0.163.0); that
  toolchain-version artifact is outside this plan's scope and was reverted so the diff stays scoped — a deliberate
  protocol-snapshot refresh belongs to a housekeeping change.
- No ceiling, tolerance, lint config, test threshold or suppression was changed. No package/lockfile change. The full
  suite is deliberately not run (assigned to the coordinator verifier by the current queue brief).
- Remaining open, unchanged: the coordinator verifier's `npm run test:quiet`, the fresh-eyes gate
  (`task-completion-gate` — its Gate 0 reproduces the full suite, so it runs with the coordinator's verification),
  the coordinator's Phase 3 C2b merge reconciliation against the delivered strip, and the rebuilt-app/provider/
  real-keyboard checks in [the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## As-built notes (23 October 2026, verifier round-2 remediation)

An independent verifier (round 2 of 3) failed the delivered work with five findings. All five are fixed in the assigned
checkout (`.worktrees/queue/2026-10-10-oct-phase5-later-da028b`, branch `queue/2026-10-10-oct-phase5-later-da028b`,
building on the coordinator's round-2 checkpoint `e0708b617`). No commits, branch changes, stash or document renames
were made by this worker. No separate spec exists to update.

1. **Finding 1 (high) — live human-question controls hid inside the collapsible status dock's Outstanding chip.**
   Root cause confirmed: this branch's `session-status-dock.component.ts` mounted `LoopOutstandingPanelComponent` behind
   the `outstanding` chip, and that panel's template transitively renders `app-loop-question-row` for `firstSeenRound`
   questions plus its own "Earlier questions" answer controls — so collapsing the chip hid pending decisions, which
   step 16 forbids ("B5 loop questions … must **not** go inside because they are decisions"; the guard pins "no approval
   or question component is rendered inside the strip"). The old guard checked only four selectors and never opened the
   chip panels, so the transitive surface was invisible to it. Fixes:
   - `session-status-dock.rules.ts`: the `outstanding` chip is removed from `DOCK_CHIPS`, `DockChipId` and
     `DockChipContext`; the header now records that the loop Outstanding panel and B5 questions are question surfaces
     that mount beside the approvals and never behind a chip. `splitDockChips`'s blocker rule is unchanged (covered by
     its unit tests) and no decision chip is registered today.
   - `session-status-dock.component.ts`: drops the panel mount, its import, the `LoopStore` injection, the
     `outstandingOpenCount` context value and the dock's `loadOutstanding` call.
   - `instance-detail.component.html`: `<app-loop-outstanding-panel [chatId]="inst.id"
     [workspaceCwd]="inst.workingDirectory" />` now mounts in the decisions block with `app-user-action-request` and
     `app-browser-approval-request`, **outside** the strip — so collapsing any chip can never hide it.
   - `loop-outstanding-panel.component.ts`: the panel is now a self-gating decision surface (renders nothing while it
     has no items — the same visibility its old chip badge had), documented as such; its dead empty-state branch and
     `.o-empty` style are gone.
   - Guard `session-status-dock.rules.spec.ts`: `APPROVAL_OR_QUESTION_SELECTORS` extended with `app-loop-question-row`,
     `app-loop-questions-chip` and `app-loop-outstanding-panel`; the DOM case now uses the real `DOCK_CHIPS` registry
     with every chip's content seeded (review started, children, checkpoints) and **opens each chip in turn**, asserting
     the strip never renders a question/approval component, a `textarea` or a `.question` row; source pins assert the
     dock renders none of those surfaces and the rules never register `'outstanding'`; a new case pins the host wiring
     (the question surface sits with the approvals, before `<app-session-status-dock`). The registry tests pin the
     three inspector chips and that no decision chip is registered. Panel render tests pin the self-gate and the live
     question surface when an open question exists.
   - The plan's own exclusion (lines 2082–2083) is now enforced by construction and by the guard, and the question
     rows stay reachable in the running path (they live beside the approvals instead of behind a chip).

2. **Finding 2 (medium) — Enter on the focused Cancel button confirmed a non-danger dialog.**
   Root cause confirmed: `confirm-dialog.component.ts`'s section-level keydown handler called `resolve(true)` for every
   non-danger Enter without checking which control was focused, breaking button semantics. Fix: Enter now follows the
   focused button's meaning — Cancel cancels (danger and non-danger alike); Enter on the confirm button or on the
   dialog body confirms only non-danger boxes, and never confirms a danger box (step 7's "Enter does not confirm"
   stands). Escape is unchanged. Regression tests: Enter on focused Cancel cancels both dialog kinds; the old danger
   case is retargeted to Enter on the action button (its previous Enter-on-cancel probe was exactly the bug).

3. **Finding 3 (medium) — table-row picks were enabled in hosts with no "Add to reply" destination.**
   Root cause confirmed: `areTablePicksDisabled` checked only message kind/streaming state, so chat, side-chat and
   split-compare transcripts showed pick controls whose `appendToComposer` output nobody bound; pressing "Add to
   reply" cleared the selection and filled nothing. Fix: new `tablePicksToComposer = input(false)` on
   `OutputStreamComponent`, folded into `areTablePicksDisabled`; only `instance-detail.component.html`'s two mounts set
   it (`true` alongside the `(appendToComposer)` binding whose `appendTextToComposer` merge is the working
   destination). Other hosts now hide the pick column and bar via the existing `md-row-picking-disabled` CSS. A unit
   test pins the gate both ways.

4. **Finding 4 (medium) — keyboard Undo fell back through older action kinds.**
   Root cause confirmed: `undoLast()` sorted all remaining per-kind entries on every call — the Undo stack Decision 4
   rejects ("Single-slot Ctrl/Cmd+Z only reaches the newest action; older toasts keep their own buttons until they
   expire", step 10 risk line). Fix: `UndoService` keeps one `newest` slot — exactly the newest registered action.
   `undoLast()` reaches only that action and consumes the slot; an expired/replaced slot is a no-op; older live notices
   keep their own toast buttons; any new registration re-arms the slot. The shipped spec's stack assertion was synced
   to the specified single-slot rule (it pinned the defect the verifier flagged), and new cases pin: no fallback to
   older kinds on repeated `undoLast()`, the older notice's own button still works, and a fresh registration re-arms
   the keyboard target.

5. **Finding 5 (medium) — the compact-preview tip had no runtime path (`compactPreviewAvailable: false`).**
   Root cause confirmed: every production runtime hard-coded the flag and `tip-catalogue.ts` requires it, so the entry
   could never be chosen. The unfinished integration is now delivered:
   - The real control in this build is `app-context-warning`'s "Preview" / "Compact Now" actions
     (`onPreviewCompaction` → `app-compaction-preview-dialog`, which records `featureUsage.record('compact-preview')`
     and retires the tip). They render exactly while the context warning shows: a real occupancy-pressure reading on a
     provider that does not self-manage auto-compaction (`resolveContextWarningLevel` non-null), the warning not
     dismissed, and no compaction running.
   - `working-tip-runtime.ts`: new pure `isCompactionPreviewControlAvailable(level, dismissed, compacting)` documents
     that rule; `createWorkingTipRuntime` takes `readCompactPreviewControl` and sets `compactPreviewAvailable` from it;
     `InstanceDetailComponent` feeds live banner state (`contextWarningLevel()`, `contextWarningDismissed()`,
     `isCompacting()`). The runtime spec's pinned `false` is replaced by derivation and pass-through cases plus the
     pure rule's cases.
   - **Recorded choice:** the tip's original wording ("Compact now in the context ring") assumed a Phase 0 step-10
     ring control that does not exist in this build (the composer-toolbar context ring is display-only), and inventing
     ring UI belongs to Phase 3 C2's "Context details" design — so availability mirrors the real preview actions and
     the wording now names them ("Preview shows what compaction keeps; Compact Now shortens it.", 88 chars, within the
     catalogue guard's limits). The plan's `context use at least 60%` relevance floor is unchanged in
     `tip-catalogue.ts`; the availability gate is the additional integration rule ("enable the compact-preview tip only
     when its real control is available"), so the tip offers only in the control's visible window (≥75% per
     `resolveContextWarningLevel`) — conservative to the plan's floor. The livetest document's "compact-preview tip is
     deliberately inactive until its Phase 0 control exists" sentence is superseded by this round; no new live-only
     acceptance was created.

**Verification after the fixes (this worker, not an independent PASS):**
- Targeted tests: `src/renderer/app/features/instance-detail/` + `src/renderer/app/features/loop/` = 116 files /
  1,336 tests pass (includes the extended dock guard, the panel gate tests and the output-stream gate case); the
  tips/confirm/undo/table-pick/markdown set = 13 files / 137 tests pass; final re-runs after the last edits (panel
  spec family 11 files / 80 tests; dock guard + table-pick 27 tests) pass.
- `npx --no-install tsc --noEmit`, `npm run typecheck:spec` (canonical 8 GiB command), `npm run lint`,
  `npm run check:ts-max-loc`: all exit 0. `npm run build:renderer` (the Angular template gate for the instance-detail
  template and the two inline templates) and `npm run build:main`: exit 0.
- `check:ts-max-loc` initially flagged `output-stream.component.ts` one line over its ceiling+tolerance; the added doc
  comment was compressed (no ceiling or tolerance change, no logic change).
- No generators re-run: no IPC channels, contracts or alias surfaces changed. No package/lockfile, compiler config or
  test-suppression change. The full suite is deliberately not run (verifier's job).
- Remaining open, unchanged: independent re-verification (round 3), coordinator full-suite and fresh-eyes gates, and
  the rebuilt-app/provider/real-keyboard checks in
  [the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## As-built notes (23 October 2026, verifier round-1 remediation)

Independent verifier round 1 failed the delivered work with three findings. All three are fixed in the assigned
checkout (`.worktrees/queue/2026-10-10-oct-phase5-later-da028b`, branch `queue/2026-10-10-oct-phase5-later-da028b`,
new HEAD after the coordinator's round-1 checkpoint `a8a1a95be`). No commits, branch changes, or document renames were
made by this worker. No separate spec exists to update.

1. **Finding 1 (high) — relayed session reference became a cross-project read grant after hibernate/wake.**
   Root cause confirmed: `outputMessagesToContinuityEntries` omitted `metadata.crossSessionMessage`, so
   `restoreWokenOutputBuffer` (the real wake path) restored a relayed message as an unmarked user message and the
   reader's `@session` chip-grant scan treated the relayed reference as the user's own words. Fixes:
   - `session-continuity.types.ts`: `ConversationEntry.crossSessionMessage?: CrossSessionMessageMetadata` (mirrors the
     existing `internalInput` provenance field).
   - `continuity-message-projection.ts`: the field is projected in `outputMessageToContinuityEntry` and restored in
     `continuityEntryToOutputMessage`, so provenance survives every continuity round trip.
   - `cross-session-messaging-provenance.ts`: new `isCrossSessionMessageText` recognises the fixed relay wrapper for
     buffers persisted before provenance was carried; `session-transcript-reader.ts` uses it as a grant-scan fallback
     alongside the metadata checks (defence in depth; all relays go through `buildCrossSessionMessageText`).
   - Tests: projection round-trip case in `continuity-message-projection.spec.ts`; two reader regressions in
     `session-transcript-reader.spec.ts` (real `outputMessagesToContinuityEntries` → `restoreWokenOutputBuffer` round
     trip keeps the different-project read `not-allowed` with the provenance metadata intact; wrapper-text fallback).
   - The verifier's own reproducer (`provenance-probe.cjs` copied to `_scratch/phase5-fix-round2/`) now reports
     `{"before":"not-allowed","after":"not-allowed"}` with `restoredMetadata.crossSessionMessage` present and no `chip`
     audit reason — recorded in `provenance-probe-fixed.log`.

2. **Finding 2 (high) — step 16's status strip, typed registry, overflow behaviour and acceptance guard absent.**
   The handoff-to-Phase-3 disposition is superseded: the strip is now delivered in this branch's own running path (the
   verifier ruled it an outstanding integration requirement, not a live-only or coordinator-only check). New files in
   `src/renderer/app/features/instance-detail/`:
   - `session-status-dock.rules.ts`: typed `DockChipId`/`DockChipDef`/`DockChipContext`, the `DOCK_CHIPS` registry new
     chips register into (this branch's live chips: review, agents, checkpoints, outstanding — the Tasks chip stays
     removed per completed step 13b; ids are reserved for the plan's named future chips: goal, compact-first,
     near-limit, helpers), `DOCK_CHIP_VISIBLE_CAP = 5`, `splitDockChips` (five most urgent visible, non-blockers fold
     into "+N more", **blocker chips never fold**), and `resolveEscapeRouting`.
   - `session-status-dock.component.ts`/`.scss`: the actual strip above the message box — chip bar with overflow
     "+N more" list, on-demand panels (review/agents/checkpoints/outstanding), Esc closes a chip's panel and returns
     focus (`closeOpenChipPanel`), and it renders nothing when no chip has content. Approvals and question components
     are not in the strip.
   - `session-status-dock.rules.spec.ts`: the four pinned guard cases (no approval/question component inside the strip,
     chips beyond the cap fold into "+N more" and its list opens, Esc closes a chip's panel and returns focus, the
     strip renders nothing when no chip has content) plus registry/overflow/`resolveEscapeRouting` unit cases — 20
     tests green.
   - Wiring: `instance-detail.component.html` replaces its inline inspector toggles/panels with
     `<app-session-status-dock>` (approvals and `app-browser-approval-request` stay outside, above the strip);
     `instance-detail.component.ts` drops the relocated inspector state, routes Escape through `resolveEscapeRouting`
     (chip panel first, interrupt only for an in-flight turn) and delegates Cmd+Shift+V `openReviewPanel` to the dock;
     the moved inspector styles left `instance-detail.component.scss`. One strip exists in the running path; no second
     strip was invented. At the coordinator's Phase 3 + Phase 5 integration, C2b extras (status rows, second-opinion
     hosting, Tasks chip history) reconcile against this delivered strip as normal merge work.

3. **Finding 3 (medium) — activity view lost tool names after restoration.** `session-transcript-view.ts` now reads
   `metadata.toolName` (continuity's restored key) with `metadata.name` (live adapters) as fallback, including in the
   truncation cap. Regression in `session-transcript-view.spec.ts` pins the named-tool line
   (`Read: {"file_path":"/example.txt"}`) unchanged across a real continuity round trip.

**Verification after the fixes (this worker, not an independent PASS):**
- Targeted tests: 8 files / 264 tests (main session/continuity/wake/compaction paths) and 8 files / 86 tests (dock
  guard + instance-detail family + workboard/loop mounts) pass; plus the earlier 4-file / 39-test and 5-file / 241-test
  sets during the fix. Full logs: `_scratch/test-run.pid-*.log`.
- `npx --no-install tsc --noEmit`, `npm run typecheck:spec` (canonical 8 GiB command), `npm run lint`,
  `npm run check:ts-max-loc`: all exit 0. `npm run build:renderer` and `npm run build:main`: exit 0 (renderer build is
  the Angular template gate for the new strip).
- No generators re-run: no IPC channels, contracts or alias surfaces changed. No package/lockfile, compiler config or
  test-suppression change. The full suite is deliberately not run (verifier's job).
- `session-inspector-visibility.ts`'s `hasOptionalSessionInspectors` lost its instance-detail caller to the dock's
  describe-driven `chipViews` gate (strictly more general: registered chips can declare content beyond the four known
  kinds). Its extracted-predicate spec is untouched and green; retiring or relocating the helper is optional cleanup,
  deliberately left out of this fix's diff.
- Remaining open, unchanged: coordinator full-suite and fresh-eyes gates, the coordinator merge of the earlier staged
  merge-resolution work, and the rebuilt-app/provider/real-keyboard checks in
  [the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## As-built notes (23 October 2026, restored checkout)

- Assigned checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase5-later-da028b`;
  branch `queue/2026-10-10-oct-phase5-later-da028b`, HEAD `6c6a73f90f0bb4de246958cde1fc97cd90536cc4`.
  The three earlier implementation checkpoints are present. The initial worktree was clean. No separate linked spec exists.
- Current `main` is `1ee52cbd8c24d7bec80c161c03595e0d77d27f02`, 12 commits beyond this branch's merge base
  `06201b4b0c592b4b1d9cf8fcd7993bcdd28f1030`. The Phase 5 merge-base diff contains 218 paths, including 85 spec files.
  This worker made no source/test edits, commits, stashes, branch changes, manual merges or worktrees.
- The root source checkout and current `main` have Phase 0's `src/main/context/compaction-continuity.ts`; this branch
  still uses the old inline package in `compaction-runtime.ts`. Its recovery pointer remains wired and passes its
  end-to-end pre-compaction transcript test. This is branch-local evidence, not evidence of the new package's integration.
- Neither this checkout nor the root source checkout contains `session-status-dock.*` or the renderer's root needs-you
  store. Step 16's actual component/guard cannot run here. The handoff recorded on Phase 3's branch remains historical
  evidence only. Do not create a parallel strip, import a sibling worktree or self-authorise a carry-over waiver.
- Coordinator integration must (1) reconcile the moved base and Phase 0's named-block package, placing the recovery
  block after `identifier_index`, naming it in the reference-data sentence and placing the lookup sentence before the
  wait rule's last sentence; (2) integrate Phase 3's C2b and run the real four-case guard; (3) preserve step 13b's single
  task view and step 10's public snooze/clear/Undo delegates when C4 relocates state; (4) enable the compact-preview tip
  only when its real control is available. These are implementation/integration checks, not deferred live checks.
  *(Superseded in part: item (4) is delivered by the round-2 remediation — see
  [the round-2 notes](#as-built-notes-23-october-2026-verifier-round-2-remediation); item (2)'s guard now runs green in
  this branch after the round-1 remediation delivered the strip, leaving the C2b merge reconciliation as ordinary
  integration work.)*
- Fresh worker checks: all **85 added/modified spec files, 892 tests PASS**; `npx --no-install tsc --noEmit`,
  `npm run typecheck:spec` (canonical 8 GiB command), `npm run lint`, and `npm run check:ts-max-loc` all exit 0.
  Generator/IPC/export/contract checks also pass and leave generated tracked files unchanged.
- Rebuilt `build:main` (42.77 s), `build:renderer` (27.13 s), and `build:aio-mcp-cli` (0.68 s): all exit 0.
  Renderer retains the recorded initial-bundle warning (1.38 MB against the 1.00 MB warning budget); no build error.
  Production assets were compiled, not launched. Builds do not close any provider/live acceptance check.
- Full logs, structured test results, SHA-256 command receipts and the resumed-worker report/seal live in
  `_scratch/phase5-2026-10-23/` in the assigned worktree. This is a worker evidence seal, not an independent PASS.
  Full-suite and genuinely fresh independent completion-gate verification remain coordinator/verifier work.
- Runtime cleanup: after writing the report/seal/receipts, removed this run's `dist/` (main/preload/renderer/MCP output).
  No dependency install, database cluster, browser binary or copied source tree was created. Preserved the pre-existing
  dependency install and Vite caches. Final worktree status is clean, HEAD unchanged; both checkout and root-plan
  `git diff --check` pass. Cleanup details are in `cleanup.receipt.json`.
- Existing rebuilt-app/provider/real-keyboard checks remain open in
  [the live-test document](2026-10-10-oct-phase5-later_livetest.md). No browser, app session, paid provider request,
  production database or credentials were accessed in this resume. Parked steps 18–21 remain unbuilt in the existing
  follow-up plan; this resume does not wake them or change their conditions.
- Only this root plan is edited. It was already tracked and modified before the resume (` M`), so an untracked `??`
  claim would be false. Its pre-existing restoration/history notes are preserved. No plan copy is created in the worktree;
  the coordinator retains document closure/rename authority.

### Restored-checkout acceptance checklist (23 October)

| Step | Worker status in assigned checkout | Remaining acceptance |
|---|---|---|
| 1 A11 | Implemented; reader/RPC/search/chip/recovery specs pass | Relayed-provenance and tool-name round-trip defects fixed in the round-1 remediation; existing provider/live checks remain |
| 2 B13 wording/log | Implemented; focused specs pass | Independent final gate |
| 3 Hide scaffolding | Implemented; registry spec passes | Existing live check |
| 4 Search/finder | Implemented; controller and rail specs pass | Existing live check |
| 5 Quiet working | Implemented; activity-status spec passes | Existing live check |
| 6 MCP cost | Implemented; helper/card specs pass | Existing live check |
| 7 Shared confirm | Implemented; service/dialog/caller/zero-allowlist ratchet specs pass | Enter-on-Cancel button semantics fixed in the round-2 remediation; existing live keyboard/focus checks |
| 8 Council prefill | Implemented; context/menu/prefill/page specs pass | Existing live check |
| 9 Claude task tools | Implemented; settings/scoping/spawn specs pass | Actual provider TodoWrite/TaskCreate observation remains live |
| 10 Undo | Implemented; archive/unarchive/IPC/toast/Undo/composer/workboard specs pass | Keyboard Undo is the single newest-action slot (round-2 finding 4); Phase 3 C4 relocation/delegates at integration; existing live checks |
| 11 Names/cents | Implemented; formatter/diagnostics/browser/Local AI specs pass | Existing live check |
| 12 Child navigation | Implemented; component spec passes | Existing live check |
| 13 Small fixes | Implemented; header/task-window/panel/hint specs pass | Preserve Tasks removal when C2b integrates; existing live checks |
| 14 Project notes | Implemented; wording/Undo component spec passes | Existing live check |
| 15 Table reply | Implemented; markdown/delegated listener/composer specs pass | Row picks gated on a working composer destination (round-2 finding 3); existing live check |
| 16 Strip rules | **Implemented in this branch (round-1 remediation, round-2 extended):** `session-status-dock.*` on the running path; guard `session-status-dock.rules.spec.ts` green with every chip opened and the loop question surface pinned outside the strip | Coordinator reconciles Phase 3 C2b extras against the delivered strip at integration; existing live check |
| 17 Tips | Implemented; catalogue/policy/usage/runtime/component/settings specs pass | Compact-preview availability wired to the real preview control (round-2 finding 5); existing live check |
| 18–21 Parked | Disposition preserved; features unbuilt | Existing follow-up conditions and authority apply |
| Final gates | Focused worker checks pass | Full suite and fresh independent PASS after integration; plan remains active |

## Historical as-built notes (20 October 2026 retry, before restoration)

- Current supplied branch: `queue/2026-10-10-oct-phase5-later-da028b`, initial HEAD `542f1f690`, initial worktree clean.
- There is no separate linked Phase 5 spec. This plan and its recorded implementation/checkpoints are the authority.
- `git merge-base --is-ancestor 6c6a73f90 HEAD` exits 1; the recorded checkpoint contains the missing Phase 5 files.
  Its merge-base patch spans 218 files (5,483 insertions, 784 deletions). That checkpoint was inspected read-only.
- The root plan, livetest and parked follow-up are already tracked on the supplied base, despite their historical
  untracked-state notes. The root plan and livetest already had modifications when checked. This worker preserves
  those edits, updates only this root plan, and does not edit the pre-existing tracked plan copy in the worktree.
- Ruling: restoring a prior queue branch is coordinator lifecycle work under the current AIO-managed-worktree rule,
  not authority to run a manual merge or import another worktree. Rebuilding parallel versions of already recorded
  work would also leave the real Phase 3 dependency unresolved. Record the reproducible mismatch and keep acceptance
  open rather than treating historical test counts as current evidence.
- Current evidence and baseline command receipts live at
  `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase5-later-da028b/_scratch/phase5-2026-10-20/`.
  The report records each active step's actual status. This is a checkout/integration blocker, not a deferred live test.
- Fresh baseline verification (all exit 0): `npx --no-install tsc --noEmit` (54.6 s), `npm run typecheck:spec`
  (100.3 s, canonical 8 GiB script), `npm run lint` (28.2 s), `npm run check:ts-max-loc` (2.3 s), and the four-file
  targeted `test:quiet` run (65 tests, 26.8 s Vitest result; 27.4 s wrapper). Specs:
  `compaction-continuity.spec.ts`, `orchestrator-tools-mcp-forwarder.spec.ts`,
  `browser-page.approval-routing.spec.ts`, `app.component.spec.ts`. Full raw test output and structured results:
  `_scratch/test-run.pid-27667.log` and `_scratch/test-results.pid-27667.json` in the supplied worktree.
  These verify only the present baseline; they do not validate the missing Phase 5 implementation. No generators or
  builds were needed because no code/contracts changed. Individual command logs and SHA-256 receipts are retained.
- No production code or tests changed. No full suite, external action, database access, browser session, installation,
  commit, stash, branch operation or document rename was performed. The full-suite and independent PASS remain open.

### Historical acceptance checklist (20 October, before restoration)

| Step | Current supplied checkout | Remaining action |
|---|---|---|
| 1 A11 | Open: transcript reader and recovery-block module absent | Coordinator restore; reconcile with Phase 0's now-present named-block continuity package, then verify |
| 2 B13 wording/log | Open: old PLAN→IMPLEMENT wording remains; goal log absent | Coordinator restore and focused verification |
| 3 Hide scaffolding | Open: Training and Instance Messaging still visible registry entries | Coordinator restore and focused verification |
| 4 Search/finder | Open: old placeholder and Session picker title remain | Coordinator restore and focused verification |
| 5 Quiet working | Open: quiet-working fallback absent | Coordinator restore and focused verification |
| 6 MCP cost | Open: token-estimate helper absent | Coordinator restore and focused verification |
| 7 Shared confirm | Open: ConfirmService absent | Coordinator restore and focused verification |
| 8 Council prefill | Open: prefill service absent | Coordinator restore and focused verification |
| 9 Claude task tools | Open: task-tools registry absent | Coordinator restore and focused verification; provider observation remains live |
| 10 Undo | Open: UndoService absent | Coordinator restore and focused verification; reconcile Phase 3 root snooze delegates |
| 11 Names/cents | Open: shared money formatter absent | Coordinator restore and focused verification |
| 12 Child navigation | Open: child-session-nav component absent | Coordinator restore and focused verification |
| 13 Small fixes | Open: todo-window helper absent | Coordinator restore and focused verification; reconcile strip Tasks removal |
| 14 Project notes | Open: L0 Identity and Wing labels remain | Coordinator restore and focused verification |
| 15 Table reply | Open: table-pick helper absent | Coordinator restore and focused verification |
| 16 Strip rules | Open: strip component/guard absent here and in the recorded Phase 5 checkpoint | Coordinator integrate Phase 3 C2b and run its actual four-case guard |
| 17 Tips | Open: working-tip service absent | Coordinator restore and focused verification |
| 18–21 Parked | Disposition preserved in existing follow-up; no features built | Remain parked under their conditions and approval rule |
| Final verification | Current baseline checks recorded separately; not Phase 5 acceptance | Full suite and fresh independent completion-gate PASS after integration |

## Historical as-built notes (12–16 October 2026, prior checkout)

Checked active steps below mean their code and focused worker verification are complete in this checkout, except step 16 (see its line). Full-suite/coordinator verification and rebuilt-app observations remain separate. A parked checkbox means its required disposition was recorded, not that the feature was built. As of 16 Oct 2026 (verifier round 1): steps 1–15 and 17 are complete and verified in this branch; step 16 is delivered into Phase 3's C2b via handoff but is **not integrated in this branch**, so its acceptance guard cannot run here — it is open and owned by the coordinator's Phase 3 + Phase 5 integration. Round-1 findings 1–2 (test-sync) are fixed; finding 3 (step-16 integration) is recorded below as coordinator-owned and not worker-fixable in this branch. **Superseded 23 Oct 2026 (verifier round-1 remediation of the next round):** the independent verifier rejected that step-16 deferral and two step-1 defects; step 16 is now implemented in this branch (see its line and the [remediation notes](#as-built-notes-23-october-2026-verifier-round-1-remediation)).

- [x] Step 1 A11 (1a tool, 1b Compact-now pointer, 1c `@session` chip); 1b implemented 15 Oct — see the 15 Oct ledger for the integration point when Phase 0's named-block package lands
- [x] Step 2 B13 wording and the Codex goal log line
- [x] Step 3 C13.4
- [x] Step 4 C13.1
- [x] Step 5 C13.9
- [x] Step 6 C13.8
- [x] Step 7 C12B (batch 1, batch 2, batch 3; `provider-accounts-tab.component.ts` **was** migrated — its `remove` site uses `ConfirmService`; a 24th native confirm added on the base after the branch point, `provider-account-chip.component.ts`'s ownership acknowledgement, was caught by the zero-allowlist ratchet and migrated on 15 Oct)
- [x] Step 8 C13.2
- [x] Step 9 C13.7 code/focused checks; actual `TodoWrite` versus `TaskCreate` remains a deferred provider check
- [x] Step 10 C12A (Done-when met; the snooze-state relocation into Phase 3's root needs-you store is Phase 3 step 6c's specified work, already cross-referenced there with `clearSnoozes()` and the `WorkboardStore` delegates — the Undo/count code calls those public methods and moves unchanged)
- [x] Step 11 C13.3
- [x] Step 12 C13.5
- [x] Step 13 C13.6 (13a, 13b, 13c)
- [x] Step 14 C13.10
- [x] Step 15 C13.11
- [x] Step 16 C13.12: **IMPLEMENTED IN THIS BRANCH (23 Oct, verifier round-1 remediation).** The earlier
  handoff-to-Phase-3 disposition was rejected by the independent verifier (round 1, finding 2): the guard had to run
  green against this branch's delivered running path, not against Phase 3's branch. `session-status-dock.rules.ts`
  (typed `DOCK_CHIPS` registry, `DOCK_CHIP_VISIBLE_CAP = 5`, `splitDockChips` with blocker chips never folding,
  `resolveEscapeRouting`), `session-status-dock.component.ts`/`.scss` (the strip above the message box, "+N more"
  overflow, Esc closes a chip's panel and returns focus, renders nothing when empty, no approvals/questions inside) and
  the four-case guard `session-status-dock.rules.spec.ts` (20 tests green) are delivered and wired into
  `instance-detail` in place of the old inline inspector toggles; the Tasks chip stays removed per step 13b. The
  coordinator still reconciles Phase 3's C2b extras (status rows, second-opinion hosting) against this strip at the
  Phase 3 + Phase 5 integration; that is ordinary merge work, not step-16 acceptance. See the
  [round-1 remediation notes](#as-built-notes-23-october-2026-verifier-round-1-remediation).
- [x] Step 17 D11
- [x] Step 18 B12: handled as parked, unbuilt; moved unchanged to `2026-10-12-oct-phase5-parked-followups_plan.md`
- [x] Step 19 B13: handled as parked, unbuilt; moved unchanged to the follow-up; loop-use threshold passes, A4 is absent
- [x] Step 20 B11a: handled as parked, unbuilt; moved unchanged to the follow-up; no OpenCode loop usage, so paid live probe not started
- [x] Step 21 A3.OC: handled as parked, unbuilt; moved unchanged to the follow-up; installed signal/prerequisites and OpenCode loop usage absent
- [x] Final gates: worker-level targeted tests and every fast static/build/generator check are green (round-1 fixes re-verified 16 Oct: forwarder 33 pass; browser suite 148 pass; MCP 655 pass; round-2 `app.component.spec.ts` 15 pass + action-dispatch/undo/provider-state 11 pass; `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint` all exit 0 — `_scratch/r17-*`, `_scratch/r18-*.log`; 23 Oct remediation re-ran the affected sets green — 264 + 86 tests, both typechecks, lint, LOC, main/renderer builds). `npm run test:quiet` (the full suite) is explicitly assigned to the coordinator verifier and remains open here. The step-16 guard now runs green in this branch (`session-status-dock.rules.spec.ts`); only the coordinator's Phase 3 C2b merge reconciliation remains. *(Round-3 remediation, 23 Oct, merged tree `8940eb287`: 835 targeted tests across the touched families plus the two named settings specs, both typechecks, lint, LOC, ui-hints, check:dead, main/renderer builds and every generator/contract check all exit 0 — `_scratch/phase5-round3/`.)*
- [ ] Fresh-eyes gate PASS — owned by the coordinator's separate verifier, who runs `task-completion-gate` (its Gate 0 reproduces the full suite, assigned to that verifier by the current queue brief); this worker did not run it. See the [round-3 remediation notes](#as-built-notes-23-october-2026-verifier-round-3-remediation).
- [x] Livetest doc created

## Queue implementation ledger (12 October 2026)

- Worktree: `.worktrees/queue/2026-10-10-oct-phase5-later-e9f577`; initial `git status --short` clean. Root plan remains untracked. No branch operations or commits permitted.
- No separate Phase 5 spec is linked. The approved backlog is root-only/untracked; this plan is the implementation authority.
- Preflight: `compaction-continuity-package.ts`, `session-status-dock.*`, Phase 0 automatic-review scope helper, and Phase 3 root needs-you store are absent in this checkout. Step 1b and step 16 require those exact prior-phase modules. Keep dependent requirements open; do not silently rebuild earlier phases or certify their absence as completion.
- Ruling: worker runs targeted tests and static/build checks; the queue verifier owns the full suite and final independent completion gate. Coordinator owns document rename and commits. These explicit queue instructions override generic finishing steps.

### As-built implementation and integration decisions

1. **Step 1: complete (1b added 15 Oct).** `read_session` is wired into tool search, deferred discovery/forwarding and authenticated RPC caller identity; the reader is initialised after cross-session messaging. Live/history projection uses the extracted full-message merge. Source filtering, paging/cursors, item/page caps, redaction before clipping, caller character budgets, title ambiguity, real-user chip grants and audit rows are implemented. Tool/RPC/projection/reader tests pass, including switch revocation during load and archived-parent identity. `@session:` offers live and past sessions, current-project first; rapid typing now waits for the shared history load and rejects stale results. **1b (15 Oct):** the `<context_recovery>` block and the final-rule look-up sentence are built by the new pure module `src/main/context/context-recovery-block.ts` and wired into the current inline continuity package in `compaction-runtime.ts` at the plan's position (block after the recent turns, sentence before the package's closing rule). The bridge predicate `isOrchestratorToolsBridgeAvailable(provider, lookups)` lives beside `buildOrchestratorToolsMcpConfig` and checks the injection-capable provider test, the `aio-mcp` binary and the RPC socket, with both lookups passed in as arguments (no capability minting); the caller also refuses remote placements. The count is the reader's own default-view `totalItems` of the merged transcript at package-build time (no count in the current package's shape would otherwise be truthful; Phase 0's `ContinuityStats` supplies it once its package lands). Phase 0 step 10's named-block package (`compaction-continuity.ts` on that phase's queue branch; the planned `compaction-continuity-package.ts` name) is still not on this base — when it lands, `buildContinuityPackage` calls `buildContextRecoveryBlock` unchanged after its `<identifier_index>` block, inserts `CONTEXT_RECOVERY_LOOKUP_SENTENCE` before the wait rule's last sentence, and lists `<context_recovery>` in the one-line "these blocks are reference data" sentence. The old inline package here has no such sentence, so none was invented. Its live check moved into the livetest document as implemented code.
2. **Step 2:** neutral fresh-context round wording; Codex goal-change logs contain status only, including `unknown` for malformed/unrecognised statuses. Focused invoker/provider regression tests cover reset wording, foreign thread and malformed goal events.
3. **Steps 3–4:** Training, Instance Messaging and the old chat-search menu entry are hidden through the registry without deleting routes. Search wording names names/prompts/folders. Find session matches bounded first/last prompt snippets and the rail action opens that same picker; focused registry/controller/rail tests pass.
4. **Step 5:** event-age fallback says Working quietly after ten seconds and keeps elapsed time/hover; existing detailed activity wins. Component tests exercise this transition.
5. **Step 6:** connected MCP cards show tool count and bounded rough schema-token cost; disconnected cards ask to connect. Central hover copy explains Claude's deferred tool loading. Helper and actual component tests pass.
6. **Step 7:** all 23 native-confirm sites, including provider accounts, migrated to the root queued Harness dialog; zero-entry native-confirm ratchet passes. Destructive dialogs start on Cancel, block Enter, trap Tab, consume Escape and restore focus. Overlapping ecosystem requests do not share an affirmative result; remote uninstall captures its target before awaiting confirmation. Existing terminate/Close-all ownership was preserved; absent Phase 0 additions were not rebuilt here.
7. **Step 8:** Council prefill is one-shot, editable and never sends automatically. Reply question matching handles older/history slices; payload closing tags are escaped with existing helpers and budgets are bounded. Phase 0's Get a second opinion item is absent, so the new item follows the existing Copy/Fork entries; no competing second-opinion implementation was added.
8. **Step 9:** all five settings surfaces include `claudeShowTaskList`, default false. One shared main-chat classifier was established because Phase 0's helper is absent; Phase 0 must reuse it rather than create a second scope rule. A bounded registry follows resolved provider/location at spawn and respawn, cleans up on rollback/removal, and enables the environment flag only for eligible local Claude chats. Warm-start/worker shortcuts are bypassed when the flag must be injected. The actual returned CLI tool (`TodoWrite` versus `TaskCreate`) is **not known from source/tests** and remains a rebuilt-provider check in the livetest document.
9. **Step 10: complete against its Done-when.** Keyed/action toasts and `UndoService` provide five seconds, hover/focus pause, one entry per kind, stale-action protection, atomic consumption and failed-restore feedback. Root dispatch/palette and Ctrl/Cmd+Z avoid text fields. Archive/unarchive contract, generated channel, validated handler, preload, renderer store and rail helpers are wired. Project Undo restores only newly archived thread IDs plus folder/pin. New-session discard snapshots text/folders/files/agent and restores without overwriting newer text. Queued-message cancellation and table append merge with existing text and distinct hidden edit/recall drafts. Workboard Snooze Undo, count and Show-all work in today's store. **Phase 3 C4 root `NeedsYouStore` handoff (15 Oct disposition):** the plan's sentence "After Phase 3's C4 these live with the snooze state in the root needs-you store" is explicitly future-conditional and is Phase 3 step 6c's own specified work — that step's text already says to move `snoozedSignal`/`snoozeItem`/`unsnoozeItem`/`isSnoozed` (and Phase 5's `clearSnoozes()`) into the root store and keep `snoozeItem`/`unsnoozeItem` as `WorkboardStore` delegates. The Phase 5 Undo and "N snoozed - Show" code calls exactly those public methods today, so it moves unchanged when C4 relocates the state; nothing parallel was invented here. Composer recovery-discard Undo was optional and was not added. No changes to termination confirmations.
10. **Step 11:** request IDs and raw provider stop values fold into Details/Copy; only abnormal stops warn. Money uses cents/plain amounts, with exact values in Details. Browser grants show site and unattended/user-approved wording while raw IDs/tool/selector remain in Details. Existing money/pricing/IPC shapes remain unchanged. Focused component, formatting and browser-label tests pass.
11. **Step 12:** child navigation derives siblings from live `parentId`, sorted by creation, with Parent/Previous/Next and disabled end/missing-parent states; component tests pass. No header rewrite.
12. **Step 13:** one primary New session plus keyboard-accessible Quick chat menu; Quick chat explicitly uses Scratch. Task window keeps the active/pending task visible and expands a scrollable full list; duplicate Tasks inspector/state removed. **Integration decision:** move the one existing Progress-panel mount into InstanceDetail so Workboard-embedded conversations also retain task visibility; do not rely on Dashboard-only mounting. Obsolete auto-expand tests replaced with task-window and real DOM visibility/expansion assertions. One state-derived composer hint preserves quota mount and avoids provider-specific compaction wording. The Phase 3 strip is absent, so no nonexistent strip chip was modified.
13. **Step 14:** Project notes wording, central hover help, created/source metadata, Last shown and Shown N times. Remove Undo re-adds through the unchanged API as a new user-added note. Known generated L1 heading prefix is stripped only for display, never rewritten in persistence. Focused tests pass.
14. **Step 15:** numbered tables get accessible row selection and bounded plain-text append into the existing composer. No automatic send. Attribute payloads use JSON/unicode escaping to survive existing DOMPurify SAFE_FOR_XML; sanitisation was not relaxed. Completed-assistant-only guard covers final ACP data and settled local/Copilot metadata; streaming/user/unknown states are excluded. The fresh-review nested reasoning/system finding was fixed: controls default disabled, only completed assistant hosts opt in, and reasoning/system ancestors always deny. Actual renderer/delegated-listener regressions pass.
15. **Step 16: unimplemented dependency (handoff delivered 15 Oct).** `session-status-dock.*` is absent. Required handoff to Phase 3 C2b: typed `DOCK_CHIPS`; show the five most urgent chips and `+N more`; approvals/questions always outside; Escape closes panel and returns focus; render nothing when empty. The guard spec must exercise the actual C2b component after integration. This plan expressly forbids a second strip; none was built. The handoff text is now recorded in Phase 3's plan, step 5 (C2b), so the C2b implementer receives the rules in their own document.
16. **Step 17:** versioned feature-use lifetime storage, successful action recording, conservative composer/modal/queue eligibility, thirty-second start, ten-minute gap, two-per-launch and three-per-feature cap; one busy-period impression counted only after render. Keyboard shortcut text uses current bindings; typing hides it, Got it retires it, Tab can reach Got it. Missing composer suppresses tips. `showWorkingTips` default true is in all settings surfaces. **Compact-preview catalogue entry is dormant** until Phase 0 exposes the referenced control; source tests pin this exclusion. *(Superseded 23 Oct 2026, verifier round-2 remediation: the entry is live and its availability is derived from the real compaction-preview control; see [the round-2 notes](#as-built-notes-23-october-2026-verifier-round-2-remediation).)*
17. **Parked Steps 18–21:** moved verbatim to [2026-10-12-oct-phase5-parked-followups_plan.md](2026-10-12-oct-phase5-parked-followups_plan.md), still untracked and unbuilt. Read-only evidence: seven recent loop runs meet Step 19's usage threshold, but A4 is absent; zero OpenCode loops fail Steps 20/21 thresholds; the installed OpenCode does not have the compaction signal. Structured Codex goal-tool activity was not found in the available corpus; the short rotating app-log window is not presented as thirty-day absence evidence.

The root implementation plan, live-test document and parked follow-up are all untracked (`??`). No separate spec exists. The coordinator owns renaming, committing and lifecycle integration. This worker does not claim the complete plan ready to close while the three predecessor-dependent requirements remain open.

### Worker verification evidence (12 October 2026, final corrected source)

- `npx tsc --noEmit`: exit 0, `_scratch/phase5-main-final.log`.
- `npm run typecheck:spec`: exit 0, `_scratch/phase5-spec-final.log`; canonical 8 GiB heap command used.
- `npm run lint`: exit 0, `_scratch/phase5-lint-final.log`. Focused main-process ESLint was also run by implementing agents; no diagnostics were suppressed.
- `npm run check:ts-max-loc`: exit 0, `_scratch/phase5-loc-final.log`; no ceilings/tolerances changed.
- `npm run build:main`: exit 0, `_scratch/phase5-build-main-final.log`; Electron compilation, asset sync and preload bundle ran.
- `npm run build:renderer`: exit 0, `_scratch/phase5-build-renderer-final.log`; Angular AOT bundle generated in 10.077 s on the final rerun.
- `npm run build:aio-mcp-cli`: exit 0, `_scratch/phase5-build-mcp-final.log`; bundled deferred session reader discovery/forwarding.
- `generate:ipc` and `generate:aliases`: exit 0, `_scratch/phase5-generate-ipc-final.log` and `_scratch/phase5-generate-aliases-final.log`; 1,187 IPC channels and 59 exact/3 prefix aliases. Alias output unchanged; unarchive generated channel current.
- `verify:ipc`, `verify:ipc-usage`, `verify:exports`, `check:contracts`: exit 0, corresponding `_scratch/phase5-*-final.log`; 1,187-channel sync, 5,717-file export scan, 38 schema subpaths. IPC usage remains the existing warn-level inventory; zero exit does not claim strict coverage.
- Latest focused main/IPC regression gate: 9 files / 128 tests PASS, `_scratch/test-run.pid-35825.log`. It covers archive/unarchive, real index-queue retry, complete history manager, archive integrity, transcript cap/cursor/reader scope, MCP/RPC and validated IPC plus renderer unarchive state. Earlier focused domains and independent reruns are recorded by the agents and reviewer, with retained `_scratch/test-run.*.log`; counts overlap and are not summed.
- Final Step 15 nested-boundary and composer regressions: 4 files / 76 tests PASS, `_scratch/test-run.pid-29830.log`; independent rerun `_scratch/test-run.phase5-fresh-review-table-final.log` PASS.
- Rapid-history-load plus actual history/recovery/resume regressions: 7 files / 56 tests PASS, `_scratch/test-run.pid-23422.log`.
- Quick-chat menu focus/Escape regression: 2 files / 6 tests PASS, `_scratch/test-run.pid-16639.log`.
- `git diff --check`: exit 0. No package/lockfile, compiler config or Vitest configuration changed. No commits, stashes, branch switches or worktrees created. Nothing staged.
- **Full suite intentionally not run:** explicit Plan Queue worker instruction assigns it to the independent coordinator verifier. Final gates checkbox remains open.

### Fresh review and corrected defects

First genuinely fresh `task-completion-gate` context reviewed tracked and untracked changes from base `4d175e55`; its full-plan **VERDICT: FAIL** is correct because Steps 1b, 10 root-store handoff and 16 are incomplete. Implemented subset received provisional PASS, with no remaining actionable finding. Independently exercised domains include 34 files/352 tests; 12 files/227 tests; 4 files/22 tests; 4 files/76 tests; 7 files/121 tests; stable final 8 files/50 tests, all exit 0. Logs `_scratch/test-run.phase5-fresh-review-*.log` overlap; they are not a full-suite substitute.

Six concrete findings were reproduced, fixed and independently rechecked: archived-parent original identity; Quick-chat keyboard focus/Escape; autocomplete history-load race; reasoning/system table selection boundary; failed/missing unarchive false success; oversized tool-name item cap/cursor loss. Unarchive now types the real conversation result, refuses missing/corrupt conversations, serializes per entry, changes index only after conversation success, compensates conversation/index on index-save failure, preserves the original error and retains unrelated latest timestamps. The real HistoryManager index ordering tail releases even when its own caller fails, allowing explicit retry instead of poisoning later writes. Regression tests cover the real method and compensation failure.

A second genuinely fresh review confirmed a High redaction defect inherited from the shared helper and affecting the new reader. That snapshot received FAIL. The defect and a further archive persistence issue were then fixed; a third genuinely fresh post-remediation review and the escalated `repo-health-audit` are checking the current stable source. The gate skill requires escalation for session-handling changes and multiple Medium findings. Do not check Fresh-eyes PASS or close this plan while whole acceptance remains incomplete. The coordinator must integrate the missing predecessor code, rerun the affected focused/static/build checks, run the full suite, and obtain a fresh whole-plan PASS before renaming.

### Security and persistence remediation found by the escalation

- **Redaction boundary:** the audit and second fresh reviewer reproduced partial disclosure through the actual new transcript projector when registered exact values overlapped. The existing shared `redactSecrets` applied overlapping original offsets after changing the string. Reuse the already-correct range-union helper from `content-egress-gate` by exporting it once from `secret-detector`; both egress paths now use that same helper. Existing egress markers/audit and detection patterns are unchanged. Indexed `matchAll` also fixes repeated connection/JWT/private-key occurrences that previously reused the first `indexOf` position. Exact matching advances one character so overlapping occurrences of the same value are all unioned. Tests use obvious placeholders only. Final detector/egress/scanner/actual reader/MCP focused gate: 6 files/65 tests PASS, `_scratch/test-run.pid-54914.log`. Original failing regressions retained in `_scratch/test-run.pid-50509.log`, `pid-51762.log` and `pid-54117.log`.
- **Archive failure truthfulness:** the same baseline mutate-before-persist defect remained on archive even after unarchive was fixed. This directly undermined the new Undo caller. The shared archive/unarchive transaction now delays index mutation until the conversation write succeeds, compensates both persistence surfaces after index-write failure and preserves the original error. Legacy index-only archive of a missing/orphan transcript remains allowed; restoring it correctly reports unavailable. Latest archive/history/index retry/IPC/store/rail gate: 7 files/107 tests PASS, `_scratch/test-run.pid-59134.log`; original two failure cases reproduced in `_scratch/test-run.pid-58046.log`.
- These are required corrections to load-bearing dependencies of Steps 1a and 10, not unrelated cleanup. No dependency/lockfile, validation scope or test harness was loosened.
- Post-remediation typechecks, renderer lint, main/shared/preload lint and LOC pass again. Final main/renderer/MCP builds all pass against this corrected source. The third fresh review found no unresolved actionable code defect and retains whole-plan FAIL for the documented acceptance gaps. The full suite remains assigned to the coordinator.

### Final independent review and escalated audit disposition

- **Third genuinely fresh post-security review:** implemented-code finding clearance; no unresolved actionable findings. Four independent focused runs (29 files / 317 tests across the runs) pass; 1,045 additional in-memory adversarial redaction checks pass. Logs `_scratch/test-run.pid-57614.log`, `pid-60138.log`, `pid-60760.log`, `pid-61236.log`; run counts are not a full-suite substitute. The reviewer checked RPC capability/resource scope, reader/paging/audit/redaction, archive/unarchive compensation and queue release, Undo/confirm/tips, table/composer boundaries and task-tool scoping. **Whole-plan VERDICT: FAIL** remains correct for Steps 1b, 10 root-store handoff and 16, plus the coordinator-owned full-suite and pending rebuilt/provider observations. Do not close this plan from implemented-subset clearance.
- **Escalated repo-health-audit:** all rubric passes 0–6 performed with a risk-prioritised whole-repository inventory (5,718 TypeScript files; 3,315 production files), broad scans and selected execution-path review. This is not certification of every repository path. Import-boundary/dead-export checks pass. Independent runtime 6 files/78 tests, post-fix security/projector 3 files/30 tests and post-fix history/IPC 4 files/54 tests pass. All 86 directly locked packages exist on the official npm registry; maintenance status was not comprehensively proved. No remaining introduced auth/resource defect, test tampering or weakened sanitisation was established. Audit logs and actual exit statuses: `_scratch/phase5-local_scan-*`.
- **Baseline remediation queue, outside this Phase 5 implementation:** (1) High: the build dependency audit exits 1 with two critical advisory entries through unchanged `concurrently@9.2.4` -> `shell-quote@1.9.0` ([GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)); fix in a separate dependency task. (2) Reviewed production dependency risk: five high entries through extract-zip/Puppeteer and one low DOMPurify entry; production audit gate passes with existing documented exceptions and inspected caller compensations. This is not blanket immunity. (3) Existing architecture cycles: the diagnostic exits 1, but independent HEAD/current comparison reports the same 35 strongly connected components / 270 cyclic files, with no added/expanded component. These baseline diagnostic failures were not hidden as passing Phase 5 checks.
- **Performance follow-up, not a reproduced acceptance failure:** the reader currently projects/redacts the complete merged transcript before selecting a page, as this plan specifies. Audit's 10,000-message / 85.5-million-character placeholder probe returned a bounded 4,000-character result in about 129 ms. Consider page-first projection during later large-session optimisation; do not claim the current page cap bounds all input work.
- All final worker typechecks, renderer/main lint, LOC, main/renderer/MCP builds, generators, IPC/exports/contracts checks and focused tests are green. No full suite run, no live UI/provider validation, no commits/stashes, no branches/worktrees created/switched, no active document rename. Final branch remains `queue/2026-10-10-oct-phase5-later-e9f577`, HEAD `4d175e55b`, with nothing staged. No Phase 5 plan/spec copy exists in the worktree.
- Final dependency check also found the three predecessor modules absent in the **root source checkout**, as well as this queue worktree. The coordinator must land the owning phases before finishing these requirements; importing another AIO worktree or inventing parallel state/strips is not an integration substitute.

**Worker handoff:** 14 of 17 active steps code-complete (2–9, 11–15, 17), Step 1 partial (1a/1c done; 1b open), Step 10 partial (root Snooze handoff open), Step 16 blocked on the owning status strip. Parked 18–21 dispositions complete, features unbuilt. Implementation plan, live-test document and parked follow-up remain untracked in the root checkout. Safe implemented work is reviewable; whole plan is **not complete** and must not be renamed or certified until the open code requirements and coordinator gates pass.

> Plan Queue parked work: `queue/2026-10-10-oct-phase5-later-e9f577` — 1 commit(s), reason: worker-error.

## Queue implementation ledger (15 October 2026, continuation)

- Worktree: `.worktrees/queue/2026-10-10-oct-phase5-later-3e8047` (branch `queue/2026-10-10-oct-phase5-later-3e8047`, cut from `main` at `06201b4b0`). Initial `git status --short` clean. Root plan/livetest remain untracked. No commits, stashes, branch switches or new branches/worktrees created.
- **Port (per the coordinator handover).** `git merge --squash queue/2026-10-10-oct-phase5-later-e9f577` (three-way base `4d175e55b`) brought the complete prior implementation in (208 files). The handover's second option (`git diff $(git merge-base HEAD main) … | git apply`) was **not** used: `HEAD == main`, so that expression would have diffed against `HEAD` and wiped newer base work. Three content conflicts, all additive on both sides, resolved by union or regeneration:
  - `src/main/providers/provider-runtime-service.spawn-worker.spec.ts`: union of both import sets (base's `ProviderRuntimeAdapterCreator`/`UnifiedSpawnOptions`/`CliAdapterWorkerProxy` plus the branch's `ClaudeCliAdapter`);
  - `src/preload/generated/channels.ts`: generated file — took the base side, then `npm run generate:ipc` rebuilt it from the merged channel sources (1,198 channels);
  - `src/renderer/app/shared/tooltip/tooltip-copy.ts`: union of both entry blocks (merge, not overwrite).
  One compile fix on the port: `table-pick.ts` spread a `NodeListOf`, which needs `dom.iterable` (this repo's `tsconfig.json` lib is `["ES2022", "dom"]`); changed to `Array.from(...)` — no compiler config change. `npm run generate:aliases` also re-run (61 exact / 3 prefix aliases).
- **Step 7 ratchet caught a 24th native confirm on the base:** `provider-account-chip.component.ts` `turnOnForSelection` used `globalThis.confirm` for the pooled-account ownership acknowledgement (added on `main` after `4d175e55b` by "october improvements" `c89b50c9c`; the branch's migration predates it). Migrated to the Harness `ConfirmService` dialog with `confirmLabel: 'Confirm and turn on'`, `danger: true` (Enter does not confirm accidentally). The chip component spec's stale `vi.stubGlobal('confirm')` case now spies on `ConfirmService` and asserts the ownership message plus `danger: true`; `confirm-callers.spec.ts` gained a real-service gating case (cancel leaves the account off and records nothing; confirm acknowledges ownership then enables). `no-native-confirm` ratchet green (empty allowlist). This is exactly the class of regression the ratchet exists for; a future lint rule (Phase 4 D10) still closes it at source.
- **Step 1b implemented (new code):**
  - `src/main/context/context-recovery-block.ts` (pure): `buildContextRecoveryBlock(messageCount?)` emits the plan's `<context_recovery>` text with the package's `</` escape; `CONTEXT_RECOVERY_LOOKUP_SENTENCE` is the final-rule instruction, kept out of the block. No count (or 0) falls back to the generic first line.
  - `src/main/mcp/orchestrator-tools-mcp-config.ts`: `isOrchestratorToolsBridgeAvailable(provider, lookups)` beside `buildOrchestratorToolsMcpConfig` — injection-capable provider test (`isOrchestratorRuntimeInjectionProvider`; `gemini`, `antigravity`, `auto`, `undefined` all answer false), `aio-mcp` binary resolves and exists, RPC socket present. Both lookups are injected arguments (no import of the large RPC server into the config module); no capability minting (side-effect unproven).
  - `src/main/app/compaction-runtime.ts`: `buildContextRecoveryPointer(instance)` refuses remote placements (`executionLocation?.type === 'remote'`), consults the predicate with `instance.provider` (rewritten to the resolved CLI at spawn, `instance-lifecycle.ts` `resolvedCliType`), counts the reader's own default-view `totalItems` over `getCompleteInstanceMessages(instance)`, and returns `{ block, sentence }` or `null` (a failed transcript read logs a warning and never aborts the compaction). The continuity package carries the block after "Recent turns" and the sentence immediately before its closing rule ("before the rule's last sentence" per the plan; the current inline package has a one-sentence closing rule and no Phase 0 wait rule).
  - Placement note for Phase 0's landing: `buildContinuityPackage` (Phase 0's `compaction-continuity.ts`, present only on that phase's queue branch) calls `buildContextRecoveryBlock` unchanged after `<identifier_index>`, inserts `CONTEXT_RECOVERY_LOOKUP_SENTENCE` before the wait rule's last sentence ("Your tools stay fully available for the next request."), and lists `<context_recovery>` in its one-line "these blocks are reference data" sentence. The old inline package here has no such sentence, so none was invented; the block's own fixed text carries no user content.
  - Count source decision: Phase 0's `ContinuityStats` (the plan's stated source) does not exist on this base and its fields carry no "messages before this reset" count anyway. The count is the reader's default view (`view: 'messages'`) `totalItems` of the merged transcript at package-build time, so the block's number matches exactly what `read_session` can page through; for the test fixture of two user/assistant messages the package reads "The 2 messages before this reset are still in this session."
- **Step 1b tests:** `context-recovery-block.spec.ts` (count line, exact call string, instruction stays out of the block, generic fallback, escape/placement shape); `orchestrator-tools-mcp-config.spec.ts` (true for claude/codex/opencode with binary+socket; false for gemini/antigravity/undefined/auto, missing binary, existing-path failure, missing socket); `compaction-runtime.spec.ts` ("context recovery pointer in the restart package (A11 part 1b)"): block+count+sentence present with the bridge up and correct placement (after Recent turns, both before the closing rule); absent when the bridge is off (binary or socket missing); absent for gemini and antigravity; absent for remote placements with the bridge up; and an end-to-end case — restart compaction with a fake `restartFreshInstance` that appends the real `session-boundary` marker, then `read_session` `self` `before-last-compaction` through the reader with fakes returns the last pre-compaction user message, hides the boundary itself, reports one compaction, and writes one audit row.
- **Step 10 disposition:** Done-when met in this checkout (see decision item 9). The C4 relocation is Phase 3 step 6c's work, already specified there including Phase 5's `clearSnoozes()` and the delegate shape.
- **Step 16 disposition:** the two rules were handed to the C2b implementer in Phase 3's plan step 5 (15 Oct note: five most urgent chips + "+N more"; typed `DOCK_CHIPS`; Esc closes a chip's panel and returns focus; the guard spec's four cases). Unbuilt here: `session-status-dock.*` does not exist and a second strip is forbidden. `session-status-dock.rules.spec.ts` is written against the real component when C2b lands.
- **Worker verification evidence (15 Oct 2026):**
  - `npx tsc --noEmit`: exit 0 (`_scratch/port-tsc.log`, `_scratch/step1b-tsc.log`).
  - `npm run typecheck:spec` (canonical 8 GiB command): exit 0 (`_scratch/gate-tsc-spec.log`).
  - `npm run lint`: exit 0 (`_scratch/gate-lint.log`).
  - `npm run check:ts-max-loc`: exit 0 before and after staging the new files (`_scratch/gate-loc.log`, `_scratch/gate-loc2.log`); no ceilings or tolerances changed.
  - `npm run build:main`, `npm run build:aio-mcp-cli`, `npm run build:renderer`: exit 0 (`_scratch/gate-build-*.log`); the renderer build reports the pre-existing initial-bundle budget warning and exits 0.
  - `npm run generate:ipc` (1,198 channels) and `npm run generate:aliases`: exit 0; `npm run verify:ipc`, `npm run verify:ipc-usage`, `npm run verify:exports` (5,969 files), `npm run check:contracts` (39 schema subpaths): exit 0 (`_scratch/gate-verify-*.log`, `_scratch/gate-check-contracts.log`).
  - Focused tests (all green): every new and modified spec of the ported work (45 new files; 34 modified), the confirm suite including the 24th-site migration, the settings completeness specs (`claude-task-list-settings`, `working-tips-settings`), and a neighbourhood sweep `src/main/app src/main/context src/main/mcp/__tests__ src/main/history` = 121 files / 2,772 tests (`_scratch/test-run.pid-14649.log`), plus session/reader/MCP/history batches (55 files / 649 tests, `pid-10714.log`) and the 1b specs (3 files / 42 tests, `pid-6404.log`; compaction-runtime rerun 26 tests, `pid-12911.log`).
  - **Full suite not run:** explicit Plan Queue worker instruction assigns `npm run test:quiet` to the independent coordinator verifier. Final gates and Fresh-eyes checkboxes stay open. Live checks (including 1b's, now implemented) are in the livetest document.
- Everything is staged in the worktree (215 paths: 79 added, 136 modified) for the coordinator's single commit; `_scratch/` is gitignored and holds the logs named above. No plan/spec copy exists in the worktree.

**Worker handoff (15 Oct):** 16 of 17 active steps code-complete (1–15, 17). Step 16 open and blocked on Phase 3's C2b (handoff delivered). Parked 18–21 unchanged in the follow-up plan. Awaiting coordinator: full suite, fresh-eyes gate, live campaign. Whole plan must not be renamed or certified while step 16 is open, unless the coordinator records its C2b dependency as an accepted carry-over with the follow-up path chosen at Finishing.

> Plan Queue parked work: `queue/2026-10-10-oct-phase5-later-3e8047` — 1 commit(s), reason: verifier-unreliable.

## Queue implementation ledger (16 October 2026, dependency re-check)

James resumed this parked item. The prior park reason was "verifier-unreliable" (a verification failure, not an implementation gap). On resume the worker re-checked the only remaining implementation item, step 16, against the current tree rather than trusting the 15 Oct note.

- **Worktree/branch unchanged:** `.worktrees/queue/2026-10-10-oct-phase5-later-3e8047`, branch `queue/2026-10-10-oct-phase5-later-3e8047`, HEAD `20c8dfde7` (the round-1 checkpoint), `git status --short` clean. No code was changed this turn (step 16 needs none here); only this root plan document (untracked) was updated. No commits, stashes, branch switches or worktrees created. Nothing staged.
- **The step-16 dependency has landed (in Phase 3's branch, not this one).** `session-status-dock.*` is still absent from `main` and from this checkout (verified by search), so nothing can be built here without a forbidden second strip. But Phase 3's C2b status strip is now built in the Phase 3 queue worktree `queue/2026-10-10-oct-phase3-calm-scr-a4427f` (HEAD `234d3c36a`): `session-status-dock.component.ts`, `.rules.ts`, `.rules.spec.ts`. This is new since the 15 Oct note ("session-status-dock.* does not exist").
- **The recorded handoff was honored (source-verified read-only from Phase 3's checkout).** Phase 3's plan step 5 (C2b) carries the 15 Oct handoff block verbatim. The built C2b implements both rules and the guard exactly as this plan specifies:
  - Overflow: `splitDockChips` + `DOCK_CHIP_VISIBLE_CAP = 5` (five most urgent chips, rest fold into "+N more"; blocker/needs-a-human chips never fold) — matches "five plus +N is a reasonable default".
  - Registry: typed `DOCK_CHIPS: readonly DockChipDef[]` that new chips register into.
  - Esc: `resolveEscapeRouting` closes a chip's panel first and returns focus (interrupts only when no panel is open and a turn is in flight).
  - Guard spec `session-status-dock.rules.spec.ts`, described in-file as the "Phase 5 handoff guard", pins all four plan cases: no approval/question component inside the strip (DOM + source); chips beyond the cap fold into "+N more" that opens the list; Esc closes the panel and returns focus to the chip; the strip renders nothing when no chip has content.
- **The guard is green (Phase 3's own focused runs).** Structured results: `test-results.pid-29635.json` (16 Oct 15:39), `pid-91203` (13:34), `pid-29015` (13:12) all show the four "Phase 5 handoff guard" cases **passed**, plus `splitDockChips`/`sortDockStatusRows`/`DOCK_CHIPS` registry cases. An earlier run `test-run.pid-76949.log` (11:19) had the "Esc returns focus" case failing (with 2 C2b component cases); the Phase 3 implementer fixed it the same day and later runs are green. Relayed from Phase 3's logs and attributed to that branch — the worker did not import or run anything inside Phase 3's active worktree.
- **Disposition:** step 16 is complete as a Phase 5 deliverable (this plan builds nothing under it) and is delivered into C2b, where its Done-when ("the strip enforces the overflow and registry rules and the guard spec passes") now holds. It is not a Phase 5 in-checkout build; the checklist line records it as complete-via-handoff, not as code in this tree. **The one open action is coordinator-side:** at the Phase 3 + Phase 5 integration, run/confirm the guard green against the merged strip (this branch's suite cannot run it because the component/spec live in Phase 3's branch).
- **Fast static checks re-run this turn on unchanged code (all exit 0):** `npx tsc --noEmit` (`_scratch/r16-tsc.log`), `npm run typecheck:spec` (canonical 8 GiB command, `_scratch/r16-tsc-spec.log`), `npm run lint` ("All files pass linting", `_scratch/r16-lint.log`). No code changed, so the 15 Oct build/generator/IPC evidence stands unchanged; those expensive gates were not re-run. Full suite remains assigned to the coordinator verifier (not run here). Fresh-eyes remains a coordinator gate.

**Worker handoff (16 Oct):** all 17 active steps complete (1–17; step 16 via the C2b handoff, green in Phase 3). Parked 18–21 unchanged in the follow-up plan. This worker made no code change; the branch is clean and green on fast static checks. Awaiting coordinator only: full suite, fresh-eyes gate, live campaign, and the step-16 guard confirmation at Phase 3 + Phase 5 integration. The plan is ready for the independent verifier.

## Verifier round 1 (16 October 2026)

An independent verifier failed the branch with three findings. Findings 1–2 were reproduced and fixed; finding 3 was confirmed true but is coordinator-owned and cannot be fixed in this AIO worktree. The 16 Oct ledger's "step 16 is complete as a Phase 5 deliverable" disposition and the matching "all 17 complete" worker-handoff line are **over-claims corrected here**: step 16 is delivered into C2b but not accepted in this branch.

- **Finding 1 (high) — FIXED.** `src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts` expected tool-name list omitted `read_session`, added by `createSessionReadForwarderTools` (impl `orchestrator-tools-mcp-forwarder.ts:180`). Reproduced (received had `read_session` between `reset_node_connection` and `read_node_output`, expected did not). Fix: inserted `'read_session'` at that exact position in the expected list. Verified: `npx vitest run src/main/mcp/orchestrator-tools-mcp-forwarder.spec.ts` = 33 passed. Neighbourhood: `src/main/mcp` sweep = 51 files / 655 tests pass; no other spec asserts this ordered inventory (rpc-server / `__tests__` reference `read_node_output` but passed without change).
- **Finding 2 (high) — FIXED.** `src/renderer/app/features/browser/browser-page.approval-routing.spec.ts` counted **all** `button` elements in an approval card, which step 11's Details/Copy controls (3 Copy buttons, `browser-page.component.html:285-289`) now precede. Reproduced (received `['Copy','Copy','Copy','Allow once','Allow for session','Allow unattended','Allow forever','Deny']`). Fix: scope the two decision-button assertions (lines 115 **and** the second site at 142–143, which the verifier did not flag but was masked by the first failure) to `.permission-actions button` — the established selector already used in `browser-page.component.spec.ts:1461/1502/1532`. This narrows to the 5 decision buttons, preserving intent and asserting the same exact labels; Copy controls are covered separately in `browser-page.component.spec.ts:1363-1378`. Verified: routing spec 1 pass; whole `src/renderer/app/features/browser` sweep = 11 files / 148 tests pass.
- **Finding 3 (high) — CONFIRMED TRUE, coordinator-owned, NOT worker-fixable here.** The step-16 acceptance guard (`session-status-dock.rules.spec.ts`) and the C2b component it tests live only on Phase 3's branch `queue/2026-10-10-oct-phase3-calm-scr-a4427f`; they are not in this branch's tree, so the guard cannot run in this branch's delivered code path. Both in-worktree routes to change that are explicitly prohibited: (a) importing/copying another AIO worktree's code is "not an integration substitute" and AIO "owns … integration"; (b) this plan forbids building a second status strip. So the worker cannot make the guard run here. The prior `[x]` on step 16 was an over-claim and is corrected to `[ ]` (deferred). **Exact remaining action (coordinator only):** integrate Phase 3's C2b with Phase 5 and run the guard green against the merged strip, **or** record step 16 as an accepted C2b carry-over per Finishing ("unless the coordinator records its C2b dependency as an accepted carry-over"). This is a real cross-branch boundary, not a code defect in this branch's own steps 1–15/17.
- **Static checks after the fixes (all exit 0):** `npx tsc --noEmit` (`_scratch/r17-tsc.log`), `npm run typecheck:spec` (`_scratch/r17-tsc-spec.log`), `npm run lint` ("All files pass linting", `_scratch/r17-lint.log`). Full suite not run (assigned to the coordinator verifier). Two spec files changed (`orchestrator-tools-mcp-forwarder.spec.ts`, `browser-page.approval-routing.spec.ts`); no production code changed this round. Nothing staged; no commits/branches/worktrees.

**Worker handoff (16 Oct, after verifier round 1):** steps 1–15 and 17 green in-branch (findings 1–2 fixed and re-verified). Step 16 delivered into C2b but **open/deferred** to the coordinator's Phase 3 + Phase 5 integration (finding 3 — not worker-fixable; corrected the over-claim). Parked 18–21 unchanged. Awaiting coordinator: full suite, fresh-eyes gate, live campaign, and either integrate-and-run the step-16 guard or accept it as a C2b carry-over.

## Verifier round 2 (16 October 2026)

The verifier's round-2 findings. The round-1 test fixes (forwarder tool inventory, browser approval-routing) are committed and still green (34 pass). This round fixed one new test defect (finding 2) and reaffirmed finding 1 as a coordinator-owned integration boundary.

- **Finding 2 (high) — FIXED.** The new root-level Undo action registration (`inject(ActionDispatchService).register(...)` at `app.component.ts:153`, from step 10) constructs the action-dispatch dependency graph — `ActionDispatchService` injects `InstanceStore`, whose hydration effects reached `settingsStore.settings()`, `ipc.stateResync()` and a `.set` call — so 11 `app.component.spec.ts` tests failed on cascading incomplete-mock errors (`TypeError: this.settingsStore.settings is not a function`, then `this.ipc.stateResync is not a function`, then `Cannot read properties of undefined (reading 'set')`). Reproduced (11 failed / 4 passed). Fix (two parts): (a) completed the `SettingsStore` mock in all three TestBed configs with `settings: signal<AppSettings>({ ...DEFAULT_SETTINGS })` (the field the verifier named); (b) **stubbed `ActionDispatchService`** (`{ register: vi.fn(() => () => undefined) }`) in all three configs — the root fix, isolating these UI tests from the heavy `InstanceStore` graph (they test the startup banner / title bar, not action dispatch; `ActionDispatchService` has its own spec). Verified: `app.component.spec.ts` **15 pass** (was 11 failed); the cascade's own services (`action-dispatch`, `undo`, `provider-state`) **11 pass**; static checks `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint` all exit 0 (`_scratch/r18-*.log`). Only `app.component.spec.ts` changed this round.
- **Finding 1 (high) — CONFIRMED, coordinator-owned, NOT worker-fixable in this branch.** Same as round-1 finding 3. Step 16's acceptance guard (`session-status-dock.rules.spec.ts`) and the C2b strip it tests live only on Phase 3's branch `queue/2026-10-10-oct-phase3-calm-scr-a4427f`; they are absent from this branch, so C13.12's acceptance cannot run in this branch's delivered code path. **This is by design, not a worker shortfall:** the plan's own step 16 says its "every case fails, or is absent, today, because the strip does not exist yet" — i.e. step 16 was always integration-gated and was never expected to pass in a Phase 5 isolated checkout. Both in-worktree routes are prohibited (import another AIO worktree = "not an integration substitute"; build a second strip = forbidden by this plan), so the worker cannot close it here. **Terminal disposition for a branch-isolated worker:** Phase 5's in-branch scope (steps 1–15, 17) is complete and green; C13.12 remains a cross-branch item that only the coordinator can close by (a) integrating Phase 3's C2b with Phase 5 and running the guard green, or (b) recording step 16 as an accepted C2b carry-over per Finishing. Not faked; left open with the exact remaining action.

**Worker handoff (16 Oct, after verifier round 2):** finding 2 fixed and verified (`app.component.spec.ts` 15 pass; `app.component.spec.ts` is the only file changed this round; static checks green). Finding 1 (step 16 / C13.12) is integration-gated by design and not worker-fixable in this branch — it stays open as a coordinator integration/carry-over item (see the terminal disposition above). Steps 1–15 and 17 are complete and green in-branch. Awaiting coordinator: full suite, fresh-eyes gate, live campaign, and the step-16 integration-or-waiver decision.

## Verifier round 3 (23 October 2026)

The verifier's round-3 findings (both high, confidence 100) landed after the coordinator's merged-tree checkpoint
`8940eb287` and are fixed in this resume; the full remediation record is in
[the round-3 as-built notes](#as-built-notes-23-october-2026-verifier-round-3-remediation). Summary: finding 1 (the
`output-stream.component.ts` file-size ratchet) is fixed by extracting the reply-menu actions into
`reply-menu-actions.ts` and the pick gate into `table-pick.ts`, leaving the file at 1,271 lines under the unchanged
1,228 + 50 ceiling; finding 2 (the UI-hint ratchet and its 12 baseline discrepancies) is fixed by replacing the dock's
native chip titles with `appTooltip`, making the activity-status and MCP cost hints keyboard reachable, moving the
sidebar header's shortcut onto `appTooltipShortcut`, making the MCP cost hint measurable, and reconciling the
baseline/wording records with `--tighten --record-wording`. `check:ts-max-loc`, `check:ui-hints` and
`ui-hints-baseline.spec.ts` are green; the worker-level static/build/generator gates and 835 targeted tests re-passed
at the merged tree (`_scratch/phase5-round3/`).

**Worker handoff (23 Oct, after verifier round 3):** both round-3 findings fixed and re-verified in the assigned
checkout; the Final gates row's worker-level criterion is green at the merged tree. No commits, branch changes or
document renames by this worker. Parked steps 18–21 unchanged in the follow-up plan. Awaiting the coordinator
verifier only: `npm run test:quiet` (full suite, expressly not run by this worker), the fresh-eyes gate
(`task-completion-gate`, whose Gate 0 reproduces the full suite), the Phase 3 C2b merge reconciliation against the
delivered strip, and the live campaign in
[the live-test document](2026-10-10-oct-phase5-later_livetest.md). Finishing item 5 (`claude_oct-todo.md` marks) is
left for the finishing sequence because it links to the completed plan name the coordinator creates at rename.

> Plan Queue parked work: `queue/2026-10-10-oct-phase5-later-da028b` — 7 commit(s), reason: round-limit.

## Verifier round 4 (23 October 2026)

The verifier's round-4 findings (both medium, confidence 100; the first verification round of the current queue cycle)
both target step 16's strip rules and are fixed in this resume; the full remediation record is in
[the round-4 as-built notes](#as-built-notes-23-october-2026-verifier-round-4-remediation). Summary: finding 1 (the
status dock remaining rendered after its last content-bearing chip disappeared while its panel was open) is fixed by
deriving the strip purely from `chipViews()`, content-gating panel mounting, and closing panels whose chip loses content
(without silent reopen), while the review chip keeps its presentation while its panel is open so
`openReviewPanel`'s Cmd/Ctrl+Shift+V workbench stays reachable before the first review; finding 2 (Escape not
returning keyboard focus after closing a panel opened from the overflow list) is fixed at its mechanism — overflow chip
activation no longer unmounts the panel's trigger — plus the Escape ladder `dismissOpenSurface` (panel → overflow row →
interrupt routing) returning focus to each surface's trigger. The verifier's own boundary probes pass 2/2, the extended
step-16 guard passes 26/26, and the instance-detail sweep (88 files / 910 tests) plus all fast static/build gates are
green (`_scratch/phase5-round4/`).

**Worker handoff (23 Oct, after verifier round 4):** both round-4 findings fixed and re-verified in the assigned
checkout. No commits, branch changes or document renames by this worker. Parked steps 18–21 unchanged. Awaiting the
coordinator verifier only: `npm run test:quiet` (full suite, expressly not run by this worker), the fresh-eyes gate
(`task-completion-gate`), the Phase 3 C2b merge reconciliation against the delivered strip, and the live campaign in
[the live-test document](2026-10-10-oct-phase5-later_livetest.md).

## Diet size note

The dieted plan remains over 120 KB because its step bodies alone (Steps 1–17, Parked work,
Final verification, Live checks, Not in this plan, Found on the way, Corrections, Finishing)
measure about 201 KB and are deliberately unchanged per Phase B Step 3.4 ("Leave the step bodies
alone; their size is a design matter for Step 5"). The dated status and as-built content moved
here accounts for the reduction (330,909 → 206,405 plan bytes).
