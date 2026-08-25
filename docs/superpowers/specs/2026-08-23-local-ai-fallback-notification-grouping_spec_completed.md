# Local AI Fallback Notification Grouping Spec

**Status:** Completed

**Implementation plan:** [2026-08-23-local-ai-fallback-notification-grouping_plan_completed.md](../plans/2026-08-23-local-ai-fallback-notification-grouping_plan_completed.md)

## Problem

The passive Local AI Guard banner renders one row for every `notify-and-allow`
fallback event. When several automation sessions start together, their
independent title-generation fallbacks appear as a stack of visually identical
rows even though they form one operational burst.

Each banner also captures its routing event before the paid provider call runs.
Cost attribution later enriches the durable SQLite event, but the runtime's
in-memory notification retains the original unpriced event. The banner can
therefore continue to say `Cost unknown` after the provider and estimated or
measured cost are known.

## Required Behaviour

- Group notifications only when they use the same auxiliary slot and their
  creation timestamps fall within a five-second batch window.
- Preserve distinct rows for different slots or events outside that window.
- Keep the current singular copy for a one-event group.
- For a multi-event group, show the event count, slot label, and aggregate cost
  in one passive row with one `Dismiss` action.
- Dismissing a group locally dismisses every event ID in that group; it does not
  alter the durable effectiveness record or make a routing decision.
- Refresh an in-memory notification from the durable routing event after cost
  attribution patches that event, then publish the normal status revision so
  the renderer receives the enriched provider, token, and cost fields.
- Format aggregate cost without inventing precision:
  - all measured values: `$N measured`;
  - any estimated value and no unknown values: `$N estimated`;
  - all values unpriced: `Cost unknown`;
  - a mixture of priced and unpriced values: show the priced subtotal and the
    number of costs still unknown.
- Keep the notification list bounded to 50 raw events and keep pending
  `require-confirmation` requests independent of passive notifications.
- Do not add persistence for UI dismissal or rendered notification groups.

## Design

`LocalAiGuardRuntime` will add a focused refresh operation that replaces a
matching in-memory notification with the repository's latest routing event.
The existing cost-attribution subscriber will invoke it after applying a patch
and before publishing the status revision. This keeps SQLite authoritative and
avoids repeated database reads on every snapshot.

The renderer will use a small pure helper beside the existing banner component.
It will sort the current most-recent-first notifications deterministically,
form same-slot groups whose oldest member remains within five seconds of the
group's newest member, and derive an honest aggregate cost label. The component
will render one row per group and dismiss every member ID when that row's button
is activated.

## Verification

- Reproduce the current three-row title-generation stack from the captured live
  evidence and confirm the implementation renders one three-event row after a
  rebuilt/restarted app receives an equivalent burst.
- Confirm later attribution changes `Cost unknown` to the aggregate estimated or
  measured label without creating another row.
- Add focused pure-helper, Angular component, and runtime regression coverage
  only after the required live-app verification checkpoint.
- Run both TypeScript configurations, lint, the TypeScript LOC ratchet,
  `build:main`, focused tests, and the full quiet suite.
- Obtain a fresh independent `task-completion-gate` verdict of `PASS` with no
  unresolved actionable findings.

## As Built

The completed implementation follows this design. A pure renderer helper owns
same-slot burst grouping and conservative aggregate-cost labels, while the
main-process runtime refreshes only the matching live notification from the
durable event after attribution. The bounded raw event list, pending-confirmation
surface, and durable effectiveness records are unchanged.

Live verification reproduced the original three-title-fallback scenario as one
priced row and confirmed group dismissal. Focused tests cover the exact
five-second boundary, interleaved and different slots, out-of-window events,
cost confidence states, singular/plural rendering, grouped dismissal, targeted
runtime refresh, preserved order, and missing-event no-ops. The independent
completion gate returned `VERDICT: PASS` with no actionable findings.
