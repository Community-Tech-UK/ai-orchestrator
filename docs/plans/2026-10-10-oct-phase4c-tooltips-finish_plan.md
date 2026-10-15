# October Phase 4 (part 3 of 3): the remaining screens, then lint

**Status:** active plan, dependency-blocked after verification-round-6 remediation on 12 Oct 2026; 0 of 10 complete parts, with independent subrequirements of 1a and 1d implemented and verified. Finding 2's dependency-provenance failure is repaired with a worktree-owned lockfile install; its unchanged reproducer and all focused tests pass (9 files / 149 tests), as do typechecks, lint, size and both builds. Finding 1 remains unresolved: Part 1 has independent PASS but AIO promotion is parked on root `package.json` changes; Part 2 is parked without its migrations. The parent must reconcile the collision, have AIO land the prerequisites, and refresh this checkout before the remaining tooltip migrations and four lint switch-ons can proceed. The full suite remains assigned to the independent verifier. Only the coordinator may rename this active document after independent PASS. This is a blocked worker handoff, not a verifier-ready completion handoff. Written 2026-10-10. Keep this file untracked until every part is implemented and
verified (see [Finishing](#finishing)). This is part 3 of 3 of Phase 4, which the second review (10 Oct 2026) recommended splitting
so that each part can close on its own. [Part 1](2026-10-10-oct-phase4-tooltips_plan.md) builds the tools and
[part 2](2026-10-10-oct-phase4b-tooltips-migration_plan.md) migrates the main screens; both must be finished first. **This is the one part that
stays open until the strict counts reach zero.** Every area is listed so the end is visible, and the records are its progress meter.

**Source:** the "Phase 4" row of the approved backlog [`claude_oct-todo.md`](../../claude_oct-todo.md) (James approved
it on 10 Oct 2026 and answered decisions 1-7). The row reads: "4: tooltips everywhere (rolling) | D1b (after D1), D2 →
D3 → D4 → D5 tiers → D6 → D8 → D7 → D9 → D10 | Measure, ratchet, building blocks, then migrate one surface per change".
This part is the second half of D5 (Tier C: the conversation tools, side chat, source control and settings; Tier D: the shared pieces and
everything else) and the second half of D10 (the four lint switch-ons).

**How it was checked:** on 10 Oct 2026, read-only checks (`p4-b.md` for D5, and `p4-a.md` for D10, in `_scratch/oct-phases/`, which is gitignored and
disposable) re-traced every D5 and D10 item against the working tree (HEAD `04b6db59b` plus other sessions' uncommitted work). The plan writer re-read
the conversation, side chat, source control, settings and shared-component sources and every file's headroom, and ran the lint mechanism in memory
against the repo's own `eslint.config.js`. A second, fresh review the same day (`_review2-phase4.md`) checked the whole of Phase 4 and recommended the
split; its findings are applied here, and its resolution log says where. Part 1's header holds the full account of the checks and the conflicts they settled.
**Line numbers are as of 10 Oct and will move. Re-read the code before editing.**

**Size:** large and open-ended by design. Step 1 is six parts, one change each, of size S to M; its last part (everything else, folder by folder) is
rolling. Step 2 is four one-line switch-ons that wait for step 1 (and part 2). Sizes use the backlog's XS-L scale.

**Depends on:**
- **Parts 1 and 2 of this phase** ([part 1](2026-10-10-oct-phase4-tooltips_plan.md), [part 2](2026-10-10-oct-phase4b-tooltips-migration_plan.md)), finished: the
  guard and its records (part 1's step 4), the building blocks (part 1's step 5), the recipe and the order rules (part 2's step 1 and choice 4), and the lint
  plug-in with its link test (part 1's step 9). Step 2 here also needs part 2's tiers done, because the counts it waits for include theirs.
- **The Phase 0 plan:** step 4 (the permission card, also edited in 1f).
- **Phase 3 (calm screen):** C8 (it renames YOLO) before the permission card in 1f.
- **Files in flight in other sessions** (see ground rule 3): the Settings provider-accounts tab (1d) and the browser-approvals banner (1f) wait for
  those sessions to commit.

---

> **Coordinator handover (13 Oct 2026, Plan Queue parent).** The complete prior implementation for
> this plan is on the parked branch `queue/2026-10-10-oct-phase4c-tooltip-4995f5` (4 files vs `main`);
> it is not on `main`, and a fresh worktree cut from `main` does not contain it. Before anything else,
> bring that branch's content into your worktree (`git merge --squash queue/2026-10-10-oct-phase4c-tooltip-4995f5`,
> or `git diff $(git merge-base HEAD main) queue/2026-10-10-oct-phase4c-tooltip-4995f5 | git apply`),
> reconcile it with the as-built notes below, then finish the remaining unchecked items — do not
> reimplement from scratch. Parts 1 and 2 must land first; integrate what has landed and record what
> still waits. Delete this handover note once the port is in place.

## In plain English (what James will notice)

1. **The rest of the app gets the same treatment, one folder at a time.** The conversation tools (find bar, jump rail, progress panel, context bar), side chat,
   source control, settings, the shared dialogs and cards, and then every other folder, largest first. Each area is checked by hovering and by Tab. Anything a
   hover used to warn about that matters becomes visible text.
2. **Source control hints show the right keys for your computer.** The hints about Command/Ctrl+Enter and Command/Shift-click say Ctrl on Windows and Linux.
3. **Six shared cards and dialogs stop showing their heading as an accidental grey bubble over the whole card,** if they do today.
4. **Later, the editor's style check catches the same mistakes as you type.** Each rule switches on only when its leftover count reaches zero, and a test makes sure that
   switch-on is not forgotten.

## Decisions this plan follows

From James (10 Oct 2026 unless stated):
- The product name on screen is **Harness** (Decision 1). All new wording says Harness.
- **Keep James's personal setup in machine-started sessions** (Decision 2). Nothing here removes any of it.
- The backlog's own rule for this phase: fix the directive, measure honestly, ratchet, then migrate one surface per
  change. A mass swap of `title=` attributes once lost a destructive-action warning, so wording only moves by part 2's recipe.
- Screen checks run on the Windows PC, or on the Mac only with James's OK. No branches or worktrees. Commit only when
  James asks.

Choices made while planning. Each is the recommended default, none blocks starting, and James can change any of
them. Visible changes have their own entries (1 and 2); the last is about how the work is done. One change since the first draft: Phase 4 is now three plans
(this is part 3 of 3). This replaces the earlier choice that the whole phase "stays open until the strict counts reach zero": parts 1 and 2 close on their
own, and this part is the one that stays open. The records stay in place and only go down. Part 1's bridge stays too: the seven HTML strings in the
conversation renderer keep their "title" text and use it. If James would rather close this part earlier, the unfinished folders of 1f and the last
lint switch-ons move to a follow-up plan with a new date; closing early would leave the guard holding old problems with no plan to remove them.
1. **The rest of the app gets the same treatment, one folder at a time (visible).**
   - The conversation tools come first among the daily panels, then side chat, source control, settings, the shared pieces, and then every other
     folder, largest first from the counter's table.
   - The same recipe and the same warning rule as part 2 apply: if an old hover said something is deleted, stopped, restarted, sent elsewhere, spent or
     lost, that sentence goes into visible text or behind a confirm. For example, the verification folder's "Delete session ×" gets a hint and a
     visible consequence or a confirm.
   - Source control's Command/Ctrl+Enter and Command/Shift-click hints are built with the right key name for the computer; the diff viewer's Esc stays
     literal, with the hidden marker that part 1 placed.
   - Alternative: stop after the daily panels. Why not: the guard would hold hundreds of old problems with no plan to remove them.
2. **Six shared cards and dialogs rename their heading setting (visible).**
   - On those six shared components the setting called "title" is a heading, not a hover hint. Renaming it to "heading" (32 places, checked by the compiler)
     removes the accidental whole-card bubble if it exists today, and takes the guard's component-host count from 32 to 0.
   - Alternative: leave them. Why not: they would keep a grey bubble over the whole card and block the last lint switch-on.
3. **Lint rules switch on one at a time, each only when its count reaches zero (not visible).**
   - The order: the shortcut rule first, then the native-title rule for controls, then the icon-control rule, then the native-title rule for every element.
   - Each is a one-line change in the same sitting as the fix that takes its total to zero, because part 1's link test goes red until the rule is switched on,
     and a rule cannot be switched on early because it would redden the build.
   - Alternative: ESLint's bulk-suppression feature (see part 1's choice 12). Why not: it would keep a second copy of the same debt.
## Ground rules for every part

1. **Read first.** Re-read the file, its callers and its specs before editing. Line numbers here are from 10 Oct, and
   Phase 0 and Phase 3 will move many of them.
2. **Prove the bug first.** Where a part names cases that "fail today", write the failing test first and confirm it fails on today's code. Cases marked "fails today" must be seen failing.
3. **Work in the current checkout.**
   - Do not create a feature branch or worktree; that is James's rule.
   - Other sessions have uncommitted work in this tree (176 entries on 10 Oct). Treat anything already modified before
     you start as theirs, and never stage, revert or reformat it.
   - Known collisions with this part:
     - `features/settings/provider-accounts-tab.component.ts` (+110 lines, plus untracked `provider-accounts-machines.ts`). Part 1d waits for that
       session to commit. The counter measures whatever exists on the day.
     - The browser-approvals banner files in `core/state/` and `features/instance-detail/browser-approval-request.component.spec.ts` are in
       flight. Their Tier D clean-up (in 1f) waits.
   - Run `git status --short` on the day each part starts.
4. **File-size limits** (`npm run check:ts-max-loc`).
   - Allowlisted files may grow to their ceiling plus 50 lines. Other `.ts` files are capped at 700. "Room" below is
     measured that way, so it is the true failure threshold. Templates, styles, specs and docs are not counted.
   - Only git-tracked `.ts` files are checked, so a new module is not size-checked until it is tracked. Count new
     modules by hand against 700 while developing.
   - Headroom on 10 Oct, for the files this part edits. Paths are under `src/renderer/app/` unless they start with `src/`:

   | File | Lines now | Room left | Plan |
   |---|---|---|---|
   | `features/instance-detail/session-progress-panel.component.ts` | 745 | 52 | part 1's 4b: marker, +1 line. 1a: three titles |
   | `features/instance-detail/instance-detail.component.ts` | 1,579 | 53 | 1a: template-only if possible |
   | `features/source-control/source-control-repo-actions.component.ts` | 625 | 75 | 1c |
   | `shared/components/remote-browse-modal/remote-browse-modal.component.ts` | 624 | 76 | 1e |
   | `features/side-chat/side-chat-panel.component.ts` | 513 | 187 | 1b |

   Roomy files edited by one part only (more than 250 lines of room) are not listed. All new modules are planned well
   under 700 lines. Put new logic in new modules, keep call-site edits to a line or two, and do not raise a ceiling.
5. **Wording on screen:**
   - Plain English, "Harness", and no internal codes.
   - Tooltips use `appTooltip` with `TOOLTIP_COPY`. Do not add new `title=` attributes to controls.
   - A tooltip may not be the only place that shows a state or a consequence (house rules at the top of
     `tooltip-copy.ts`).
   - Old hover wording moves verbatim and only by part 2's recipe (its step 1). Never reword, merge or drop a hover sentence
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
12. **Commit only when James asks.**

## Order of work

Parts run one at a time. "Needs first" lists hard dependencies only. A part that is still waiting for its Phase 2 or Phase 3 item, or for another session's
files, is skipped for now; the others do not wait for it.

| Part | Item | Size | Needs first | Main files (new modules in *italics*) |
|---|---|---|---|---|
| 1a | Conversation tools (find bar, jump rail, progress panel, context bar and attribution, inspector toggles) | M | part 1 step 5; part 2's recipe | the conversation templates under `features/instance-detail/` |
| 1b | Side chat | S | part 1 step 5 | `side-chat-panel.component.*` |
| 1c | Source control | M | part 1 steps 5 (5c, `modKeyLabel()`) and 4b (the `local-key` marker) | source-control templates, repo actions, diff viewer |
| 1d | Settings: the shared row and the other tabs | M | part 1 step 5; the provider-accounts tab waits for its other session | `setting-row.component.ts`, the Settings tabs |
| 1e | Shared pieces and the whole-card titles | S-M | part 1 step 5 | shared components, six `title` to `heading` renames |
| 1f | Everything else, folder by folder | L, rolling | all above; Phase 3 (C8, for the permission card's YOLO button); the browser-approvals banner waits for its other session | per folder, by the counter's table |
| 2a | Switch on the shortcut rule | XS | the H5 total is 0 | `eslint.config.js` |
| 2b | Switch on the native-title rule for controls | XS | the H2a total is 0 | `eslint.config.js` |
| 2c | Switch on the icon-control rule | XS | the H1a and H1b totals are 0 | `eslint.config.js` |
| 2d | Widen the native-title rule to every element | XS | the H2a, H2b and H2c totals are 0 | `eslint.config.js` |

Do the parts of step 1 in the order above; the four switch-ons of step 2 follow, each when its count is zero.

**Numbering (old to new).** The single Phase 4 plan's parts 9i to 9n are 1a to 1f here, in the same order, and its 10b to 10e are 2a to 2d. Everything
else moved: its steps 1 to 8 and the lint plug-in (old 10a, now step 9) are in part 1, and its 9a to 9h are in part 2 (as 1a to 1h). Where this plan says "part 1's step 5", it means the old step 5.

**What "rolling" means here.** Each part is one change. Each change starts from a fresh list from the counter
(`npm run audit:ui-hints -- --list <rule>`, filtered by file), converts that area, and ends with
`npm run check:ui-hints -- --tighten`. The change description states the drop in plain numbers, for example "native
titles 216 → 208". A part is finished only when its files read zero for the strict rules (or carry a listed reason) and
the wording ledger passes. Progress is read from the guard's one-line summary.

---

## Step 1. D5 (tiers C and D): Proper hints, names and warnings on the rest of the app, one area at a time (M-L, rolling)

**For James:** the rest of the app gets the same treatment as the daily screens, one area per change: the conversation tools, side chat, source control,
settings, the shared dialogs and cards, and then every other folder, until the leftover list is empty. Each area is checked by hovering and by Tab. Anything a
hover used to warn about that matters becomes visible text instead.

Six parts here, one change each, in the order below (the backlog's Tier C is 1a to 1d, Tier D is 1e and 1f). **How every part is done is part 2's recipe (its
step 1), unchanged,** including its Phase 3 overlap rule and its "Done when, for every part" list; they are not repeated here. Needs part 1's steps 4 and 5. A part
that is still waiting for its Phase 2 or Phase 3 item, or for another session's files, is skipped for now.

**Expected record drops** (raw grep counts of native titles on 10 Oct; the counter's list is the authority):

| Part | Native titles to convert | Other rows expected to fall |
|---|---|---|
| 1a Conversation tools | about 21 plus the jump rail | |
| 1b Side chat | 7 | shortcut text −1 |
| 1c Source control | about 25 (17 + 6 + 2) | shortcut text −4 |
| 1d Settings (rest) | about 42 | |
| 1e Shared pieces and whole-card titles | about 22, plus 32 component-host titles | component-host rows −32 |
| 1f Everything else | the remainder, by the counter's folder table | role-less clickables −2 |

### 1a. The conversation tools (M)

**For James:** the find bar, the jump rail, the progress panel, the context bar and the context details panel get proper hints and names.

**Needs first:** nothing beyond part 1's step 5 and part 2's recipe. This is the first part here because it is on screen whenever a conversation is. The audit put it in Tier A; the approved
backlog's Tier A does not list it (part 2's choice 4).

**Verified (10 Oct):** find bar 3 titles (`transcript-find-bar.component.ts`, 218 lines); jump rail (`transcript-jump-rail.component.ts`, 524 lines; open the preview on
focus too); session progress panel 3 (`session-progress-panel.component.ts`, room 52); `instance-detail.component.html` 5, including the inspector toggle that still uses a
native `title` (`:253`, found by the Phase 2 check; `instance-detail.component.ts` room 53); context bar 4 (`context-bar.component.ts`, 330 lines);
`context-attribution-panel.component.ts` 6 (514 lines).

**Change:** the recipe on each file; the jump rail opens its preview on keyboard focus as well as hover. The five inspector toggles in
`instance-detail.component.html` (`:166`, `:186`, `:213`, `:233`, `:253`) are text buttons ("Tasks" and so on) that carry `[attr.aria-expanded]` for "the panel is open"
and an explanatory title, so each becomes `appTooltip` (the old text, verbatim) with `appTooltipShowWhenExpanded`.

**Tests / Live checks:** per the recipe (Windows PC).

### 1b. Side chat (S)

**For James:** the side chat panel's icon buttons get names and hints, and "Close panel" shows its real shortcut.

**Verified (10 Oct):** `side-chat-panel.component.html` has 7 titles and 0 tooltips (`:11`, `:23`, `:32`, `:39`, `:144`, `:239`, `:248`); `side-chat-panel.component.ts` has room 187.
The close button (`:35-41`) has `title="Close panel (⌥⌘S). Running sidechats keep going."` and `aria-label="Close sidechat panel; running sidechats keep going"`, so its name and
its hint differ, and the hint carries a reassurance the label does not show. Two more hints carry consequences: "Archive this sidechat (keeps history, removes it from the list)"
(`:144`) and "Stop this sidechat's answer (the main session is not affected)" (`:239`).

**Change:** buttons whose hint and name are the same words (for example "New sidechat", "Send") become `[appIconButton]`. The rest keep their `aria-label` and move the title to
`appTooltip` verbatim. For the close button, only the glyphs move: `appTooltip="Close panel. Running sidechats keep going."` plus `appTooltipShortcut="toggle-side-chat"`. The two
consequence sentences above move verbatim (they are ledger entries).

**Tests / Live checks:** per the recipe (Windows PC).

### 1c. Source control (M)

**For James:** the source control panel's buttons get proper hints. The hints about Command/Ctrl+Enter and Command/Shift-click show the right keys for your computer.

**Verified (10 Oct):** `source-control.component.html` 17 titles, `source-control-repo-actions.component.ts` 6 (625 lines, room 75),
`source-control-diff-viewer.component.ts` 2 titles and 1 tooltip (332 lines), plus two small files. The two chevrons have no hover (audit `:125`, `:214`). The
"⌘/⇧-click to multi-select" hints (`source-control.component.html:132`, `:222`) and "Commit staged changes (⌘+Enter)" (`source-control-repo-actions.component.ts:184`) are not
registry actions. The diff viewer's "Close (Esc)" (`source-control-diff-viewer.component.ts:67`) is a local key, the same on every platform.

**Change:**
1. Build the three non-registry hints from `modKeyLabel()`, not a typed glyph. Two are bound expressions in the template that join the file path with the tip (for
   example `source-control.component.html:139`, `[title]="file.path + ' — click to open diff · ⌘/⇧-click to multi-select · drag to …'"`, and `:230-231`), so each becomes
   a small method or computed in the component that composes the same words with the right key name. The commit button's "(⌘+Enter)" (`source-control-repo-actions.component.ts:189`,
   and the placeholder at `:169`) is built the same way.
2. The diff viewer's "Close (Esc)" stays literal. Its `local-key` marker was placed in part 1's step 4b, so the records already hold it; do not add a second one.
3. Give the chevrons names and hints.
4. Destructive actions in this panel (discard, revert) keep their visible consequence: check each.

**Tests / Live checks:** per the recipe. Windows PC: confirm the hints say Ctrl, not the Mac symbol.

### 1d. Settings: the shared row and the other tabs (M)

**For James:** each setting's description is read out with its control, and the rest of the Settings tabs get proper hints, one folder at a time.

**Verified (10 Oct):** `setting-row.component.ts` (349 lines, room 351): the control is already named by `<label [for]>`, so the gap is the description only. The stage pills
(`[appTooltip]="stageBadge.detail"` on non-focusable spans) are allowed elaborations. `features/settings` has 45 raw titles on 10 Oct (3 are done in part 2's 1a).
`provider-accounts-tab.component.ts` (+110 lines) and the untracked `provider-accounts-machines.ts` belong to another session.

**Change:** give the description paragraph an id and each control `aria-describedby`; keep the stage pills as reasoned elaborations; then the other tabs, folder by folder.
Do the provider-accounts tab after the other session commits. Wiring `SettingMetadata.dependsOn` (declared at `settings-metadata.types.ts:51-65`, used by nothing) is not in this plan.

**Tests / Live checks:** per the recipe (Windows PC).

### 1e. Shared pieces, and the whole-card titles (S-M)

**For James:** the close buttons on dialogs and the small shared pieces get proper hints, and six shared cards and dialogs stop showing their heading as an accidental grey
bubble over the whole card, if they do today.

**Verified (10 Oct):**
- Shared components multiply: `prompt-modal` close (5 consumers; `prompt-modal.component.ts`, 324 lines), `remote-browse-modal` close (624 lines, room 76), the `menu-item`
  chevron (`menu-item.component.ts:57`), `image-lightbox`; and the Help pane's own two native titles (`shared/help/help-pane.component.html:7`, `:26`). `shared/components`
  has 20 raw titles on 10 Oct.
- **The 32 component-host titles** (see part 1's step 1): `<app-empty-state>` 13, `<app-task-preflight-card>` 6, `<app-prompt-modal>` 5, `<app-settings-card>` 4,
  `<app-danger-zone>` 3, `<app-page-header>` 1. Each component declares `title` as an `input()`, so Angular writes the static ones onto the host as a DOM attribute (inferred; not
  seen in a browser).

**Change:**
1. Convert the shared components' own hover titles by the recipe.
2. Rename the `title` input of the six components to `heading`, in the component, every template use (32 sites) and their specs. The record's component-host row goes from 32 to 0.
3. Convert the Help pane's two titles.

**Tests:** each component's spec uses `heading`; a spec for each of the six renders without a DOM `title` attribute on the host.

**Risks:** a wide mechanical edit (32 sites across many templates). It is safe because the compiler fails on a missed rename under `strictTemplates`.

**Live checks:** (Windows PC) first, before the rename, record whether a grey bubble appears over an empty-state card heading today (live check 7 of part 1's step 1). After it, none does.

### 1f. Everything else, folder by folder (L, rolling)

**For James:** the rest of the app gets the same treatment, one folder at a time, until the leftover list is empty. Each folder is its own change.

**Verified (10 Oct):**
- The counter's per-folder table (`npm run audit:ui-hints`) is the worklist, shared components done in 1e, largest first after that. Raw title counts by top-level folder on
  10 Oct (grep, before part 2's parts and 1a to 1e here): `features/instance-detail` 93 (the composer, header and conversation tools above take most), `features/settings` 45,
  `features/source-control` 26, `features/instance-list` 24, `shared/components` 20, `features/dashboard` 16, `features/campaign` 14, `features/verification` 11,
  `features/loop` 11, `features/snapshots` 10, `features/codebase` 10, `features/automations` 9, `features/models` 8, `features/side-chat` 7, `features/cost` 7, `core` 7, then about 25
  folders with 1 to 5 each. (The audit's roughly 180 remaining after Tiers A to C is arithmetic, not a fresh count.)
- The verification folder holds 10 icon-only controls with no hover, including the destructive "Delete session ×" (`features/verification/dashboard/verification-dashboard.component.html:309`,
  which has an `aria-label` and no hint or visible consequence), and 26 unnamed inputs (audit evidence).
- Three role-less clickable elements are gated: `features/overlay/overlay-shell.component.ts:65` and `features/verification/shared/components/agent-card.component.ts:25` need a role and
  keyboard handling; the diff-viewer backdrop is marked in part 1's 4b.
- The permission card still has a native `title` on its YOLO button (`features/instance-detail/user-action-request.component.html:277`, "Enable YOLO mode to auto-approve all permissions
  for this session"; found by the Phase 1 check). That sentence carries consequence words, so it is a ledger entry: keep the words, or retire the entry with a reason when Phase 3's C8
  renames YOLO. Phase 0 step 4 also edits this card.
- The browser-approvals banner's name-only close button (`core/state/browser-approvals-banner.component.ts:158`) sits in files another session is editing: wait.

**Change:** one change per folder, by the recipe. The verification folder's "Delete session ×" gets a hint and a visible consequence or a confirm (house rule 2).

**Done when (for the whole of this step, which is also the end of Phase 4's migration):** the counter shows zero for H1a, H1b, H2a, H2b, H2c, H3, H5, H6 and H10 across the whole tree, H4 holds only reasoned entries, and H11 stays at 7. The unreadable-hover count is no higher than at 4c. The wording
ledger passes with no entry retired except by a deliberate, reasoned `--retire`.

**Live checks:** per folder (Windows PC), by the recipe.

---

## Step 2. D10 (second half): Switch the lint rules on, one by one, as the counts reach zero (XS each)

**For James:** nothing changes on screen. As each leftover count reaches zero, the matching style-check rule is switched on, so the editor and the lint check flag
that mistake from then on.

Four one-line changes, each made only when its count in the record reaches zero. The plug-in and the test that forces each switch-on are part 1's step 9. **This
step cannot finish until step 1 here and part 2 have emptied the counts it switches on**; that is why it is last. The change that takes a total to zero includes the
switch-on in the same sitting, because part 1's link test goes red until the severity is set.

### 2a. Switch on the shortcut rule (XS)

**For James:** nothing changes on screen. From now on, typing a Mac key symbol or "Ctrl+" into a hover hint is flagged in the editor and in the lint check.

**Change:** set `ui-hints/no-hardcoded-shortcut` to `error` in `eslint.config.js`. **When:** the guard's H5 total is 0 (part 1's step 5c; part 2's 1b, 1d and 1e; and 1b and 1c here).

**Done when:** `npm run check:ui-hints` shows H5 = 0, `npm run lint` is green, the link test is green, and adding `appTooltip="Save (⌘S)"` to a button in a
scratch template makes `npm run lint` print `ui-hints/no-hardcoded-shortcut` at the right line (revert afterwards).

### 2b. Switch on the native-title rule for controls (XS)

**For James:** nothing changes on screen. A browser-style hover hint attribute on a button or other control is flagged as it is typed.

**Change:** set `ui-hints/no-native-title` to `["error", { scope: "controls" }]`. **When:** the guard's H2a total is 0.

**Done when:** H2a = 0, `npm run lint` is green, and adding `title="x"` to a `<button>` in a scratch template makes `npm run lint` print `ui-hints/no-native-title` at
the right line (revert afterwards).

### 2c. Switch on the icon-control rule (XS)

**For James:** nothing changes on screen. An icon-only button with no name or no tooltip is flagged as it is typed.

**Change:** set `ui-hints/icon-control-needs-name-and-tooltip` to `error`. **When:** the guard's H1a and H1b totals are both 0.

**Done when:** H1a and H1b = 0, `npm run lint` is green, and adding `<button type="button"><svg></svg></button>` to a scratch template makes `npm run lint` print
`ui-hints/icon-control-needs-name-and-tooltip` at the right line (revert afterwards).

### 2d. Widen the native-title rule to every element (XS)

**For James:** nothing changes on screen. A hover hint attribute on any element, including the six shared cards, is flagged. After this, part 1's bridge no longer has any
template titles left to show; it stays for the seven transcript HTML strings.

**Change:** set the `no-native-title` option to `scope: "all"`. **When:** the guard's H2a, H2b and H2c totals are all 0 (1e here renames the component-host inputs).

**Done when:** H2a, H2b and H2c = 0, `npm run lint` is green, and adding `title="x"` to a `<div>` in a scratch template makes `npm run lint` print
`ui-hints/no-native-title` at the right line (revert afterwards).

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
`npm run audit:ui-hints` prints the honest counts; paste its summary into the as-built notes after each tier (tier C is 1a to 1d, tier D is 1e and 1f), and after each
lint switch-on.

**Fresh-eyes completion gate.** Before calling this plan complete:
1. A fresh agent that did no implementation work runs the `task-completion-gate` skill over this plan's changes, this plan and the backlog items.
2. Fix every actionable finding, rerun the checks, and send the work to another fresh review.
3. Repeat until it returns `VERDICT: PASS`.

Because the migration is rolling and a lost warning is its main risk, also run the gate at the end of each tier here (C, then D) and brief that reviewer to compare the
saved old hover wording (`git show HEAD:<path>`) with the new. Brief every reviewer on James's rules: no branches or worktrees, no browser on the Mac, preserve
other sessions' uncommitted work, and no secrets.

## Live checks

These need the rebuilt app, a person, or the Windows PC. They are listed under each part. When the code is done, move them into
`docs/plans/2026-10-10-oct-phase4c-tooltips-finish_livetest.md` with the standard header:
- prerequisites (rebuild, restart, and which instance);
- a link back to this plan;
- the remediation-flow paragraph pointing at `livetest-campaign-runbook.md` and `livetest-remediation-register.md`.

Then leave a one-line pointer here. Screen checks run on the Windows PC, or on the Mac only with James's OK. Step 1's live checks are recorded per part as each part
finishes, because this plan stays open until the last part. Step 2's checks need only a person with an editor (optional). The livetest doc is itself a plan: it is
renamed `_livetest_completed.md` only when every check passes with evidence.

## Not in this plan (and where it goes)

- **Deleting part 1's bridge.** It needs the native-title counts at zero everywhere and the seven transcript HTML strings (see part 1's "Not in this plan") moved to
  something the bridge also reads. After 2d, the bridge has no template titles left to show; it stays for those seven strings.
- **Wiring `SettingMetadata.dependsOn` into setting rows** (declared at `settings-metadata.types.ts:51-65`, used by nothing): needs a first setting that declares one; a Settings
  follow-up.
- **A rule for unnamed form fields:** the audit counted 26 unnamed inputs in the verification pages (1f). The counter prints a number; nothing gates it (see part 1's "Not in this plan").
- **A hover card in the model picker (`appTooltipTpl`).** Phase 1's check (A9) handed this to D4 and D5 "once Phase 0 step 5 is in". It is a new feature, not a migration, and `appTooltipTpl`
  has no uses today. A follow-up after the models folder in 1f (the October follow-ups plan, part 8d, item 7).
- **Hover styles for `aria-disabled` controls in each adopter's own stylesheet:** done per adoption, as in part 2, not globally.
- **ESLint bulk suppressions, and per-folder lint switch-on:** see part 1's choice 12.
- Pieces this plan leaves to nobody are collected in the October follow-ups plan (`2026-10-11-oct-followups_plan.md`), with a one-line list for the small or conditional ones.

## Found on the way (not fixed here)

1. **No rule gates unnamed form fields** (see Not in this plan): the verification pages hold 26 unnamed inputs (1f).

## Corrections to the backlog

- **"The audit's roughly 180 remaining after Tiers A to C"** is arithmetic, not a fresh count; the counter's per-folder table is the worklist (1f).
- **A figure in a report:** `session-progress-panel.component.ts` has 52 lines of room under the size ratchet (ceiling 747 + 50 − 745), not 2.

## Finishing

1. Every part is implemented, every gate passes, and the fresh-eyes gate returns PASS (including at the end of tier C and tier D). Step 1's last part (1f) is done when
   the counter shows zero for the strict rules (see 1f), and step 2 is done when 2a to 2d have all been switched on. This is the one part that stays open until then: the
   records stay in place and only go down. If James chooses to close this part earlier, the unfinished folders of 1f and the lint switch-ons 2a to 2d move to a follow-up
   plan with a new date; never add scope to this file after it is `_completed`.
2. Create the livetest doc `docs/plans/2026-10-10-oct-phase4c-tooltips-finish_livetest.md` and move the live checks into it.
3. Update this plan's status line and as-built notes. Rename this plan `2026-10-10-oct-phase4c-tooltips-finish_plan_completed.md` **last**.
4. In `claude_oct-todo.md`, mark D5 and D10 done and link to the completed plan.
5. Commit only when James asks. Stage only this plan's code and the `_completed` plan (the livetest doc stays untracked until it is renamed `_livetest_completed`, because the commit hook refuses an open one); never other sessions' work. Before every commit, inspect the
   staged paths and unstage any plan or spec that is not `_completed`.

## As-built notes

### Verification-round-6 dependency-install repair (12 Oct 2026)

- **Finding 2: dependency-provenance defect repaired; full-suite acceptance still pending.** Reproduced the exact failure with the unchanged `scripts/__tests__/dependency-compatibility.spec.ts`: 1 of 5 tests failed, exit 1, because both root manifests differ from this worktree's. RED summary: `_scratch/phase4c-round6/dependency-red.log`; full log: `_scratch/test-run.pid-60174.log`. Read the entire spec and `docs/testing.md`; the guard intentionally fails closed when a linked install's owner has different manifests. No test, classifier or assertion was changed.
- Moved this worktree's per-entry linked `node_modules` aside, then ran `rtk npm ci --ignore-scripts --no-audit --no-fund`, exit 0 (`_scratch/phase4c-round6/npm-ci.log`). Skipped lifecycle scripts to avoid the project postinstall's shared Git-hook and global-ignore writes. Ran `rtk npm rebuild esbuild electron better-sqlite3 node-pty @parcel/watcher lmdb msgpackr-extract electron-winstaller --no-audit --no-fund`, exit 0 (`dependency-rebuild.log`), followed by the documented `rtk npm run rebuild:native`, exit 0 (`native-electron.log`). `rtk proxy node scripts/verify-native-abi.js` exits 0 and confirms better-sqlite3 ABI 143 matches locked Electron 40.10.6 (`native-abi.log`). The install marker, TypeScript, Vitest, Electron and better-sqlite3 now resolve inside this worktree and are not root-checkout links. The superseded link directory was removed after verification; root dependencies and both worktree manifests remain unchanged.
- **Current focused verification, all exit 0:** dependency compatibility, setting-row, settings-tiered-row-list, jump-rail accessibility/component/markers, tooltip policy/directive and icon-control tests: **9 files / 149 tests**. This includes all five dependency-compatibility tests, with the formerly failing production-tree check now passing. Summary: `_scratch/phase4c-round6/targeted-tests.log`; full test log: `_scratch/test-run.pid-16892.log`. `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk proxy npm run check:ts-max-loc`, `rtk proxy npm run build:main`, `rtk proxy npm run build:renderer` and `rtk git diff --check` all exit 0. Static/build logs: `_scratch/phase4c-round6/{typecheck,typecheck-spec,lint,loc,build-main,build-renderer}.log`; size warnings remain within existing tolerance. The worker did not run the full suite, as explicitly required by the queue brief. These checks validate the existing subsets and repaired install, not the unimplemented migrations.
- **Finding 1: unresolved, with current dependency evidence.** Started clean at checkpoint `33f64da8f`, base `main` at `4d175e55b`; the merge-base-to-HEAD diff still contains only the four committed subset files, +278/-5. Read this complete root-checkout plan, Part 2's mandatory recipe and current status, Part 1's remediation records, the manifest, lint config, current tooltip directive and architecture/testing/native-module runbooks. No separate spec is linked. `scripts/ui-hints/` is absent; searching the tooltip directory, manifest and ESLint config for `appTooltipShortcut`, `appTooltipDisabledReason`, `appTooltipShowWhenExpanded`, `visibleTextOf`, `appIconButton` and `ui-hints` has no matches (exit 1). Foundation checkpoint `165417296` is not an ancestor (exit 1). Both executable preflights still exit 1 with `Missing script`: `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints`. Logs: `_scratch/phase4c-round6/{hint-audit,hint-guard}.log`. These failures cannot establish a worklist, preserved wording or zero totals.
- Fresh read-only `plan_queue_status` confirms Part 1 item `a6a27c49-0df2-45f1-b81e-83eb621b2e67` is parked, round 2, `PASS`, no findings, `land-blocked` on root `package.json`. Part 2 item `0053e038-f171-437a-94be-cd7aad0b85c5` is parked, round 3, `verifier-unreliable`; its plan still records 0 of 8 migrations. This item is fixing in round 6 with the supplied two findings. Root status confirms unrelated modifications to both manifests and `??` for this plan; those root modifications were preserved. The control schema still permits the originating session to resume items; its rescue exception excludes queue-spawned workers. No queue-control mutation was attempted.
- **Ruling and required recovery:** retain the measured migration recipe and AIO integration ownership. Do not copy/recreate the separately owned foundation, manually merge/promote it, edit unrelated root manifests or turn on absent lint rules without zero-count evidence. The parent session must reconcile the root collision preserving unrelated work, land Part 1 through AIO, complete and land Part 2 through AIO, and refresh this supplied checkout through AIO. Recheck the actual APIs, tooling and prerequisite migrations before continuing. Further completion-verifier retries against this prerequisite-free checkout cannot repair Finding 1. Missing source dependencies do not qualify for live-test deferral.
- **Actual checklist:** 1a partial (keyboard previews); 1b open; 1c open; 1d partial (control descriptions); 1e open; 1f open; 2a open; 2b open; 2c open; 2d open. Existing subset live checks remain pending in the existing livetest document. Only this root-checkout plan and ignored local dependency/build/evidence artifacts changed in this round; no tracked source, tests, generators, baseline/wording records or completion flags changed. No commit, staging, stash, branch/worktree change, browser/desktop action, app setting or database write occurred. **One of two verifier findings repaired locally; 0 of 10 complete plan parts. This remains a dependency-blocked handoff.**

### Verification-round-5 dependency recheck (12 Oct 2026)

- **Both supplied findings remain unresolved.** The clean assigned checkout is still checkpoint `33f64da8f` against `main` at `4d175e55b`; `git diff main...HEAD --stat` reports only the four existing subset files, +278/-5. Read the entire root-checkout plan, current prerequisite execution records, Part 2's mandatory recipe, repository instructions and current tooltip directive. No separate spec is linked. No implementation was repeated.
- Current filesystem and source checks confirm `scripts/ui-hints/` is absent and the required foundation APIs/plug-in have no matches in the tooltip directory, manifest or ESLint configuration (search exit 1). Foundation checkpoint `165417296` remains outside HEAD's ancestry (exit 1). `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` both fail with `Missing script`, exit 1. Logs: `_scratch/phase4c-round5/{hint-audit,hint-guard}.log`. These failures provide no count or wording-preservation evidence.
- Fresh read-only `plan_queue_status` confirms Part 1 is parked at round 2 with `PASS`, no findings, `land-blocked` on root `package.json`; Part 2 is parked at round 3 with `verifier-unreliable`. Part 2's current plan still records 0 of 8 migrations. This item is `fixing`, round 5, with the two supplied findings. Root status confirms ` M package.json` and this plan's `??` visibility.
- **Ruling:** retain the measured migration contract and AIO integration ownership. The recipe requires the absent counter before editing and the absent ratchet/ledger afterwards; Step 2 also requires the absent plug-in and Part 2's whole-tree reductions. Copying parked work or manually integrating it would bypass AIO ownership. The discovered control schema permits the originating session to resume items; its rescue exception excludes queue-spawned workers. No control mutation was attempted. Cost: this worker cannot repair the prerequisite integration boundary, and unchanged completion-verifier retries will reproduce both findings.
- **Required recovery before another worker/verifier round:** the originating session reconciles the root `package.json` collision while preserving unrelated changes, has AIO land Part 1, completes and lands Part 2 through AIO, and has AIO refresh this assigned checkout. Confirm actual APIs, scripts, records and prerequisite migrations before continuing. Missing source dependencies are not eligible for live-test deferral.
- **Current subset checks, all exit 0:** six focused setting-row/settings-tiered-row-list/jump-rail/tooltip-policy files, **116 tests**; `rtk npx tsc --noEmit`; `rtk npm run typecheck:spec`; `rtk npm run lint`; `rtk git diff --check`. Logs: `_scratch/phase4c-round5/{targeted-tests,typecheck,typecheck-spec,lint}.log`; full test log `_scratch/test-run.pid-80386.log`. No full suite was run, per the worker brief. These checks verify the existing subsets only.
- **Checklist:** 1a partial (keyboard preview); 1b open; 1c open; 1d partial (control descriptions); 1e open; 1f open; 2a open; 2b open; 2c open; 2d open. Existing subset live checks remain pending. Only this root-checkout plan changed; code, tests, generators, count/wording records and completion flags are unchanged. No commit, staging, stash, branch/worktree change, browser/desktop action, settings or database write occurred. **0 of 10 complete parts; blocked, not ready for completion verification.**

### Verification-round-4 dependency recheck (12 Oct 2026)

- Started from the existing clean checkpoint `33f64da8f`, base `main` at `4d175e55b`; `git diff main...HEAD --stat` still reports four subset files, +278/-5. No implementation was restarted or repeated. Read the plan at its root-checkout absolute path, the dependency plans' current execution/status records, Part 2's migration recipe, and the actual manifest, ESLint configuration and tooltip directive. There is no separate linked spec.
- **Finding 1: unresolved.** The required `scripts/ui-hints/` directory is absent; the directive/manifest/config search for `appTooltipShortcut`, `appTooltipDisabledReason`, `appTooltipShowWhenExpanded`, `visibleTextOf`, `appIconButton` and `ui-hints` has no matches (exit 1). Foundation checkpoint `165417296` is not an ancestor of HEAD (exit 1). Both executable preflights fail, exit 1: `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints`, each reporting `Missing script`. Logs: `_scratch/phase4c-round4/{hint-audit,hint-guard}.log`. These failures cannot supply the worklist, wording ledger or zero-count evidence required for any migration/lint switch-on.
- **Finding 2: prerequisite defect unresolved; rename requirement rejected under the current worker instructions.** Fresh read-only `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` confirms Part 1 parked, round 2, `PASS`, no findings, `land-blocked` on root `package.json`; Part 2 parked, round 3, `verifier-unreliable`. Part 2's current plan records 0 of 8 migration parts. This item is `fixing`, round 4, `FAIL`, with both supplied findings. Root Git status independently confirms ` M package.json` and the plan's `??` visibility. The worker brief explicitly says “Never rename your document to a `_completed` name. The coordinator does that after an independent verifier passes the work.” Keeping the active filename is required, and changing it would not repair the missing implementation.
- **Ruling:** preserve AIO integration ownership and the measured migration recipe. Do not copy or recreate the separately parked foundation, manually merge/promote it, overwrite root changes, or enable absent rules without zero totals. The current control-tool schema allows only the originating session to resume items; its stranded-run rescue excludes queue-spawned workers. No control mutation was attempted. Cost: the remaining implementation stays blocked until the coordinator supplies prerequisites; another unchanged verifier round will reproduce the same defects.
- **Required recovery:** the originating session reconciles the root `package.json` collision while preserving unrelated work, has AIO land Part 1, completes and lands Part 2 through AIO, and has AIO refresh this assigned checkout. Confirm actual foundation APIs, records and prerequisite migrations before resuming. This is a source/integration dependency, not a human-only live check or a new approval requirement.
- **Current subset verification, all exit 0:** setting-row, settings-tiered-row-list, jump-rail accessibility/component/markers and tooltip-policy tests pass **6 files / 116 tests**; `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint` and `rtk git diff --check` pass. Logs: `_scratch/phase4c-round4/{targeted-tests,typecheck,typecheck-spec,lint}.log`; full test output `_scratch/test-run.pid-16343.log`. No full suite was run, as instructed. These checks certify the existing subsets only; no new build or whole-plan PASS is claimed.
- **Checklist:** 1a partial (keyboard preview implemented); 1b open; 1c open; 1d partial (control descriptions implemented); 1e open; 1f open; 2a, 2b, 2c and 2d open. Existing subset live checks remain pending. Only this root-checkout plan changed; code, tests, generated files, baselines, wording records, completion flags and the existing livetest document are unchanged. No commits, staging, stashes, branch/worktree changes, browser/desktop actions, settings or database writes. **0 of 10 complete parts; not ready for completion verification.**

### Verification-round-3 dependency recheck (12 Oct 2026)

- **Finding 1 remains unresolved; 0 of 10 complete parts.** Resumed checkpoint `33f64da8f2cd665762a6e5c010c1bb68a2b4feab` against base `main` at `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`. The merge-base-to-HEAD diff still comprises four subset files, +278/-5. The supplied worktree started clean. The verifier correctly identifies unimplemented migrations and lint switch-ons; passing subset checks do not satisfy their acceptance criteria.
- Read this entire plan at its root-checkout absolute path, the actual manifest/ESLint/tooltip directive, Part 2's mandatory migration recipe and current status, and Part 1's execution/remediation records. No separate spec is linked. Current filesystem inspection confirms `scripts/ui-hints/` is absent. A targeted search of `src/renderer/app/shared/tooltip/`, `package.json` and `eslint.config.js` for the foundation APIs and plug-in returns no matches, exit 1. The foundation checkpoint `165417296` is still not an ancestor of HEAD (`git merge-base --is-ancestor`, exit 1).
- **Fresh read-only coordinator evidence:** `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` reports Part 1 parked at round 2 with `PASS`, no findings, and `land-blocked`: `root checkout has uncommitted changes to a promoted path: package.json`. Part 2 remains parked at round 3 with `verifier-unreliable`; its own current status records 0 of 8 migration parts implemented. This item is `fixing`, round 3, with the supplied critical finding. Root Git status independently confirms ` M package.json` and `?? docs/plans/2026-10-10-oct-phase4c-tooltips-finish_plan.md`; unrelated work was preserved.
- **Required preflights fail now:** `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1, `Missing script`. Retained summaries: `_scratch/phase4c-round3/{hint-audit,hint-guard}.log`. npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_37_48_830Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_37_48_831Z-debug-0.log`. No count reduction or zero-total evidence can be obtained from these failed commands.
- **Ruling:** retain the measured-migration contract and AIO ownership. Do not duplicate the parked foundation, copy its implementation, manually integrate it, alter root package changes, or enable lint rules without their plug-in and zero-count evidence. This is a confirmed implementation/lifecycle dependency, not an old approval note. Cost: the remaining parts cannot proceed until AIO supplies the prerequisites. The current `plan_queue_control` schema restricts mutations to the originating session, and its rescue exception excludes queue-spawned workers. No mutation was attempted.
- **Required coordinator recovery:** reconcile the root `package.json` collision while preserving other work; land the PASS foundation through AIO; complete and land Part 2 through AIO; refresh this supplied checkout through AIO. Recheck actual APIs, scripts, records and earlier-phase overlaps before resuming the remaining parts. Sending the same unchanged checkout to another completion-verifier round cannot remove the dependency.
- **Safe current verification, all exit 0:** the setting-row, settings-tiered-row-list, jump-rail accessibility/component/markers and tooltip-policy specs pass **6 files / 116 tests**; `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint` and `rtk git diff --check` pass. Logs: `_scratch/phase4c-round3/{targeted-tests,typecheck,typecheck-spec,lint}.log`; full test log `_scratch/test-run.pid-56792.log`. These verify the existing subsets only. No full suite was run, per the worker brief; no new build or whole-plan independent PASS is claimed.
- Only this root-checkout plan changed. Its active filename and untracked visibility are preserved. No code, tests, generated files, count/wording records, completion flags, commits, staging, stashes, branches, worktrees, browser sessions, app settings or databases changed. Existing subset live checks remain pending. Missing source prerequisites cannot be deferred into a livetest document. **1a and 1d remain partial; 1b, 1c, 1e, 1f and 2a–2d remain open. This is a blocked worker handoff, not readiness for completion verification.**

### Verification-round-2 dependency recheck (12 Oct 2026)

- **Finding 1 remains unresolved: 0 of 10 parts complete.** Resumed the coordinator's committed checkpoint, not an empty branch: `HEAD` is `33f64da8f2cd665762a6e5c010c1bb68a2b4feab`, `main` is `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`, and `git diff main...HEAD --stat` reports the four existing subset files, +278/-5. The assigned worktree started clean and remains clean. No subset implementation was repeated.
- Re-read this root-checkout plan, Part 2's migration recipe and current dependency status, Part 1's execution/remediation records, the actual tooltip directive, lint configuration and the committed production diff. There is no separate linked spec. The required `scripts/ui-hints/` directory is absent. Searching the correct directive directory (`src/renderer/app/shared/tooltip/`), `eslint.config.js` and `package.json` for `appTooltipShortcut`, `appTooltipDisabledReason`, `appTooltipShowWhenExpanded`, `visibleTextOf`, `appIconButton` and `ui-hints` returns no matches (exit 1). `git merge-base --is-ancestor 165417296 HEAD` exits 1. The foundation is still absent from this checkout.
- **Current coordinator evidence, not an inferred waiting/approval requirement:** read-only `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` reports Part 1 item `a6a27c49-0df2-45f1-b81e-83eb621b2e67` parked, round 2, `PASS`, no findings, `land-blocked`, detail `root checkout has uncommitted changes to a promoted path: package.json`. Part 2 item `0053e038-f171-437a-94be-cd7aad0b85c5` remains parked, round 3, `verifier-unreliable`; its plan still reports 0 of 8 migrations. This item is `fixing`, round 2, `FAIL`, with the exact critical finding supplied to this worker. Root Git status independently confirms ` M package.json`; that unrelated work was preserved.
- Executable preflights still fail: `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` each exit 1, `Missing script`. Retained evidence: this worktree's `_scratch/phase4c-round2/{hint-audit,hint-guard}.log`; npm logs `/Users/suas/.npm/_logs/2026-10-12T05_34_27_076Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_34_27_082Z-debug-0.log`. These are failed acceptance preflights, not zero counts.
- **Ruling:** do not turn a lifecycle boundary into a duplicate foundation implementation or an unmeasured title migration. Part 2's required recipe starts with the missing source counter and ends with the missing ratchet/wording ledger. The four lint switch-ons additionally require the absent plug-in and the whole-tree reductions from Part 2. The current AIO-managed-worktree instruction explicitly reserves integration to AIO and prohibits manual merge/promotion or bypassing its metadata. The discovered `plan_queue_control` schema permits control only by the originating session; its rescue exception excludes queue-spawned workers. No control mutation, root package edit, copied parked implementation or manual integration was attempted. No new permission question is needed to establish this dependency.
- **Required recovery before another completion-verifier round:** the parent reconciles the root `package.json` collision while preserving unrelated changes, has AIO land the already-PASS foundation, completes and lands Part 2 through AIO, and has AIO refresh this supplied checkout. Confirm actual runtime APIs, counter/ledger scripts and prerequisite migration contents before resuming 1a–1f and 2a–2d. Re-running this worker or a completion verifier against the same prerequisite-free checkout cannot repair the collision.
- **Safe subset checks rerun, all exit 0:** setting-row, settings-tiered-row-list, jump-rail accessibility/component/markers and shared tooltip-policy specs: **6 files / 116 tests**; `rtk npx tsc --noEmit`; `rtk npm run typecheck:spec`; `rtk npm run lint`; `rtk git diff --check`. Retained summaries: `_scratch/phase4c-round2/{targeted-tests,typecheck,typecheck-spec,lint}.log`; full test log `_scratch/test-run.pid-52069.log`. These results verify the existing committed subsets only. No full suite was run, as required by the queue worker brief; no new build or whole-plan independent PASS is claimed.
- All ten enclosing parts retain their actual statuses in the table below: 1a and 1d partial; 1b, 1c, 1e, 1f and 2a–2d open. Only this root-checkout plan was edited in this round; it retains its active filename and `??` visibility. No code, test, generator, count/wording record, backlog completion flag, commit, stash, branch, worktree, browser session, app setting or database was changed. The existing subset livetest document remains pending. Missing agent-runnable prerequisites are not eligible for live-test deferral. **This turn reports an unresolved dependency blocker, not readiness for implementation verification.**

### Verification-round-1 remediation (12 Oct 2026)

- Re-read the plan at its root-checkout path, both prerequisite plans, Part 2's recipe, architecture and Angular conventions. The historical diff is still empty (`HEAD` and `main` are `4d175e55bc5b43121437e9884eddc2d2ebf84b9f`); the implementation in this round is deliberately uncommitted under the worker instruction. There is no separate linked spec.
- Current `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` still reports Part 1 parked with `PASS` / `land-blocked` on root `package.json`; Part 2 parked with `verifier-unreliable`, round 3. Root status still shows ` M package.json`, preserved. `plan_queue_control` remains restricted to the parent session; no queue mutation or manual promotion was attempted. Actual preflights `rtk npm run audit:ui-hints -- --list H2a` and `rtk npm run check:ui-hints` both exit 1, `Missing script`. npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_20_20_390Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_20_20_695Z-debug-0.log`.
- Ruling revises the earlier all-or-nothing implementation decision: the two independent accessibility requirements below can safely run without moving native hover text, using absent foundation APIs, changing another item's files, or bypassing AIO integration. Implement them now; keep their enclosing migration parts open. All old hover strings, warning wording, shortcut text, count/ledger records and lint severities are unchanged. No zero-count result is claimed.
- **1a subset:** `transcript-jump-rail.component.ts` opens the existing prompt/reply/files preview immediately on keyboard focus, closes on blur/Escape, adds a tooltip role and per-instance description id, and highlights keyboard-focused ticks. Pointer leave keeps a keyboard-focused preview open; pending hover timers cannot overwrite it. Focus follows message identity instead of array index when older history is prepended. The shared `shouldOpenOnFocus` policy excludes incidental pointer focus; pointer-down clears keyboard preview state when switching back to pointer interaction. A reactive cleanup clears orphaned focus when its prompt or rail disappears (DOM removal does not fire blur). DOM tests exercise actual focus/blur/keyboard events and history changes; existing hover, jump and marker tests remain intact. Native-title conversions and the other conversation controls remain open.
- **1d subset:** `setting-row.component.ts` gives the existing description a setting-key-derived id and connects all seven input variants, directory Browse and Reset with `aria-describedby`. References update when a row's setting changes. Stage-pill elaborations and existing accessible names remain unchanged; no `dependsOn` control behaviour was added. Parameterized DOM regressions cover all seven setting types, every control including multi-select options, and row reuse. Other Settings-tab migrations remain open.
- RED evidence before implementation: `_scratch/phase4c-round1/red-tests.log`, full `_scratch/test-run.pid-13724.log`: 11 new tests fail against the base because descriptions have no id and focus has no preview; 20 existing tests pass. A further history-prepend test failed (`First prompt` instead of `Second prompt`) in `_scratch/phase4c-round1/red-prepend.log`, full `_scratch/test-run.pid-15816.log`; tracking focused message identity fixes it.
- Initial targeted verification: `rtk npm run test:quiet -- src/renderer/app/features/settings/setting-row.component.spec.ts src/renderer/app/features/settings/settings-tiered-row-list.component.spec.ts src/renderer/app/features/instance-detail/transcript-jump-rail.accessibility.spec.ts src/renderer/app/features/instance-detail/transcript-jump-rail.component.spec.ts src/renderer/app/features/instance-detail/transcript-jump-rail.markers.spec.ts` exits 0, **5 files / 88 tests pass**. Summary `_scratch/phase4c-round1/targeted-tests.log`; full `_scratch/test-run.pid-16279.log`. The final post-review-fix run adds the shared tooltip policy spec and removal/pointer regressions: **6 files / 116 tests pass**, exit 0; `_scratch/phase4c-round1/targeted-tests-final.log`, full `_scratch/test-run.pid-38094.log`.
- Static and build gates rerun after the final code change, all exit 0: `rtk npx tsc --noEmit`, `rtk npm run typecheck:spec`, `rtk npm run lint`, `rtk npm run check:ts-max-loc`, `rtk npm run build:main`, `rtk npm run build:renderer`. Current logs: `_scratch/phase4c-round1/{typecheck,typecheck-spec,lint,loc,build-main,build-renderer}-final.log`. Size-check warnings are existing files within tolerance. No full suite was run: the worker brief explicitly reserves it for the verifier. No IPC, aliases or generated tracked files changed.
- First fresh independent subset review returned `VERDICT: FAIL` with two Medium actionable findings: orphaned focused-message state suppressed all hover after DOM removal, and incidental pointer focus pinned a keyboard preview. The reviewer independently reproduced both with Angular/jsdom and reran 3 focused files / 51 tests, typecheck and diff whitespace checks. New regression tests reproduced both findings before fixes: `_scratch/phase4c-round1/red-orphan-focus.log` (2 failing tests / full `_scratch/test-run.pid-24944.log`) and `red-pointer-focus.log` (3 failing tests / full `_scratch/test-run.pid-26153.log`). The fixes are described in the 1a subset entry above. An additional transition, clicking an already keyboard-focused tick, failed before the pointer-down fix (`red-modality-switch.log`, full `_scratch/test-run.pid-36569.log`). Test investigation logged that jsdom returned `:focus-visible = false` without a Tab event (`diagnose-prepend.log`, full `_scratch/test-run.pid-30450.log`); the DOM keyboard tests now dispatch Tab before focus instead of assuming a programmatic `.focus()` represents keyboard input. Temporary diagnostic logging was removed. The pointer-focus test supplies only the browser's `:focus-visible = false` answer because jsdom cannot infer that pointer modality; production policy is unchanged. Another genuinely fresh review is required before accepting the subset. A subset review cannot certify this overall plan until the prerequisite migrations and strict zero-count requirements are satisfied.
- Second genuinely fresh independent reviewer returned **`VERDICT: PASS — implemented subsets only`**, with no unresolved actionable findings. It reviewed the historical range plus all working-tree modifications and the untracked DOM spec, independently reran **6 files / 116 tests**, `rtk npx tsc --noEmit`, `rtk npm run lint` and `rtk git diff --check` (all exit 0), and inspected current build/spec-typecheck/size logs. Independent full test log: `_scratch/test-run.pid-43748.log`. It confirmed additive test integrity, stable focus identity, cleanup, pointer modality, hover-timer precedence and all seven setting variants with Browse/Reset/reuse. It explicitly declined whole-plan completion: native-title migrations, strict totals, four lint switch-ons, full suite and Windows/screen-reader checks remain unverified. The subset fix/review cycle is closed; the whole-plan gate remains open.
- Remaining coordination action is unchanged: the parent reconciles its root collision, lets AIO promote Part 1, completes/promotes Part 2, and has AIO refresh the supplied checkout. This worker has no route to resolve that lifecycle boundary. Keep this item out of completion-verifier rounds until those prerequisites exist. Missing source tooling is not eligible for live-test deferral. Screen-reader and integrated-Windows visual checks for the implemented subset are recorded in [the pending live-check document](2026-10-10-oct-phase4c-tooltips-finish_livetest.md); the unimplemented parts' live requirements remain in the plan.

| Part | Actual status after this round |
|---|---|
| 1a conversation tools | Partial: jump-rail keyboard preview verified; all native-title/control migrations pending foundation |
| 1b side chat | Open: foundation APIs, counter and wording ledger absent |
| 1c source control | Open: foundation APIs, shortcut helper and local-key marker absent |
| 1d Settings | Partial: row descriptions verified; tab migrations pending foundation |
| 1e shared pieces / headings | Open: migration recipe and guard unavailable |
| 1f remaining folders | Open: foundation guard absent and Part 2 migrations unfinished; strict totals cannot be proved zero |
| 2a shortcut lint rule | Open: plug-in/link test absent; H5 has not been proved zero |
| 2b control-title lint rule | Open: plug-in/link test absent; H2a has not been proved zero |
| 2c icon-control lint rule | Open: plug-in/link test absent; H1a/H1b have not been proved zero |
| 2d all-title lint rule | Open: plug-in/link test absent; H2a/H2b/H2c have not been proved zero |

The verifier's claim of no code implementation is addressed by the working-tree patch and new regression coverage. Its requirement for the whole plan is **still unresolved**. The active filename is preserved; no commits, staging, stashes, branch changes, new worktrees, database/settings writes or local browser/desktop actions were performed.

### Queue dependency preflight (12 Oct 2026)

- Assigned checkout: `/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-10-10-oct-phase4c-tooltip-4995f5`, branch `queue/2026-10-10-oct-phase4c-tooltip-4995f5`. It started clean; `rtk git rev-parse HEAD main` returns `4d175e55bc5b43121437e9884eddc2d2ebf84b9f` for both, and `rtk git diff main...HEAD --stat` is empty. This plan was read and edited only at its original root-checkout absolute path. There is no separate linked spec: the approved backlog's D5/D10 sections and this plan are the requirements; Part 2 supplies the mandatory migration recipe.
- Investigated current implementation dependencies instead of treating an old waiting note as an approval requirement. Read the current manifest, ESLint configuration and tooltip directive, the source backlog's tooltip section, both dependency plans' execution records and Part 2's recipe. This checkout lacks `scripts/ui-hints/`, the count ratchet, wording ledger, reason register, icon-button directive, `appTooltipShortcut`, `appTooltipDisabledReason`, `appTooltipShowWhenExpanded` and `visibleTextOf`. A targeted search in the tooltip directory for those API names exits 1 with no matches. ESLint has no `ui-hints` plug-in or rules to switch on.
- Executable tooling preflight fails: `rtk npm run audit:ui-hints -- --list H2a` exits 1 with `Missing script: "audit:ui-hints"`; `rtk npm run check:ui-hints` exits 1 with `Missing script: "check:ui-hints"`. npm logs: `/Users/suas/.npm/_logs/2026-10-12T05_12_46_331Z-debug-0.log` and `/Users/suas/.npm/_logs/2026-10-12T05_12_46_579Z-debug-0.log`. These are failed preflights, not passing acceptance evidence. Every migration needs the counter and wording ledger before editing and the guard afterwards; the four lint switch-ons need the missing plug-in and proven zero totals.
- Read-only coordinator evidence: `plan_queue_status` for run `af1f497f-382a-4ad9-8451-4efa1dcfdaf8` reports Part 1 item `a6a27c49-0df2-45f1-b81e-83eb621b2e67` parked, round 2, verdict `PASS`, no findings, reason `land-blocked`, detail `root checkout has uncommitted changes to a promoted path: package.json`. Part 2 item `0053e038-f171-437a-94be-cd7aad0b85c5` is parked, round 3, reason `verifier-unreliable` (the verifier ended without reporting a verdict); its current plan records 0 of 8 migrations implemented. Neither status establishes landed prerequisites here.
- Independently confirmed ` M package.json` in the root checkout, preserving that unrelated work. `rtk git merge-base --is-ancestor 165417296 HEAD` exits 1. Reading the foundation checkpoint's stat confirms it owns the missing tooling, icon-button building block and new directive APIs in a separate queue item. Its existence in Git does not make those files available in this checkout.
- Ruling: keep 1a–1f and 2a–2d open. Do not recreate another queue item's foundation, copy parked code, manually merge/promote it, bypass AIO lifecycle metadata or perform an unmeasured title swap. Part 1's mandatory tooling blocks every surface, including the six heading renames; Part 2's unfinished migration also prevents the whole-tree zero counts required to finish 1f and Step 2. The current worker instruction forbids branches/merges and assigns integration to AIO. This is an implementation dependency, not a missing user preference or consent decision.
- Recovery capability investigated: the current `plan_queue_control` schema permits control only by the session that started the run, with a rescue exception for non-queue-spawned sessions when that parent no longer exists. This queue-spawned worker has no applicable control route; no mutation was attempted. Required next action: the parent session reconciles its root `package.json` changes without discarding other work, resumes and lands the PASS foundation through AIO, completes and lands Part 2 through AIO, and has AIO refresh this assigned checkout. Recheck actual contents, hint scripts and APIs before starting this plan, and recheck Phase 0/3 overlaps at that point. Keep this unchanged branch out of completion-verifier rounds until those prerequisites are present.
- Safe partial checks run against the unchanged base, all exit 0: existing `aio-tooltip.directive.spec.ts`, `tooltip-policy.spec.ts` and `icon-control-tooltip.spec.ts` (3 files, 52 tests); `rtk npx tsc --noEmit`; `rtk npm run typecheck:spec`; `rtk npm run lint`. Retained logs in this worktree: `_scratch/phase4c-preflight/{tooltip-tests,typecheck,typecheck-spec,lint}.log`; full test output `_scratch/test-run.pid-4805.log`. These establish base health only and do not verify any migration. No full suite was run, per the worker brief; no build or independent completion review is claimed.
- Only this root-checkout plan is changed. No code, tests, generated files, baseline/wording records, completion flags, commits, stashes, branches, worktrees, browser sessions, app settings or databases are changed. The plan remains untracked and keeps its active filename. No `_livetest.md` is created: missing agent-runnable prerequisites do not qualify for live-test deferral. All original live requirements stay open. This worker turn ends with a dependency blocker, not readiness for implementation verification.

(Record here, per part: what changed, any deviation from this plan and why, each part's record drop, the folders done in 1f and the counter's numbers, the live-check results,
and the current gate output.)

- [ ] Step 1 D5: 1a conversation tools; 1b side chat; 1c source control; 1d settings; 1e shared pieces and whole-card titles; 1f everything else (folders: …)
- [ ] Step 2 D10: 2a shortcut rule on; 2b titles on controls on; 2c icon-control rule on; 2d all elements
- [ ] Final gates (targeted tests, typechecks, lint, size and both builds pass for the subset; missing hint guard and coordinator-owned full suite remain)
- [ ] Fresh-eyes gate PASS (implemented subsets PASS; whole-plan completion pending prerequisites and remaining implementation)
- [x] Livetest doc created (implemented subsets only; remaining live requirements stay with their unimplemented parts)

> Plan Queue parked work: `queue/2026-10-10-oct-phase4c-tooltip-4995f5` — 1 commit(s), reason: verifier-unreliable.
