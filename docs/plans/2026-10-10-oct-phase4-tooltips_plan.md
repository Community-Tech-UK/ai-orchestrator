# October Phase 4 (part 1 of 3): tooltips foundation

**Status:** all nine implementation steps and verification-round-1 remediation are ready for independent queue re-verification in `queue/2026-10-10-oct-phase4-tooltips-1b2e67` (12 Oct 2026). Worker-authorized verification passes with a worktree-owned dependency install. The coordinator owns the remaining full-suite acceptance, overall PASS and `_completed` rename; native/provider/human checks are separately deferred in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), not claimed as verified. Written 2026-10-10. Keep this file untracked until every step is implemented and
verified (see [Finishing](#finishing)). This is part 1 of 3. The second review on 10 Oct 2026 recommended splitting the
single Phase 4 plan so that each part can close on its own. This file builds the tools.
[Part 2](2026-10-10-oct-phase4b-tooltips-migration_plan.md) migrates the main screens, and
[part 3](2026-10-10-oct-phase4c-tooltips-finish_plan.md) migrates the rest and switches the lint rules on.

**Source:** the "Phase 4" row of the approved backlog [`claude_oct-todo.md`](../../claude_oct-todo.md) (James approved
it on 10 Oct 2026 and answered decisions 1-7). The row reads: "4: tooltips everywhere (rolling) | D1b (after D1), D2 →
D3 → D4 → D5 tiers → D6 → D8 → D7 → D9 → D10 | Measure, ratchet, building blocks, then migrate one surface per change".
Section D of the backlog holds the items (D1b to D10; D1 itself is Phase 0 step 5, and D11 is a later item). This part
covers D1b, D2, D3, D4, D6, D7, D8, D9 and the plug-in half of D10. Part 2 covers D5's tiers A and B, and part 3 covers
D5's tiers C and D and the lint switch-ons.

**How it was checked:** on 10 Oct 2026, three read-only checks re-traced every D item against the working tree (HEAD
`04b6db59b` plus other sessions' uncommitted work). Their reports are `p4-a.md` (D1b, D2, D3, D10), `p4-b.md` (the D1
follow-ups, D4, D5) and `p4-c.md` (D6, D8, D7, D9) in `_scratch/oct-phases/`, which is gitignored and disposable; this
plan carries what an implementer needs. While merging them, the plan writer re-ran the key counts (393 titles in 132
files, 100 tooltip hosts in 30 files, no `MutationObserver`, `hostDirectives` and `resolveIconButtonAria` unused), re-read
the directive, the dead tooltip, the Windows shortcut label, the Settings menu, the queue, rail, composer, plan-queue and
loop sources, the transcript builders, the review prompt builders, the ratchet script and every file's headroom, and read
the Phase 0 plan for overlaps. That turned up five conflicts, between the reports or between a report and the Phase 0
plan: a stale loop hint that Phase 0 already fixes; seven transcript strings that the "delegated listener" does not cure;
a shortcut rule with no way to keep one local key; an inert-tooltip check with no rule to live in; and a wrong size
figure. Each is settled where it arises and recorded under [Corrections to the backlog](#corrections-to-the-backlog),
[Not in this plan](#not-in-this-plan-and-where-it-goes) or [Found on the way](#found-on-the-way-not-fixed-here).
A second, fresh review the same day (`_review2-phase4.md` in the same folder) found 4 must-fix and 15 should-fix points
and recommended the split; they are all applied here and in parts 2 and 3, and its resolution log says where.
**Line numbers are as of 10 Oct and will move. Re-read the code before editing.**

**Size:** large but finite. Steps 1 to 8 are about 22 separate changes of size XS to M: the quick bridge, the honest counter,
the guide, the guard, the building blocks, the glossary, help and the reviewer check. Step 9 is one medium change, the lint
plug-in, shipped with every rule off. The screen-by-screen migration (about 14 further changes) is in parts 2 and 3, and so
are the four one-line lint switch-ons that wait for it. Sizes use the backlog's XS-L scale. First: steps 1 (the bridge), 2
(the counter) and 3 (the guide) share no files and can start at once (step 3 as soon as Phase 3's C5 to C7 have landed).

**Depends on:**
- **The Phase 0 plan** ([`2026-10-10-oct-phase0-confirmed-fixes_plan.md`](2026-10-10-oct-phase0-confirmed-fixes_plan.md)).
  - **Step 5 (D1, tooltip directive fixes)** before steps 1 and 5 (and before part 2's 1a). They reuse its `visibleTextOf`, its
    template panel and its `appTooltipFormat` input.
  - **Step 9 (A14, second opinions)** before step 8. Both edit `review-prompts.ts`.
  - Step 2.6c (it wires `loop.recycleToggle` and already fixes the stale "50KB" recycle hint) before 6c. Step 1 (B4,
    the loop end states) before 7d.
  - Steps 2.6a, 3, 8 and 10 add a few tooltips of their own. This phase leaves them alone and re-reads them when it
    reaches the same file.
- **Phase 3 (calm screen):**
  - C5, C6 and C7 (banner rule, status words, word list as code) before step 3. C7 before step 6.
  - C2 and C8 (the new header) before 7c.
- **Phase 2 (loops converge):** B2 and B3 before the finish-rule wording in 7d. Phase 2's part 9e moves the loop setup panel's
  default constants out first; if it has landed, step 7a is skipped.
- **Files shared with Phases 1 and 5** (no hard order; whichever lands second carries the other's change): Phase 1's A13
  (the RTK Savings tab, with 6c), Phase 5's C13 (the transcript click listener, with 7b) and Phase 5's C12A (the session
  list's archive code, with 2b).
- **What comes after:** parts 2 and 3 need this part finished first (the guard, the building blocks and the glossary).
- **A request to every earlier phase, and to Phase 3 if it lands after step 4c:** until the guard in step 4 exists, write
  new controls with `appTooltip` and an `aria-label`, and add no new `title=`. Anything else becomes debt in the first
  record, which then starts larger than it was on 10 Oct. Once the records exist (4c), any change that touches a template
  or rewords a recorded hover sentence runs `npm run check:ui-hints -- --tighten` and, for a reworded sentence,
  `--retire` with a reason. This matters most for Phase 3's big template changes (C2, C4, C8, C9, C10 and C11). If there
  is a choice, write the records (4c) after those have landed.

---

> **Coordinator handover (13 Oct 2026, Plan Queue parent).** The complete prior implementation for
> this plan is on the parked branch `queue/2026-10-10-oct-phase4-tooltips-1b2e67` (125 files vs `main`);
> it is not on `main`, and a fresh worktree cut from `main` does not contain it. Before anything else,
> bring that branch's content into your worktree (`git merge --squash queue/2026-10-10-oct-phase4-tooltips-1b2e67`,
> or `git diff $(git merge-base HEAD main) queue/2026-10-10-oct-phase4-tooltips-1b2e67 | git apply`),
> reconcile it with the as-built notes below, then finish the remaining unchecked items — do not
> reimplement from scratch. Delete this handover note once the port is in place.

## In plain English (what James will notice)

This part builds the tools. The screens themselves are migrated in the next two parts: the main screens in part 2, the
rest in part 3.

1. **Every hover hint looks and behaves the same.** About 360 buttons, icons and labels still show the browser's slow
   grey bubble. They will show Harness's own tooltip instead, after about a fifth of a second on a button, and also when
   you move to them with the Tab key. The words do not change, so no warning can go missing. About 30 hints on whole
   cards and dialogs keep the old bubble for now.
2. **One hover hint that never worked now works.** The small dot that marks a finished conversation you have not opened
   yet, in the history list, was meant to say "Completed — click to view". A missing line of code switched it off.
3. **The check that counts missing hints becomes honest, and then strict.**
   - Today's check says "no problems" while about 25 buttons have no name at all and about 100 more have no hover hint.
     A new counter reads every screen the way the app itself does. Its first report will look worse. That is the point.
   - Then a guard in the build lets the number of problems go down and never up. It also stops any warning sentence it has
     recorded from quietly disappearing when someone rewords a hint, including sentences written in a screen's own code,
     such as the Close session button's. It cannot protect a sentence nobody has recorded, so each later change records its
     new ones.
4. **Shortcut hints show your real keys.** On Windows and Linux, the Keyboard page and the command palette say "Win+H"
   for a shortcut that needs Ctrl+H. They will say Ctrl. Hover hints will show whatever keys you have set, and follow
   you when you change them.
5. **Buttons that stay greyed out can explain why.** For a lasting reason, such as no working folder chosen, the button
   stays greyed, ignores clicks, and says why when you hover it or reach it with Tab. The first buttons to use this are in
   part 2.
6. **Screen readers say a button's name once, not twice.** Nothing changes on screen.
7. **Hard words get a dotted underline.** Words such as "worktree", "steer" or "fast mode" show a short plain
   explanation on hover or Tab. Selecting one opens a side panel listing every word Harness uses, scrolled to that word.
8. **A small "?" on the loop panel and on the session header opens help right there.** The loop help is rewritten in
   everyday words, and file names in the conversation can be reached with the Tab key.
9. **One page of house rules for screens and wording.** The instruction file every coding agent reads points to it, so
   new screens stay calm. Reviewers also check screen changes against it. Those notes are advice and never stop a loop.
10. **Later, the editor's style check catches the same mistakes as you type.** The checking code ships now with every rule
    switched off. Each rule switches on (in part 3) only when its leftover count reaches zero, and a test makes sure that
    switch-on is not forgotten.

## Decisions this plan follows

From James (10 Oct 2026 unless stated):
- The product name on screen is **Harness** (Decision 1). All new wording says Harness.
- **Keep James's personal setup in machine-started sessions** (Decision 2). Nothing here removes any of it. The guide
  reaches agents through one short sentence in the repo's instruction file. It is not imported into every session.
- The backlog's own rule for this phase: fix the directive, measure honestly, ratchet, then migrate one surface per
  change. A mass swap of `title=` attributes once lost a destructive-action warning, so wording only moves by the recipe
  in part 2 (step 1).
- Screen checks run on the Windows PC, or on the Mac only with James's OK. No branches or worktrees. Commit only when
  James asks.

Choices made while planning. Each is the recommended default, none blocks starting, and James can change any of
them. Visible changes have their own entries (1 to 7); the rest are about how the work is done (8 to 12). One change
since the first draft: Phase 4 is now three plans (this is part 1 of 3), so each part can close on its own. That replaces
the earlier choice that the whole phase "stays open until the strict counts reach zero". Only part 3 waits for the counts.
1. **About 360 existing browser-style hover hints switch to Harness's own tooltip at once, with no wording changed
   (visible).**
   - Buttons and icons wait about 0.2 seconds. Plain text and truncated labels wait 0.6 seconds, so lists stay calm.
     Tab shows the hint immediately. Touch screens keep the old behaviour.
   - Clicking, pressing Escape or scrolling that area hides the hint and keeps the grey bubble from popping up in its place
     until the pointer moves away. Where one hinted thing sits inside another, the innermost hint wins and the outer grey
     bubble stays hidden. Scrolling somewhere else on the page leaves an open hint alone.
   - A button with no name is given its hint as a temporary name while it is hovered.
   - About 30 hints on whole cards and dialogs are left alone for now. On those six shared components, the setting called
     "title" is a heading, not a hover hint. A later change (part 3) renames it, which removes the accidental whole-card
     bubble if it exists.
   - Alternative: wait for the screen-by-screen work. Why: it is the quickest way to improve every remaining hover
     without touching a single word.
2. **The "Completed" dot in the history list gets the hover hint it was always meant to have (visible).** The list never
   loaded the tooltip tool, so the hint did nothing. Alternative: leave it. Why: it is a one-line fix, and the new
   counter would otherwise start with a failure.
3. **Shortcut hints show your real keys, and Windows and Linux say Ctrl, not Win (visible).**
   - Hints read the key currently set, show nothing if the action has no key, and follow a rebind with no reload.
   - A few hints are not rebindable shortcuts: the diff viewer's own Esc, the commit box's Command/Ctrl+Enter, and
     Command/Shift-click. They keep their own wording, with a platform-aware key name or a recorded reason (the one that stays literal, the diff
     viewer's Esc, is marked in step 4b).
   - Alternative: make them rebindable actions. Why not: it adds a settings surface for no gain, and Esc is the same on
     every platform.
4. **Buttons that stay greyed out for a lasting reason say why, and Tab reaches them (visible).**
   - They stay focusable, look greyed, ignore clicks, and show the reason. First users (in part 2): the voice button, the Loop
     switch with no folder, and the plan queue's Start and Submit.
   - A short busy state, such as "Saving…", keeps the normal disabled look and says so in its label.
   - Alternative: wrap a truly disabled button in a span, which works for the mouse only.
5. **Hard words get a dotted underline, a short explanation, and a click that opens one shared Words panel (visible).**
   - 30 starter words (the backlog said about 25; five are words Phase 0 and Phase 3 put on screen). The click is on the
     underlined word itself, because Harness hover boxes deliberately never take the pointer.
   - One new side panel, mounted once for the whole app. "Learn more" means help written for James inside the app, not
     files from the docs folder, which the packaged app does not ship.
   - Old names such as YOLO stay as search words and in a muted "Also called" line. First three places: the "steer" chip
     in the queue, the Worktrees heading and the RTK settings header. Every other screen follows as it is migrated.
   - Alternative: make hover boxes clickable, or reuse Settings' private drawer.
6. **A small "?" on the loop panel and the session header opens help in the shared panel, and the loop help is rewritten in
   plain English (visible).** If the one-line header has no room at narrow widths, the "?" becomes the last item of the
   Session options menu. The approved text did not mention the rewrite, but the "?" would otherwise open a page full of
   internal terms. The finish-rule wording waits for Phase 2. Alternative: palette only.
7. **File names in the conversation become reachable with Tab (visible).**
   - They stay selectable and copyable text, not buttons.
   - The hint on focus comes from step 1's bridge.
   - The cost: every inline path becomes a Tab stop, so tabbing across a long conversation takes longer. A live check
     measures it. The fallback is to limit this to recent messages.
8. **The tooltip tool grows by optional extras instead of becoming three separate tools, and the one-phrase icon button is
   built on an Angular feature this app has never used, with a written fallback (not visible).**
   - A hover hint that merely repeats a button's own name is no longer read out a second time to screen-reader users.
   - Because the Angular feature is new here, a short trial comes first. Either way, the way a developer writes the button in
     a template is the same.
9. **A new counter replaces the old text-search check, and a guard lets the counts only go down (not visible).**
   - The counter reads every screen the way the app itself does, so a button whose only content is a "×" or an icon inside a
     condition is understood.
   - A name needs a real word. A browser-style hint, a placeholder or a tooltip never counts as a name.
   - Text that comes from data, and buttons that hold another component, are counted separately and never passed silently.
   - It stops with an error on anything it cannot read, checks itself against a second independent count, looks at the files
     on disk so brand-new files count, and treats a tooltip that cannot work as a failure.
   - The old check stays until the new gate takes over in one change, and is then deleted (it is tracked, so Git can
     restore it).
   - The guard fails when a count is lower than its record as well as when it is higher, and one command tightens it.
     Records are kept per component file, so moving a template between inline and its own file changes nothing.
   - A second lock compares the records with an earlier Git version, so one hand edit cannot raise a number and add a
     problem together. Splitting a component has a sanctioned way to move its debt.
   - It runs in the build's full check, in CI and as a test. Locally it only warns on push; commits are untouched, so loop
     auto-commits stay instant.
   - Alternatives: rebuild the old script in place (the backlog wording), or make the guard growth-only like the file-size
     check. Why not: the old gate must not weaken in between, and leftover headroom lets new problems hide in the very
     files people are editing.
10. **A wording ledger stops recorded hover warnings from vanishing, and these rules are strict from the start (not visible).**
    - The ledger records every hover sentence of three or more words that either contains a consequence word (delete,
      discard, revert, terminate, restart, clear, send, replace, empty, sign out, YOLO, crash and so on) or runs to seven
      words or more: about 110 on 10 Oct before the extra words and the member reading below, so expect somewhat more.
    - It reads hover text written in the same component's code, or in a small helper beside it (for example the Close
      session button's sentences), not only text in templates. Hover text it cannot read, because a service or a file in
      another folder builds it, is counted, and that count may not rise.
    - The words must still appear in a hover or in visible text of the same component after any change. An accessible name
      does not count as carrying the wording, because sighted users never see it. Retiring an entry needs a reason of 20 or
      more characters that no other entry uses; a retirement is a visible change in the file, not an impossible one.
    - It is a snapshot taken when the guard goes live. A new qualifying sentence is only a notice until someone records it,
      and each migration part records its new ones. So the promise is "cannot lose recorded wording silently", not "cannot
      lose any wording".
    - A browser-style "title" hint is counted on every element, not only controls, so step 1's bridge can eventually go. A click on
      something that is not a button counts only when it has no role at all (3 today).
    - Exemptions are by a visible reason only: invisible backdrops, decorative items, and (added by this plan) a key that is
      handled locally and is the same on every platform. The count of reasons is itself recorded, a stale one fails, and
      adding a new one later has one approved route (a command that raises that file's count, visible in the diff).
    - "A disabled button needs a reason" and "the tooltip must begin with the name" start as reports only. The glossary
      rule stays dormant until step 6 and then starts as a report.
    - Alternatives: record every hover string (about 330) or a hand-picked list; or gate every rule now. Why not for the
      second: two of the rules are heuristics until step 5 gives them a proper form.
11. **One new page of house rules, a pointer to it, and a reviewer check for screen changes that can never block a loop
    (not visible).**
    - The page is at most 140 lines, kept beside the design-token page rather than replacing it. Failures from the new
      guard point back to it.
    - The pointer is one sentence added to an existing paragraph of the instruction file every coding agent reads. It is not
      imported into the file Claude Code loads into every session and every loop round. No size cap on the instruction file.
    - The only upkeep rule is one sentence in the guide: "when James gives the same feedback twice, add it here".
    - James's personal completion-gate skill is left alone; the pointer reaches that reviewer through the instruction file.
    - The reviewer check is a short section inside the existing reviewer prompts. It is not a fifth review angle: every
      remote angle is "required", and an unfinished required angle stops a loop from finishing.
    - Its notes are advisory by construction (a flag plus a low severity), not merely low-scoring. The section appears only
      when the reviewed change touches screen files, at about 250 tokens per reviewer.
    - The agent checklist in the guide is the day-to-day value, so the prompt code comes last.
12. **Lint rules ship late and switched off, and the foundation comes before the screens (not visible).**
    - The plug-in is plain JavaScript, because the style-check setup cannot load TypeScript. A matching test ties it to the
      counter, so the two cannot drift apart.
    - Each rule is switched on in a one-line change (in part 3) only when its count in the record reaches zero. The test goes
      red until that is done, and also goes red if a rule is switched on too early.
    - The guide, the glossary and the Help panel come before the migrations, so agents doing them read the rules and mark
      words as they go.
    - The glossary step does not widen the central hover-text file, and it deletes only the two dead entries that remain
      after Phase 0.
    - Alternative: ESLint's bulk-suppression feature, which would allow the rules at error today. Why not: it would keep
      a second copy of the same debt.

## Ground rules for every step

1. **Read first.** Re-read the file, its callers and its specs before editing. Line numbers here are from 10 Oct, and
   Phase 0 and Phase 3 will move many of them.
2. **Prove the bug first.** For the steps that fix something (2b, 5a, 5b, 7b, 8a), write the named failing test first and
   confirm it fails on today's code. Cases marked "fails today" must be seen failing.
3. **Work in the current checkout.**
   - Do not create a feature branch or worktree; that is James's rule.
   - Other sessions have uncommitted work in this tree (176 entries on 10 Oct). Treat anything already modified before
     you start as theirs, and never stage, revert or reformat it.
   - Known collisions with this part:
     - `scripts/check-ts-max-loc.ts` (two ceilings raised for the MiMo work). Step 4 copies its ideas but does not edit
       it.
     - Files other sessions have in flight (the Settings provider-accounts tab and its new helper, the browser-approvals
       banner) are measured as they stand on the day; their clean-up waits for part 3.
   - Run `git status --short` on the day each part starts.
4. **File-size limits** (`npm run check:ts-max-loc`).
   - Allowlisted files may grow to their ceiling plus 50 lines. Other `.ts` files are capped at 700. "Room" below is
     measured that way, so it is the true failure threshold. Templates, styles, specs and docs are not counted.
   - Only git-tracked `.ts` files are checked, so a new module is not size-checked until it is tracked. Count new
     modules by hand against 700 while developing.
   - Headroom on 10 Oct, for the files this part edits. Paths are under `src/renderer/app/` unless they start with `src/`:

   | File | Lines now | Room left | Plan |
   |---|---|---|---|
   | `features/loop/loop-config-panel.component.ts` | 700 | 0 | 7a moves the default constants out first (about −50) unless Phase 2's part 9e already did. Then 7c, and part 2's 1g: import-only edits |
   | `features/instance-list/instance-list.component.ts` | 1,481 | 4 | 2b: one import. Phase 3's C4 may use some. All later edits (part 2) are template-only |
   | `features/instance-detail/instance-header.component.ts` | 694 | 6 | 7c: one import. Falls to about 430 once C2 lands |
   | `features/chats/session-artifacts-strip.component.ts` | 711 | 68 | 4b: marker, +1 line |
   | `features/instance-detail/session-progress-panel.component.ts` | 745 | 52 | 4b: marker, +1 line. Part 3's 1a: three titles |
   | `shared/components/recent-directories-dropdown/recent-directories-dropdown.component.ts` | 688 | 12 | 4b: marker, +1 line |
   | `features/models/model-selection-panel.component.ts` | 1,068 | 20 | 5c (optional): replace its private ⌘/Ctrl helper with `modKeyLabel()`, net negative |
   | `src/shared/types/keybinding.types.ts` | 669 | 31 | 5a: about +5. Phase 3's wording pass (C6, C7) and C10 also edit it |
   | `features/instance-detail/output-stream.component.ts` | 1,240 | 38 | 7b: about +10. Fallback: a new module and about 3 lines here |
   | `features/worktree/worktree-panel.component.ts` | 713 | 51 | 6c: +2 |
   | `core/services/markdown.service.ts` | 586 | 114 | 7b: about +6 (a branch in the existing sanitiser hook at `:89`) |
   | `core/services/keybinding.service.ts` | 539 | 161 | 5c: about +8 |
   | `features/loop/loop-control.component.ts` | 752 | 423 | 7c: +2 |
   | `shared/tooltip/tooltip-copy.ts` | 251 | 449 | 6c: delete 2 keys. Phase 0 and Phase 3 add about 200 lines first. Re-measure; part 2's 1d and 1h add sections in new files |
   | `shared/tooltip/aio-tooltip.directive.ts` | 338 | 362 | step 1 nets about −25; step 5 adds about 95 |
   | `shared/tooltip/aio-tooltip-panel.component.ts` | 53 | 647 | 5c: the shortcut chip |
   | `shared/tooltip/tooltip-policy.ts` | 145 | 555 | 5b |
   | `app.config.ts` | 47 | 653 | 1: about +4 |
   | `app.component.ts` | 455 | 245 | 6b: +2 |
   | `src/main/orchestration/review-prompts.ts` | 261 | 439 | 8b: about +8, shared with Phase 0 step 9 |
   | `src/main/orchestration/headless-review-findings.ts` | 68 | 632 | 8a: about +12 |
   | `src/main/orchestration/review-finding-aggregation.ts` | 226 | 474 | 8a: +1 to 2 |

   Roomy files edited by one part only (more than 250 lines of room) are not listed. All new modules are planned well
   under 700 lines. Put new logic in new modules, keep call-site edits to a line or two, and do not raise a ceiling.
5. **Prompt text** (step 8 only) follows `docs/prompt-engineering-house-style.md`: role first, payload in named
   delimiters stated to be data, the task and output contract after the payload, one complete example with no
   placeholders, and provider-neutral positive wording.
6. **Wording on screen:**
   - Plain English, "Harness", and no internal codes.
   - Tooltips use `appTooltip` with `TOOLTIP_COPY`. Do not add new `title=` attributes to controls.
   - A tooltip may not be the only place that shows a state or a consequence (house rules at the top of
     `tooltip-copy.ts`).
   - Old hover wording moves verbatim and only by the recipe in part 2 (step 1). Never reword, merge or drop a hover sentence
     inside a bulk edit.
7. **IPC:** this phase adds no channel. If one turns out to be needed, follow the Phase 0 rule: channel file,
   `npm run generate:ipc`, schema, handler, preload domain, `npm run verify:ipc` and `npm run verify:ipc-usage`.
8. **No browser on the Mac.**
   - Test renderer behaviour headless in Vitest (jsdom), with seeded stores and fake timers.
   - Anything that needs eyes on the rebuilt app goes to the live checks. Those run on the Windows PC, or on the Mac
     only with James's OK.
   - Brief every subagent and reviewer on this rule.
9. **Never write to James's app databases or settings from a script.** This phase changes no stored data. The
   counter and the guard read source files only.
10. **Testing:** while working, run `npm run test:quiet -- <spec>`. Scripts specs live in `scripts/` and run in the
    "main" Vitest project (jsdom). Renderer specs run in the renderer project. When a step is finished, run the
    [gates](#final-verification) that apply.
11. **Baseline last.** The records the guard checks (`baseline.json` and `wording-ledger.json`, step 4c) hold whatever
    templates exist at that moment, and other sessions are still editing templates. So they are generated as the very
    last action of step 4, just before its verification, and re-checked at the end of every later part. If another
    session's template change lands after that and the guard goes red, fix the cause or run `--tighten`. Never raise a
    number by hand; the one sanctioned way to raise a record is `--exempt` for a new marker (step 4a).
12. **From step 4c on, new files start at zero.** A new component has no record, so any problem in it fails the
    guard. Use `appTooltip` plus an `aria-label` on every icon button, and mark invisible backdrops (a new backdrop that is hidden from
    keyboard and screen readers with `aria-hidden="true"` and `tabindex="-1"` needs no marker).
13. **The guide is a product document, not a plan.** `docs/screen-and-wording-guide.md` is committed with the work when
    James asks. It stays untracked until then like any other new file.
14. **Commit only when James asks.**

## Order of work

Steps run one at a time unless two of them share no files. "Needs first" lists hard dependencies only. In every step, a part
that is still waiting for its Phase 2 or Phase 3 item is skipped for now; the others do not wait for it (for example 3b
needs no Phase 3 change, 7a and 7b need neither C2, C8 nor Phase 2, and 7d may land as a jargon-only rewrite before B2
and B3).

| Step | Item | Size | Needs first | Main files (new modules in *italics*) |
|---|---|---|---|---|
| 1 | D1b Existing hover hints show in Harness's own tooltip | M | Phase 0 step 5 | `aio-tooltip.directive.ts`, `app.config.ts`, *`tooltip-registry.ts`*, *`tooltip-overlay.ts`*, *`title-tooltip-bridge.ts`* |
| 2 | D2 An honest counter (2a), and the one tooltip that never worked (2b) | M, XS | none | *`scripts/ui-hints/` (reader)*, *`scripts/audit-ui-hints.ts`*, `package.json`, `instance-list.component.ts` |
| 3 | D8 One page of house rules (3a), and two stale standards pages (3b) | S, XS | Phase 3 (C5, C6, C7) for 3a | *`docs/screen-and-wording-guide.md`*, `AGENTS.md`, *`scripts/screen-and-wording-guide.spec.ts`*, `docs/shell-component-standards.md`, `docs/visual-qa-checklist.md`, `docs/DESIGN.md` |
| 4 | D3 A guard that only lets problems go down and cannot lose recorded wording silently (4a code, 4b markers, 4c records, last) | M | step 2 (step 3 adds the guide links when it lands) | `scripts/ui-hints/` (rules, records, ledger), *`scripts/check-ui-hints.ts`*, *`baseline.json`*, *`wording-ledger.json`*, `package.json`, `ci.yml`, `run-git-hook.js`, `AGENTS.md`, ten markers; the old check is deleted |
| 5 | D4 Building blocks (5a-5e), with the D1 follow-up on names read twice (5b) | S-M | Phase 0 step 5; steps 1 and 4 | `aio-tooltip.directive.ts`, `aio-tooltip-panel.component.ts`, `tooltip-policy.ts`, `keybinding.types.ts`, `keybinding.service.ts`, *`icon-button.directive.ts`*, *`shortcut-display.ts`*, `_base.scss` |
| 6 | D6 A glossary and one shared Help panel (6a-6c) | M | Phase 3 (C7); Phase 0 step 2.6c; steps 3 and 4 | *`shared/glossary/`*, *`shared/help/` (panel, topics, service)*, `app.component.*`, `tooltip-copy.ts`, three first screens |
| 7 | D7 Help where the work is (7a-7d) | S-M | steps 1, 5 (5e) and 6; Phase 0 step 1; Phase 3 (C2, C8); Phase 2 (B2, B3) for the finish rules | *`loop-config-panel.defaults.ts`* (7a, unless Phase 2's 9e did it), *`help-link.component.ts`*, *`session.help.ts`*, `loop.help.ts`, `markdown.service.ts`, `output-stream.component.ts`, header and loop templates |
| 8 | D9 A screen-and-wording check for reviewers (8a, 8b) | S | step 3; Phase 0 step 9 | *`review-ui-consistency.ts`*, `review-prompts.ts`, `headless-review-findings.ts`, `review-finding-aggregation.ts` |
| 9 | D10 (first half) The lint plug-in and its link test, with every rule off | M | steps 4 and 5e | *`eslint-rules/ui-hints.js`*, `eslint.config.js` |

Files shared across steps:
- `aio-tooltip.directive.ts` (Phase 0 step 5, then steps 1, 5b, 5c and 5d; 5e builds on it): re-anchor line numbers after each.
- `scripts/ui-hints/types.ts` and `rules.ts` (steps 2, 4, then 5 and 6 add classifications).
- `package.json` (steps 2 and 4); `AGENTS.md` (steps 3 and 4: a sentence each, in different paragraphs).
- `tooltip-copy.ts` (Phase 0, Phase 3, 6c; part 2 adds sections in new files).
- `review-prompts.ts` (Phase 0 step 9, then step 8).
- `loop-config-panel.component.*` (7a, 7c, Phase 0 step 2.6c; part 2's 1g).
- `composer-queue.component.html` (6c; part 2's 1d); `instance-header.component.*` (7c, Phase 3 C2 and C8; part 2's 1f).
- `docs/shell-component-standards.md` (3b only).

Do those steps in the order above.

**Numbering (old to new).** The single Phase 4 plan had ten steps. Steps 1 to 8 keep their numbers here. The old step 10a (the
lint plug-in) is step 9 here. The old step 9 (parts 9a to 9n) is split: 9a to 9h became part 2's 1a to 1h, and 9i to 9n became
part 3's 1a to 1f. The old 10b to 10e (the four lint switch-ons) became part 3's 2a to 2d.

**Why this order.** It keeps the backlog's rule (fix, measure, ratchet, build, then migrate) and changes three things,
each for a reason the reports found:
- **The guide (D8) moves up to step 3.** The guard's failure messages should cite sections of a page that exists, and
  the agents doing the migration are the guide's readers. The guide may only name helpers that exist on the day it lands, so
  steps 4, 5 and 6 each add their own line to it.
- **The glossary and help (D6, D7) move before the migration.** The queue work in part 2's 1d builds on the glossary mark placed in 6c, and
  step 7a (room in the loop setup panel) must come before part 2's 1g edits the same file. The backlog put them after the
  migration.
- **The reviewer check (D9) moves before the migration.** It is small, finite and independent, and the migration's own changes should
  be reviewed with it. The migration is open-ended, so anything numbered after it would otherwise wait for it.

Constraints this order respects. The wording ledger (4c) exists before any migration part. Each migration part follows the Phase
2 or Phase 3 change that edits its template. Lint cannot finish until the migration has emptied the counts it switches
on: its plug-in (step 9 here) ships early with every rule off, and each switch-on (part 3) follows its count reaching zero.
If Phase 3 runs late, steps 1, 2, 4 and 5 do not need it; step 3 then adds the "See the guide" line to step 4's messages when it lands.

---

## Step 1. D1b: Existing hover hints show in Harness's own tooltip (M)

**For James:** about 360 hover hints on buttons, icons and labels still use the browser's slow grey bubble (about 30
more sit on whole cards and keep it for now). After this change the 360 show Harness's own tooltip instead: quicker,
in the same style as the others, and also when you tab to a button with the keyboard. No wording changes at all, so no
warning can go missing.

**Verified (10 Oct):**
- **What is left to upgrade.**
  - `command grep -rEo --include='*.html' --include='*.ts' --exclude='*.spec.ts' --exclude='*.test.ts'
    '(^|[[:space:]])(title="|\[title\]=|\[attr\.title\]=)' src/renderer | wc -l` prints **393** in **132** files (re-run
    on 10 Oct).
  - Angular's own `parseTemplate` over the 305 real templates finds **390** `title` attributes on elements (212 static,
    160 `[title]`, 18 `[attr.title]`): **216 on controls, 142 on plain elements, 32 on component hosts**.
  - The other 3 of the 393 are HTML strings built in TypeScript (`core/services/markdown.service.ts:145,276`,
    `core/services/codex-followup-markdown.ts:69`). The transcript also sets `button.title = …` four times through the
    DOM (`markdown.service.ts:460,464,470,473`). The bridge sees all of these because it works on the live page.
- **`appTooltip` today:** 100 hosts in 30 files (re-run). `appTooltipTpl` has 0 uses. No element carries both a `title`
  and an `appTooltip`.
- **Nesting today (parser):** 0 titled elements inside an `appTooltip` host, **2** `appTooltip` hosts inside a titled
  element (`input-panel.component.html:66,92`), **16** titled elements inside titled elements (17 pairs, because one
  element has two titled ancestors). So "nearest source wins" and "a directive host beats an outer title" are both
  needed, and the second needs more than doing nothing: the outer element's native bubble must be held back too (rules 2
  and 3 below).
- **The 32 component-host titles are not hover hints.** They sit on `<app-empty-state>` (13), `<app-task-preflight-card>`
  (6), `<app-prompt-modal>` (5), `<app-settings-card>` (4), `<app-danger-zone>` (3) and `<app-page-header>` (1). 30 are
  static `title="…"`; the other 2 are bound (one on `app-empty-state`, one on `app-prompt-modal`). Each component
  declares `title` as an `input()` (for example
  `shared/components/empty-state/empty-state.component.ts:23`). Angular writes every static attribute onto the host
  element (`setUpAttributes` in `node_modules/@angular/core/fesm2022/_debug_node-chunk.mjs`). That runtime path is
  verified; no one has rendered it in a browser, so "hovering anywhere on an empty-state card shows its heading as a
  grey bubble today" is **inferred**. A bridge that styled these would make that accidental bubble louder (200 ms
  instead of about 1 s), so the bridge skips them.
- **No bridge exists.** `MutationObserver` appears in 0 non-spec renderer files (the same command finds `ResizeObserver`
  in 6, so it ran). No non-spec renderer file calls `addEventListener` for `pointerover`, `mouseover`, `mouseenter` or
  `pointerenter` (the tooltip directive uses Angular host listeners instead; the same search finds 3 calls for `'click'`, so
  it does work). No CSS or TypeScript selects on `[title=…]` or on a bare `[title]` (re-checked on 10 Oct), so setting a
  title to empty for a moment cannot break styling or lookups.
- **The directive anchors** (`aio-tooltip.directive.ts`, 338 lines, re-read):
  - skip-window state `:63`; `liveTooltips` `:87`; selector and host listeners `:89-103`;
  - innermost hand-back `:158-171`; focus-visible gate `:173-178`; `show()` `:199-216`;
  - suppression `:270-279`, with the `textContent` read at **`:273`**;
  - overlay config `:286-301` (close on scroll `:293`); `aria-describedby` merge and restore `:307-319`.
- **The policy is strict.** `tooltip-policy.ts:93-97` `isRedundantWithLabel` is a case- and whitespace-insensitive
  **equality** test, not "contains". A title that adds even one word to the visible label is never suppressed. Delays
  are at `:27-31`, the skip window at `:33`, the post-click block at `:39`, `openDelayFor` at `:50-57` and
  `shouldOpenOnFocus` at `:107-115`.
- **Why Phase 0 step 5 (D1) must land first.** The bridge calls the same redundancy test. Today that test reads
  `textContent` (`:273`). The collapsed Settings rail hides its labels with `display:none`
  (`features/settings/settings.component.nav.scss:288-293`) while using `[title]="item.label"` plus
  `[attr.aria-label]` (`settings.component.html:88,109`). Without D1's `visibleTextOf`, the bridge would blank those
  titles and then suppress the styled tooltip as "redundant", and the collapsed rail would show **nothing**. That is
  exactly how a mass upgrade loses a hover. D1 plans `shared/tooltip/tooltip-visible-text.ts` (`visibleTextOf(root)`), a
  `template` input on the panel, and `appTooltipFormat` (Phase 0 plan, step 5).
- **A hover-only consequence that must survive the swap:**
  `features/instance-detail/composer-queue.component.html:39` is `<span class="queued-drop-warning" title="Not yet saved
  for crash recovery — a renderer crash right now could lose this message">not saved</span>`. The visible text is "not
  saved"; the loss warning is only in the title. It is not equal to the label, so the bridge shows it in full. Part 2's step 1d
  later puts it in visible text.
- **The test environment can drive the bridge.** jsdom 27.4.0 has `PointerEvent` and `MutationObserver`, and no
  `innerText`. The directive spec already uses TestBed with fake timers (`aio-tooltip.directive.spec.ts:1-82`).
- **Where to start it.** `app.config.ts:34-36` already uses `provideAppInitializer(() => {
  inject(RendererHeartbeatService).start(); })`. No need to touch `app.component.ts` (455 lines). The title-bar
  widgets sit in `no-drag` islands inside a draggable bar (`app.component.scss:23`, `:40`), so pointer events should
  reach them; that needs a live check.

**Change:** (assumes Phase 0 step 5 is merged)
1. **No template, no `tooltip-copy.ts`, no wording edits.** This rule makes a lost warning impossible by construction.
   The change set is code only. The diff must touch no `.html` file and no string in any template.
2. **New `shared/tooltip/tooltip-registry.ts` (about 40 lines).** It holds three things the directive and the bridge
   must share:
   - `tooltipHostElements: WeakSet<Element>`, every live `AioTooltipDirective` host. The directive adds in its
     constructor body (`:133-139`) and removes in `ngOnDestroy` (`:141`).
   - the `lastTooltipClosedAt` timestamp, moved out of the directive (`:63`) behind `getLastTooltipClosedAt()` and
     `markTooltipClosed()`;
   - a one-slot hook, `registerBridgeHider(fn)`, called once per `show()` next to the existing
     `hideAncestorTooltips()` (`:203`), so the directive can hide a bridge tooltip.
3. **New `shared/tooltip/tooltip-overlay.ts` (about 60 lines).** Move `POSITIONS` (`:65-82`) and the body of
   `ensureOverlay()` (`:286-301`) here as `createTooltipOverlay(overlay, positionBuilder, origin, position)`. The
   directive calls it. That keeps one definition of position, push, close-on-scroll and `panelClass`.
4. **New `shared/tooltip/title-tooltip-bridge.ts` (about 260 lines).** `@Injectable({ providedIn: 'root' }) class
   TitleTooltipBridge` with `start()` and `stop()`. Rules, in order:
   1. *Listeners* (document, capture, passive): `pointerover`, `pointerout`, `pointerdown`, `focusin`, `focusout`,
      `keydown` (Escape only) and `scroll`; plus `window` `blur`, `document` `visibilitychange` and `pagehide`. Ignore
      `pointerType === 'touch'`: touch stays native. A capture listener on `document` receives scroll events from every
      element, so the `scroll` handler hides a tooltip only when the scrolled element contains the anchor (or the
      document itself scrolled). An unrelated scroll, for example the transcript scrolling itself while a reply streams
      (inferred, not run), must not cancel a tooltip on the rail or the title bar. The directive is narrower for the same
      reason: its `scrollStrategies.close()` (`:293`) reacts only to scrolls the CDK knows about, and openclaw's bridge
      listens to no scroll event at all (`openclaw/ui/src/components/tooltip-title.ts:277-278`).
   2. *Find the source.* From the event target, walk up to the first element that is one of:
      - the element now holding the slot (rule 3), read with its saved text, because its live `title` is the bridge's own
        blank;
      - in `tooltipHostElements` (a directive host: the directive owns the tooltip, so the bridge shows nothing; see the
        last paragraph of this rule);
      - carrying a `title` attribute. A title that is empty and was not written by the bridge counts: browsers let an empty
        title cancel an outer one, so empty means "show nothing" and stop.

      Skip non-`HTMLElement` nodes (SVG, MathML), any tag name containing a hyphen (an Angular component host, where `title`
      is an input name), `iframe`, `frame`, `embed`, `object`, `body`, `html`, and anything inside
      `[data-title-tooltip="off"]`.

      When the nearest match is a directive host, the bridge shows nothing, but it keeps the nearest titled ancestor (if
      there is one) blanked in the slot for as long as the pointer stays inside the host. Otherwise that ancestor's native
      bubble would appear behind the styled tooltip and "a directive host beats an outer title" would be false in the
      browser (inferred; jsdom shows no native bubble, so only the attribute can be tested). The 2 real cases are
      `input-panel.component.html:66,92`.
   3. *Single slot.* At most one element has a blanked title at a time. On `pointerover` of a source: restore the
      previous slot, save `{ el, text }`, then blank the title with `setAttribute('title', '')`. **Never
      `removeAttribute('title')`**: an empty title blocks the browser's inheritance from an outer element, while a missing
      title lets the outer one show. The reference does the same (`openclaw/ui/src/components/tooltip-title.ts:211-214`:
      "An empty title blocks browser inheritance without exposing the next ancestor"). If the element has no other
      accessible name (no `aria-label`, no `aria-labelledby`, and `visibleTextOf(el).trim()` is empty), set `aria-label`
      to the text for the duration and remember that we did.
   4. *Show after the policy delay:* `openDelayFor(variant, skipActive)`, with the skip window read from the registry
      (`SKIP_WINDOW_MS`).
      - Variant `default` (200 ms) for controls. Variant `overflow` (600 ms) for plain elements and for any truncated
        anchor (`scrollWidth > clientWidth + 1`, the test at `:281-284`).
      - Run `shouldSuppressTooltip({ text, visibleLabel: visibleTextOf(el), truncated, expanded: aria-expanded ===
        'true', recentlyClicked })`. If suppressed, stay blanked but show nothing until the pointer leaves, so the native
        bubble cannot appear in its place.
   5. *Render:* the shared panel through `createTooltipOverlay`, with `setInput('text', text)`, `setInput('tooltipId',
      …)` and the panel's code format (Phase 0 step 5) when the anchor is `<code>`, `<kbd>` or `<samp>` (the
      transcript's file paths). Merge the panel id into `aria-describedby` with `mergeDescribedBy` and restore it with
      `unmergeDescribedBy` (the helpers used at `:307-319`). Call the registry's `markTooltipClosed()` on hide, so the
      skip window is shared.
   6. *Hide is not restore.* `pointerdown`, `Escape` and a scroll that moves the anchor hide the tooltip but keep the
      title blanked while the pointer stays on the element; otherwise the native bubble appears after a click. The title is
      restored only when: `pointerout` leaves the element (the `relatedTarget` is outside it); `focusout` or the window
      `blur`s; `visibilitychange`; `pagehide`; the element leaves the document (checked at the next event); another source
      takes the slot; or `stop()` is called. "Restored" means: if the attribute is still `''`, write the saved text back; if
      it holds another value, Angular rebound it and that value stays; if it is gone, Angular removed it and nothing is
      written (`tooltip-title.ts:55-56` is the reference).
   7. *Angular rewrites the title while it is open.* A `MutationObserver` on the one held element (attribute filter
      `title`) reads each change, and drops the record caused by the bridge's own blanking write (`takeRecords()` straight
      after writing it). A new non-empty value is the new saved text (update the open tooltip, blank it again). An empty
      value from Angular, or a removed attribute, means "no hint any more": hide the tooltip and restore nothing, so a stale
      old text can never come back. The observer exists only while a slot is held.
   8. *Keyboard focus.* `focusin` on a source that passes `shouldOpenOnFocus(el)` (`:focus-visible`) shows at 0 ms and
      does **not** blank the title. Browsers never show a title on focus, so there is nothing to hide, and the control
      keeps its fallback name. `focusout` hides.
5. **`app.config.ts`:** add `provideAppInitializer(() => { inject(TitleTooltipBridge).start(); })` (about 4 lines).
6. **`aio-tooltip.directive.ts`:** use the registry and the overlay helper (net about −25 lines). No behaviour change
   for the 100 existing hosts. The existing 389-line spec must pass untouched.
7. **Docs.** One paragraph in the directive's header comment: "Native `title` attributes are shown through
   `TitleTooltipBridge`; they still count as debt in the ratchet until migrated to `appTooltip`."

**Tests:** `title-tooltip-bridge.spec.ts` (renderer project, TestBed, fake timers). Every case is new. The first three
are the guards that make a lost warning impossible.
- `shows the title text verbatim`: for each of 12 titles copied from today's templates (the queue's "not saved" line,
  "Discard changes (revert to HEAD)", "Delete all conversation history", "YOLO mode ON — auto-approve all actions",
  "Enable YOLO mode to auto-approve all permissions for this session", "Close this computer's live connection without
  revoking it. It reconnects by itself.", "Archive this sidechat (keeps history, removes it from the list)" and so on),
  the `[role="tooltip"]` text equals the title exactly.
- `never swallows a title that adds to the label`, plus `a label hidden with display:none does not suppress` (fails
  without D1), plus `only an exact, visible match is suppressed`. These use the real `shouldSuppressTooltip` and
  `visibleTextOf`.
- `restores every title after any event sequence`: seeded random sequences of pointerover and pointerout, focusin and
  focusout, pointerdown, Escape, scroll, window blur, visibilitychange, an Angular-style `el.title = x` rebind while
  open, and element removal. After each sequence plus `stop()`, every element's `title` equals its last bound value (or is absent where Angular removed it), no
  lent `aria-label` remains, and at no point were two titles blanked at once.
- `a click hides the tooltip but keeps the native one blank until the pointer leaves`.
- `defers to a directive host`: an `appTooltip` host inside a titled parent (the 2 real cases) shows only the directive's
  tooltip, and the parent's `title` attribute is `''` (not removed) while the inner host is hovered, so its native bubble
  cannot show; titled-in-titled shows the innermost.
- `outer-title inheritance`: hovering a titled child inside a titled parent leaves the parent's `title` as `''` until the
  pointer leaves the parent, then restores it.
- `ignores component hosts, iframes, SVG and touch`.
- `updates when Angular rebinds the title while open`; `hides when the title is removed`; `an [attr.title] that goes to null
  while blanked restores nothing` (no stale old text comes back).
- `an unrelated scroll does not hide an open tooltip`; `a scroll of an element that contains the anchor does`.
- `lends an aria-label only when the control has no other name, and takes it back`.
- `keyboard focus shows the tooltip without touching the title; Escape hides`.
- `<code title>` uses the code format.
- Edit nothing in `icon-control-tooltip.spec.ts` for this step.

**Risks:**
- *More tooltips appear, sooner.* Native titles waited about 1 s; controls now wait 200 ms. Dense areas (the session list
  has 13 titled controls and 7 titled plain elements in one template) will pop up more often. Mitigation: plain
  elements use the 600 ms `overflow` delay, and the skip window keeps a rail of icons smooth.
- *The 30 static component-host titles stay native* (the bridge ignores hyphenated tags). They keep today's behaviour.
  Part 3's step 1e renames the input and the guard counts them until then.
- *Focus lands on a blanked title.* Avoided: the keyboard path never blanks, and the pointer path lends a name only when
  none exists.
- *Drag regions may swallow pointer events.* The title bar is `-webkit-app-region: drag` with `no-drag` islands. If the
  islands do not deliver `pointerover` on Windows, the 12 title-bar titles keep the native bubble (no loss, just no
  upgrade). Live check.
- *Performance.* Three passive capture listeners and one `closest`-style walk per pointer transition. The observer
  exists only while hovering.
- *Silent loss modes ruled out:* a title that adds words is never suppressed (strict equality); nothing is restored late,
  because release is tied to six exits plus `stop()`; and the open-menu suppression (`aria-expanded`) only delays the
  hint until the menu closes, it never deletes it.
- *An outer native bubble behind a styled tooltip* is ruled out by blanking with an empty title (never removing it) and by
  also blanking the nearest titled ancestor when a directive host is nearest (rules 2 and 3). The reference bridge does the
  same (`tooltip-title.ts:211-214`).
- *This bridge is permanent for now.* The seven transcript HTML sites keep their `title` text and use it (see the notes
  under [Not in this plan](#not-in-this-plan-and-where-it-goes)), so the bridge is not deleted when the migration ends.

**Done when:**
- Re-running the title count command prints the same numbers as today (393 raw, 132 files), and `git diff --stat` shows
  no `.html` file and no string change in any template: wording did not move.
- `npm run test:quiet -- src/renderer/app/shared/tooltip` passes, including the restore-invariant and never-swallow
  specs, and the untouched directive spec.
- On the Windows PC: hovering a titled button shows the styled tooltip and no grey bubble; tabbing to it shows the
  tooltip; the collapsed Settings rail, the title-bar chips, a disabled button and a transcript file path all show it.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “Step 1. D1b: Existing hover hints show in Harness's own tooltip (M)”.

## Step 2. D2: An honest tooltip counter (M), and the one tooltip that never worked (XS)

### 2a. The counter (M)

**For James:** the current tooltip check says "0 problems" and is wrong: it misses about 25 buttons that have no name at
all and about 100 more with no hover hint. This replaces it with a counter that reads every screen the way the app
itself does, so the numbers can be trusted. The first honest report will look worse than the old one. That is the point.
Nothing changes on screen.

**Verified (10 Oct):**
- **The old check really is blind** (re-run with the script's own functions):
  - the composer's wake-up button (`input-panel.component.html:353`) and voice button (`:472`) both return
    `hasTextualName = true`, although their only content is an SVG and their only name is a native `title`;
  - `<button title="Close">&times;</button>` returns `true`, and so does a button whose only content is an
    `@if (…) {<svg/>} @else {<svg/>}` block.
  - Cause: `hasTextualName` (`scripts/audit-native-titles.js:182-189`) tests the raw text for `[A-Za-z][A-Za-z0-9._-]`,
    and control-flow syntax and undecoded entities contain letters.
  - A third gap: `audit()` only looks at tags that already carry a `title` (`:247-249`), so icon buttons with no title at
    all can never appear. It also scans every non-spec `.ts` file as raw text (`walk`, `:80-83`), so an HTML string in a
    service counts as a control.
  - `node scripts/audit-native-titles.js` prints "0 interactive control(s) with NO accessible name / 217 named but still
    using a native title / across 74 file(s)" (re-run on 10 Oct).
- **Where the old gate runs.** `package.json:49` `verify` runs `audit:native-titles -- --fail-on-blocking`, and the spec
  pins `audit().blocking` to `[]` (`scripts/audit-native-titles.spec.ts:250-252`). `.github/workflows/ci.yml` does not
  run the script, so CI enforces it only through that spec in the test shards.
- **The compiler is already here.** `@angular/compiler` 22.2.1 exports `parseTemplate`
  (`node_modules/@angular/compiler/types/compiler.d.ts:5307`), `TmplAstRecursiveVisitor` and `tmplAstVisitAll` (export
  list `:6893`). A parse of a template with an `@switch` block works under plain `require` on Node 24.15 (`engines` is
  `^22.22.3 || ^24.15.0 || ^26.0.0`). TypeScript 6.0.3 is installed for finding inline templates. No new package.
- **Traps found while prototyping** (each becomes a spec case):
  1. Angular 22's `SwitchBlock` has `groups[]` (each with `cases` and `children`), not `cases[].children`. A
     hand-written child walker silently dropped every control inside an `@switch`. Use `TmplAstRecursiveVisitor`, never
     index children by hand.
  2. A `*ngIf`-style wrapper produces a `Template` node that **repeats** the element's attributes. Count in
     `visitElement` only.
  3. A tag inside an interpolation string, `{{ '<b>' }}`, is an Angular parse error, so parse errors must fail the run,
     never be skipped.
  4. The parser decodes entities: `&times;` becomes "×" and `&#x2715;` becomes "✕". HTML comments are not nodes.
- **Cross-checks that hold today.** `command grep -rE '^\s*@Component\(' src/renderer --include='*.ts'
  --exclude='*.spec.ts' --exclude='*.test.ts' | wc -l` prints **305**, in 305 distinct files. The TypeScript AST finds
  75 `templateUrl` plus 230 literal `template:` = 305 templates (0 non-literal), every `templateUrl` resolves, and the
  only `.html` under `src/renderer` that no component references is `index.html`. All 305 parse with 0 errors. (The
  audit's "307 templates" counted `index.html` and one stray `template:` line.) Raw `title` grep (393) = parser (390) + 3
  HTML strings. Raw `appTooltip` grep (100) = parser (100).
- **Honest numbers, 10 Oct, from the parser** (a second method matched the earlier audit within one control in every
  bucket):

  | Measure | Honest count |
  |---|---|
  | Templates analysed / parse errors / unanalysable | 305 (75 external + 230 inline) / 0 / 0 |
  | Elements / controls (including 568 inputs, selects and textareas) | 12,834 / 1,916 |
  | Controls named by visible text / by data only (`{{ x }}`) | 1,294 / 161 |
  | **Icon-only controls** (no visible word, no data text) | **174** (and 1 that wraps a child component) |
  | ... with a tooltip and a name (meets the rule) | 47 |
  | ... native title and name / name only / **nothing** / title only (no name) | 66 / 36 / 23 / 2 |
  | Native `title` attributes (static / `[title]` / `[attr.title]`) | 390 (212 / 160 / 18) |
  | ... on controls / on plain elements / on component hosts | 216 / 142 / 32 |
  | `appTooltip` hosts (static / bound; on controls / on plain elements) | 100 (49 / 51; 79 / 21) |
  | Hover-only plain-element hosts (not focusable, no name): tooltip / title | 11 / 132 |
  | Hover strings with hard-coded shortcut text | 11 sites |
  | Tooltip host inside a tooltip host | 0 |
  | Clickable non-controls with no `role="button"`: 12 only stop propagation, 11 are dialog or presentation containers, **3** have a real handler and no role | 26 (3 gated) |
  | Hover surfaces outside templates (3 HTML strings, 4 `button.title =`) | 7 |
  | Elements with a static `aria-label` and a static tooltip / the tooltip does not start with the name | 43 / 2 |
  | `TOOLTIP_COPY` keys / keys with no reference elsewhere | 35 / 3 (`loop.recycleToggle`, `loop.isolation`, `loop.verifyTwice`) |
  | Tooltip attributes on a component that does not import the directive (inert) | 1 (`instance-list.component.html:472`, see 2b) |

  Reproduce the cheap ones with the title command above (393 and 132 files) and the same command with
  `'(^|[[:space:]])\[?appTooltip\]?='` (100 and 30 files). A raw `<button` grep under-counts (about 618) because many tags
  break the line right after `<button`; do not use it as a denominator.
- **Where the new code can live without tripping other gates.** `scripts/**/*.spec.ts` run in the "main" Vitest project
  (`vitest.config.ts:113-124`); the root `tsc --noEmit` has no `include` list, so `scripts/` is type-checked; `check:dead`
  scans only `src/main`, `src/shared` and `packages/*`; `check:ts-max-loc` does cover new scripts (700-line cap), so
  split into modules.

**Change:** (ship it beside the old script; step 4 swaps the gate. The gate must never get weaker in between.)
1. **New folder `scripts/ui-hints/` (TypeScript, all new, each file well under 700 lines):**
   - `template-sources.ts` (~140 lines): `collectTemplates(root)`.
     - Walks `src/renderer` on the file system, not `git ls-files`, so an untracked new component is counted too.
     - For every `@Component` found with the TypeScript AST (not a regex), `template` must be a string or
       no-substitution template literal (use the cooked `.text`), or `templateUrl` must resolve to an existing file.
       Anything else is reported as `unanalysable`, a hard failure.
     - Also fails if the number of templates differs from an independent `@Component(` count, or if an `.html` under
       `src/renderer` other than `index.html` is not referenced by exactly one `templateUrl`.
     - Keeps each template's first source line, so inline findings point at the real `.ts` line.
     - Records `ownerFile`, the `.ts` file of the component that owns each template, and reads its `imports` array. If an
       `imports` list cannot be read statically, that is `unanalysable` too.
   - `template-facts.ts` (~280): `parseTemplate(text, file, { enableBlockSyntax: true, enableLetSyntax: true })`; any
     entry in `errors` aborts with `file:line`. A `TmplAstRecursiveVisitor` subclass overriding `visitElement` builds one
     fact per element: tag; component host (tag contains `-`, not `ng-*`); control or not; role; `title` form (static,
     property, attribute or interpolated); `appTooltip` form; `aria-label` and `aria-labelledby`; `tabindex`; ancestors
     that are tooltip or title hosts; exemption marker; whether the owning component imports the directive the
     attribute needs (`AioTooltipDirective` for `appTooltip`, `appTooltipTpl` and `appTooltipDisabledReason`;
     `AppIconButtonDirective` for `appIconButton` once step 5e ships); and a nested `TextCollector` visitor (also a
     `TmplAstRecursiveVisitor`) over the element's children. A tooltip attribute on a component that does not import its
     directive is marked **inert** and is not counted as a tooltip host.
   - `hover-strings.ts` (~170): the literal text fragments of a bound `title` or `appTooltip` (use `RecursiveAstVisitor`
     `visitLiteralPrimitive`, `visitTemplateLiteralElement`, `visitInterpolation`), and resolution of `copy('key')` and
     `copyFor('key')` to the `TOOLTIP_COPY` text by importing `shared/tooltip/tooltip-copy.ts` (plain TypeScript, no
     Angular imports). It also reads **text written in the same component's code**: when a bound hover calls a member of
     the owning class (`name()` or `this.name()`, alone or inside a larger expression; the member is a `computed(...)`, an
     arrow function, a method or a getter), the string and template literals in that member's initializer or body, found with
     the TypeScript AST the reader already uses for `@Component`, become fragments too. `${...}` holes are recorded as gaps,
     and a `copy('key')` call inside the member resolves like one in a template. If the member calls a function imported from
     a file in the same folder (the helper pattern that part 2's steps 1a, 1d and 1g use to keep a component small, for
     example `input-panel-tooltips.ts`), that function's literals are read the same way, one level deep. A bound hover that
     calls anything else it cannot follow (a service method, a pipe, or a function imported from another folder) is marked
     **unreadable**; step 4 counts those. A plain data read such as `item.label` carries no authored wording and is neither.
     Output: `{ channel, fragments, dynamic, unreadable }`.
   - `outside-template.ts` (~80): a TypeScript-AST scan of non-spec renderer files for hover surfaces that are not in a
     template: `x.title = …`, `setAttribute('title', …)`, `host: { '[title]' | '[attr.title]' | 'title' }`,
     `@HostBinding('title' | 'attr.title')`, and string or template literals containing `<tag … title=`.
   - `types.ts` (~60): the `ElementFact`, `HoverText`, `Violation` and `Analysis` shapes. Every template record and every
     fact also carries `ownerFile`, so step 4 can key its records by component and survive moving a template between
     inline and `.html`.
   - `rules.ts` (~200): the rule catalogue (code, one-line title, fix hint, status) and the evaluators for H1a, H1b, H2a,
     H2b, H2c, H3, H4, H5, H10, H11 and H12 over the facts (the codes are listed in step 4). The CLI calls it to print and
     `--list` violations; step 4 adds H6, H7, H9 and the record comparison on top.
2. **The counting rules** (each is a spec case; together they are what "cannot be gamed" means):
   1. *Count what Angular renders.* Everything comes from the compiler's AST. HTML comments, strings inside `{{ }}`,
      TypeScript code and `@if (…)` syntax are never text. The parser decodes entities, so `&times;` is a glyph.
   2. *A name needs a word.* A name is `aria-label`, `[aria-label]`, `[attr.aria-label]` or `aria-labelledby`; visible
      text; `sr-only` or `visually-hidden` text; an SVG `<title>`; or, for inputs, selects and textareas, an associated
      `<label>`. "Word" means two or more letters (`/\p{L}{2,}/u`). `aria-label=""`, a space, a single character, `×`, a
      number or an emoji on its own are **not** names. A native `title`, a `placeholder` and an `appTooltip` are never
      names.
   3. *Dynamic text is a separate answer.* `{{ cond ? '×' : '↻' }}` is read from its literal branches (glyphs, so still
      icon-only). `{{ item.label }}` is "named by data" (161 controls today): not counted as icon-only, but reported as
      its own number.
   4. *Icon-only* means a control (not an input, select or textarea) with no visible word, no data text, no `sr-only` word
      and no child component. A child component is "opaque": reported (1 today), never silently passed.
   5. *Count elements, not files and not ratios.* Coverage percentages are printed for people but never gate: adding 100
      compliant buttons must not make a violation look smaller.
   6. *A title is a title however it is written:* static, `[title]`, `[attr.title]`, `title="{{ x }}"`, and a binding
      that evaluates to `null` at run time still counts (the binding is the debt). SVG `<title>` children are not titles.
   7. *Where a control counts as exempt, say so out loud:* only `aria-hidden="true"` together with `tabindex="-1"`, or an
      explicit `data-ui-hints-exempt` marker with a known reason. The marker count is reported (and ratcheted in step
      4; once the records exist, a new marker is added only with `--exempt`, see 4a). A class-name guess such as "contains backdrop" is deliberately not used: it is gameable. The eight real cases
      today are the invisible backdrop buttons listed in step 4b (which also holds the one `local-key` marker).
   8. *Hard failures, never skips:* a template that does not parse, a template that cannot be analysed, a component with
      no template found, an orphan `.html`. Each prints the file and the reason.
   9. *Two methods must agree.* A measurement self-test compares the parser's counts of `title` attributes, `appTooltip`
      hosts and templates with an independent regex count over the same extracted template text with HTML comments
      stripped. A disagreement fails with "measurement drift", which is what an Angular upgrade that changes the AST
      would look like.
3. **New CLI `scripts/audit-ui-hints.ts` (~150 lines) and `package.json` script `"audit:ui-hints": "tsx
   scripts/audit-ui-hints.ts"`.** Default output: the table above, a per-folder table and the coverage ratios. Flags:
   `--json`, `--list <rule>` (every violation with `file:line` and a one-line fix hint), and `--root <dir>` (so specs can
   point it at fixtures). The per-folder table is the worklist for part 3's folder-by-folder step (1f).
4. **Leave `scripts/audit-native-titles.js`, its spec, the `--fail-on-blocking` step at `package.json:49` and
   `icon-control-tooltip.spec.ts` exactly as they are** until step 4c replaces them in one change.
5. **This step only measures.** It computes the rule violations so the report can show them, but nothing fails on a
   count. Parse errors, unanalysable templates and measurement drift still stop the run.

**Tests:** `scripts/__tests__/ui-hints-facts.spec.ts` (fixture templates as strings) and
`scripts/__tests__/ui-hints-measurement.spec.ts` (the real tree). "Old audit" marks cases the current script gets wrong.
- `@if`-only content is icon-only (old audit: named).
- `&times;`, `&#x2715;`, `×` and `x` alone are icon-only (old audit: `&times;` named).
- `aria-label=""`, `aria-label=" "` and `aria-label="x"` are not names; `[attr.aria-label]="label()"` is a data name.
- A title-less icon button is found (old audit: invisible).
- `{{ on ? '×' : '↻' }}` is icon-only; `{{ item.label }}` is named by data and reported separately.
- `sr-only` text, an SVG `<title>`, and a `<label for>` or wrapping label name a control; a native `title`, a
  `placeholder` and an `appTooltip` do not.
- Controls inside `@if`/`@else`, `@for`/`@empty`, `@switch`/`@case`/`@default` (Angular 22 `groups`), `@defer` with
  placeholder, loading and error, `<ng-template>` and a `*ngIf` wrapper are all seen, and a `*ngIf` element is counted
  once.
- A `title` in an HTML comment is not counted; a template that fails to parse aborts with its file and line.
- A non-literal `template:` and a missing `templateUrl` are reported as unanalysable, not skipped.
- A static `title` on `<app-x>` is counted as a component-host title, not a control title.
- `aria-hidden="true"` with `tabindex="-1"` is exempt; either alone is not; the marker needs a known reason.
- A static `appTooltip` on a component whose `imports` lacks the directive is reported as inert, and a host in a component
  that imports it is not.
- A bound hover that calls a member of the same component (`[appTooltip]="closeTooltip()"`, with two string literals in the
  member) yields those literals as fragments; so does a call to a function imported from the same folder (one level deep);
  a call to a service, a pipe or a function from another folder is unreadable; `item.label` is data and neither.
- Real tree: analysed templates equal the `@Component(` count (305 today); parser `title` plus TypeScript-string titles
  equal the raw regex count; parser tooltip hosts equal the regex count; the scan is non-vacuous (more than 1,000
  controls and more than 50 tooltip hosts) so a silently empty scan cannot pass; and the inert count is 0 once 2b has
  landed (it is 1 before).
- CLI: `--json` is valid JSON; `--root` on a fixture folder reports the seeded violations; the exit code is 0 for a
  report.

**Risks:**
- *The honest numbers look worse.* Expect "127 icon-only controls need work" (66 + 36 + 23 + 2) where the old gate said
  0. Say so in the change description. Nothing user-visible changes.
- *Angular upgrades.* Node classes can change shape again (as `SwitchBlock` did). The visitor base class plus the
  two-methods self-test is the defence; the self-test fails loudly rather than under-counting.
- *Runtime.* Parsing 305 templates plus about 700 TypeScript files takes a few seconds; the 76 external templates alone
  parse in about 0.3 s.
- *Child components are opaque.* A control whose content is a child component is reported, not judged. One today.
- *Scope.* Only `src/renderer`. Templates rendered by other packages would need their roots added.
- *Unnamed form fields are reported, not gated.* The message box and 26 inputs in the verification pages have no name;
  no rule in step 4 covers inputs (see [Found on the way](#found-on-the-way-not-fixed-here)).

**Done when:**
- `npm run audit:ui-hints` prints the table above (within the drift the code has had since 10 Oct), and `--list H1a`
  names the composer's wake-up and voice buttons.
- `npm run test:quiet -- scripts/__tests__/ui-hints-facts.spec.ts scripts/__tests__/ui-hints-measurement.spec.ts` passes;
  the cases marked "old audit" fail if pointed at the old regex functions.
- `npx tsc --noEmit` and `npm run check:ts-max-loc` pass with the new files (counted by hand until tracked); the old
  audit and its gate are unchanged.

**Live checks:** none. Static analysis only.

### 2b. The "Completed" dot gets its hover hint (XS)

**For James:** in the history list, the small dot that marks a finished conversation you have not opened yet will now say
"Completed — click to view" when you point at it. It was written to, but a missing line of code switched it off.

**Verified (10 Oct):**
- `features/instance-list/instance-list.component.html:472` is `appTooltip="Completed — click to view"` on a
  `<span class="history-entry-unread-dot" role="img" aria-label="Completed">`. The component's `imports` array
  (`instance-list.component.ts`, around `:85`) does not include `AioTooltipDirective`; the file does not mention it
  anywhere. A static `appTooltip="…"` with no directive is just an inert attribute (a bound `[appTooltip]` would be a
  compile error; a static one is not).
- Of the 30 files that carry an `appTooltip` attribute, this is the only one that does not import the directive. So the
  audit's "100 hosts" is 99 live ones.
- After the fix the dot is a tooltip host that already has a name (its `aria-label`), so it is not a new "hover-only"
  finding in step 4.
- `instance-list.component.ts` is 1,481 lines (ceiling 1,435 + 50), so it has **4 lines of room**. Phase 3's C4 needs +1 and this
  part +1 (the array entry is on the existing `imports:` line); Phase 5's C12A shrinks the file by deleting its inline archive
  code. Re-measure first, and land C12A's shrink first if the total would pass 4.

**Change:**
1. Add `AioTooltipDirective` to the component's imports (one `import` line and one array entry on the existing
   `imports:` line). Keep the wording as it is. If C4 has used the room, move a small helper out first.

**Tests:**
- `ui-hints-measurement.spec.ts`: the real-tree inert count is 0 (it is 1 before this change). **Fails today.**
- A TestBed case for the history list: with an unread, completed history entry, hovering the dot opens a `role="tooltip"` showing
  "Completed — click to view". **Fails today** (the directive is not imported). No spec renders the list component today
  (`history-rail-filtering.spec.ts` covers its data only), so create `features/instance-list/instance-list.component.spec.ts` with
  seeded stores. If seeding the whole list component proves too heavy, the measurement case above and the live check are the evidence.

**Risks:**
- A new tooltip appears over a dot inside a clickable row. It uses the normal 200 ms delay and the post-click block, so
  it does not cover the row after a click.

**Done when:**
- `npm run audit:ui-hints` reports 0 inert tooltip attributes.
- The dot opens the tooltip in the spec.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “2b. The "Completed" dot gets its hover hint (XS)”.

## Step 3. D8: One page of house rules for screens and wording (S)

### 3a. The guide, the pointer and the guard (S)

**For James:** anyone, human or agent, about to change a screen or its wording is pointed at one short page of house
rules: plain English, one name per thing, nothing on screen unless it needs attention. New screens then stay calm
instead of copying today's cluttered ones. Nothing changes on screen.

**Verified (10 Oct):**
- **No instruction file points at any UI or wording standard.** `AGENTS.md` (142 lines, 10,505 bytes) has one paragraph
  pointing at conventions: line 111, "The complete repo-local Angular conventions are in `docs/angular-conventions.md`.
  Prompt changes must follow `docs/prompt-engineering-house-style.md`." `CLAUDE.md` is two lines (`@AGENTS.md`,
  `@docs/angular-conventions.md`). No spec, script or hook reads or pins `AGENTS.md`, so editing it breaks nothing.
  Harness's own per-file instruction cap is 32,000 characters (`src/main/core/config/instruction-cap.ts:45`), so there is
  room.
- **`docs/DESIGN.md` is the wrong thing to point agents at.** It is a 423-line architecture document whose goals include
  "Massive Scalability ... 10,000+ instances" and "Rich Visual Telemetry" (`docs/DESIGN.md:7-14`), the opposite of the
  calm-screen goal.
- **`docs/shell-component-standards.md` (151 lines) has a different job:** design tokens, the settings kit, shell layout,
  status pills, motion and a new-component checklist. Keep it as the token-and-layout reference and add the guide beside
  it. Its stale lines are fixed in 3b.
- **Which tools read `AGENTS.md`, so one sentence reaches all of them.** Claude Code loads `CLAUDE.md`, which imports
  `@AGENTS.md`. Copilot loads `AGENTS.md` directly and again through that import (twice, so the sentence costs about
  100 tokens there; Phase 0 records this as James's choice). OpenCode 2.x reads the project's `AGENTS.md` chain. Codex
  loads it natively (`src/main/core/config/native-instruction-ownership.ts:115-117` skips `agents` sources for Codex
  because the CLI already injects them). The pointer costs about 50 tokens per session and adds no line if it joins the
  existing paragraph.
- **A precedent for a doc that review must check:** `docs/prompt-engineering-house-style.md:50` "PR review must check this
  document whenever a change adds or modifies an LLM-facing prompt or parser."
- **The guide depends on Phase 3.** It names C5's banner rule, C6's `presentInstanceStatus()` and C7's word list in
  `src/shared/copy/ui-vocabulary.ts`. Nothing may be named that does not exist on the day it lands.

**Change:**
1. **New `docs/screen-and-wording-guide.md`**, a single page of at most 140 lines. Future-state, not a description of
   today's screens. It holds rules and links; it does not contain the word list, the glossary or the tooltip copy. Draft
   (trim to fit and adjust to what exists on the day):

   ```markdown
   # Screen and wording guide

   Read this before changing anything under `src/renderer/` or any text a user can see (labels, tooltips, messages,
   notifications, help). It says where Harness is going, not where it is. A screen that disagrees with this page is
   debt, not precedent: do not copy it. When James gives the same feedback twice, add it here as a rule.

   ## 1. Words
   - The product is "Harness". Never "AIO", "Orchestrator" or "AI Orchestrator" on screen.
   - Follow the word list in `src/shared/copy/ui-vocabulary.ts`: say the `use` name, never a `never` name. "Session",
     not instance, thread or chat. "Helper agent" for sessions another session started. A page title is its menu label.
   - Plain English, sentence case. Say what happened, what it means and what to do next. Codes, ids, raw statuses and
     stack text go behind "Details".
   - Never say Harness is fixing something unless a fix is running.
   - Remove introductory copy when the title, the control or a nearby status already explains the task. Keep only text
     that changes a decision, explains a failure or gives a required next step.
   - Settings names describe what the user wants done, not internal vocabulary.

   ## 2. Status
   - Session state comes from `presentInstanceStatus()`. No local label map and no local colour map.
   - State is never carried by colour or a glyph alone, and never only in a tooltip.
   - Healthy is invisible: no chip, dot or banner unless something needs attention or differs from the default.
   - Status panels explain; they do not configure. A link to Settings is fine; a second settings page is not.

   ## 3. What may sit in the session header and composer
   Always visible: what the agent may do without asking (auto-approve), the model, how full the context is, and Send or
   Stop. Anything else must pass all three questions:
   1. Would nearly every session use it?
   2. Can the state be read from somewhere else?
   3. Does the user choose it on purpose (a menu, `/`, `@`) rather than as a permanent switch? Abilities the agent picks
      for itself (tools, skills, MCP servers) never become persistent toggles.
   Every chip is visible, removable and says what it costs. On narrow windows the least-used items collapse first;
   auto-approve is never hidden.

   ## 4. Notices
   - A banner only if it changes what Send does. Anything else is one quiet line in the transcript with one action.
   - At most one banner row; extra ones collapse to "N more". Errors stay until dismissed and offer the fix as a button.
     A notice names the session and opens it.

   ## 5. Controls and hints
   - An icon-only control has a tooltip and an accessible name with the same words. No new `title=` on controls.
   - A tooltip is a short phrase: not a paragraph, not a copy of the visible label, and not a way to explain a menu item
     that could simply be named. Text lives in `TOOLTIP_COPY` when it carries a consequence, is used twice or is long.
   - A tooltip may elaborate, but it is never the only place a state or consequence appears. Anything that deletes,
     stops work, spends money or bypasses approval says so in visible text next to the control, or in a confirmation.
   - A control that stays disabled says why, in a way keyboard users get (`aria-disabled` plus the reason). A control
     disabled for a moment shows progress in its label.
   - Shortcuts shown to the user come from the live key bindings, never typed glyphs.

   ## 6. Reviewing a renderer change
   Look at the changed lines only. Do not build, trace or ask for screenshots. Report each of the following that you can
   point to, with the line. If none apply, answer exactly `All clear`.
   1. An icon-only control without a tooltip and an accessible name.
   2. A native `title` on a control.
   3. New raw status text, internal code or jargon in text a user can see.
   4. A local status-to-label map instead of `presentInstanceStatus()`.
   5. A destructive, money-spending or auto-approving action whose consequence is not shown next to it.
   ```

   Lines that later steps add, each in its own change, so the guide never names something that does not exist: step 4c
   adds "The template ratchet (`npm run check:ui-hints`) already fails on 1 and 2 file by file; reviewers make the judgement
   calls in 3 to 5" to section 6; step 5 names `[appIconButton]`, `appTooltipShortcut` and `appTooltipDisabledReason` in
   section 5; step 6 adds "A word that needs explaining gets an entry in `GLOSSARY` and `<app-term>` on its first use"
   to section 1.
2. **One pointer in `AGENTS.md:111`, no new line.** Extend that paragraph with: "Before changing anything under
   `src/renderer/` or any text a user can see, read `docs/screen-and-wording-guide.md`; when reviewing a renderer
   change, apply its section 6." About 190 bytes (1.8 percent of the file). Do **not** `@`-import the guide from
   `CLAUDE.md`: that would load it into every Claude session, loop round and reviewer.
3. **Make the failures point back to the guide.** Every guard that enforces a guide rule ends its failure message with
   "See docs/screen-and-wording-guide.md, section N". Step 4's hint for every hover rule ends with section 5. Phase 3's two
   guard specs (the vocabulary guard, section 1; the status-presentation guard, section 2) also need the same one-line
   ending. If Phase 3 has not added it, add it here, since both exist by now.
4. **Two one-line cross-links:** `docs/DESIGN.md` gets a two-line note at the top ("Architecture overview. Not a UI
   standard: for screens and wording see docs/screen-and-wording-guide.md."), and `docs/shell-component-standards.md` gets
   one line under its intro saying words, tooltips and status rules live in the guide and this file keeps tokens and
   layout.
5. **New guard spec `scripts/screen-and-wording-guide.spec.ts`** (main Vitest project; the existing
   `scripts/audit-native-titles.spec.ts` is the model). It reads the repo files with `fs`.
6. **Keep it alive:** the guide's intro rule ("when James gives the same feedback twice, add it here") is the only
   maintenance process. No scheduled review.

**Tests:** `scripts/screen-and-wording-guide.spec.ts` (new). All fail today (the file does not exist).
- `AGENTS.md` names `docs/screen-and-wording-guide.md`, and that file exists.
- The guide is at most 140 lines and has sections 1 to 6 in order.
- Every backticked repo path in the guide (`src/...`, `docs/...`, `scripts/...`, `packages/...`) exists on disk, so a
  rename cannot leave a dead pointer.
- The guide says "Harness".
- (Step 8 adds the case that section 6 contains a keyword for each of the five checks exported by the reviewer module.)
- Optional, skipped by default: a byte cap on `AGENTS.md`. It would fail unrelated edits to that file.

**Risks:**
- A guide nobody enforces drifts. Mitigations: the guard messages, the section 6 checklist in review, and the
  one-sentence maintenance rule.
- The guide leans on Phase 3's outputs. It must be written after Phase 3 and name only helpers that exist on the day.
- Two docs on adjacent topics. Mitigated by the one-line division of labour in each.
- A pointer sentence is advice; an agent can skip it. The live check is how we find out.

**Done when:**
- The guide exists, is one page, and `AGENTS.md:111` points to it; the spec passes.
- The Phase 3 guards' failure messages cite a section of the guide.
- In a fresh session of each CLI, asked to add an icon button to a template, the transcript shows it reading the guide
  before editing.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “3a. The guide, the pointer and the guard (S)”.

### 3b. Two standards pages stop prescribing the old way (XS)

**For James:** two internal design pages still tell people to use the old grey-bubble hints on every button, and one still
calls the app "AI Orchestrator". They are corrected, so agents stop copying the old way. Nothing changes on screen.

**Verified (10 Oct):**
- `docs/shell-component-standards.md:3` says "AI Orchestrator desktop shell"; `:68-69` still says "Tooltip-first (`title`
  on every button)"; the new-component checklist (§8, `:141-151`) has no tooltip or accessible-name item.
- `docs/visual-qa-checklist.md` (78 lines) has no tooltip check in its Cross-cutting section (`:69-78`).
- This is the documentation half of the backlog's D7 (TT-13). It moves here because it rides with the guide: the same
  two files get the guide's cross-link, and agents read them during the migration.

**Change:**
1. `docs/shell-component-standards.md`: change `:3` to "Harness desktop shell"; replace the rail sentence at `:68-69` with
   "Every icon button uses `appTooltip` and an accessible name with the same words; never a native `title`."; add one §8
   item: "- [ ] Every icon-only control has a tooltip and an accessible name; every control that stays disabled says why; no
   native `title`."
2. `docs/visual-qa-checklist.md`, Cross-cutting section: add "- [ ] **Tooltips** — tab through the rail, sidebar and
   session header; every icon shows its tooltip on focus and every greyed-out control says why." Step 7c adds the Help
   line.

**Tests:** in `scripts/screen-and-wording-guide.spec.ts`: `shell-component-standards.md` no longer contains "`title` on
every button", does not say "AI Orchestrator", and its §8 mentions tooltips. **Fails today.**

**Risks:** none beyond wording.

**Done when:** both pages carry the new lines, and the spec passes.

**Live checks:** none.

---

## Step 4. D3: A guard that only lets problems go down, and cannot lose recorded wording silently (M)

Three parts: the code (4a), ten invisible markers (4b), and the part that writes the records last, switches the gates
over and deletes the old check (4c).

### 4a. The rules, the record logic, the wording ledger and the command (M)

**For James:** nothing changes on screen. This writes the guard itself: the rules, the way it compares today's counts
with a saved list, and the check that stops a warning sentence from disappearing. It is not switched on until 4c.

**Verified (10 Oct):**
- **The model to copy, and the one thing to change.** `scripts/check-ts-max-loc.ts` keeps per-file ceilings in an
  in-code table, a +50 tolerance (`:43-46`), `--warn` (`:53-54`), exit 1 when strict and exit 0 when warn-only, skips test
  files, and lists files with `git ls-files '*.ts'` (tracked files only). It fails only on growth: a file that shrank is
  not mentioned (the header says "should be re-tightened opportunistically"), so headroom piles up. The new guard keeps
  everything else but also fails on shrinkage (choice 9). Its spec builds a temp git repo and runs the CLI through `tsx`
  with `spawnSync` (`scripts/__tests__/check-ts-max-loc.spec.ts:1-80`); the new spec follows that pattern.
- **The guard spec being generalised.** `src/renderer/app/shared/tooltip/icon-control-tooltip.spec.ts` (238 lines) has four
  rule families, each limited to two templates (`MIGRATED_TEMPLATES`, `:43-46`): icon-only controls need a tooltip
  (`:78`), no native `title` on controls (`:117`), no nested hosts (`:146`), and hover-only hosts need a decision via the
  11-entry `ELABORATION_ONLY` table (`:199-212`). It borrows the old regex helpers (`:24-31`). A re-run of `git grep` on
  10 Oct shows only this spec, the old script's own spec, and `package.json:49,96` use the old script. Two comments name
  the spec and need a new target: `tooltip-copy.ts:47` and `features/loop/loop-formatters.util.spec.ts:534`.
- **A title-count ratchet rewards deleting titles, which is the exact failure James is worried about.** Removing
  `title="Discard changes (revert to HEAD)"` from a labelled button lowers the native-title count and trips no other rule.
  The repo has lived it: UX3 swapped the Terminate hint for an `aria-label` (`icon-control-tooltip.spec.ts:1-12`), and
  `tooltip-copy.ts:13-36` now says "It does not mean 'remove the hover'". House rule 4 adds that a tooltip "may not be
  the only carrier" (`tooltip-copy.ts:37-52`). So the count ratchet is paired with a wording ledger (H9). Counts alone are
  not safe.
- **H5 sites today (11, element start lines, from the parser):**
  `features/dashboard/dashboard.component.html:71` "Show sidebar (⌘B)"; `features/dashboard/sidebar-header.component.ts:31`
  "New session (⌘N)"; `features/dashboard/workspace-rail.component.ts:97` "Sidechats (⌥⌘S)", `:121` "Session history
  (⌘H)", `:133` "Settings (⌘,)"; `features/instance-detail/input-panel.component.html:509` "Stop current turn (Esc)";
  `features/side-chat/side-chat-panel.component.html:35` "Close panel (⌥⌘S)"; `features/source-control/source-control-diff-viewer.component.ts:67`
  "Close (Esc)"; `.../source-control-repo-actions.component.ts:184` "Commit staged changes (⌘+Enter)";
  `.../source-control.component.html:132` and `:222` "⌘/⇧-click to multi-select". These are element start lines: the diff viewer's
  "Close (Esc)" is on the `<button` line `:67`, while step 5c cites `:71`, the line of its `appTooltip=` attribute. **Blind spot,
  narrowed by the second review:** hover text computed in TypeScript is not a template literal, so on its own it is invisible. The
  reader (step 2) therefore also reads text written in a member of the same component, which brings in
  `input-panel.component.ts:497-500` ("Send message (Enter)", bound at `input-panel.component.html:527`) and
  `instance-header.component.ts:87` (bound at `instance-header.component.html:45`). So H5 starts at about 13 elements, not 11 (the
  reader's first report gives the exact figure). What stays invisible to H5 is text built by an imported helper or a service. A
  blunt "scan every string for ⌘" would be wrong: `models/model-selection-panel.component.ts:1057-1063` is a legitimate
  platform-aware label formatter. Step 5c's `appTooltipShortcut` is the real cure.
- **H10 is smaller than the 26.** 12 only call `$event.stopPropagation()`; 11 are `role="dialog"` or `"presentation"`
  containers whose handler closes the dialog; **3 have a real handler and no role at all**:
  `features/overlay/overlay-shell.component.ts:65` (`select(item)`),
  `features/verification/shared/components/agent-card.component.ts:25` (`handleClick()`) and
  `features/source-control/source-control-diff-viewer.component.ts:33` (a backdrop).
- **H11 sites today (7):** `core/services/markdown.service.ts:145,276` (HTML strings with `title=`), `:460,464,470,473`
  (`button.title = …`) and `core/services/codex-followup-markdown.ts:69`.
- **H6 today:** `TOOLTIP_COPY` has 35 keys (`command grep -cE "^  '[a-zA-Z.]+': \{" tooltip-copy.ts`). `loop.recycleToggle`,
  `loop.isolation` and `loop.verifyTwice` (`tooltip-copy.ts:182,187,191`) appear nowhere else in `src/renderer`, specs
  included (re-run with `git grep -F`). Live keys are reached as `copy('x')` in templates through `protected copy = copyFor`
  and as literals in `features/loop/loop-tooltip-copy.util.ts:18-64`, including a dynamic `copyFor(namedReason)` at `:64`
  whose keys are literals in the same file. So "used" must mean "the key text appears as a string literal anywhere else",
  not "a `copy('…')` call". Phase 0 step 2.6c wires `loop.recycleToggle`, so this guard will record **2** dead keys when it
  starts, not 3. The migration (part 2) splits the registry into several `tooltip-copy*.ts` files, so H6 must read keys from all of them.
- **The eight backdrop buttons would be false alarms without a marker.** Each has an `aria-label`, no tooltip, and neither
  `aria-hidden="true"` nor `tabindex="-1"` (4b).
- **The old `ELABORATION_ONLY` table maps cleanly.** Of its 11 classes, 7 are real hover-only hosts today and become the
  first H4 reasons: in `features/instance-list/instance-row.component.html` `approval-chip`, `remote-badge`, `diff-stats`;
  in `features/loop/loop-control.component.html` `ls-pill`, `ls-text`, `lp-badge` (two hosts) and `loop-gate`. The other four
  (`automation-clock`, `leading-indicator`, `unread-dot`, `collapsed-badge`) carry an `aria-label`, so the new H4 test
  already skips them (`icon-control-tooltip.spec.ts:208-211` says "listed for completeness").
- **Wording ledger sizing (parser, 10 Oct).** 332 hover fragments have two or more words. 60 contain a consequence word (29
  on the narrow destructive list); 97 have seven or more words; together 127, of which **110 have three or more words**.
  **None** of the 127 is also present as visible text in its own component today, so every one is hover-only. That is the
  debt the migration (parts 2 and 3) reduces, and why "now carried by visible text" must count as still carried. These counts
  were taken before the second review's changes (the reader now follows same-component members, and the consequence list has
  six more words), so the first real report will show a larger ledger.
- **Hover text that is computed in a component (second review, 10 Oct; an approximate regex scan, not the parser).** Of 217
  bound `[title]`, `[attr.title]` and `[appTooltip]` bindings in non-spec templates, 23 go through `copy()` or `copyFor()`, 68
  contain a literal fragment, and 126 are plain expressions or method calls with no literal text. Most of those 126 are data
  (paths, labels, ids). The ones that matter call a member of the same component whose body is a warning:
  - `closeTooltip` and `restartTooltip` (bound at `features/instance-list/instance-row.component.html:198,207`, and also the
    `aria-label`). The sentences live only in `instance-row.component.ts:349-355`: "Close session — stops this child agent and
    removes it from the tree", "Close session — stops the agent and moves this thread to history", "Restart with fresh
    context — the conversation so far is not carried over" (checked on 10 Oct).
  - `remoteNodeBadgeTitle` (`instance-row.component.ts:279-284`, "Node '…' disconnected — session may be interrupted"),
    `quotaParkDetail` and `authDetail` (`composer-banners.component.ts:265-269, 295-299`: "resumes at …", "re-sent
    automatically") and the Loop switch's `title` ("Loop ON — click to stop", `loop-toggle.component.ts:127-132`).
  - `closeTooltip` is the incident control (`tooltip-copy.ts:20-24`: "the session-ending button ... lost its `title`"). A
    ledger that cannot read it would not protect the one button this guard exists for, and a migration edit that swapped it for a
    short literal name would keep every other guard green. That is why the reader and the ledger follow same-component
    members and same-folder helpers (4a item 4) and count what they cannot follow.
- **Wiring facts.** `package.json:49` `verify` runs `audit:native-titles -- --fail-on-blocking`; `:55` `check:ts-max-loc`;
  `:96` `audit:native-titles`. CI has the size ratchet at `.github/workflows/ci.yml:66-67` and `npm run lint` at `:48-49`.
  Local hooks run `check:ts-max-loc -- --warn` (`scripts/run-git-hook.js:24` pre-commit, `:51` pre-push), pinned by
  `scripts/__tests__/run-git-hook.spec.ts:22,43`. `scripts/check-ts-max-loc.ts` is dirty from another session (two ceilings
  raised); this step neither edits nor needs it.

**The rule catalogue** (the codes step 2 already uses):

| Code | Rule | Status | Expected on 10 Oct | Cured by |
|---|---|---|---|---|
| H1a | Icon-only control has no accessible name | ratchet | 25 (23 nothing + 2 title-only: the wake-up `input-panel.component.html:353` and voice `:472` buttons) | parts 2 and 3 |
| H1b | Icon-only control has a name but no Harness tooltip | ratchet | about 94 (66 + 36, minus the 8 marked backdrops) | parts 2 and 3 |
| H1c | Static name and tooltip disagree (the tooltip must begin with the name) | report only until 5e | 1-2 (`loop-control.component.html:392`, "Dismiss" against "Hides this summary...") | step 5e |
| H2a | Native `title` on a control | ratchet | 216 | parts 2 and 3 |
| H2b | Native `title` on a plain element | ratchet | 142 | parts 2 and 3 |
| H2c | `title` written on a component host (an input named `title`; Angular also writes the DOM attribute) | ratchet | 32 | part 3's 1e (rename the input) |
| H3 | Tooltip or title host nested inside another host | ratchet | 18 elements (2 tooltip-in-title + 16 title-in-title) | parts 2 and 3 |
| H4 | Hover-only host (not focusable, no name) with no listed reason | ratchet | 143 (11 tooltip + 132 title) | parts 2 and 3, or a reason |
| H5 | Hard-coded shortcut text in a hover string | ratchet | about 13 (11 in templates, plus the two bound members the reader now follows) | 5c and parts 2 and 3 |
| H6 | `TOOLTIP_COPY` key with no use | ratchet | 2 (3 before Phase 0 step 2.6c) | 6c |
| H7 | Lasting disabled control with no reason channel | report only | about 120 (the audit counted 192 by another method) | 5d |
| H8 | First use of a glossary term is not marked | dormant until 6a, then report only | n/a | step 6 |
| H9 | Recorded hover wording lost, or the count of hover text the reader cannot follow rises | hard (the ledger, plus a ratcheted count) | 0 | n/a |
| H10 | `(click)` on a non-control with no role at all | ratchet | 3 | part 3 (give it a role and keyboard handling), or a `backdrop` marker added with `--exempt` |
| H11 | Hover text built outside templates (HTML strings, `.title =`, host bindings) | ratchet | 7 | no step; a standing exception |
| H12 | Measurement integrity and exemptions (unreadable template, drift, an unused or unknown marker, a stale reason, an inert tooltip attribute) | hard | 0 (1 before 2b) | n/a |

H2 counts native titles everywhere, not only on controls as the backlog line says, so the bridge from step 1 can in
principle be deleted (choice 10). H4 and H2b overlap on purpose: H2b says "convert it", H4 says "make it reachable or give
a reason".

**Change:** (step 2 must have landed; it supplies the reader, the facts, `rules.ts` and `ownerFile`)
1. **Shared constants (`scripts/ui-hints/types.ts`, about +40 lines).** Export in one place: `RULE_CODES` (the baselined
   codes H1a H1b H2a H2b H2c H3 H4 H5 H6 H10 H11), `REPORT_ONLY` (H1c, H7), `DORMANT` (H8), `HOVER_BINDINGS` (`title`,
   `appTooltip`), `TOOLTIP_PROVIDERS` (`appTooltip`, `appTooltipTpl`), `NAME_PROVIDERS` (`aria-label`, `aria-labelledby`) and
   `EXEMPT_REASONS` (`backdrop`, `decorative`, and **`local-key`**: a key handled by that screen alone, the same on every
   platform and not a rebindable action; it exempts only H5 and is added by this plan so the one literal "Close (Esc)" in
   part 3's step 1c can reach zero; step 4b places the marker). Step 5 appends `appIconButton` to `HOVER_BINDINGS`, `TOOLTIP_PROVIDERS` and `NAME_PROVIDERS`.
2. **`scripts/ui-hints/rules.ts` (about +130 lines).** Add the evaluators step 2 does not have:
   - H6 `findDeadCopyKeys`: keys from the `TOOLTIP_COPY` object in every `tooltip-copy*.ts` file via the TypeScript AST,
     following spreads. A key is used if its text is a string literal in any other non-spec renderer `.ts` file or appears
     quoted in any template. Comments never count.
   - H7 `findLastingDisabled` (report only): a control with `[disabled]` whose expression has none of
     `busy|loading|saving|submitting|pending|running|sending|working|starting|stopping|processing|waiting|generating|applying|deleting|installing|uploading|downloading|connecting`
     and which has no tooltip, title or `aria-describedby`.
   - H1c (report only).
   - H10: a real `(click)` handler (not only `$event.stopPropagation()` or `preventDefault()`) on a non-control,
     non-component-host element with no `role`.
   - H8: a stub that returns nothing and is listed as dormant.
3. **New `scripts/ui-hints/baseline.ts` (about 190 lines).** Types and pure functions, no I/O except two helpers.
   - `measure(analysis)` returns `{ rules: {H1a: {ownerFile: n}}, markers: {backdrop: {ownerFile: n}}, unreadable: {ownerFile: n} }`.
   - `compare(measured, baseline)` returns findings of kind `new` (measured above baseline; a file with no entry has
     baseline 0), `stale` (measured below baseline), `unknown-rule`, `unsorted` and `zero-entry`.
   - `tighten(measured, baseline)` lowers numbers (rule, marker and unreadable counts), drops zero entries and deleted files, and refuses (returns the `new`
     findings) if anything went up. `initBaseline(measured)` writes the first record.
   - `transfer(baseline, from, to, {rule?, count?})` moves existing debt and never raises a total.
     `compareBaselines(prev, next)` backs `--against`.
   - `serialize` writes sorted keys, two-space indent, one file per line and a trailing newline, so concurrent edits to
     different files merge cleanly.
   - **Keys are the owner component's `.ts` path (`ownerFile`), not the template path**, so moving a template between
     inline and `.html` changes nothing. They are stored repo-relative with forward slashes (normalise Windows backslashes
     when reading, and use the same form for the ledger's `owner`), so a run on a Windows machine matches the record; the
     ratchet spec feeds one backslash path.
4. **New `scripts/ui-hints/wording-ledger.ts` (about 230 lines): H9.**
   - `tokens(text)`: NFKC, lower case, `/[\p{L}\p{N}']+/gu`, **after deleting shortcut text**. "Discard changes (revert to HEAD)" and "discard
     changes - revert to head" are the same words. Shortcut text is a parenthesised group that contains a modifier glyph (`⌘ ⌥ ⇧ ⌃`) or
     `Cmd+`, `Ctrl+`, `Alt+` or `Shift+`, or is exactly `(Esc)` or `(Enter)`, plus any bare glyph run with its key; it uses the same pattern
     constant as H5. Without this, moving "(⌥⌘S)" or "(Esc)" out of a hover into `appTooltipShortcut` would count as lost words (`s`, `esc`;
     checked on 10 Oct with this tokenizer), although the recipe allows exactly that move.
   - `classify(text)`: `'consequence'` if it matches the consequence list (delete, discard, revert, remove, terminate, kill,
     force, overwrite, reset, wipe, lose/lost, irreversible, permanent, YOLO, auto-approve, bypass, unsaved, not saved,
     crash, revoke, disconnect, archive, restart, clear, send/sent, replace, empty, sign out, plus stop, cancel, close,
     cost, spend, never, cannot, expire); `'long'` if it has seven or more words; otherwise null. Fewer than three words
     is never recorded. The last six words before "plus" were added after the second review: the recipe's own categories
     "restarted" and "sent elsewhere" had no word in the list, so short sentences such as "Clear all notifications" (three
     words, destructive) and "Will send before passive queued messages" (six words) were not recorded. The "long" threshold
     stays at seven.
   - Per owner, build one **stream**: every hover fragment (title, appTooltip, any `HOVER_BINDINGS` entry, `copy()` keys
     resolved to their text, and the literals the reader finds in a same-class member (or a same-folder helper it calls) that a
     hover binding calls) plus all
     visible text (static text and the literal fragments of bound text). `aria-label` is
     deliberately not in the stream: the repo's own rule says it is invisible to sighted users (`tooltip-copy.ts:13-36`).
   - **Hover text the reader cannot follow** (a bound hover that calls a service method, a pipe or a function imported from
     another folder) is counted per owner file as `unreadable` in `baseline.json`. That count may not rise, so a sentence cannot move into a
     place the ledger cannot read without the guard failing; `--tighten` lowers it. Plain data reads such as `item.label`
     are not counted, since they carry no authored wording.
   - An entry `{ id, owner, text, why, retired? }` is **carried** if its tokens appear as a contiguous run in its owner's
     stream. A longer sentence that contains the old words still carries it; reordered or reworded text does not.
   - `checkLedger` fails with "H9 hover wording lost", naming the entry, the owner and the **lost words**, and prints the
     two ways out: keep the words (in a tooltip or in visible text of that component), or `--retire <id> --reason "..."`.
     `recordNew` only adds. A retired entry needs a reason of at least 20 characters that no other entry uses, stays in the
     file as an audit trail and is not enforced. Retiring is a visible change to `wording-ledger.json`, not a blocked one: a
     shell loop could retire every entry with throwaway reasons, and the diff and the list that `--against` prints are where
     review would see it.
   - A new qualifying string that is not in the ledger is a notice, not a failure, and the notice names
     `--record-wording`. The ledger is therefore a snapshot of the sentences recorded so far, and each migration part records
     its new ones (part 2, recipe item 6). The claim is "cannot lose recorded wording silently".
5. **New `scripts/ui-hints/hover-only-reasons.ts` (about 40 lines).** `HOVER_ONLY_REASONS: Record<string, string>` keyed
   `<ownerFile>#<tag>.<firstClass>`, seeded with the seven migrated entries and their original reason text, for example
   `'.../loop-control.component.ts#span.ls-pill': 'visible text is the status label'`. A reason that matches no host is an
   H12 failure (stale), so the list cannot rot.
6. **New CLI `scripts/check-ui-hints.ts` (about 170 lines), `"check:ui-hints": "tsx scripts/check-ui-hints.ts"`.**
   - Default is the strict gate. Flags: `--warn` (print, exit 0), `--tighten`, `--init` (refuses if the record exists unless
     `--force`), `--transfer <from> <to> [--rule Hx] [--count n]`, `--exempt <ownerFile> <reason>`, `--record-wording`,
     `--retire <id> --reason "<text>"`, `--against <git-ref>`, `--root`, `--baseline`, `--ledger` (for fixture runs) and
     `--json`.
   - `--exempt` is the one approved way to add a marker once the records exist (the reasons are `backdrop`, `decorative` and
     `local-key`). Add the `data-ui-hints-exempt="<reason>"` attribute to the template first; the command then raises that
     file's marker record by the number of new markers it finds, and changes nothing else. It refuses an unknown reason, a
     file with no new marker, and a run in which any rule number went up. `--tighten` never raises a marker count. The change
     shows as a line in `baseline.json`, which review reads.
   - `--against` is the second lock, and it covers both records. For `baseline.json` it fails if any rule total, or any file
     entry, is higher than at that ref (exact equality alone lets someone raise a number and add a violation in one hand
     edit). For `wording-ledger.json` it fails if an entry present at the ref is gone or its words were edited, and it lists
     every entry retired since then with its reason. Retiring stays allowed; it is made visible, not blocked, because a
     failure here would block the sanctioned `--retire` path. Run it by hand in review and in the fresh-eyes gate, and in CI
     on pull requests (see 4c: the checkout there is shallow, so it needs the base commit fetched).
   - Output on failure: one block per finding with the rule code, the owner, the measured and recorded numbers, up to 20
     `file:line` hits, and a one-line fix hint from the catalogue. Each fix hint for H1 to H5 and H9 to H11 ends "See
     docs/screen-and-wording-guide.md, section 5". On success: one line with the per-rule totals, the marker count, the
     ledger size and the number retired. The header comment holds a "how to fix each code" table.

**House TypeScript flags that shape all the new code** (root `tsconfig.json:17-30`, no `extends`): `strict`,
`noPropertyAccessFromIndexSignature` (so `process.env['X']` and `baseline.rules['H2a']`, as `check-ts-max-loc.ts:44`
does), `noImplicitReturns`, and no `resolveJsonModule` or `allowJs`. Read `baseline.json` and `wording-ledger.json` with
`readFileSync` plus `JSON.parse`, never `import`. `scripts/` specs are type-checked by the root `tsc --noEmit`.

**Tests:** all new; the first three are the guards. Files are in `scripts/__tests__/`.
- `ui-hints-wording.spec.ts`:
  - `title="Delete all conversation history" replaced by appTooltip="Delete history" fails H9 and names the lost words` (the
    incident class; remove the ledger check and it passes).
  - `[appTooltip]="closeTooltip()" replaced by [appIconButton]="'Close session'" fails H9 and names the lost words "stops" and
    "removes"` (the incident control, whose sentences live in the component's code; the reader follows `closeTooltip`).
  - `a hover sentence moved from a same-class member into a helper in another folder is reported as lost, and the unreadable
    count rises`.
  - `the hover removed and only an aria-label kept fails` (the UX3 Terminate regression).
  - `the same words moved into visible text of the same component pass`; `moved into a TOOLTIP_COPY key used by that
    component pass`; `a longer sentence containing the old words passes`; `reordered words fail`.
  - `moving a shortcut into appTooltipShortcut is not a lost word` ("Close panel (⌥⌘S). Running sidechats keep going." becomes "Close panel. Running
    sidechats keep going." and passes; so does "Stop current turn (Esc)" becoming "Stop current turn"; removing "Running" still fails).
  - `retire needs 20+ characters and a reason no other entry uses`; `--record-wording adds and never edits or removes`.
  - `classifier: "Delete all conversation history" is recorded as a consequence; "Cancel delete" matches a consequence
    word but has two words so it is not recorded; "Open file" is not; "Clear all notifications" and "Will send before passive queued messages" are`.
  - `every directive under shared/tooltip is classified as hover-text, name provider or neither` (passes today; fails the
    day step 5 adds a directive until it is classified).
- `ui-hints-ratchet.spec.ts` (library calls on fixture trees written to temp dirs, plus three CLI runs through `tsx`):
  - `passes when measured equals baseline`; `fails when a file gets one more violation and lists the file:line hits`; `a
    new file with any violation fails (no entry means zero)`.
  - `fails when a number is below baseline and names --tighten`; `--tighten lowers, drops zero entries and deleted files,
    and refuses to raise`.
  - `--init refuses to overwrite without --force`; `--transfer moves debt between components and never raises a rule
    total`; `moving a template from inline to .html keeps the count (keyed by owner)`.
  - `--against <ref> fails when any rule total or file entry rose, when a ledger entry is gone or its words were edited,
    and it lists every entry retired since the ref`; `markers are counted per file; an unknown or unused marker fails; adding
    one in a clean file fails until --exempt records it`; `--exempt records only a new marker, and refuses an unknown reason,
    a file with no new marker, or a run in which a rule number went up`.
  - `keys are repo-relative with forward slashes: a record read with a backslash path (a Windows run) matches`; `the
    unreadable count may not rise, and --tighten lowers it`.
  - `a hover-only reason exempts exactly its host; a stale reason fails`; `a local-key marker exempts exactly its host from
    H5 and from nothing else`.
  - `report-only and dormant codes (H1c, H7, H8) never appear in the baseline and never fail`.
  - `baseline hygiene: sorted keys, no zero entries, no unknown codes`.
- `ui-hints-rules.spec.ts` (table-driven, a failing fixture and its nearest compliant twin for each of H1a, H1b, H2a, H2b,
  H2c, H3, H4, H5, H6, H10, H11). The fixture table lives in a sibling helper, `scripts/__tests__/ui-hints-fixtures.ts`
  (about 150 lines), because step 9's parity spec (the lint plug-in) reuses it.
  - `H5 flags ⌘, Cmd+, (Esc) and (Enter) in static, bound and copy()-resolved hover strings, and does not flag visible text
    such as "Cmd+K for palette"`.
  - `H6: a key used only in a comment is dead; a key used as a literal in another file is live; a dynamic copyFor(var)
    does not hide keys that exist as literals; a key defined in a spread-in registry file is read`.
  - `H10 ignores stopPropagation-only handlers and any element with a role`.
  - `H2c fires for <app-empty-state title="x"> and not for an <iframe title="x">`.
  - `the real instance-row close button is a tooltip host, and the ledger holds both of its Close session sentences` (the migrated
    canary; the second half runs once 4c has written the ledger).

**Risks:**
- *Stale-headroom failures annoy.* A fix that forgets `--tighten` fails CI. Deliberate (choice 9); the message is one
  command.
- *Refactors that split a component* move debt between owners. `--transfer` is the sanctioned path, and `--against` keeps
  the totals honest.
- *Ledger friction for the migration parts.* Rewording a hover sentence needs `--retire` with a reason. That is the point; the output
  prints the lost consequence words so nobody can retire "delete" without seeing it. Strings outside the ledger (short
  labels) are protected only by H1a and H1b, and by the migration parts' diff review.
- *Hover text built outside the component and its folder is invisible* to H5 and H9: text from a service, a pipe or a helper
  in another folder cannot be read, so it is counted as unreadable and that count may not rise. Text written in a member of the
  same component (such as `input-panel.component.ts:497-500`) or in a helper beside it is read. Step 5c removes the need for
  hard-coded shortcut text.
- *Speed.* The CLI parses 305 templates and about 700 TypeScript files: a few seconds. Fine in CI and pre-push, too slow
  for pre-commit.
- *An Angular upgrade changes the AST.* Step 2's two-methods self-test fails loudly instead of under-counting.
- *Opaque controls escape H1 by design.* A control whose only content is a child component is reported by the reader but
  not gated (one today; a crude probe put it at `features/remote-nodes/remote-nodes-page.component.ts:45`; whether the child
  supplies text is not checked). If the opaque count grows, promote it to a ratcheted code.
- *Marker abuse.* Three reasons exist; the count is ratcheted; an unused marker fails; a new marker can only be added with
  `--exempt`, which shows in the diff.

**Done when:**
- The three guard specs and the rules spec pass on fixtures. Nothing is wired into `verify` or CI yet.
- `npx tsc --noEmit` and `npm run check:ts-max-loc` pass with the new files (counted by hand until tracked).

**Live checks:** none. Static analysis only.

### 4b. Mark the invisible backdrop buttons and the one local key (XS)

**For James:** nothing changes on screen or for the mouse. Nine invisible "click outside to close" layers, and one Close
button whose key (Esc) only that screen handles, get a hidden tag saying so, so the new guard does not mistake them for
unlabelled buttons or for a shortcut typed into a hint.

**Verified (10 Oct):**
- Eight invisible backdrop or scrim buttons were read one by one. For example `features/settings/settings.component.html:9`
  is `class="settings-nav-scrim" aria-label="Close settings navigation"`. Each has an `aria-label` and no tooltip, so they
  fall in step 2's "name only" bucket, and each lacks both `aria-hidden="true"` and `tabindex="-1"`. They are real tab
  stops (see [Found on the way](#found-on-the-way-not-fixed-here)); this part does not change that.
- A ninth is the backdrop `div` in the diff viewer (`source-control-diff-viewer.component.ts:33`, the only H10 backdrop).
- A tenth is the diff viewer's Close button: `<button` at `:67`, `appTooltip="Close (Esc)"` at `:71`. The Escape key is handled
  by that screen alone (`@HostListener('document:keydown.escape')` at `:328`, `(keydown.escape)` at `:36`), and the registry's
  Escape action `cancel-operation` is not customizable (`keybinding.types.ts:371-376`), so the literal is the same on every
  platform and is not a rebindable action. It is the only H5 site of that kind, and its exemption is `local-key`. The marker
  goes in here, with the other markers, so that 4c records all ten at once (a marker added later cannot be recorded without
  `--exempt`).

**Change:** add `data-ui-hints-exempt="backdrop"` (an invisible attribute, no wording) to:
- `features/chats/session-artifacts-strip.component.ts:181` (711 lines, room 68);
- `features/instance-detail/instance-header.component.html:83`;
- `features/instance-detail/session-progress-panel.component.ts:145` (745 lines, room 52; +1 line);
- `features/orchestration/child-diagnostic-bundle.modal.component.html:3`;
- `features/settings/settings.component.html:9` and `:364` (Phase 3's C11 may move these; carry the marker);
- `shared/components/node-picker/node-picker.component.ts:81` (306 lines);
- `shared/components/recent-directories-dropdown/recent-directories-dropdown.component.ts:184` (688 lines, room 12);
- `features/source-control/source-control-diff-viewer.component.ts:33` (332 lines), the H10 backdrop.

And add `data-ui-hints-exempt="local-key"` to the Close button in the same file (`:67`). Part 3's step 1c then leaves that
button's "Close (Esc)" text as it is.

**Tests:** covered by 4a's marker cases. The real-tree check in 4c reports a marker count of 10.

**Risks:** an inline-template file gains a line; each has room. A marker on an element that is later removed becomes an
unused marker, which fails the guard until it is removed (intended).

**Done when:** `npm run audit:ui-hints` lists the ten markers and `--list H1b` no longer lists the eight backdrops.
`npm run build:renderer` passes (templates changed).

**Live checks:** none; the attribute is invisible.

### 4c. Write the records last, switch the gates over, delete the old check (S)

**For James:** nothing changes on screen. The guard goes live in the build, and the old check that said "no problems" is
removed in the same change, so there is never a gap and never two competing checks.

**Change:** in this order. The last item below (writing the records) is the final action before verification. The tree is
red between items 3 and 6 by design, because the gate is wired before its record exists; do all six in one sitting.
1. **Check the tree is quiet.** Run `git status --short -- src/renderer` and note which template files other sessions are
   editing. The records capture whatever exists at that moment (for example `provider-accounts-tab.component.ts` is dirty
   today). If they are still moving, wait, or run again afterwards.
2. **Delete the old guard in this same change** (the files are tracked, so Git can restore them): `scripts/audit-native-titles.js` (303 lines),
   `scripts/audit-native-titles.spec.ts` (253) and `src/renderer/app/shared/tooltip/icon-control-tooltip.spec.ts` (238),
   only after each old assertion has a home:

   | Old assertion | New home |
   |---|---|
   | `:78-86` no glyph-only button without a tooltip in two templates | H1a and H1b over every template; both files have no record entry, so any finding fails |
   | `:90-101` the scan is not empty, and the Terminate button is a tooltip host | step 2's non-vacuity spec, plus one real-file case in `ui-hints-rules.spec.ts` that the `terminate` button in `instance-row.component.html` is a tooltip host and that the ledger holds its two Close session sentences |
   | `:117-137` no native title on controls | H2a |
   | `:146-178` no nested hosts | H3 (now also titled hosts) |
   | `:199-237` hover-only needs a decision | H4 plus `hover-only-reasons.ts` |

   Update the two comments to name `scripts/check-ui-hints.ts` (`tooltip-copy.ts:47`, `loop-formatters.util.spec.ts:534`).
   They are comment-only edits; `tooltip-copy.ts` has room.
3. **Wire it.**
   - `package.json`: add `check:ui-hints`; in `verify` (`:49`) replace `npm run audit:native-titles -- --fail-on-blocking`
     with `npm run check:ui-hints`; remove `audit:native-titles` (`:96`).
   - `.github/workflows/ci.yml`: add after `:67` a step `Check UI hints ratchet` running `npm run check:ui-hints`. On pull requests also run
     `npm run check:ui-hints -- --against <base commit>` (the second lock for both records). The checkout at `:29` is shallow (no `fetch-depth`), so
     fetch the base commit first (`git fetch --depth=1 origin <base sha>`) or set `fetch-depth: 0`; on pushes to `main` the plain check is enough.
   - `scripts/run-git-hook.js` pre-push (the `:51` neighbourhood): add `{ command: 'npm', args: ['run', 'check:ui-hints',
     '--', '--warn'] }`, and the matching pin in `run-git-hook.spec.ts` near `:43`. **Not** pre-commit: the analysis takes
     seconds and loop auto-commits must stay near-instant.
   - `AGENTS.md`: add `npm run check:ui-hints` to the canonical verification checklist (a separate spot from step 3's
     pointer sentence).
   - `docs/screen-and-wording-guide.md`: add the closing sentence to section 6 (step 3a lists it).
4. **Add the real-tree spec** `scripts/__tests__/ui-hints-baseline.spec.ts` (one run, a few seconds): "measured counts equal
   the committed records and every non-retired ledger entry is carried". This keeps `npm run test` self-sufficient; CI runs
   the CLI as well.
5. **Do the grep check:** `git grep -n "audit-native-titles\|audit:native-titles" -- package.json .github src scripts`
   prints nothing, and nothing under `scripts/` or `src/` imports the old script.
6. **Generate the records, last.** Run `npm run check:ui-hints -- --init`, then `npm run check:ui-hints --
   --record-wording`. This writes `scripts/ui-hints/baseline.json` (about 175 owner files, a few hundred lines) and
   `scripts/ui-hints/wording-ledger.json` (110 entries on 10 Oct before the member reading and the extra words; expect more). Then run the verification below.

**Tests:**
- `ui-hints-baseline.spec.ts` as above; `run-git-hook.spec.ts` updated for the new pre-push entry.
- Mutation checks, each reverted afterwards:
  - add `<button><svg></svg></button>` to any template: exit 1, H1a at that line;
  - add `title="x"` to a `<button>`: H2a;
  - delete `title="Delete all conversation history"` from `history-sidebar.component.ts`: H9 names "delete" and "history";
  - change `[appTooltip]="closeTooltip()"` in `instance-row.component.html` to a short literal name: H9 names "stops" and "removes";
  - remove one backdrop marker: H1b;
  - fix one real violation without tightening: the stale message.

**Risks:**
- *Red on day one.* Avoided only if the records are generated last and the tree is quiet. Another session's template edits
  landing after `--init` fail the guard until `--tighten` or a fix; the failure text says which.
- *Phases 1 to 3 add UI before the guard exists.* Any new `title=` or nameless icon button they add becomes recorded
  debt. The request in "Depends on" is how to keep the first record from being larger than it was on 10 Oct.
- *Behaviour change James will see:* none on screen. A red build now names the exact `file:line` and the fix.

**Done when:**
- `npm run check:ui-hints` exits 0 and prints one line with totals close to the catalogue (about 700 findings, 10 markers,
  about 110 ledger entries plus those that member reading and the extra words add).
- Every mutation check above behaves as listed.
- `npm run test:quiet -- scripts/__tests__/ui-hints-wording.spec.ts scripts/__tests__/ui-hints-ratchet.spec.ts
  scripts/__tests__/ui-hints-rules.spec.ts scripts/__tests__/ui-hints-baseline.spec.ts scripts/__tests__/run-git-hook.spec.ts`
  passes.
- `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc` and `npm run build:renderer` pass.
- `npm run verify` no longer runs the old audit.

**Live checks:** none. Static analysis only.

---

## Step 5. D4: Building blocks that make the right thing the easy thing (S-M)

Five parts, each shippable alone, in this order: the Windows and Linux label fix (5a), names read once (5b, which is the D1
follow-up from the Phase 0 plan), the live shortcut chip (5c), reasons on greyed-out buttons (5d), and the one-phrase icon
button (5e). 5b to 5d edit `aio-tooltip.directive.ts` and 5e builds on it: re-anchor line numbers after Phase 0 step 5 and after step 1.
This step adopts nothing itself. The first use of `[appIconButton]` is step 7c (the help buttons), so its live checks run on the
first adopters: 7c here for the icon button, and in part 2 the rail (1b) for the chip and the voice button and Loop switch (1d,
1g) for the reason. Those last two are recorded in part 2's livetest doc, not here.

### 5a. Windows and Linux hints say Ctrl, not Win (XS)

**For James:** on Windows and Linux, the Keyboard page and the command palette show "Win+H" for a shortcut that really
needs Ctrl+H. After this they show "Ctrl+H". The Mac is unchanged.

**Verified (10 Oct):**
- `keybinding.service.ts:283-293` `matchesPlatformKeyCombo` treats a `meta` binding as **Ctrl** off the Mac
  (`modifiers.map((modifier) => modifier === 'meta' ? 'ctrl' : modifier)`), but `keybinding.types.ts:573-584`
  `formatKeyCombo` prints `meta` as **"Win"** off the Mac (`{ ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win', cmd:
  'Win' }`). So on Windows `toggle-history` (`{ key: 'h', modifiers: ['meta'] }`, `:286-290`) fires on Ctrl+H, while
  Settings → Keyboard (`keyboard-settings-tab.component.ts:114`) and the command palette
  (`command-palette.controller.ts:104`) say "Win+H".
- `parseKeyCombo` turns `cmd`, `command` and `win` into `meta` (`:559`), so no default binding uses `cmd`.
- No spec covers it: `keybinding.types.spec.ts` is 43 lines and has no test of `formatKeyCombo` or `formatKeyBinding`.
- The backlog understated this: even the existing live display is wrong off the Mac, so wiring the existing pipe is not
  enough.

**Change:**
1. `shared/types/keybinding.types.ts` (669 lines, room 31): `formatKeyCombo` off the Mac prints `meta` and `cmd` as `Ctrl`
   and drops a duplicate when `ctrl` is also present, so the display matches `matchesPlatformKeyCombo`. About +5 lines.
   Mac output is unchanged.

**Tests:** `src/shared/types/keybinding.types.spec.ts` (43 lines today). **The non-Mac cases fail today.**
- `formatKeyCombo` off the Mac prints `Ctrl+H` for `meta+h` and `Ctrl+Shift+K` for `ctrl+meta+shift+k` (no doubled Ctrl).
- Mac output is unchanged (`⌘H`).

**Risks:** the Keyboard page and the palette text change on Windows and Linux. This is a visible correction; no behaviour
changes. The file's 31 lines of room are shared with Phase 3's wording pass (C6, C7) and C10; this change needs about 5.

**Done when:** the new cases pass; on the Windows PC, Settings → Keyboard shows "Ctrl+H" for History, and Ctrl+H toggles it.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “5a. Windows and Linux hints say Ctrl, not Win (XS)”.

### 5b. Screen readers hear a button's name once (XS)

**For James:** screen readers stop saying a button's name twice when its hover hint is just the same words. Nothing changes
on screen.

**Verified (10 Oct):**
- **The tooltip always points the button at itself.** `aio-tooltip.directive.ts:307-311` `applyDescribedBy()` runs from
  `show()` (`:215`) for every tooltip. Nothing compares the tooltip with the button's own `aria-label`.
- **The house contract makes them identical on purpose** (`tooltip-policy.ts:117-127`: "they must be the same string").
  Today that is met by hand. An approximate regex over every non-spec template finds about 46 of the 99 live `appTooltip`
  hosts (36 static, which a re-count on 10 Oct confirmed, plus 10 bound) whose tooltip equals their own `aria-label`, for
  example `input-panel.component.html:41-42` ("Remove folder reference" twice) and `composer-queue.component.html:70-71`.
  Those are the hosts whose behaviour changes. Step 2's reader gives the exact figure.
- **The comparison already exists.** `tooltip-policy.ts:93-97` `isRedundantWithLabel(text, label)` is a case- and
  whitespace-insensitive equality. Reuse it; do not write a second normaliser.
- **No existing test conflicts.** `aio-tooltip.directive.spec.ts` has no `aria-label` anywhere, so the existing describedby
  cases (`:98-126`) keep passing.
- The Phase 0 plan lists this under "Not in this plan" for D1; this part carries it.

**Change:**
1. `tooltip-policy.ts` (145 lines, room 555): add `export function shouldDescribeHost(tooltipText: string | null |
   undefined, hostAriaLabel: string | null | undefined): boolean`. It returns `false` when the text is empty or when
   `isRedundantWithLabel(text, hostAriaLabel)` is true; otherwise `true`. Doc comment: "A tooltip that only repeats the
   host's own accessible name adds a second announcement of the same words." Template tooltips pass the literal
   `'template'`, which never equals a label.
2. `aio-tooltip.directive.ts`: in `applyDescribedBy()` read `el.getAttribute('aria-label')`, call
   `shouldDescribeHost(text, label)` and return early without touching `aria-describedby` when it is `false`. Track
   `private describedByApplied = false` so `restoreDescribedBy()` does nothing when nothing was applied. `show()` passes the
   resolved text (after 5d, `effectiveText()`).
3. One sentence in the directive's header comment under "Deliberate behaviours": "**Does not describe a control by its own
   name.** When the tooltip text equals the host's `aria-label` the description is skipped, so assistive technology
   announces the name once."
4. Make step 1's bridge call `mergeDescribedBy` only when `shouldDescribeHost` is true.

**Tests:**
- `aio-tooltip.directive.spec.ts` (new host component per case, fake timers like `:83-126`):
  - `does not point a button at a tooltip that repeats its own aria-label` (`aria-label="Close"` + `appTooltip="Close"`, open
    it; `aria-describedby` is null). **Fails today.**
  - `ignores case and spacing when comparing` (`aria-label="Close panel"` against `appTooltip=" close  panel "`). Fails today.
  - `still describes a control when the tooltip adds to the name` (`aria-label="History"`, `appTooltip="Session history"`;
    describedby present while open, restored on close). Passes today; guards against over-skipping.
  - `keeps an unrelated existing aria-describedby when it skips` (`aria-describedby="hint"` stays `"hint"`).
  - `a template tooltip is still described` (uses Phase 0 step 5's template panel; the text is `'template'`).
- `tooltip-policy.spec.ts`: `shouldDescribeHost` returns false for equal, case-different and space-different strings, false
  for empty text, true for a different string, true when there is no label. Fails today (function missing).

**Risks:**
- Screen-reader output changes for about 46 hosts: the name is heard once instead of twice. That is the intent.
- A host whose `aria-label` is set by a later binding is read at show time, which is when it matters.
- `aria-labelledby` is deliberately not compared (its text needs a DOM lookup, and no host here relies on it).

**Done when:** with the new cases green, opening the tooltip on `<button aria-label="Close" appTooltip="Close">` leaves no
`aria-describedby`; on a host with a longer tooltip it is still set and then restored; the existing 389-line directive spec
passes untouched.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “5b. Screen readers hear a button's name once (XS)”.

### 5c. Hover hints can show the button's real shortcut (S)

**For James:** a hover hint can show the button's real keyboard shortcut as a small key chip. It follows you when you change
the key in Settings, shows nothing if the action has no key, and uses the right keys on Windows (today some hints show Mac
symbols).

**Verified (10 Oct):**
- **Shortcut text is hard-coded in 15 places in 11 files** (`command grep -rnE '⌘|⌥|⇧|Cmd\+|Ctrl\+|\(Esc\)|\(Enter\)'` over
  non-spec renderer `.ts` and `.html`, comments removed by hand). Hover or label strings: `workspace-rail.component.ts:106`
  ("Sidechats (⌥⌘S). Right-click for sidechat activity."), `:125` ("Session history (⌘H)"), `:137` ("Settings (⌘,)"); `sidebar-header.component.ts:34`
  ("New session (⌘N)"); `dashboard.component.html:74` (`appTooltip="Show sidebar (⌘B)"`); `side-chat-panel.component.html:39`
  ("Close panel (⌥⌘S)…"); `input-panel.component.html:513` ("Stop current turn (Esc)"); `input-panel.component.ts:497,499,500`
  ('Start loop (Enter)', 'Queue message (Enter)', 'Send message (Enter)', used as the tooltip **and** the `aria-label`, so
  the spoken name contains "(Enter)"); `instance-header.component.ts:87` (`Interrupt … (Esc)`);
  `source-control-diff-viewer.component.ts:71` ("Close (Esc)"; the `appTooltip=` line, while the guard reports the element's start line `:67`); `source-control-repo-actions.component.ts:169,189` ("⌘+Enter");
  `source-control.component.html:139,230,231` ("⌘/⇧-click"). A visible hint, not a hover: `input-panel.component.html:467`
  ("Cmd+K for palette"). A separate local solution exists at `features/models/model-selection-panel.component.ts:1057-1063`.
- **Which are real, rebindable actions:** `new-instance` (`keybinding.types.ts:202`), `toggle-sidebar` (`:280`),
  `toggle-history` (`:290`), `toggle-side-chat` (`:300`), `toggle-settings` (`:310`), `send-message` (`:352`, `:362`) and
  `cancel-operation` (`:372`). **Not** registry actions: the diff viewer's own Esc, the commit box's ⌘+Enter and the
  ⌘/⇧-click modifiers.
- **The live-text pipe has one consumer** (`keyboard-settings-tab.component.ts:114`), and `aria-keyshortcuts` has none in the
  renderer.
- **The first binding wins.** `getBindingByAction` is `allBindings().find((b) => b.action === action)`
  (`keybinding.service.ts:379-381`); `formatBindingByAction` is at `:393-395`. `send-message` has two bindings (Enter,
  non-customisable; Meta+Enter) and `toggle-command-palette` has two. The chip shows the first; `aria-keyshortcuts` can list
  every single-combo binding, space separated.
- **`shared/` may import from `core/`** (eight files already do, for example `shared/terminate-confirm/terminate-confirm.store.ts`),
  so the tooltip directive may use `KeybindingService`. Resolve it lazily through `Injector`, so the 100 hosts that never
  use a shortcut do not construct it and the existing directive spec needs no new providers (inferred from its injected
  dependencies at `keybinding.service.ts:61-64`: `DOCUMENT`, `NgZone`, `ActionDispatchService`, `SettingsStore`).

**Change:**
1. **New `core/keybindings/shortcut-display.ts` (about 60 lines, pure).**
   - `ariaKeyShortcut(combo, isMac)` returns the ARIA form (`Control+H`, `Alt+Meta+S`, `Enter`; letters upper-case; off the
     Mac, `meta` becomes `Control`).
   - `ariaKeyShortcuts(bindings, isMac)` joins every single-combo binding with a space and omits leader sequences.
   - `modKeyLabel(isMac)` returns `'⌘'` or `'Ctrl'` for the non-registry hints. Optionally, replace the private
     `shortcutModifierLabel()` at `model-selection-panel.component.ts:1060` with it (net negative; that file has 20 lines of
     room).
2. `core/services/keybinding.service.ts` (539 lines, room 161): add `ariaShortcutsByAction(action: string): string | null`
   (about +8 lines) reading `allBindings()` so it is reactive.
3. `aio-tooltip.directive.ts` (about 320 lines after steps 1 and 5b; this part adds about 40):
   - `readonly appTooltipShortcut = input<string | null>(null)`: a keybinding **action id**. At `show()` the chip text is
     `formatBindingByAction(id)` (an empty string when unbound; then no chip). A host binding `[attr.aria-keyshortcuts]` binds
     `ariaShortcutsByAction(id)` through a `computed`, so it is reactive and absent when unbound or when no id is set.
     `KeybindingService` is fetched with `inject(Injector).get(...)` only when an id is set.
   - `show()` passes `shortcut` to the panel.
4. `aio-tooltip-panel.component.ts` (53 lines; about 70 after Phase 0 step 5): `readonly shortcut = input('')`; in the template
   `@if (shortcut()) { <kbd class="aio-tooltip-kbd" aria-hidden="true">{{ shortcut() }}</kbd> }` after the text (hidden from
   assistive technology because `aria-keyshortcuts` carries the machine-readable form). Styles: a small monospace chip, 4px
   left margin, the panel's own border colour token.
5. Step 4 constants: `appTooltipShortcut` is a modifier, neither hover text nor a name provider. Add one line to guide
   section 5 naming it.

**Tests:**
- `aio-tooltip.directive.spec.ts` (new `describe` blocks; reuse `stubFocusVisible`, `:48-52`):
  - `shows the live binding as a chip` (customise `toggle-history` via `KeybindingService.customizeBinding`, open, the panel
    contains a `<kbd>` with the new text). Fails today.
  - `shows no chip and no aria-keyshortcuts when the action is unbound` (`resetBinding` or an unknown id).
  - `sets aria-keyshortcuts from the live binding and updates after a rebind`.
- `core/keybindings/shortcut-display.spec.ts` (new): `ariaKeyShortcut` for Mac and non-Mac, upper-case letters, `Enter`,
  `Escape`; `ariaKeyShortcuts` lists both `send-message` bindings and skips sequences; `modKeyLabel`.
- `keybinding.service.spec.ts`: `ariaShortcutsByAction` reflects a customisation.

**Risks:**
- The chip and the Keyboard page change from "Win+…" to "Ctrl+…" on Windows and Linux (5a). A visible correction.
- The `aria-keyshortcuts` host binding writes `null` when unset. No current host conflicts (no renderer file sets
  `aria-keyshortcuts`, checked with `command grep -c`). A future template that binds it itself on a tooltip host would fight
  the directive.
- No new per-host listener, and `KeybindingService` is not constructed for the 100 existing hosts.

**Done when:** the new cases pass, the ones marked "fails today" were seen failing first, and `appTooltipShortcut` is listed
in guide section 5. The Windows PC check (a button with `appTooltipShortcut="toggle-history"` shows "Ctrl+H", and the chip
changes after rebinding in Settings → Keyboard with no reload) runs on the first adopter, part 2's step 1b, and is recorded there.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “5c. Hover hints can show the button's real shortcut (S)”.

### 5d. Buttons that stay greyed out say why, and Tab reaches them (S)

**For James:** a button that stays greyed out for a lasting reason, such as no working folder, can say why. You can reach the
reason with the keyboard, because the button stays reachable instead of becoming a dead control.

**Verified (10 Oct):**
- **Existing `aria-disabled` patterns to copy:** `models/model-selection-panel.component.ts:136`
  (`[attr.aria-disabled]="row.disabledReason ? 'true' : null"`) and `shared/menu/menu-item.component.ts:43,62`. There is no
  global style for `[aria-disabled]`: `styles/_base.scss:177-180` styles only `button:disabled`, `.btn:disabled` is in
  `_component-utilities.scss:50`, and the hover rules there are `:hover:not(:disabled)`, so they do not exclude
  `aria-disabled`.
- **The tooltip is hidden while the host says `aria-expanded="true"`** (`aio-tooltip.directive.ts:275`, policy
  `tooltip-policy.ts:85-86`). That is right for menu openers and wrong for panel toggles that use `aria-expanded` for "the
  panel is open": `workspace-rail.component.ts:87` (`[attr.aria-expanded]="controlPlaneOpen()"`) and `:101`
  (`sideChatOpen()`), and the Settings collapse toggle (`settings.component.html:28-45`). Migrated as they are, they would
  lose their hint exactly when the panel is open, which a native `title` does not do.
- **The click-guard design is sound in the test runner.** A probe with the repo's jsdom 27.4.0 showed a capture-phase
  listener on the target ran first even though it was registered after a bubble listener, and `stopImmediatePropagation()`
  stopped the earlier bubble listener. Chromium has run at-target capture listeners first since version 89 (inferred;
  Electron 40 is far newer). So a swallowed click never reaches a template `(click)` handler on the same element.
- **The new host bindings clobber nothing today.** The three files that bind `aria-disabled`
  (`model-selection-panel.component.ts`, `overlay-shell.component.ts`, `menu-item.component.ts`) contain no `appTooltip`.
- **Unverified:** whether `[appTooltip]` opens on a disabled host in Harness's Chromium (the directive listens to
  `mouseenter` and `focus` on the host, `:92-95`). Phase 0 step 5 adds a spec and a live check. This route sidesteps the
  question, because the host is not disabled.

**Change:** (`aio-tooltip.directive.ts`; about +55 lines)
1. `readonly appTooltipDisabledReason = input<string | null>(null)`. The selector becomes `[appTooltip], [appTooltipTpl],
   [appTooltipDisabledReason]`. While the trimmed reason is non-empty ("reason active"):
   1. the tooltip text is the reason (it wins over `appTooltip`), written as a full sentence ("Unavailable: pick a working
      folder first.");
   2. host bindings add `aria-disabled="true"` and the class `aio-reason-disabled`;
   3. an effect registers `host.addEventListener('click', guard, true)` while a reason is active and removes it when it
      clears. `guard` calls `event.preventDefault()` and `event.stopImmediatePropagation()`. That blocks `(click)` handlers
      and form submission, including Enter and Space on a `<button>` (browsers turn those into a click);
   4. `onClick()` (`:180-183`) returns early while a reason is active, so clicking a greyed button does not close the reason
      the user is trying to read.
   The host stays focusable, so keyboard focus opens the reason (`onFocus` → `shouldOpenOnFocus`, `:173-178`).
2. `readonly appTooltipShowWhenExpanded = input(false)`: when true, `isSuppressed()` passes `expanded: false`. For panel
   toggles whose `aria-expanded` means "the panel is open". Menu openers keep today's suppression.
3. `registerTextSource(source: Signal<string | null>): void` (public, for companion directives): the lowest-priority text
   source. `effectiveText()` is `reason || appTooltip() || source?.() || null`; use it in `isSuppressed()` and `show()`.
4. `styles/_base.scss` (279 lines; stylesheets are not size-ratcheted): after `button:disabled` (`:177-180`) add
   `.aio-reason-disabled { cursor: not-allowed; opacity: 0.5; }` and the same for `a.aio-reason-disabled`.
5. The directive's header comment gets the convention: "Lasting condition (no folder, nothing selected, unsupported): use
   `appTooltipDisabledReason` and keep the control focusable. Short busy state: keep `disabled` and say it in the label
   ('Saving…')." Adopt the naming `xDisabledReason`: a computed called `<thing>DisabledReason` next to each
   `<thing>Disabled`. Guide section 5 names the input.
6. Step 4 constants: `appTooltipDisabledReason` goes into `HOVER_BINDINGS` and `TOOLTIP_PROVIDERS`.

**Tests:** (`aio-tooltip.directive.spec.ts`, new `describe` blocks)
- `a host with a reason is aria-disabled, shows the reason on focus and on hover`.
- `a click on a host with a reason does not reach the template (click) handler and does not submit a form` (a button inside
  a `<form>` with a submit handler). Fails today (no such input).
- `clearing the reason removes aria-disabled and the click guard`.
- `clicking a reason host does not close its tooltip`.
- `appTooltipShowWhenExpanded keeps the tooltip while aria-expanded is true`; without it, still suppressed (the existing
  behaviour, the `:180-190` case).
- `a host with only a disabled reason and no appTooltip still attaches the directive`.

**Risks:**
- **Hover styles.** Many component styles use `:hover:not(:disabled)` or their own `.disabled` class. An `aria-disabled`
  control still looks hoverable until its owner excludes `[aria-disabled='true']`. Each adoption checks the component's own
  hover rules. This is the main reason adoption is one surface per change.
- **Wrapped inputs.** A checkbox inside a `<label>` (the Loop switch) must carry the directive on the **input**, not the label:
  the input receives keyboard focus, and the directive listens to `focus` on its own host only. The label must not also be a
  tooltip host, because a host inside a host breaks rule H3. Part 2's 1g therefore gives the label no hint of its own and puts
  its sentence on the word "Loop" and on the switch as siblings, so hover covers the word and the switch but not the label's
  padding.
- **Announcement is best effort.** `aria-describedby` is added when the tooltip opens (on focus: immediately), not at rest,
  so some screen readers may not read the reason on focus. House rule 4 is still met, because the host stays focusable and
  the tooltip opens on focus; extra visible text is needed only for consequences, not for reasons.
- Cost: no per-host listener (the click guard exists only while a reason is active).

**Done when:** the new cases pass and the "fails today" ones were seen failing. On the Windows PC (first adopters, in part 2:
the voice button, 1d, and the Loop switch, 1g): a greyed button is reached with Tab, the reason appears, Enter and Space do
nothing, and the form it sits in does not submit. That check is recorded in part 2, not here.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “5d. Buttons that stay greyed out say why, and Tab reaches them (S)”.

### 5e. One phrase names and explains an icon button (S)

**For James:** an icon button gets both its hover hint and its screen-reader name from one phrase, so the two can never
disagree.

**Verified (10 Oct):**
- **`resolveIconButtonAria` is unwired.** `tooltip-policy.ts:124-127` defines it, and `command grep -rn resolveIconButtonAria
  src/renderer/app` finds only `tooltip-policy.spec.ts` outside the policy file. No production caller.
- **`hostDirectives` has never been used in this renderer** (0 files, re-run; the same command shape finds other matches
  elsewhere). So `[appIconButton]` is the first use and needs a short spike.

**Change:**
1. **New `shared/tooltip/icon-button.directive.ts` (about 70 lines): `AppIconButtonDirective`**, selector `[appIconButton]`.
   - `readonly label = input.required<string>({ alias: 'appIconButton' })`.
   - `hostDirectives: [{ directive: AioTooltipDirective, inputs: ['appTooltipShortcut', 'appTooltipPosition',
     'appTooltipVariant', 'appTooltipShowWhenExpanded', 'appTooltipDisabledReason: appIconButtonDisabledReason'] }]`. The
     reason input is exposed under a different name because `[appTooltipDisabledReason]` is in the tooltip directive's
     selector, and Angular raises NG0309 when a host directive is also matched by selector on the same element (inferred; the
     spike checks it).
   - The constructor calls `inject(AioTooltipDirective, { self: true }).registerTextSource(computed(() =>
     resolveIconButtonAria(this.label()).tooltip))`, which finally gives `resolveIconButtonAria` a production caller.
   - `host: { '[attr.aria-label]': 'ariaLabel()' }` with `ariaLabel = computed(() => resolveIconButtonAria(this.label()).ariaLabel)`.
   - Usage: `<button type="button" [appIconButton]="'Close panel'" (click)="close()">×</button>`. With a shortcut:
     `[appIconButton]="'Session history'" appTooltipShortcut="toggle-history"`. For `<a routerLink>` hosts it works the same.
2. **Spike first (30 minutes, inside the first change):** a TestBed spec that mounts a button with `[appIconButton]` plus
   `appTooltipShortcut`, checks the aria-label, opens the tooltip and checks `role="tooltip"`. **Fallback if Angular rejects
   the host-directive input mapping or the NG0309 case:** drop `hostDirectives`; add `[appIconButton]` to the tooltip
   directive's selector with its own `appIconButton` input; set `aria-label` with `Renderer2.setAttribute` inside an
   `effect`, only when the label is non-empty (not a host binding: a `null` host binding would delete the static
   `aria-label` that other hosts carry); and use that label as the text source. The public API is the same either way.
   Record which route was used in the as-built notes.
3. **Classify it for the guard:** add `appIconButton` to `HOVER_BINDINGS`, `TOOLTIP_PROVIDERS` and `NAME_PROVIDERS` in step
   4's constants (a spec fails until every directive under `shared/tooltip/` is classified), and extend step 2's inert-host
   check so a component using `[appIconButton]` must import `AppIconButtonDirective`.
4. **Docs:** guide section 5 now names `[appIconButton]`, `appTooltipShortcut` and `appTooltipDisabledReason` (they exist).
5. **No adoption in this change except specs.** The first real adoption is 7c (the "?" buttons use `[appIconButton]`). Part 2
   adds the shortcut chip (1b, the rail) and the reason (1d the voice button, 1g the Loop switch).

**Tests:** `icon-button.directive.spec.ts` (new): the label becomes `aria-label`; the tooltip text equals the label; no
`aria-describedby` (5b); the shortcut passes through; `appIconButtonDisabledReason` works; two nested icon buttons are
handled by the existing nested-host logic. Step 4's directive-classification case and step 2's inert check cover the guard.

**Risks:** `hostDirectives` is new here. If the spike fails, use the fallback. Either way the public API (`[appIconButton]`,
`appTooltipShortcut`) is identical, so call sites do not change.

**Done when:**
- All new spec cases pass, and the ones marked "fails today" were seen failing first.
- `command grep -rn resolveIconButtonAria src/renderer/app` finds a production caller (`icon-button.directive.ts`).
- `npm run check:ts-max-loc`, `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint` and `npm run build:renderer` pass (the
  last because template type errors only show there).

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “5e. One phrase names and explains an icon button (S)”.

---

## Step 6. D6: A glossary for the jargon, with "Learn more" (M)

Three parts: the glossary data and the underlined word (6a), one shared Help panel (6b), and the first three screens plus
the dead-key clean-up (6c). Needs Phase 3's word list as code (C7).

### 6a. The glossary data and the underlined word (S-M)

**For James:** words such as "worktree", "steer" or "fast mode" get a dotted underline. Hover over one, or tab onto it, and a
short plain-English explanation appears. Selecting it opens the Words panel (6b).

**Verified (10 Oct):**
- **There is no glossary today.** The only mention in the repo is a backlog comment (`docs/fable_todo_2_completed.md:881`).
  Jargon in visible text, per the audit: debate 20, aux 15, MCP 13, worktree 12, RTK 10, compaction 6, YOLO 6, council 5,
  parked 5, RLM 5; almost none explained.
- **A hover tooltip cannot hold a "Learn more" link, so the click must live on the term itself.** The tooltip panel is
  `pointer-events: none` (`shared/tooltip/aio-tooltip-panel.component.ts:35`, "Never take the pointer"), the directive closes
  on click (`aio-tooltip.directive.ts:180-183`), and the overlay has no backdrop and is never hoverable (`:294-296`). This is
  deliberate (a hoverable tooltip stays open over its own control). So the term must be a focusable button whose tooltip
  shows the definition and whose click opens Help.
- **`TooltipCopyEntry` has no `learnMore`** (`tooltip-copy.ts:59-69`: `label`, `meaning`, `consequence?`), although the
  2026-09-03 plan intended one. Do **not** add it there: a hover tooltip has no way to act on it, so it would be dead data
  like `resolveIconButtonAria` and `dependsOn`. It lives on the glossary entry.
- **Definitions already exist in product copy; reuse them:** MCP `shared/help/content/integrations.help.ts:15`, worktrees
  `code.help.ts:15`, council `agents.help.ts:201`, Learning Database `knowledge.help.ts:51`, RTK
  `features/settings/help/settings-help-system.ts:351`, "Auto-approve (YOLO) is risky" `settings-help-core.ts:27`, the header
  strings for YOLO and FAST (`instance-header.component.html:222-241`, `:245-258`), the loop chips (`tooltip-copy.ts:141-179`).
- **Two names for one thing today.** The learning store is "Learning Database" in the menu and Help, "RLM · Context Manager" on
  its page and "/rlm" in commands. The YOLO badge is "YOLO ON/OFF" while Settings help says "Auto-approve (YOLO)"; C8
  relabels it.
- **The word list is Phase 3's code.** C7 ships `src/shared/copy/ui-vocabulary.ts` with `PRODUCT_NAME = 'Harness'` and
  `UI_TERMS: readonly UiTerm[]`, each `{ id, use, never: RegExp[], meaning, enforcement: 'zero' | 'ratchet' | 'planned',
  owner? }` (Phase 3 plan; the file does not exist yet). "It has no runtime consumer except the guard. Its `meaning` strings
  seed the glossary later." This glossary is its first runtime consumer.
- **The glossary links to the word list loosely, not strictly.** C7's table has 21 rows. Of the 30 seed entries below only 6
  have a row (auto-approve, helper-models, shortening, asleep, second-opinion, helper-agent). 24 have none. So a rule that
  every entry names a row cannot hold. C7's rules A and B scan renderer and shared copy for "AIO", "Orchestrator",
  "instance" and "thread" and fail on a hit in a new file, and `glossary.ts` is a new scanned file. No alias or definition may
  use those words (an alias for helper agent is "subagent", not "child instance"). YOLO, RTK, RLM and codemem are fine as
  aliases and in a muted "Also called" line. When Phase 3's YOLO ratchet is switched on (its word-list row for Auto-approve says
  "ratchet after step 3"), add `glossary.ts` and the Words panel's alias line (`glossary.help.ts`) to its `ALLOWED_HITS` list with a
  reason, since they are the one place old names stay on screen.
- **`docs/` is mostly not packaged.** `electron-builder.json:30-34` ships only `BROWSER_AUTOMATION_SETUP.md` and
  `runbooks/**/*` from `docs/`. So "Learn more" cannot open A12's `docs/llm/harness-help/` markdown in a packaged app; it
  opens in-app Help (TypeScript content). Those pages are instructions for agents, not explanations for James, and nobody
  builds them (see [Corrections](#corrections-to-the-backlog)).
- **`<app-term>` cannot sit inside another button.** The YOLO and FAST badges are buttons (`instance-header.component.html:222`,
  `:245`). For those, the control's own tooltip uses the glossary text through a helper (`termTooltip(id)`), and C8 removes
  the jargon from the label anyway.

**Change:**
1. **Do not write a second word table.** `GlossaryEntry = { label: string; term?: string; plain: string; aliases?: readonly
   string[]; learnMore?: HelpTarget }`. When `term` is set it names a row in `UI_TERMS`. This part does not edit C7's file;
   when C7 later adds a row for one of the 24, that entry gains `term`.
2. **New `shared/glossary/glossary.ts`** (about 230 lines, new file, room 470): `export const GLOSSARY = {...} as const
   satisfies Record<string, GlossaryEntry>` and `type GlossaryTermId = keyof typeof GLOSSARY` (a typo in a template is a build
   error under `strictTemplates`). Helpers: `glossaryLabel(id)`, `glossaryPlain(id)`, `termTooltip(id)` (the definition, for
   controls that cannot nest a button) and `GLOSSARY_PATTERNS` (term and alias regexes) for step 4's glossary rule. The
   header comment carries the house rules, in the style of `tooltip-copy.ts`: define what it means for James, in everyday words,
   under about 25 words; expand any acronym; one name per concept; never state a number the code can change; a consequence
   James needs in order to decide goes in visible text next to the control, never only here.
3. **Seed entries (30; the backlog said about 25).** Names are proposals (C7's table wins where a row exists, marked "word
   list"); definitions are drafts for James's review. "Check" means read the source before shipping.

   | id | On-screen name (old names kept as search words) | Draft plain definition | Check before shipping |
   |---|---|---|---|
   | auto-approve | Auto-approve (YOLO) | The agent runs every tool without asking you first. Risky outside a safe folder. | word list; `instance-header.component.html:222-241`; `settings-help-core.ts:27`; C8 relabels the badge |
   | fast-mode | Fast mode (FAST) | Quicker replies on a priority service tier, at some cost in ability. Only some models offer it. | header `:245-258`; `supportsFastMode()` providers |
   | rtk | Output compression (RTK) | A helper that shortens long command output before the agent reads it, so fewer tokens are used. | `settings-help-system.ts:351`; do not quote savings |
   | learning-database | Learning database (RLM) | A store of context and patterns that agents can look up in later sessions. | `knowledge.help.ts:51` |
   | code-index | Code index (codemem) | Harness's index of your code, so agents can find where things are defined and used without reading whole files. | `docs/CODEBASE_INDEXING.md` |
   | tool-servers | Tool servers (MCP) | Add-on programs that give an agent extra abilities, such as searching the web or reading a database. | `integrations.help.ts:15` |
   | code-intelligence | Code intelligence (LSP) | A language's own helper that knows where things are defined and where the errors are. | `code.help.ts:58` |
   | acp | ACP | A standard way for Harness to talk to some agent tools. It stands for Agent Client Protocol. | one UI mention; C7 may remove it |
   | worktree | Worktree (separate working copy) | A separate copy of your project folder, so an agent's changes do not touch the folder you are working in. | `code.help.ts:15` |
   | helper-models | Helper models (aux) | Smaller or local models Harness uses for small jobs, such as naming sessions and shortening conversations. | word list; Settings → Auxiliary Models slot list |
   | shortening | Shorten conversation (compaction) | Replaces the older part of a long conversation with a summary so it fits in the model's memory. | word list; `message-format.service.ts:161`; reword after Phase 0 step 10 |
   | fresh-start | Fresh start (recycle) | In a loop, starts a new conversation with a short summary when the old one gets full. | `loop-config-panel.component.html:356-361`; Phase 0 step 2.6c |
   | same-session | Same session | The loop keeps one conversation going from round to round. | `loop.help.ts` |
   | new-session-each-round | New session each round | Every loop round starts a new conversation and reloads its progress from files. | `loop.help.ts` |
   | finish-by-checks | Finish by checks (gated) | The loop finishes when your check command passes and the agent says it is done. | `loop.help.ts`; re-read after Phase 2 |
   | finish-by-reviews | Finish by reviews (review-driven) | The loop finishes after clean self-reviews in a row, optionally with an independent review. | `loop.help.ts`; re-read after Phase 2 |
   | back-and-forth-review | Back-and-forth review (ping-pong) | A second model checks each "done" claim, and the loop ends only when both agree. It is not the repeated-tool-call warning. | `tooltip-copy.ts:176-179` |
   | independent-review | Independent review (fresh-eyes) | A reviewer that did not do the work checks it before the loop may finish. | `shared/types/loop.types.ts:288-300` |
   | final-round | Final tidy-up round (wrap-up) | When a loop reaches its round or time limit it gets one last turn to write its hand-off notes. | `tooltip-copy.ts:146-149` |
   | retry-new-approach | Retry with a new approach (unstick) | The loop saw no progress and asked the agent to change approach. It only tries a limited number of times. | `tooltip-copy.ts:141-145` |
   | set-aside | Set aside (parked) | Items the loop could not finish and put aside with a reason. The work is kept. | `tooltip-copy.ts:150-154` |
   | steer | Send now (steer) | A message sent while the agent is working. It goes ahead of other queued messages to change what the agent does next. | `composer-queue.component.html:26, 58`; what "now" means in `canSteerActiveTurn` |
   | side-chat | Side chat | A short separate conversation next to the main session, so you can ask something without interrupting it. | rail button; feature copy |
   | asleep | Asleep (hibernated) | Harness paused this session to save memory. Send a message to wake it. | word list |
   | context-window | Context window (occupancy) | How much the model can hold in mind at once. When it fills up, older parts are shortened. | `context-bar.component.ts:33-51` |
   | ask-several-models | Ask several models (council) | Sends one question to several AI models at once and shows the answers side by side. | `agents.help.ts:201` |
   | second-opinion | Second opinion | Another model checks a finished turn that changed files and says if it has concerns. | word list; Phase 0 step 9 |
   | helper-agent | Helper agent | A session that another session started to do part of the work. | word list |
   | tokens | Tokens | The small pieces of text a model reads and writes. Usage limits and costs are counted in them. | new |
   | cache-read-write | Cache read and write | Text the model saw recently is read back at a lower price. Adding new text to the cache is charged separately. | Phase 0 step 7h shows these on the Costs page; match that screen |

4. **New `shared/glossary/glossary-term.component.ts`** (about 70 lines): `<app-term term="worktree">Worktrees</app-term>`.
   - It renders `<button type="button" class="app-term" [appTooltip]="tooltip()" aria-haspopup="dialog"
     (click)="learnMore($event)">` with the projected text, or the glossary label when empty (Angular's default `ng-content`
     content). Styling: `text-decoration: underline dotted`, `cursor: help`, inherits the font, a visible `:focus-visible`
     outline. State is never colour only.
   - The tooltip text is `plain` plus the short line "Select for more." (hover tooltips cannot be clicked, so the hint tells
     the user the term itself can be).
   - `learnMore` calls `HelpDrawerService.open(...)` (6b) and `stopPropagation()`, so a term inside a clickable card does not
     trigger the card.
   - Not for use inside another control. In those cases use `[appTooltip]="termTooltip('fast-mode')"` on the control.
5. **Step 4 hand-off.** Add the glossary rule (H8) to `rules.ts` as a **report-only** rule using `GLOSSARY_PATTERNS` (a term
   inside an interactive control counts as satisfied when that control's tooltip uses `termTooltip(...)`), and move H8 from
   `DORMANT` to `REPORT_ONLY` in `types.ts`. Add the glossary line to guide section 1 (step 3a lists it).

**Tests:**
- `shared/glossary/glossary.spec.ts` (new, renderer project):
  - when `term` is set it names a row in `UI_TERMS`;
  - no `label` or `plain` matches any row's `never` regex (aliases are exempt on purpose: they are the old names people
    search for);
  - no label or alias is used by two entries;
  - `plain` is non-empty and at most 30 words, and every acronym in it is expanded in the same sentence;
  - every `learnMore.surface` exists in `CONTROL_SURFACES` and has a `CONTROL_SURFACE_HELP` entry;
  - no `never` regex carries a `g` or `y` flag (a global regex makes `.test()` remember its position, so specs would become
    order-dependent). This is the one thing to ask of C7.
- `shared/glossary/glossary-term.component.spec.ts` (new): renders a `button` with the label; keyboard-visible focus opens the
  tooltip and stamps `aria-describedby`; the tooltip text starts with `plain` and ends with "Select for more."; click calls
  `HelpDrawerService.open` with `{ topic: 'glossary', anchor }` and a parent click handler is not called; empty projection falls
  back to the label; a bad id is a compile error (`// @ts-expect-error`).
- `scripts/__tests__/ui-hints-rules.spec.ts`: H8 flags an unmarked first use and accepts `<app-term>` or `termTooltip`.

**Risks:**
- A `<button>` nested in another interactive element is invalid HTML and breaks keyboard order. The H8 matcher and the
  `termTooltip` route exist to avoid it.
- Glossary text goes stale when behaviour changes (loop finish rules change in Phase 2). Every loop entry carries a "re-read
  after Phase 2" note, and there are no numbers in the text.
- `hint-policy.ts` deliberately rejects rotating tips (`hint-policy.ts:4-8`). The glossary is pull, not push (nothing
  appears until James hovers), so it does not break that rule.
- The word list is a hard dependency on C7 shipping as code. Without it the glossary would have to carry its own names,
  which is the duplication this item is meant to avoid.

**Done when:** `GLOSSARY` has the 30 seed entries, and its spec passes. Hovering or tabbing onto a term shows its definition
(checked on 6c's screens).

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “6a. The glossary data and the underlined word (S-M)”.

### 6b. One shared Help panel, mounted once (S-M)

**For James:** selecting an underlined word opens a side panel listing every word Harness uses, scrolled to that word.
Escape closes it and puts you back where you were. The same panel later serves the "?" buttons (step 7).

**Verified (10 Oct):**
- **Help already has the machinery "Learn more" needs, in two places only.** `HelpEntry` and `HelpSection`
  (`shared/help/help-content.types.ts`, 66 lines); `HelpPaneComponent` (`help-pane.component.ts`, 57 lines; the
  `@switch (section.kind)` at `help-pane.component.html:35`); mounted only in Settings (`settings.component.html:354` rail,
  `:378` drawer) and the Control Center shell (`shared/control-surface/control-surface-shell.component.html:66`). Settings'
  drawer is private to that component (`settings.component.ts:148-176, 584-625`).
- **A second drawer can open on top of the first.** `createFocusTrap` (`shared/utils/focus-trap.ts`) keeps a stack of traps
  (`activeTraps`, `:27`; the newest connected trap wins, `:117-126`). `--z-modal` is 400 (`styles/_theme.scss:338`) and
  Settings' drawer uses `+ 1` (`settings.component.shell.scss:72`).
- **Where a mounted app-wide singleton goes.** `app.component.html:102` is `<app-terminate-confirm-dialog />` (comment:
  "mounted app-wide, not in the collapsible sidebar") and `app.component.ts` imports it. The new drawer is mounted the same
  way. `app.component.ts` is 455 lines (room 245).

**Change:**
1. `app/shared/help/help-target.ts`: `HelpTarget = { topic: HelpTopicId; anchor?: GlossaryTermId } | { surface: ControlSurfaceId
   }` and `resolveHelpTarget(target): { title: string; entry: HelpEntry; anchor?: string }` (surfaces from
   `CONTROL_SURFACE_HELP`; use `import type` between `glossary.ts` and `help-target.ts` so there is no import cycle). Settings
   tabs are left out on purpose (`SETTINGS_TAB_HELP` and `SettingsTab` live under `features/settings`, and `shared/` must not
   import from `features/`); a term whose best explanation is a Settings tab points at the matching Control Center page
   instead (for example helper models point at the Models page).
2. `app/shared/help/help-topics.ts`: `HELP_TOPICS: Record<HelpTopicId, { title; entry }>`. This part registers `glossary` only;
   step 7 adds `loop` and `session`.
3. `app/shared/help/help-drawer.service.ts`: a private signal for the open target, a readonly `target`, `open(target)` and
   `close()`.
4. `app/shared/help/help-drawer.component.ts` (`app-help-drawer`): a scrim `<button type="button" aria-hidden="true"
   tabindex="-1">` (the reader exempts that pair with no marker, so the records need no new one, and it is not a Tab stop;
   Escape and the focus trap serve keyboard users), `<aside role="dialog" aria-modal="true" aria-label="Help &amp; tips">`
   hosting `<app-help-pane [collapsed]="false">`, focus trap via `createFocusTrap`, Escape closes it, and anchor scroll and
   focus after render.
   `position: fixed; z-index: calc(var(--z-modal) + 2)` so it sits above Settings' drawer; width `min(380px, 100%)`.
   Settings' own Escape handler is bound on the Settings page element (`settings.component.html:5`, `settings.component.ts:584-600`),
   outside the app-level drawer's DOM, so one key press cannot close both; the spec pins this.
5. Mount `<app-help-drawer />` next to `app.component.html:102` and add it to `imports` in `app.component.ts` (+2 lines).
6. New section kind `terms` in `help-content.types.ts` (`{ kind: 'terms'; heading: string; terms: readonly GlossaryTermId[] }`) and
   a `@case ('terms')` in `help-pane.component.html` rendering a `<dl>` with `id="term-<id>"` anchors. New
   `app/shared/help/content/glossary.help.ts` builds the "Words used in Harness" entry from `GLOSSARY`: a lead callout ("Short
   explanations of words you may see in Harness. Select an underlined word on screen to jump to it here."), then one `terms`
   section per area (Controls, Loops, Memory and tools, Costs), then a short tip callout so the entry passes
   `expectUsefulEntry`. Old names show in a muted "Also called" line.
7. The new drawer's own controls start clean (name plus tooltip), since a new file has a record of zero.

**Tests:**
- `shared/help/help-drawer.component.spec.ts` (new): opens from the service; `role="dialog"` and `aria-modal`; focus lands inside
  and returns to the opener on close; Escape closes only the new drawer when Settings' drawer is also open (a second Escape
  closes Settings' drawer); a scrim click closes; the anchor id is scrolled into view and focused (jsdom `scrollIntoView`
  stubbed).
- `shared/help/help-content.spec.ts` (extend): loop over `HELP_TOPICS` through `expectUsefulEntry` (lead callout over 40
  characters, at least one guidance section).

**Risks:** two drawers can be open at once (Settings' own, then a term inside Settings opens the shared one). Handled by the
z-index step; the two Escape handlers live in different DOM branches, so one key press closes one drawer. Settings' drawer is
left alone; converging them is out of scope.

**Done when:** Enter or click on a term opens the Words panel scrolled to that term; Escape closes it and focus returns to the
term; the specs pass; `npm run build:renderer` passes.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “6b. One shared Help panel, mounted once (S-M)”.

### 6c. The first three screens, and two dead tooltip texts removed (XS-S)

**For James:** three places show their first underlined word: the "steer" tag in the message queue, the Worktrees heading, and
the Output compression (RTK) settings heading. Two hover texts that nothing used are deleted.

**Verified (10 Oct):**
- `composer-queue.component.html:26` is a non-interactive `<span class="queued-kind queued-kind-steer" title="Will send before
  passive queued messages">steer</span>`; `composer-queue.component.ts` is 38 lines and already imports the tooltip directive.
- `features/worktree/worktree-panel.component.ts:56` is `<span class="worktree-title">Worktrees</span>` (713 lines, ceiling 714,
  room 51). The RTK tab header is `features/settings/rtk-savings-tab.component.ts:34-36` (209 lines),
  `<h3 class="section-title">Output compression savings</h3>`. Phase 1's A13 rewrites this tab and already expects its header to carry this
  term (visible name "Output compression", RTK as the also-called name, +2 lines); whichever lands second carries the other.
- **Dead registry keys: three today, two after Phase 0.** `loop.recycleToggle` (`tooltip-copy.ts:182`), `loop.isolation` (`:187`)
  and `loop.verifyTwice` (`:191`) appear nowhere else (`git grep -F`). Phase 0 step 2.6c wires `loop.recycleToggle` to the
  recycle checkbox, so this part deletes only `loop.isolation` and `loop.verifyTwice`.
- The registry cannot be "expanded beyond the loop" up front: step 4's key-use rule would fail on any key added before its
  screen is migrated. New keys arrive with the screen that uses them (the migration in parts 2 and 3).
- The house rules in the `tooltip-copy.ts` header are numbered 1, 2, 4, 3 (cosmetic).

**Change:**
1. `composer-queue.component.html:26`: replace the span's native title with `<app-term term="steer">steer</app-term>` and import
   the component (+2 lines in the `.ts`). The old title ("Will send before passive queued messages") now counts as a ledger entry
   (it holds "send", one of the words step 4 added), so this change retires that entry with `--retire <id> --reason "..."`, the
   reason naming the glossary entry that says the same thing in plain words.
2. `worktree-panel.component.ts:56`: `<app-term term="worktree">Worktrees</app-term>` (+2 lines).
3. `rtk-savings-tab.component.ts` header: `<app-term term="rtk">Output compression</app-term> savings`.
4. `tooltip-copy.ts`: delete `loop.isolation` and `loop.verifyTwice` (and `loop.recycleToggle` only if Phase 0 step 2.6c has not
   wired it by then). Add a header rule: key names are `<area>.<control>`, and a key is added in the same change as the template
   that uses it. Do **not** add `learnMore` to `TooltipCopyEntry`. Optional tidy: number the house rules 1, 2, 3, 4.
5. `npm run check:ui-hints -- --tighten` (H6 from 2 to 0), and the `--retire` above.

**Tests:**
- A wiring spec mounting `ComposerQueueComponent` with a steer message asserts an `app-term` is rendered and that its
  keyboard-visible focus shows the definition (existence is not behaviour).
- The real-tree rule: no `TOOLTIP_COPY` key is unreferenced. **Fails on today's code** (3 keys; 2 after Phase 0).

**Risks:** the "steer" hover text changes from the old sentence to the glossary sentence. Same meaning, and it is now one
click from a longer explanation.

**Done when:**
- The three first sites show a dotted-underline term in the rebuilt app.
- `loop.isolation` and `loop.verifyTwice` are gone and nothing references a missing key; `npm run build:renderer` passes.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “6c. The first three screens, and two dead tooltip texts removed (XS-S)”.

## Step 7. D7: Help where the work is (S-M)

Four parts. The backlog's documentation line for this item (the two standards pages) was done in 3b. Needs step 6 (the panel
and the topic list), and step 5e for 7c (`[appIconButton]`).

### 7a. Make room in the loop setup panel (XS)

**For James:** nothing changes on screen. A block of default numbers moves out of a file that is exactly at its size limit, so
the next changes can fit.

**Verified (10 Oct):** `features/loop/loop-config-panel.component.ts` is exactly 700 lines (room 0). Lines 27-96 hold the
default constants (`DEFAULT_CAPS` through `type PlanPacketMode`). The `imports` array is one line (`:110`) and already includes
`AioTooltipDirective`; `copyFor` is already imported. **Phase 2 plans the same move first:** its part 9e moves the `DEFAULT_*`
constants (`:27-96`) into a new `loop-config-panel.defaults.ts` ("frees about 65 lines"; Phase 2 plan, headroom table and part 9e).
A file named `src/shared/types/loop-config-defaults.ts` already exists (the engine's defaults), so a renderer module with that
name would be confusing.

**Change:** do this only if Phase 2's part 9e has not landed; if it has, skip this part, because the room already exists. Otherwise
move `loop-config-panel.component.ts:27-96` into a new `features/loop/loop-config-panel.defaults.ts` (about 75 lines; the same
name Phase 2 uses, so whichever lands second finds the move done) and import the 13 names. That frees roughly 50 lines after the
new import. A pure refactor. Do it before 7c and part 2's 1g, which both add a line to this file.

**Tests:** the existing `loop-config-panel.component.spec.ts` passes unchanged; `npm run check:ts-max-loc` shows the file with room.

**Risks:** a hot file. Phase 0 step 2.6c edits this component's template and hint in the same period.

**Done when:** `loop-config-panel.component.ts` is under 700 lines with room, and the existing spec passes (or Phase 2's part 9e
did the move and this part was skipped).

**Live checks:** none.

### 7b. File names in the conversation can be reached with the Tab key (S)

**For James:** a file name in a conversation (a path in backticks) can now be reached with Tab, shows its hint when you land on it,
and opens with Enter or Space, the same as a click.

**Verified (10 Oct):**
- Inline paths are `<code class="inline-code file-path" data-file-path=… title="Click to open file">`
  (`core/services/markdown.service.ts:128-135`, `:267-277`). The only activation is one delegated `click` listener on the viewport
  (`features/instance-detail/output-stream.component.ts:841-889`; added at `:879`, removed at `:648`). There is no `keydown`
  handling, and `<code>` is not focusable.
- DOMPurify's explicit `ALLOWED_ATTR` (`markdown.service.ts:337-356`) allows `title` and has `ALLOW_DATA_ATTR: true`, but not `role`
  or `tabindex` (an explicit list replaces DOMPurify's defaults, which do include both). It is a deliberate hardening that drops
  `role`, `tabindex`, `id` and `style`. The file already registers an `afterSanitizeAttributes` hook (`:89-94`, which today only
  returns early for copy buttons); that hook is where this part adds the two attributes, after sanitising.
- Markdown links to files are real `<a href>` elements, so Enter should already work for those (inferred from the markup; confirm
  in the live check). Follow-up buttons are real `<button>`s with an `aria-label` (`core/services/codex-followup-markdown.ts:69`),
  so they are already keyboard-operable.
- `markdown.service.ts` has two dead helpers: `setupCopyHandlers` (`:510`) and `setupFilePathHandlers` (`:572`) have no caller
  anywhere in `src` (re-run on 10 Oct). The live path is the delegated listener. Do not build on them.
- Step 1's bridge covers the hover and focus hint for these elements; it reads `title` only (so does this part). The transcript's
  HTML builders already set `title`, so no HTML change is needed for the hint.

**Change:**
1. `core/services/markdown.service.ts`: leave `ALLOWED_ATTR` alone. In the existing `afterSanitizeAttributes` hook (`:89-94`), for a
   node that is `code.file-path` with `data-file-path`, set `tabindex="0"` and `role="link"` after sanitising (about +6 lines; the
   file has room 114). Adding `tabindex` to the allowlist would let model-written HTML carry `tabindex="1"` or higher, and a
   positive tabindex reorders the Tab sequence for the whole window.
2. `features/instance-detail/output-stream.component.ts`: register the same listener for `keydown` (handle Enter and Space on
   `[data-file-path]` elements that are not `<a>`, call `preventDefault`, then the existing `onFilePathClick`) and remove it at `:648`.
   About +10 lines; the file is 1,240 lines (ceiling 1,228, room 38). Fallback: put the handler in a new module and add about 3
   lines here.
3. `<code tabindex="0" role="link">` is chosen over turning paths into buttons because inline code must stay selectable and
   copyable.
4. Do not write a second bridge. If step 1 has not landed, the hint half of this part waits.

**Tests:**
- `core/services/markdown.service.spec.ts` (extend): a backticked path renders `code.file-path` with `tabindex="0"` and `role="link"`
  after sanitising; the allowlist is unchanged, so model-written HTML carrying `tabindex="3"`, `role`, `onclick`, `style` or `id`
  is still stripped (a `tabindex="3"` on a `code.file-path` ends as `0`, set by the hook). The first assertion **fails today**.
- `features/instance-detail/output-stream-followup.spec.ts` or a new `output-stream-file-path.spec.ts`: Enter and Space on a focused
  `code.file-path` call `fileIpc.openPath` once; other keys do nothing; click still works; the listener is removed on destroy.
  **Fails today.**

**Risks:**
- Transcript messages are injected with `[innerHTML]` (`output-stream.component.html:90`) inside a virtualised list
  (`TranscriptVirtualizerController`, `output-stream.component.ts:83`, `:379`). A focused path inside a message whose rendered string
  changes (a streaming reply) should lose focus when the HTML is replaced, and paths outside the render window are not in the Tab
  order. Both are inferred from the binding and the virtualiser, not run. Acceptable for finished messages; check live.
- Every inline path becomes a Tab stop, so a long transcript adds many stops before the message box. There is no ready-made way to
  jump past them: the "Focus Input" action (`keybinding.types.ts:57`, `:165-171`, default key `i`) is defined, but nothing
  registers a handler for it (the id appears nowhere else in non-spec `src`). If crossing is too slow, limit `tabindex="0"` to
  paths in the last few messages, use a roving tabindex, or wire that action (a small follow-up). Default: all paths.
- The sanitiser allowlist is not widened, so model-written HTML cannot carry `tabindex` or `role` (a positive `tabindex` would
  reorder the Tab sequence of the whole window). Model-written HTML that imitates a path (`code.file-path` with `data-file-path`)
  also gets `tabindex="0"`, which is harmless (natural order); the spec pins that nothing else changed.
- **Shared room in `output-stream.component.ts`.** Phase 5's C13.2 and C13.11 also extend this one delegated listener (about 8 lines
  each); with this part's 10 the three need about 26 of the file's 38 lines. Extend the listener once. If the total would pass the
  room, use the fallback (a new module, about 3 lines here).

**Done when:** Tab reaches an inline file path in a transcript, Enter opens the file, and its hint shows on focus.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “7b. File names in the conversation can be reached with the Tab key (S)”.

### 7c. A "?" on the loop panel and the session header (S-M)

**For James:** a small "?" on the loop panel and on the session header opens help right there, in the same side panel the Words list
uses, instead of sending you digging through Settings.

**Verified (10 Oct):**
- **Loop help is reachable only through Settings.** `ORCHESTRATION_TAB_HELP` spreads `...LOOP_MODE_HELP.sections`
  (`features/settings/help/settings-help-core.ts:123-131`). Neither loop template links to help.
- **There is no help for the session screen at all.** `CONTROL_SURFACE_HELP` is one entry per Control Center page
  (`shared/help/control-surface-help.ts:78-131`).
- **The existing `/help` command is a command list, not topic help** (`src/shared/types/command.types.ts:143-154`, run by
  `app.open-command-help`, `features/dashboard/dashboard.component.ts:497-503`).
- **Where the triggers go.** The session header: the end of `.header-actions` (`instance-header.component.html:41`);
  `instance-header.component.ts` is 694 lines (room 6) with a one-line `imports` array, so only the `import` statement adds a line
  (+1). The loop panel: the end of `.ls-actions` (`loop-control.component.html:93`; `loop-control.component.ts` has room 423). The
  loop setup form: next to the close button in the header (`loop-config-panel.component.html:2-8`; room from 7a).
- **Phase 3's C2 makes the header one row** and moves the model, account and context ring beside the message box. Mode, Auto-approve,
  Fast and Computer Use go into a "Session options" menu; the header shows chips only for settings that are not normal; the Open,
  Files and Git buttons stay. `instance-header.component.ts` falls from 694 to about 430 lines there, so the one added import line is
  safe whether this lands before or after C2.

**Change:**
1. **New `app/shared/help/help-link.component.ts`** (`app-help-link`, about 45 lines): inputs `topic: HelpTopicId` and `label: string`.
   One quiet 20px icon button; the label is both its tooltip and its accessible name (use `[appIconButton]`, which now exists);
   `aria-haspopup="dialog"`; click calls `HelpDrawerService.open({ topic })`.
2. **Place three triggers** (each is a template line plus an `imports` entry):
   - `<app-help-link topic="session" label="Help: working in a session" />` at the end of `.header-actions`
     (`instance-header.component.html`). The trigger belongs at the end of whatever action cluster survives C2. If the one-line header
     has no room at narrow widths, it becomes the last item of the Session options menu.
   - `<app-help-link topic="loop" label="Help: Loop Mode" />` at the end of `.ls-actions` in `loop-control.component.html`.
   - The same, beside the close button in `loop-config-panel.component.html`.
3. **Two new topics in `help-topics.ts`:** `loop` (`LOOP_MODE_HELP`, rewritten in 7d) and `session` (a new
   `app/shared/help/content/session.help.ts`, `SESSION_HELP`, about 40 lines). Draft, to be checked against the header after C2 and
   C8 land (each line is traced to the code named; the two marked "check" are not yet confirmed; the wording follows C7 and C8):
   - Lead (info, "Working in a session"): "A session is one conversation with an AI agent. The top shows which session you are in and
     any settings that are not normal. The box at the bottom is where you write to it."
   - List "At the top": "Name: double-click to rename." / "Chips appear only for settings that are not normal, for example
     auto-approve." / "Open, Files and Git: open the folder, browse its files, and see the changes." / "Session options: the kind of
     work the agent is set up for (for example Plan or Review), auto-approve and fast mode." (check the mode names)
   - List "Next to the message box": "Model: which model answers. A change you make while it is working starts when the current reply
     finishes." / "The ring shows how full the model's memory is. When it fills up, older parts are shortened. Select it for details." /
     "Messages you send while the agent is working wait in a queue. Send now puts one at the front so it can change what the agent
     does next." (check what "now" does in `canSteerActiveTurn`) / "Loop Mode keeps the agent working on a goal until its checks pass
     or you stop it. The ? on the loop panel explains it."
   - Warning "Auto-approve is risky": "With auto-approve on, the agent can change files and run commands without asking. Use it in
     folders where you can afford to lose changes."
   - Tip "Find anything" (only after C10): "Open the command palette to jump to any page or setting."
   (Sources: model change `instance-header.component.html:193-198`, mode `:204-215`, auto-approve `:222-241`, fast `:245-258`, rename
   `:24`, queue and steer `composer-queue.component.html:25-26, 54-58`. These lines are as of 10 Oct and move with C2.)
4. `docs/visual-qa-checklist.md` Cross-cutting section: add "- [ ] **Help** — the ? buttons open the side panel, Escape closes it and
   focus returns to the button."
5. **Optional (small):** if C10's palette is in place, register "Help: Loop Mode", "Help: Working in a session" and "Help: Words used in
   Harness" as palette entries that call `HelpDrawerService.open`. Skip if the palette API is not ready; nothing depends on it.

**Tests:**
- `shared/help/help-link.component.spec.ts` (new): the accessible name equals the tooltip text; click calls
  `HelpDrawerService.open({ topic })`; `aria-haspopup="dialog"`.
- `instance-header.component.spec.ts`, `loop-control.component.spec.ts`, `loop-config-panel.component.spec.ts` (extend): each renders an
  `app-help-link` with the expected topic and label. All **fail today**.
- `help-content.spec.ts` (extend): the `loop` and `session` topics pass `expectUsefulEntry`, and none of their text contains a word from
  the word list's `never` side ("instance", "thread", "AIO", "Orchestrator").

**Risks:**
- **Header crowding.** The header is the thing C2 is trying to empty. The "?" is one small stateless icon (it passes the guide's
  admission test: stateless, always the same, and the screen's only help entry), but confirm it with C2's final layout. Alternative:
  palette only, plus the existing `/help`.
- **Two drawers** can be open at once; handled in 6b.
- **Stale help.** The text describes behaviour that Phases 0 to 3 change. Hence the ordering (after the loop end states, C2 and C8) and
  "no numbers in help text".

**Done when:** each of the three "?" buttons opens the shared panel on the right topic, with a visible focus ring, and closes with
Escape returning focus to the button; `SESSION_HELP` exists and passes the content-quality spec.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “7c. A "?" on the loop panel and the session header (S-M)”.

### 7d. The loop help in plain English (S)

**For James:** the help page for Loop Mode today talks about "occupancy recycle", "app-server" and "resident". It is rewritten in
everyday words, so the new "?" opens something you can read.

**Verified (10 Oct):**
- `shared/help/content/loop.help.ts` (45 lines) explains loops in internal terms, for example "Occupancy recycle fires on a
  provider-reported current-window sample (Claude resident, Codex app-server, Copilot server mode)". It also quotes numbers the code can
  change ("iterations (50) and wall time (50 hours)").
- `loop.help.spec.ts` (26 lines) pins three behaviours by regex: no claim that every cap takes a wrap-up round; "token or cost cap
  stops immediately"; "replay would be unsafe" and "not the loop being stuck".
- The approved D7 text did not mention this rewrite (it is the second half of the audit's TT-14); it is included because the "?" would
  otherwise open a page full of internal terms.

**Change:**
1. Rewrite `loop.help.ts` in plain English with the Phase 3 words and Phase 0's new end states. Keep its headings and keep the three
   pinned facts. State no number the code can change. Keep the true statement that a loop has no cost limit unless you set one (James's
   decision). Example wording for "When the loop stops":
   - "If a loop reaches its round or time limit it gets one final tidy-up round to write its hand-off notes. A token or cost limit stops
     it straight away."
   - "If a failed attempt had already changed files, or Harness cannot tell whether it did, the loop pauses for your review instead of
     trying again, because trying again could make things worse. That is not the loop being stuck."
2. Rewrite `loop.help.spec.ts` to assert those facts rather than the old phrases.
3. Land the finish-rule wording after Phase 0 step 1 (the new end states) and Phase 2 (B2 and B3 change the finish rules). Before that,
   limit the rewrite to removing jargon.

**Tests:** `loop.help.spec.ts` (rewritten, by fact not by phrase); `help-content.spec.ts` (7c) fails today for the loop topic because it
contains "Occupancy recycle", "app-server" and "resident".

**Risks:** help text describes behaviour that Phase 2 changes; hence the order and the no-numbers rule.

**Done when:** `loop.help.ts` contains no word from the word list's `never` side and its spec passes.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “7d. The loop help in plain English (S)”.

---

## Step 8. D9: A screen-and-wording check for reviewers of renderer changes (S)

Two parts, in this order: the safety net first (8a), then the prompt section (8b). The checklist half of this item (the five checks
as section 6 of the guide, and the pointer in `AGENTS.md`) arrived with step 3. Needs step 3, and Phase 0 step 9 (A14): both edit
`review-prompts.ts`.

### 8a. Screen notes can never block a loop (S)

**For James:** nothing changes on screen. Before the new reviewer check is added, this makes sure its notes are advice only: even a
reviewer that scores a screen note harshly cannot stop a loop from finishing.

**Verified (10 Oct):**
- **One fixed list of four review angles.** `REVIEW_ANGLES` = correctness, security, completeness, regressions
  (`src/main/orchestration/review-prompts.ts:27-52`), handed out round-robin by reviewer position (`:55-57`). "Reviewers still score every
  dimension; the angle only shifts emphasis" (`:14-19`).
- **Every remote angle is "required", and an incomplete required angle fails the gate closed.** `LoopReviewAngleCoverageEntry.required`
  (`shared/types/loop-review-state.types.ts:44-69`); `required: r.required ?? r.source !== 'local'` (`loop-fresh-eyes-reviewer.ts:313`);
  the gate treats a required angle that is not `used` or `cached` as "unavailable, not a clean pass"
  (`loop-coordinator-completion-gates.ts:527-546`). **So a "fifth angle" cannot simply be appended** (this changes the backlog and its
  T3-12 wording): with two or three reviewers it would never be reached, and as a separate dispatch it would be required, so a failure of a
  style check could block a loop from finishing.
- **Notes do not block by default, but three routes could.** Default blocking severities are `['critical', 'high']`
  (`shared/types/loop.types.ts:338`); a finding blocks the completion gate only if it passes `isBlockingFreshEyesFinding` and then
  `classifyFreshEyesBlocking` (`loop-coordinator-completion-gates.ts:468-479`; blocked findings are emitted at `:638`).
  `severityForScore` (`headless-review-findings.ts:64-68`) maps a score of 3 to `low` and 2 to `medium`, but a score of 1 to `high`
  (`security`: `critical`). Anything a tiered reviewer puts in `critical_issues` is always `high` (`:22-28`). A finding whose quote checks out
  is not demoted (`classifyFreshEyesBlocking`, `fresh-eyes-blocking.ts:29-60`, called at `loop-coordinator-completion-gates.ts:469-480`), so
  severity alone decides.
- **The gate already skips advisory findings.** `isBlockingFreshEyesFinding` is `finding.advisory !== true &&
  blockingSeverities.includes(finding.severity)` (`loop-fresh-eyes-reviewer.ts:147-152`), and `HeadlessReviewFinding.advisory?: boolean`
  exists (`src/main/cli-entrypoints/review-command-output.ts:38`). But `aggregateReviewFindings` recomputes `advisory` from reviewer
  provenance alone (`review-finding-aggregation.ts:189`: advisory only when no remote reviewer reported it), so a flag set earlier is
  dropped. The runner keeps the flag up to that point (`headless-review-runner.ts:247-250` spreads each finding).
- **Little traffic today.** Fresh-eyes review is normally opt-in (`loop-coordinator.ts:1000-1002`); it is on by default only for
  investigation goals with no verify command (`loop-start-config.ts:207-230`) and for "converge until clean" prompts
  (`loop-coordinator.ts:1008-1013`); the backlog says loops have not run since 22 September. No other production code calls the headless
  runner except the `aio review` command. The plan queue does not.

**Change:**
1. `src/main/orchestration/headless-review-findings.ts` (68 lines, room 632; about +12 lines): in `toHeadlessFindings`, treat an issue that
   starts with `UI:` (in the dimension issues at `:29-38` and in `criticalIssues` at `:22-28`) as a screen note: severity `low`,
   `advisory: true`, title `<reviewer> screen and wording note`, and a body without the `UI:` prefix.
2. `src/main/orchestration/review-finding-aggregation.ts` (226 lines, room 474; +1 or 2 lines): change `:189` to `const advisory =
   !reviewerProvenance.some(({ source }) => source === 'remote') || cluster.members.every((m) => m.advisory === true);`. Every existing
   finding has `advisory` undefined, so today's behaviour is unchanged, and a cluster that mixes a note with a real finding stays
   blocking.

**Tests:**
- `headless-review-findings.spec.ts` (exists, extend): a `UI:` issue at score 3, at score 1 and in `critical_issues` each give `{ severity:
  'low', advisory: true }` with the plain title, and `isBlockingFreshEyesFinding(f, ['critical','high','medium','low'])` is false.
  The score-1 and `critical_issues` cases **fail today**.
- `review-finding-aggregation.spec.ts` (exists, extend): an all-advisory cluster from a remote reviewer is advisory; a mixed cluster is
  not; the existing cases still pass.

**Risks:** an aggregated finding that mixes a note with a real finding stays blocking (intended).

**Done when:** a simulated reply with a `UI:` entry scored 1 produces an advisory finding that does not block, even if `blockingSeverities`
includes `low`.

**Live checks:** none.

### 8b. The screen-and-wording section in the reviewer prompts (S)

**For James:** when a reviewer looks at a change to the screen code, it also checks the new buttons and text against the house rules (no
unlabelled icon buttons, no jargon, no hidden consequences) and says what it found. In a loop, these notes are advice: they never stop a
loop from finishing.

**Verified (10 Oct):**
- **Only one path applies angles.** `headless-review-runner.ts:93-97` calls `angleForReviewer(reviewerIndex++)` and then the prompt builders.
  That runner serves the loop's fresh-eyes gate (`loop-fresh-eyes-reviewer.ts:264-276`, via `CrossModelReviewService.runHeadlessReview`,
  `cross-model-review-service.ts:727-760`) and the `aio review` command (`cli-entrypoints/review-command.ts:166-203`). The interactive
  review calls the same builders with no angle (`cross-model-review-service.ts:627-628`), and so does the local-model reviewer
  (`review/local-reviewer.ts:286-287`).
- **The reviewed material is a real diff**, so "touches `src/renderer/**`" is detectable. The loop sends `git diff` headers plus
  untracked-file blocks written as `+++ new file: <path>` (`loop-diff.ts:183-196`, content built in `loop-fresh-eyes-reviewer.ts:154-197`),
  and `aio review` redacts the request content as a diff (`headless-review-runner.ts:56-57`). Detection must run on the same truncated text
  the reviewer sees (`truncateForReview`, 32,000 characters, `review-prompts.ts:254-261`).
- **Both builders put the payload, then the angle, then the checklist** (`review-prompts.ts:150-156` and `:191-197`). The new section
  follows the payload, as the house style asks.
- **The builders end with a sentence that could cancel the new section.** The structured builder closes with "Only flag genuine
  issues, not stylistic preferences." (`review-prompts.ts:180`) and the tiered builder with "Do not nitpick style. Focus on things
  that would cause real failures." (`:228`); both come after the new section. So the section says in its own words that its five
  patterns are house rules, not style preferences. Its example path is a real file's path, because a made-up one such as
  `example/example.component` reads as a placeholder (house style rule 4).
- **Phase 0 step 9 edits the same neighbourhood.** It adds a `<changed_files>` block "between 'Output Under Review' and 'Review Checklist'",
  caps `taskDescription` at 4,000 characters, and adds a case to `review-prompts.spec.ts` (Phase 0 plan, step 9). It also puts `changedFiles`
  (at most 50) on the dispatch request. So this part lands after step 9, the "byte-identical for non-renderer content" snapshot is taken
  after step 9, and `uiConsistencySection(content, changedFiles?)` uses that list when given. That closes the "not confirmed" caveat for the
  interactive second-opinion path.
- **The completion gate has no repo-local hook.** The `task-completion-gate` skill is a personal global skill. The only repo-side lever on a
  fresh reviewing agent is what it reads in this repo: `AGENTS.md` and what that points to (step 3). Editing that skill is a change to
  James's own setup, not to this repo, so it is left alone.
- **`aio review` takes a git ref** (default `HEAD`): `review-command.ts:101` and `git diff --find-renames <target>` at `:211-212`. A
  working-tree change is reviewable with no branch.

**Change:**
1. **New `src/main/orchestration/review-ui-consistency.ts`** (about 90 lines): `UI_CONSISTENCY_CHECKS` (five `{ id, text, guideKeyword }`),
   `changedPathsFromReviewContent(content)` (lines starting `diff --git a/`, `+++ b/` or `+++ new file: `; unique, capped at 500),
   `touchesRendererScreens(paths)` (starts with `src/renderer/`, ends `.html`, `.ts`, `.scss` or `.css`, and is not `.spec.ts` or `.test.ts`),
   and `uiConsistencySection(content, changedFiles?): string` (empty when nothing matches). Its header comment says why this is not a fifth
   entry in `REVIEW_ANGLES` (the `required` rule above), so the next person does not "fix" it.
2. **The section text** (house style: it follows the payload inside a prompt that already states the role; positive wording; one complete
   example with no placeholders; the evidence format is the one the prompt already teaches):

   ```
   ## Screen and wording check (this change touches renderer files)
   In addition to the review that follows, look at the changed lines only for these five patterns:
   1. An icon-only control (a button that shows only a glyph or a picture) without a tooltip and an accessible name.
   2. A native title attribute on a control.
   3. New raw status text, internal codes or jargon in text a user can see.
   4. A new local status-to-label map instead of the shared status presenter.
   5. A destructive, money-spending or auto-approving action whose consequence is not shown in visible text beside it.
   These five patterns are house rules for this repository, not style preferences.
   Write each match as one entry in the consistency issues that starts with "UI:" and ends with the evidence line described below. These
   entries are advisory: when they are the only issues, keep the consistency score at 3 or 4. When no pattern matches, add no UI entry.
   Example entry: "UI: the new Remove button shows only a × and has no tooltip or accessible name.
   #EVIDENCE#
   {"file": "src/renderer/app/features/instance-detail/composer-queue.component.html", "lines": [12, 12], "quote": "<button (click)=\"remove()\">×</button>"}"
   ```
3. **`review-prompts.ts`** (261 lines, room 439): import `uiConsistencySection`; add `${uiConsistencySection(primaryOutput)}` right after
   `${angleSection(angle)}` in both builders (`:155` and `:196` today; re-anchor after Phase 0 step 9); add the section text to the `material`
   array of `promptVersionForAngle` (`:73`) so editing the check text invalidates cached verdicts (about +5 lines). Because the change is in the
   builders, the headless runner, the interactive review and the local reviewer all pick it up with no call-site edits.
4. **No new angle id, no new coverage entry, no extra model call.** The cost is about 250 tokens per reviewer, and only on renderer diffs.
5. **Drift guard:** `scripts/screen-and-wording-guide.spec.ts` imports `UI_CONSISTENCY_CHECKS` and asserts each `guideKeyword` (tooltip, title,
   jargon, status, consequence) appears in guide section 6.
6. The optional idea of building pattern 3's examples from the word list is dropped: the word list's `never` entries are regular expressions and
   cannot be printed as words. Pattern 3 keeps its fixed wording.
7. Keep the check that a local status map is a reviewer item (check 4) even though a build-time test already guards the common forms (Phase 3's
   status-presentation guard fails on `Record<InstanceStatus, string>` or a status `switch` that returns text); the reviewer catches variants the
   pattern cannot see. Do not count it as new protection.

**Tests:**
- `src/main/orchestration/review-ui-consistency.spec.ts` (new):
  - path detection is true for `diff --git a/src/renderer/app/x.component.html b/...`, for `+++ b/src/renderer/...scss` and for `+++ new file:
    src/renderer/...ts`; false for `src/main/...`, for `docs/...`, for a renderer `.spec.ts` only, and for a main-process file whose code
    merely contains the text `src/renderer/` in a changed line (headers only);
  - the section appears exactly once and contains all five patterns, the "UI:" instruction and the example;
  - closing-delimiter escaping and the evidence section still appear once; no all-caps `IMPORTANT` or `ONLY` was added.
  All fail today (the module is missing).
- `review-prompts.spec.ts` (extend): for non-renderer content the structured and tiered prompts are byte-identical to the output after Phase 0 step 9;
  for renderer content they contain the section once; `promptVersionForAngle` differs only through the added material. Fails today for the
  renderer cases.
- `headless-review-runner.spec.ts` (extend; it observes prompts through `dispatchReviewerPrompt.mock.calls[n][1]`, `:60-62`): a renderer diff puts the
  section into every reviewer's prompt; a main-process diff does not; coverage entries are unchanged in number and `required` flags.
- `scripts/screen-and-wording-guide.spec.ts`: guide section 6 keywords match `UI_CONSISTENCY_CHECKS`.

**Risks:**
- Extra prompt text on renderer diffs (about 250 tokens per reviewer); no extra calls, so the spend numbers move very little.
- A reviewer can ignore "keep the score at 3 or 4" and score 2. The note is still advisory because of 8a, so nothing depends on that line.
- The "consistency" dimension is a loose home for these notes. It is the closest existing slot that needs no schema change, and the title rewrite
  hides the mismatch from James.
- Other repos with a `src/renderer/` folder get Harness-specific questions through `aio review`. Accepted.
- Cache: the check text is part of `promptVersionForAngle`, so editing it invalidates every cached verdict once. Intended.
- Little traffic until loops and `aio review` are used on renderer work again; the day-to-day value is the guide's section 6.

**Done when:**
- A reviewer prompt built from a renderer diff contains the section once; one built from a main-process diff is unchanged byte for byte.
- A simulated reviewer reply with a `UI:` entry produces a non-blocking `low` finding with the plain title.
- The drift spec passes, and `npm run check:dead` is clean for the new module's exports.

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “8b. The screen-and-wording section in the reviewer prompts (S)”.

## Step 9. D10 (first half): The lint plug-in and its link test, with every rule off (M)

**For James:** nothing changes on screen. When the leftover count for one of the strict tooltip rules reaches zero, the editor and the ordinary style
check (called lint) will flag that mistake the moment it is typed, instead of waiting for the longer check. A test reminds whoever finishes the last
fix to switch the rule on, so it cannot be forgotten.

This is the first half of the backlog's D10. The plug-in ships with every rule switched off, together with the test that forces each switch-on. The
four one-line switch-ons are in part 3 (its step 2), each made only when its count in the record reaches zero. **This step needs only step 4** (the
codes, the record, the constants and the fixtures module) **and step 5e** (the plug-in classifies `[appIconButton]`); the single plan ordered it after the rail part (its 9b)
without giving a reason, and none exists, because every rule starts off. Its value starts when a record row reaches zero, which needs the migration in
parts 2 and 3.

**Verified (10 Oct):**
- **The backlog item** (`claude_oct-todo.md:864-866`): "Move the strict rules into a local ESLint template rule... angular-eslint's `elements-content` can't do
  it, because it counts any child and `title` as content." The audit's staging rationale is that lint on day one would need about 300 suppressions and push
  people into the mass `title=` swap the plan forbids, so this trails the guard.
- **Today's lint cannot see the nameless-button pattern.** `elements-content` is in `angular.configs.templateAccessibility` at `error`; its selector is
  `Element[name=/^(a|button|h1|h2|h3|h4|h5|h6)$/i][children.length=0]`
  (`node_modules/@angular-eslint/eslint-plugin-template/dist/rules/elements-content.js:48`), and `title` and `aria-label` are in its default safelist (`:8-16`).
  Run with the repo's own `eslint.config.js` through `ESLint#lintText` (in memory, nothing written; re-run by the plan writer on 10 Oct): an empty `<button type="button"></button>` is reported;
  `<button type="button"><svg viewBox="0 0 1 1"></svg></button>` is clean; `<button type="button">&times;</button>` is clean; an empty button with only a
  `title` is clean. (More precisely than the backlog: the rule only inspects `a`, `button` and headings with no children at all, and accepts `title` or
  `aria-label`.)
- **Where lint runs.** `eslint.config.js` is CommonJS (`package.json` has no `"type"`); its `**/*.ts` block uses `processor: angular.processInlineTemplates`
  and its `**/*.html` block extends `templateRecommended` and `templateAccessibility` with `rules: {}` (read on 10 Oct; 99 lines). `ng lint` covers
  `src/renderer/**/*.ts` and `.html` (`angular.json:89-92`); CI runs it (`.github/workflows/ci.yml:48-49`) and `verify` runs it (`package.json:49`).
- **The mechanism works end to end** (in-memory probes, nothing written). A custom rule added with `new ESLint({ overrideConfigFile: 'eslint.config.js',
  overrideConfig: [{ files: ['src/renderer/**/*.html'], plugins, rules }] }).lintText(...)` reported `title` on a `<button>` inside an **inline** template at the
  right place in the `.ts` file, skipped an `<iframe title>`, fired on a standalone `.html`, and did not fire on `resources/other.html`. Locations come from
  `context.sourceCode.getLocFromIndex(node.sourceSpan.start.offset)`; no extra package. With `new Linter({ configType: 'flat' })` and `parser:
  require('@angular-eslint/template-parser')`, one rule that listens to `Element`, `Text`, `BoundText` and `Element:exit` classified eight cases correctly.
- **No hand-written child walker is needed.** The parser registers visitor keys for control flow (`node_modules/@angular-eslint/template-parser/dist/index.js:45-46`
  `SwitchBlock: ['groups','expression']`, `SwitchBlockCaseGroup: ['cases','children']`), so ESLint's own traversal reaches text in every branch. This sidesteps the
  `SwitchBlock` trap step 2 hit.
- **Reuse is not free.** The reader is TypeScript run by `tsx`; the config loads plugins with `require`; the root `tsconfig.json` has no `allowJs`. So the plug-in
  is plain, self-contained JavaScript, and a parity spec ties it to the reader.
- **Tooling.** ESLint 9.39.5 (`Linter`, flat config; re-checked). `@angular-eslint/test-utils` is not installed, and the repo says not to add packages without
  approval, so specs drive `Linter` directly. No existing spec drives ESLint.
- **Precedent.** t3code bans `title` on every intrinsic element except `embed`, `frame`, `iframe`, `math` and `object`
  (`oxlint-plugin-t3code/rules/no-native-title-tooltip.ts:1-35`) and wires it as `"t3code/no-native-title-tooltip": "error"` (`vite.config.ts:169`).
- **An alternative not taken.** ESLint 9.24+ bulk suppressions would allow the rules at `error` today, and the angular-eslint builder exposes `applySuppressions`
  and `suppressionsLocation` (`node_modules/@angular-eslint/builder/dist/schema.json:105,109`; read, not run). It would keep a second copy of the same debt.

**Change:** (step 4 first: the codes, the record, the constants and the fixtures module)
1. **New `eslint-rules/ui-hints.js`** (CommonJS, `// @ts-check`, about 240 lines; plain JavaScript, so outside the `.ts` size ratchet, but keep it under 300).
   Exports `{ meta: { name: 'ui-hints' }, rules }` with three rules. Messages are for developers.
   1. `icon-control-needs-name-and-tooltip` (H1a, H1b; message ids `noName`, `noTooltip`).
      - A control is `button`, `summary`, `a` with `href` or `routerLink` (text or bound), or an element with an interactive `role`.
      - Skipped: `aria-hidden="true"` with `tabindex="-1"`, a known `data-ui-hints-exempt`, and any control whose subtree contains a hyphenated non-`ng-`
        element (a child component has unknown content, the same as the reader's "opaque").
      - Keep a stack of open controls; `Text` with `/\p{L}{2,}/u`, and `BoundText` with a lettered fragment or any expression, mark every open control as
        having text; decide at `Element:exit`.
      - Name: an `aria-label` text attribute containing a word, `[aria-label]` or `[attr.aria-label]`, or `aria-labelledby`. Tooltip: `appTooltip`,
        `appTooltipTpl` or `appIconButton`.
   2. `no-native-title` (H2a first). Option `{ scope: 'controls' | 'all' }`, default `'controls'`. `controls` reports a `title` text attribute or `[title]` /
      `[attr.title]` on the control set above plus `input`, `select` and `textarea`. `all` reports every element except `iframe`, `frame`, `embed`, `object`,
      `math` and SVG `<title>` elements, and includes hyphenated hosts (H2c).
   3. `no-hardcoded-shortcut` (H5). On `title` and `appTooltip` text attributes and the literal strings inside bound values (walk `value.ast` for
      `LiteralPrimitive` strings and `Interpolation.strings`), reject the same pattern the reader uses (glyphs `⌘ ⌥ ⇧ ⌃`, `Cmd+`, `Ctrl+`, `Alt+`, `Shift+`,
      `(Esc)`, `(Enter)`, `+Enter`, `-click`). Visible text is not checked. An element marked `data-ui-hints-exempt="local-key"` is skipped.
2. **`eslint.config.js`** (99 lines, JavaScript, no cap; about +14 lines): `const uiHints = require("./eslint-rules/ui-hints");` and one new block after the
   last one: `{ files: ["src/renderer/**/*.html"], plugins: { "ui-hints": uiHints }, rules: { "ui-hints/no-hardcoded-shortcut": "off", "ui-hints/no-native-title":
   ["off", { scope: "controls" }], "ui-hints/icon-control-needs-name-and-tooltip": "off" } }`, with a comment pointing at the link test. Renderer-scoped on
   purpose (the probe showed this pattern matches inline and external templates and nothing outside `src/renderer`).
3. **The switch-on is automatic: `scripts/__tests__/ui-hints-lint-link.spec.ts`.** It loads `eslint.config.js` and `scripts/ui-hints/baseline.json` and applies one
   pure function `checkLink(config, baseline)`:
   - `icon-control-needs-name-and-tooltip` must be `error` exactly when the H1a and H1b totals are 0;
   - `no-hardcoded-shortcut` exactly when the H5 total is 0;
   - `no-native-title` must be `error` exactly when H2a is 0, and its option must be `scope: "all"` exactly when H2a, H2b and H2c are all 0.
   The failure text says which direction to flip. So when the migration's last fix lands (in part 2 or part 3) and `--tighten` takes a total to zero, the build goes red until the
   severity is set, and the severity cannot be set early because the rule would redden CI.
4. **Switch-on order**, written in the plug-in's header and the link test's message: H5 first (about 13 sites; step 5c and the migration in parts 2 and 3 remove them), then `no-native-title`
   with `controls`, then the icon-control rule, then `scope: "all"`. H3, H4, H6, H9, H10 and H11 stay in the guard: they need judgement or whole-tree knowledge.
5. **Lint is the convenience layer; the guard stays the enforcement.** An `eslint-disable` comment in a template silences lint but not the guard, which ignores
   directives. State this in the plug-in header.

**Tests:** all new. None can fail on today's code, because the rules start `off`.
- `scripts/__tests__/eslint-ui-hints.spec.ts` (`Linter` plus the template parser, no new package):
  - icon-control rule: the eight proven cases (`&times;` only has no name; an `@if/@else` pair of SVGs has no name; `@switch` text is clean; bound text is clean;
    `aria-label` without a tooltip lacks a tooltip; both present is clean; a child component is skipped; `aria-label="x"` with `appTooltip="x"` is a junk name);
    `a` without `href` is not a control; a `div role="button"` is; the exempt marker and `aria-hidden` with `tabindex="-1"` are skipped; an `@for` body and a
    `*ngIf` wrapper report once.
  - `no-native-title`: `title`, `[title]` and `[attr.title]` on a button; `div title` clean under `controls` and flagged under `all`; `iframe title` and SVG
    `<title>` clean; `<app-empty-state title="x">` clean under `controls`, flagged under `all`.
  - `no-hardcoded-shortcut`: static, bound-literal and interpolated strings flagged; visible text "Cmd+K" not flagged; the `local-key` marker skips.
  - wiring through the real config: `ESLint#lintText` with `overrideConfig` that turns a rule on reports at the `.ts` line and column for an inline template,
    reports for a standalone `.html`, and reports nothing outside `src/renderer`.
  - **parity:** for every lint-backed fixture in `scripts/__tests__/ui-hints-fixtures.ts`, lint flags exactly the fixtures the reader flags and none of their
    compliant twins; the shortcut pattern, control tags, interactive roles and exempt reasons in the plug-in equal the reader's exported constants.
- `scripts/__tests__/ui-hints-lint-link.spec.ts`: `checkLink` accepts today's state (all `off`, totals above zero); fails when a fixture baseline has H5 at zero and the
  rule is `off` ("switch it on"); fails when a rule is `error` while its total is above zero ("it would redden CI"); the `scope: "all"` rule follows H2a, H2b and H2c;
  and the three rules are present in the loaded config (a deleted block fails).

**Risks:**
- *Cannot be finished inside this step on its own.* Its value starts when a record row hits zero, and that needs the migration in parts 2 and 3. The code, the parity test and the link test
  ship now with every rule off; each switch-on is a one-line change forced by the link test.
- *Constants duplicated between the reader and the plug-in.* The parity test fails on drift. A new text-bearing directive must be added to both: step 4's
  "every directive under `shared/tooltip` is classified" case catches the reader side and the parity test the plug-in side.
- *False positives.* The lint set is a deliberate subset of the guard's (child components are skipped), so "record at zero" implies "lint clean". The risk is the other
  direction, a rule at `error` that flags something the reader allows; the parity test covers that.
- *Speed and noise.* One cheap visitor per template; no warnings are emitted while a rule is `off`, so `ng lint` output does not change today.

**Done when:** `npm run lint` passes with the plug-in registered and every rule `off`; `npm run test:quiet -- scripts/__tests__/eslint-ui-hints.spec.ts
scripts/__tests__/ui-hints-lint-link.spec.ts` passes; `npx tsc --noEmit` and `npm run check:ts-max-loc` still pass (the plug-in is `.js`).

**Live checks:** recorded in [the live-test document](2026-10-10-oct-phase4-tooltips_livetest.md), under “Step 9. D10 (first half): The lint plug-in and its link test, with every rule off (M)”.

---

## Final verification

When each step is finished, run its targeted specs and `npx tsc --noEmit`. When the whole plan is done, run the canonical gates and record their current output in
the as-built notes:

```bash
npx tsc --noEmit
npm run typecheck:spec
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run build:renderer
npm run test:quiet
npm run check:ui-hints     # from step 4c on: the guard and the wording ledger
npm run check:dead         # step 8 adds exports in src/main
```

This phase adds no IPC channel, so `npm run verify:ipc` and `npm run verify:ipc-usage` are not needed. Run both if a channel is added after all.
`npm run audit:ui-hints` prints the honest counts; paste its summary into the as-built notes at step 2 and at step 4c.

**Fresh-eyes completion gate.** Before calling this plan complete:
1. A fresh agent that did no implementation work runs the `task-completion-gate` skill over this plan's changes, this plan and the backlog items.
2. Fix every actionable finding, rerun the checks, and send the work to another fresh review.
3. Repeat until it returns `VERDICT: PASS`.

Brief every reviewer on James's rules: no branches or worktrees, no browser on the Mac, preserve other sessions' uncommitted work, and no secrets. Ask the
reviewer of step 4 to run `npm run check:ui-hints -- --against <ref>` by hand; it checks the wording ledger as well as the counts.

## Live checks

These need the rebuilt app, a real provider CLI, a person, or the Windows PC. They are listed under each step. When the code is done, move them into
`docs/plans/2026-10-10-oct-phase4-tooltips_livetest.md` with the standard header:
- prerequisites (rebuild, restart, and which instance);
- a link back to this plan;
- the remediation-flow paragraph pointing at `livetest-campaign-runbook.md` and `livetest-remediation-register.md`.

Then leave a one-line pointer here. Screen checks run on the Windows PC, or on the Mac only with James's OK. Two checks need an adopter that does not exist
in this part, so they are not deferred from here but run in part 2's livetest doc: step 5c's shortcut chip (first used on the rail, part 2 step 1b) and step 5d's
reasons on greyed-out buttons (the voice button and the Loop switch, part 2 steps 1d and 1g). Say so in this part's livetest doc. Step 5e's check runs on 7c,
which is in this part. The livetest doc is itself a plan: it is renamed `_livetest_completed.md` only when every check passes with evidence.

## Not in this plan (and where it goes)

- **The screen-by-screen migration and the lint switch-ons** are parts 2 and 3 of Phase 4, not later work.
- **Deleting step 1's bridge.** It needs the native-title counts at zero everywhere and the seven transcript HTML strings (`markdown.service.ts:145,276,460,464,470,473`,
  `codex-followup-markdown.ts:69`) moved to something the bridge also reads, such as a data attribute. Those seven are a standing exception in the record.
  The backlog's D7 "delegated listener" was expected to cover them, but the design relies on step 1's bridge instead (7b adds only keyboard access), so nothing
  removes those strings. A later change (the October follow-ups plan, part 8d, item 1).
- **Promoting the "disabled needs a reason" and "tooltip begins with the name" reports to the guard.** They start report-only; promote them when step 5's adoption has
  settled and the counts mean something.
- **Ratcheting the "opaque control" count** (a button whose only content is a child component; one today) if it grows.
- **A rule for unnamed form fields** (the message box is fixed in part 2's step 1d; the audit counted 26 unnamed inputs in the verification pages). The counter prints a number; nothing gates it.
- **A12's `docs/llm/harness-help/` page set.** Phase 1's check moved it out of A12 and handed it to D6 ("D6 can render the same three texts"). D6 declines it: those pages are
  instructions written for the agent, not explanations for James, `docs/` is not packaged, and "Learn more" opens in-app Help (6b). So neither plan builds it, and James
  dropped it on 11 Oct ("We have FAR too many docs"; Phase 1 choice 14).
- **Converging Settings' own Help drawer with the new shared panel.** The two coexist; merging them is a later tidy-up.
- **"Which one do I want?" boxes** on the empty states of Loop, Plan queue, Automations, Council and Verification. Not in the approved D7 text; the shared Help topics would carry them
  if wanted.
- **A bare "?" key and a shortcuts list in `/help`:** the backlog rejects it. The "?" here is a button.
- **Palette entries for the three Help topics** (7c, optional): only if Phase 3's C10 palette API exists.
- **Switching Phase 3's wording extractor to read templates with step 2's reader** (`scripts/ui-text/extract-ui-text.ts`, `npm run audit:ui-words`). Phase 3 handed this to this phase. It is
  optional, because the extractor works on its own; a small follow-up once step 2 exists, so the two tools share one template reader (the October follow-ups plan, part 8d, item 3).
- **Rewriting the other Help articles (`*.help.ts`) beyond word swaps.** Phase 3 handed this to the glossary item. Step 6 adds a Words entry and 7d rewrites only the loop article; the rest wait.
- **Deleting the two dead helpers in `markdown.service.ts`** (`setupCopyHandlers`, `setupFilePathHandlers`): housekeeping (corrected 11 Oct: the Housekeeping plan does not list them; the October follow-ups plan, part 5i).
- **A size cap on `AGENTS.md`** and **a scheduled review of the guide.** Neither; the guide's one-sentence upkeep rule is enough.
- **The reviewer check reading the guide at review time** instead of copying the five checks into the prompt: one source of truth, but it adds file reads to a pure prompt builder and
  puts repo text into the prompt as instructions. Revisit if the checks change often.
- **Editing James's personal `task-completion-gate` skill.** The pointer in `AGENTS.md` reaches that reviewer; changing the skill is a change to his own setup.
- **ESLint bulk suppressions, and per-folder lint switch-on** (choice 12).
- Pieces this plan leaves to nobody are collected in the October follow-ups plan (`2026-10-11-oct-followups_plan.md`), with a one-line list for the small or conditional ones.

## Found on the way (not fixed here)

1. **Lint is blind to icon-only buttons** (verified): `<button><svg></svg></button>` and `<button>&times;</button>` pass `elements-content`. Step 9 here adds the rule's plug-in and part 3 switches it on late.
2. **Eight invisible backdrop buttons are real tab stops** (`type="button"` with `aria-label`, no `tabindex="-1"`): keyboard users likely land on invisible "Close menu" buttons
   (`settings.component.html:9,364` and six more). Not tested in a browser. 4b only exempts them from the counts. The new Help drawer's scrim (6b) avoids the problem with `aria-hidden="true"` and `tabindex="-1"`. The October follow-ups plan, part 7e, fixes the other eight.
3. **A button that wraps a child component and has no name of its own:** a crude probe put one at `features/remote-nodes/remote-nodes-page.component.ts:45`. Unverified; the counter
   reports such "opaque" controls (1 today) without judging them.
4. **No rule gates unnamed form fields** (see Not in this plan; the October follow-ups plan, part 7f, adds one).
5. **Two dead helpers in `core/services/markdown.service.ts`** (`:510`, `:572`), no caller anywhere in `src`. The October follow-ups plan, part 5i, deletes them.
6. **`docs/DESIGN.md:7-14`** lists "Massive Scalability ... 10,000+ instances" and "Rich Visual Telemetry" as goals, the opposite of the calm-screen goal. Step 3 adds a two-line pointer
   and leaves the rest.
7. **The "Focus Input" keybinding has no handler** (`keybinding.types.ts:57`, `:165-171`, default key `i`): the action id appears in no other non-spec file. It matters for 7b's Tab-stop risk. The October follow-ups plan, part 5i, deletes it.
8. **`AGENTS.md` is loaded twice by Copilot** (once directly, once through the `@AGENTS.md` line in `CLAUDE.md`). Phase 0 records that as James's choice. Every byte added to `AGENTS.md`
   costs double there; step 3's pointer (about 190 bytes) is sized for it.
9. **Whether `[appTooltip]` opens on a disabled host in Harness's Chromium is unverified.** The directive listens to `mouseenter` and `focus` on the host
   (`aio-tooltip.directive.ts:92-95`). Step 1's live check 5 settles it (step 5d's check is the same one, recorded once); the greyed-out design does not depend on it.
10. **The size check only counts git-tracked `.ts` files** (`check-ts-max-loc.ts:620-625`), so a new module is unchecked until added. Count by hand (ground rule 4). The October follow-ups plan, part 5i, makes the check see untracked files.

## Corrections to the backlog

- **The Phase 4 row "tooltips everywhere (rolling)":** it is now three plans. D1b, D2 to D4 and D6 to D9 are this part, D5's tiers A and B are part 2, and D5's tiers C and D and the lint switch-ons (D10) are part 3.
- **D1b "all ~358 remaining hovers":** 358 is right for real elements (216 on controls + 142 on plain elements). The parser total is 390 titles because 32 more sit on component hosts, plus 3 HTML
  strings built in TypeScript and 4 `button.title =` writes. So "all" is not quite true: the bridge upgrades the 358 and the transcript strings, and skips the 32 component-host titles by design (choice 1).
- **D2 and D3 "all 307 templates":** it is 305 (307 counted `index.html` and a stray `template:` line); all 305 parse with 0 errors.
- **The audit's "32 `title` component inputs (not DOM)":** 30 of the 32 are static attributes that Angular does write to the host element (verified in the runtime path; not seen in a browser).
- **D2 "rebuild `scripts/audit-native-titles.js`":** the new reader is a TypeScript folder beside it; the old script and its spec are deleted in 4c, not rewritten. It also
  counts a tooltip host only when its component imports the directive; one attribute today (`instance-list.component.html:472`) is inert, and that is a hard failure under H12.
- **D3 "generalise `icon-control-tooltip.spec.ts`":** the logic moves to a script and CLI, and that spec is deleted (its 11-entry exemption table becomes 7 reasoned entries; four carry an
  `aria-label` and need none).
- **D3 rule 2 "no native `title` on controls":** widened to every element, so the bridge can in principle be removed; and a count-only ratchet is unsafe because it rewards deleting
  titles, so a wording ledger was added.
- **D3 rule 4 "136 hover-only titles" (audit):** the parser gives 143 hosts (11 tooltip + 132 title).
- **D3 rule 5 "no hard-coded shortcut text":** only template literals were visible (11 sites). Since the second review the reader also reads text computed in a member of the same component or a helper beside it (the send and interrupt buttons, about 13 in all); computed text built in another folder or a service is the remaining blind spot. Added: a `local-key` exemption for the one literal
  that cannot be a registry action (this plan's addition, which reconciles the reports).
- **D3 rule 6 and D6 "delete its 3 dead keys":** 2. Phase 0 step 2.6c wires `loop.recycleToggle`.
- **D3 rule 8 (glossary marks):** dormant until step 6a, then report-only (not a ratcheted rule).
- **D4.2 "at least 12 hover texts hard-code Mac glyphs":** 15 sites in 11 files (12 hover strings, 3 labels, placeholders or visible hints), and two of the kinds are not registry actions.
  **"wrong on Windows and Linux" is understated:** even the existing live display prints "Win" for Ctrl, so wiring the existing pipe was not enough; 5a fixes the display.
- **D4.3 "put an `xDisabledReason` next to every `xDisabled`":** the directive must sit on the focusable element; for a checkbox inside a label that is the input, so the Loop switch needs its
  template adjusted (part 2's step 1g).
- **D6:** (a) "delete its 3 dead keys" is 2; (b) "Expand `TOOLTIP_COPY` beyond the loop" is not part of D6, because new keys arrive with the screen that uses them; (c) "add `learnMore`" goes on glossary entries,
  not tooltip entries, because a hover box cannot be clicked; (d) "'Learn more' opening Help or the A12 help pages" is in-app Help only, and A12's `harness-help` set is dropped (backlog line 376 is stale);
  (e) "about 25 terms" is 30; (f) "an `appTerm` marker" is a small component (`<app-term>`) because it must render a real button.
- **D7:** (a) "opens the Help pane as a drawer" assumes a drawer that does not exist (the Help pane is mounted only in Settings and the Control Center); 6b builds the shared one; (b) "Add tooltips to
  transcript links and buttons ... using one delegated listener" is supplied by step 1's bridge, and 7b's own work is keyboard access; (c) the approved text does not mention rewriting the loop help; 7d includes it.
- **D8:** the guide points at C5's banner rule, C6's status presenter and C7's word list; it does not copy them. The audit's idea of turning `shell-component-standards.md` into the guide is not taken.
- **D9:** (a) "a review angle" is not a fifth entry in `REVIEW_ANGLES`: every remote angle is `required` and an incomplete one fails the gate closed; (b) "use it in the completion gate" is reachable
  only through the `AGENTS.md` pointer, because the gate is a personal skill; (c) the findings must be advisory by construction (8a), not just low-scoring; (d) it shares `review-prompts.ts` with Phase 0 step 9.
- **D10 "`elements-content` counts any child and `title` as content":** more precisely it only inspects `a`, `button` and headings with no children at all, and accepts `title` or `aria-label` (verified against the
  repo config on 10 Oct).
- **Backlog line 376 (A12: the `harness-help` pages "feed the tooltips' Learn more (D6)"):** stale. Phase 1's check handed those pages to D6, and D6 declines them (see Not in this
  plan), and James dropped `docs/llm/harness-help/` on 11 Oct (Phase 1 choice 14). Both phases now say so.
- **A figure in a report:** `session-progress-panel.component.ts` has 52 lines of room under the size ratchet (ceiling 747 + 50 − 745), not 2.

## Finishing

1. Every step is implemented, every gate passes, and the fresh-eyes gate returns PASS. This part closes on its own: it does not wait for the
   migration or the lint switch-ons (parts 2 and 3). The records written in 4c still hold the leftover counts, which parts 2 and 3 take down.
2. Create the livetest doc `docs/plans/2026-10-10-oct-phase4-tooltips_livetest.md` and move this part's live checks into it. Steps 5c and 5d need
   an adopter, so their checks are recorded in part 2's livetest doc; say so in this one.
3. Update this plan's status line and as-built notes. Rename this plan `2026-10-10-oct-phase4-tooltips_plan_completed.md` **last**.
4. In `claude_oct-todo.md`, mark D1b, D2, D3, D4, D6, D7, D8 and D9 done and link to the completed plan. Leave D5 and D10 open (D10's plug-in is built
   and switched off) until parts 2 and 3.
5. Commit only when James asks. Stage only this plan's code, the `_completed` plan and the guide (the livetest doc stays untracked until it is renamed `_livetest_completed`, because the commit hook refuses an open one) (`docs/screen-and-wording-guide.md`, a
   product document); never other sessions' work. Before every commit, inspect the staged paths and unstage any plan or spec that is not `_completed`
   (parts 2 and 3 stay untracked until they finish).

## As-built notes

### Queue execution record (12 Oct 2026)

- Worktree started clean; this root-checkout plan remains `?? docs/plans/2026-10-10-oct-phase4-tooltips_plan.md`. There is no separate linked spec; the approved backlog and this plan supply acceptance criteria. No branch/worktree creation, commits, stashes or database writes.
- Implementation is divided by module ownership using the subagent-driven-development skill: runtime steps 1/5; source tooling steps 2a/4a/4c/9; glossary/help/docs steps 3/6/7a/7c/7d. Root owns integration, markers, history import, transcript keyboard access and review safety.
- Ruling: earlier-phase output is absent in both supplied worktree and root (no `tooltip-visible-text.ts`, no `src/shared/copy/ui-vocabulary.ts`, no status presenter or new session header). Implement the narrow visible-text/panel prerequisite and canonical Phase 3 vocabulary data needed by this foundation; do not implement a Phase 3 wording sweep or pretend its presenter/header exists. Help describes the actual current screen and loop engine. Cost if wrong: reconcile these narrow interfaces when the earlier phases land.
- Ruling: the step 1 outer-title test conflicts with its explicit single-slot rule. Blanking a titled child with `title=""` blocks native ancestor inheritance; the parent keeps its original attribute until it becomes the selected source. Test single-slot and native-inheritance blocking rather than blanking two titles simultaneously.
- Initial honest source measurement before step 2b: 305 templates, 390 template titles, 99 active tooltip hosts, one inert tooltip at `instance-list.component.html:469` because its owner lacked `AioTooltipDirective`. The import is now added without changing that text.
- Ruling: all three configuration copy keys (`loop.recycleToggle`, `loop.isolation`, `loop.verifyTwice`) remain unreferenced because Phase 0 has not wired recycle. Remove all three, as step 6c explicitly permits; an earlier phase adopting recycle must add its key with its template use.
- Step 8 red evidence: six failures in 33 tests for UI-note severity, advisory aggregation and prompt section before implementation (`_scratch/test-run.pid-30638.log`). Step 7b red evidence: four failures in 56 tests for path role/tabindex and Enter/Space (`_scratch/test-run.pid-37488.log`). After changes, seven focused files / 100 tests passed (`_scratch/test-run.pid-38845.log`); runner/prompt contract extensions passed 24 tests (`_scratch/test-run.pid-46020.log`).
- Full test suite and fresh completion verdict are assigned to the independent queue verifier by the current worker brief. This worker leaves the plan active and does not rename it.
- Tooling rulings from executable fixtures: conditional selectors are not rendered names; visible whitespace around data bindings is not an icon-only name; HTML comments do not keep copy keys alive. Directive classification scans all `*.directive.ts` selectors rather than two fixed files, so a newly added provider requires an explicit classification. The disabled-reason icon alias is hover-bearing but not a standalone host.
- H11 records eight outside-template surfaces: the original seven transcript title strings/writes plus the bridge's restoration write. Restoring the user's current title is deliberate passthrough, not authored copy; no whole-file bridge exemption was introduced. Empty suppression writes do not create authored hints.
- CLI ruling: baseline tightening and a ledger retirement/recording must be validated together before either file is written; otherwise an honest title migration deadlocks between stale counts and lost wording. `--exempt owner reason --tighten` similarly permits one reasoned marker addition with concurrent reductions, never independent debt increases. Failed mutations leave both records unchanged. `--against` retains per-owner rule/unreadable increases and immutable ledger checks; known marker increases emit an explicit review notice (owner/reason/old/new) so the sanctioned exemption path remains usable. Transfers that raise a target owner's debt still require explicit base-review handling under this stronger second lock.
- Bootstrap correction: extensionless `baseline`/`wording-ledger` imports could resolve the newly emitted JSON instead of the TypeScript module. Internal `.js` imports preserve TypeScript/tsx module resolution after record creation; bootstrap regression coverage exercises the real CLI. No lint rule is switched on early while its recorded debt remains nonzero.
- Root marked all ten sanctioned surfaces with `data-ui-hints-exempt`; the header and two Settings backdrop markers were corrected to this exact contract. No backdrop tab-order changes were included. Existing adjacent marker-component tests passed 39 tests (`_scratch/test-run.pid-62169.log`).
- Fresh review correction: titled HTML sources must remain discoverable from SVG/path event targets. Two new bridge regressions failed before the fix (`_scratch/test-run.pid-79621.log`), then seven tooltip files / 104 tests passed (`_scratch/test-run.pid-83594.log`). Standalone SVG and component/media boundaries remain respected.
- Final runtime/help/main focused verification: 31 files / 417 tests passed (`_scratch/test-run.pid-11576.log`). This includes the original unmodified directive suite, real delegate open-path/teardown tests, live bindings/reasons, Help focus handling and both reviewer dispatch builders. Source-tooling corrections and their final evidence are recorded below after the final review.
- Source review corrections are now covered by executable regressions: ternary and boolean comparison operands do not supply labels or hover sentences; bound interactive roles match lint; visible sentences cannot be manufactured by joining alternate branches, dynamic holes or separate controls. Static concatenation, interpolation and inline sentence pieces still count. Variant expansion is capped at 128 with separated conservative fallback. The visible-only ledger stream excludes known hidden classes, hidden attributes, literal bound class/style/hidden values, SVG titles and unused templates; accessible-name facts retain screen-reader-only names.
- Evidence for those corrections: first extraction review reproduced nine failures (`_scratch/test-run.pid-12629.log`); subsequent hidden/boolean cases reproduced eleven (`_scratch/test-run.pid-21127.log`); whole-value bound class/style reproduced four (`_scratch/test-run.pid-31727.log`). Final nine tooling files / 152 tests passed (`_scratch/test-run.pid-32536.log`). No prior test was weakened to accommodate a defect.
- Final honest measurement: 308 templates / 308 components (75 external, 233 inline), 12,860 elements, 1,921 controls, 175 icon-only, 1,138 named by text, 167 named by data, one opaque control and 141 unnamed fields. There are 387 template titles, 105 active tooltip hosts, zero inert hosts, eight outside-template surfaces, ten markers and 79 unreadable hover bindings. Predicate-only reads were removed from the old 114 unreadable count with the sanctioned `--tighten`; no debt count was raised.
- Final ratchet: H1a 24; H1b 91; H2a 214; H2b 140; H2c 32; H3 20; H4 138; H5 12; H6/H10/H12 zero; H11 8. Report-only H1c 2, H7 123, H8 84. Wording ledger contains 170 entries, one explicitly retired: the original steer-warning title is replaced by the visible term and its keyboard-accessible definition. Counts and ledger were emitted/updated by the CLI, not hand-edited. Final guard and `--against HEAD` pass (`_scratch/phase4-check-ui-hints.log`); audit is `_scratch/phase4-audit-ui-hints.log`.
- Worker verification totals: 40 focused files / 569 tests passed across the two final runs. `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`, `npm run check:ui-hints -- --against HEAD` and `npm run check:dead` all exited zero. Retained logs are `_scratch/phase4-typecheck.log`, `phase4-typecheck-spec.log`, `phase4-lint.log`, `phase4-loc.log`, `phase4-build-main.log`, `phase4-build-renderer.log`, `phase4-check-ui-hints.log` and `phase4-check-dead.log` under this worktree's `_scratch/`.
- Warnings retained honestly: renderer initial bundle is 1.13 MB against a 1.00 MB warning budget (126.76 kB over); `check:dead` lists 23 pre-existing reset-helper candidates outside this diff and exits zero. No thresholds/baselines for these gates were relaxed. All 36 new production TypeScript modules were separately counted because the size gate scans tracked paths: maximum 234 lines (bridge); no module exceeds 700. All new hint tooling modules are at most 120 lines. No IPC was added and no generated IPC/alias output is required.
- Fresh independent scoped review of the corrected guard returned **VERDICT: PASS**, no unresolved actionable findings (`guard_corrected_review`): independently reran nine tooling files / 152 tests (`_scratch/test-run.pid-36151.log`), the strict CLI against HEAD, and 39 static/literal-bound/conditional interactive-role cases. Earlier broad fresh review independently passed runtime/Help/glossary/transcript tests (11 files / 108 tests, `_scratch/test-run.pid-16685.log`) and found no additional actionable runtime, CLI/CI, dependency, security, state or performance issues. Every reported SVG/extraction/visibility finding was reproduced, fixed and reviewed in a new context. This scoped evidence deliberately does not certify the coordinator's full clean-state Gate 0.
- First-round handoff: all nine implementation rows below were checked; the full-suite and overall verifier rows stayed open. Root plan and root livetest document remained untracked at their original filenames. The coordinator subsequently committed the implementation checkpoint as `165417296`; this worker did not commit it. The coordinator owns commit, harvest, integration, final closure and cleanup.

### Verification round 1 remediation (12 Oct 2026)

- **Finding 1, dependency provenance: remediated.** The verifier's full-suite run failed 1 of 30,948 tests; it is not recorded as a passing gate. Reproduced its failure independently with `npm run test:quiet -- scripts/__tests__/dependency-compatibility.spec.ts`: exit 1, 1 of 5 failed (`_scratch/test-run.pid-56652.log`). The linked install marker resolved to the root checkout; both `package.json` and `package-lock.json` differed from that checkout. This is an install provenance failure, not a tooltip defect, and the strict test remains unchanged.
- Replaced this worktree's per-entry dependency links with a real lockfile install: `npm ci --ignore-scripts --no-audit --no-fund` installed 1,434 packages, exit 0 (`_scratch/phase4-round2-npm-ci.log`). Skipping lifecycle scripts avoids the project postinstall's shared Git-hook/global-ignore writes. Ran `npm rebuild esbuild electron better-sqlite3 node-pty @parcel/watcher lmdb msgpackr-extract electron-winstaller --no-audit --no-fund`, exit 0 (`_scratch/phase4-round2-dependency-rebuild.log`), then the documented `npm run rebuild:native`, exit 0 (`_scratch/phase4-round2-native-electron.log`). `node scripts/verify-native-abi.js` confirmed better-sqlite3 ABI 143 matches locked Electron 40.10.6. No browser/app window was opened.
- The real `node_modules/.package-lock.json` now resolves inside this exact worktree. `archiver`, `@ai-orchestrator/contracts` and `@ai-orchestrator/sdk` workspace links also resolve to this worktree's `packages/` sources. Neither manifest was changed. Preserve this local install for re-verification; replacing it with the root checkout's linked install would reintroduce the failure. The old worktree-local link directory was removed after successful verification; the root dependency tree was not modified.
- **Current verification:** all 39 selected specs (every added/modified spec in the checkpoint diff, plus dependency compatibility and the unchanged tooltip directive/policy suites), 568 tests, passed with exit 0 (`_scratch/test-run.pid-61016.log`). After the Electron native rebuild, dependency compatibility passed again, 5 of 5, exit 0 (`_scratch/test-run.pid-63886.log`). `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`, `npm run check:ts-max-loc`, `npm run check:ui-hints -- --against HEAD`, `npm run build:main`, `npm run build:renderer` and `npm run check:dead` all exited 0. Logs: `_scratch/phase4-round2-{typecheck,typecheck-spec,lint,loc,check-ui-hints,build-main,build-renderer,check-dead}.log`. The recorded 1.13 MB renderer bundle warning and pre-existing dead-export candidates remain; no gate, test, threshold or baseline was weakened. No source or generated-output change was needed for either finding.
- **Finding 2, status clarity: corrected within queue ownership.** The status and checklist now distinguish finished worker implementation/verification from coordinator acceptance. The unchecked full-suite/PASS rows below are coordinator-owned gates, not unimplemented worker steps. The active filename is required by the current queue brief: this worker must not run the full suite, declare overall PASS or rename the plan. The existing live-test document already records exact procedures, expected results, prerequisites, routing and why those checks genuinely require a rebuilt/restarted designated app, real providers or human validation; those are allowed live-test deferrals, not inferred results.
- **Round 2 handoff:** ready for the independent verifier to rerun the full suite and completion gate against checkpoint `165417296` with the local install. Plan and livetest stay untracked in the root checkout at their original absolute paths. No separate linked spec exists. The supplied worktree has no tracked edits, staged files or new code changes from this remediation; no commit, stash, branch or worktree action was taken. Formal plan closure remains with the coordinator after an independent PASS.

(Record here, per step: what changed, any deviation from this plan and why, the 5e spike result, the counter's numbers at 2a and 4c, the live-check results,
and the current gate output.)

- [x] Step 1 D1b: root-provided delegated bridge, one live title slot, teardown/restoration, focus/hover/Escape/scroll behaviour. Fresh review's SVG-child targeting defect reproduced in two failing tests and fixed; tooltip directory's 104 tests passed (`_scratch/test-run.pid-83594.log`). Native Chromium checks remain in the livetest document.
- [x] Step 2 D2: 2a Angular/TypeScript source counter (initial and final measurements above), 2b actual owner imports `AioTooltipDirective`, completing runtime wiring for the unchanged Completed-dot hint. Final source measurement has zero inert tooltips.
- [x] Step 3 D8: 3a six-section guide with five numbered reviewer checks, AGENTS pointer and guide guard; 3b standards/design/visual-QA cross-links. Four guide contract tests pass in the final focused run.
- [x] Step 4 D3: 4a source guard/counts/wording ledger; 4b ten reasoned markers; 4c final CLI-written records and CI/pre-push wiring. Legacy audit and icon-only spec removed after their coverage moved to tooling. Numbers and exact final regression/gate evidence are above.
- [x] Step 5 D4: 5a Windows/Linux Ctrl display; 5b names read once; 5c registry shortcut chips update from settings; 5d described disabled reasons update/restore IDs; 5e icon-button spike uses `hostDirectives` with registered text source and the `appIconButtonDisabledReason` alias (avoids duplicate input/NG0309). Focus, live binding and retained baseline directive tests pass. Adopter visual checks remain assigned to part 2.
- [x] Step 6 D6: 30 glossary entries, underlined real term buttons, shared focus-trapped Help drawer mounted once at the application root, queue/worktree/RTK first uses and removal of three genuinely dead copy keys. Existing Settings Help remains separate. Drawer focus return, Escape layering, glossary text alignment and safe links are tested.
- [x] Step 7 D7: defaults extracted without value changes; sanitised inline file paths receive safe role/tabindex, delegated Enter/Space follows the real open-path handler and tears down both listeners; header/setup/running-loop Help links wired. Help describes this checkout's actual loop engine and header. Phase 3 header/palette and Phase 2 semantics were not fabricated.
- [x] Step 8 D9: prefixed UI findings are low/advisory through local conversion and remote aggregation (mixed substantive findings remain authoritative); screen check joins both existing review builders without adding an angle. Renderer paths come from actual diff headers; non-renderer prompt byte hashes stay unchanged. Runner tests exercise dispatch. Prompt fingerprints include the new static section. Phase 0 has not supplied a changedFiles field, so no nonexistent caller contract was added.
- [x] Step 9 D10 (first half): lint plug-in registered for real inline/external renderer templates, shared parity fixtures and automatic zero-debt switch-on link test. Every rule remains off while its debt is nonzero; the guard enforces the records independently of lint suppressions.
- [x] Worker final gates: focused tests, type checks, lint, size check, UI-hints guard, both builds and dead-export check pass with the worktree-owned install; current round-2 evidence is recorded above.
- [ ] Coordinator full-suite acceptance: round 1 exited 1 solely on dependency provenance; that failure now reproduces green in the unchanged targeted test. The full suite must be rerun by the independent queue verifier, not this worker, before the coordinator closes this plan.
- [ ] Fresh-eyes gate PASS: overall clean-state queue verdict remains assigned to the coordinator's independent verifier; the scoped worker fresh-review PASS evidence is recorded above.
- [x] Livetest doc created beside this root-checkout plan; each original live-check section now points there. This does not certify any live result.

> Plan Queue parked work: `queue/2026-10-10-oct-phase4-tooltips-1b2e67` — 1 commit(s), reason: land-blocked.
