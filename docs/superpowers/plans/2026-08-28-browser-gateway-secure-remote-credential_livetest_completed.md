# Browser Gateway Secure Remote Credential Workflow — Live Test

## Status — completed by consolidation 2026-09-27

Open: 0 · Closed: 3 · Transferred residual campaign: 1 · Failed: 0

Check 1 closes on the 2026-09-24 current-code deployment-integrity evidence; its one-time 0.2.18
Meta/Instagram tab-preservation clause is obsolete and cannot be recreated after the worker and tab
inventory moved on. Browser Gateway health on 2026-09-27 reports `windows-pc` ready on v0.2.36.
Checks 2–3 passed. Check 4's real extension-bound origin and escalation assertions are preserved in
[RES-022](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-022--secure-browser-credential-origin-and-escalation-boundaries), where later credential-login documents should add only non-duplicate steps.

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-08-28-browser-gateway-secure-remote-credential_plan_completed.md](2026-08-28-browser-gateway-secure-remote-credential_plan_completed.md)

**Prerequisites used:** the existing `AI Orchestrator Worker` Scheduled Task on `windows-pc`; the
coordinator/forwarder rebuilt and restarted from this checkout; the unpacked Harness Browser
Gateway extension reloaded without restarting Chrome. The existing Meta/Instagram sessions are
preserved throughout. No real account, vault item, credential grant, or password is created by any
check here.

## Status — 2026-09-06



> **⚠ Check 1 cannot pass as written — corrected 2026-09-06.**
>
> 1. It pins extension version `0.2.18` and its `background.js` / `manifest.json` hashes
>    (steps 4 and the evidence line below). The repo now ships `0.2.19`
>    (`resources/browser-extension/manifest.json:4`) and `windows-pc` is live on `0.2.19`.
>    Those hash values are stale by construction and can never match. Re-derive them
>    against 0.2.19 before running.
> 2. The blocker was "`windows-pc` disconnected". It is connected as of 2026-09-06 05:18,
>    relay registration `ok`, extension reloaded 11:05. Steps 1, 3 and 4 are now reachable.
>
> Separately, the operator punch-list claims a signed candidate
> `Harness.secure-credential-gate19.app` is "staged and waiting" to be installed. **It does
> not exist.** `/Users/suas/Applications/` holds no such bundle, and none of the four
> `app.asar` hashes present on this machine matches the `0a7289f1…` recorded in the plan.
> Nobody is waiting on James to install *that* bundle. A current signed build does exist —
> `release/Harness-0.1.0-mac-arm64.dmg`, built 2026-09-06 11:24, same `TeamIdentifier`
> `GJL9WJ4S4W` as the installed app — so what remains is choosing an artifact and agreeing a
> window to replace the running app, not producing one. Local signing is agent-operable: no
> interactive Apple ID step was needed for either existing signed build.
Open: 2 · Closed: 2 · Failed: 0

Check 1 needs `windows-pc` reconnected/restarted and its roster re-verified — agent-runnable now
via the Browser Gateway on that worker, no human required. Check 4 is flagged for a human decision
(see Recommended for deletion) rather than being run or dropped unilaterally.

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| 2. Codex tool surface is eager from a fresh runtime, no dynamic reveal needed | 2026-08-30 | Disposable instance `xssrzck4q`; first `functions.exec` cell returned `AIO_LT_EAGER_SURFACE_20260830 {"allToolsPresent":true,"callablePresent":true,"missingAllTools":[],"missingCallable":[]}`; app log `Browser gateway tool schemas injected eagerly` ×2, `toolCount: 42`, `schemaBytes: 43880`; `browser.health` reports `schemaMatch: true`, `42/42` for every session; `create_agent_credential` schema exposes non-secret `itemTitle`/`loginUri` |
| 3. Secure register boundary is reached, nothing is created | 2026-08-30 | Read-only preflight selected the real Meta Business Suite target at `https://business.facebook.com`, rejecting 9 other-origin tabs; `browser.list_grants` = 0 before; test call with `loginUri: "https://example.invalid/"` returned `credential_not_authorized:no_authorization_for_profile`, `decision: denied`, `outcome: not_run`, `auditId: 43e538a5-3e7b-4cf4-9ab5-7c03fb7fc4f2`; grants still 0 after; audit row `redactionApplied: true`; write journal unchanged |

## Historical outstanding checks

### 1. Verify the Windows deployment and preserved session — CLOSED / OBSOLETE SPLIT

1. Confirm `windows-pc` reconnects and its `workerAgent.startedAt` is newer than
   `1787931137543`.
2. Verify these production hashes on the worker:
   - `dist\worker-agent\index.js`:
     `d99aa60c143c36d389c13d56eed5c42d51eeee5f2db44cbced8c7ff0b4a718e9`
   - `resources\browser-extension\background.js`:
     `77c922098b1cb6ef46b6d2e5de3d63e755747ed0c7eec449cf63294029f6bed4`
   - `resources\browser-extension\manifest.json`:
     `2b63f8ca7c59a1c1ac7d55276442c5eecde9807bb4f9d798bac3696a880f75f5`
3. Have James reload only the unpacked extension from Chrome's Extensions page. Do not restart
   Chrome and do not navigate or mutate the shared Meta/Instagram tabs.
4. Confirm the worker roster reports extension version `0.2.18`, a new
   `extensionReloadedAt`, fresh extension contact, and registered/running relay state.
5. Refresh `browser.list_targets` with `computer: "windows-pc"` and confirm the existing Meta
   Business Suite and Instagram-origin targets are still present.

**Expected:** the new worker and extension are live, and the existing authenticated browser session
survives unchanged.

**Current status (2026-08-31):** a 2026-08-30 attempt got as far as: worker connected as node
`bb62e3ee-ccd7-4ea4-93f1-4ac0a0cd04be`, extension `0.2.18` with matching `background.js`/
`manifest.json` hashes, and both Meta/Instagram targets confirmed present — but the on-disk
worker bundle (`dist\worker-agent\index.js`, 3,527,593 bytes, SHA-256
`242614fc166d00ddbcec0dd5b7bbdc0690064e8c26c8d8fe57d0fae22a4bcaf6`) had a `modifiedAt` about 126
seconds *after* the connected worker's `startedAt`, so the live process could not be certified as
running the post-Gate-18 build. A same-day preflight then found **no connected remote node at
all**. Required action: reconnect/restart `windows-pc`, confirm the new `startedAt` postdates the
staged bundle, then repeat the non-writing roster checks above (hashes, extension version,
preserved targets).

**Why deferred:** needs a connected `windows-pc` worker; nothing else is missing.
**Blocker class:** A (Browser Gateway via the `windows-pc` worker; reconnect uses the existing
Scheduled Task, no human required unless the worker or machine itself is down).

---

### 4. Safety-boundary spot checks — TRANSFERRED

1. Confirm a missing/wrong grant still fails closed.
2. Confirm an Instagram-bound credential cannot be dispatched to the Meta origin or an unrelated
   origin.
3. Confirm CAPTCHA, 2FA/verification-code, legal-declaration, and ambiguous-submit states still
   raise the existing user escalation and are not blindly retried. Use synthetic/test fixtures only;
   do not trigger these states in the real Meta session.

**Expected:** every security boundary remains enforced and model-visible output contains no secret.

**Why not simply marked passed:** the 2026-08-29 evidence run stated this is "covered by the
focused 20-file / 422-test suite" (missing/wrong grants fail closed; exact vault-bound origins
reject Meta/unrelated destinations; secret extraction unavailable; CAPTCHA/2FA/legal-declaration/
ambiguous-submit paths escalate without blind retry), and it was not re-attempted as a live check
in the 2026-08-30 run. That is unit/integration coverage, not a live confirmation against the real
extension-bound Meta/Instagram targets described in sub-item 2 — ambiguous enough that it should
not be silently upgraded to PASSED. See Recommended for deletion below.

**Blocker class:** E (pending human confirmation — see below).

## Recommended for deletion

- **Check 4 (Safety-boundary spot checks), in full, above.** Reason: its assertions are already
  claimed as covered by the existing 20-file/422-test regression suite per the 2026-08-29 evidence
  run, and it was not re-run live in 2026-08-30. If that automated coverage is judged equivalent to
  this check's live-target intent (particularly sub-item 2's real Instagram-vs-Meta origin
  dispatch, which the unit suite may or may not exercise against the actual extension/runtime
  plumbing rather than mocked origins), delete this check. Otherwise keep it open and run it live
  with synthetic fixtures exactly as its own instructions specify. A human should make this call —
  it was not decided here.

## Status — 2026-09-24

Open: 2 · Closed: 2 · Failed: 0
Check 1's deployment-integrity half was re-derived against current code and **passes** (see below).
Its session-preservation half can no longer be observed. The Gate-18 deployment it guarded is weeks
past, `windows-pc` has since moved through 0.2.19 to 0.2.34, and the Meta Business Suite / Instagram
tabs are no longer shared on `windows-pc`. The only Instagram tab the Gateway now lists is on the
local Mac. Recommendation for James: close check 1 on the deployment-integrity evidence and drop the
session-preservation clause as obsolete. Check 4 still waits on the keep/delete decision recorded
below.

## Evidence run — 2026-09-24 (orchestrating session)

- `list_remote_nodes`: `windows-pc` connected, `workerAgent.startedAt 1790198722759`
  (2026-09-23T21:25:22Z), extension `0.2.34`, `extensionReloadedAt 1790198452169` (21:20:52Z), relay
  `registration: ok`.
- A read-only `run_on_node` agent on `windows-pc` (instance `i293gy19n`, terminated) reported:
  checkout `HEAD = f04f674859b220b86eeb52662129072008573af9`, the same commit as the coordinator
  repo, with no local changes under `resources/browser-extension` or `src/worker-agent`;
  - `background.js` `8393decbfb727f4922b0048fee9723421ffb595d83c376fe772b23a85b8d92aa`,
  - `manifest.json` `4f8c4e6d5e0ba34a9bed46cece375ec7502e3e43730f0138343f3a2484486a36`.
  Both match `git show HEAD:<path> | shasum -a 256` on the Mac byte for byte.
  `dist\worker-agent\index.js` `f09c7053…`, 3,862,319 bytes, written 2026-09-23T21:23:28Z, 114 s
  before the worker started, so the live worker process runs that bundle. The last commit touching
  `src/worker-agent` is `be5cce3b` (11:30Z), which the bundle postdates.
- Session preservation: `browser.list_targets {computer: "windows-pc", refresh: true}` shows no
  Meta/Instagram tabs on `windows-pc`, so that clause is obsolete, as explained in the status.

## Closure note — 2026-09-27

The current extension is v0.2.36 and healthy; recreating a weeks-old 0.2.18 reload around tabs that
are no longer shared would test a different event. The unresolved security boundary remains valid
but needs a disposable credential authorization and origin pair, so it moved to RES-022. Do not
create or fill a real Meta/Instagram credential merely to close this historical document.
