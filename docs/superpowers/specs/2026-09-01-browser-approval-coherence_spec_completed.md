# Browser Approval Coherence Spec

**Date:** 2026-09-01
**Status:** Completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. Lifecycle closure is taken; rebuilt-app live validation remains deferred to the plan's linked `_livetest.md`.
**Owner:** James

**Implementation plan:** [2026-09-01-browser-approval-coherence_plan_completed.md](../plans/2026-09-01-browser-approval-coherence_plan_completed.md)

## Problem

Browser Gateway approval state is split across independently refreshed renderer surfaces. The root banner polls every five seconds, while the Browser Gateway page reads approvals only during explicit refreshes. The banner's `More options` action navigates to the Browser Gateway route without selecting the Permissions tab or identifying the request. Sequential requests with the same action, origin, and session render as indistinguishable banners, and the banner cannot be safely minimised.

The backend also exposes a contradictory credential-approval contract. Mutation tool schemas accept an approval `requestId`, and the renderer can create session or unattended credential grants, but credential hard stops raise another approval even when the exact approved request and grant are supplied. The live incident produced three identical approvals for the same credential click.

## Goals

1. Redeem an approved credential hard stop exactly once when the retry supplies the matching request ID and the action fingerprint is unchanged.
2. Reuse an existing identical pending request instead of stacking another approval.
3. Prevent broad credential approvals that the backend deliberately will not honour.
4. Make the banner and Browser Gateway page consume one live approval state.
5. Deep-link `More options` to the Permissions tab and focus the exact request, including when already on `/browser`.
6. Make sequential requests visibly distinct.
7. Let the operator minimise the full banner without resolving the request or losing the pending indicator.

## Non-Goals

- Credential approvals do not become standing unattended access.
- Captcha, two-factor, payment, financial-identity, or sensitive-identity hard stops are not made automatable.
- Existing historical grants are not rewritten or deleted.
- The Browser Gateway page is not otherwise redesigned.

## Security Contract

An exact credential redemption requires all of the following:

- The request belongs to the current instance and provider.
- The stored approval status is `approved` and has a grant ID.
- The retry's `requestId` matches the stored approval.
- The stored profile, target, tool, action, action class, origin, and target label match the retry.
- The matching live grant is the grant created by that approval.
- The classification is the ordinary credential/manual-challenge hard stop, not captcha or two-factor.

After a successful mutation, the redeemed grant is consumed even if an older renderer requested session or autonomous mode. New credential approvals are normalised in the main process to one-action, non-autonomous credential grants. The renderer exposes only `Allow once` and `Deny` for credential and unknown approvals.

## Pending-Request Deduplication

Before creating a mutation approval, the action guard checks live pending requests for the same instance. It reuses only an unexpired request with the same profile, target, tool, action, action class, origin, selector/UID target label, and proposed grant scope. A materially different action remains a distinct request.

## Renderer State

A root-provided `BrowserApprovalsStore` owns the pending-approval signal, five-second poll, explicit refresh, optimistic removal, current-request transition marker, and ephemeral minimised snapshot. The banner starts the poll for the app lifetime. The Browser Gateway page aliases the same signal and uses the store for refreshes and decisions, eliminating contradictory counts.

Minimisation records the current sorted request-ID snapshot. Any request-set change automatically expands the banner so a new request cannot remain hidden. The compact reminder retains the pending count plus Show and Review actions.

## Navigation and Focus

`More options` navigates to `/browser?view=permissions&requestId=<id>`. `BrowserPageComponent` observes query-parameter changes, selects Permissions, refreshes the shared store, highlights the matching card, and moves keyboard focus to it after rendering. If the request resolves before navigation completes, the page still opens Permissions and shows the current empty state.

## Request Identity and Accessibility

The expanded banner shows a `New request` label, the current position when multiple requests exist, a short request identifier, and received time. The minimise button has an explicit accessible label and does not imply approval or denial. The compact reminder remains a polite live region. Focus rings, semantic buttons, text labels, and reduced-motion behavior follow the existing shell styling.

## Verification

- Regression tests prove an approved exact credential retry executes once and consumes its grant.
- Negative tests cover missing/wrong request IDs, changed targets, and captcha/two-factor exclusions.
- Regression tests prove identical pending actions reuse one request while different actions remain separate.
- Main-process tests prove credential approvals are narrowed server-side.
- Renderer store tests prove shared refresh, optimistic removal, minimisation, and automatic re-expansion.
- Banner tests prove deep-link payload, sequential identity, and compact reminder behavior.
- Browser page tests prove query-driven Permissions selection, shared live counts, highlighting, and focus.
- Run the canonical project verification checklist and complete a fresh independent completion gate.

## As-Built Status — 2026-09-01

The implementation now uses an exact approval redeemer with synchronous one-use reservations,
server-side credential/unknown grant narrowing, pending-request fingerprint deduplication, and a
root-provided renderer approval store. The banner and Permissions page share state, direct links
select and focus the exact card, request identity is visible, and the × control minimizes to a compact
reminder whose snapshot is permanently cleared on the first request-set change.

Focused approval verification passes 129 tests across eight files. Application TypeScript, lint,
the TypeScript LOC ratchet, main/preload build, and diff checks pass. A fourth fresh completion gate
returned `VERDICT: PASS`. The rebuilt-app checks remain in
[2026-09-01-browser-approval-coherence_livetest.md](../plans/2026-09-01-browser-approval-coherence_livetest.md).
The documents remain active because the current shared checkout has unrelated context-worker spec
type errors and three unrelated full-suite baseline failures; those concurrent changes were not
modified as part of this work.
