# Plan Queue provider and account control: live checks

Status: pending a rebuilt and restarted app. All code, tests, lint, builds and repeated independent
fresh-eyes reviews have passed (see the plan's as-built notes for each round).

Plan: [2026-10-13-plan-queue-provider-account-control_plan_completed.md](2026-10-13-plan-queue-provider-account-control_plan_completed.md).

Prerequisites: a rebuilt app containing this change, installed or restarted only with James's
approval (never restart Harness with live sessions). Browser/UI work uses the Browser Gateway
against `windows-pc` or James himself; no Mac browser/desktop control is authorised. Run queue
checks against a scratch repository first, never the real backlog
([2026-09-18-plan-queue_livetest.md](2026-09-18-plan-queue_livetest.md) check 7 explains why).

Remediation flow: read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before running
these. A reproduced defect goes in [livetest-remediation-register.md](livetest-remediation-register.md)
as a new `LT-NNN` item; keep per-check evidence here. Never edit a `_completed` document.

## 1. Saved choice on the Plan Queue page

- [ ] Open the Plan Queue page. The "Providers and accounts" section shows Workers ("Same as the
      session that starts the run" / "Always use") and Checkers ("Choose automatically" / "Only
      these, in this order").
- [ ] Choose Workers → Always use → Codex, tick one Codex account; Checkers → Only these → Claude.
      Save. Expected: "Saved. New runs will use these choices." and
      `$AIO_MCP settings get planQueueRouting` shows the value.
- [ ] Copilot (on the never-auto-pick list) is greyed out with "on your never-auto-pick list";
      a manual-only account is greyed out with "manual only".

Why deferred: needs the rebuilt renderer in a running app; headless component tests cover the logic.

## 2. A run follows the saved choice

- [ ] From any session in a scratch repository, start a run (`plan_queue_start`, kind plans).
      Expected: `plan_queue_status` shows `routing: { workers: "codex (accounts: <id>)",
      checkers: "claude" }`; the Plan Queue run list shows the same line.
- [ ] The worker session runs on Codex on the chosen account (session header account chip), and
      the checker runs on Claude, not Copilot, even though this repository matches a protected
      Copilot owner rule (saved list replaces the work seat).
- [ ] In `app.log`, the `account_route_resolved` events for the queue sessions carry
      `origin: "automation"` (worker/triage) and `"verification"` (checker).

Why deferred: needs real provider CLIs, signed-in accounts and a running app.

## 3. Inheriting the starting session

- [ ] Clear the saved choice (Workers: Same as the session; Checkers: Choose automatically).
      Start a run from a Claude session on a non-default, automation-allowed account. Expected:
      the worker runs on that same account; a usage limit parks the item rather than moving it
      to another account.

Why deferred: needs a pooled account set-up and a real session.

## 4. Refusals

- [ ] `plan_queue_start` with `verifiers: [{ provider: "copilot" }]` while Copilot is on the
      never-auto-pick list is refused with the plain-English reason; no run is created.
- [ ] In this repository (protected Community-Tech-UK Copilot rule), `plan_queue_start` with
      `verifiers: [{ provider: "claude" }]` is refused with "checkers given for one run cannot
      replace the work seat here"; the same checker saved on the Plan Queue page is honoured.
- [ ] `plan_queue_start` with a misspelt key (`worker: { provider: "claude", accounts: [...] }`)
      is refused by the tool's argument validation.

Why deferred: exercises the live MCP tool surface of the rebuilt app.
