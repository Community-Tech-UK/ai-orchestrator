# Live-test campaign defects — deferred live acceptance

> **Found a defect while running these checks?** Record a newly reproduced defect in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row,
> observed behaviour, root cause, required behaviour, acceptance) and add matching
> implementation status to the active remediation plan. The historical
> `2026-07-19-livetest-failure-remediation_plan_completed.md` is closed; do not edit it.
> Keep per-check evidence here and in the owning live-test document.
> Read `docs/plans/livetest-campaign-runbook.md` before running a campaign.

Plan: [2026-10-05-livetest-campaign-defects_plan.md](2026-10-05-livetest-campaign-defects_plan.md)

**Status — 2026-10-13:** 16 live acceptance checks remain open. LT-682 requires only
the passing component regression, so it has no deferred check here. Earlier dated
evidence in the owning documents remains valid history, not evidence for this build.

**Prerequisites and execution boundary:** Run after independent queue verification
and coordinator integration, against an app rebuilt from the integrated source.
Record its commit/build, instance/profile, provider/CLI version, instance IDs and
timestamps. The running Harness does not contain this worker's unintegrated changes.
The worker did not restart or control Harness: the current Computer Use rules
hard-deny that application. James supplies the Harness rebuild/restart or an
approved independent runtime for these checks. No Mac browser fallback is authorized.
Browser checks must preflight worker and extension health via the AIO Browser Gateway
and explicitly target `windows-pc`. If unavailable, report the health result and
leave the check open. Do not infer an unreadable state from a transport error.

All pure logic, database transactions, adapter event replay, renderer stores and
queue tracking are tested in-loop. The deferred work below specifically tests the
rebuilt runtime, real provider processes, authenticated browser state or app restart.
It is not a deferral of unit tests, static checks, generators or builds.

## 1. LT-670 — circuit-breaker backoff survival

- [ ] On a disposable root Claude session, perform four idle provider crashes
  within one hour. Before each `kill -9 <pid>`, check that the PID was created for
  this check, is the session's provider process, is parented by the disposable
  Harness process, and its command line names the expected CLI. Wait for recovery
  between kills. At attempt four, observe through the 30-second backoff and the
  following recovery window.
- Expected: the session is never force-terminated while waiting; recovery posts
  the reconnect/restart notice. Re-run crash-turn LT-C, including user takeover.
- Why deferred: real provider crash and rebuilt renderer watchdog, requiring an
  independent disposable Harness runtime. Owner: crash-turn auto-continue LT-C.

## 2. LT-702 — settled ping-pong reviewer

- [ ] Run at least ten consecutive real ping-pong reviewer rounds with a Claude
  builder and Codex reviewer. Set `pingPong.reviewerTimeoutSeconds` to 900 and
  retain spawn/verdict timestamps; do not use `crossModelReview.timeoutSeconds`
  as the reviewer budget.
- Expected: each round logs `Ping-pong reviewer produced a verdict` within 120
  seconds of reviewer spawn; no round remains in flight after its reviewer settles.
- Why deferred: real reviewer timing and provider calls in the rebuilt app.
  Owner: LT-702 acceptance, without editing the closed ping-pong document.

## 3. LT-665 — unreadable authenticated browser

- [ ] On `windows-pc`, select an existing tab that demonstrably returns a live
  `host_permission_denied` or `page_text_read_failed` observation. Record the URL
  and browser audit position, call `browser.check_session` with
  `autoRelogin: true`, then re-read the URL and audit. Use the gateway's discovered
  shared-tab request schema, not a managed browser profile.
- Expected: `state: unknown` with the specific reason, unchanged URL, no
  `fill_credential` audit entry and no parked escalation. On a readable signed-in
  page with missing recipe markers, likewise expect `unknown` and no navigation.
- Why deferred: real extension permissions and an existing authenticated tab.
  Owner: browser-login-recipe-persistence check 1.

## 4. LT-680 — input joined into a Codex goal turn

- [ ] In a disposable root Codex session create an eight-turn goal, one animal
  paragraph per turn. Six seconds into a provider-started turn, send a plain
  composer message requesting a unique prefix such as `MIDJOIN` in the response.
  Retain the rollout and Harness transcript/lifecycle timestamps.
- Expected: the reply appears in the transcript; no `busy -> idle` between the
  accepted steer and real `turn/completed`/`task_complete`; send completion waits
  for the actual turn completion.
- Why deferred: native Codex goal scheduling and sampling boundaries.
  Owner: codex-compaction-reliability check 4.

## 5. LT-690 — scoped OpenCode output ceiling

- [ ] Re-run provider-hardening check 1 step 2 on the scoped MiMo Token Plan
  model in an unpaused root OpenCode session outside a managed loop. Ask it to
  spell successive integer names until it reaches the injected combined output
  cap. Record output/reasoning usage and the `ACP turn completed` metadata.
- Expected: `classifierReason: max_output`, Harness `budget_saturated` evidence,
  a safe notice and no more than two automatic prompts. Ordinary bounded answers
  remain ordinary completions. Logs contain metadata, not thinking/task text.
- Why deferred: the installed OpenCode ACP mapping and a real capped model turn.
  Owner: provider-hardening check 1.

## 6. LT-671 — fresh-session crash replay

- [ ] Repeat five times on brand-new disposable root Claude sessions: start a
  long first turn, kill only that session's verified provider PID within its
  first few seconds, and observe a recovery that actually uses `fresh-replay`.
  Keep orchestration unpaused and the session outside managed loops.
- Expected: every fresh-replay recovery sends exactly one continuation and posts
  `Continuing the interrupted turn automatically (attempt 1 of 2)`.
  If intentionally testing a paused refusal, expect a metadata-only
  `Crash continuation reservation refused after recovery` warning and no send.
- Why deferred: real first-turn resume failure and replay timing. Owner: crash-turn LT-A.

## 7. LT-673 — renderer reload with sessions open

- [ ] Open three sessions, reload/reopen the rebuilt renderer three times, and
  inspect the session rail, loading state and `stateResync` results each time.
- Expected: all three sessions repopulate without manual refresh; an injected
  persistent resync failure clears loading and displays an error.
- Why deferred: preload auth-token initialization in a restarted window.
  Owner: session-title-quality reload check.

## 8. LT-700 — verifier restart waits for tools

- [ ] Run Plan Queue check 3, quitting normally while one disposable item is
  `verifying` and another `awaiting-slot`. Relaunch the rebuilt app and retain
  orchestrator-tools listening, verifier spawn and verdict log timestamps.
- Expected: tools listen before the recovered verifier spawns; its MCP config
  includes orchestrator tools; it calls `plan_queue_report_verdict` and reaches
  an ordinary verdict/landing, never missing-verdict `verifier-unreliable`.
- Why deferred: real application initialization ordering and verifier MCP discovery.

## 9. LT-701 — normal quit during two worker turns

- [ ] Run Plan Queue check 3 with two disposable items actively `working`,
  recording item states and their existing `queue/...` branches. Quit normally
  while both workers are busy, then restart. Exercise the normal sync cleanup
  followed by async cleanup, not just a synthetic `terminated` status.
- Expected: no shutdown-caused worker-error park or completed run. After restart
  both items are `working`, with new workers, restart-resumption instructions
  and the same branches. Let the run complete normally afterwards.
- Why deferred: app quit/restart, real provider exit/removal events and durable recovery.

## 10. LT-666 — session-wide login fingerprint

- [ ] On `windows-pc`, use the authorized saved-login/secure credential routes
  and re-record the In-tend recipe with markers visible throughout the session
  (account name/logout affordance). Check both home and tender-details pages
  with `autoRelogin: false`, then repeat login-recipe checks 1 and 2. Do not type
  secrets or infer login success. A credential/MFA boundary uses escalation.
- Expected: both pages report `logged_in / fingerprint_matched`. Invalid markers
  are rejected with guidance. A readable login URL with no password field stops
  without a fill and reports `markers_not_matched_on_signed_in_page`.
- Why deferred: persistent user recipe and real authenticated page variants.

## 11. LT-664 — retired Local AI incident cleanup

- [ ] After rebuild/restart, use `$AIO_MCP local-ai status --json` and inspect
  the formerly stale `51c88683-…` incident. In a disposable target fixture, open
  and acknowledge incidents, retire the target, then query status again.
  Re-enrol the fixture and query once more.
- Expected: no open/acknowledged incidents for the retired target; the old
  incident is resolved by startup cleanup; re-enrolment begins clean. A failure
  closing an incident rolls back retirement (covered by the database regression).
- Why deferred: startup against existing persisted data and the rebuilt Local AI
  runtime. Do not retire James's active endpoints for this test.

## 12. LT-672 — Claude user Stop

- [ ] Start a long turn on a disposable resident Claude session and press Stop.
- Expected: idle, interrupt notices only, no provider-error notice or automatic
  continuation; completion evidence is `client_cancelled`.
- Why deferred: the real Claude interrupted-result shape. Prior Codex Stop
  evidence does not establish this provider's result. Owner: crash-turn LT-B.

## 13. LT-674 — resident Claude errored completion

- [ ] Repeat outstanding-plans-sweep check 3 using its isolated-runtime staging
  of a legacy `type: error` message into a resident Claude adapter mid-turn.
  Query provider-event captures, cost recording and Stop-hook evidence.
- Expected: exactly one `adapter-event:complete` with `turnErrored: true`, one
  cost recording and a Stop hook with `stopReason: error`, before adapter cleanup.
- Why deferred: real instance-manager/capture/hook wiring in the rebuilt runtime.

## 14. LT-675 — signed-out title provider

- [ ] Start an isolated rebuilt runtime with `CLAUDE_CONFIG_DIR` pointing to a
  new empty scratch directory, leaving James's normal CLI configuration alone.
  Create a session with a meaningful task and inspect its title and escalation.
- Expected: no sign-in banner as title; retain the instant title or use a valid
  title from the next permitted provider.
- Why deferred: one-shot CLI auth output and provider availability in the rebuilt app.

## 15. LT-681 — manual Codex compaction

- [ ] Bring an idle disposable Codex session to about 30% measured occupancy;
  choose Compact now with no queued message and observe the meter/boundary row
  until the next real usage update, then send a bounded message.
- Expected: retain the last measured reading as estimated with
  `awaiting-post-compaction-usage`; no fabricated `~0%` or `→ 0%`. Real subsequent
  usage replaces the retained estimate.
- Why deferred: a native manual Compact turn lacking fresh occupancy in the rebuilt app.
  Owner: codex-compaction-turn-visibility check 3.

## 16. LT-683 — rapid consecutive native goal turns

- [ ] Repeat several 14-turn root Codex goal runs without steering messages.
  Compare every rollout turn ID with Harness's Following log, transcript and
  lifecycle timestamps, including the shortest gaps between turns.
- Expected: every root turn is followed and all replies are captured; no idle
  interval exceeds the provider's actual inter-turn gap.
- Why deferred: native provider scheduling/teardown timing. The in-loop adapter
  regression covers the overlapping capture case; this checks the installed CLI.

## Evidence and cleanup

For each check record PASS/FAIL, commands/actions, exact observed output, timestamps,
instance/turn IDs and durable evidence paths. Update the owning live-test document
where it remains open. Leave a check unchecked if its preconditions were not met.
Terminate only disposable sessions and restore test settings. Never rename this
document `_livetest_completed.md` until all 16 checks have current passing evidence.
