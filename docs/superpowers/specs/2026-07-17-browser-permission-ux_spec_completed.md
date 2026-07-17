# Browser Permission UX Fix Spec

**Date:** 2026-07-17
**Status:** Implemented and agent-verified; rebuilt-app checks are deferred to the linked live-test document
**Owner:** James

**Implementation plan:** [2026-07-17-browser-permission-ux_plan_completed.md](../plans/2026-07-17-browser-permission-ux_plan_completed.md)

## Problem

The global browser approval bar removes both approval and denial actions when an agent proposes an autonomous grant. It leaves only `Review`, which opens the broad Browser Control & Diagnostics page. That page requires the word `AUTONOMOUS` for every autonomous approval and places the field in a generic controls block below the request list.

James's screenshot shows the failure on an ordinary `browser.type` request for `play.google.com`: a full-width blue bar says the action is waiting, but offers only `Review`, even though the selected session shows `YOLO ON`.

## Root Cause

The renderer treats the requested grant mode as the risk signal. `BrowserApprovalsBannerComponent.canQuickApprove()` rejects every autonomous proposal, regardless of the classified action. `BrowserPageComponent.approveApprovalRequest()` then requires generic typed confirmation for every autonomous mode.

This diverges from the completed Browser Gateway design. That design makes session grants the ergonomic default and reserves typed confirmation for autonomous submit/publish/delete capability. Ordinary input is grantable without that confirmation. Credential and payment classes remain hard stops.

## Options Considered

1. **Recommended: safe decisions in place.** Keep the compact global bar, but offer scoped `Allow once`, `Allow for session`, and `Deny` actions for grantable low-risk requests. Downgrade an autonomous proposal when the user selects a narrower choice. Keep advanced unattended permission behind `More options`, and require typed confirmation only when the chosen grant contains submit or destructive classes.
2. **Deep-link to diagnostics.** Preserve the Review-only bar but route to the exact request and focus its controls. This removes some hunting but keeps an unnecessary context switch and still makes routine input feel like system configuration.
3. **Rely on YOLO auto-approval.** The main process already auto-approves grantable requests for YOLO sessions, including stale pending requests when they are listed. Relying on that alone leaves stale, mismatched, credential, and non-YOLO fallback UX broken.

## Chosen Interaction

The permission bar names the browser action and host in plain language. For low-risk grantable requests it shows:

- `Allow once`
- `Allow for session`
- `Deny`
- `More options`

For credential, payment, unknown, submit, or destructive requests, the bar keeps `Deny` and `More options` but does not expose a misleading quick approval.

`Allow once` creates a per-action, non-autonomous grant scoped to the classified action. `Allow for session` creates a session, non-autonomous grant using only grantable classes from the proposal. Neither action widens origins, upload roots, target scope, or external-navigation permission.

The Browser page keeps advanced unattended approval. Generic `AUTONOMOUS` confirmation is removed for ordinary input. If submit or destructive classes are included, the confirmation appears with that request and explains why it is required. The confirmation phrase is the managed profile label when available, otherwise the request host.

## Safety Boundary

- Never quick-approve `credential`, `payment`, `financial_identity`, `sensitive_identity`, `unknown`, `submit`, or `destructive`.
- Never widen the proposal's origins, upload roots, action classes, or navigation scope.
- `Deny` is always available from the global bar.
- Autonomous submit/destructive approval still requires explicit capability selection and typed confirmation.
- Existing main-process classification, grant matching, expiry, audit, and YOLO auto-approval remain unchanged.

## Visual Direction

Use the existing app tokens and compact shell-bar geometry. Change the bar from a generic blue status strip to an amber permission treatment so it reads as a decision, not an informational notification. The signature element is the action group itself: the narrow safe choices are visible where the request appears, with advanced control visually secondary.

## Verification

- Reproduce the current Review-only autonomous-input state with the existing renderer tests and James's screenshot.
- Add renderer regression coverage for safe quick choices, downgraded grant payloads, always-visible denial, and high-risk withholding.
- Add Browser page coverage proving ordinary unattended input does not require typed confirmation and submit/destructive still does.
- Run targeted renderer tests, both TypeScript checks, lint, max-LOC gate, and the full quiet suite.
- Verify the rebuilt UI with a seeded pending autonomous input request or record an exact live-test deferral if the running Electron instance cannot be rebuilt safely in-loop.

## As Built

The global banner now exposes narrow one-action and session choices for low-risk requests, keeps denial visible for every request, and sends credential, payment, unknown, submit, and destructive requests to advanced review. The Browser page and session approval card now keep unattended options and confirmation state on the individual request. Ordinary input no longer asks for a generic confirmation word; submit and destructive capability require the managed profile label or request host.

All three approval component specs pass with 35 tests, both TypeScript checks pass, lint and max-LOC pass, the full quiet suite passes with 14,843 tests across 1,501 files, and the production renderer build succeeds. The rebuilt Harness interaction is pending in [2026-07-17-browser-permission-ux_plan_livetest.md](../plans/2026-07-17-browser-permission-ux_plan_livetest.md) because Harness is hard-denied for automated desktop control in this session.
