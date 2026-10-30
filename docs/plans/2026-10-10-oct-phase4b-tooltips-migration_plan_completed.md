## Verifier finding to fix next (23 Oct, coordinator handoff; medium)

`composer-queue.component.ts:40` - the crash-loss warning (`hasNotSaved`) keys off the messages input identity, but
`QueuePersistenceService.setDurabilityFlag` mutates entries in place, so the warning stays on after the queued message
is saved. Observe the in-place durability change and add a persistence-acknowledgement regression.

**Fixed 24 Oct 2026** in the assigned worktree (see the [Coordinator-handoff remediation](#as-built-notes) as-built): `setDurabilityFlag` now publishes a new queue array on every flag flip — the observation channel identity-keyed consumers need — and a red-first persistence-acknowledgement regression pins the visible warning clearing when the durable write is confirmed.


# October Phase 4 (part 2 of 3): migrating the main screens

On the supplied base (`0389bf165a05d751ef6e735e82aeb43bb9b50779`): all eight implementations are present. Final queue verification and document closure remain open.

**Current execution (30 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-da593f`):** the supplied checkout starts clean at `0389bf165a05d751ef6e735e82aeb43bb9b50779`, identical to its starting `main`, and already contains all eight migrations plus later Phase 4c cleanup. No additional product-source, test, dependency or generated-file change is required. Fresh cache-disabled focused tests pass (173 files / 2,070 tests, zero failures or pending); both type checks, lint, size and tooltip guards, both production builds and all three generators pass. The tooltip records are unchanged by `--tighten --record-wording`; current strict-rule findings are zero repository-wide, with the existing H11 outside-template findings and advisory reports retained. Current evidence is in `_scratch/phase4b-da593f-20261030/` in the assigned worktree. No separate linked spec exists. Full suite and final independent verdict remain with the queue verifier; live checks remain in the existing root livetest document. This worker does not rename or close the plan, update the historical backlog, commit or integrate. Earlier checkout results below are historical and do not supply this run's evidence.

**Previous execution (28 Oct 2026, resumed `a7d5c4` checkout):** all five conflicts from the coordinator’s latest merge of `main` are resolved and staged, preserving both parents’ behavior. The migration is ready for the queue verifier; the merge remains in progress, without a worker commit or abort. The shell keeps main’s deliberate Remote Terminal relocation into the left rail, alongside the tooltip migration; the rail retains the new Plan Queue destination and both sets of tests; the queue item list retains the reactive stronger-worker label and its tooltip imports. Fresh focused tests (32 files / 455 tests), both type checks, lint, size/tooltip guards, both production builds and generators pass under pinned Node v24.22.1. A genuinely fresh scoped task-completion-gate review returned PASS with no actionable findings and independently passed the three directly affected specs (60 tests). Current report, receipts, source comparisons, review and seal are in `_scratch/phase4b-merge-20261028/` in the assigned worktree. No separate linked spec exists. Full suite, final whole-migration PASS, document closure and integration remain with the queue verifier/coordinator. Existing live checks remain open in the linked livetest document. The previous clean-checkpoint verification notes below are historical, not evidence of the current merge state.

**Historical status (23–24 Oct, parked checkout):** All eight parts (1a–1h) implemented in the assigned worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506` (23–24 Oct 2026), plus the independent verifier's three round-1 findings, five round-2 findings, the 23 Oct coordinator-handoff finding, the 24 Oct re-check's two findings and the 24 Oct round-2 re-check's two findings fixed (24 Oct round-2 re-check remediation: the past-runs Copy button's lasting missing-prompt state now carries a focusable `appTooltipDisabledReason` reason like Reattempt — native `disabled` skipped Tab and hid the reason — with focus and blocked-activation coverage; the full-suite question-case flake in `plan-queue-coordinator.spec.ts` is de-flaked, its eight bare `vi.waitFor` waits now carrying explicit timeouts per that file's own convention, and the full suite passed under the pinned Node v24.22.1 (2,757 files, 35,113 tests); 24 Oct re-check remediation: the Hardened and Fence toggles' lasting disabled states now carry focusable `appTooltipDisabledReason` explanations per the recipe's lasting-disabled rule, with focus and blocked-activation coverage — native `disabled` skipped Tab and hid the reasons from keyboard users; the full suite passed under the pinned Node v24.22.1 (2,757 files, 35,109 tests — the default PATH node lacks the Node SEA fuse and fails two SEA cases by design); 24 Oct coordinator-handoff remediation: the crash-loss warning now clears when the queued message's durable write is confirmed — `QueuePersistenceService.setDurabilityFlag` publishes a fresh queue array per flag flip and a red-first persistence-acknowledgement regression pins it; 23 Oct round-2 remediation: the Pause copy's false "running work finishes" promise corrected against the real `holdItem` runtime and pinned by a main-side behaviour case; the Loop switch track no longer swallows hover; the automation clock is Tab-reachable; one real Tab/focus-visible case per part via the shared `stubFocusVisible` helper; the voice button and Reattempt keep their disabled look while aria-disabled). 1g and 1h landed first (23 Oct) against the post-merge state; 1a–1f (Tier A) were implemented in the 24 Oct remediation round **against today's templates, per the Phase 3 overlap rule** ("if one of them slips, do that part's whole list from the part text"), because the verifier ruled them unfinished agent-runnable migrations rather than skippable work. Part 1's foundation landed on `main` (`0c4b7de7a`, 23 Oct) and this work uses that landed API set — no duplicate helpers, no manual merge/rebase/checkout, no queue-metadata change. Record drops (whole plan, from main's post-merge 23 Oct state): native titles on controls 207→133, on plain elements 130→106, nested hover hosts 20→9, hard-coded shortcut text 12→4, hover-only without reason 127→104, icon controls without a tooltip 89→63, icon controls without a name 24→22; wording ledger 202→208 entries (209 after the round-2 Pause correction: one false sentence retired via H9's `--retire` route, the corrected sentence recorded). The strict rules (H1a, H1b, H2a, H2b, H3, H5) read **zero on every migrated file** and H4 reads zero there (each remaining hover-only host carries an exact recorded reason); the two `app-prompt-modal` `title` inputs in the session list stay listed exceptions (dialog titles). Gates on 24 Oct: tsc / typecheck:spec / lint / check:ts-max-loc / build:main / build:renderer / check:ui-hints green; targeted suites green (settings 60, dashboard/rail/list 53, instance-detail 837, plan-queue + loop + tooltip + shell + chips + tooling included in a 1,839-test sweep and a 467-test tooling re-run). Gates re-run green after the round-2 remediation (23 Oct): the same gates, plus targeted sweeps of 1,255 (main plan-queue + tooltip + pause + renderer plan-queue + loop), 1,443 (instance-detail + instance-list + dashboard + settings) and 467 (tooling) tests. Named failing cases seen failing first in this checkout: 1a's "no title / collapsed input" (5 red on pre-migration settings), 1d's "a not-saved message shows the visible warning line", the verifier's two repro signatures (finding 2 "Hide full prompt", finding 3 tabIndex), and the round-2 red-runs (the switch track's `pointer-events`, the clock's `tabIndex: -1`, the two aria-disabled style cases). Full suite: green under the pinned Node v24.22.1 in the 24 Oct round-2 re-check (2,757 files, 35,113 tests — see the round-2 verification remediation as-built; the 24 Oct re-check's first green run is in the verification re-check remediation as-built); the fresh-eyes gate remains open (verifier/coordinator). Live checks stay in the [livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md). The queue's base sync is resolved (23 Oct 2026 merge of `main` into this branch; see the 23 Oct sync as-built). The 16 Oct notes below describe the parked `queue/2026-10-10-oct-phase4b-tooltip-8b1f09` checkpoint and are historical, not this checkout. Written 2026-10-10. Keep this file untracked until every part is implemented and
verified (see [Finishing](#finishing)). This is part 2 of 3 of Phase 4, which the second review (10 Oct 2026) recommended
splitting so that each part can close on its own. [Part 1](2026-10-10-oct-phase4-tooltips_plan.md) builds the tools and must
be finished first. [Part 3](2026-10-10-oct-phase4c-tooltips-finish_plan.md) migrates the rest and switches the lint rules on.

**Source:** the "Phase 4" row of the approved backlog [`claude_oct-todo.md`](../../claude_oct-todo.md) (James approved
it on 10 Oct 2026 and answered decisions 1-7). The row reads: "4: tooltips everywhere (rolling) | D1b (after D1), D2 →
D3 → D4 → D5 tiers → D6 → D8 → D7 → D9 → D10 | Measure, ratchet, building blocks, then migrate one surface per change".
This part is the first half of D5 (proper hints, names and warnings on every screen): Tier A (the Settings menu, the left
icon bar, the top bar, the message box and its queue, the session list, the session header) and Tier B (the loop and
plan-queue buttons).

**How it was checked:** on 10 Oct 2026, a read-only check (`p4-b.md`, in `_scratch/oct-phases/`, which is gitignored and
disposable) re-traced every D5 item against the working tree (HEAD `04b6db59b` plus other sessions' uncommitted work). The plan
writer re-read the Settings menu, rail, composer, queue, banners, session list, header, loop and plan-queue sources and every
file's headroom, and read the Phase 0, 2 and 3 plans for overlaps. A second, fresh review the same day (`_review2-phase4.md`)
checked the whole of Phase 4 and recommended the split; its findings are applied here, and its resolution log says where. Part
1's header holds the full account of the checks and the conflicts they settled.
**Line numbers are as of 10 Oct and will move. Re-read the code before editing.**

**Size:** eight changes, one per part (1a to 1h), of size XS to S-M, done one at a time. Sizes use the backlog's XS-L scale.
First: 1a (the Settings menu), once part 1 is finished and Phase 3's C11 has landed.

**Depends on:**
- **Part 1 of this phase** ([`2026-10-10-oct-phase4-tooltips_plan.md`](2026-10-10-oct-phase4-tooltips_plan.md)), finished:
  - the bridge (step 1), the counter (step 2) and the guard with its records (step 4, with 4c written);
  - the building blocks (step 5): the collapse toggle in 1a, the voice button, the Loop switch and the plan queue's buttons need 5d, and the
    rail needs 5c;
  - the glossary and the first three screens (step 6; 1d needs 6c, the "steer" tag);
  - room in the loop setup panel (step 7a, unless Phase 2's part 9e already did it), needed by 1g.
- **The Phase 0 plan:** step 5 (D1, tooltip directive fixes) before 1a. Steps 2.6a (the "Close" button on stranded loop runs, with its own tooltip) and
  2.6c (the recycle hint) have already touched 1g's files. Step 3 may already have converted the footer's Close all title (1e). Step 8 adds the
  header's cost item with its own tooltip (1f).
- **Phase 3 (calm screen):** C11 (Settings menu) before 1a. C10 (rail) and C4 (session list; its part 6d also edits the rail) before 1b. C5 (top bar)
  before 1c. C2, C8 and C9 before 1d. C4 and C9 before 1e. C2 and C8 before 1f.
- **Phase 2 (loops converge):** step 15 (the loop screen, backlog B9) before 1g. Steps 4 (parts 4d and 4f) and 5 (the Plan Queue page, backlog B9) before 1h;
  step 5 rewrites the controls and the item list ("Skip asks first", a status word, "Round N of M").
- **Files shared with Phase 5** (no hard order; whichever lands second carries the other's change): C13 (the sidebar header's two "new" buttons become one
  "New session" button, with 1e) and C12A (the session list's archive code, with 1e).
- **What comes after:** part 3 uses this part's recipe (step 1 below) and the records it has lowered.

---

## In plain English (what James will notice)

This part puts the new tools to work on the screens you look at all day, one area per change. The rest of the app follows in part 3.

1. **The screens you look at all day get proper names, hints and visible warnings, one area at a time.**
   - Order: the narrow Settings menu, the left icon bar, the top bar, the message box and its queue, the session list, the session
     header, then the loop and plan-queue buttons.
   - Anything a hover used to warn about that matters becomes visible text. For example, the queue will say "Not saved yet. If Harness
     crashes now, the marked message could be lost." instead of hiding that in a hover.
2. **The narrow Settings menu names its icons.** When it is squeezed to icons, each icon's hint gives its name and status, for example
   "Provider Quota, Exhausted". When the menu is wide there is no extra bubble.
3. **Shortcut hints show your real keys.** The left bar's hints show whatever keys you have set, and say Ctrl, not Win, on Windows.
4. **Buttons that stay greyed out explain why.** The voice button, the Loop switch with no folder picked, and the plan queue's Start and Submit say why,
   and Tab reaches them.
5. **The plan queue's Pause says what it really does:** it stops anything new from starting and pauses work already
   running — that work is saved and carries on when you resume.

## Decisions this plan follows

From James (10 Oct 2026 unless stated):
- The product name on screen is **Harness** (Decision 1). All new wording says Harness.
- **Keep James's personal setup in machine-started sessions** (Decision 2). Nothing here removes any of it.
- The backlog's own rule for this phase: fix the directive, measure honestly, ratchet, then migrate one surface per
  change. A mass swap of `title=` attributes once lost a destructive-action warning, so wording only moves by the recipe
  in step 1 below.
- Screen checks run on the Windows PC, or on the Mac only with James's OK. No branches or worktrees. Commit only when
  James asks.

Choices made while planning. Each is the recommended default, none blocks starting, and James can change any of
them. Visible changes have their own entries (1 to 3); the last is about how the work is done. One change since the first draft: Phase 4 is
now three plans (this is part 2 of 3), so each part can close on its own. This part closes when its eight parts are done, whatever the state of part 3.
1. **When the Settings menu is squeezed to icons, each icon's hint gives its name and status; when it is wide there is no
   hint (visible).** For example "Provider Quota, Exhausted". The status is also spoken in every state, which it never
   was. Alternative: always show the hint and rely on the repeat check. Why not: the badge text sits inside the same
   button, so the check would let a hint that only repeats the label through in the wide menu. A visible status dot on
   the squeezed menu is a later, optional improvement (recommended, with Phase 3's Settings visual pass).
2. **A warning that exists only in a hover becomes visible text in the same change (visible).**
   - The rule for every migration: if an old hover said something is deleted, stopped, restarted, sent elsewhere, spent
     or lost, that sentence goes into visible text or behind a confirm.
   - First cases: the queue's "Not saved yet. If Harness crashes now, the marked message could be lost." (one line for the
     whole queue, not on every chip), the "Allow path & retry" bar ("Allowing a path gives this session write access to
     it."), and the session header's wait reason.
   - One recorded exception: three banner buttons ("Just retry", "Switch provider" and the "Switch account…" box) restart the
     session or move the conversation to another provider or account. Their visible label already names the action, so their
     longer explanation stays as a hover that opens on Tab, as an elaboration of that label. Rewording the labels would break
     the rule that names do not change in a migration. Alternative: say it in visible text next to the bar.
   - Alternative: keep every such warning as a hover on a focusable host. Why not: not everyone hovers.
3. **Loop and plan-queue buttons say what they do (visible).**
   - The Loop switch carries its own reason, and Tab shows "Pick a working folder to enable Loop Mode" even though it is
     greyed out. Hovering the word "Loop" shows the same sentence as before.
   - Plan-queue Pause says "Stops anything new from starting and pauses work already running. Paused work is saved and
     carries on when you resume." That is what the code does (the 23 Oct correction below verified it against `holdItem`;
     the first draft's "work already running carries on" claim described behaviour the coordinator never had).
   - Alternative: an extra visible line under the switch. Why not: a focusable host already meets the house rule.
4. **Screens are migrated one at a time, in a fixed order, from the counter's fresh list (not visible).**
   - Every screen is migrated after the Phase 3 change that edits the same template, and starts from the counter's fresh list, not
     old line numbers.
   - Settings menu first, then the rail, title bar, composer, list and header; part 3 starts with the conversation tools.
   - New hint text goes in the central text file only when it carries a consequence, is used twice, or runs past about 60
     characters. New sections go in new files spread into it.
   - Each part records its new qualifying hover sentences in the wording ledger, so they are protected from then on.

## Ground rules for every part

1. **Read first.** Re-read the file, its callers and its specs before editing. Line numbers here are from 10 Oct, and
   Phase 0 and Phase 3 will move many of them.
2. **Prove the bug first.** For the parts that fix something (1a, 1d, 1g and 1h each name cases that "fail today"), write the named
   failing test first and confirm it fails on today's code. Cases marked "fails today" must be seen failing.
3. **Work in the current checkout.**
   - Do not create a feature branch or worktree; that is James's rule.
   - Other sessions have uncommitted work in this tree (176 entries on 10 Oct). Treat anything already modified before
     you start as theirs, and never stage, revert or reformat it.
   - Known collision with this part: `features/settings/settings-navigation.ts` has a label change from another session. Part 1a does not
     touch it; the new tooltips read its labels, so they pick the change up.
   - Run `git status --short` on the day each part starts.
4. **File-size limits** (`npm run check:ts-max-loc`).
   - Allowlisted files may grow to their ceiling plus 50 lines. Other `.ts` files are capped at 700. "Room" below is
     measured that way, so it is the true failure threshold. Templates, styles, specs and docs are not counted.
   - Only git-tracked `.ts` files are checked, so a new module is not size-checked until it is tracked. Count new
     modules by hand against 700 while developing.
   - Headroom on 10 Oct, for the files this part edits. Paths are under `src/renderer/app/` unless they start with `src/`:

   | File | Lines now | Room left | Plan |
   |---|---|---|---|
   | `features/loop/loop-config-panel.component.ts` | 700 | 0 | part 1's 7a moves the default constants out first (about −50) unless Phase 2's part 9e did; then 1g (and part 1's 7c): import-only edits |
   | `features/settings/settings.component.ts` | 699 | 1 | 1a: net-negative only. Move the six storage helpers out first unless Phase 3's C11 (net about −20) has landed |
   | `features/instance-list/instance-list.component.ts` | 1,481 | 4 | part 1's 2b: one import. Phase 3's C4 may use some. 1e's edits are template-only |
   | `features/instance-detail/instance-header.component.ts` | 694 | 6 | part 1's 7c: one import. Falls to about 430 once C2 lands; 1f is template-only |
   | `features/instance-detail/input-panel.component.ts` | 1,938 | 22 | 1d: import-only, plus a shorter send label. New logic goes in *`input-panel-tooltips.ts`* |
   | `features/dashboard/dashboard.component.ts` | 758 | 22 | not edited. 1e is template-only |
   | `features/instance-detail/composer-toolbar.component.ts` | 642 | 58 | 1d |
   | `shared/components/provider-quota-chip/provider-quota-chip.component.ts` | 600 | 100 | 1c |
   | `features/instance-detail/composer-banners.component.ts` | 504 | 196 | 1d |
   | `features/loop/loop-past-runs-panel.component.ts` | 489 | 211 | 1g |
   | `shared/tooltip/tooltip-copy.ts` | 251 | 449 | part 1's 6c: delete 2 keys. Phase 0 and Phase 3 add about 200 lines first. Re-measure; 1d and 1h add sections in new files |

   Roomy files edited by one part only (more than 250 lines of room) are not listed. All new modules are planned well
   under 700 lines. Put new logic in new modules, keep call-site edits to a line or two, and do not raise a ceiling.
5. **Wording on screen:**
   - Plain English, "Harness", and no internal codes.
   - Tooltips use `appTooltip` with `TOOLTIP_COPY`. Do not add new `title=` attributes to controls.
   - A tooltip may not be the only place that shows a state or a consequence (house rules at the top of
     `tooltip-copy.ts`).
   - Old hover wording moves verbatim and only by the recipe in step 1 below. Never reword, merge or drop a hover sentence
     inside a bulk edit.
6. **IPC:** this phase adds no channel. If one turns out to be needed, follow the Phase 0 rule: channel file,
   `npm run generate:ipc`, schema, handler, preload domain, `npm run verify:ipc` and `npm run verify:ipc-usage`.
7. **No browser on the Mac.**
   - Test renderer behaviour headless in Vitest (jsdom), with seeded stores and fake timers.
   - Anything that needs eyes on the rebuilt app goes to the live checks. Those run on the Windows PC, or on the Mac
     only with James's OK.
   - Brief every subagent and reviewer on this rule.
8. **Never write to James's app databases or settings from a script.** This phase changes no stored data. The
   counter and the guard read source files only.
9. **Testing:** while working, run `npm run test:quiet -- <spec>`. Scripts specs live in `scripts/` and run in the
    "main" Vitest project (jsdom). Renderer specs run in the renderer project. When a part is finished, run the
    [gates](#final-verification) that apply.
10. **The records are already written (part 1's step 4c).** Each part ends with `npm run check:ui-hints -- --tighten` and a green guard. If another
    session's template change lands and the guard goes red, fix the cause or run `--tighten`. Never raise a number by hand; the one
    sanctioned way to raise a record is `--exempt` for a new marker (part 1's step 4a).
11. **New files start at zero.** A new component has no record, so any problem in it fails the guard. Use `appTooltip` plus an `aria-label` on
    every icon button, and mark invisible backdrops (a new backdrop that is hidden from keyboard and screen readers with
    `aria-hidden="true"` and `tabindex="-1"` needs no marker).
12. **Commit only when James asks.** The guide (`docs/screen-and-wording-guide.md`) is a product document from part 1; it is committed with that part's work
    when James asks.

## Order of work

Parts run one at a time. "Needs first" lists hard dependencies only. A part that is still waiting for its Phase 2 or Phase 3 item is
skipped for now; the others do not wait for it.

| Part | Item | Size | Needs first | Main files (new modules in *italics*) |
|---|---|---|---|---|
| 1a | Settings menu when squeezed to icons | XS-S | Phase 0 step 5; Phase 3 (C11); part 1 steps 1 and 5 (5d for the collapse toggle) | `settings.component.*`, *`settings-nav-label.ts`* (and *`settings-local-state.ts`* only if room is needed) |
| 1b | Left icon bar | S | Phase 3 (C10, and C4's part 6d); part 1 step 5 (all of it) | `workspace-rail.component.ts` |
| 1c | Top bar of the window | S | Phase 3 (C5) | `app.component.html`, six chip components |
| 1d | Message box and its queue | M | Phase 3 (C2, C8, C9); part 1 steps 5 and 6c | input panel, queue, banners and toolbar, *`input-panel-tooltips.ts`*, *`tooltip-copy-composer.ts`* |
| 1e | Session list | M | Phase 3 (C4, C9); Phase 5 (C13) if landed; part 1 step 2b | list, sidebar header and footer, dashboard |
| 1f | Session header leftovers | S-M | Phase 3 (C2, C8); Phase 0 step 8 | `instance-header.component.html` |
| 1g | Loop switch, setup panel and past runs | S | Phase 2 (step 15); part 1 steps 5d and 7a (7a is skipped if Phase 2's 9e did it); Phase 0 steps 2.6a and 2.6c | loop toggle, config panel, past runs, *`loop-config-tooltips.ts`* |
| 1h | Plan queue | S-M | Phase 2 (steps 4 and 5); part 1 step 5d | plan-queue templates, *`tooltip-copy-plan-queue.ts`* |

Files shared across parts:
- `tooltip-copy.ts` and its new section files (part 1's 6c, then 1d and 1h).
- `composer-queue.component.html` (part 1's 6c, then 1d); `instance-header.component.*` (part 1's 7c, 1f, Phase 3 C2 and C8);
  `loop-config-panel.component.*` (part 1's 7a and 7c, 1g, Phase 0 step 2.6c); `instance-list.component.*` (part 1's 2b, 1e, Phase 3 C4,
  Phase 5 C12A); `workspace-rail.component.ts` (Phase 3 C4 and C10, 1b).

Do those parts in the order above.

**Numbering (old to new).** The single Phase 4 plan's parts 9a to 9h are 1a to 1h here, in the same order. Everything else moved: its
steps 1 to 8 and the lint plug-in (old 10a) are in part 1, and its 9i to 9n and 10b to 10e are in part 3. Where this plan says "part
1's step 5d", it means the old step 5d.

**What "rolling" means here.** Each part is one change. Each change starts from a fresh list from the counter
(`npm run audit:ui-hints -- --list <rule>`, filtered by file), converts that area, and ends with
`npm run check:ui-hints -- --tighten`. The change description states the drop in plain numbers, for example "native
titles 216 → 208". A part is finished only when its files read zero for the strict rules (or carry a listed reason) and
the wording ledger passes. Progress is read from the guard's one-line summary.

---

## Step 1. D5 (tiers A and B): Proper hints, names and warnings on the main screens, one area at a time (M-L)

**For James:** the parts of Harness you look at all day get proper hints first, one area per change: the narrow Settings menu, the
left icon bar, the top bar of the window, the message box and its queue, the session list, the session header, then the loop and
plan-queue buttons. Part 3 does the conversation tools, side chat, source control, settings and the rest. Each area is checked by hovering and by
Tab. Anything a hover used to warn about that matters becomes visible text instead.

Eight parts here, one change each, in the order below (the backlog's Tier A is 1a to 1f, Tier B is 1g and 1h; part 3 holds Tier C and Tier D). The
order differs from the backlog's list on purpose: the Settings menu first because it proves part 1's step 1 fix on a real template, then the rail (eight
simple controls and the first user of the shortcut chip), then the title bar, then the busy surfaces; the header is mostly done by Phase 3's C2 and C8, so
it comes after the composer and list. Needs part 1's steps 4 and 5 (and its step 6c for 1d). A part that is still waiting for its Phase 2 or Phase 3 item is
skipped for now.

**Phase 3 overlap rule.** C2, C4, C5, C8, C9, C10 and C11 edit the same templates. Each part starts from the counter's fresh list, not
from the line numbers below, and does only what those changes leave. If one of them slips, do that part's whole list from the part
text. Do not redo what they already specify.

**How every part is done (the recipe).**
1. **Worklist.** Run the counter for the part's files: `npm run audit:ui-hints -- --list H2a` (and `H1a`, `H1b`, `H2b`, `H3`, `H4`,
   `H5`, `H10`), filtered by file name. Before editing, save the files' old hover strings (`git show HEAD:<path>`), and also copy the
   bodies of any member that a hover binding calls (for example `closeTooltip()` in the session list's row) and the text of any imported
   helper they call: the ledger reads the members, but a human compares against this list, and a helper in another file is read by
   nothing else. The wording ledger covers hover sentences of three or more words that carry a consequence word or run to seven words
   or more; shorter labels are covered only by this saved list and the diff review.
2. **Choose one form per control.** Never merge two different strings into one; names do not change in a migration.
   - An icon button whose tooltip and name are the same words: `[appIconButton]="'Name'"` (plus `appTooltipShortcut` when the action
     is a registry action).
   - An icon button whose tooltip adds meaning: keep the existing `aria-label` and move the old title to `appTooltip`. The shortcut
     glyphs are the only text allowed to move (to `appTooltipShortcut`).
   - A text button with an explanation: `appTooltip` with the old text verbatim. A lasting disabled state: `appTooltipDisabledReason`
     fed by a `<thing>DisabledReason` computed placed next to the `<thing>Disabled` one. A busy disabled state: keep `disabled` and
     put the state in the label.
   - A title on a non-control element: if it repeats a truncated label, `appTooltip` with `appTooltipVariant="overflow"` (for example
     the session name, `instance-header.component.html:21`); if it adds information that is not visible, make that information
     visible, or make the host focusable if it only explains a visible word; otherwise it goes on the reasoned list.
3. **Registry or inline.** Put a string in `TOOLTIP_COPY` only when it carries a consequence, is used in two places, or is longer than
   about 60 characters. Short names stay inline. Copy is moved verbatim; new wording says Harness, never AIO or Orchestrator, in plain
   words. New sections go in new files spread into the registry (`tooltip-copy-composer.ts`, `tooltip-copy-shell.ts`,
   `tooltip-copy-plan-queue.ts`); `tooltip-copy.ts` keeps the types, `tooltipText`, `copyFor` and `TooltipCopyKey`. Part 1's step 4
   dead-key rule already reads every `tooltip-copy*.ts`.
4. **Consequences first (house rule 2).** If an old hover says something is deleted, stopped, restarted, sent elsewhere, spent or lost,
   the same change shows that sentence as visible text or behind a confirm, and the change description lists it.
5. **Imports.** Add the directive to the component's `imports`. A missing import leaves the attribute inert (the finding in part 1's step 2b), and the
   counter now fails on it.
6. **Records.** Run `npm run check:ui-hints -- --tighten`. The touched files' entries only go down. Put the drop in the change
   description, for example "native titles on controls 216 → 208". Then run `npm run check:ui-hints -- --record-wording`, so the part's new qualifying hover
   sentences (a consequence word, or seven words or more) are protected from now on; until they are recorded, a new sentence is only a notice.
7. **Specs for the part** (create the spec if missing): the migrated template has no `title` attribute on any control
   (`querySelectorAll('[title]')` is empty apart from listed exceptions); each icon-only control has an accessible name and a tooltip
   input (read through `By.directive(AioTooltipDirective)`); every consequence moved inline is present as visible text; one Tab-focus
   case per part using `stubFocusVisible` (the first control opens its tooltip).
8. **Live.** Hover and Tab through the area on the Windows PC against the saved list of old strings. For every part: hover each control
   for a second and expect the same or better text (the first within 200 ms, the next immediately); Tab through and expect every icon
   control to open its tooltip on focus and Escape to close it.

**Done when, for every part:**
- `command grep -nE '(\[title\]|\[attr\.title\]|[^a-zA-Z-]title=)'` on the part's files prints nothing except listed exceptions; the
  counter shows zero for the strict rules on those files (H1a, H1b, H2a, H2b, H3, H5, and H4 unless a reason is listed); the records
  moved down; the wording ledger passes.
- The part's specs (`npm run test:quiet -- <spec files>`), `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:renderer`
  and `npm run check:ui-hints` pass.
- The live check was done on the Windows PC with the saved list of old strings.

**Expected record drops** (raw grep counts of native titles on 10 Oct; the counter's list is the authority):

| Part | Native titles to convert | Other rows expected to fall |
|---|---|---|
| 1a Settings menu | 3 | icon-control rows for the menu buttons |
| 1b Left icon bar | 8 | shortcut text −3; icon-control rows −8 |
| 1c Title bar | 12 (less what C5 converts) | |
| 1d Message box and queue | 35 (input panel 15, queue 7, banners 11, toolbar 2) | no-name icon buttons −2 (wake-up, voice); shortcut text −2 (Stop's "(Esc)" and the send label's "(Enter)") |
| 1e Session list | 29 (list 22, header 2, footer 2, dashboard 3) | shortcut text −2 |
| 1f Header leftovers | up to 16 (C2 and C8 convert most) | shortcut text −1 (the Interrupt button, if C2 has not already deleted it) |
| 1g Loop switch, setup, past runs | about 6 | |
| 1h Plan queue | 5 | about 24 controls gain tooltips or reasons |

### 1a. The Settings menu when squeezed to icons (XS-S)

**For James:** when the Settings menu is squeezed down to just icons, pointing at (or tabbing to) an icon shows its name in Harness's
own tooltip, to the right of the icon. It also says the status that the squeezed menu hides, for example "Provider Quota, Exhausted".
When the menu is wide you see no extra bubble.

**Needs first:** Phase 0 step 5; Phase 3's C11 (it rewrites this menu block, so carry the bindings across); part 1's step 5d for the collapse
toggle.

**Verified (10 Oct):**
- **Today these are native titles.** `features/settings/settings.component.html:88-89` and `:109-110` are `[title]="item.label"` plus
  `[attr.aria-label]="item.label"`. The collapse toggle at `:28-45` also uses `[title]` (the same text as its `aria-label`). Native
  count in the file: 3; `appTooltip`: 0.
- **Why a plain swap breaks.** Collapsed, the label, badge and "Recommended" text are hidden with `display: none`
  (`settings.component.nav.scss:288-293`). The directive compares the tooltip with `textContent` (`aio-tooltip.directive.ts:273`),
  which still contains the hidden label, so the hint is dropped as "redundant" exactly when it is needed. Phase 0 step 5's `visibleTextOf`
  fixes that for badge-less items.
- **A refinement to Phase 3's C11 plan**, which binds `[appTooltip]="page.label"` and says the redundancy check suppresses it while the
  label is visible. That holds only for buttons whose visible text is the label alone. The badge and "Recommended" spans sit inside the same
  button (`settings.component.html:94-96`, `:115-117`), so `visibleTextOf` returns "Provider Quota Exhausted", which is not equal to
  "Provider Quota" (the policy is strict equality), and in the wide menu those items would show a hint that merely repeats the label.
  Fix: bind the tooltip only while the menu is icon-only.
- **The collapsed state has one definition:** `settings.component.html:24`, `[class.nav-collapsed]="effectiveNavCollapsed() &&
  !(compactViewport() && compactNavOpen())"`; `effectiveNavCollapsed` is `settings.component.ts:192-193` (a compact window is always
  icon-only). Reuse that expression for the tooltip so the class and the tooltip cannot disagree.
- The badge text is words or a percentage (`settings.component.ts:271-285`: `'Exhausted'`, `` `${percent}%` ``), so appending it to the name
  reads sensibly.
- **No room in the component file.** `settings.component.ts` is 699 lines with no allowlist entry (1 line of room) and does not import the
  tooltip directive. The six private storage helpers `readStoredTab`, `persistTab`, `readHelpCollapsed`, `readNavCollapsed`,
  `persistHelpCollapsed` and `persistNavCollapsed` are at `:651-698` and use `LAST_TAB_KEY`, `HELP_COLLAPSED_KEY` and
  `NAV_COLLAPSED_KEY` (imported at `:79-86`). `settings.component.spec.ts:327-370` tests the persisted collapsed state, so those helpers
  keep their behaviour.
- `settings-navigation.ts` is dirty (a label change by another session). This part does not touch it; the new tooltips read its labels, so
  they pick the change up.

**Change:**
0. **Make room first, only if needed.** If `settings.component.ts` is at or above 698 lines when this starts (it will be if C11 has not
   landed; C11's step is net −20), move the six storage helpers into a new `features/settings/settings-local-state.ts` as plain functions
   (`readStoredTab()`, `persistTab(tab)`, `readFlag(key)`, `persistFlag(key, value)`; every one keeps its `try/catch`). That frees about 35
   lines. Behaviour identical; the existing spec is the check.
1. New pure `features/settings/settings-nav-label.ts` (about 25 lines): `navItemLabel(label: string, badgeText: string | null,
   recommended: boolean): string`. It returns `label`, or `label + ', ' + badgeText`, or `label + ', Recommended'` (a badge wins over
   "Recommended", as in the template's `@if … @else if`).
2. `settings.component.ts`: `readonly railIconsOnly = computed(() => this.effectiveNavCollapsed() && !(this.compactViewport() &&
   this.compactNavOpen()))`, also used in the template at `:24`; `navLabel(item)` calls `navItemLabel(item.label,
   this.navBadges()[item.id]?.text ?? null, !!item.recommended)`; add `AioTooltipDirective` to the imports (+2 lines).
3. `settings.component.html`, both nav buttons (`:82-98` and `:103-119`, or C11's page buttons): delete `[title]`; set
   `[attr.aria-label]="navLabel(item)"` (so the status is spoken in every state, which the hidden badge never was); add
   `[appTooltip]="railIconsOnly() ? navLabel(item) : null" appTooltipPosition="after"`. The tooltip equals the name, so 5b leaves no
   duplicate description. After C11 the buttons are page buttons: the same bindings with the page's label and its most severe badge.
4. Collapse toggle (`:28-45`): replace `[title]` with `[appTooltip]` using the same expression, and add `appTooltipShowWhenExpanded`
   (part 1's 5d), because the toggle carries `aria-expanded` and would otherwise lose its hint while the menu is open.

**Tests:**
- `settings-nav-label.spec.ts` (new): plain label; label with badge; label with "Recommended"; badge beats "Recommended".
- `settings.component.spec.ts` (add): with the menu collapsed, every nav button has no `title` attribute, an `aria-label` equal to
  `navItemLabel(...)`, and its directive's `appTooltip()` equals that label (read via `By.directive(AioTooltipDirective)` and
  `.injector.get(...)`; this avoids depending on component stylesheets being applied in jsdom). With the menu expanded the directive
  input is `null`. In a compact window with the overlay open the input is `null` (labels are visible). The toggle's directive keeps its
  hint while `aria-expanded="true"`. The "no title" and "collapsed input is set" cases **fail on today's code**.
- `settings-local-state.spec.ts` (only if step 0 runs): each helper survives a throwing `localStorage`.

**Risks:**
- **No visible status dot in the squeezed menu.** The badge is still `display: none` when collapsed, so the status is only in the hover and
  the spoken name. That is better than before (nobody got it), but house rule 4 would prefer a visible dot. Left to C11's visual pass (corrected 11 Oct: C11 adds no dot; the October follow-ups plan, part 8d, item 6).
- **C11 collision.** Both rewrite the nav block of `settings.component.html` and edit `settings.component.ts`. Whichever lands second carries
  the bindings across. Recommended: C11 first, then this.
- `appTooltipPosition="after"` places the hint to the right of the icon; the directive's own fallback is the left side
  (`aio-tooltip.directive.ts:78-81`), and `withPush(true)` keeps it on screen.

**Done when:** `command grep -nE '(\[title\]|[^a-zA-Z-]title=)' settings.component.html` prints nothing; collapsed, hovering or tabbing to each
icon shows its name (and status when it has one) to the right; expanded, no hint on any item, including badged ones;
`settings.component.ts` is under 700 lines with `npm run check:ts-max-loc` green.

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1b. The left icon bar (S)

**For James:** pointing at an icon in the left bar shows a proper tooltip, with the real shortcut (Ctrl+H for History on Windows, and
following any change you make in Settings). The hint stays visible while the Tools or Side chat panel is open.

**Needs first:** Phase 3's C10 (it deletes Plugins) and C4 (its part 6d adds the "Needs you" button), both in this file; part 1's step 5 (all of it). This is
the first user of the shortcut chip and show-when-expanded, so part 1's step 5c live checks run here. (The icon button's first user is part 1's step 7c.)

**Verified (10 Oct):**
- `features/dashboard/workspace-rail.component.ts` is 263 lines (room 437): eight controls, all icon-only on native titles: Search,
  Automations, Browser, Plugins (links) and Tools & Views, Sidechats, History, Settings (buttons). Native titles: 8; `appTooltip`: 0.
- The shortcut glyphs are in three strings: `:106` "Sidechats (⌥⌘S). Right-click for sidechat activity.", `:125` "Session history (⌘H)",
  `:137` "Settings (⌘,)".
- The two toggles use `aria-expanded` for "the panel is open" (`:87`, `:101`), so they need `appTooltipShowWhenExpanded` or the hint goes
  quiet while the panel is open. The Sidechats button also supports Shift+F10 and the menu key for its activity menu (the handlers just above
  its title), while its title mentions only right-click.

**Change:**
1. Use `appTooltip` plus the existing `aria-label` where the tooltip adds meaning (for example "Scheduled and recurring agent runs"), and
   `[appIconButton]` where name and tooltip are the same words.
2. `appTooltipShortcut` for `toggle-side-chat`, `toggle-history` and `toggle-settings`; `appTooltipPosition="after"` on all;
   `appTooltipShowWhenExpanded` on Tools & Views and Sidechats.
3. Strip the glyph text out of the three strings (`:106`, `:125`, `:137`). Keep the right-click sentence, and make it name Shift+F10 too.

**Tests:** extend the existing `workspace-rail.component.spec.ts` (155 lines; it covers the automations badge and the sidechat activity menu).
Each chip shows the live binding; History shows "Ctrl+H" on a non-Mac platform after a rebind; Tools & Views keeps its hint while open.

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1c. The top bar of the window (S)

**For James:** the chips in the title bar (computer-use, pause, local AI, CLI update, notifications, quota) show Harness's tooltip when you
point at them, including inside the draggable part of the bar.

**Needs first:** Phase 3's C5 (it moves the startup chip and the quota chip to `appTooltip` and deletes the bottom "Sending N" toast).

**Verified (10 Oct):** `app.component.html` has 4 titles (`:16`, `:32`, `:43`, `:66`) and six chip components have 8 more:
`computer-use-permission-chip` 1, `pause-toggle` 1, `local-ai-status-chip` 1, `cli-update-pill` 1, `notification-center` 3,
`provider-quota-chip` 1. Total 12 titles, 0 tooltips. The chip files are small (67 to 245 lines) except
`shared/components/provider-quota-chip/provider-quota-chip.component.ts` (600 lines, room 100). The widgets sit in `no-drag` islands
inside a `-webkit-app-region: drag` bar (`app.component.scss:23`, `:40`), so whether pointer events reach them needs the live check.

**Change:** after C5, convert the leftovers: the remote-terminal title (`:32`), the dismiss button (`:66`), and the chips C5 does not touch.
All are existing computed strings; keep them. `notification-center.component.ts` "Dismiss" and "Clear all notifications" are destructive-ish:
confirm their visible text says what they do.

**Tests:** per the recipe, in each chip's spec (create it if missing).

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1d. The message box and its queue (M)

**For James:** the message box gets a name for screen readers. The wake-up and voice buttons get names, and the voice button says why it is
unavailable. The Send button's spoken name no longer ends in "(Enter)". The queue says in plain text when a message is not saved yet, and the
banner buttons explain themselves on Tab as well as hover.

**Needs first:** Phase 3's C2, C8 and C9 (same files); part 1's step 5; part 1's step 6c (the "steer" tag is already a glossary word).

**Verified (10 Oct):**
- **The message box has no accessible name.** `input-panel.component.html:309-320` is `<textarea … [placeholder]="showGhostText() ? '' :
  placeholder()">` with no `aria-label`, and the placeholder is empty while ghost text shows. The wake-up button (`:353-358`,
  `title="Schedule thread wakeup"`) and the voice button (`:472-478`, `[title]="voiceButtonTitle()"`) have a title and no `aria-label`. Stop
  (`:509-513`) has `title="Stop current turn (Esc)"` and `aria-label="Stop current turn"`. `sendButtonLabel` (`input-panel.component.ts:495-501`)
  ends in "(Enter)" and is both the tooltip and the `aria-label`. `voiceButtonTitle()` (`:764-770`) holds the existing sentences ("Start a
  session before using voice", "Voice is available after the session starts", "Voice is unavailable right now", "Stop voice conversation",
  "Start voice conversation").
- **The queue's "not saved" is a hover-only data-loss warning.** `composer-queue.component.html:39`: the visible chip says "not saved"; the
  consequence ("a renderer crash right now could lose this message") is only in the `title`. In the same file `:22` the truncated message text
  has `[title]="queuedMsg.message"`, `:46` the Edit button has a title and an `aria-label`, and `:58` the Steer button has a title.
- **The banner buttons' hover text carries real consequences** (`composer-banners.component.ts`): `:55` "Move this conversation to the next
  configured fallback provider instead of waiting", `:63` (a different account), `:145` "Grant this path as a writable root and restart the
  session inside the rebuilt sandbox", `:152` "Restart the session in the same sandbox without granting anything new". All are text buttons with the
  explanation only in `title`. The two status bars carry long `[title]` details (`:37` `quotaParkDetail()`, `:78` `authDetail()`) on non-focusable
  `role="status"` elements; `quotaParkDetail()` includes when the session will resume.
- No spec pins the old send or stop strings (a `command grep` over the specs for "(Enter)" and "Stop current turn" found nothing).
- Room: `input-panel.component.ts` has **22 lines** (ceiling 1,910 + 50), shared with Phase 3's C2a (step 8) and A10.2 (+2) and Phase 5's C12A (+1) and C13.6(c) (0);
  this part needs at most +2 (the import and call of `voiceTooltipParts`), and the shorter send label may free a line. `composer-toolbar.component.ts` 58;
  `composer-banners.component.ts` 196; `composer-queue.component.ts` 662.

**Change:**
1. Name the textarea: `aria-label="Message"` (static; the placeholder stays as the hint).
2. Wake-up (`:358`): `[appIconButton]="'Schedule thread wakeup'"`. Voice (`:478`): the name is `Start voice conversation` or `Stop voice
   conversation`; the reason (the existing sentences) is passed as `appIconButtonDisabledReason` only while `!isVoiceActive() && !canUseVoice()`,
   replacing `[disabled]`. Put the decision in a pure `voiceTooltipParts(...)` in the new `features/instance-detail/input-panel-tooltips.ts`
   returning `{ name, disabledReason }`, so the component's line count does not grow. The helper sits beside the component, so the ledger's reader follows it
   one level deep and the voice sentences ("Voice is available after the session starts" and "Stop voice conversation" qualify) stay recorded; pin each
   sentence verbatim in the helper's unit cases.
3. Send and Stop: `sendButtonLabel` loses "(Enter)" (the names become "Send message", "Queue message" and "Start loop");
   `appTooltipShortcut="send-message"`, left empty while the loop is starting. Stop: `appTooltipShortcut="cancel-operation"`, text "Stop current
   turn". The header Interrupt is Phase 3's C2.
4. Queue:
   - Add one visible line under the queue header while any message is not saved: "Not saved yet. If Harness crashes now, the marked message could
     be lost." (`role="status"`). Keep the chip. Move the old title text to `TOOLTIP_COPY` (`composer.queueNotSaved`) so the hover keeps its
     words.
   - The truncated message text (`:22`) becomes `appTooltip` with `appTooltipVariant="overflow"`; the Edit button becomes `[appIconButton]`; the
     Steer button's title becomes `appTooltip`, verbatim.
5. Banners: move the 11 titles to `appTooltip` verbatim; the buttons are focusable, so the hints open on Tab. One needs a visible sentence (house
   rule 2): "Allow path & retry" grants the session write access to the path in the box above it, and the bar's visible text ("Hardened session
   exited — the sandbox may have blocked a write.") says nothing about that. Add "Allowing a path gives this session write access to it." to that
   bar. The other three (`:55`, `:63`, `:152`) explain a visible verb ("Switch provider", "Switch account…", "Just retry"). Two of them move the conversation to another
   provider or account and one restarts the session, so under the warning rule they would need visible text; they stay as hints by a recorded decision
   (choice 2): their label already names the action, and names do not change in a migration. They are focusable, so the hints open on Tab.
   For the two status bars, first check whether the visible label already says when the session resumes. If it does not, show that line as visible
   text. If it does, list the title as a reasoned elaboration. Do not shorten the text.
6. Draft toggles (`:174-200`: YOLO, FAST, Hardened): after C8, migrate whatever title remains to `appTooltip`.
7. Context ring: done by C2. This change only verifies the ring is focusable and opens its tooltip on Tab.

**Tests:**
- `input-panel` spec: "the message box has the name Message"; "wake-up and voice have names"; "the send label has no (Enter)".
- `composer-queue` spec: "a not-saved message shows the visible warning line" (**fails today**).
- `composer-banners` spec: "Allow path & retry shows the write-access sentence"; each button opens its tooltip on Tab.
- `voiceTooltipParts` unit cases for each branch.

**Risks:** `input-panel.component.ts` has 22 lines of room, so new logic goes in `input-panel-tooltips.ts` and edits to the component are
import-only. The voice button now stays focusable while unavailable (part 1's 5d); its hover rules must exclude `[aria-disabled='true']`.

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1e. The session list (M)

**For James:** the session list's filter, sort, options and project buttons get names and hints, a "filters on" state is part of the filter button's
name, and "Show sidebar" and "New session" show their real shortcuts.

**Needs first:** Phase 3's C4 (it rewrites the "All / Active" group at `instance-list.component.html:18-38`) and C9 (the hover card), and Phase 5's C13 if it has
landed (it reworks the sidebar header's two "new" buttons into one "New session" button with a caret menu; take what it leaves). Part 1's step 2b has already added the
directive import.

**Verified (10 Oct):** native titles / `appTooltip`: `instance-list.component.html` **22**/1 (the audit said 20), `sidebar-header.component.ts` 2/0,
`sidebar-footer.component.ts` 2/0, `dashboard.component.html` 3/1. Phase 0 step 3 may already have converted the footer's Close all title. Room:
`instance-list.component.ts` has 4 lines, so everything is template-only.

**Change:**
1. The filter, sort and options buttons (audit lines `:49`, `:70`, `:82`, `:94`) become `appTooltip` or `[appIconButton]`; the project row buttons
   (`:225`, `:237`, `:252`) get names.
2. The "filters active" dot (`:58`) is the visible state, so the toggle's name and tooltip say it too ("Filter and sort, filters on" while a filter is
   active).
3. The hidden-automations explanation (`:144`) becomes visible help text next to the toggle, or a focusable `appTooltip` (the state is not carried only
   there, so a focusable elaboration is enough).
4. The truncated subtitle (`:215`) and thread title use `appTooltipVariant="overflow"`.
5. "Confirm archive" (`:563`) and "Archive thread" (`:590`): check the visible text says what archiving does; if it does not, add the sentence as visible
   text.
6. "Show sidebar (⌘B)" (`dashboard.component.html:74`) and "New session (⌘N)" (`sidebar-header.component.ts:34`) become `appTooltipShortcut`
   (`toggle-sidebar`, `new-instance`).

**Tests:** the list spec created in 2b (if it exists): the surface checks from the recipe, and "the filter button's name includes 'filters on' while a
filter is active". Specs that exist today for these files: `sidebar-footer.component.spec.ts` and `dashboard.component.spec.ts`; create the others.

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1f. The session header's leftovers (S-M)

**For James:** whatever hover hints the header redesign leaves behind become proper tooltips, and a session's wait reason shows as text, not only on
hover.

**Needs first:** Phase 3's C2 and C8 (and Phase 0 step 8, which adds the cost item with its own tooltip).

**Verified (10 Oct):**
- `instance-header.component.html` has 16 native titles and 1 tooltip today. C2 turns the header into one row plus a "Session options" menu, deletes the
  header Interrupt button, makes the context ring a real button with `appTooltip`, and replaces the titles it keeps (the audit lists
  `instance-header.component.html:21,36,45,53,124,149,154,170,181,197,209,227,249,262,268`). C8 relabels YOLO as "Auto-approve" with its consequence
  sentence in visible text and uses the sentence as an `appTooltip` elaboration.
- So this part's job is: run the list after those landed, convert the leftovers, and confirm nothing is hover-only.
- The wait reason (`:36`) must not stay hover-only: render the reason as visible text when the session is waiting (`waitReasonDetail()` exists). The session
  name (`:21`) is a truncated title.
- `instance-header.component.ts` has 6 lines of room until C2 shrinks it; the edits here are template-only.

**Change:** the recipe on whatever the counter lists for `instance-header.component.html`, plus the wait reason as visible text. If neither C2 nor C8 has
landed, use the line list above.

**Tests:** per the recipe; "a waiting session shows its reason as text".

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1g. The Loop switch, the setup panel and past runs (S)

**For James:** the Loop switch can be reached with the keyboard even when it is greyed out, and Tab shows "Pick a working folder to enable Loop Mode". The
setup panel's close button and its "require rename" box say what they do, and past runs have proper hints.

**Needs first:** Phase 2's step 15 (B9, the loop screen); part 1's step 7a (room in the setup panel; skipped if Phase 2's part 9e already moved the constants)
and step 5d; Phase 0 steps 2.6a (the new "Close" button on stranded runs, with its own tooltip) and 2.6c (the recycle hint) have already touched these files.

**Verified (10 Oct):**
- **The Loop switch.** `features/loop/loop-toggle.component.ts:14` has `[title]="title()"` on the wrapping `<label>`; the lasting reason "Pick a working
  folder to enable Loop Mode" exists only there (`:130`); the checkbox inside is `[disabled]="!canInteract()"` (`:21-22`), so keyboard users never reach it.
  A disabled-reason host has to be the **input**, not the label (part 1's 5d).
- **The setup panel.** `loop-config-panel.component.html:7` has a close × with `aria-label="Close"` only; `:343` the "require rename" checkbox is disabled by
  `planFileRequiresRename()` with no reason. The component already imports the tooltip directive (use plain `appTooltip`, not a new directive).
- **Past runs.** `loop-past-runs-panel.component.ts` has 4 titles and 1 tooltip. The Reattempt button already carries the pattern:
  `[disabled]="reattemptDisabledReason(run) !== null"` with the reason in its `[title]` (`:147-148`; the method is at `:418`), so keyboard users cannot reach the
  reason. The other titles are the absolute time on a relative-time label (`:114`), the full-prompt toggle (`:134`) and the copy button (`:141`).
  `rlm-storage-maintenance.component.ts:51` has a close × with an `aria-label` and no hint.
- The stale "50KB" recycle hint at `loop-config-panel.component.html:361` is already fixed by Phase 0 step 2.6c. Do not touch it here.

**Change:**
1. Loop switch: the label gets no hint of its own (delete its `[title]="title()"`). A tooltip host inside another host breaks rule H3, and part 1's step 5d
   puts the reason host on the checkbox inside the label. The label's sentence goes on two siblings instead, so nothing is nested: `[appTooltip]="title()"`
   on the word (`.lt-label`), so hovering "Loop" still shows the same sentence as before, and the same `[appTooltip]="title()"` on the checkbox together with
   `[appTooltipDisabledReason]="noFolderReason()"`, where `noFolderReason` is `computed(() => this.workspaceCwd() ? null : 'Pick a working folder to enable
   Loop Mode')` and replaces `[disabled]="!canInteract()"`. The reason wins while it is active, so the switch stays focusable and Tab shows the reason.
   `onChange` is never reached while the reason is active, because the click is cancelled. The word is a hover-only host (not focusable), so it gets a
   reasoned entry in `hover-only-reasons.ts` ("the focusable switch beside it carries the same sentence"). No extra visible line: a focusable host meets house
   rule 4. The `.loop-toggle:hover:not(.disabled)` and `.loop-toggle.disabled` rules (`:45-52`) already key off `canInteract()` through `[class.disabled]`
   (`:11`), so no hover rule needs changing here.
2. Setup panel: the close × gets `appTooltip="Close"`; "require rename" gets `appTooltipDisabledReason` fed by a `requireRenameDisabledReason` computed built in a
   new `features/loop/loop-config-tooltips.ts` (about 30 lines).
3. Past runs: Reattempt becomes `appTooltipDisabledReason` fed by `reattemptDisabledReason(run)` (with `appTooltip` "Open the loop config pre-filled with this
   prompt"), replacing `[disabled]`. The relative-time label's absolute time is an elaboration of visible text: a focusable `appTooltip` or a listed reason. Convert the
   other two titles by the recipe. `rlm-storage-maintenance` close ×: add the hint. (The existing tooltip at `:156` still says "AIO"; Phase 3's wording pass (C7) owns that
   change, not this one.)

**Tests:** create `features/loop/loop-toggle.component.spec.ts` (none exists; the component is 154 lines): "a loop toggle with no folder is aria-disabled,
focusable, and shows the reason" (**fails today**). Extend `loop-config-panel.component.spec.ts` and `loop-past-runs-panel.component.spec.ts` (both exist) with
the surface checks from the recipe. Add "the loop toggle's template has no tooltip host inside another host" (the counter's H3 stays 0).

**Risks:** the switch is a checkbox inside a label that now has no hint. Hovering the label's padding (the few pixels around the word and the switch) shows
nothing; hovering the word or the switch shows the sentence. That is the intended result, and it keeps nested hosts at zero (H3).

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

### 1h. The plan queue (S-M)

**For James:** the plan queue's buttons say what they do. Pause says it stops new work from starting and pauses work already running until you resume,
and the Start and Submit buttons say why they are
greyed out.

**Needs first:** Phase 2's step 5 (the Plan Queue page, backlog B9), which itself needs Phase 2's step 4 (parts 4d and 4f). Step 5 rewrites these controls and the
item list ("Skip asks first", a status word, "Round N of M").

**Verified (10 Oct):**
- 11 plan-queue templates under `features/plan-queue/` have 0 `appTooltip` and 5 titles (item list 1, parked list 1, question list 2, run list 1), across about 24
  controls.
- **What Pause really does (corrected 23 Oct 2026 — the 10 Oct analysis first written here was wrong).** `PlanQueueRunControl.control('pause')`
  (`src/main/plan-queue/plan-queue-run-control.ts:28-31`) sets the run paused and calls `holdRun`, which holds **every** item
  (`plan-queue-coordinator.ts:426-429`). `holdItem` (`plan-queue-run-hold.ts:30-42`) stops each working item's worker and verifier
  sessions (`stopInstance` → `terminateInstance`, `plan-queue-item-flow.ts:680-688`), checkpoints its final edits and
  requeues it (`state: 'queued'`); Resume picks that work back up from the same branch. So the true copy: Pause stops anything
  new from starting AND pauses work already running — that work is saved and carries on when the run resumes. Cancel already
  confirms inline (`plan-queue-run-controls.component.html:2-7`); the parked-item actions confirm too
  (`plan-queue-parked-list.component.html:15-30`).

**Change:** a registry section `planQueue.*` in the new `tooltip-copy-plan-queue.ts`:
- Pause: "Stops anything new from starting and pauses work already running. Paused work is saved and carries on when you resume."
- Resume: "Lets new documents and checks start again."
- Cancel (already confirms inline); parked-item Resume, Land anyway and Discard (confirms exist); Skip; Refresh.
- Start run and Submit: lasting disabled reasons from `!canStart()` and `!selectedOptionId()` through `appTooltipDisabledReason`: "Choose a parent session first." and
  "Pick an answer first."
- The run-list and question-list titles become `appTooltip`.
- Wording for Skip, Land anyway and Discard is written together with Phase 2's pass.

**Tests:** `plan-queue-run-controls` spec: "Pause says it stops new work and pauses running work until resume" plus its Tab-focus case; the runtime
behaviour the sentence describes is pinned in `plan-queue-run-hold.spec.ts` ("what the Pause hint promises" — a held working item has its
session stopped, its work checkpointed and is requeued); "Start run shows its reason while it cannot start".

**Live checks:** moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md).

---

## Final verification

When each part is finished, run its targeted specs and `npx tsc --noEmit`. When the whole plan is done, run the canonical gates and record their current output in
the as-built notes:

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
npm run check:ui-hints     # the guard and the wording ledger
```

This part adds no IPC channel, so `npm run verify:ipc` and `npm run verify:ipc-usage` are not needed. Run both if a channel is added after all.
`npm run audit:ui-hints` prints the honest counts; paste its summary into the as-built notes after each tier (tier A is 1a to 1f, tier B is 1g and 1h).

**Fresh-eyes completion gate.** Before calling this plan complete:
1. A fresh agent that did no implementation work runs the `task-completion-gate` skill over this plan's changes, this plan and the backlog items.
2. Fix every actionable finding, rerun the checks, and send the work to another fresh review.
3. Repeat until it returns `VERDICT: PASS`.

Because the migration is rolling and a lost warning is its main risk, also run the gate at the end of each tier here (A, then B) and brief that reviewer to compare the
saved old hover wording (`git show HEAD:<path>`) with the new. Brief every reviewer on James's rules: no branches or worktrees, no browser on the Mac, preserve
other sessions' uncommitted work, and no secrets.

## Live checks

These need the rebuilt app, a person, or the Windows PC. Live checks moved to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md) (each part's checks, plus part 1's two deferred checks: the shortcut chip on 1b and the greyed-out-button reasons on 1d and 1g). Screen checks run on the Windows PC, or on the Mac only with James's OK.

## Not in this plan (and where it goes)

- **The conversation tools, side chat, source control, settings, the shared pieces, everything else folder by folder, and the lint switch-ons** are part 3.
- **A visible status dot on the squeezed Settings menu** (the badge stays hidden when collapsed): goes with Phase 3's Settings visual pass (corrected 11 Oct: Phase 3 steps 10a to 10d give a page badge but no dot in the icon-only state, so the October follow-ups plan, part 8d, item 6). Recommended, later.
- **Plan-queue Skip, Land anyway and Discard wording:** written with Phase 2's plan-queue pass.
- **Hover styles for `aria-disabled` controls in each adopter's own stylesheet:** done per adoption in the migration parts (here and in part 3), not globally.
- **A confirm when enabling auto-approve:** Phase 3's C8 (corrected 11 Oct: Phase 3 step 3, C8, has no confirm, and neither has the backlog's C8; the October follow-ups plan, part 7i, holds the question, recommended: do not build).
- Pieces this plan leaves to nobody are collected in the October follow-ups plan (`2026-10-11-oct-followups_plan.md`), with a one-line list for the small or conditional ones.

## Found on the way (not fixed here)

1. **Phase 0 step 2.6c's new recycle hint states "about 1,200 characters".** The real cap is a main-process constant (`loop-recycle-handoff.ts:18-23`) the renderer cannot read, so the
    hint can go stale again (the tooltip copy rule says to state no number the code can change). Not changed here; if James prefers a hint without a number, it is a one-line follow-up (the October follow-ups plan, part 8d, item 8).

## Corrections to the backlog

- **D5 Tier A "Session header" and "Context ring":** already specified by Phase 3 (C8 for the YOLO sentence, C2 for the ring and the one-row header). D5 only verifies and sweeps the leftovers.
  **"Session list: 20 titles":** 22 by `command grep` on 10 Oct, plus one dead tooltip. "Title bar" and "Left rail" counts are confirmed (12 and 0; 8 and 0). "32 of 138 controls" was not recounted;
  the plan queue's "0 of 24" is confirmed as 0 tooltips in all 11 templates.
- **D5's stale loop hint (a report's item):** the "50KB" recycle hint at `loop-config-panel.component.html:361` is already fixed by Phase 0 step 2.6c; this plan does not redo it.
- **D1 follow-up "migrate the collapsed Settings rail":** Phase 3's C11 rewrites that block. The tooltip must be bound only while the menu is icon-only (choice 1).

## Finishing

1. Every part (1a to 1h) is implemented, every gate passes, and the fresh-eyes gate returns PASS (also at the end of each tier). This part closes on its own once
   its eight parts are done; it does not wait for part 3. A part skipped because its Phase 2 or Phase 3 item had not landed is done before this plan closes; if that
   item is still late, move the part to part 3's list with a note (never add scope to this file after it is `_completed`).
2. Create the livetest doc `docs/plans/2026-10-10-oct-phase4b-tooltips-migration_livetest.md` and move the live checks into it, including part 1's two deferred checks.
3. Update this plan's status line and as-built notes. Rename this plan `2026-10-10-oct-phase4b-tooltips-migration_plan_completed.md` **last**.
4. In `claude_oct-todo.md`, mark D5's tiers A and B done and link to the completed plan. D5 as a whole and D10 stay open until part 3.
5. Commit only when James asks. Stage only this plan's code and the `_completed` plan (the livetest doc stays untracked until it is renamed `_livetest_completed`, because the commit hook refuses an open one); never other sessions' work. Before every commit, inspect the
   staged paths and unstage any plan or spec that is not `_completed` (part 3 stays untracked until it finishes).

## As-built notes

### Current base acceptance and worker handoff (30 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-da593f`)

**Current state, independently re-executed worker checks.** Starting HEAD and `main` both resolve to `0389bf165a05d751ef6e735e82aeb43bb9b50779`; the worktree starts clean. This base already contains all eight migrations and the later Phase 4c cleanup, so no further product-source, test, dependency or generated edit is needed. The old missing-foundation, merge-conflict and earlier-checkout statuses are historical. No separate linked spec exists. The original root plan is the only planning file edited; the tracked worktree copy stays untouched. Root plan/livetest were already tracked and modified on arrival; neither is staged, renamed or copied.

**All eight parts checked against current source and tests:**

- [x] 1a Settings: icon-only names/status, expanded-menu and compact-overlay suppression, label precedence and expanded-toggle focus.
- [x] 1b Rail: imported directives, names, live shortcuts/rebinding, right-side positioning and expanded-panel focus hints, retaining newer destinations and the terminal drawer.
- [x] 1c Shell and all six chip owners: tooltip wiring and focused regressions pass; native drag-region behavior remains live.
- [x] 1d Composer and queue: Message/voice names, lasting disabled reasons and guards, Send/Stop shortcuts, visible crash-loss and write-access consequences, and real persistence acknowledgement clearing the warning.
- [x] 1e List: filters-on name, archive consequence, sidebar shortcuts and restricted-action reasons. The automation explanation is now visible text in this later base rather than a hover-only clock.
- [x] 1f Header: visible wait detail, overflow explanation, provider-specific Interrupt words with the live shortcut, and locked-control reasons.
- [x] 1g Loop: focusable no-folder reason, running-loop Stop, inert decorative track/thumb, required-rename explanation, visible recipe descriptions and Copy/Reattempt restrictions. The current expanded Show/Hide binding is retained; shared directive expanded-state tests pass, without claiming a dedicated current adopter regression that is absent from this base.
- [x] 1h Plan queue: Start/Submit focusable reasons and guards, keyboard-reachable document paths, corrected Pause sentence and stop/checkpoint/requeue runtime regression.

**Fresh commands:** cache-disabled focused tests under pinned Node v24.22.1 pass, **173 files / 2,070 tests, zero failed or pending**, JSON `success: true`. Both type checks, lint, size guard, tooltip guard, audit JSON, both production builds, alias/IPC/architecture generators and architecture `--check` all exit 0; generators leave no diff. Main uses `npm --ignore-scripts run build:main`: the entire declared compile/asset-sync/preload build runs, skipping only the unrelated installed-Codex protocol-refresh prehook. Renderer retains its existing initial-bundle warning (1.64 MB versus 1 MB). `check:ui-hints -- --tighten --record-wording` and comparison against the starting base pass without changing records: strict-rule findings **zero repo-wide**, H11 **8**, **224** advisory reports, **14** markers, **244** wording entries (**8** retired). This run's record drop is zero because the implementation is already in the base. No record was raised or sentence retired. `git diff --check` passes; tracked worktree diff remains empty.

**Runtime traces:** durability acknowledgement publishes a new queue array while retaining entry identity in `queue-persistence.service.ts`, through `instance-messaging.store.ts:160` / `instance.store.ts:789` / `instance-detail.component.ts:481` / its template `:323` / `input-panel.component.html:607`, to `ComposerQueueComponent.hasUnsavedMessages:38` and the visible line. The rendered persistence regression passes. Pause routes through `plan-queue-run-control.ts`, coordinator `holdRun:476`, item-flow `holdItem` wiring `:218` and session termination `:744`, then stop-before-checkpoint/requeue in `plan-queue-run-hold.ts`; its focused runtime regression passes.

**Review and limits:** the worker's fresh source/diff review finds no actionable gap; the screen-and-wording check on worker changes is All clear. There are no new test/config/dependency/suppression edits. Two genuinely fresh review attempts did not produce a verdict: the first provider returned its spending-limit error before review, and the second source-only MCP review timed out after 300 seconds without a report. These are not permission denials or passing review evidence. The full suite was deliberately not run, per the worker brief. Final independent tier/whole-plan PASS remains open for the queue verifier. Real Electron/native Tab, hover timing, drag-region and spoken screen-reader checks remain in the existing root livetest, including the macOS-only authority requirement; no browser/desktop run, worker-health claim or new deferral is made here.

**Evidence and cleanup:** `_scratch/phase4b-da593f-20261030/` in this assigned worktree contains `report.md`, exact command receipts/logs, focused selection, test/audit summaries, source hashes, review-attempt record, cleanup receipt and SHA256 seal. The original test output/JSON paths are recorded in the report. No commit, stash, staging, branch/worktree operation, dependency installation, source/dependency copy, app/database/settings write, browser binary or service was created. Task-created `dist/` is removed after report/seal creation; pre-existing dependencies and shared cache symlinks are preserved. The shell process-list command was denied (`Operation not permitted`), so no process-status assertion is inferred from it; all worker verification commands returned completion results. No final verdict is inferred for the timed-out MCP review's internal execution.

- [x] Eight implementations present and current worker focused/static/build/generator checks pass.
- [x] Root plan updated at its original path; active name retained; report/receipts/seal and runtime cleanup recorded.
- [ ] Full suite and final independent tier/whole-plan verdict: queue verifier.
- [ ] Live application checks: existing root livetest remains open.
- [ ] Document closure/rename, permitted backlog closure, checkpoint/integration: coordinator.

### Queue dependency preflight (12 Oct 2026)

- Assigned checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase4b-tooltip-0b85c5`, branch `queue/2026-10-10-oct-phase4b-tooltip-0b85c5`, HEAD `4d175e55b`. It started clean. This plan was read and updated only at its original root-checkout absolute path; there is no separate linked spec. The source is the approved backlog and this plan.
- Investigated the actual dependency rather than treating an old status as an approval requirement. Part 1's current execution record identifies checkpoint `165417296` and a parked queue item, `queue/2026-10-10-oct-phase4-tooltips-1b2e67`, with reason `land-blocked`. `git merge-base --is-ancestor 165417296 HEAD` exited 1 in this checkout: the prerequisite is not integrated here. The root checkout is also at `4d175e55b` and lacks the required directive APIs.
- Read the current tooltip directive and package manifest. The supplied checkout has no `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `visibleTextOf`, icon-button directive, hover-only reason register, or `scripts/ui-hints` tooling. The plan requires part 1's counter, ratchet and wording ledger before every migration; parts 1a/1b/1d/1g/1h additionally consume its runtime APIs. This is a real missing implementation dependency, not a missing consent decision.
- Executable preflight: `rtk npm run audit:ui-hints -- --list H2a` exited 1, `Missing script: "audit:ui-hints"`; `rtk npm run check:ui-hints` exited 1, `Missing script: "check:ui-hints"`. These are failed checks, not passing evidence. npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_00_15_938Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_00_15_947Z-debug-0.log`.
- Ruling: keep all eight migrations open and preserve their order. Do not recreate the foundation in this worker, import parked work manually, or move every migration into part 3. The current AIO-managed worktree rule assigns harvest/integration to AIO; duplicating the separately implemented foundation would create divergent runtime APIs and ledger records. Required next action: the coordinator resolves the foundation's land blocker, integrates it through AIO, supplies a migration checkout containing it, and retries this plan. Recheck earlier-phase template overlaps at that time.
- Safe partial work completed: full migration-plan read, dependency-plan execution-record inspection, manifest/directive inspection, branch/ancestry checks and the two executable tooling preflights. No code, tests, generated files, baselines or backlog completion states changed. No commits, stashes, branches, worktrees, browser sessions or app/database writes were made. Type checks, lint, builds, targeted migration tests and independent completion review were not run: no migration was implemented. The full suite remains assigned to the verifier under the worker brief.
- This is not a live-test deferral. Missing agent-runnable implementation/tooling must land before testing; no `_livetest.md` was created to disguise that dependency as a rebuilt-app or human check. The original live-check requirements and every unchecked acceptance item below remain open. This plan stays untracked and retains its active filename.

### Verification round 1 remediation preflight (12 Oct 2026)

- **Finding 1 remains unresolved.** Reproduced the verifier's evidence: both `HEAD` and `main` resolve to `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`; `git diff --stat main...HEAD` is empty; the migration worktree starts clean. There is no previously committed migration to resume. This worker makes no implementation-completion or verifier-readiness claim.
- **Dependency rechecked against actual repository contents.** `git merge-base --is-ancestor 165417296 HEAD` again exits 1. Reading checkpoint `165417296` with `git show --stat` and `git ls-tree` confirms it contains the missing `scripts/ui-hints/` counter, baseline, wording ledger and reason register, plus `icon-button.directive.ts` and `tooltip-visible-text.ts`. These exist in the parked foundation checkpoint, not the assigned migration checkout. The foundation plan currently reports readiness for independent re-verification, with its parked `land-blocked` record still present; that report does not establish integration here.
- Read the migration plan in sequential sections and the current directive in full. A targeted search of `src/renderer/app/shared/tooltip/` finds none of `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `appIconButton` or `visibleTextOf` (exit 1, no matches). The current directive still derives its visible label from `textContent` and suppresses expanded controls unconditionally. Binding the planned new inputs against this implementation would not implement the required runtime behavior.
- **Required tooling preflight still fails:** `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1 with `Missing script`. Current npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_03_22_589Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_03_22_877Z-debug-0.log`. Every migration requires this counter and guard, including the surfaces that need no new directive API, so none can meet the specified recipe in this checkout.
- **Safe partial verification now run:** the existing `aio-tooltip.directive.spec.ts`, `tooltip-policy.spec.ts` and `icon-control-tooltip.spec.ts` pass, 3 files / 52 tests, exit 0. `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec` and `rtk npm run lint` each exit 0. Retained worktree logs: `_scratch/phase4b-round1/{tooltip-tests,typecheck,typecheck-spec,lint}.log`; full test-run log `_scratch/test-run.pid-85797.log`. These verify the unchanged base only; they are not evidence of migration acceptance. The full suite was not run, as required by the queue worker brief.
- **Coordinator action required before another worker or verifier attempt:** resolve and integrate the foundation through AIO, then refresh the supplied migration checkout so the foundation is an ancestor and both UI-hint scripts and directive APIs are present. Do not send this unchanged branch straight back for completion verification. Importing or merging the parked checkpoint manually would violate the AIO-managed-worktree rule; recreating its 125-file foundation here would duplicate a separate queue item and is outside this migration plan.
- Only this original root-checkout plan is updated. No code, tests, generated output, baselines or backlog completion states are changed; no commits, stashes, branches, worktrees or browser/app actions are taken. The plan remains untracked under its active filename. No live-test document or fresh completion-gate PASS is claimed: all eight implementations and their acceptance checks remain open.

### Verification round 2 remediation preflight (12 Oct 2026)

- **Finding 1 remains unresolved; 0 of 8 parts implemented.** Fresh `git rev-parse HEAD main` resolves both to `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`. `git diff --stat main...HEAD` is empty and the assigned worktree is clean. The resume message's claim of earlier committed migration work does not match the supplied Git state.
- **Required dependency is still absent.** `git merge-base --is-ancestor 165417296 HEAD` exits 1. Part 1's current root-checkout execution notes identify that checkpoint and still carry the parked `land-blocked` queue record. Its round-2 handoff is readiness for independent verification, not evidence of landing. `git show --stat 165417296` confirms the separate foundation spans 125 files, including the directive APIs, icon-button building block, counter, ratchet, reason register and wording ledger. The supplied directive was read in full and still lacks the planned inputs; a targeted search for `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `appIconButton` and `visibleTextOf` returns no matches.
- **Executable preflight fails unchanged:** `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1 with `Missing script`. npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_06_38_938Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_06_39_175Z-debug-0.log`. This blocks the required source worklist and records for all eight parts, in addition to the runtime dependency for the new bindings. No missing permission or missing linked spec is inferred.
- **Safe partial checks rerun:** the existing tooltip directive, policy and icon-control specs pass (3 files, 52 tests, exit 0). `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec` and `rtk npm run lint` each exit 0. Full retained logs: `_scratch/phase4b-round2/{tooltip-tests,typecheck,typecheck-spec,lint}.log`; test runner's full log: `_scratch/test-run.pid-92076.log`. These results validate the unchanged base only. No full suite was run, per the queue worker instruction.
- **Required coordinator action:** resolve the foundation item's land blocker, verify and integrate it through AIO, then refresh this migration checkout through AIO so the foundation is an ancestor and both scripts and directive APIs are present. Only then resume implementation of 1a–1h. Do not interpret this worker's turn ending as a ready-for-verification handoff or send the unchanged branch for another completion-verifier round. The explicit AIO-managed-worktree instructions prohibit this worker from manually merging, promoting or bypassing lifecycle metadata; duplicating the separately owned foundation would expand this migration into another queue item's implementation.
- Only this original root-checkout plan is updated; it retains its active filename and untracked state. No code, tests, generated files, baseline records, backlog completion flags, commits, stashes, branches, worktrees, browser sessions or app/database writes are changed. All acceptance items below stay open. No `_livetest.md` is created because an absent agent-runnable prerequisite is not eligible for live-test deferral. No independent PASS or migration completion is claimed.

### Verification round 3: exact coordinator blocker (12 Oct 2026)

- **Finding 1 remains unresolved; 0 of 8 parts implemented.** Read the entire migration plan at its root-checkout absolute path and checked the supplied Git state. `rtk git rev-parse HEAD main` resolves both to `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`; `rtk git diff main...HEAD --stat` is empty and the worktree is clean. There is no committed migration to resume.
- **New evidence from the running coordinator, rather than relying on old dependency notes:** the read-only `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` reports foundation item `a6a27c49-0df2-45f1-b81e-83eb621b2e67` as `parked`, round 2, verdict `PASS`, no findings, reason `land-blocked`, with exact detail `root checkout has uncommitted changes to a promoted path: package.json`. This establishes that independent verification has passed; the remaining prerequisite failure is landing, not a pending verification decision. `rtk git -C /Users/suas/work/orchestrat0r/ai-orchestrator status --short -- package.json docs/plans/2026-10-10-oct-phase4b-tooltips-migration_plan.md` independently confirms ` M package.json` and `??` for this plan. The root changes belong to other work and were preserved.
- **The prerequisite still has not reached this checkout:** `rtk git merge-base --is-ancestor 165417296 HEAD` exits 1. The current tooltip directive was read in full; the search for `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `appIconButton` and `visibleTextOf` in its directory exits 1 with no matches. Reading the manifest confirms the tooling scripts are absent. `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1 with `Missing script`; npm logs are `/Users/suas/.npm/_logs/2026-10-12T05_09_52_199Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_09_52_431Z-debug-0.log`.
- **Recovery capability investigated:** the actual `plan_queue_control` schema restricts control to the session that started the run. Its rescue exception applies only to non-queue-spawned sessions when the parent no longer exists. This queue-spawned migration worker has no applicable control route. No control mutation was attempted. The current AIO-managed-worktree instructions also prohibit manually merging or promoting the parked branch. Copying that separate implementation into this worktree would bypass the same lifecycle and would not reconcile the root collision.
- **Required next action:** the parent session reconciles its existing root `package.json` changes without discarding other work, resumes the already-PASS foundation through AIO, and has AIO refresh this migration checkout after landing. Recheck `165417296` ancestry (or the corresponding AIO squash contents) and the presence of both hint scripts and directive APIs before starting 1a–1h. Keep this migration out of further completion-verifier rounds until the prerequisite is present; another verifier cannot repair a landing collision.
- **Requested safe checks rerun, all exit 0:** existing tooltip directive, policy and icon-control specs: 3 files / 52 tests; `rtk npx tsc --noEmit`; `rtk npm run typecheck:spec`; `rtk npm run lint`. Retained logs: `_scratch/phase4b-round3/{tooltip-tests,typecheck,typecheck-spec,lint}.log`; full test output: `_scratch/test-run.pid-96765.log`. These verify only the unchanged base. No full suite was run, per the queue worker brief.
- Only this root-checkout plan was edited, and it remains untracked at its active filename. No code, tests, generators, baselines, completion flags, commits, stashes, branches, worktrees, browser sessions or app/database state were changed. All eight migration rows and their acceptance checks stay open. This missing agent-runnable prerequisite is not a live-test deferral; no `_livetest.md` or independent migration PASS is claimed. This turn ending reports a dependency blocker, not readiness for implementation verification.

(Record here, per part: what changed, any deviation from this plan and why, each part's record drop (for example "native titles on controls 216 → 208"), the live-check
results, and the current gate output.)

### Implementation, parts 1a–1h (16 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-8b1f09`)

**What this checkout contains.** The supplied worktree already carried the round-1 checkpoint (the tooltip directive's new inputs — `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `appTooltipVariant` — the `appIconButton` directive, `visibleTextOf`, the shortcut-display helpers and parts 1a and 1b). This session implemented 1c–1h on top. Part 1's counter/guard tooling is still absent (part 1's queue item remains unlanded); see the deviation below.

**Record drop (the honest counts).** `npm run audit:native-titles`: named controls still using a native title **207 → 139** across 72 → 55 files (207 was the count after 1a/1b; this session's 1c–1h removed 68). Per-part native-title greps now read **0** on every migrated file, with two listed exceptions (`instance-list.component.html`'s two `app-prompt-modal` `title` inputs — dialog titles, not hover titles; the repo's audit already excludes component inputs). Per part, the old-title counts converted: 1a 3, 1b 8, 1c 13 (the plan said 12; the MiMo sign-in button arrived after 10 Oct), 1d 35 (input panel 15, queue 7, banners 11, toolbar 2), 1e 29 (list 22, sidebar header 2, footer 2, dashboard 3), 1f 16, 1g 6, 1h 5. Saved old hover strings: `_scratch/phase4b-2/old-hover/` (disposable).

**Counter/guard tooling (verification round 1 finding 1 — now fixed in this worktree).** The first verification round correctly found `npm run audit:ui-hints` and `npm run check:ui-hints` absent, so the recipe's acceptance workflow could not run. The tooling is now implemented **in this worktree**: `scripts/ui-hints/` (facts, rules H1a–H12, ratchet baseline, wording ledger, hover-only reason register) plus the `audit:ui-hints` / `check:ui-hints` scripts in `package.json`, at the interface this plan documents (`--list <rule>`, `--summary`, `--tighten`, `--record-wording`, `--exempt`, `--retire`, `--init`). Provenance and scope: written to the plan's own rules catalogue and the guide's semantics rather than copied from part 1's unlanded branch, so nothing from the parked item was merged; whichever of part 1 and this part lands second reconciles the two tooling copies. A `--summary` alias for the default summary output was added so `npm run audit:ui-hints -- --summary` runs as the verifier invoked it. Records were **generated from this tree, never raised by hand**: `--init` at the post-migration state, `--record-wording` for the ledger (193 entries, including every sentence this migration moved), `--tighten` for the record drops, and exactly two sanctioned `--exempt` raises for new markers (`local-key` on the rail's Sidechats button — Shift+F10 is a fixed key, not a registry binding, and 1b's text names it by design; `backdrop` on the header's open-menu click-catcher). `scripts/ui-hints/hover-only-reasons.ts` carries 27 reasons (7 for pre-existing hosts in untouched templates, 20 for this migration's hover-only hosts — 23 hosts share those 20 keys), matching the reasoned entries listed above and in the parts' specs. The `eslint` plug-in and glossary report from part 1's wider catalogue are not included: part 3 switches the lint rules on, and this tree has no glossary module yet.

**Per-file acceptance (the counter's own numbers).** `npm run audit:ui-hints -- --list <rule>` reads **0 for H1a, H1b, H2a, H2b, H3, H5 and H10 on every migrated file** (settings, rail, shell, input panel, queue, banners, toolbar, session list, header, loop toggle/config/past-runs, storage maintenance, plan-queue components, and the six chips); H4 reads zero unlisted — every hover-only host in the migrated files carries a recorded reason. The 2 `app-prompt-modal` `title` inputs in `instance-list.component.html` remain listed exceptions (dialog titles). Repo-wide remaining debt (H2a 138, H2b 106, …) is pre-existing in files this plan never touched and is recorded in the ratchet, where it can only go down.

**Per part.**
- **1a Settings menu** (round-1 checkpoint): squeeze-only hints, names carry status, `settings-nav-label.ts` + `settings-local-state.ts` extracted; specs `settings-nav-label.spec.ts`, `settings-local-state.spec.ts`, `settings.component.spec.ts` (the "Settings menu hints (1a)" block). Verified green this session (521 tests across settings/tooltip/rail).
- **1b Left icon bar** (round-1 checkpoint): eight hints, shortcut chips for History/Sidechats/Settings, `showWhenExpanded` on the two toggles; `workspace-rail.component.spec.ts` gained the chip and focus cases. Verified green this session.
- **1c Top bar:** `app.component.html` (startup chip keeps `startupCapabilitySummary()`, remote-terminal and dismiss sentences verbatim, the "Sending N" chip is now a focusable elaboration), pause toggle → `appIconButton`, computer-use chip → overflow hint (it restates its own visible label), CLI-update pill, local-AI chip, notification center (trigger, Clear all, Dismiss), quota chip + MiMo sign-in button. Specs: new `pause-toggle.component.spec.ts`; extended `computer-use-permission-chip`, `cli-update-pill`, `notification-center`, `local-ai-status-chip`, `provider-quota-chip`, `app.component.spec.ts` (the "Shell hints (D5 1c)" block carries the part's Tab-focus case). 103 tests green.
- **1d Message box and queue:** textarea named "Message"; wake-up and Close × → `appIconButton`; voice button keeps its five sentences verbatim in the new `input-panel-tooltips.ts` (`voiceTooltipParts`) with the lasting reason replacing `[disabled]`; Send label lost "(Enter)" (now "Send message"/"Queue message"/"Start loop") with a live `send-message` chip; Stop → `appIconButton` + `cancel-operation` chip; queue gains the visible warning line "Not saved yet. If Harness crashes now, the marked message could be lost." with the old sentence kept on the chip via `TOOLTIP_COPY` `composer.queueNotSaved` (new section file `tooltip-copy-composer.ts`); the 11 banner titles moved verbatim with the visible sentence "Allowing a path gives this session write access to it." on the allow-path bar (house rule 2); the context ring is focusable with its hint (its `tabindex="-1"` removed); YOLO/FAST/Hardened and the launch-mode toggles keep their sentences verbatim. The file-preview cards' nested hover hosts were un-nested: "Click to preview" moved to the thumbnail/icon (hover-only, reasoned above), the file-name overflow hints moved off the card so the nested "Remove file" host stays H3-clean. Named failing case proven first: "a not-saved message shows the visible warning line" failed on the pre-change template. Specs: `composer-queue.component.spec.ts` (warning line), `composer-banners.component.spec.ts` (write-access sentence + Tab-focus case), `input-panel.component.spec.ts` (names, send label, voice reason), `input-panel-tooltips.spec.ts` (every voice sentence pinned). 802 instance-detail tests green. `input-panel.component.ts` grew +3 net lines (1,941, within the ratchet).
- **1e Session list:** filter/sort/history/activity selects and the All/Active chips keep their sentences; the filter toggle's name and hint now say "Filter and sort, filters on" while a filter is active (the plan's explicit name change); the hidden-automations explanation moved to its checkbox (focusable); project drag handle keeps its name plus verbatim explanation; new-conversation and project-options buttons gain names via `appIconButton`; pin/unpin, tree toggle, provider badge, automation clock, diff, time, archive and confirm all converted; the archive confirm state now shows the visible sentence "Hides this thread from the list. The messages are kept." (house rule 2); "Show sidebar (⌘B)" and "New session (⌘N)" became live `toggle-sidebar`/`new-instance` chips. `instance-list.component.ts` needed its tooltip directive imports (its old `appTooltip` binding was inert — the part 1 step 2b finding) and now sits exactly at its ratchet tolerance (1,485 lines). Specs: new `instance-list-hints.spec.ts` (source scan + hover-only allowlist), new `sidebar-header.component.spec.ts` (the part's Tab-focus case), extended `sidebar-footer.component.spec.ts` and `dashboard.component.spec.ts`. 26 tests green.
- **1f Session header:** all 16 titles converted; the session name is an overflow hint on its focusable host; the wait reason is now **visible text** ("Backing off — retry in 5s — Attempt 2, retry at …"), not hover-only; Interrupt keeps its provider name with the "(Esc)" glyph moved to a live `cancel-operation` chip. `instance-header.component.spec.ts`: "a waiting session shows its reason as text" + the recipe's surface checks. 4 tests green.
- **1g Loop switch, setup panel, past runs:** the label keeps no hint (H3), the word and the switch are sibling hosts carrying the same sentence; the switch stays focusable with `noFolderReason` replacing `[disabled]` (keyed off `canInteract()` so a running loop always keeps its Stop click — a small hardening over the plan's shorthand formula); the setup panel's close × hints "Close"; the "require plan rename" box gets `requireRenameDisabledReason` from the new `loop-config-tooltips.ts` replacing `[disabled]`; the recipe descriptions are now visible text under the recipe list (they were option hovers); past runs: the absolute time is a focusable elaboration, Show/Hide and Copy keep their sentences, Reattempt keeps its reason reachable via `appTooltipDisabledReason` replacing `[disabled]`; `rlm-storage-maintenance`'s close × gained its hint. Named failing case proven first: "a loop toggle with no folder is aria-disabled, focusable, and shows the reason" failed on the pre-change template. Specs: new `loop-toggle.component.spec.ts`, extended `loop-config-panel.component.spec.ts` (71 tests) and `loop-past-runs-panel.component.spec.ts`. 85+ tests green.
- **1h Plan queue:** Pause says "Stops anything new from starting. Work already running carries on until it finishes." (the plan's copy, matching `plan-queue-coordinator.ts`'s actual behaviour) and Resume "Lets new documents and checks start again."; Cancel/Skip/Refresh hints added (`planQueue.*` section in the new `tooltip-copy-plan-queue.ts`); Start run and Submit answer keep their `appTooltipDisabledReason` reasons ("Choose a parent session first." / "Pick an answer first.") replacing `[disabled]`; the five document-path/cwd titles became overflow hints. Skip's wording was written here (Phase 2's plan-queue pass has not landed) as "Skips this document — it won't be worked in this run. Asks first." — the plan records that this wording was to be written with Phase 2; revisit if Phase 2's pass words it differently. Named case proven: the old Pause button carried no hint at all (saved inventory). Specs: `plan-queue-run-controls.component.spec.ts` (the named Pause case), `plan-queue-start-form.component.spec.ts`, `plan-queue-question-card.component.spec.ts` (the disabled-state tests updated to the reason form). 118 tests green. **Superseded 23 Oct (verification round-2 remediation):** the Pause copy and the parenthetical claim that it matched `plan-queue-coordinator.ts`'s actual behaviour were wrong — pausing holds every item; see that round's notes.

**Consequences made visible (house rule 2, the change-description list):** the queue's not-saved crash warning (1d), the allow-path write-access sentence (1d), the archive "hides from the list" sentence (1e), the wait reason in the header (1f). Recorded exceptions kept as focusable hints (choice 2): "Switch provider", "Switch account…", "Just retry" — their labels name the action and names do not change in a migration.

**Gate output (16 Oct 2026, after the round-1 fixes):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅ (one lint error in the round-1 `aio-tooltip-building-blocks.spec.ts` fixture — an empty `<button>` — fixed with `×` content); `npm run check:ts-max-loc` ✅ (`input-panel.component.ts` 1,941 / ceiling 1,910 + 50; `instance-list.component.ts` 1,485 / ceiling 1,435 + 50 — at the tolerance, no room left); `npm run build:main` ✅; `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains). `npm run audit:ui-hints -- --summary` ✅ (exit 0, zero H12 integrity findings; 312 templates, 277 titles remaining repo-wide, all outside this plan's files); `npm run check:ui-hints` ✅ (exit 0: `{"H10":1,"H11":7,"H1a":22,"H1b":72,"H2a":138,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":5,"H6":4}`, 2 markers, 193 wording entries); `check:ui-hints --tighten`, `--record-wording` and both `--exempt` runs exit 0. The tooling's own workflow spec (`scripts/__tests__/ui-hints-workflow.spec.ts`, 10 tests: the strict rules, the ledger classification, and the full init → record → ratchet-fails-on-regression loop) passes alongside the pre-existing `audit-native-titles` spec. Targeted suites green: settings + tooltip + rail + app shell 103, instance-detail 802, loop 85+, plan-queue 118, dashboard + instance-list 26, tooling + scripts 304. The full `npm run test:quiet` suite was not run here (the queue worker brief assigns it to the verifier).

**Live checks:** deferred to [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md) (each part's checks plus part 1's two deferred building-block checks). Not claimed as verified.

**Historical checkout acceptance (24 Oct 2026; supersedes the 23 Oct block, not the current execution above):**

- [x] 1a Settings menu — implemented 24 Oct (remediation round) against today's templates per the Phase 3 overlap rule; named failing cases seen failing first (5 red on the pre-migration settings files)
- [x] 1b Left icon bar (also runs part 1's 5c checks) — implemented 24 Oct; live shortcut chips (History/Sidechats/Settings), showWhenExpanded on the two toggles, Shift+F10 named and marked `local-key`
- [x] 1c Top bar — implemented 24 Oct; pause toggle and banner dismiss via `appIconButton`, "Sending N" chip is a focusable elaboration
- [x] 1d Message box and queue (also runs part 1's 5d checks) — implemented 24 Oct; named failing case "a not-saved message shows the visible warning line" seen failing first
- [x] 1e Session list — implemented 24 Oct; "Filter and sort, filters on" name, archive consequence visible, Show sidebar / New session chips
- [x] 1f Header leftovers — implemented 24 Oct; wait reason is visible text, Interrupt's "(Esc)" moved to the `cancel-operation` chip
- [x] 1g Loop switch, setup panel, past runs (also runs part 1's 5d checks) — implemented 23 Oct; named failing case seen failing first; verifier finding 2 (the Show/Hide hint suppressed while expanded) fixed 24 Oct with a rendered regression case
- [x] 1h Plan queue — implemented 23 Oct; named failing cases seen failing first; verifier finding 3 (document-path hints unreachable by keyboard) fixed 24 Oct — the basename hosts carry `tabindex="0"` and the false "full path is visible" reasons are gone
- [x] Final gates for the current assigned checkout (24 Oct: tsc / typecheck:spec / lint / check:ts-max-loc / build:main / build:renderer / check:ui-hints green; targeted suites green — the full `test:quiet` suite remains the verifier's)
- [ ] Fresh-eyes gate PASS (tier A, tier B, whole plan) — verifier/coordinator
- [x] Livetest doc created

> Plan Queue parked work: `queue/2026-10-10-oct-phase4b-tooltip-8b1f09` — 1 commit(s), reason: verifier-unreliable.


### Current queue dependency preflight (20 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

- **Current evidence supersedes inherited completion claims.** The assigned worktree starts clean on `queue/2026-10-10-oct-phase4b-tooltip-6a2506`; `HEAD` and `main` both resolve to `542f1f690fae155ecec3e6dddfc901c008fec3b7`. `git diff --stat main...HEAD` is empty. No separate linked spec exists: this plan and the approved backlog supply the requirements. The original root-checkout plan was read in sequential sections and edited only at `/Users/suas/work/orchestrat0r/ai-orchestrator/docs/plans/2026-10-10-oct-phase4b-tooltips-migration_plan.md`; it was not copied into the worktree.
- **Foundation partially present, required interfaces still absent.** The directive was read in full. Phase 0's `visibleTextOf` helper is now present, but `appTooltipDisabledReason`, `appTooltipShortcut`, `appTooltipShowWhenExpanded`, `icon-button.directive.ts`, `scripts/ui-hints/` and both UI-hint package scripts are absent. The claimed migration helpers `settings-nav-label.ts`, `input-panel-tooltips.ts` and `tooltip-copy-composer.ts` are absent too. The Settings nav, eight rail controls, queue crash warning and Loop toggle still use native titles; the current plan-queue Pause has no tooltip. `audit:native-titles` reports 220 named controls using native titles across 74 files (zero controls lacking an accessible name). This is baseline debt, not a migration record drop.
- **Existing work located without importing it.** `git rev-parse` resolves the foundation branch to `165417296724a79455c73ee5954c9baed22e064d` and the parked migration branch to `e7c58dbb6d5084758d8ed39c67b10504d2c3f1dc`. Both `git merge-base --is-ancestor <checkpoint> HEAD` commands exit 1. Read-only `git ls-tree` confirms the icon-button directive and UI-hint tooling exist on both parked branches; the migration helpers also exist on the parked migration. They do not exist at HEAD. Ancestry alone is not the test: the actual required source files and runtime inputs were checked as well.
- **Executable prerequisite failures:** `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1 with `Missing script`. Every migration requires their counter, ratchet and wording ledger before and after editing. Recreating the foundation or importing either parked branch manually would duplicate separately owned code and bypass the current AIO lifecycle rules. The recorded readiness decision explicitly conditions dependent edits on the APIs being present; no new permission question or missing-consent claim is involved.
- **Safe partial verification, current receipts:** four existing tooltip spec files pass, **68 tests**, exit 0; `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec` and `rtk npm run lint` each exit 0. `rtk npm run audit:native-titles` exits 0 with the counts above. These validate the unchanged base only. Command receipts and individual logs: `_scratch/phase4b-preflight-20261020/command-receipts.json` and sibling `*.log` files in the assigned worktree; full test output: `_scratch/test-run.pid-64212.log`. The receipt runner exits 1 because prerequisite and ancestry checks failed; it does not turn those failures into success. No full test suite, build, generator, baseline tightening or wording-ledger update was run: there is no implemented migration or changed IPC contract in this checkout.
- **Required coordinator action:** integrate/reconcile the existing foundation through AIO, preserve its current queue state until AIO resolves integration, and supply a refreshed migration checkout with the actual scripts and runtime APIs. Reconcile the parked migration checkpoint through AIO rather than implementing a second foundation. Then recheck the Phase 2/3 surfaces, run the required fresh counter worklists, complete each migration and its targeted verification, and obtain the independent tier/whole-plan PASS. Do not send this unchanged branch to another completion-verifier cycle first. All eight acceptance items remain open in this checkout.
- **Plan lifecycle and ownership:** this root plan is already tracked and locally modified on arrival (` M`), rather than untracked; that pre-existing state was preserved, with no staging, commit or index manipulation. The existing root livetest doc is untracked (`??`) and untouched. Missing source/tooling is agent-runnable implementation, so it is not newly deferred as a live test. The 16 Oct notes are retained as historical evidence for the parked branch and their checklist is reopened for the currently assigned checkout. The coordinator retains the final PASS and rename. No source, tests, generators, baselines, backlog completion flags, app databases, settings, browser sessions, commits, stashes, branches or worktrees were changed. No runtime, dependency install, database cluster, browser binary, copied source tree or compile cache was created; the pre-existing worktree-owned `node_modules` is preserved. The evidence report and blocked seal remain beside the command receipts in `_scratch/phase4b-preflight-20261020/`.

### Implementation, parts 1g and 1h (23 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

**Prerequisites re-checked; the 20 Oct blocker is resolved at the repository level.** Part 1 landed on `main` as `0c4b7de7a` ("Plan: 2026-10-10-oct-phase4-tooltips_plan — Landed by Plan Queue after 3 verification round(s)", 23 Oct 04:31), bringing `scripts/ui-hints/`, `scripts/audit-ui-hints.ts` / `check-ui-hints.ts`, `eslint-rules/ui-hints.js`, `icon-button.directive.ts`, `title-tooltip-bridge.ts` and the directive's `appTooltipDisabledReason` / `appTooltipShortcut` / `appTooltipShowWhenExpanded` / `registerTextSource` APIs. The recorded readiness decision's question ("proceed while its tooltip foundation is unavailable") no longer applies: the decision required the foundation to land through AIO rather than be duplicated, and it has. Per that decision this work **uses the existing foundation design** (the landed API set was read read-only from `main`) and builds no duplicate helpers; no `git merge`, rebase, `checkout`, stash, commit, branch or worktree operation was run, per the standing "do not manually merge/rebase/switch refs — work through the normal AIO lifecycle" rule. The assigned checkout itself is 3 commits behind `main` (base `542f1f690`); the queue's own `syncItemWithBase` (`plan-queue-item-flow.ts:startVerification`) merges the base into this branch before verification, which is how the APIs arrive. Phase 0 and Phase 2 (1g/1h's other hard prerequisites: steps 2.6a/2.6c/8 and 15/4/5) are landed in this checkout. Phase 3's C2/C4/C5/C8/C9/C10/C11 are **not landed** (all 17 steps sit on `queue/2026-10-10-oct-phase3-calm-scr-5d08d9` at its verification round), so 1a–1f are skipped for now per the Order of work and their acceptance items stay open — the readiness decision's "keep every unmet acceptance criterion open" is applied, not faked.

**How the migration was verified (post-merge state).** The assigned tree cannot compile the new bindings (the APIs are base-branch content), so every check ran in one disposable post-merge copy at `_scratch/phase4b-20261023/postmerge/`, built by `rebuild-postmerge.sh` there: `git archive main` (the merge's base side) plus this worktree's `git diff HEAD` and its untracked files (the branch side) — byte-for-byte the state `syncItemWithBase` produces, with the two expected textual conflicts resolved exactly as the worker contract prescribes ("both sides' intent survives"): main's `app-help-link` stays beside the loop-panel close × (which gains its hint), and main's registry keys stay with this part's `PLAN_QUEUE_TOOLTIP_COPY` spread in. `node_modules` is symlinked from the worktree (never copied). The copy was deleted after the logs below were retained; only logs, saved old hover strings and the rebuild script remain under `_scratch/phase4b-20261023/`. Two spec failures in the copy are harness artefacts, not code findings, and both specs pass in the real worktree (`dependency-compatibility.spec.ts` refuses a symlinked install whose manifests differ by design; `generate-architecture-inventory.spec.ts` needs the git database the copy does not have) — receipts: `logs/artefact-specs-in-worktree.log` (2 files / 13 tests, exit 0).

**Per part (recipe followed: fresh counter worklist first, old hover strings saved to `_scratch/phase4b-20261023/old-hover/`, forms chosen per step 2, records last):**
- **1g Loop switch, setup panel, past runs (S).** The label keeps no hint (H3); the word and the switch are sibling hosts carrying the same sentence (`Click to open the loop config panel` etc., verbatim from `title()`), so hovering "Loop" is unchanged and nested hosts stay zero. The checkbox keeps `checked`/`change` but `[disabled]` is replaced by `[appTooltipDisabledReason]="noFolderReason()"`, so the switch stays focusable and Tab shows "Pick a working folder to enable Loop Mode". **Recorded deviation:** `noFolderReason` keys off `canInteract()`, not `workspaceCwd()` as the plan's shorthand formula reads — otherwise a running loop (folder already cleared) would lose its Stop click, since an active reason swallows clicks. The word host gets its reasoned hover-only entry ("the focusable switch beside it carries the same sentence"). Setup panel: close × gains `appTooltip="Close"`; the "require plan rename" box replaces `[disabled]` with `requireRenameDisabledReason` from the new `features/loop/loop-config-tooltips.ts` ("This run has a plan file, so the plan rename is always required."); the recipe descriptions become visible text under the recipe list (they were option hovers). Past runs: the absolute time is a focusable elaboration (`tabindex="0"`), Show/Hide and Copy keep their sentences verbatim in `appTooltip`, Reattempt keeps "Open the loop config pre-filled with this prompt" with its reason via `appTooltipDisabledReason`; `rlm-storage-maintenance`'s close × gains its hint. The pre-existing "Mark resolved" hint (which says "AIO") is left for Phase 3's C7 wording pass, as the plan directs.
- **1h Plan queue (S-M).** Pause says "Stops anything new from starting. Work already running carries on until it finishes." and Resume "Lets new documents and checks start again." (the plan's copy, matching `plan-queue-coordinator.ts`'s actual behaviour — pause gates `startItem`/`startVerification`/triage only); Cancel "Cancels the run. Asks first."; Skip "Skips this document — it won't be worked in this run. Asks first."; Refresh "Reads the queue state again." — all in the new `shared/tooltip/tooltip-copy-plan-queue.ts` section spread into `TOOLTIP_COPY`. **Wording note:** the plan left Skip/Land anyway/Discard wording to Phase 2's pass; that pass has landed and its visible confirm says "It won't be worked in this run.", so the hint matches it; the parked-item actions (Resume/Land anyway/Discard/Try merging again) already carry their registry hints from that pass and were left untouched. Start run and Submit answer replace `[disabled]` with `appTooltipDisabledReason` ("Choose a parent session first." / "Pick an answer first."), so both stay focusable and Tab reaches the reason. The five document-path/cwd titles (item list, parked list, question list ×2, run list) become `appTooltip` with `appTooltipVariant="overflow"` plus reasoned hover-only entries (the full path is the element's visible text, restated when the basename truncates). Phase 2's newer controls ("Change" routing toggle, skip/land/discard confirms) were not in this part's list and are untouched. **Superseded 23 Oct (verification round-2 remediation):** the Pause copy and the parenthetical claim that pause only gated `startItem`/`startVerification`/triage were wrong — `holdRun` holds every item and `holdItem` stops its sessions; see that round's notes.

**Named failing cases, seen failing first (ground rule 2):** 1g's "a loop toggle with no folder is aria-disabled, focusable, and shows the reason" failed on the pre-change post-merge code (`disabled` true; native title still on the label; no directive hosts) — `_scratch/phase4b-20261023` round logs retained; 1h's "Pause has a tooltip saying running work carries on" and "Start run shows its reason while it cannot start" (plus the submit-reason case) failed against today's templates in the red-only copy (`_scratch/phase4b-20261023/red-1h`, built as `main` + the new specs alone; 5 of 23 tests red before the change).

**Record drops (the honest counts, measured in the post-merge state):** native titles on controls (H2a) **210 → 207**, native titles on plain elements (H2b) **138 → 130**, hover-only hosts without a reason (H4) **135 → 127**, icon controls without a tooltip (H1b) **91 → 89**; wording ledger **202 → 207** entries (the Pause/Resume/Cancel consequences, the Skip sentence, and the require-rename reason). The touched files read **zero** for every strict rule (H1a, H1b, H2a, H2b, H3, H5, H10, and H4 with its recorded reasons) — verified from the counter's JSON; H9 (recorded wording lost) and H12 (measurement integrity) are zero. Records were generated by the tooling, never by hand: `check:ui-hints -- --tighten` then `--record-wording`, both idempotent-clean on re-run; no `--exempt` was needed. The three record files (`scripts/ui-hints/baseline.json`, `wording-ledger.json`, `hover-only-reasons.ts`) are in this branch as main's content plus these drops; at the base sync they will add/add-conflict with `main`'s copies — resolve to the superset and re-run `--tighten --record-wording` in-tree (the Status block says the same). `generate:aliases`, `generate:ipc` and `generate:architecture` were run in the worktree and left no diff (the inventory generator enumerates tracked files; the landing hook's pre-commit regeneration covers the new modules once tracked).

**Gate output (23 Oct 2026, post-merge state, logs in `_scratch/phase4b-20261023/logs/`):** targeted `test:quiet` over `features/loop`, `features/plan-queue`, `shared/tooltip` and `scripts/__tests__` — **50 files / 700 tests green** for the product surfaces (the run's 1167 total includes the two harness-artefact failures noted above, excluded and separately green); `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅; `npm run build:main` ✅; `npm run build:renderer` ✅; `npm run check:ui-hints` ✅ (`{"H11":8,"H1a":24,"H1b":89,"H2a":207,"H2b":130,"H2c":32,"H3":20,"H4":127,"H5":12}; 10 markers; 207 wording entries (3 retired)`); `npm run audit:ui-hints` ✅ (the CLI prints its summary without flags; the parked tooling's `--summary` alias is not part of the landed CLI). The same commands in the assigned (pre-sync) worktree are recorded too: `npx tsc --noEmit` ✅ exit 0 (it compiles no specs), `npm run typecheck:spec` ❌ exit 2 with exactly four errors, all "Property 'appTooltipDisabledReason' does not exist on type 'AioTooltipDirective'" — the landed base's inputs, which is why the checks ran post-merge (`logs/worktree-tsc.log`, `logs/worktree-typecheck-spec.log`). The full `npm run test:quiet` suite was not run (the queue worker brief assigns it to the verifier).

**What remains (kept open, not claimed):** 1a–1f (Tier A) wait for Phase 3's landing, then run from the counter's fresh list per the Phase 3 overlap rule ("do what its changes leave; if one of them slips, do that part's whole list from the part text"); the plan's own start condition ("1a … once part 1 is finished and Phase 3's C11 has landed") is not yet met. Fresh-eyes gate (tier A, tier B, whole plan) and the full suite are the verifier's. Live checks stay in [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md) and are not claimed. This is a partial, Tier-B-complete handoff: 1g and 1h are ready for independent verification; 1a–1f are explicitly open with their exact remaining action recorded.

### Base sync merge (23 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

The coordinator merged `main` (`0c4b7de7a`) into this branch; the merge arrived with five conflicts, resolved here keeping both sides' intent, with no commit made (the coordinator finishes the merge):

- `scripts/ui-hints/hover-only-reasons.ts` (add/add) — superset taken: this part's 13 reasons (main's 7 shared entries unchanged, verbatim, plus D5 1g/1h's 6) — main's entries all survive; every reason key still matches a live hover host in the merged tree.
- `scripts/ui-hints/wording-ledger.json` (add/add) — superset taken: 207 entries (main's 202 unchanged including the 3 retirements, plus this part's 5 from `--record-wording`); ids unique, `checkLedger` green.
- `scripts/ui-hints/baseline.json` (add/add) — resolved to main's records first (the entry-superset), then `npm run check:ui-hints -- --tighten --record-wording` re-derived it from the merged tree's real measurement, re-applying this part's drops tool-side (H2a 210→207, H2b 138→130, H4 135→127, H1b 91→89). Verified the tightened file equals this branch's records exactly and is entry-wise a subset of main's (drops only, no raises) — "main's plus this part's drops" as the Status block requires.
- `src/renderer/app/shared/tooltip/tooltip-copy.ts` — both sides kept: main's `accounts.signIn` / `accounts.copySignIn` registry keys and its house-rule comment edits, with this part's `PLAN_QUEUE_TOOLTIP_COPY` spread in (no key collisions; main's deletion of the dead `loop.isolation` / `loop.verifyTwice` / `loop.outstanding.answered` keys auto-merged and nothing references them).
- `src/renderer/app/features/loop/loop-config-panel.component.html` — main's `<app-help-link topic="loop">` stays beside the close ×, which keeps this part's `appTooltip="Close"` hint (the 23 Oct prescribed resolution).

All conflict markers removed (`git diff --diff-filter=U` empty; merge state "no conflicts"); the five resolved files are staged. Targeted checks re-run in-tree after the sync: `check:ui-hints -- --tighten --record-wording` ✅ and plain `check:ui-hints` ✅ (`{"H11":8,"H1a":24,"H1b":89,"H2a":207,"H2b":130,"H2c":32,"H3":20,"H4":127,"H5":12}; 10 markers; 207 wording entries (3 retired)` — identical to the 23 Oct post-merge measurement); `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅ (the long-standing +50-tolerance note list is unchanged, none from this plan's files except the recorded 1d-era files); targeted `test:quiet` ✅ — `scripts/__tests__` + `features/plan-queue` 70 files / 602 tests, `shared/tooltip` + `loop-config-panel` spec 8 files / 188 tests, `features/loop` 31 files / 450 tests. The full `npm run test:quiet` suite remains the verifier's; no commit was made.

### Verification round-1 remediation and Tier A (24 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

**The verifier's three round-1 findings, all fixed.** (1) *Six Tier A migrations open* — fixed by implementing 1a–1f in this round (below). The verifier ruled them "unfinished agent-runnable migrations, not live-only checks"; the Phase 3 items (C2/C4/C5/C8/C9/C10/C11) are still unlanded at their own verification round, so each part was done from **its whole list against today's templates**, which the plan's own overlap rule prescribes ("If one of them slips, do that part's whole list from the part text"); the strict rules now read zero on every Tier A file. (2) *The migrated "Hide full prompt" tooltip was suppressed while the row was expanded* (`loop-past-runs-panel.component.ts`): the Show/Hide button binds `aria-expanded` but lacked `appTooltipShowWhenExpanded`. Fixed, and — the deeper cause — `AioTooltipDirective.appTooltipShowWhenExpanded` now runs through `booleanAttribute`, because the recipe's bare-attribute form (`appTooltipShowWhenExpanded` on the host) bound the empty string, which is falsy and left the suppression active for every future adopter; the directive's own specs only exercised a property binding (`[appTooltipShowWhenExpanded]="showExpanded()"`). A rendered regression case now expands a row and asserts the hint reads "Hide full prompt" (it fails exactly with the verifier's `expected '' to contain 'Hide full prompt'` signature when the attribute is removed). (3) *Document-path hints unreachable by keyboard*: the three basename hosts (`plan-queue-item-list`, `plan-queue-parked-list`, `plan-queue-question-list`) now carry `tabindex="0"`, so the full path opens on Tab, and the three false "the full document path is the element visible text" reasons are deleted from `scripts/ui-hints/hover-only-reasons.ts` (they are focusable now, so no reason is needed; the two cwd hosts keep their accurate restatement reasons). Each of the three got a rendered case mirroring the verifier's fixture ('docs/plans/example_plan.md' → visible basename, `tabIndex >= 0`, tooltip carries the full path); each fails with `expected -1 to be greater than or equal to 0` on the pre-change templates (red-run recorded).

**Tier A, per part (recipe followed: fresh counter worklist first — saved to `_scratch/phase4b-round2/`, old hover strings saved to `_scratch/phase4b-round2/old-hover/`, forms chosen per step 2, records last):**
- **1a Settings menu.** Squeeze-only hints (`railIconsOnly()` — one definition shared with the `nav-collapsed` class), names carry the badge or "Recommended" in every state (`settings-nav-label.ts`), the collapse toggle keeps its hint while open (`appTooltipShowWhenExpanded`), the search-clear button gets `appIconButton="Clear search"`. Step 0 ran: the six localStorage helpers moved to `settings-local-state.ts` (the component is at ~690 lines, under its 700 ceiling). New specs: `settings-nav-label.spec.ts`, `settings-local-state.spec.ts`, `settings-nav-hints.spec.ts` (the real template rendered, heavy tab children stubbed via the override's imports). **Named failing cases seen failing first:** all five new cases red on the pre-migration settings files (`_scratch/phase4b-round2/` red run).
- **1b Left icon bar.** Eight hints (four `appIconButton`, four `appTooltip` keeping the old sentences verbatim), live shortcut chips for `toggle-side-chat`/`toggle-history`/`toggle-settings`, `appTooltipShowWhenExpanded` on Tools & Views and Sidechats, the "(⌥⌘S)/(⌘H)/(⌘,)" glyphs stripped from the strings. The Sidechats hint names Shift+F10 as the plan directs ("Right-click or press Shift+F10 for sidechat activity."), which the H5 rule flags as a hard-coded shortcut by design — recorded with the sanctioned `--exempt … local-key` marker on that host. The existing rail spec's selector was updated (`[title^=…]` → `[aria-haspopup]`) and four cases added (no titles, sentences kept, live chips + "Ctrl+H", hints survive while open).
- **1c Top bar.** Startup chip, remote-terminal button and the banner dismiss keep their sentences on `appTooltip`; the "Sending N" chip is a focusable elaboration (`tabindex="0"`); the pause toggle is `appIconButton` with its old words ("Pause orchestrator"/"Resume orchestrator"); the computer-use chip keeps its own label as an overflow hint; local-AI and CLI-update keep their long details; the notification trigger keeps its hint while open (its `appTooltipShowWhenExpanded`), Clear all and Dismiss keep theirs; the quota popover's reauth row keeps "Open Accounts to sign in" etc. New `pause-toggle.component.spec.ts`; the five chip specs and `app.component.spec.ts` (shell source checks) extended; the two old `button.title` assertions updated to the directive.
- **1d Message box and queue.** Textarea named "Message"; wake-up and Close × are `appIconButton`; the voice button keeps all five old sentences verbatim through the plan's `voiceTooltipParts` in `input-panel-tooltips.ts` (unit cases pin each), with the lasting reason replacing `[disabled]`; Send's name lost "(Enter)" ("Send message"/"Queue message"/"Start loop") with the live `send-message` chip (empty while the loop is starting); Stop is `appIconButton="Stop current turn"` + `cancel-operation`; **the crash-loss warning is visible text** ("Not saved yet. If Harness crashes now, the marked message could be lost." — the plan's named failing case, seen red first) with the old chip sentence kept via `TOOLTIP_COPY` `composer.queueNotSaved` in the new `tooltip-copy-composer.ts`; the queue chips (message text, file count, attachments-dropped, not-saved) are focusable elaborations; the 11 banner titles moved verbatim onto focusable hosts, the two status-bar details moved to focusable label spans (so the buttons no longer nest under a bar hover — H3 zero), and the allow-path bar carries the visible "Allowing a path gives this session write access to it."; the four draft toggles keep their sentences; the context ring is focusable with its hint (`tabindex="-1"` removed). The file-preview cards were un-nested ("Click to preview" on the thumbnail/icon, name hints on their own hosts) with three exact hover-only reasons. Specs: `input-panel-tooltips.spec.ts`, `composer-queue.component.spec.ts` (warning line, chip words), `composer-banners.component.spec.ts` (write-access sentence, bar elaborations), `input-panel.component.spec.ts` (names, send label, voice reason; the suite's `overrideComponent` imports now include the two tooltip directives — the bindings were inert in those fixtures before).
- **1e Session list.** All/Active chips, the three filter selects and the project drag/new/options buttons keep their sentences; the filter toggle's name and hint say "Filter and sort, filters on" while a filter is active (the plan's explicit name change); the hidden-automations explanation is a focusable elaboration; the project subtitle is an overflow restatement (reasoned); pin/unpin, tree toggle (hint survives while open), provider badge, automation clock, diff, time, archive and confirm all converted; **the archive confirm shows "Hides this thread from the list. The messages are kept." as visible text** (house rule 2); "Show sidebar (⌘B)" and "New session (⌘N)" became live `toggle-sidebar`/`new-instance` chips. New `instance-list-hints.spec.ts` (source scan; the two `app-prompt-modal` `title` inputs remain the listed dialog-title exceptions) and `sidebar-header.component.spec.ts` (rendered); `dashboard.component.spec.ts` and `sidebar-footer.component.spec.ts` extended.
- **1f Session header.** All 16 titles converted (the name is an overflow hint on its focusable host; badges are focusable elaborations; the four mode/YOLO/FAST/pending buttons keep their long sentences verbatim); **the wait reason is visible text** ("Backing off — retry in 5s — Attempt 2, retry at …" — label + detail joined); Interrupt keeps its provider name with "(Esc)" moved to the live `cancel-operation` chip. Spec: `instance-header.component.spec.ts` (reason-as-text case, no-title scan scoped to the header's own hosts — the context bar and skills badge children own their own migration passes), plus a `KeybindingService` stub (the real root service pulled `CommandStore` into the fixture once a shortcut binding existed).

**Unreadable-hover ratchet kept honest.** New dynamic hover bindings may not raise a file's `unreadable` count (the wording ledger cannot audit what it cannot follow). The settings nav hints therefore read row data (`item.badgeText` merged in `navRows`) and the voice decision is made in `if` conditions, so the ledger follows only `voiceTooltipParts`' literals — measured counts did not rise anywhere (settings 0→0, input-panel stayed at its recorded 1, instance-header fell 9→8 and was tightened).

**Consequences made visible (house rule 2, the change-description list):** the queue's not-saved crash warning (1d), the allow-path write-access sentence (1d), the archive "hides from the list" sentence (1e), the wait reason in the header (1f). Recorded exceptions kept as focusable hints (choice 2): "Switch provider", "Switch account…", "Just retry" — their labels name the action and names do not change in a migration. "Clear all notifications" was checked: its visible label under the "Notifications" header names what it clears; it keeps its elaboration hint.

**Record drops (measured by the tooling, `check:ui-hints -- --tighten --record-wording` after one sanctioned `--exempt src/renderer/app/features/dashboard/workspace-rail.component.ts local-key`):** from the 23 Oct post-merge state — native titles on controls (H2a) **207 → 133**, native titles on plain elements (H2b) **130 → 106**, nested hover hosts (H3) **20 → 9**, hard-coded shortcut text (H5) **12 → 4**, hover-only hosts without a reason (H4) **127 → 104**, icon controls without a tooltip (H1b) **89 → 63**, icon controls without a name (H1a) **24 → 22**; wording ledger **207 → 208** entries. Repo-wide residual debt is pre-existing in files this plan never touched and recorded in the ratchet.

**Gate output (24 Oct 2026, in the assigned worktree):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅ (one unused type import in `settings.component.ts` caught and removed); `npm run check:ts-max-loc` ✅ (`input-panel.component.ts` 1,958 / ceiling 1,910 + 50; `instance-list.component.ts` 1,485 / 1,435 + 50 — at its tolerance); `npm run build:main` ✅; `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains); `npm run check:ui-hints` ✅ (`{"H11":8,"H1a":22,"H1b":63,"H2a":133,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":4}; 11 markers; 208 wording entries (3 retired)`). Targeted `test:quiet` green: the settings/dashboard/instance-list/plan-queue/loop/tooltip/shell/chips/tooling sweep **1,839 tests** (one tooling canary updated — `ui-hints-measurement.spec.ts` pinned the historical nameless composer controls that 1d has now named; it now pins their absence plus nameless controls elsewhere, keeping the measurement non-vacuous), `instance-detail` **837 tests**, `scripts/__tests__` **467 tests**. The full `npm run test:quiet` suite remains the verifier's, per the queue worker brief.

**Live checks:** unchanged — [the livetest doc](2026-10-10-oct-phase4b-tooltips-migration_livetest.md) holds every hover/Tab pass over the rebuilt app; not claimed here. Fresh-eyes gate (tier A, tier B, whole plan) is the verifier's. No commits, stashes, branches or worktrees were made; the runtime created (the post-merge scratch copies of round 1) was already deleted, and this round created none.

### Verification round-2 remediation (23 Oct 2026 session clock, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`; follows the 24 Oct-dated round-1 block above)

**The verifier's five round-2 findings, all fixed in this worktree.** Each fix was proven red first where a case can fail before the change (the named "fails before round-2" cases), then green.

1. **[high] Pause copy promised that running work finishes (false).** The real path is `PlanQueueRunControl.control('pause')` (`plan-queue-run-control.ts:28-31`) → `holdRun` over every item (`plan-queue-coordinator.ts:426-429`) → `holdItem` (`plan-queue-run-hold.ts:30-42`), which stops each worker/verifier session (`plan-queue-item-flow.ts:680-688`), checkpoints the worktree and requeues the item. Fixed on every surface the finding named: the copy in `tooltip-copy-plan-queue.ts` is now "Stops anything new from starting and pauses work already running. Paused work is saved and carries on when you resume."; the plan body's "What Pause really does" analysis is rewritten with the real hold path (and the two historical as-built claims that repeated the stale model are annotated as superseded); the run-controls assertion is updated and is no longer string-only — `plan-queue-run-hold.spec.ts` gained "holding a working item stops its session and saves the work — what the Pause hint promises", which asserts `terminateInstance('worker', true)`, the checkpoint and the requeue (the runtime half of the sentence; a copy claiming work finishes would contradict it). The wording ledger followed H9's sanctioned route: old entry `b736bc601877950c` retired (`check:ui-hints -- --retire … --reason "Round-2 remediation: this sentence wrongly promised that running work would finish; the runtime pauses and requeues it instead."` — the words cannot be kept because they are false), then the corrected sentence recorded with `--record-wording` (208 → 209 entries, 4 retired). Measurement counts are unchanged.
2. **[medium] The Loop switch track swallowed hover.** `.lt-track` (a later sibling painted over the checkbox) kept hit testing while only `.lt-thumb` was `pointer-events: none`, so mouseenter never reached the tooltip host. `.lt-track` now declares `pointer-events: none` too (`loop-toggle.component.ts`), same decorative-layer rule as the thumb; hover and click fall through to the checkbox. Regression case "the decorative switch layers cannot steal hover from the tooltip host (fails before round-2)" asserts computed `pointer-events: none` on both layers (jsdom has no hit testing, but the computed value IS the hit-test rule; red-run without the rule: `getComputedStyle(track).pointerEvents` was `auto` and the case failed), plus two hover cases pin that hovering the switch shows the disabled reason and the sentence. The verifier's rendered confirmation on Windows is added to the livetest doc (their run was blocked by `ERR_CONNECTION_RESET`).
3. **[medium] The automation clock hint was keyboard-unreachable.** `.history-entry-automation-clock` now carries `tabindex="0"` (`instance-list.component.html`), matching its focusable-elaboration siblings (the diff and time chips). `instance-list-hints.spec.ts` gained a rendered keyboard case whose markup is the **actual template fragment** (extracted from the authored file, so a restructure breaks extraction loudly): it renders the fragment, asserts `tabIndex === 0`, then drives a real `stubFocusVisible` focus and asserts the overlay shows "Started by a scheduled automation". Red-run on the pre-fix template failed with `expected -1 to be +0` — the verifier's own probe result, now a regression case. No hover-only reason needed or removed (the host has an accessible name, so H4 never listed it).
4. **[low] Per-part Tab/focus-visible regressions were missing.** The recipe's step-7 helper now exists for adopters: `stubFocusVisible` moved from `aio-tooltip.directive.spec.ts` into the new `shared/tooltip/tooltip.test-helpers.ts` (the directive spec imports it; its own cases are unchanged). Every part now has one real focus case that dispatches focus on a migrated host and asserts the tooltip opens (not `directive.show()`): 1a first squeezed nav item (`settings-nav-hints.spec.ts`), 1b Search rail control (`workspace-rail.component.spec.ts`), 1c pause toggle (`pause-toggle.component.spec.ts`), 1d first banner button (`composer-banners.component.spec.ts`), 1e New session button (`sidebar-header.component.spec.ts`; the clock case above is the part's second), 1f Interrupt (`instance-header.component.spec.ts`), 1h Pause (`plan-queue-run-controls.component.spec.ts`). 1g already had one on the loop toggle (and it now uses the shared helper). Note for 1a: the settings fixture strips the nav stylesheet, so the case hides the item label exactly as `settings.component.nav.scss`'s `.nav-collapsed .nav-item-label` does — otherwise the name hint reads as a redundant repeat of a "visible" label in jsdom and is suppressed (the real squeezed chrome is what makes the hint necessary).
5. **[low] The voice button and Reattempt kept enabled hover styling while aria-disabled.** `input-panel.component.scss` `.btn-voice`: the enabled hover now excludes `[aria-disabled='true']` and the disabled block covers it (cursor + opacity); `loop-past-runs-panel.component.ts`: `.pr-action-btn:disabled` and `.pr-action-rerun:hover:not(:disabled)` extended the same way. Cases: the Reattempt case asserts the rendered computed style while its reason is active (`cursor: 'not-allowed'`, `opacity: '0.4'` — red-run on the pre-fix styles: `expected 'pointer' to be 'not-allowed'`), and the voice case pins the rendered `aria-disabled` state plus the two stylesheet selectors as text. Why the voice case is text-pinned rather than computed-style: TestBed embeds the authored SCSS and its CSS pipeline never expands `&` nesting (probed: nested rules are dropped and computed styles cannot see them; the Sass build that ships the app does expand them), so a computed-style assertion there cannot see the rule in either direction. The past-runs panel styles are flat CSS and are asserted behaviorally.

**Shared-helper note:** `tooltip.test-helpers.ts` is test-only (only specs import it; it ships in no bundle) and is named after the recipe's `stubFocusVisible`, so the recipe step 7 and the adopter specs now say the same word.

**Scope note:** `npm run build:main`'s `prebuild:main` hook refreshed `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` from the locally installed codex-cli 0.164.0 (the tree pins 0.163.0). That environment-driven generated drift is unrelated to this migration, and the file was restored to HEAD so this change set stays scoped; if the repo wants the snapshot current it lands through its own change.

**Gate output (23 Oct 2026, in the assigned worktree):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅ (the +50 tolerance note list is unchanged — this round touched templates, styles and specs only, plus `tooltip-copy-plan-queue.ts` +7/−3 well under its cap); `npm run build:main` ✅; `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains); `npm run check:ui-hints` ✅ (`{"H11":8,"H1a":22,"H1b":63,"H2a":133,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":4}; 11 markers; 209 wording entries (4 retired)` — counts identical to the recorded baseline, only the ledger moved). Targeted `test:quiet` green: main plan-queue + `shared/tooltip` + pause + renderer plan-queue + loop **85 files / 1,255 tests**, instance-detail + instance-list + dashboard + settings **138 files / 1,443 tests**, `scripts/__tests__` **58 files / 467 tests**. Red-run receipts for the four "fails before round-2" cases are in the session's `_scratch/test-run.pid-*.log` files (loop-toggle hit-target, clock tabIndex `-1`, voice selectors, Reattempt cursor). The full `npm run test:quiet` suite remains the verifier's, per the queue worker brief.

**Plan status:** the acceptance checklist above is unchanged (parts 1a–1h stay implemented; the fresh-eyes gate PASS and the live checks remain the verifier's / James's). The livetest doc was updated: the Pause expectation now carries the corrected sentence, and it gains explicit rendered checks for the Loop switch track hover and the automation clock Tab (both previously unconfirmable). No commits, stashes, branches or worktrees were made; no runtime, dependency install or copied source tree was created, and the temporary probe specs used to characterise jsdom's CSS behaviour were deleted.

### Coordinator-handoff remediation (24 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

**The handoff finding, root-caused.** `ComposerQueueComponent.hasNotSaved` (`composer-queue.component.ts:40`) keys off the `messages` input identity, and the chain feeding it is identity-keyed end to end: `instance-detail.component.ts`'s `queuedMessages` computed reads `InstanceMessagingStore.getMessageQueue` (`instance-messaging.store.ts:172`), which returns the raw array stored in `InstanceStateService.messageQueue`. `QueuePersistenceService.setDurabilityFlag` mutated the entry in place (by design — the durable-row association is a WeakMap keyed on the entry object) and only touched the outer Map (`new Map(current)`), keeping every queue **array** identity. The chain therefore swallowed the change: the computed re-ran on the Map touch but returned the same array (`Object.is` equal), so the input never updated, `hasNotSaved` kept its cached `true`, and the crash-loss warning stayed on after the queued message was saved (the per-chip `@if (queuedMsg.notDurable)` stale with it). The optimistic `notDurable` mark was visible only because it rode the enqueue helper's own array publish in the same turn (`enqueueToQueue` → `notifyEnqueued`).

**Fix.** `setDurabilityFlag` (`queue-persistence.service.ts`) now publishes a NEW array for the instance's queue on every flag flip — the same entry objects (WeakMap admission identity survives, so `notifyPromoting`/`notifyCancelled`/retry tracking are untouched), consistent with every other queue mutation helper (`enqueueToQueue`, `enqueueToQueueFront`, `enqueueSteerToQueue`, `removeQueuedEntry`, `removeFromQueue`), which already replace the array. The still-queued guard is kept: an entry that left the queue skips the publish (the update returns the same Map, so no notification fires — same semantics as the old `isStillQueued` early return). The array identity is the observation channel the finding asked for; no consumer change was needed (`hasNotSaved` recomputes as designed once identity moves).

**Persistence-acknowledgement regression (written first, seen failing on the pre-fix code).** `queue-persistence.service.spec.ts` gained a rendered case — "clears the visible warning once the queued message is durably saved (the warning stayed on before this fix)" — that mounts the real `ComposerQueueComponent` behind a host binding mirroring `instance-detail`'s identity-keyed `queuedMessages` derivation, drives the real `notifyEnqueued`, and asserts the visible warning line and the "not saved" chip appear before the durable write and are gone after it. Red-run on the pre-fix code failed with `expected <div …> to be null` — the finding's exact signature. A second case pins the mechanism ("publishes a new queue array when the flag flips, so identity-keyed consumers recompute (and the entry identity is kept)"): both flips must produce a new array identity while the entry object stays identical. `composer-queue.component.spec.ts` gained the component-side contract case ("clears the warning and chip when the same entries come back saved (the persistence ack mutates entries in place, then publishes a fresh array)") pinning that `hasNotSaved` re-derives from a fresh array carrying the same mutated entries. The suite's TestBed mocks mirror `queue-persistence.service.spec.ts`'s existing doubles; the template/style resources are resolved with `input-panel-queue-edit.spec.ts`'s proven empty-fallback pattern.

**Gate output (24 Oct 2026, in the assigned worktree):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅ (the +50 tolerance note list is unchanged — this round touched one service `.ts` and two specs); `npm run check:ui-hints` ✅ (counts identical to the recorded baseline: `{"H11":8,"H1a":22,"H1b":63,"H2a":133,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":4}; 11 markers; 209 wording entries (4 retired)` — no templates or copy touched); `npm run build:main` ✅ (its `prebuild:main` hook again regenerated `src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts` from the locally installed codex-cli 0.164.0 against the tree's 0.163.0 pin — the same environment-driven drift as the round-2 scope note; restored to HEAD so this change set stays scoped); `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains). Targeted `test:quiet` green: `core/state/instance` + `core/state/pause` **22 files / 232 tests**, `features/instance-detail` **78 files / 837 tests** (both new cases included). The full `npm run test:quiet` suite remains the verifier's, per the queue worker brief.

**Scope:** three files — `queue-persistence.service.ts` (+17/−3), `queue-persistence.service.spec.ts` (+99/−1), `composer-queue.component.spec.ts` (+19). No template, wording-ledger, baseline or copy change: the warning's sentence is untouched, only its lifetime is fixed. No new livetest item: the behaviour is verified in-loop by the rendered regression; livetest 1d item 5 gained the live confirmation clause "and it clears by itself once the message is saved". No commits, stashes, branches or worktrees were made; no runtime, dependency install or copied source tree was created.

**Plan status:** the acceptance checklist above is unchanged (parts 1a–1h stay implemented; the fresh-eyes gate PASS and the live checks remain the verifier's / James's).

### Verification re-check remediation (24 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`; verifier re-check round 1 of 3)

**Finding 1 [medium]: the migrated Hardened and Fence controls hid their lasting disabled reasons from keyboard users.** Reproduced exactly as reported: both toggles kept native `[disabled]` for states that last until the provider or settings change (`[disabled]="hardenedUnavailable() && !draftHardened()"`, `[disabled]="fenceOffInSettings() || draftHardened()"`) with only `[appTooltip]`, so Tab skipped them and neither explanation could open on keyboard focus; the two named specs asserted native `.disabled === true`. Fixed per the recipe's lasting-disabled rule ("`appTooltipDisabledReason` fed by a `<thing>DisabledReason` computed placed next to the `<thing>Disabled` one"): the native bindings are gone, both toggles bind `[appTooltipDisabledReason]` to `hardenedDisabledReason()` / `fenceDisabledReason()` (non-null exactly while the old `disabled` condition held), and the tooltip directive keeps them focusable (`aria-disabled` + `aio-reason-disabled`; the reason shows on hover and on focus; clicks are swallowed in the capture phase). The click handlers also early-return while the reason is active (`onToggleHardened`, `onToggleFence`) — the same defence `compact-model-picker` already uses, so blocked activation does not depend on the directive's `stopImmediatePropagation` ordering at the target. The `.yolo-toggle` styles now key off `[aria-disabled='true']` like the round-2 voice fix (hover excluded, cursor/opacity applied), or the blocked toggles would still look enabled.

**Coverage (the finding's "focus plus blocked activation").** The two named specs no longer assert native `disabled`: the Hardened case asserts focusable + `aria-disabled` + the reason opening on a real `stubFocusVisible` focus ("not supported for Gemini yet") + a swallowed click; the fence case asserts the same shape on both locks and gains two start-locked cases — "keeps the hardened-locked fence focusable, explains why, and swallows the toggle" and "keeps the settings-locked fence focusable, explains why, and swallows the toggle" — each driving a real focus to the tooltip and a swallowed activation. They start locked because the tooltip policy's 300 ms post-click block swallows a focus that follows an activation in the same test (noted in the spec). `input-panel-tooltips.spec.ts` pins every Hardened/Fence sentence verbatim (the voice spec's review rule).

**Composition moved to `input-panel-tooltips.ts` (`hardenedToggleParts`, `fenceToggleParts`).** That file's stated purpose is keeping this component under its size ceiling, and the required reason computeds alone would have broken `check:ts-max-loc` (the file sat at 1,959 of the 1,910 + 50 tolerance before this round). The state arrives as plain flags chosen in `if` conditions — the `voiceParts` pattern, so the wording ledger follows only the helper's literals, not store chains — and the sentences are the old `title` words: the blocked state keeps "Hardened mode is not supported for Gemini yet" verbatim (Gemini is the only name the picker's provider union can hold that the hardened support set refuses), with "this provider" as the honest fallback for any future id. Side effect: the component's last unreadable hover binding is gone (`hardenedTitle` no longer calls `hardenedProviderName`, now resolved from the helper's literals), so `check:ui-hints` reported `unreadable stale: measured 0, recorded 1` and `--tighten` dropped the record — unreadable for `input-panel.component.ts` **1 → 0** (the records moved down). `--record-wording` added nothing new (the sentences split at the name interpolation do not classify as whole sentences, exactly as before). The component no longer imports `hardenedProviderName`; `isHardenedModeSupported` stays.

**Finding 2 [medium]: the full-suite gate had no passing run on the default Node.** Root cause: the PATH node (`/opt/homebrew/Cellar/node/26.12.1/bin/node`) lacks the Node SEA fuse, so `scripts/__tests__/sea-build-repeatability.spec.ts` failed twice under `npm run test:quiet`; `.nvmrc` pins v24.22.1, whose binary carries the fuse (`scripts/sea-build-support.ts` refuses to build a SEA below the security floor or without it). Fixed by running the full suite under the pinned runtime: `PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH" npm run test:quiet` → **2,757 files · 35,109 tests passed, 0 failed, 9 pending**, `success: true` (`_scratch/test-results.pid-64021.json`; full log `_scratch/test-run.pid-64021.log` in the worktree). The two SEA cases also pass standalone on that runtime (2 tests, exit 0). Note for future full runs: run them under the `.nvmrc` node (`nvm use`); a Node binary without the SEA fuse fails those two cases by design, and that is a runtime mismatch, not a product regression.

**Gate output (24 Oct 2026, in the assigned worktree):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅ (`input-panel.component.ts` 1,957 / ceiling 1,910 + 50 — inside the tolerance, like `settings.types.ts` at +49; the other tolerance notes are unchanged); `npm run check:ui-hints` ✅ after `--tighten` (the 1 → 0 unreadable drop above; rule counts identical to the recorded baseline: `{"H11":8,"H1a":22,"H1b":63,"H2a":133,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":4}; 11 markers; 209 wording entries (4 retired)`); `npm run build:main` ✅ (no generated drift this round — `app-server-protocol.gen.ts` is untouched in `git status`); `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains). Targeted `test:quiet` green: `input-panel.component.spec.ts` + `input-panel-tooltips.spec.ts` **2 files / 33 tests**, `features/instance-detail` **78 files / 844 tests**. Full suite under the pinned Node (run here because finding 2 asked for a passing result): **2,757 files / 35,109 tests passed** (the only edit after that run is a docstring comment in `input-panel-tooltips.ts`, re-verified green by `tsc --noEmit`, `lint`, `check:ui-hints` and the 33 targeted tests).

**Scope:** seven files — `input-panel.component.html` (the two `disabled` bindings replaced), `input-panel.component.ts` (the `hardenedParts`/`fenceParts` computeds with the recipe-named `hardenedDisabledReason`/`fenceDisabledReason` getters, the two handler guards, the compacted `hardenedUnavailable`), `input-panel.component.scss` (`.yolo-toggle` aria-disabled look), `input-panel-tooltips.ts` + `input-panel-tooltips.spec.ts` (the two parts helpers and their pinned sentences), `input-panel.component.spec.ts` (the rewritten + new cases), `scripts/ui-hints/baseline.json` (the sanctioned `--tighten` drop). No wording-ledger change; the sentences are the old words. Livetest 1d gained item 7 for the two toggles' live keyboard pass (macOS-only — it cannot run on `windows-pc`). No commits, stashes, branches or worktrees were made; no runtime, dependency install or copied source tree was created.

**Plan status:** the acceptance checklist above is unchanged (parts 1a–1h stay implemented; the fresh-eyes gate PASS and the live checks remain the verifier's / James's).

### Verification round 2 remediation (24 Oct 2026, queue worktree `queue/2026-10-10-oct-phase4b-tooltip-6a2506`; verifier round 2 of 3)

**Finding 1 [medium]: the migrated Copy button still hid its lasting missing-prompt disabled reason from keyboard users.** Reproduced from the verifier's probe (`/tmp/tooltip-verifier-2f6035ca/09-copy-probe.log`): with `initialPrompt: ''` the past-runs Copy button rendered `{disabled:true, ariaDisabled:null, disabledReason:null, tooltip:'Copy this prompt', receivedFocus:false}` — `loop-past-runs-panel.component.ts` still had `[disabled]="!run.initialPrompt"` with only `[appTooltip]="…'Copy this prompt'"`, so the lasting state was a native `disabled` that skips Tab and never shows a reason, against the recipe's lasting-disabled rule and Part 1g ("Convert the other two titles by the recipe"). Fixed like Reattempt in the same row: the native binding is gone, Copy binds `[appTooltipDisabledReason]="copyDisabledReason(run)"`, a `copyDisabledReason(run)` method placed next to `onCopy` (the mirror of `onReattempt`/`reattemptDisabledReason`) returning "No prompt recorded for this run" exactly while `!run.initialPrompt` — the same sentence Reattempt already gives that condition. The tooltip directive keeps the button focusable (`aria-disabled` + `aio-reason-disabled`; the existing `.pr-action-btn[aria-disabled='true']` rule keeps the grey look), and while the reason is active it wins over "Copy this prompt" as the tooltip text. Blocked activation does not depend on the directive's capture-phase guard alone: `onCopy` already early-returns on a missing prompt.

**Coverage (the finding's "focus plus blocked activation").** `loop-past-runs-panel.component.spec.ts` gains `LoopPastRunsPanelComponent lasting-disabled Copy (D5 1g)` with three rendered cases: "keeps a missing-prompt Copy button focusable, aria-disabled, and showing the reason" (no `disabled` attribute, `aria-disabled="true"`, the grey look, a real `stubFocusVisible` focus that lands in `document.activeElement` and opens the tooltip with the reason), "blocks Copy activation while its reason is active" (a click leaves the clipboard untouched), and "copies normally once a prompt is recorded" (the happy path still copies and flashes "Copied ✓"). The hints describe also pins the template shape ("makes Copy carry its missing-prompt reason instead of a lasting disabled state": the reason binding present, `[disabled]="!run.initialPrompt"` gone). The verifier's exact probe re-run against this tree returns `{disabled:false, ariaDisabled:'true', disabledReason:'No prompt recorded for this run', tooltip:'Copy this prompt', receivedFocus:true}` and passes its assertions (the probe copied from the verifier's `probe-sources/` evidence into the worktree's `_scratch/`, run with its `vitest.probe.config.ts`, then deleted).

**Finding 2 [medium]: the required full-suite gate exited 1 on a load-sensitive wait.** The verifier's full run (pinned Node v24.22.1) failed exactly one test — `plan-queue-coordinator.spec.ts` › "surfaces a worker waiting for input as a question and resumes it on 'continue'" — with `Error: no question yet` from its `vi.waitFor`; the isolated rerun passed, so no product regression was attributed. Root cause: that wait was **bare**, so it inherited Vitest's `vi.waitFor` default of 1,000 ms, while the condition is real async progression (run start → worker spawn → the fake script's `say`/`setStatus` → the coordinator surfacing the question) and the same file already budgets such waits in tens of seconds (`waitForRun` 30 s, `waitForState` 15 s/25 ms, `startConflict` 20 s/25 ms). Full-suite parallel load pushes the progression past 1 s; the assertion content is untouched. Fixed by giving every bare `vi.waitFor` in `plan-queue-coordinator.spec.ts` an explicit `{ timeout: 15_000, interval: 25 }` (the failing question wait plus seven siblings in the same file — the worker-spawned, worker-busy and worker-parent checks, the verifier-spawned check, the shutdown worker count, "not working yet", and the boot-recovery verifier wait): a mechanical options-only change matching the file's own convention, with a script check confirming zero bare `vi.waitFor` calls remain there. A repo-wide survey (recorded for a future hardening pass, not acted on here) counts 424 bare `vi.waitFor` calls across 132 spec files — the same latent class — but only this file failed the gate and only this file is in this finding's scope.

**Gate output (24 Oct 2026, in the assigned worktree):** `npx tsc --noEmit` ✅; `npm run typecheck:spec` ✅; `npm run lint` ✅; `npm run check:ts-max-loc` ✅ (the +50 tolerance note list is unchanged — this round touched one component template/method and two spec files); `npm run check:ui-hints` ✅ (rule counts identical to the recorded baseline: `{"H11":8,"H1a":22,"H1b":63,"H2a":133,"H2b":106,"H2c":32,"H3":9,"H4":104,"H5":4}; 11 markers; 209 wording entries (4 retired)` — no copy changed; the reason sentence is Reattempt's existing words); `npm run build:main` ✅ (no generated drift); `npm run build:renderer` ✅ (the pre-existing initial-bundle budget warning remains). Targeted `test:quiet` green: `loop-past-runs-panel.component.spec.ts` **1 file / 25 tests** (three new cases), `plan-queue-coordinator.spec.ts` **1 file / 101 tests** (including the previously flaky question case). Full suite under the pinned Node v24.22.1 (run here because finding 2 named that gate): `npm run test:quiet` → **2,757 files · 35,113 tests passed, 0 failed** in 429 s, `success: true` (`_scratch/test-run.pid-4036.log` / `_scratch/test-results.pid-4036.json` in the worktree; the SEA cases pass on this runtime, as the round-1 re-check required).

**Scope:** three files — `loop-past-runs-panel.component.ts` (the Copy button's reason binding + `copyDisabledReason`), `loop-past-runs-panel.component.spec.ts` (one source pin + three rendered cases), `plan-queue-coordinator.spec.ts` (eight `vi.waitFor` timeouts, no assertion change). No wording-ledger, baseline or copy change. No new livetest item: both fixes are verified in-loop (the keyboard/activation behaviour by the rendered cases and the verifier's probe; the flake fix is a test-only patience change). No commits, stashes, branches or worktrees were made; no runtime, dependency install or copied source tree was created, and the temporary probe files were deleted.

**Plan status:** the acceptance checklist above is unchanged (parts 1a–1h stay implemented; the fresh-eyes gate PASS and the live checks remain the verifier's / James's).

> Plan Queue parked work: `queue/2026-10-10-oct-phase4b-tooltip-6a2506` — 4 commit(s), reason: round-limit.

### Resumed checkpoint verification and handoff (27 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-a7d5c4`)

**Starting state and scope.** `git log` and the merge-base diff show the coordinator's paused checkpoint `ec64e794f` already contains all eight migrations on base `d21fdce4b` (93 changed files). The worktree started clean. The root plan and livetest were already tracked and modified on arrival; that existing lifecycle state was preserved without staging or renaming. This plan is still edited only at its original root-checkout absolute path; there is no separate linked spec. Contrary to the dispatch's description, a tracked version of the plan already exists in the worktree too; it is unchanged versus HEAD and was neither copied nor edited by this worker. The 25 Oct receipts and source were re-read, rather than treating older checkout results as current evidence.

**Remaining implementation work.** The 25 Oct size-check log failed on the session-list component, but the paused checkpoint already contains the later header-comment compaction: the current size check passes. No further component or test edits were needed. Re-running `generate:architecture` now that the migration files are tracked refreshed `docs/generated/architecture-inventory.json`: changed source/spec line counts and ordering, plus the loop-config spec entering the large-file list. The generator's `--check` and its targeted spec pass. `generate:aliases` and `generate:ipc` produce no drift. No generated file was edited by hand, and no IPC channel or dependency was added.

**Current acceptance and evidence.** Source references below are relative to the assigned worktree. All named specs ran in the fresh focused commands, with the test cache disabled.

| Part | Status | Executing source and regression coverage |
|---|---|---|
| 1a Settings menu | Implemented; focused checks pass | `settings.component.html:92`/`:114` bind squeeze-only names/status; `settings.component.ts:204` shares the icon-only definition. `settings-nav-hints`, `settings-nav-label`, `settings-local-state` and the existing settings component specs pass. |
| 1b Left icon bar | Implemented; focused checks pass | `workspace-rail.component.ts` uses live shortcut inputs and expanded-state hints; its spec exercises real `KeybindingService` rebinding on a non-Mac platform and keyboard focus. The Sidechats Shift+F10 exemption is a fixed local-menu key, not a registry shortcut. |
| 1c Top bar | Implemented; focused checks pass | `app.component.html` and the six chip components import/bind the tooltip directives; shell/chip specs and the pause focus case pass. Native Electron drag-region interaction remains a live check. |
| 1d Message box and queue | Implemented; focused checks pass | `composer-queue.component.html:12` renders the crash-loss sentence; `composer-banners.component.ts:137` renders write-access consequences. The textarea, voice, Hardened/Fence, Send/Stop and context-ring cases pass. The persistence-ack regression confirms the warning clears. |
| 1e Session list | Implemented; focused checks pass | The list template carries filter state, archive consequences, focusable clock and overflow hints; sidebar/dashboard shortcuts and sidechat focus restoration are covered. The whole instance-list directory passes. |
| 1f Session header | Implemented; focused checks pass | `instance-header.component.html:42` shows wait detail as visible text; header focus, no-title and shortcut cases pass. |
| 1g Loop | Implemented; focused checks pass | `loop-toggle.component.ts:25`/`:139` keep the no-folder reason focusable while preserving Stop on an active loop. The track cannot steal hover; require-rename, expanded Show/Hide and missing-prompt Copy/Reattempt regressions pass. |
| 1h Plan queue | Implemented; focused checks pass | Start/Submit explain lasting disabled states. Pause uses corrected registry copy, and `plan-queue-run-hold.spec.ts` pins session termination, checkpoint and requeue on pause. Basename paths are keyboard reachable. |

**Runtime traces rechecked.** Durability acknowledgement runs through `queue-persistence.service.ts:200` → `setDurabilityFlag:244`, which replaces the queue array while retaining entry identity. The chain is `instance-messaging.store.ts:160` → `instance.store.ts:789` → `instance-detail.component.ts:479` → its template `:318` → `input-panel.component.html:592` → `ComposerQueueComponent.hasNotSaved:40`. Pause runs through `plan-queue-run-control.ts:28` → the coordinator's `holdRun` wiring `:442` → `flow.hold`/`holdItem`, which stops writers before checkpointing and requeuing. These are executing call paths, not merely matching definitions.

**Fresh command results.** All run under the repository-pinned Node v24.22.1. Receipts and full command logs are in `_scratch/phase4b-resume-20261027/` in the assigned worktree; test-result JSONs named by the logs confirm `success: true`, with no failed tests.

- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`, `npm run build:renderer`: all exit 0. The renderer retains the initial-bundle budget warning (1.63 MB versus 1 MB); the build succeeds. The size checker reports existing tolerance notes without violations.
- Targeted tests: instance-list **9 files / 113 tests**; changed migration specs plus queue-state and UI-hint tooling **62 files / 829 tests**; tooltip foundation, existing settings/composer-toolbar callers and architecture-generator spec **10 files / 214 tests**. All exit 0. These runs overlap; they are not a unique-test total.
- `generate:aliases`, `generate:ipc`, `generate:architecture` and `node scripts/generate-architecture-inventory.js --check`: all exit 0.
- `audit:ui-hints --json` and `check:ui-hints --against main`: exit 0. Across all **39 changed renderer owners**, H1a/H1b/H2a/H2b/H3/H4/H5/H10/H12 findings are empty. The two session-list dialog-heading `title` inputs remain the listed component-input exceptions. Recorded whole-branch drops versus this base: H1a **24→22**, H1b **91→63**, H2a **210→133**, H2b **138→106**, H3 **20→9**, H4 **135→104**, H5 **12→4**. H11 remains 8 and H2c remains 32. Current wording ledger: **208 entries, 3 retired**; the historical 209/4 figures belong to the parked branch that first introduced then retired the false Pause sentence, not this branch.
- The first scratch audit-summary script used the wrong JSON property (`counts` instead of baseline `rules`) and exited 1 after the audit and guard themselves passed. Correcting that evidence-only script produced `audit-summary.json`; no source, record or test was changed to obtain a pass. Both attempts are recorded in the receipts.

**Review and remaining gates.** A fresh review of the committed diff found no unresolved actionable issue. The diff-forensics record finds no new skipped/focused tests, forced-success exits, type/lint suppressions, TODO stubs, dependency changes or test/compiler/lint configuration changes. The measurement-canary update now asserts the migrated controls are named while still proving the scanner detects nameless controls elsewhere; assertions were not weakened to hide a failure. Per-part focus regressions and visible-warning changes were checked against the saved old strings. This is the worker's review, not an independent gate verdict: the fresh-agent spawn failed with `invalid thread-store request: no rollout found`, so no fresh agent ran. The independent queue verifier must still run the full suite and return PASS for tier A, tier B and the whole plan. No full suite was run by this worker, as expressly instructed. Live Electron, real keyboard/hover timing and assistive-technology checks remain in `2026-10-10-oct-phase4b-tooltips-migration_livetest.md`; its macOS-only item still requires task-specific Mac permission.

**Handoff checklist.**

- [x] 1a–1h implemented and freshly checked as mapped above.
- [x] Worker targeted/static/build/generator gates pass; generated inventory current.
- [x] Current report, readiness seal and command receipts retained under `_scratch/phase4b-resume-20261027/`.
- [x] Existing live-test document retained with explicit outstanding checks.
- [ ] Independent queue-verifier PASS and full suite: intentionally open for the next queue stage.
- [ ] Live checks: pending the coordinator-integrated application and the prerequisites in the livetest document.

**Ownership and cleanup.** No commit, stash, branch/worktree operation, database/settings write, browser session, dependency install, database cluster, browser binary or copied source tree was created. Pre-existing provisioned dependencies and build directories are retained. No task-owned runtime or compile cache remains. The only tracked worktree change from this resume is the generated architecture inventory; root planning documents stay active and the coordinator retains their final rename, backlog closure, commit and integration.

> Plan Queue parked work: `queue/2026-10-10-oct-phase4b-tooltip-a7d5c4` — 3 commit(s), reason: verifier-unreliable.

### Resumed assigned-checkout verification and handoff (28 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-6a2506`)

**Starting state.** The worktree starts clean at `390a82e5bc2231b067e0d64d7476f0e0416805ee`; `git log` and the 93-file shared-base diff against `2b949b0dfedd718b74aa532a22f7219efcc9d4b8` contain all eight migrations and the earlier verifier remediations. The foundation is present: both audit/guard scripts, the icon-button directive and the disabled-reason, shortcut and show-when-expanded APIs. The old missing-foundation decision is therefore resolved here without creating duplicate tooling or importing another branch. No separate linked spec exists. The root plan and livetest were already tracked and modified on arrival; that lifecycle state is preserved. This plan was read and edited only at its original absolute root-checkout path. The tracked worktree copy was neither copied nor edited.

**Remaining work and decisions.** No further product-source or test edit was needed. The generated architecture inventory was stale after earlier coordinator commits; `generate:architecture` refreshes its indexed line counts, entries and ordering, including migration files and previously merged documents. Its `--check` and focused generator spec pass. Alias and IPC generation produce no drift. No IPC channel or dependency declaration changed.

**Dependency mismatch reproduced and repaired.** The provisioned worktree install contained Vitest 4.1.12 despite lockfile 3.2.7; it also had incompatible MSAL types and no `extract-zip`. The initial focused runner exited 1 before tests started (`vitest/vitest.mjs` not exported), and both initial type checks exited 2. These failed attempts remain in the receipts. `npm ci --ignore-scripts --no-audit --no-fund` restored the repository's existing locked dependencies, without changing the manifest or lockfile. Every final gate below then passed. Native installation hooks were not required for this focused test/build scope; packaged/native smoke tests were not run.

**Current acceptance, all re-executed in the focused run:**

| Part | Current status | Evidence covered |
|---|---|---|
| 1a Settings menu | Implemented; focused checks pass | Squeeze-only names/status, expanded-toggle hints, local storage helpers and existing settings callers. |
| 1b Left icon bar | Implemented; focused checks pass | Live History/Sidechats/Settings bindings, non-Mac Ctrl wording, expanded-panel hints and focus. |
| 1c Top bar | Implemented; focused checks pass | Shell, all six chip components and keyboard-focus tooltip opening. Native drag-region interaction remains live. |
| 1d Message box and queue | Implemented; focused checks pass | Message/voice names, voice/Hardened/Fence reasons and blocked activation, Send/Stop shortcuts, visible warning/consequence text and acknowledgement clearing. |
| 1e Session list | Implemented; focused checks pass | Filter state, archive consequence, focusable automation clock and sidebar shortcuts; whole instance-list test directory. |
| 1f Session header | Implemented; focused checks pass | Wait detail is visible text; header hints, shortcut and focus regressions. |
| 1g Loop | Implemented; focused checks pass | No-folder and rename reasons, Stop with an active loop, decorative track, expanded Show/Hide and missing-prompt Copy/Reattempt focus/activation cases. |
| 1h Plan queue | Implemented; focused checks pass | Start/Submit reasons, basename-path focus, corrected Pause words and runtime stop/checkpoint/requeue behavior. |

**Executing paths rechecked.** Durability acknowledgement in `queue-persistence.service.ts:175` calls `setDurabilityFlag:219`, publishing a fresh queue array while preserving entry identity. `instance-messaging.store.ts:172` exposes that array, `instance-detail.component.ts:479` derives the input, and `ComposerQueueComponent.hasNotSaved:40` responds to its identity. The rendered persistence-acknowledgement regression passes. Pause routes through `plan-queue-run-control.ts:28-31` and the coordinator's `holdRun` wiring at `plan-queue-coordinator.ts:426-429` to `flow.hold`/`holdItem` (`plan-queue-run-hold.ts:16`): stop writers, checkpoint and requeue. Its runtime regression passes alongside the coordinator suite.

**Fresh gates, pinned Node v24.22.1.** Focused `test:quiet`, cache disabled: **51 files / 848 tests pass, 0 failed, 0 pending**, exit 0 (`_scratch/test-results.pid-40249.json`, `success: true`; raw log `_scratch/test-run.pid-40249.log`). The command includes every changed spec plus tooltip foundation, the full instance-list directory, existing settings/composer-toolbar callers and the architecture-generator spec. Both type checks, lint, size guard, tooltip guard, both production builds, all three generators and architecture `--check` exit 0. The renderer retains the existing initial-bundle warning (1.48 MB versus 1 MB); it builds successfully.

The normal main-build prehook refreshed the unrelated Codex protocol snapshot from the locally installed CLI. That environmental diff is saved in the evidence folder, original bytes were restored, and `npm --ignore-scripts run build:main` then successfully recompiled the committed snapshot through the complete main-build command. No protocol drift remains in the worktree.

**Audit and review.** All 39 changed renderer owners read zero for H1a/H1b/H2a/H2b/H3/H4/H5/H10/H12; the two session-list dialog-heading inputs remain intentional exceptions. `check:ui-hints -- --tighten --record-wording` passes without modifying either record. Shared-base drops: H1a 24→22, H1b 91→63, H2a 210→133, H2b 138→106, H3 20→9, H4 135→104, H5 12→4. Current ledger: **209 entries, 4 retired**, matching this branch rather than the other checkout's 208/3. The shared-base comparison passes. A direct comparison against today's moving `main` fails on later plugin-page baseline changes and four later wording retirements that are absent from this older checkout; those unrelated records are not rewritten here. AIO retains base synchronization and integration.

The worker reviewed the migration and generated diff and applied the screen-and-wording guide; no unresolved actionable finding was found in that review. Added-line scans find no new focused/skipped tests, forced-success exits, type/lint suppressions or unfinished stubs. No manifest, lockfile or test/compiler/lint configuration changes occur. The measurement-canary change pins named composer controls while retaining a positive detection assertion elsewhere; timeout changes retain the original assertions. This is worker review, not an independent verdict. Headless focus-visible simulations do not prove actual native Tab order, hover timing, Electron drag regions or screen-reader announcements.

**Handoff and evidence.** Current report, SHA256 seal, consolidated command receipts, audit JSON/summary, exact migration diff and command logs are in `_scratch/phase4b-resume-20261028/` in the assigned worktree. Initial failed dependency checks and the unsuccessful direct-to-current-main comparison are retained separately, not presented as successes.

- [x] All eight migrations implemented and freshly checked in this assigned checkout.
- [x] Worker focused/static/build/generator gates pass; generated inventory is current.
- [x] Worker diff review and evidence report/seal/receipts written.
- [x] Existing live-test document retained unchanged with its outstanding checks.
- [ ] Full suite and independent task-completion-gate PASS for both tiers and the whole plan: intentionally assigned to the next queue stage.
- [ ] Live app checks: remain pending in `2026-10-10-oct-phase4b-tooltips-migration_livetest.md`, including task-specific Mac authority for its macOS-only item. No browser/desktop check or current worker-health claim was made here.

**Ownership and cleanup.** No commit, stash, branch/worktree operation, app/database/settings write, browser session, database cluster, browser binary or source-tree copy was created. After writing the report, receipts and seal, the replacement task-owned dependency installation and newly created production output/compile caches were removed; `cleanup-receipt.json` records exact paths and absence checks, and the seal covers that receipt. The verifier will require its own lockfile install. Small evidence remains. The generated architecture inventory is the only tracked worktree change; root planning documents remain active. Coordinator-owned full verification, document rename, backlog closure, commit and integration are not performed by this worker.

### Resumed merged-checkpoint verification and handoff (28 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-a7d5c4`)

**Starting point and remaining work.** The assigned worktree started clean at `107bf54a16b3243c505787a92d605fb35d44f859` (coordinator merge of main). The current merge base is `80412201a07ec93cefb9a4b6ddb06579ad314d75`; the 94-file migration diff already contains all eight parts and their earlier remediations. The sibling checkout's 28 Oct claims were not used as evidence for this checkout. No further product-source, test, dependency or generated edit was needed. Alias, IPC and architecture generators are current and produce no diff. No separate linked spec exists. This plan was read and edited only at its original absolute root path; its tracked worktree copy stays untouched. The root plan and livetest were already tracked and modified on arrival, and that lifecycle state was preserved without staging or renaming.

**Current acceptance, re-executed.**

- [x] 1a Settings: icon-only name/status hints, expanded/compact-overlay suppression, storage helper behavior and focus.
- [x] 1b Left icon bar: live shortcuts, non-Mac Ctrl wording and expanded-panel hints.
- [x] 1c Top bar: shell and all six chip owners, with keyboard-focus regression coverage.
- [x] 1d Composer and queue: Message/voice names; voice, Hardened and Fence focusable reasons and blocked activation; Send/Stop chips; visible crash-loss/write-access consequences; persistence acknowledgement clears the warning.
- [x] 1e Session list: filters-on name, visible archive consequence, focusable automation clock and sidebar shortcuts.
- [x] 1f Header: visible wait detail, overflow hints, Interrupt shortcut and focus.
- [x] 1g Loop: no-folder/rename/Copy/Reattempt reasons, running-loop Stop preserved, decorative track and expanded Show/Hide regressions.
- [x] 1h Plan queue: Start/Submit reasons, keyboard-reachable paths, corrected Pause copy and runtime stop/checkpoint/requeue regression.

**Fresh worker gates, pinned Node v24.22.1.** Initial focused run: 4 files / 32 tests pass. Final focused run: **50 files / 755 tests pass, 0 failed, 0 pending**, cache disabled; includes all changed specs plus tooltip foundation, instance-list, existing settings/composer-toolbar callers, Pause run control and architecture-generator regression. Counts overlap and are not additive. Both type checks, lint, size guard, tooltip guard, production main/renderer builds, all three generators, architecture `--check` and migration `git diff --check` exit 0. Renderer retains the existing initial-bundle warning (1.63 MB versus 1 MB). The main prehook regenerated the unrelated Codex snapshot from the machine's CLI 0.165.0; that drift was saved in evidence, original committed bytes restored and hash-checked, then the full main compile/asset-sync/preload command passed again using `npm --ignore-scripts run build:main`. No protocol drift remains.

**Records and runtime evidence.** All 39 changed renderer owners have zero H1a/H1b/H2a/H2b/H3/H4/H5/H10/H12 findings. Tightening/wording recording and comparison with this merge base pass without record changes. Base-to-branch drops: H1a 24→22, H1b 91→63, H2a 210→133, H2b 138→106, H3 20→9, H4 135→104, H5 12→4. Current ledger is **208 entries, 3 retired** (the sibling branch's 209/4 figures do not describe this checkout). The two session-list dialog-heading inputs remain the listed title exceptions. The durability path is `queue-persistence.service.ts:200` → `setDurabilityFlag:244`, preserving entry identity while replacing the queue array; `instance-messaging.store.ts:160` and `instance-detail.component.ts:479` feed `ComposerQueueComponent.hasNotSaved:40`. Pause routes through `plan-queue-run-control.ts:28` → coordinator `holdRun:445` → item-flow `holdItem` wiring → session termination before checkpoint/requeue. The rendered acknowledgement and hold regressions pass.

**Review and evidence.** Worker diff/wording review and a genuinely fresh read-only review using task-completion-gate source checks found no actionable source issue. Added-line scans show no focused/skipped tests, forced-success exits, suppressions, unfinished stubs or manifest/lock/config changes. Assertion migrations retain behavioral checks and the measurement canary retains positive detection coverage. The fresh report contains per-part source/test mapping; this is not final Gate 0 or a whole-task PASS. A failed inherited-context spawn was resolved by starting a fresh context without inherited history. Report, source hashes, saved old-hover bindings, test JSON summary, consolidated command receipts, logs and SHA256 seal are retained in `_scratch/phase4b-a7d5c4-resume-20261028/`.

- [x] All eight implementations and worker focused/static/build/generator gates freshly checked.
- [x] Worker review and fresh independent source review: no actionable findings.
- [x] Report, receipts and seal written; task-owned generated runtime removed with a cleanup receipt.
- [ ] Full suite and independent final PASS for both tiers and the whole plan: next queue stage, deliberately not run by this worker.
- [ ] Real Electron/native Tab, hover timing, drag-region and spoken screen-reader checks: pending in the existing root livetest document; its macOS-only item still needs task-specific Mac UI authority. No browser/desktop run or Windows health claim is made here.
- [ ] Coordinator document closure, backlog update, commit and integration: left to the coordinator.

**Ownership and cleanup.** No commit, stash, branch/worktree operation, app/database/settings write, browser session, dependency install, database cluster, browser binary, copied source tree or long-lived service was created. The only new generated runtime was this resume's `dist/`, absent on arrival; it is removed after writing the report, receipts and initial seal. Pre-existing dependencies and caches are retained (their creation timestamps precede this run). `cleanup-receipt.json` records the final absence checks, and the final seal covers it. The worktree has no tracked source or generated change from this resume; only the original root plan is updated, without a completion rename. The existing live-test history remains unchanged.


### Latest base merge conflicts resolved (28 Oct 2026, `queue/2026-10-10-oct-phase4b-tooltip-a7d5c4`)

**Scope and starting point.** The coordinator supplied an in-progress merge of current `main` into checkpoint `107bf54a1`, with five unmerged paths. Read both parent versions and the existing implementation notes rather than restarting the migrations. The root plan is edited only at this original absolute path; no separate linked spec exists. Other pre-staged coordinator merge work is preserved. No worker commit, merge abort, stash, branch/worktree operation, app/database/settings write or browser/desktop action was performed.

**Both sides preserved.**

- `scripts/ui-hints/baseline.json`: retained the migration’s stricter conflicted entries, then ran the official `--tighten --record-wording` workflow. Main’s removal of the obsolete Plugins page reduced H2b 106→102 and H4 104→100. No numeric limit was raised by hand. Comparisons against both `HEAD` and `MERGE_HEAD` pass. Current ledger: 208 entries, 7 retired; main’s existing terminal-move and plugin-removal retirements survive.
- `app.component.html`: preserved main’s deliberate removal of the old title-bar Remote Terminal button and its store-backed drawer wiring, while retaining the migration’s startup/dismiss/Sending hints and keyboard-reachable Sending elaboration. Main’s component no longer defines `showRemoteTerminalButton`; retaining the old button would call a removed member.
- `workspace-rail.component.ts`: retained `AioTooltipDirective` plus `AppIconButtonDirective`, the migration’s live shortcuts/expanded hints and main’s Plan Queue destination, worker-terminal toggle and shared `TerminalDrawerStore`.
- `workspace-rail.component.spec.ts`: retained both parent test blocks, main’s worker-store providers/navigation/drawer cases and the migration’s tooltip/focus/rebinding cases. The initial no-worker rail count changes from eight to nine because main added Plan Queue; its hint is now included in the existing name/content assertions.
- `plan-queue-item-list.component.ts`: retained main’s `computed` import/reactive stronger-worker text and the migration’s tooltip directive/`copyFor` imports, with all status/Skip logic unchanged.
- One required adjacent adjustment: `app.component.spec.ts` removes the obsolete hover-string assertion for the intentionally removed title-bar terminal button and updates its comment. Main’s explicit terminal-relocation/single-drawer test and the rail’s terminal behavior tests remain. No test was skipped or weakened to hide a product defect.

**Fresh verification.** All commands use repository-pinned Node v24.22.1. Before resolution, the three directly affected specs failed (45 of 57 tests), including `showRemoteTerminalButton is not a function` and missing `RemoteNodeStore`; that failure remains in the receipts. After resolution, cache-disabled focused tests pass: 32 files / 455 tests across shell, rail, dashboard, renderer plan queue, tooltip foundation and UI-hint tooling. Architecture generator regression: 1 file / 8 tests pass. Both type checks, lint, size guard, tooltip guards against both parents, renderer production build, main compile/asset sync/preload build, alias/IPC/architecture generators and architecture `--check` all exit 0. Generators leave no extra diff. Main used `npm --ignore-scripts run build:main`, skipping only the unrelated installed-Codex protocol-refresh prehook; the complete declared main-build command ran. Renderer retains its existing 1.63 MB initial-bundle warning.

**Review and merge state.** A genuinely fresh agent used `task-completion-gate` for the scoped resolutions, reviewed both parent comparisons and returned `VERDICT: PASS`, with no actionable findings. It independently reran the three directly affected specs (3 files / 60 tests pass), both-parent tooltip guards and scoped whitespace check. Worker and reviewer applied screen-and-wording guide section 6: All clear. The resolved files contain no conflict markers; `git ls-files -u` is empty; all six resolved/adjusted files exactly match staged blobs; no unstaged change remains; `MERGE_HEAD` still exists. Whole staged `git diff --check` exits 2 solely on whitespace in 16 imported evidence logs that byte-match `MERGE_HEAD`; those unrelated logs were preserved. The scoped six-file check passes.

**Evidence and cleanup.** `_scratch/phase4b-merge-20261028/` holds the report, command receipts (including actual failures), source hashes, both-parent diffs, test JSON summary, merge-state receipt, independent review and SHA256 seal. After the report/initial seal were written, task-created `dist/` was removed; `.angular/cache` remains absent. Existing dependencies and `node_modules/.vite` predate this work and are retained. No dependency installation, database cluster, browser binary, copied checkout or long-lived service was created. `cleanup-receipt.json` records absence checks; the final seal covers it.

- [x] Resolve and stage all five conflicts, keeping both parents’ intent and the required adjacent test adjustment.
- [x] Focused tests, fast static checks, tooltip records, production builds and generator verification pass.
- [x] Fresh independent scoped resolution review PASS; evidence and cleanup recorded.
- [ ] Full test suite and final independent verdict for the eight-part migration: intentionally left to the queue verifier, as instructed.
- [ ] Existing real Electron/native keyboard/hover/drag-region/screen-reader checks: remain in the root livetest document, unchanged. No new live check introduced.
- [ ] Coordinator merge commit, plan rename, backlog closure and integration: not performed by this worker.
