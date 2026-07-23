# Composer Draft Auto-Resize Specification

Status: implemented; completion blocked by an unrelated full-suite heap-snapshot failure

Implementation plan: [2026-07-23-composer-draft-auto-resize_plan.md](./2026-07-23-composer-draft-auto-resize_plan.md)

## Problem

The composer persists draft text per session, but its textarea height is DOM-only state. Typing schedules an auto-resize; restoring a draft after the composer is remounted or its `instanceId` changes only updates the `message` signal. A long restored draft can therefore appear in a one-row textarea.

The benchmark renderer reproduced the fault with two seeded sessions:

- Before leaving the drafted session: `valueLength: 527`, `inlineHeight: 220px`, `clientHeight: 220`, `scrollHeight: 298`.
- After choosing New Session and returning: `valueLength: 527`, `inlineHeight: ""`, `clientHeight: 51`, `scrollHeight: 298`.

Switching directly from the long draft to an empty session also leaves the empty textarea at `220px`, showing that the stale height can be too small or too large.

## Required Behaviour

1. Whenever a composer becomes visible with restored text, its textarea height must be recalculated from that text.
2. Session switches must both expand for longer drafts and contract for shorter or empty drafts.
3. The existing maximum height remains `min(30vh, 220px)`; longer content scrolls inside the textarea.
4. Ordinary typing, recalled prompts, edit mode, ghost-text acceptance, and other programmatic message changes continue to use the same sizing rule.
5. Draft content and attachment behaviour are unchanged.

## Design

Treat textarea height as derived view state instead of persisted session state.

`InputPanelComponent` will react to both the current `message` value and the signal-based textarea view child. Once the element exists, it will schedule the existing animation-frame resize. This covers initial render, remount, session changes, and programmatic message updates without coupling sizing to the draft store.

The resize callback will set the textarea height to `auto` before reading `scrollHeight`, then clamp the measured height to the existing maximum. Resetting before measurement is required for contraction: a fixed `220px` textarea otherwise reports a scroll height no smaller than its current box.

The existing `resizeScheduled` guard remains the performance boundary, so multiple changes in one frame produce one layout measurement.

## Alternatives Rejected

1. Persist textarea height per session. Height depends on viewport size, font metrics, and wrapping width, so persisted pixels become stale and duplicate derived state.
2. Resize only inside the draft synchronization effect. That fixes one path but misses other signal-driven restores and can run before the view child exists.
3. Dispatch a synthetic `input` event after restoration. That mixes view repair with user-input side effects such as draft writes, prompt recall changes, suggestions, and telemetry.

## Verification

- Re-run the benchmark renderer reproduction and capture dimensions after:
  - long draft input;
  - switching to an empty session;
  - choosing New Session and returning to the long draft.
- Add an `InputPanelComponent` regression test that supplies per-instance drafts, switches the required `instanceId` input, and verifies scheduled height recalculation.
- Run the targeted renderer spec.
- Run:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run check:ts-max-loc`
  - `npm run test:quiet`

## Scope

Only the composer sizing lifecycle and its focused regression coverage are in scope. No layout redesign, draft-store change, or unrelated refactor is included.

## As Built

`InputPanelComponent` now derives textarea height whenever either the current
message or the signal-based textarea element changes. Resize requests within one
animation frame are coalesced onto the latest textarea element, measurement
resets height to `auto` so the box can contract, and the result remains clamped
to `min(30vh, 220px)`. Destruction clears the pending target so a late frame
cannot write to a detached textarea.

Focused coverage now verifies:

- expansion and contraction while switching between session drafts;
- a restored draft after destroying and recreating the composer;
- coalesced resize requests targeting the latest textarea element.

The renderer benchmark confirmed the requested behaviour:

- long draft: `valueLength: 527`, `clientHeight: 220`, `scrollHeight: 298`;
- empty session: `clientHeight: 51`;
- restored long draft after returning: `valueLength: 527`, `clientHeight: 220`.

## Verification Status

The focused spec passes 7/7. Production and spec typechecks, lint, the
TypeScript LOC ratchet, and `git diff --check` pass. One stable canonical run
also passed all 1,554 files and 15,383 tests.

The mandatory fresh completion gate remains nonzero because two independent
full-suite executions failed in the unrelated
`src/main/diagnostics/heap-snapshot.spec.ts` test with Node's maximum-string
error. That test passes 3/3 in isolation, and no composer-specific failure was
found. Repository rules require the specification and plan to retain their
active filenames until the full completion gate passes or the unrelated failure
is fixed in separately authorized scope.
