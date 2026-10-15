# OpenCode startup remediation — deferred packaged acceptance

> **Found a defect while running these checks?** Record a newly reproduced defect in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row, observed
> behaviour, root cause, required behaviour, acceptance) and add matching implementation status
> to an active remediation plan. Keep per-check evidence in the owning live-test document
> [2026-10-13-opencode-launch-environment_livetest.md](2026-10-13-opencode-launch-environment_livetest.md)
> and in this file. Read [livetest-campaign-runbook.md](livetest-campaign-runbook.md) before
> running a campaign. Never rename any of these `_livetest.md` files to `_livetest_completed.md`
> unless every check in them passes with current evidence.

Plan: [2026-10-13-opencode-startup-remediation_plan.md](2026-10-13-opencode-startup-remediation_plan.md)

**Status — 2026-10-14:** Open. Three packaged acceptance checks remain unrun: the two LT-704
smokes (provider-default and High thinking in `~/work/12steps`) and the LT-705 communitytech
smoke. Code remediation is implemented and independently verified; the checks' install/restart
prerequisite is now satisfied (provenance below), so only the smoke runs themselves remain.
They are shared with the [launch-environment packaged live check](2026-10-13-opencode-launch-environment_livetest.md)
(plan-designated evidence home) and the [original effort-variant owner](2026-10-13-opencode-effort-variant-startup_livetest.md).
Run them **once**; record the per-check evidence in the launch-environment document, link it
back to the effort-variant owner, and tick the boxes in all three documents from that one run.

**Branch-recorded mirror (2026-10-14).** Active `_livetest.md` documents are never committed
(the plan-spec guard and the landing squash in `src/main/plan-queue/plan-queue-squash.ts`
refuse them), so this file cannot be reached from a checkout of the work branch. The identical
deferred procedure (prerequisites, exact steps, expected results, why deferred) is therefore
also recorded inline in the remediation register's
[LT-704](livetest-remediation-register.md#lt-704-deferred-packaged-acceptance) and
[LT-705](livetest-remediation-register.md#lt-705-deferred-packaged-acceptance) sections, which
are committed with the branch. Keep the two copies identical and never weaken either; this
file remains the campaign runbook and per-check evidence home.

## Prerequisites and why deferred

Which instance: the installed packaged Harness at `/Applications/Harness.app` that James uses,
with his normal account. Prerequisites and their current state (verified 2026-10-14; receipts
`_scratch/opencode-startup-remediation-queue-worker-20261014-bf56b9/`):

- **A build containing the LT-704 discovery repair and the LT-705 OpenCode-2 refusal is
  installed and the app restarted after it — satisfied.** Read-only provenance: the archive
  `app.asar` was installed 2026-10-14 13:00:28 UTC and contains both repairs
  (`getSafeEnvForTrustedProcess` discovery merge; `MAX_SUPPORTED_OPENCODE_MAJOR` refusal with
  its plain message); its compiled `dist/main/cli/adapters/opencode-cli-launch.js` is
  byte-identical (sha256 `9c5cd822…`, 6,115 bytes) to the verified worktree build; the
  production log shows `App Initializing Harness` at 13:08:32 UTC and `Harness initialized` at
  13:08:52 UTC — after that install. Limitation: archive-on-disk plus boot-after-install
  provenance; loaded process memory is not established. Re-check this provenance if the app has
  been rebuilt or restarted since 2026-10-14 13:08 UTC.
- **OpenCode 1 opens both target folders (LT-705 machine repair holds) — satisfied.**
  `opencode debug config` exits 0 in `~/work/communitytech` and `~/work/12steps` (2026-10-14,
  output discarded).

Why the checks themselves are deferred: each needs a disposable session created in the packaged
app with interactive account/model/thinking selection and James's signed-in ComTechSpare
account. No agent-reachable surface can do that. `aio-mcp` exposes `settings`, `remote-nodes`,
`release-readiness`, `local-ai`, `copilot-account`, `browser-credentials`, `loop` and MCP
forwarders only — no session-create or prompt-send command (docs/AIO_MCP_CLI.md) — and the
orchestrator-tools toolset has none either; Harness desktop control is hard-denied, and the
thin-client/mobile gateways are user remote-control surfaces with no sanctioned agent flow.
Agent-side verification of the same runtime behaviour already exists (source and compiled
factory default/High real replies confirming the exact routed account/model — see the plan);
these checks confirm the installed app's own session path.

## Checks

- [ ] **1. LT-704 provider-default smoke (12steps).** In the running packaged Harness, create a
  disposable session in `/Users/suas/work/12steps`. Select OpenCode, MiMo-V2.6-Pro, account
  ComTechSpare (Amsterdam), and provider-default thinking. Send exactly
  `Reply with exactly OK. Do not use tools or change files.`
  Expected: startup succeeds, ComTechSpare and MiMo-V2.6-Pro remain selected, and the session
  responds `OK` without a model-limit or selected-model-confirmation error. Retain safe startup
  evidence and build provenance in the owning live test; never record native configuration,
  credentials or unrelated task content.
  Why deferred: packaged-app UI session creation on James's account is not agent-runnable
  (see above). Owner: [launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md)
  check 1; [original owner](2026-10-13-opencode-effort-variant-startup_livetest.md).
- [ ] **2. LT-704 High-thinking smoke (12steps).** A second, otherwise identical disposable
  session with High thinking, same prompt. Expected: startup and response succeed; High thinking
  and ComTechSpare remain selected. Record the observed selections and reply, then end only the
  disposable smoke sessions. A default-thinking failure does not establish a High-thinking
  failure. Same deferral and owner as check 1 (launch-environment live check check 2).
- [ ] **3. LT-705 communitytech smoke.** Repeat check 1 in `/Users/suas/work/communitytech`.
  Expected: startup succeeds on OpenCode 1 with ComTechSpare and MiMo-V2.6-Pro retained, and the
  session replies `OK`. Owner: [launch-environment live check](2026-10-13-opencode-launch-environment_livetest.md)
  check 3.

## Evidence

No passing run yet. A 2026-10-13 packaged run of the LT-704 default check in
`~/work/communitytech` failed with the LT-705 cause; that history lives in the
[launch-environment packaged live check](2026-10-13-opencode-launch-environment_livetest.md)
and is not a pass of these checks. Record future runs here and in the owning document as dated
`## Evidence run — <date>` sections; never rewrite history.
