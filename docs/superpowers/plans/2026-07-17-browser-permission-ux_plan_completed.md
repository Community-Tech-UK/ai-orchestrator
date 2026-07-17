# Browser Permission UX Fix Implementation Plan

> **For agentic workers:** Execute inline in this working tree. Do not dispatch subagents. Keep this plan and its linked spec untracked until all implementation and verification work is complete.

**Goal:** Let users resolve ordinary browser permission requests where they appear, without navigating to diagnostics or typing `AUTONOMOUS`, while preserving explicit safeguards for credentials, payments, submit, and destructive actions.

**Architecture:** Keep policy enforcement in the main process and change only trusted renderer decision surfaces. Add small pure grant-building helpers beside the banner so quick actions can only narrow a proposed grant. Update the Browser page to scope advanced confirmation to the request and to require it only for submit/destructive autonomy.

**Tech Stack:** Angular 21 standalone components, signals, TypeScript, Vitest, existing Browser Gateway IPC contracts and design tokens.

**Status:** Implementation complete and agent-runnable checks passed. Rebuilt-app interaction checks are deferred to [2026-07-17-browser-permission-ux_plan_livetest.md](2026-07-17-browser-permission-ux_plan_livetest.md).

## Global Constraints

- Preserve unrelated staged, unstaged, and untracked work.
- Do not change Browser Gateway classification, grant matching, audit, or YOLO policy.
- Never quick-approve `credential`, `payment`, `financial_identity`, `sensitive_identity`, `unknown`, `submit`, or `destructive`.
- Never widen an approval proposal's origins, upload roots, action classes, target scope, or external-navigation setting.
- Keep `Deny` available in the global bar for every pending request.
- Use plain product copy with no em dash characters.
- Do not commit or push.

---

### Task 1: Global permission bar decisions

**Files:**
- Modify: `src/renderer/app/core/state/browser-approvals-banner.component.ts`
- Test: `src/renderer/app/core/state/browser-approvals-banner.component.spec.ts`

**Interfaces:**
- Consumes: `BrowserApprovalRequest`, `BrowserGrantProposal`, and `BrowserGatewayIpcService.approveRequest()`.
- Produces: narrow per-action/session grant payloads and renderer methods used by the inline template.

- [x] Confirm the existing test reproduces the Review-only autonomous-input state.
- [x] Add regression expectations that an autonomous `input` proposal renders `Allow once`, `Allow for session`, `Deny`, and `More options`.
- [x] Add regression expectations that credential/payment/unknown/submit/destructive proposals render `Deny` and `More options` without quick approval.
- [x] Add payload tests proving `Allow once` sends `mode: 'per_action'`, `autonomous: false`, and only the current classified action.
- [x] Add payload tests proving `Allow for session` sends `mode: 'session'`, `autonomous: false`, and only safe classes already present in the proposal.
- [x] Run the focused spec and confirm the new assertions fail for the current Review-only behavior.
- [x] Implement pure helpers that return `null` for unsafe quick scopes and otherwise narrow the proposal without changing origin, upload, or navigation fields.
- [x] Update the template and copy so denial is always present and advanced review is secondary.
- [x] Restyle the strip with existing warning and surface tokens, visible keyboard focus, and responsive wrapping.
- [x] Run the focused spec and confirm it passes.

### Task 2: Request-scoped advanced approval

**Files:**
- Modify: `src/renderer/app/features/browser/browser-page.component.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.html`
- Modify: `src/renderer/app/features/browser/browser-page.component.scss`
- Test: `src/renderer/app/features/browser/browser-page.component.spec.ts`

**Interfaces:**
- Consumes: the selected `BrowserApprovalRequest`, loaded `BrowserProfile` labels, and `BrowserGatewayIpcService.approveRequest()`.
- Produces: `requiresAutonomousConfirmation(approval)`, `confirmationPhrase(approval)`, and request-scoped confirmation state.

- [x] Add regression coverage proving an autonomous input-only request can be approved without typed confirmation.
- [x] Add regression coverage proving autonomous submit/destructive approval is blocked until the request-specific phrase is entered.
- [x] Add template coverage proving no generic `AUTONOMOUS` field is rendered below the whole approval list.
- [x] Run the focused spec and confirm the new assertions fail for the current global confirmation behavior.
- [x] Replace the single global confirmation string with confirmation state keyed by request ID.
- [x] Derive the phrase from the managed profile label, falling back to the request host for an existing Chrome tab.
- [x] Render confirmation copy and input inside only the high-risk request card.
- [x] Keep ordinary unattended input approval direct and leave proposed scope unchanged.
- [x] Remove the generic global confirmation field and keep any dangerous capability controls visually attached to the request they affect.
- [x] Run the focused spec and confirm it passes.

### Task 3: Coherence and verification

**Files:**
- Modify if needed: `src/renderer/app/features/instance-detail/browser-approval-request.component.ts`
- Modify if needed: `src/renderer/app/features/instance-detail/browser-approval-request.component.html`
- Test if needed: `src/renderer/app/features/instance-detail/browser-approval-request.component.spec.ts`
- Update: this plan and the linked spec
- Create only if required: `docs/superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest.md`

- [x] Check the session-level approval card against the same safety rule. Make only the smallest consistency change needed to prevent a bypass of high-risk confirmation.
- [x] Run all three renderer approval specs together.
- [x] Inspect the diff for widened grant scope, hidden denial, stale generic `AUTONOMOUS` copy, unrelated formatting, and overlap with user changes.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run test:quiet`.
- [x] Update as-built notes in this plan and the linked spec.
- [x] Rename this plan to `2026-07-17-browser-permission-ux_plan_completed.md` only after all agent-runnable checks pass.
- [x] Rename the linked spec from `_spec_planned.md` to `_spec_completed.md`, and update its plan link to the completed filename.

The rebuilt Electron UI checks were moved to [2026-07-17-browser-permission-ux_plan_livetest.md](2026-07-17-browser-permission-ux_plan_livetest.md).

## As-Built Notes

Implemented narrow, non-autonomous quick grants in the global permission banner, with `Deny` always available and high-risk classes withheld from quick approval. The Browser page now keeps unattended options, dangerous-capability toggles, and confirmation text on each request. The instance-level approval card enforces the same request-specific confirmation boundary.

Regression tests were proved red by temporarily restoring each bypass, then restored and run green. The three focused specs pass 35 tests. `npx tsc --noEmit`, the spec TypeScript check, lint, and max-LOC all pass. The full quiet suite passes 14,843 tests in 1,501 files. The production renderer build succeeds with the existing initial-bundle budget warning. No Browser Gateway policy, classification, matching, audit, or YOLO main-process behavior changed.

The live interaction checks require a rebuilt or restarted Harness instance and are recorded in the linked live-test document.
