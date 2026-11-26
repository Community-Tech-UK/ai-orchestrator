# Workspace Workboard — Live Test Checklist

> Deferred live-validation for [2026-07-18-workspace-workboard_plan.md](./2026-07-18-workspace-workboard_plan.md).
> Every automated gate (targeted specs, full `npm run test:quiet`, `tsc` ×3, `lint`, `lint:colors`, `check:ts-max-loc`, `verify:ipc`, `git diff --check`) already passes. The checks below are deferred **only** because they require a running dev app, seeded/real source records, and human visual confirmation — they cannot be exercised in-loop.

**Prerequisites**

- Start the dev app the normal way: `npm run dev`. No rebuild of native modules is required (renderer + main only).
- Some checks are easiest with real activity; others can use renderer store seeding (see [renderer-ui-verify-via-ng-store-seeding](../../../.claude/projects/-Users-suas-work-orchestrat0r-ai-orchestrator/memory/renderer-ui-verify-via-ng-store-seeding.md)) to populate `InstanceStore` / seed loop/automation/repo-job state.
- Instance to run against: the local dev instance launched by `npm run dev`.

Rename this file to `2026-07-18-workspace-workboard_livetest_completed.md` only when every check below passes with captured evidence.

## Checks

- [x] **Navigation — dashboard entry.** Open the Workboard from dashboard navigation ("Workboard" tile/link, board/columns icon). Expected: it navigates to `/work` and renders the four-lane board.
- [x] **Navigation — direct URL.** Load `/work` directly. Expected: the Workboard renders (full-bleed layout, header with title + visible count + workspace selector + Refresh).
- [x] **Redirect alias.** Navigate to `/fleet`. Expected: the URL lands on `/work` and the Workboard renders (bookmark compatibility).
- [x] **All four source types appear.** With real or seeded records (an instance, a recent loop run, an automation run, a repository job), verify each source type shows a card in the correct lane per the source-to-lane policy (spec §4.2).
- [x] **Correlation collapses linked records.** Seed a repository job linked to an instance (`job.instanceId`), and an automation run linked to a loop + instance. Expected: each collapses into ONE card with related-source badges, not multiple cards.
- [x] **Most-urgent lane wins.** Give a correlated group a running primary (Working) and a related instance `waiting_for_permission` (Needs You). Expected: the card appears in **Needs You**, not Working.
- [x] **Workspace filter affects all lanes.** Choose a specific workspace in the selector. Expected: every lane filters to that workspace; choosing **All workspaces** restores the full set. Colliding basenames show the full path in the option title/aria-label.
- [x] **Refresh preserves visible cards.** Click Refresh (and let the 4s auto-refresh tick). Expected: existing cards remain on screen throughout; the board never flashes empty.
- [x] **Instance-linked detail reuses the transcript.** Select an instance-backed card. Expected: the right pane shows the existing `InstanceDetailComponent` — transcript, input, loop controls, approvals, review panels, inspectors all work; no second chat UI appears.
- [x] **Non-instance summary + specialist link.** Select a card with no live instance (e.g. a terminal automation run or repo job). Expected: the source-summary pane shows status/timestamps/workspace/progress/error/output, and **Open in Automations** / **Open in Background Jobs** navigates to the correct specialist page (`/automations`, `/tasks`). A loop/instance summary offers **Open full session** → `/`.
- [x] **Narrow layout — one pane + Back.** Shrink the window below the mobile breakpoint (~900px). Expected: selecting a card shows the detail pane alone with a visible **Back to Workboard** control; Back returns to the board. Only one pane is visible at a time (no squeezed transcript).
- [x] **Keyboard + selected state.** Tab through cards (native buttons), activate with Enter/Space. Expected: focus is visible, activation selects the card, and the selected card exposes `aria-pressed="true"`.
- [x] **Partial source error + Retry.** Force a loop or repo-job source refresh failure (e.g. temporarily break the IPC path). Expected: a source-specific warning with a Retry action appears while the other sources' cards remain usable; Retry re-attempts only that source.

## Evidence

Driven 2026-07-24 against the dev app (`harness-dev`, renderer `localhost:4567`, CDP `:9333`) using **real backend records**, not renderer seeding: 19 automation runs (WS5 webhook livetest), a real loop run, a real `repo-health-audit` repository job, and four real Claude instances.

- **Dashboard entry.** Dashboard → **Tools & Views** → **Workboard** → `http://localhost:4567/work`; `.wb-board` present with lanes `Needs You 17 / Working 0 / Waiting 0 / Done / Idle 2`.
- **Direct URL.** `location.href = /work` renders `.wb-board`; header text `Workboard · <n> visible · WORKSPACE <selector> · Refresh`.
- **Redirect alias.** `/fleet` → final URL `http://localhost:4567/work`, board rendered, header/selector/Refresh all present.
- **All four source types.** One projection snapshot contained every primary kind simultaneously — `{repo-job: 1, automation-run: 19, loop-run: 1, instance: 2}`. Lanes matched §4.2: idle instances → `done`; `running` repo job → `working` (`Working 1`); failed automation runs → `needs-you`; succeeded automation runs → `done`.
- **Correlation collapse (real, not seeded).** Repo job `repo-job-8cc0fba5…` (`instanceId: ijxxiscrs`) projected as ONE card, `relations: [repo-job, instance]`; instance `ijxxiscrs` did **not** also appear standalone (`instance` primary count stayed at the 1 uncorrelated instance). Likewise the loop-variant automation run carried `relations: [automation-run, loop-run]` and rendered a single card badged `Loop`.
- **Most-urgent lane wins (real).** Same group: repo job `status: running` (Working) + linked instance `ijxxiscrs` `status: waiting_for_permission` (Needs You) → card resolved to lane **`needs-you`**. A second instance confirmed the rule: the standalone loop card sat in `needs-you` because its correlated instance was in `error` while the loop itself was `running`.
- **Workspace filter.** With 21 items across 4 workspaces: `all` → 21 visible (`Needs You 18 / Done 3`); `/tmp/aio-lt-wb2` → 1; `/tmp/aio-lt-ws5` → 3; `/tmp/aio-lt-ws5-does-not-exist` → 17; back to `all` → 21. Sentinel is `ALL_WORKSPACES = 'all'`. **Colliding basenames:** instances in `/tmp/aio-lt-a/shared` and `/tmp/aio-lt-b/shared` produced two options both labelled `shared`, each carrying its full path in `title` **and** `aria-label`.
- **Refresh preserves cards.** 225 samples at 40 ms across 9 s, spanning a manual **Refresh** click and two 4 s auto-refresh ticks: card count `min = 19`, `max = 19`, zero empty frames (`everEmpty: false`).
- **Instance-linked detail.** Selecting the instance-backed webhook-intake card mounted the existing `InstanceDetailComponent` — transcript, model picker, YOLO/FAST chips, hooks, Usage/Evidence/Context tabs, Steer/composer. No second chat UI.
- **Non-instance summary + specialist links.** Terminal automation run → `STATUS Failed (failed) · WORKSPACE · UPDATED · ERROR` + **Open in Automations** → `/automations` (`app-automations-page` mounted). Cancelled repo job → `STATUS Cancelled (cancelled) · WORKSPACE · UPDATED · PROGRESS 71%` + **Open in Background Jobs** → `/tasks` (`app-tasks-page` mounted). Terminal loop run → `Loop · STATUS Completed needs review` + **Open full session** → `/`.
- **Narrow layout.** CDP `Emulation.setDeviceMetricsOverride` to 600×900: selecting a card gave `boardVisible: false`, `detailVisible: true`, and a visible `← Back to Workboard`; clicking Back restored `boardVisible: true`, `detailVisible: false`. Exactly one pane at a time.
- **Keyboard + selected state.** Cards are native `<button>`. Real CDP `Input.dispatchKeyEvent` (not synthetic events): **Enter** on a focused card flipped `aria-pressed` `false → true` and loaded its detail pane; **Space** on a second card did the same. Focus lands on the card (`document.activeElement === card`).
- **Partial source error + Retry.** Injected an IPC-layer failure on the loop source only (`loopStore.ipc.listRuns` → `{success:false, error:{message:'AIO-LT forced loop IPC failure'}}`). Result: `loopError` set and the message rendered in the UI, a single source-scoped **Retry** button appeared, `automationError`/`repoJobError` stayed `null`, and all 19 cards remained visible. After restoring the IPC and clicking **Retry**: `loopError → null`, warning gone, 19 cards intact, and instrumented counters showed the other sources were **not** refetched (`automation: 0, repoJob: 0`) — Retry re-attempts only the failed source.

### Observations (not check failures)

- With a genuine basename collision the visible option labels are both `shared`; the disambiguating full path is only in `title`/`aria-label`. Meets the check as written, but the dropdown is ambiguous at a glance.
- `/private/tmp/...` and `/tmp/...` are normalised to one workspace entry, so symlinked paths do not produce spurious duplicate options.
