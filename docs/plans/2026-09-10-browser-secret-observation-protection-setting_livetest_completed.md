# Browser secret observation protection setting — Live Test

## Current status — 2026-09-27
Open: 0 · Closed: 4 · Moved: 1 · Failed: 0

The remaining operator-popup, payload-propagation and authenticated Diamond assertions now form
one extension-bound residual under
[RES-023](2026-09-27-livetest-human-external-residuals_livetest.md#res-023--reload-browser-gateway-v0237-and-confirm-lt-658-live).
This source document is complete as a campaign record; moving that residual does not claim it passed.

**Check 1 PASS.** 0.2.20 files are on the `windows-pc` unpacked checkout; hashes re-confirmed
2026-09-10 14:18 UTC.

**Check 2 PASS on windows-pc (recheck 14:20 UTC).** Relay now reports `extensionVersion: "0.2.20"`
and `extensionReloadedAt: 2026-09-10T14:18:58Z` (was `00:44:18Z` / `0.2.19`). One service-worker
restart and a brief `native_host_stdin_eof` during the reload. Local Mac remains `0.2.20`.

**Check 3 PARTIAL.** Setting is OFF in Harness (`value: false`, MCP-closed). The next Windows
command never applied the flag: after the 0.2.20 reload the channel started rejecting every
command with `browser_extension_runtime_incompatible`.

**Reproduced 14:21–14:32 UTC.** `waitingPollerCount: 2` (legacy + relay native hosts share one
node). A `native_host_stdin_eof` or an unstamped sibling poll tombstoned generation
`extensionReloadedAt: 1789049938827`. Later complete `0.2.20` polls were treated as delayed
replay, so snapshot / `list_targets(refresh)` failed. Health then reported
`commandsDeliverable: false` (the generic “redeploy the worker” warning is wrong here —
`forwardsRuntimeEvidence: true` and `extensionVersion: "0.2.20"`).

**Fix in this checkout (not yet in the running app):** incomplete sibling polls no longer
poison a proven generation; a disconnect tombstone is reconnectable; an incompatible poller
no longer steals a queued command from a capable sibling. Focused tests green. Rebuild and
restart Harness, then re-run checks 3–4. Do not reload the Windows extension on the *current*
coordinator — that can re-poison the same way.

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file. Before a campaign, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-10-browser-secret-observation-protection-setting_plan_completed.md](2026-09-10-browser-secret-observation-protection-setting_plan_completed.md)

**Prerequisites:** Harness **rebuilt and restarted** from this checkout so the Advanced row and
payload stamp exist. `windows-pc` connected. Unpacked Harness Browser Gateway loaded from
`C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator\resources\browser-extension`.
James available to toggle **Lock shared tabs after a credential fill** OFF in Settings → Advanced
and to reload the unpacked extension. Do not delete cookies, passwords, or site data.

Deferral reason: the Settings write and the Diamond fill → snapshot → download path need the
rebuilt app plus James flipping an operator-only setting. Extension reload needs a click on
`chrome://extensions` or the unpacked popup **Reload Extension** button; `chrome://` pages are
not Browser Gateway targets.

## 1. Deploy 0.2.20 onto the windows-pc checkout

- [x] Copy `resources/browser-extension` from this checkout onto
  `C:\Users\shutu\Documents\Work\orchestrat0r\ai-orchestrator\resources\browser-extension`.
  Done 2026-09-10 via scratch sync + node copy. Destination `manifest.json` version `0.2.20`.

Expected asset SHA-256 values (this checkout):

- `background.js`: `62c869613df111f26d70d4e968d73f250b941b2c9620be52acc89b48d3032e7c`
- `popup.js`: `7f7a8bcff590c2b0e755604aee062bfbe24c91ebaa2d24b2cd361707e432b0f9`
- `popup.html`: `07e52f076fbd92b3c6c87f5dedd0c7d3bc2105b2f26ca08de26c3238fe630410`
- `manifest.json`: `34e292b8bfaa56d31011754404ea6463533e0c054a0165eedb4f4c224b5f82ca`

Re-checked 2026-09-10 14:18 UTC via `get_node_file_info` (hash=true). All four match. File
mtimes on the node are ~14:10 UTC (later than the first copy), so the checkout was written
again and still has the 0.2.20 bytes.

## 2. Reload the unpacked extension

- [x] On `windows-pc` Chrome, reload only the Harness Browser Gateway unpacked extension
  (`chrome://extensions` reload, or the popup **Reload Extension** button). Keep existing
  tabs. Confirm `list_remote_nodes` / Browser Gateway health reports `extensionVersion: "0.2.20"`
  and a newer `extensionReloadedAt`.
  **2026-09-10 14:20 UTC:** `0.2.20`, `extensionReloadedAt: 2026-09-10T14:18:58Z`. Channel ready.
- **Moved:** popup confirmation after the OFF setting reaches the extension is now RES-023 step 11.

Why this cannot run from the coordinator session: `chrome://extensions` is not a Browser Gateway
target, and the relay still advertised `0.2.19` after the files were on disk.

## 3. Operator setting

- [x] Rebuild and restart Harness from this checkout.
  **2026-09-10 14:20 UTC:** `list_settings` returns the new Advanced row and description.
- [x] In Settings → Advanced, find **Lock shared tabs after a credential fill**
  (`browserSecretObservationProtectionEnabled`). Default is ON. Turn it OFF. Agents must not be
  able to do this via MCP or `$AIO_MCP settings`.
  **Verified:** `get_setting` → `value: false`, `defaultValue: true`, `writable: false`,
  `policyTier: "read-only"`.
- **Moved:** confirmation that the next shared-tab command carries
  `secretObservationProtectionEnabled: false` is now RES-023 step 11. The setting itself remains
  verified OFF and MCP-read-only.

## 4. Diamond path (acceptance) — moved

The secure fill, immediate snapshot and harmless pack-download sequence is now RES-023 steps 12–13.
It still requires an explicitly authorised disposable Diamond/ProContract login tab and the
v0.2.37 extension. The 2026-09-27 cached Windows inventory contained only a timed-out Proactis login
page, not a live authorised Diamond session, so manufacturing a replacement would not be valid
evidence.
