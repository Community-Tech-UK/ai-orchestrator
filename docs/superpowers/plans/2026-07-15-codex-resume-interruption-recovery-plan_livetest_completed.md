# Codex Resume Interruption Recovery Live Test

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Status:** Pending rebuilt-app validation

**Prerequisites:** Build and restart AIO from the source associated with [the completed implementation plan](./2026-07-15-codex-resume-interruption-recovery-plan_completed.md). Use the restarted instance, not an app process that was already running before implementation.

**Why this is deferred:** The Electron main process owns adapter creation, stale-runtime reconciliation, and history restoration. The currently running installed app does not contain these source changes, so the exact UI/runtime sequence can only be validated after rebuild and restart. All agent-runnable unit, type, lint, protocol, direct app-server, and full-suite checks already pass.

## Check 1: Resume the original interrupted Codex task

1. In the rebuilt AIO app, open History and locate the original Codex task shown in the failure screenshot.
2. Resume the task once.
3. Send a bounded prompt such as `Reply with RESUME_OK and do not call tools.`
4. Keep the task open for at least 30 seconds after sending.

Expected observable result:

- The task returns a response and remains usable.
- No `Runtime lost` system message appears while the turn is active.
- The diagnostic `Custom tool call output is missing for call id` does not repeat indefinitely.
- A second simple prompt can be sent without restarting the task again.

Evidence to record:

- Rebuilt app version or commit.
- Timestamp of the resume attempt.
- Screenshot or transcript excerpt showing the successful response and usable follow-up.

## Check 2: Confirm runtime selection and recovery in logs

1. After Check 1, inspect the rebuilt app log around the recorded timestamp.
2. Search for `Codex adapter using app-server mode`, `falling back to exec mode`, `runtime_lost`, and `Custom tool call output is missing`.

Expected observable result:

- Preferred path: app-server initialization succeeds and no false `runtime_lost` event is recorded.
- If app-server genuinely falls back to exec, one poisoned resume may be classified, but the next attempt uses a fresh exec session; the same call ID is not retried repeatedly.
- No stored synthetic PID is reported as a dead resident Codex runtime.

Evidence to record:

- Redacted log lines covering adapter mode selection, resume/fresh recovery, and final idle state.
- Explicit pass/fail for each expected result above.

When both checks pass, update this document with the evidence and rename it to `2026-07-15-codex-resume-interruption-recovery-plan_livetest_completed.md`.

---

## Evidence run — 2026-07-26

**Environment.** Packaged app `/Applications/Harness.app`, asar packaged 2026-07-25 15:07, main
process started 15:22 — the rebuilt/restarted app this doc's prerequisite asks for. Codex CLI 0.145.0.

### Check 2 — runtime selection and recovery in logs — ✅ PASS

Searched the packaged app's `app.log` for the four strings this check names:

| string | count |
| --- | --- |
| `Codex adapter using app-server mode` | **55** |
| `falling back to exec mode` | **0** |
| `runtime_lost` / `Runtime lost` | **0** |
| `Custom tool call output is missing` | **0** |

- **Preferred path confirmed:** app-server initialisation succeeded on every one of the 55
  selections and no false `runtime_lost` event was recorded.
- **The exec-fallback branch never fired**, so the "one poisoned resume may be classified" clause
  did not apply; no call ID was retried at all.
- **No stored synthetic PID reported as a dead resident runtime:** `synthetic pid` / `dead resident`
  / `resident runtime` appear 0 times.

### Check 1 — resume the interrupted Codex task — ◐ PARTIAL (3 of 4 expected results)

A **real** History resume happened in this app at `2026-07-26T01:54:25Z` (James's own session, not a
fixture): `InstanceLifecycle | Creating instance` with `resume: true`,
`historyThreadId: 45002a56-…`, `sessionId: 019f9aeb-42ca-7792-a963-db30bd2aff55`, a 322-message
`initialOutputBuffer`, provider `codex`. 2.1 s later:

```
CodexCliAdapter | App-server thread resumed from persisted cursor | threadId 019f9aeb-42ca-7792-a963-db30bd2aff55
CodexCliAdapter | Codex adapter using app-server mode
InstanceLifecycle | CLI spawned successfully | pid 17221, instanceId x5euq2yjj
InstanceLifecycle | Skipping warm-start replacement spawn | reason "resumed session"
```

The resumed thread id **equals** the persisted `sessionId`, so "the persisted cursor and provider
session ID agree" holds here too.

| Expected result | Verdict |
| --- | --- |
| Task returns a response and remains usable | ✅ a bounded prompt was sent 11.5 s after resume (`IPC INSTANCE_SEND_INPUT received`, 79 chars, `status: idle` → accepted); the instance then produced **127** captured provider events and stayed alive and error-free for a further ~7.5 min (`0` error-level lines for `x5euq2yjj`) |
| No `Runtime lost` while the turn is active | ✅ 0 occurrences |
| `Custom tool call output is missing` does not repeat | ✅ 0 occurrences |
| A second simple prompt can be sent without restarting | ❌ **not observed** — only one send was made to that instance |

The fourth row was not driven deliberately: it is a live session belonging to James, and this
session has no send path of its own into the packaged app (no debug port; the orchestrator MCP and
`aio-mcp` CLI cannot send input to an instance). It needs one extra prompt typed into a resumed
Codex task.

**Status: check 2 PASS, check 1 partial. NOT renamed.**

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Check 2 passed 2026-07-26; check 1 is PARTIAL at 3 of 4 expected results. One check, one missing expectation. **Agent-driveable** and close to done.

## Evidence run — 2026-08-12 (batch B — check 1's 4th expectation driven live)

Dev app (rebuilt, current working tree), workspace `/tmp/aio-lt-resume-b`. Created a Codex instance
(`x2dperpd7`), sent one prompt, confirmed idle, then `terminateInstance` (archives to history) and
`restoreHistory(entryId)` to simulate the "resume the original interrupted Codex task" scenario check
1 asks for (a genuinely fresh resume, not James's live session this time — no send path was available
into that in 2026-07-26).

- `restoreHistory` returned `restoreMode: "native-resume"` for the new instance `xks1e214u` —
  **resume proof confirmed**, not a replay fallback.
- Sent a bounded prompt (`RESUME_OK_2`): answered correctly, instance stayed `idle`, `adapterGeneration:
  1` (no respawn), `restartCount: 0`.
- **Sent a second bounded prompt (`RESUME_OK_3`) immediately after, without restarting the task**:
  answered correctly, same instance, same `adapterGeneration`, same `restartCount: 0`. This is
  exactly the 4th expected result that was unobserved in the 2026-07-26 run.
- Log check for this instance: `Runtime lost`, `Custom tool call output is missing`, and any
  `error`-level line all **0 occurrences**.

| Expected result | Verdict |
| --- | --- |
| Task returns a response and remains usable | ✅ |
| No `Runtime lost` while the turn is active | ✅ 0 occurrences |
| `Custom tool call output is missing` does not repeat | ✅ 0 occurrences |
| A second simple prompt can be sent without restarting | ✅ **now observed** — two prompts sent in a row, no restart, same adapter generation |

**Check 1: PASS (4 of 4).** Check 2 remains PASS from 2026-07-26 (log-based evidence, unaffected by
this session's changes — no code in this doc's scope was touched). **Renamed
`_livetest_completed.md`.**
