# Saved login access approvals

Status: completed 2026-10-06. Implementation and independent verification passed (Plan Queue verifier PASS; plan landed as `028e824ba`). Requirement 6's windows-pc approval → sign-in proof and requirement 7's installed-update activation are deferred live checks in the [live-test document](2026-10-05-saved-login-access_livetest.md), pending a safe app restart.

Implementation plan: [Saved login access plan](2026-10-05-saved-login-access_plan_completed.md).

## Outcome

A session blocked from secure filling an existing Bitwarden login can ask through its available browser tool. Harness shows a visible approval with the requesting session, reason, exact website and computer, saved-login title, requested purposes and lifetime, and any agent-folder movement. Approve performs enrolment and authorisation through the existing services; Deny grants nothing. The originating session receives a truthful decision and can retry secure fill without copying commands.

## Requirements

1. Browser-tool and credential CLI request routes share the same main-process permission service. Repair provider shell connection propagation on supported launch/resume paths.
2. Requests remain pending until an explicit operator decision, including YOLO. Existing valid permissions can be reused only within their actual scope. Manual handoffs, escalations and browser read grants are never credential authority.
3. Default to the requesting current task. Bind new permission to exact origin, computer/profile, saved item and purposes. A separate explicit limited remember choice may outlive the task. Preserve secure fill, vault locking, folder jail, exact binding and all existing restrictions.
4. Persist a real reference and pending/approved/denied/expired states; handle cancellation, repeats, resumption, concurrent decisions, navigation and disconnected workers without duplicate prompts or actions.
5. Keep passwords and connection capability values out of responses, logs, screenshots and command arguments. Show only login metadata to the operator.
6. Independently verify approval/denial, expiry/revocation, wrong origin/computer, pending navigation, locked vault, movement and deduplication. Prove the visible approval → secure fill → authenticated-page flow on windows-pc only after James accepts an actual credential request.
7. Run all canonical gates and a fresh task-completion-gate review. Use the normal application update route without stopping unrelated sessions. Report any restart/reconnection requirement and exact continuation.

## Constraints

Existing checkout and dirty baseline retained. No branches, worktrees, commits or pushes. Do not directly edit permission records or borrow another session's transport credentials. Existing edits in browser-auto-approve.ts and browser-gateway/index.ts belong to another session and must be preserved.

## Initial evidence

- Windows Browser Gateway health reports a fresh, deliverable extension channel.
- Browser fill tools prescribe the CLI authorisation route and have no credential-access request tool.
- Manual handoffs propose read-only grants, which the generic YOLO predicate can approve without creating credential authorisation.
- Saved login metadata confirms the BabyLoveGrowth login is outside the agent folder and its saved login URI is https://www.babylovegrowth.ai. No secret values were emitted.
- Local Codex configuration uses shell_environment_policy inherit=core; the provider-home preparation retains that policy while Harness injects transport variables into the process environment. Provider investigation is confirming safe preservation of the session's bridge variables.

## Review and execution

James already authorised the implementation and independent review. Process-only approval gates are overridden by his decision-autonomy instructions. Maintain a linked implementation plan untracked throughout implementation.
