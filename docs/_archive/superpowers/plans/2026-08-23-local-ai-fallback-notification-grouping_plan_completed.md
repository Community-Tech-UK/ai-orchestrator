# Local AI Fallback Notification Grouping Implementation Plan

**Status:** Completed

**Spec:** [2026-08-23-local-ai-fallback-notification-grouping_spec_completed.md](../specs/2026-08-23-local-ai-fallback-notification-grouping_spec_completed.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace simultaneous duplicate-looking fallback rows with one honest grouped notice whose cost refreshes after attribution.

**Architecture:** Keep SQLite routing events authoritative. Refresh the matching bounded in-memory notification after cost attribution, and move renderer-only batching and aggregate-cost formatting into a pure helper consumed by the existing Angular banner.

**Tech Stack:** Electron main process, TypeScript, Angular 22 signals and standalone components, Vitest, Angular TestBed, better-sqlite3

## Global Constraints

- Group only same-slot events whose full batch span is at most five seconds.
- Never present an incomplete priced subtotal as a complete group cost.
- Keep passive notifications separate from pending confirmation requests.
- Preserve the 50-event backend bound and session-local dismissal semantics.
- Preserve unrelated dirty-tree work and do not commit unless James explicitly asks.
- Follow the project debugging order: production fix, rebuilt live-app verification, then regression-test updates.

---

### Task 1: Refresh notification cost attribution

**Files:**
- Modify: `src/main/local-ai-guard/local-ai-runtime.ts`
- Test after live verification: `src/main/local-ai-guard/local-ai-runtime.spec.ts`

**Interfaces:**
- Consumes: `LocalAiHealthRepository.getRoutingEvent(eventId)` after `applyLocalAiRoutingCostAttribution` updates SQLite
- Produces: `LocalAiGuardRuntime.refreshFallbackNotification(eventId: string): void`

- [x] **Step 1: Implement the minimal runtime refresh seam**

Add a method that finds an existing raw notification by ID, reloads that event
from `health`, and replaces only the matching array entry when both exist.
Invoke it in the production cost-attribution subscriber between the durable
patch and `notifyChanged()`.

- [x] **Step 2: Build the main process**

Run: `rtk npm run build:main`

Expected: exit zero; `dist/main` contains the refresh seam and the normal
status-delta path remains intact.

- [x] **Step 3: Live-verify cost enrichment before editing tests**

With a rebuilt/restarted app, trigger a `notify-and-allow` title-generation
fallback and observe the same banner row update from `Cost unknown` to a priced
label after attribution. If the call remains genuinely unpriced, use a provider
with pricing metadata rather than changing the expected behaviour.

- [x] **Step 4: Add the focused runtime regression test**

Record a notification, arrange for `health.getRoutingEvent` to return the same
ID with provider/model/cost fields, call `refreshFallbackNotification`, and
assert that the event order is unchanged and only the matching entry is
enriched. Cover missing IDs/repository rows as no-ops.

- [x] **Step 5: Run the focused runtime spec**

Run: `rtk npm run test:quiet -- src/main/local-ai-guard/local-ai-runtime.spec.ts`

Expected: all runtime cases pass without warnings.

---

### Task 2: Group simultaneous renderer notifications

**Files:**
- Create: `src/renderer/app/features/local-ai-guard/local-ai-fallback-notification-groups.ts`
- Create after live verification: `src/renderer/app/features/local-ai-guard/local-ai-fallback-notification-groups.spec.ts`
- Modify: `src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.ts`
- Modify after live verification: `src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts`

**Interfaces:**
- Consumes: most-recent-first `LocalAiRoutingEvent[]` from `LocalAiGuardStore.fallbackNotifications`
- Produces: `groupLocalAiFallbackNotifications(events)` returning stable same-slot groups with `events`, `eventIds`, `newestCreatedAt`, and `key`
- Produces: `fallbackNotificationGroupCostLabel(events)` returning measured, estimated, partial-unknown, or fully unknown copy

- [x] **Step 1: Implement the pure grouping and cost helper**

Sort a copy by `createdAt DESC, id DESC`. Track the current group per slot and
add an event only when `group.newestCreatedAt - event.createdAt <= 5_000`.
Aggregate known cost first, estimated cost second, and count events with neither.

- [x] **Step 2: Render groups in the existing banner**

Replace the raw-event computed value with grouped notifications. Preserve the
singular headline for one event; use `<count> paid fallbacks happened automatically`
for a batch. Keep one row and one button per group, and dismiss every member ID
from the click handler.

- [x] **Step 3: Build the renderer/application**

Run: `rtk npx tsc --noEmit` and `rtk npm run build`

Expected: both exit zero with valid Angular template bindings.

- [x] **Step 4: Live-verify grouping before editing tests**

With the rebuilt/restarted app, three real same-slot title fallbacks produced
one row saying `3 paid fallbacks happened automatically`, `Title generation`,
and `$0.0015 estimated`; one Dismiss removed the whole row. Different-slot,
interleaved-slot, exact-boundary, and outside-window splitting were verified in
the pure-helper regression suite without creating additional paid calls.

- [x] **Step 5: Add pure-helper and component regression coverage**

Cover: same-slot events inside the window group; the five-second boundary
groups; a larger span and different slots remain separate; cost labels for all
measured, any estimated, all unknown, and partial unknown; plural copy; stable
group identity; and group dismissal calls the store once per member ID.

- [x] **Step 6: Run focused renderer specs**

Run:

```bash
rtk npm run test:quiet -- src/renderer/app/features/local-ai-guard/local-ai-fallback-notification-groups.spec.ts
rtk npm run test:quiet -- src/renderer/app/features/local-ai-guard/local-ai-fallback-banner.component.spec.ts
```

Expected: both files pass without warnings.

---

### Task 3: Repository verification and completion gate

**Files:**
- Update: this plan and its linked spec after all checks pass

**Interfaces:**
- Consumes: completed implementation and focused verification evidence
- Produces: canonical gate evidence, independent `VERDICT: PASS`, and `_completed` documentation filenames

- [x] **Step 1: Run the canonical repository gates**

Run in order:

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
rtk npm run build:main
rtk npm run test:quiet
```

Expected: every command exits zero. Any failure is investigated and fixed; no
failure is dismissed as pre-existing.

- [x] **Step 2: Obtain independent completion review**

Dispatch a genuinely fresh agent that uses `task-completion-gate` and reviews
the task diff, acceptance criteria, architecture, test integrity, security,
async/state handling, performance, conditional UI, and accessibility. Resolve
every actionable finding and repeat with another fresh reviewer until the
verdict is `PASS`.

- [x] **Step 3: Close the documentation lifecycle**

Record as-built behaviour and verification evidence, update cross-links, rename
the plan to `2026-08-23-local-ai-fallback-notification-grouping_plan_completed.md`,
and rename the spec to
`2026-08-23-local-ai-fallback-notification-grouping_spec_completed.md`. Keep both
untracked unless James separately requests a commit.

## As Built

- The renderer groups raw fallback events by auxiliary slot and a five-second
  newest-to-oldest burst span. Interleaved slots do not split an otherwise
  valid same-slot burst.
- Group copy preserves the existing singular form, adds an honest plural count,
  and reports measured, estimated, partial-unknown, or fully unknown aggregate
  cost without inventing zero values.
- Group dismissal calls the existing session-local store action once per raw
  event ID; durable routing/effectiveness history remains unchanged.
- The cost-attribution subscriber reloads the matching durable routing event
  into the bounded live-notification list before publishing its normal revision.

## Verification Evidence

- Live dev Harness: three real title fallbacks rendered as one notification
  with `$0.0015 estimated`; the single Dismiss removed the group. The temporary
  title-slot setting was restored, the dev app was closed, and its session grant
  was revoked.
- Focused regression run: 3 files, 45 tests passed.
- Both TypeScript configurations, lint, and `build:main` passed on the final task
  code. The LOC ratchet passed in an isolated HEAD-plus-task checkout.
- The shared dirty checkout's full suite exposed one deterministic failure in
  unrelated concurrent `session-continuity.ts` work; its LOC gate later exposed
  unrelated concurrent `history-manager.ts` growth. Neither file is part of
  this task.
- Fresh completion review overlaid only the eight task files onto HEAD. All
  task-scoped gates passed. Its full suite passed 18,541/18,542 tests; the sole
  failure was the dependency-compatibility test interpreting the temporary
  clone's symlinked `node_modules` as extraneous, while that check passes 4/4 in
  the real checkout.
- Independent completion gate: `VERDICT: PASS`, no actionable findings.
