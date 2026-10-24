# Oct-2 Phase F: help and tooltips everywhere, and keep it that way

## Status

Partial implementation in `queue/2026-10-20-oct2-phasef-tooltip-094153`. On main: no. Step 7's independent queue-copy
slice is implemented with the existing `appTooltip`; focused renderer/steering tests, both typechecks, lint, LOC and both
builds passed. Alias/IPC generation left no diff. Pause copy follows immediate stop/checkpoint behaviour; Steer copy
describes interrupt-before-send and the compaction exception, rather than promising delivery after the next tool call.
Steps 1–6 remain blocked: Phase B's three Phase 4 branches are not ancestors of this worker HEAD and their named
foundations are absent. AIO owns integration; no branch was merged or replayed. `check:ui-hints` exits with
`npm error Missing script: "check:ui-hints"`; no coverage count is claimed.
This is not a full-plan verification handoff. Independent review/full suite remain coordinator-owned. Windows eyes-on
checks for the copy slice are in [livetests](2026-10-20-oct2-phaseF-tooltips_livetest.md). Keep this plan active and unrenamed.
Evidence, exact remaining work and as-built notes: [history](2026-10-20-oct2-phaseF-tooltips_history.md).

**Backlog source:** [`claude_oct-2-todo.md`](../../claude_oct-2-todo.md) items H3-H9 (H1 is Phase B, H2 is Phase A, H10 is
later). **Programme:** [A](2026-10-20-oct2-phaseA-safety-and-truth_plan.md) ·
[B](2026-10-20-oct2-phaseB-land-built-work_plan.md) · [C](2026-10-20-oct2-phaseC-queue-that-finishes_plan.md) ·
[D](2026-10-20-oct2-phaseD-tokens_plan.md) · [E](2026-10-20-oct2-phaseE-calm-screen_plan.md) · F (this) ·
[housekeeping](2026-10-20-oct2-housekeeping_plan.md) · [later](2026-10-20-oct2-later_plan.md) ·
[decisions](2026-10-20-oct2-decisions-for-james_completed.md).

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
