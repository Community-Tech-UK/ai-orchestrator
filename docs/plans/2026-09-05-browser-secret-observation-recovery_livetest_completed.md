# Browser secret observation recovery: Windows live checks

## Final status — 2026-09-27

Open: 0 · Closed here: 0 · Transferred: 9 · Failed: 0

The pinned v0.2.19 bundle is obsolete. All nine Windows assertions now live in the combined
[RES-023 extension reload campaign](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live), using the current v0.2.37 assets and sharing one operator reload with LT-658. The current worker has no tainted origin/tab to reset, so the campaign explicitly forbids manufacturing taint on James's real sites and retains the protection branches for authorised test-only state.

## Status — 2026-09-06
Open: 9 · Closed: 0 · Failed: 0
Needs `windows-pc` reconnected and the extension redeployed/reloaded first; several checks then also need James to operate the real toolbar popup on his own protected tabs/site data.

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file. Before a campaign, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-05-browser-secret-observation-recovery_plan_completed.md](2026-09-05-browser-secret-observation-recovery_plan_completed.md)

Prerequisites: `windows-pc` connected; authorised normal extension deployment and reload of version 0.2.19; James available to review his existing protected tabs/site data. Keep existing browser sessions intact. No automatic reset of real protection is authorised as a test.

Deferral reason: on 2026-09-05 the roster reported `windows-pc` disconnected and Browser Gateway reported zero remote extension channels. Source and isolated real-Chrome runtime are verified locally; the existing Windows installation cannot be updated or tested while disconnected.

## 1. Deploy and establish the live runtime

- [ ] Through the normal AIO worker deployment pipeline, install the extension assets from this checkout. Do not edit code on the worker.
- [ ] Reload only the Harness Browser Gateway extension, preserving Chrome sessions. Confirm `browser.health` reports version 0.2.19 on the Windows channel, a new start/reload generation, and fresh polling. Verify the deployed asset hashes below.
- [ ] Use `browser.preflight_target` with explicit `computer: "windows-pc"` and James's current test URL. Confirm target discovery uses Windows.

Expected asset SHA-256 values:
- `background.js`: `532f9c8bca96dfac898ea788e309a66c20207baa7e7e5b91629e2c4d3b5ac480`
- `popup.js`: `ad3f4e47d5dbfa834d70923f553602f16b5c1643804200fa32362f4b29cd05a7`
- `popup.html`: `c1ff3eff48fe77daebf075cb9489686d88594be2123ed852ca60b7cb0ae3f291`
- `manifest.json`: `901d1edaf6443b3c431760fe42b32213a9cfad3cfe0e3beb45b5cc80a7c249b2`

## 2. Verify existing protection and operator recovery

- [ ] On a previously flagged tab, request one `browser.snapshot` with its explicit Windows target. Expected: fixed `browser_secret_observation_blocked_for_tainted_origin: command not run` text pointing to the popup. It must not claim a write may have applied. Do not bypass protection or retry a real uncertain mutation.
- [ ] James opens the extension toolbar popup, turns Browser Gateway off, and reviews the listed sites, all affected tabs (including descendants), and stored site data. The confirmation explicitly states that resetting permits agent reads, including remaining secrets. If he does not approve, leave protection active.
- [ ] After James confirms and clicks Reset secret protection, verify the popup reports success and Browser Gateway stays off. No website data, cookies, passwords, or sessions should be deleted.
- [ ] After James turns the gateway back on, read an approved safe test page. Expected: normal page content without the old warning. Future protected fills should still activate protection; test only with explicit authorisation and test-only fixtures.

## 3. Observation uncertainty

- [ ] In a disposable Windows test profile, induce a frame-inspection failure on an unrelated test tab while a test origin is protected. Expected: `browser_secret_inspection_unavailable: command not run`, with no permanent taint assigned to the unrelated tab.
- [ ] Restore inspection availability. Expected: that tab is readable without a protection reset. Actual protected-origin, iframe, and opener tabs remain protected.

Local evidence: `_scratch/browser-secret-recovery/live-probe.cjs` exercised the unmodified shipped JS and actual toolbar popup in an isolated Chrome for Testing profile, using obvious TEST_ONLY markers. A simulated inspection failure did not persist taint; the next real Chrome probe succeeded. Actual trusted checkbox/click reset only test flags, persisted the reset, and left the gateway off. Temp profile removed after shutdown. Unit tests separately cover forged senders, expired/stale/single-use tokens, storage failure, and in-flight watchdog races.

## Current Windows evidence and reconciliation — 2026-09-27

- Browser Gateway health found `windows-pc` registered, enabled and running, with registration
  `ok`, but its extension channel was `commands_unanswered` after three consecutive unanswered
  commands. The sanctioned relay recovery timed out after about 60 seconds and a fresh health read
  still reported the same extension-channel state. This does not show that the PC itself is down.
- Health reported secret-observation protection disabled and zero tainted origins/tabs. There is no
  existing protected real tab that can satisfy section 2 without first creating new sensitive
  state, which is outside this checklist's authority.
- The working tree's current bundle is v0.2.37. Its hashes are recorded in RES-023; the 0.2.19
  version and four hashes above are retained only as historical instructions and must not be used
  for deployment.
- The source already contains isolated real-Chrome evidence for popup reset and transient
  inspection failure behavior. The remaining Windows routing/reload/operator assertions share
  RES-023's unavoidable unpacked-extension reload boundary, so they are consolidated there rather
  than requiring a second reload or a second residual document.

With every numbered checkbox preserved in RES-023 and no safe autonomous mutation left here, this
source is ready for the `_livetest_completed.md` state.
