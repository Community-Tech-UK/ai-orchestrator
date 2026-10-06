# Plan Queue page layout and stranded-run rescue

Status: completed 2026-10-03. Implemented and verified, with three fresh completion-gate passes. Not committed (James has not asked for a commit). Takes effect in the packaged app only after James rebuilds and restarts it. Source: Part 3 of
`/Users/suas/work/communitytech/plan-queue-cleanup-and-fixes-2026-10-03_prompt.md`
(James, 3 October 2026: "this page is a pile of shit… I have no idea what all
this stuff is and what I should do with it").

## Problems (measured 2026-10-03)

1. **The page cannot scroll.** `.control-content` in
   `control-surface-shell.component.scss` is `overflow: hidden`, and
   `PlanQueuePageComponent` never owned a scroller. Everything below the fold was
   unreachable, including the Runs section, which holds the only Cancel button.
   The tasks page had the same bug and fixed it with a scrolling `:host`.
2. **The important things are buried.** The order was start form → banner →
   reconciler alerts → livetest checks → parked work → Runs. The question cards
   sat inside each run's item list, so with three active runs (62/32/17 items)
   the 41 open questions were spread through the slowest pane. Parked rows
   showed only a branch name and no document name. No section said what it was
   for.
3. **A run whose parent session is gone can only be cancelled from the panel.**
   `assertParent` refuses every MCP control call from anyone but the parent. Run
   ids are not kept across restarts, so once the parent is gone the run claims its
   documents indefinitely. This stranded runs `49d3a87b` (30 Sep) and `aa092999`
   (1 Oct).

## Changes

### Renderer (`src/renderer/app/features/plan-queue/`)

- [x] `:host` owns its scrolling (`display:block; height:100%; min-height:0;
  overflow-y:auto`), with the same explanatory comment as the tasks page.
- [x] New page order, with a one-line plain-English purpose under every heading:
  1. **Needs your answer**: every open question card, grouped by run, each card
     labelled with its document. New `PlanQueueQuestionListComponent`, fed by a new
     `PlanQueueStore.questionGroups` computed. As built: each run's group is a
     `<details>`, open when there are 10 questions or fewer in total, and folded
     above that. With all 41 open, the rendered check put Runs about 7,600px down,
     so the folding keeps Runs on the first screen.
  2. **Runs**: run rows with Pause/Resume/Cancel always visible. Each run's
     document list is collapsed in a `<details>` element whose summary shows the
     state counts. Item rows no longer repeat the question card; they point to
     the section above.
  3. **Start a run**: the existing form (its duplicate inner "Start run" heading removed).
  4. **Needs James (livetests)**.
  5. **Parked work** ("leftovers of a stopped run"): now shows the document name
     and run as well as the branch.
  6. **Reconciler alerts**.
- [x] Help-pane text (`automation.help.ts`) matches the new order and mentions
  the stranded-run rescue.

### Main (`src/main/plan-queue/`, `src/main/mcp/plan-queue-tools.ts`)

- [x] `PlanQueueCoordinator.control` authorises through `authorizeControl`:
  - Panel (no caller) and parent behave as before ("James").
  - **Stranded-run rescue:** when the parent instance no longer exists, any session
    that is not a queue worker, verifier or triage agent may run `cancel` (run) or
    `discard-item` (item). Every other action is still refused, and the refusal
    message names the two rescue actions.
  - The rescue writes an audit line to the log (`logger.warn`) and to each affected
    item's `detail`: "Run cancelled by session X, because the session that
    started the run (Y) no longer exists." / "Discarded by session X, …".
- [x] `PlanQueueItemFlow.discard` takes the actor for its detail note (default
  "James").
- [x] The `plan_queue_control` tool description, the module header,
  `docs/AIO_MCP_CLI.md` and `docs/llm/AIO_MCP_CLI_REFERENCE.md` document the rescue.

### Tests

- [x] As built: the authorisation lives in `plan-queue-control-authority.ts`, which keeps the
  coordinator under the 700-line limit.
- [x] `plan-queue-coordinator.spec.ts`: rescue cancel (refused while the parent
  lives, refused for a queue instance, refused for non-rescue actions, accepted
  once the parent is gone, audit detail recorded); rescue discard of a parked
  item (resume refused, discard accepted, branch deleted, audit detail).
- [x] `plan-queue.store.spec.ts`: `questionGroups`.
- [x] Component specs: page section order and the scrolling host; the question
  list; the run list's collapsed documents and the absence of duplicate cards;
  parked-row document label.

## Verification

Evidence (2026-10-03):

- Coordinator spec: 40/40 (two new rescue tests). Plan Queue renderer, store and MCP specs: 590/590.
  Final renderer and store run: 82/82.
- `tsc --noEmit`, `lint`, `check:ts-max-loc`, `build:main` and `build:renderer` all exit 0.
- `typecheck:spec` fails with one error, in `src/renderer/app/core/state/side-chat.store.spec.ts`
  (another session's untracked side-chat work, which uses a wrong relative import). Full suite:
  29,195 of 29,196 pass. The one failure is `packages/contracts/src/channels/__tests__/chat.channels.spec.ts`,
  caused by the side-chat session's uncommitted `chat.channels.ts` change. Neither failure involves
  a file in this plan.
- Rendered check: dev app (`--no-sandbox`, isolated profile) with the real `PlanQueueStore`
  seeded at the live run sizes (62, 32 and 17 items; 41 questions; 34 parked). The host scrolls
  (`overflow-y: auto`, scrollHeight 5079 in a 525px viewport). The section order is as above,
  each section has a purpose line, the Runs heading is on the first screen and the bottom
  section scrolls into view. Opening a folded group and answering a card called
  `store.answer(item, option)`, and Cancel called `control` only after Confirm. Screenshots
  are in `_scratch/pq-verify/`.

- [x] Targeted specs (coordinator, store, plan-queue components).
- [x] `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`,
  `npm run test:quiet`.
- [x] Rendered check of the page in the dev app or a renderer harness with seeded
  runs: the page scrolls and the questions come first.
- [x] Fresh `task-completion-gate` agent: `VERDICT: PASS` three times. Low findings from passes 1 and 2
  were fixed: question-group open state fixed at first render (test mutation-checked against the old
  binding), rescue log worded "authorised", authority comment corrected, alerts purpose line covers
  missing worktrees, run-summary order exhaustive via a `Record`. Pass 3 had no actionable findings;
  its one wording note (tool description excludes queue sessions) was also applied.

Not part of this plan: the communitytech cleanup and the work-finding queue run
(Parts 1 and 2 of the prompt). Those depend on James cancelling the two stranded
runs from the panel, because the rescue only takes effect after a rebuild and
restart, and live sessions are running.
