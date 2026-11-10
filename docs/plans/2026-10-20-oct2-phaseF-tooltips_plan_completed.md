# Oct-2 Phase F: help and tooltips everywhere, and keep it that way

## Repair handoff preserved during queue document cleanup: 3 November 2026

The status below is retained from the committed worktree copy. Its verification claims describe the prior
repair session; this document-only cleanup did not rerun implementation checks. The root plan and its existing
history are preserved. The duplicate active plan is removed from the queue worktree for the coordinator.

Reopened on 3 November for verifier round 1 repairs in the `73fd2b` checkout, on top of AIO's implementation checkpoint.
The reported model-token guard and two dependency-compatibility failures were reproduced. Shared model constants and
a real local dependency install now pass the focused checks. Both typechecks, lint, size/hint checks and both builds pass;
native preparation and both automated Electron checks also pass. Fresh remediation review returned PASS. The extra worker
full-suite attempt was interrupted (exit 130); no full-suite pass is claimed. This is a repair handoff, with full-suite and
whole-feature acceptance left to AIO. AIO owns subsequent integration and document completion. No commit or rename.

```text
UI hints OK {"H11":8}; 13 markers; 350 wording entries (28 retired); 367 advisory reports
```

Current repair as-built notes and command evidence are in [history](2026-10-20-oct2-phaseF-tooltips_plan_history_c954462cd40ae32fb2e621fbf23fa54fd88e6dcc32124127dcc5cbb0a34a9fce_completed.md).
That document retains the older `094153` worker evidence as historical context. Existing Windows
[live checks](2026-10-20-oct2-phaseF-tooltips_livetest.md) remain unverified. Keep this plan active and unrenamed.


## Worker handoff: 3 November 2026

**Implementation recovered into the newly assigned checkout; worker verification passes.** The supplied base lacked the
previous Phase F contribution. Recovered it file by file from the parked queue branch while retaining newer code.
The only new implementation repair makes the header's waiting-detail tooltip readable by the wording checker without
raising its allowance, with rendered tests preserving the formatted values and open-tooltip updates.

- [x] Steps 1–7 and prior verifier repairs present; duplicate recovered attributes/providers omitted.
- [x] Every changed spec has current focused coverage. Both typechecks, repository/script lint, size/hint gates,
  both builds, generators, contract/architecture checks and native archive/SQLite smoke pass.
- [x] Author review and changed-line wording review (`All clear`); report, source seal and command receipts retained.
- [ ] Full suite and independent completion PASS remain coordinator-owned under the current worker instruction.
- [ ] Existing Windows live checks remain open; no implementation work is deferred there.

Current [report, receipts and seal](2026-10-20-oct2-phaseF-tooltips_resume-evidence/worker-73fd2b-2026-11-03/report.md).
Canonical plan/history stay at their root paths, active and unrenamed. No separate spec is linked. No staging, commits,
branch changes or integration operations were performed. Keep the provisioned dependencies for the verifier.


## Verifier round 1 repair handoff: 31 October 2026

**All three reported findings addressed; independent re-verification remains pending.** The two renderer failures were
reproduced before editing. Restored transcript-preview suppression and its screen-reader description link through the
existing icon-button directive. Updated the settings test's standalone imports without changing its assertions.

- [x] Transcript ticks show one preview on keyboard focus, with its description link, and close on Escape/blur.
- [x] Settings navigation tests exercise the real icon-button tooltip, including its expanded-state exception.
- [x] Reproduced the missing native SQLite binding and rebuilt it for the installed Electron. Every file that failed
  in the verifier's full run passes in the final uncached targeted run: `18 files · 268 tests passed in 34.8s`.
- [x] Both typechecks, lint, LOC, ordinary/merge-base hint checks, both builds, native archive/SQLite smoke and author
  diff review passed. Changed-line wording review: `All clear`.
- [ ] Full-suite rerun and fresh independent PASS remain coordinator-owned. Windows live checks remain open.

As-built detail, source seal and command receipts: [round 1 repair report](2026-10-20-oct2-phaseF-tooltips_resume-evidence/worker-61096e-round1-2026-10-31/report.md).
Keep the worktree's dependency install and rebuilt SQLite binding for the verifier. Temporary build output and caches
are removed after sealing. No commits, staging, branch changes or document renames were performed.

## Earlier worker handoff: 31 October 2026

**Implementation ready for independent verification in the assigned checkout.** Recovered the earlier Phase F contribution into the newer base and reconciled its UI, copy and tests. Earlier dated handoffs below are historical.

- [x] Steps 1–7, repairs 1–7 and the merge-hook repair are present; current worker checks pass.
- [x] The affected-screen tests, both typechecks, repository and changed-script lint, LOC, hint comparisons, both builds and candidate generators passed. A repeated deletion confirmation is now consumed only once.
- [ ] Repair 8's full suite and fresh independent PASS remain with the coordinator; Windows live checks remain open.

Latest [worker report, receipts and seal](2026-10-20-oct2-phaseF-tooltips_resume-evidence/worker-61096e-2026-10-31/report.md). Dependencies stay installed in the worktree for the verifier under the current queue instruction. No commit, real-index staging or document rename was performed. No standalone spec is linked.

## Hook timeout repair handoff: 29 October 2026

**Hook repair implemented; worker verification passed; independent gate still pending.**
The merge hook now tests the feature contribution and staged conflict resolutions against the incoming parent,
instead of retesting incoming main changes against the old feature tip. Normal commit selection is unchanged.
A real Git merge regression failed before the fix and now passes, including manual configuration resolutions.
The hook also refreshed the stale generated architecture inventory from the already-committed tooltip changes.

- [x] Repair merge-aware staged-test selection and retain failure propagation and generated-file exclusions.
- [x] Direct pre-commit hook passed on the pending repair using a disposable index: exit 0 in 35.73s;
  no commit was made and the real staging tree remains unchanged.
- [x] Focused hook/runner/generator tests, both typechecks, repository and changed-script lint, LOC, hints,
  generated architecture check and self-review passed. Runtime dependencies are removed after sealing.
- [ ] Full-suite and fresh independent PASS remain with the coordinator; existing Windows live checks stay open.

[Hook repair report, seal and receipts](2026-10-20-oct2-phaseF-tooltips_resume-evidence/hook-repair/report.md).
No standalone spec is linked. Keep this plan active, unrenamed and uncommitted; original item 8 remains unchecked.

## Current repair handoff: 28 October 2026

**VERIFIER REPAIRS IMPLEMENTED; worker checks passed; final independent verification pending.** James resumed this item on 28 October.
Repairs 1–7 and the resumed full-sweep/dependency findings have current evidence in the latest history section and
`2026-10-20-oct2-phaseF-tooltips_report.md`. The full suite and independent gate remain coordinator-owned,
as required by the resume instruction; this is not a whole-plan completion claim.
Original run `9b6a2192-c5b4-43a2-b2de-c08859cd080c`,
parent `xocgikiwn`; exact item `fbec1d7f-818b-4c36-be12-57298c094153`, branch
`queue/2026-10-20-oct2-phasef-tooltip-094153`. The retained original item records round 2,
`parked`, `worker-error` / `instance entered error`, and verifier `FAIL` in its historical snapshot.
Those records describe the earlier attempt, not the results of this resumed worker pass.

**Original evidence and authority:** the findings below were attributed to the original verifier.
Current reproduction and repair results are in the new history section. Original findings are retained at
`/Users/suas/work/orchestrat0r/ai-orchestrator/_scratch/plan-queue-evidence/2026-10-28-direct-defect-repairs/completed-original-run-status.json`.
That is a historical completed-run snapshot; the owning coordinator reports the original run now running
again. Use its matching original item, not duplicate notifications. Re-read the candidate's executing paths
and reproduce each reported defect before repairing it; record source and runtime evidence for any finding
that is no longer reproducible. Preserve all existing criteria and legitimate deferred checks below.

This handoff authorises no experiment, provider spend, real-account use, settings activation or live model
run. Agent-runnable defects must be repaired and tested in-loop, not moved to a live-test deferral. Keep
this plan active and unrenamed; no commits. Queue checkout, branch and lifecycle operations belong to the
owning coordinator, not this document repair.

### Repairs from the original verifier

- [x] 1. **Four failing behavior/contract tests (high):** reproduce the failures in
  `channel.store.spec.ts:139` (Harness naming), `verification-dashboard.component.spec.ts:428`
  (native-disabled assertion after migration), `scripts/screen-and-wording-guide.spec.ts:14`
  (guide structure), and `scripts/__tests__/ui-hints-baseline.spec.ts:11` (new H3 debt).
  Reconcile legitimate behavior changes only after verifying the runtime; preserve meaningful assertions.
  Original full output: `_scratch/test-run.phaseF-verifier.log`, structured results:
  `_scratch/test-results.phaseF-verifier.json` in the candidate evidence.
- [x] 2. **Tooltip ratchet and wording ledger (high):** verify the nested Copy Manual Config hover host
  beneath the danger-zone title in `remote-nodes-settings-tab.component.html:596-600` (H3 measured 3,
  recorded 2) and the ten missing qualifying wording entries. Fix the contract and record the words;
  pass both ordinary `check:ui-hints` and its `--against` actual merge-base comparison. Preserve reasons
  for any legitimate raised marker; do not hide this regression by simply increasing baseline debt.
- [x] 3. **Deliverable project skill (high):** verify the Step 6 pointer in `AGENTS.md:115` and the
  ignored `.claude/skills/screen-and-wording-guide/SKILL.md`. Resolve delivery so the required skill
  accompanies the candidate's integration, with a valid pointer; prove it from the deliverable diff,
  not merely its local presence. Preserve the Step 6 content and changed-lines review requirements.
- [x] 4. **Keyboard-reachable lasting disabled reasons (high):** finish Step 4's named-screen coverage,
  including routing Reset's lasting `!dirty()` state (`plan-queue-routing-panel.component.html:204`)
  and the only-enabled-account checkbox (`provider-accounts-tab.component.html:57-62`, native-title-only
  explanation). Verify focus, reason and blocked-action behavior with rendered tests. Preserve the
  short-busy-state distinction and verify Step 4 item 2 through existing validation/error paths; implementation gaps are not
  live-test-only checks.
- [x] 5. **Shared-component input wording coverage (medium):** verify `glossary-report.ts:69` and
  `analyze.ts:22`. The workflow preflight subtitle's visible “instance” bypassed the guard because
  input strings were absent from its streams. Cover visible shared-component inputs through the real
  analyzer/avoid-word path, including `workflow-page.component.ts:128` and its preflight-card rendering.
- [x] 6. **Single authored vocabulary source (medium):** verify `glossary.ts:34` and
  `src/shared/copy/ui-vocabulary.ts:15` onward. Move authored terms/definitions/avoid words to the
  existing required glossary source and reduce the name module to maps; update callers together.
  Prove consumers and generated agent guidance use that single source, as Step 5 already requires.
- [x] 7. **Delete-confirmation behavior coverage (medium):** verify the dashboard flow at template
  line 312 and `startDeleteSession()` / `dismissDeleteSession()`. Add rendered behavior tests proving
  first click preserves history, Never mind preserves history, and confirmation deletes exactly once;
  cover this behavior alongside the corrected disabled-state assertion.

- [ ] 8. **Repair verification and fresh review:** reproduce the relevant failures, verify repaired behavior,
  then add or correct meaningful regression coverage without weakening assertions. Run every existing
  extra gate in this plan and all eight canonical gates: `npx tsc --noEmit`, `npm run typecheck:spec`,
  `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
  `npm run build:renderer`, and `npm run test:quiet`. Retain current receipts. Require a genuinely fresh
  agent using `task-completion-gate` on the final candidate diff and acceptance criteria; fix actionable
  findings and repeat with another fresh context until `VERDICT: PASS`. The worker still leaves the
  active documents unrenamed and uncommitted for the owning coordinator.

  Worker portion passed on resume: targeted tests, both typechecks, lint, LOC, both builds, ordinary
  hints and the actual merge-base comparison; generators refreshed. The worker also reproduced and
  repaired an additional ledger regression: screen-reader-only or arbitrary input strings could
  substitute for a visibly rendered warning. Full-suite and fresh independent PASS remain unchecked.

---

## Status

On main: yes (this landing commit)
Code is on main (hand-merged 6 Nov 2026, commit `a527bf04d`). Steps 1–7 and all verifier repairs are in; nothing
implementation-shaped is left open. 10 Nov 2026 worker pass on a clean checkout of current main: the wording ledger had
one unrecorded sentence from a later Plan Queue change (`plan-queue-item-list.component.ts`); recorded it with
`--record-wording` (one entry, no allowance raised). Then `npm run checks` passed all seven gates (typecheck, spec
typecheck, lint, size, hints, both builds) and the five hint/guide specs passed (54 tests).

```text
UI hints OK {"H11":8}; 15 markers; 471 wording entries (61 retired); 449 advisory reports
```

Still open, and not worker work: the full suite and a fresh independent PASS (coordinator), and the Windows eyes-on
[live checks](2026-10-20-oct2-phaseF-tooltips_livetest.md) (screen reader, keyboard, rebound shortcut, layout).
Evidence for this pass is in [history](2026-10-20-oct2-phaseF-tooltips_plan_history_c954462cd40ae32fb2e621fbf23fa54fd88e6dcc32124127dcc5cbb0a34a9fce_completed.md); older as-built notes and receipts are
in the [3 November report](2026-10-20-oct2-phaseF-tooltips_resume-evidence/worker-73fd2b-2026-11-03/report.md).
Plan stays active, unrenamed, uncommitted.

### Verifier-repair as-built notes: 28 October 2026

- Completed the wider sweep: 50 → 206 disabled-reason hosts, 190 → 0 native control titles,
  and 112 → 167 named/hovered action icons. Nine remaining icon-like elements are dismissal scrims/backdrops,
  not missing action hints. Busy operations keep native protection; lasting input/select restrictions use
  focusable explanation hosts. Menu callers were updated together and protected composer drafts remain intact.
- Verified enable-then-error and correction paths in browser declaration approval, workspace connectors,
  campaign Run and remote-config Save; Pull/Push reach existing operations regardless of cached counts.
  No provider or real-account work ran. The earlier broad-sweep/title/Phase E blockers are superseded.
- Enabled the two zero-debt lint rules. Tightened records and preserved marker/retirement reasons. Shared literal
  projections and input defaults have guard regressions for prototype setters, shadowed imports and unrelated
  exports. Unsupported local function declarations remain unreadable rather than certifying unused body text;
  the evidence panel uses explicit central copy entries instead. No allowance exceeds the checkpoint.
- Reproduced and repaired local dependency drift with a real lockfile install, not a root dependency symlink.
  Package manifests and lockfile are unchanged. The created install is removed after sealing, as instructed.
- ✓ 150 files · 1880 tests passed in 46.2s; ✓ 16 files · 312 tests passed in 46.5s. Both typechecks, lint, LOC, both builds, hint checks, required generators and contracts
  passed. Fresh interim reviews' actionable findings were repaired; final full-suite/fresh gate remains unchecked.
- Updated all three required Windows checks and their prerequisites. They are actual assistive-technology/layout
  deferrals; no remaining implementation gap is represented as a live test. No Mac browser was used.
- Earlier merge notes below are historical. This resume started clean at `7c0846f56` with no merge in progress,
  staged paths or unresolved conflicts. The worker did not commit or perform any branch/worktree lifecycle action.

### Historical merge-repair notes (superseded by the status above):

### Merge-repair as-built notes: 28 October 2026

- All 15 supplied conflicts resolved and staged. The root document stays at this exact path, unstaged and
  unrenamed. No commit, merge continuation, merge abort, branch change or worktree creation was performed.
- Kept main's ranked worker/checker editor, model suggestions, account rules, stronger-worker handover and
  connector management. Reapplied lasting disabled reasons to the shared ranked-list controls, including
  worker list boundaries and limits; kept Reset's focusable explanation. Account changes call the new
  list/index handler. New rendered cases prove focus, the explanation and blocked activation on both lists.
- Kept main's runtime-package-only Plugins page and its validation/error/trust tests. Adapted the missing-input
> Earlier journal sections moved to `2026-10-20-oct2-phaseF-tooltips_plan_history_c954462cd40ae32fb2e621fbf23fa54fd88e6dcc32124127dcc5cbb0a34a9fce_completed.md`.
## In plain English

On the main code nothing you would notice has changed since 10 October: 48 of 169 icon-only buttons have both a hover hint
and a name for screen readers. The tooltip work is written on three side copies that Phase B lands. This plan then finishes
the job and stops it slipping back: the remaining nameless buttons, one way to show shortcuts, reasons on greyed-out
controls that keyboards can reach, one vocabulary file, a wording guide that loads only for screen work, and better copy
where James spends most time.

## Ground rules

1. **Read first**; line numbers are from 20 Oct `main` and move when Phase 4 lands; re-locate by name.
2. **The ratchet comes first** (Step 1): a sweep without it leaks again.
3. **Current checkout only;** no branch or worktree; never stage, revert or stash other sessions' files; commit only when
   James asks.
4. **Angular:** standalone, `OnPush`, `inject()`, signals; tooltips through `appTooltip` / `appIconButton` with copy from
   the tooltip copy module; never a new `title=`.
5. **No browser or desktop app on the Mac.** Headless Vitest only; eyes-on checks (including screen-reader and keyboard
   checks) go to the livetest document and run on the Windows PC. If it is down, stop and tell James; never fall back
   to the Mac.
6. Counts in this plan's Status are pasted output of `npm run check:ui-hints`, never prose.
7. Keep the Status block under about 1,500 characters.

## Order of work

| Step | Item | Size | Needs first |
|---|---|---|---|
| 1 | H6 a ratchet that survives parallel work | XS-S | Phase 4 part 1 landed |
| 2 | H3 the icon-button sweep | S | Step 1 |
| 3 | H4 one way to show shortcuts | S | Phase 4 parts 1-3 landed |
| 4 | H5 disabled controls say why, reachable by keyboard | M | Step 1 |
| 5 | H7 one vocabulary file with three uses | S-M | Step 1 |
| 6 | H8 the screen-and-wording guide as a project skill | S | Step 5 |
| 7 | H9 tooltip copy where James works most | XS-S | Phase 4 part 2 landed |

---

## Step 1. H6: a ratchet that survives parallel work

Part 1's ratchet is `scripts/check-ui-hints.ts` (`npm run check:ui-hints`), with `scripts/ui-hints/baseline.json` and
`wording-ledger.json`, wired in `.github/workflows/ci.yml`. Its base comparison (`--against <base>`) runs only on pull
requests, while `main` takes direct commits, and "stale is an error" with one shared baseline will conflict between parallel
queue worktrees.
1. Run the base comparison on push too.
2. "Stale" becomes a CI warning with an auto-tighten helper (`npm run check:ui-hints -- --tighten`); split the baseline by
   top-level renderer folder.
3. Any raised marker needs a written reason in the baseline entry.
4. Store the words, not only counts (the wording ledger), so each new tooltip string shows up in review.
5. Paste the first run's output into the history file and the Status block.

## Step 2. H3: the cheap sweep

22 icon buttons with no name and no hover: the archive page, codebase panel, hooks configuration, knowledge, memory and
context-query panels, skill browser, training dashboard, agent configuration, verification preferences, remote-browse
dialog, and the MCP "Add MCP Server" dialog (`mcp-page.component.html:583`). Also:
- the message box has no accessible name (`input-panel.component.html:318-330`, placeholder only);
- two composer buttons have only a native title (`:362-368` "Schedule thread wakeup", `:481-487` voice);
- 28 icon buttons have a name but no hover, including the destructive "Delete session ×"
  (`verification-dashboard.component.html:309-316`), which also gets a confirm or a visible consequence.

Use `appIconButton` (from Phase 4 part 1). **Target: about 101 of 169** icon-only controls meeting the contract after this
sweep (48 today + 53 edits); about 168 once Phase 4 parts 2 and 3 have migrated the other 67 native-title controls. Lower the
ratchet baseline in the same change.

## Step 3. H4: one way to show shortcuts

Parts 1 and 2 take a key-binding action id (`appTooltipShortcut="<action id>"`, live after rebinding, sets
`aria-keyshortcuts` via `KeybindingService.ariaShortcutsByAction`); part 3 passes a literal from `modKeyLabel()`
(`mod-key-label.ts:41-47`), which is wrong after a rebind. `main` has 19 hard-coded shortcut strings and no
`aria-keyshortcuts`. Standardise on the action id, delete `mod-key-label.ts` and part 3's strings, register actions for the
source-control hints, and switch on the "no hard-coded shortcut" lint at zero.

## Step 4. H5: disabled controls say why, and keyboards can reach the reason

264 lasting disabled states give no reason, and a disabled button cannot take focus. Worst: plan-queue routing panel (8 of
8), provider accounts, the worktree panel's "Merge All", the browser page (34), local models (22), MCP (22), plugins (15).
1. Use `appTooltipDisabledReason` (part 1), which keeps the control focusable with `aria-disabled` and swallows the click,
   on lasting states first. Short busy states keep plain `disabled` with a "Saving…" label.
2. Disable a control only when it truly cannot work. If James could fix the cause, let the click happen and show the real
   error (through Phase E's presenter).
3. Batch buttons show the eligible count: "Merge All (3)".

## Step 5. H7: one vocabulary file with three uses

The glossary exists on part 1 (`shared/glossary/glossary.ts`, 30 entries, used 3 times). Unexplained on screen today:
compaction (14 of 16 uses), MCP (13 of 13), worktree (13 of 13), RTK (7 of 7), debate (18), council (4), parked (4); "RLM" is
"Learning database" in help but "RLM" on screen.
1. One source, `src/shared/glossary/glossary.ts`, entries `{term, plain, group, avoid?, flag?}`, written as "what it means,
   not how it works", so each doubles as a tooltip body. A "Flagged" group for real double meanings ("worker" for a computer
   and for a queue agent). This is the single word list for the whole programme (Phase E's name module holds only maps).
2. Uses: the `<app-term>` popover and "Learn more"; a check that fails when visible text uses an `avoid` word ("AIO",
   "instance", "Orchestrator"); a short generated file for agents.
3. Agents get the rules through Step 6's skill, not through always-loaded AGENTS.md: one pointer line in AGENTS.md only.

## Step 6. H8: the screen-and-wording guide, loaded only for screen work

Part 1's D8 guide ships as a project skill that loads when a change touches `src/renderer` or visible text, plus one pointer
line in AGENTS.md. Add these rules, each with an AIO example:
1. **No fake zero:** every number has a declared source (measured, estimated, derived, not available), or it is hidden or
   labelled. Five review questions (CodePilot `CLAUDE.md:62-82`).
2. **Actionability:** if James could not act on it, it goes behind Details; healthy is invisible; composer controls stay
   quiet until they hold a non-default value.
3. **Enabled and running are two lines;** "not checked" is not "unavailable".
4. **Every automatic action's notice names its off switch;** a hint may fade, a count may not.
5. **openclaw's rules** (from its `ui/AGENTS.md`, `docs/web/control-ui/chat.md` and recent commits): omit rather than
   estimate; show progress once; never open a panel because of background activity; no second line repeating an icon; hide
   empty things; an explicit close sticks; the pointer cursor only for links; completion buttons last; colours only from
   tokens; a blocked action says what happens to the user's work.
6. **agent-orchestrator's** six-moment lifecycle table (arrive, leave untouched, begin, active, finish, interrupt), three
   review classes (Blocker, Must fix, Follow-up), and a dated decision log of James's rulings (Harness as the name; no
   rotating tips; healthy is invisible).

D9's review angle checks changed lines against these rules.

## Step 7. H9: tooltip copy where James works most

1. **The queue dock** (`composer-queue.component.html:26`, `:58`; hint at `input-panel.component.html:455`, `:461`): check
   each provider's real steer behaviour first, then "Steer: send this into the running turn now. The agent reads it after
   its next tool call." and the hint "Enter queues this to run after the current turn. Use Steer to redirect it now."
2. **The plan queue:** 32 buttons, 4 tooltips. Pause, Resume and Cancel say when each takes effect. Land part 2's
   `tooltip-copy-plan-queue.ts` if Phase B has not.
3. The effort picker and Codex settings copy is Phase E Step 7.

---

## Final verification

Canonical seven (`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`,
`npm run build:main`, `npm run build:renderer`, `npm run test:quiet`) plus `npm run check:ui-hints`, summaries in the history
file; fresh-eyes completion gate (a new agent using the `task-completion-gate` skill), repeated with another new agent until `VERDICT: PASS`.

## Live checks

`2026-10-20-oct2-phaseF-tooltips_livetest.md` (standard header), on the Windows PC: keyboard focus reaches a disabled reason;
a screen reader names the message box and the swept buttons; a rebound shortcut shows in its tooltip.

## Finishing

Rewrite the Status block as an as-built summary, rename the history file `_history_completed.md`, then rename this file `_completed` last. Commit only when James asks.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasef-tooltip-094153` — 1 commit(s), reason: verifier-unreliable.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasef-tooltip-61096e` — 2 commit(s), reason: land-blocked.

> Plan Queue parked work: `queue/2026-10-20-oct2-phasef-tooltip-73fd2b` — 3 commit(s), reason: land-blocked.
