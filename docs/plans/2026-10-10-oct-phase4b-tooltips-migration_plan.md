# October Phase 4 (part 2 of 3): migrating the main screens

**Status:** active plan, dependency-blocked after verification-round-3 investigation on 12 Oct 2026; 0 of 8 migration parts implemented, verifier finding 1 unresolved. Current coordinator status confirms Part 1 has verifier PASS but is parked (`land-blocked`) because the root checkout has uncommitted changes to `package.json`. Its foundation checkpoint remains absent from the supplied migration worktree. This is not a verifier-ready implementation; the parent session must reconcile the root changes, let AIO land the prerequisite, and refresh this migration checkout before retrying. Written 2026-10-10. Keep this file untracked until every part is implemented and
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
5. **The plan queue's Pause says what it really does:** it stops anything new from starting, and work already running carries on.

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
   - Plan-queue Pause says "Stops anything new from starting. Work already running carries on until it finishes." That
     is what the code does.
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

**Live checks:** (Windows PC, rebuilt app) collapse the Settings menu; hover three icons (one with a badge, such as Provider Quota when usage
is high); Tab through them; expand the menu and confirm no bubbles; narrow the window to the compact layout and repeat. jsdom cannot prove that
Chromium's `display: none` handling matches the spec's computed-style check.

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

**Live checks:** (Windows PC) rebind History to another key in Settings → Keyboard: the chip changes. Windows shows "Ctrl", never "Win".
Hover and Tab each button. Tools & Views keeps its hint while the panel is open.

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

**Live checks:** (Windows PC) hover each chip inside the draggable area; the hint appears. If any does not, record it; the bridge from step 1
covers the rest.

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

**Live checks:** (Windows PC) hover and Tab each control. The not-saved line appears only while a save is pending or has failed, so the spec proves it;
it is not forced live. Tab to the voice button when voice is unavailable: the reason appears and Enter does nothing.

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

**Live checks:** (Windows PC) hover and Tab the filter, sort, options and project buttons; check the archive confirm text; rebind New session and watch the
chip follow.

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

**Live checks:** (Windows PC) hover and Tab every header control; put a session in a waiting state and read the reason without hovering.

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

**Live checks:** (Windows PC) with no folder picked, Tab to the Loop switch: the reason appears and Space does nothing. Pick a folder: the switch works.

### 1h. The plan queue (S-M)

**For James:** the plan queue's buttons say what they do. Pause says it only stops new work from starting, and the Start and Submit buttons say why they are
greyed out.

**Needs first:** Phase 2's step 5 (the Plan Queue page, backlog B9), which itself needs Phase 2's step 4 (parts 4d and 4f). Step 5 rewrites these controls and the
item list ("Skip asks first", a status word, "Round N of M").

**Verified (10 Oct):**
- 11 plan-queue templates under `features/plan-queue/` have 0 `appTooltip` and 5 titles (item list 1, parked list 1, question list 2, run list 1), across about 24
  controls.
- **What Pause really does.** `plan-queue-coordinator.ts:477-492` starts triage, queued documents (`startItem`) and verifications (`startVerification`) only
  inside `if (run.status === 'running')`. `reconcileWaitingDocuments` (`:473`) runs for paused runs too, and nothing in `src/main/plan-queue` stops running workers
  when a run is paused (the only `'paused'` writes are the pause and resume actions, `:388-389`, and `:569`). So the true copy: Pause stops anything new from starting;
  work already running carries on. Cancel already confirms inline (`plan-queue-run-controls.component.html:2-7`); the parked-item actions confirm too
  (`plan-queue-parked-list.component.html:15-30`).

**Change:** a registry section `planQueue.*` in the new `tooltip-copy-plan-queue.ts`:
- Pause: "Stops anything new from starting. Work already running carries on until it finishes."
- Resume: "Lets new documents and checks start again."
- Cancel (already confirms inline); parked-item Resume, Land anyway and Discard (confirms exist); Skip; Refresh.
- Start run and Submit: lasting disabled reasons from `!canStart()` and `!selectedOptionId()` through `appTooltipDisabledReason`: "Choose a parent session first." and
  "Pick an answer first."
- The run-list and question-list titles become `appTooltip`.
- Wording for Skip, Land anyway and Discard is written together with Phase 2's pass.

**Tests:** `plan-queue-run-controls` spec: "Pause has a tooltip saying running work carries on" (fails today); "Start run shows its reason while it cannot start".

**Live checks:** (Windows PC) with a run active, hover Pause and Resume; with nothing chosen, Tab to Start run and read the reason.

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

These need the rebuilt app, a person, or the Windows PC. They are listed under each part. When the code is done, move them into
`docs/plans/2026-10-10-oct-phase4b-tooltips-migration_livetest.md` with the standard header:
- prerequisites (rebuild, restart, and which instance);
- a link back to this plan;
- the remediation-flow paragraph pointing at `livetest-campaign-runbook.md` and `livetest-remediation-register.md`.

Then leave a one-line pointer here. Screen checks run on the Windows PC, or on the Mac only with James's OK. Each part's live checks are recorded as that part finishes.
Include the two checks that part 1 could not run because nothing there used the building blocks yet: the shortcut chip (part 1's step 5c, run on 1b, the rail) and the
reasons on greyed-out buttons (part 1's step 5d, run on 1d, the voice button, and 1g, the Loop switch). The livetest doc is itself a plan: it is renamed
`_livetest_completed.md` only when every check passes with evidence.

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

- [ ] 1a Settings menu
- [ ] 1b Left icon bar (also runs part 1's 5c checks)
- [ ] 1c Top bar
- [ ] 1d Message box and queue (also runs part 1's 5d checks)
- [ ] 1e Session list
- [ ] 1f Header leftovers
- [ ] 1g Loop switch, setup panel, past runs (also runs part 1's 5d checks)
- [ ] 1h Plan queue
- [ ] Final gates
- [ ] Fresh-eyes gate PASS (tier A, tier B, whole plan)
- [ ] Livetest doc created
