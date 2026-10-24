# Restart onto a limited account: installed-app live check

Status: pending external validation.

Prerequisites:
- Install a build containing this fix.
- Restart that Harness instance only when its active sessions can safely be interrupted.
- Use the existing automatic, acknowledged Codex pool, with paid overage left disabled.
- One Codex account must be at a genuine usage limit, and another signed-in Codex account must have usage left. The `chatgptcomtech-e73d` weekly limit runs until 25 October 2026.

Plan: [restart onto a limited account](2026-10-19-restart-limit-account-switch_plan_completed.md).

Follow-up plan: [closing the known residuals](2026-10-19-restart-limit-account-switch-gaps_plan_completed.md).

Remediation flow:
- Before running a live campaign, read [the campaign runbook](livetest-campaign-runbook.md).
- Record a reproduced defect as a new LT-NNN index row and a full acceptance entry in [the remediation register](livetest-remediation-register.md), with a matching implementation-status section in [the remediation plan](2026-07-19-livetest-failure-remediation-followup_plan.md).
- Keep per-check evidence here.
- Rename this document `_livetest_completed.md` only after every check passes.

- [ ] **Restart lands on the other account.**
  - Steps: restart a Codex session that is pinned to the limited account.
  - Expected:
    - app.log shows `Restarting a session on another account: its own account has a known usage limit`.
    - `account_route_resolved` shows the other profile with `routingSource: "failover"`.
    - The session header shows the new account.
    - An "Account switched" notification names both accounts.
    - No quota-park banner appears.
- [ ] **Queued child reports wait, then arrive.**
  - Steps: use a parent session with child sessions that finish while the parent is stopped or limited.
  - Expected:
    - No "Orchestration … was not delivered to the agent: You've hit your usage limit" errors appear.
    - Each report reaches the parent after it runs on the account with usage left.
    - app.log shows `Automated write suppressed … reason: provider-limited` while the reports are held.
- [ ] **A busy session still switches.**
  - Steps: send a message to a session on the limited account while it is busy with queued deliveries.
  - Expected:
    - app.log shows `Account failover finished … outcome: switched` within about a minute.
    - If the switch does not happen, the same line names the reason and each considered account's veto.

Why deferred:
- The routing, hold, requeue and settle-wait behaviour is covered by automated specs, including an end-to-end replay of the 2026-10-19 sequence through the real admission service, limit handler and ledger.
- Observing it in the installed app needs a rebuilt and restarted Harness and a real provider limit.
- Harness must not be restarted while James has live sessions.
