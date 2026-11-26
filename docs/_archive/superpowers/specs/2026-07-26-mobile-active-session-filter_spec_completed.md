# Mobile Active Session Filter Specification

**Status:** Completed and independently verified on 2026-07-26.

**Implementation plan:** [2026-07-26-mobile-active-session-filter_plan_completed.md](../plans/2026-07-26-mobile-active-session-filter_plan_completed.md)

## As Built

The implementation matches this specification without gateway or persistence changes. The mobile Projects screen now exposes an accessible All/Active segmented control, applies desktop-aligned active semantics to both organization modes, composes state and text filtering, removes empty projects in Active mode, and provides active-specific empty-state guidance.

Verification passed across focused and full mobile tests, mobile typecheck/lint/build, the repository canonical gates, a 390×844 rendered browser check, and an independent completion gate with `VERDICT: PASS`.

## Goal

Give the mobile Projects screen the same quick All/Active session filtering concept as the desktop project rail.

## User Experience

- Show an accessible two-option segmented control labelled `Filter sessions by state` beside the Projects/Sessions heading.
- Default to `All`.
- Selecting `Active` shows only live/current sessions and removes projects that have no matching sessions.
- The filter applies identically to By project and Chronological organization modes.
- Text search composes with the state filter. A matching project name must not reintroduce inactive or history-only sessions.
- When the active filter has no results, show `No active sessions` with guidance to switch back to All.
- The filter is view-local and does not change host state, ordering, history, or persisted data.

## Active Definition

Mobile must match the desktop active-state filter. These statuses are active:

- `initializing`
- `ready`
- `idle`
- `busy`
- `processing`
- `thinking_deeply`
- `waiting_for_input`
- `waiting_for_permission`
- `interrupting`
- `cancelling`
- `interrupt-escalating`
- `respawning`
- `hibernating`
- `waking`
- `degraded`

History-only rows and live rows in `cancelled`, `superseded`, `hibernated`, `error`, `failed`, or `terminated` are not active.

## Architecture

- Add a pure active-status predicate to the mobile status module.
- Enrich project-list session rows with a view-model-only `active` flag; do not change gateway DTOs or the shared visual row component.
- Extend the existing pure project-group filter to apply both state and text filters, preserving project context only for rows that pass the state filter.
- Keep filter state in `ProjectsComponent` as an Angular signal and feed the same filtered groups to both rendering modes.

## Accessibility

- Wrap All and Active buttons in a group labelled `Filter sessions by state`.
- Expose selection with `aria-pressed`.
- Keep each control at least the repository's standard mobile control height.

## Verification

- Status unit test for every desktop-aligned active and inactive status.
- Project-list view-model tests for active-only filtering, empty-project removal, and state-plus-search composition.
- Component structure test for the segmented control, accessible state, and active empty-state copy.
- Mobile focused tests, mobile typecheck, mobile lint, mobile build, and the repository canonical verification checklist.
