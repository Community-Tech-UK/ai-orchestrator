# Remote worker Claude policy and Codex exit: windows-pc live check

Status: pending external validation.

Prerequisites:
- Commit this change (James to authorise) and push it, so the windows-pc worker auto-update picks it up. Before
  running, `list_remote_nodes` must show windows-pc with a `workerAgent.buildCommit` that contains the change (it was
  `bca871e` on 2026-10-19, which does not).
- Install or rebuild a Harness containing the change on the coordinator, and restart it only when its active sessions
  can safely be interrupted. Both sides need the new build: the coordinator sends the policy and checks the worker's
  `claudeSpawnPolicy` capability; the worker applies the policy and stops forwarding per-turn Codex exits.
- Run from an agent session in that Harness (so `run_on_node` sets the `node-run` machine session).

Plan: [remote worker Claude policy and Codex exit](2026-10-19-remote-worker-claude-policy-and-codex-exit_plan_completed.md).

Remediation flow:
- Before running a live campaign, read [the campaign runbook](livetest-campaign-runbook.md).
- Record a reproduced defect as a new LT-NNN index row and a full acceptance entry in [the remediation register](livetest-remediation-register.md), with a matching implementation-status section in [the remediation plan](2026-07-19-livetest-failure-remediation-followup_plan.md).
- Keep per-check evidence here.
- Rename this document `_livetest_completed.md` only after every check passes.

- [ ] **Remote Claude runs from an agent session.**
  - Steps: `run_on_node { node: "windows-pc", provider: "claude", prompt: "Reply with just the word READY." }`, then
    `read_node_output` until idle, then `terminate_node_instance`.
  - Expected:
    - No "Remote Claude execution cannot enforce read-only review, machine-session policy or turn/context limits"
      error.
    - Exactly one READY reply; the instance settles idle.
- [ ] **Remote Codex one-shot ends cleanly.**
  - Steps: `run_on_node { node: "windows-pc", provider: "codex", prompt: "Reply with just the word READY." }`, then
    `read_node_output` until idle, wait a further minute, read again, then `terminate_node_instance`.
  - Expected:
    - Exactly one READY reply; the instance settles idle and stays idle.
    - No "Session restarted automatically (resume failed)" message, and no repeated READY.
    - The coordinator app.log has no `Adapter exit event code 0` with `previousStatus: busy` for that instance.
- [ ] **A second Codex turn on the same remote instance still works.**
  - Steps: before terminating the Codex instance above, send it a second short prompt.
  - Expected: one reply to the second prompt, then idle; no restart message.

Why deferred:
- The guard, policy carriage, worker adapter construction, per-turn exit handling and interrupt idle are covered by
  automated specs, including a worker integration spec that runs a Codex exec turn through `LocalInstanceManager`.
- Observing it end to end needs a pushed commit for the windows-pc auto-update and a rebuilt, restarted Harness.
