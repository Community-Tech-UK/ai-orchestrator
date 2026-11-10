# Revived-session input provenance (LT-728): installed-app check

> **Found a defect while running these checks?** Record a reproduced defect in
> [the remediation register](livetest-remediation-register.md), with an index row and observed behaviour,
> root cause, required behaviour and acceptance. Add implementation notes to an active follow-up plan;
> do not add new work to a completed plan. The original remediation implementation is
> [recorded here](2026-07-19-livetest-failure-remediation_plan_completed.md).
> Keep per-check evidence in this file. Before running a campaign, read
> [the campaign runbook](livetest-campaign-runbook.md).

Plan: [revived-session input provenance](2026-11-07-revived-session-input-provenance_plan_completed.md).
Defect: [LT-728](livetest-remediation-register.md#lt-728).

**Status:** closed 2026-11-09. Check 2 (provider switch) passed live. Check 1 (crash-revived session) was not run: no crash-revived session existed, and James waived it on 2026-11-09 to sign this off. It is unverified live; the unit and integration tests cover it.

**Prerequisites:** James rebuilds and restarts the installed Harness with this change. Do not restart it for him.
Read-only inspection of `~/Library/Application Support/harness/conversation-ledger/conversation-ledger.db`
(`sqlite3 -readonly`) and `logs/app.log` is allowed; never write to either. No browser is needed.

**Why deferred:** the fix changes how the running app publishes and saves events. Unit and integration tests drive
the real bridge, ledger, tool server, recovery redaction and provider switch, but only the rebuilt app proves a real
revived session and a real provider switch.

## 1. A crash-revived session saves typed messages and can use Harness tools

1. Find a session revived by crash recovery after the restart: its `InstanceLifecycle` "Creating instance" log line
   shows `historyThreadId: "[recovery history identity omitted]"`. Prefer a Codex session, since Codex is `enforce`
   on this machine. If none exists, record that and leave this check open; do not crash the app to make one.
2. James sends any short message in it. The session calls `get_setting` for `workloadLevel`.

**Expected:** the call succeeds. The ledger has a `user` row with that message, `metadata.instanceId` equal to the
session's instance id, on the session's conversation.

## 2. A provider switch takes the destination provider's evidence mode

1. In an ordinary session on Claude (`off`), switch the provider to Codex (`enforce`) through the normal model picker,
   then send a message. The session calls `get_setting`.
2. Switch the same session back to Claude, send a message and call `get_setting` again.

**Expected:** both calls succeed. After the switch to Codex, new rows for the session (user, assistant, tool) appear
in the ledger; after the switch back to Claude, Harness tools still work.

Record the build time, instance ids, exact tool results and ledger rows for each check.

## Evidence — 2026-11-07 09:19Z, after James's rebuild and restart

- Build identity: the fix is in commit `bdf416f21` (09:08Z). The installed `app.asar` was written at 09:09:49 (UK time, equal to UTC
  in November) and contains `harnessPublished` (9 matches); Harness restarted and resumed sessions from 09:09Z.
- **Check 1: not run, no subject.** The 26 sessions created since 09:09Z were ordinary restores; none has the
  crash-recovery creation log (`historyThreadId: "[recovery history identity omitted]"`). Per the prerequisites, no
  crash was staged. Still open.
- **Check 2: not run, Codex unavailable.** The three Codex sessions restored at 09:18Z (`xm1xtfgkr`, `xcunhzsax`,
  `xpxe7oytc`) were each parked on the Codex provider limit straight away, resuming at Sun 8 Nov 12:21Z. Their park
  notices were saved to the ledger (the `enforce` capture path is running); no typed message has been sent to them.
  Still open until Codex usage is available.
- No ledger or settings writes were made; inspection was read-only.

## Evidence — 2026-11-09 16:45Z, check 2 passed

- Build identity: installed `/Applications/Harness.app/Contents/Resources/app.asar` written 2026-11-08 20:50:39 GMT,
  contains `harnessPublished` (13 matches).
- Subject: ordinary (not crash-revived) session, instance `c4hvnma0n`, ledger thread
  `189f2f25-eafe-4ab2-85b8-1de447d6e9fc`. Started on Claude; a baseline `get_setting(workloadLevel)` returned 5 and the
  ledger had no rows for it (Claude is `off`).
- Switch to Codex: `RuntimeReconciler` "Runtime change applied" at 16:41:37Z (`provider: codex`, pid 82802,
  `continuity: replay`). James's typed message was sent at 16:42:47Z (`sendInput`). Ledger rows, all with
  `metadata.instanceId = c4hvnma0n`: seq 11 `user` "Read the workloadLevel setting with get_setting and tell me the
  result." (16:42:47Z), seq 12 `tool` "Tool orchestrator/get_setting completed" (16:42:55Z), seq 13 `assistant`
  "`workloadLevel` is **5**…" (16:42:57Z). Tool result: `{"key":"workloadLevel","value":5}`.
- Switch back to Claude: "Runtime change applied" at 16:45:06Z (`provider: claude`, model `opus`, pid 2326,
  `continuity: replay`). On Claude, `get_setting(workloadLevel)` returned
  `{"key":"workloadLevel","value":5,"restartRequired":false,"writable":true,"policyTier":"open"}` with no refusal.
  No new ledger rows after 16:45:06Z, as expected for `off`.
- Observation, outside the check's steps: the automatic replay turn Codex ran straight after the switch (before any
  typed message; only the seq 1 provider-change `system` row existed) had its `get_setting` refused with
  `EVIDENCE_CAPTURE_REQUIRED` / `SOURCE_MESSAGE_MISSING` (seq 5, 16:42:02Z). Once James typed a message, calls
  succeeded. An unrelated stray switch to Copilot (`claude-opus-5`, "not available") at 16:43:47Z reverted to Codex
  two seconds later.
- **Check 2: passed.** Check 1 remains open (no crash-revived subject).
- Inspection of the ledger and `app.log` was read-only; no settings were written.
