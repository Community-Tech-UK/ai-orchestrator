# Browser Permission UX Fix Live Test

## Status — 2026-09-21
Open: 0 · Closed: 3 · Failed: 0 (LT-001 re-verified live and closed)
Check 1 ran end to end against a dev app built from this working tree, paired to an isolated
local Chrome sharing `http://localhost:48765`. Every step passed, including the post-approval
retry that LT-001 used to break. Evidence: [Evidence run — 2026-09-21](#evidence-run--2026-09-21).
One wording divergence between this document and the shipped UI is recorded there; it is a
stale expectation in this document, not a product defect, and nothing was filed.

### Status — 2026-09-06 (superseded)
Open: 1 · Closed: 2 · Failed: 0 (1 historical defect, fixed, pending re-verification)
Agent-runnable: needs a dev app driveable renderer with a shareable tab (via `windows-pc`
Browser Gateway routing, or a local shared tab) to re-run Check 1 end to end.

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-07-17-browser-permission-ux_plan_completed.md](2026-07-17-browser-permission-ux_plan_completed.md)

## Prerequisites

- Rebuild and restart Harness after the implementation commit, or start a fresh `Harness (Dev)` instance from this working tree.
- Use a disposable local browser page, not a live account or production form.
- Run the check in a session with YOLO off so Browser Gateway leaves the request pending for inspection.

## Local Test Page

From the repository root, run:

```bash
python3 -m http.server 48765 --directory _scratch/browser-permission-ux
```

Open `http://localhost:48765` in Chrome and share the tab through the Browser Gateway extension.

## Check 1: Low-Risk Permission Bar

1. In the test session, request an autonomous Browser Gateway grant for the shared tab with origin `http://localhost:48765`, action classes `read`, `navigate`, and `input`, and no submit, destructive, credential, payment, upload, or external-navigation permission.
2. Observe the global permission bar.
3. Confirm the bar says `Browser permission requested`, names `localhost:48765`, and shows `Allow once`, `Allow for session`, `Deny`, and `More options`.
4. Confirm the bar uses the compact amber permission treatment and wraps cleanly if the window is narrowed.
5. Choose `Allow for session`.
6. Retry typing `permission check` into the harmless test field.

**Expected:** The request is resolved without navigating to Browser Control & Diagnostics and without typing a confirmation word. The retry types into the local field. The resulting active grant is non-autonomous session scope and contains no action classes beyond those requested.

**Why it was deferred (resolved 2026-09-21 — see the evidence run below; kept for history):**
the production Harness app runs live sessions and is a hard-denied
automated-desktop-control target, so this needs a rebuilt/restarted dev app plus a real
Chrome tab shared through the extension. A 2026-07-18 run first hit a real blocking defect
here (LT-001, fixed in code 2026-07-19 — see below); a live re-run of Check 1's literal
steps against the post-fix build has not been performed since. A chain of infrastructure
blockers investigated across 2026-08-12 through 2026-08-19 (cross-batch contention over the
single shared Chrome native-messaging-host registration; the since-fixed LT-095 Computer Use
approval-surface gap; an apparent local-vs-remote `windows-pc` routing gate) is now fully
resolved: contention was batch-scheduling, not a product defect; LT-095 shipped and was
confirmed live 2026-08-18; and the `windows-pc` routing gate was found on 2026-08-19 to
clear on a plain retry, not to be a hard block. As of the 2026-08-31 authorization
correction, browser work routes to `windows-pc` first with local-Mac fallback after a
failed preflight, so Check 1 no longer needs a new product/scope decision — it needs a
concrete driveable renderer with a shareable target: a dev app paired to `windows-pc` (or
another node) sharing a tab, or a local shared tab under the current routing/fallback
policy.

## LT-001 (fixed 2026-07-19, re-verified live 2026-09-21 — closed)

The 2026-07-18 run produced the compact amber bar, four decisions, and phrase-gated
unattended approval correctly (see Closed checks), but the immediate retry after approving
a session grant failed: `browser.type` on `#message` returned `requires_user` /
`no_matching_grant` and re-prompted. Root cause (2026-07-19): existing-tab grants are
node-scoped (`profileId` omitted, `nodeId` set) by design, and `prepareExistingTabMutatingAction`
computed that `nodeId` correctly, but `recheckPreparedGrant` — called on every mutating
action including the post-approval retry — did not, in both its `listGrants` filter and its
`findMatchingBrowserGrant` input, so the DB query never returned the just-approved grant.

**Fix:** `recheckPreparedGrant` now computes `nodeId = existingTabGrantNodeId(request.profileId)`
and passes it to both the store query and the match input (`browser-gateway-action-guard.ts`),
mirroring `prepareExistingTabMutatingAction`.

**Regression coverage:** two new cases in `browser-gateway-action-guard.spec.ts` (approved
existing-tab session grant matches its immediate retry; a grant does not broaden to a
different node scope), both confirmed to fail pre-fix and pass post-fix. Full
browser-gateway suite (770 tests), `tsc` (main + spec config), and `ng lint` all green at
fix time.

Live re-run of Check 1 end-to-end against a rebuilt app happened on 2026-09-21 and passed —
`browser.type` on `#message` immediately after approving a session grant from the permission
bar returned `decision: allowed / outcome: succeeded` on the first attempt, with no new
approval request raised. See [Evidence run — 2026-09-21](#evidence-run--2026-09-21). LT-001
is now closed rather than "fixed, pending live re-verification".

## Closed checks

| Check | Date | Evidence |
| --- | --- | --- |
| Check 1: Low-risk permission bar | 2026-09-21 | Live dev app + isolated local Chrome sharing `http://localhost:48765`: bar copy, four decisions, amber treatment, narrow-width wrap, `Allow for session` approval without leaving the page, session-scoped non-autonomous grant, and a first-attempt post-approval `browser.type` retry. See [Evidence run — 2026-09-21](#evidence-run--2026-09-21) |
| Check 2: Advanced options stay request-scoped | 2026-07-18 | Live rebuilt dev app + shared Chrome tab: advanced page showed all four decisions; submit/destructive gated on the exact request-specific phrase (empty rejected, matching phrase approved) |
| Check 3: High-risk safeguards | 2026-07-18 | Same run: credential-class fixture exposed only `Deny`/`More options`, no quick approval action in the global bar |

Checks 2 and 3 were reconfirmed unaffected by the LT-001 fix on every subsequent evidence run
through 2026-08-31 (no code touching Checks 2/3's paths changed). They were **not** re-run on
2026-09-21 — that run covered Check 1 only, which was the sole open item.

---

## Evidence run — 2026-09-21

Run by the Plan Queue livetest worker on branch `queue/2026-07-17-browser-permission-6802a7`,
worktree `.worktrees/queue/2026-07-17-browser-permission-6802a7`. **Result: Check 1 passes.
No defect reproduced, so nothing was filed in the remediation register.** Scope was Check 1
only — Checks 2 and 3 were already closed and were not re-run.

### Rig

The blocker this document carried since 2026-08-12 was "a driveable renderer plus a shareable
tab". Both were solved locally, without touching James's Chrome or the packaged app:

| Piece | How |
| --- | --- |
| Dev app | Built from this worktree (`build:main`, `build:aio-mcp-dist`), launched as `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-0f6802a7 npx electron . --remote-debugging-port=9757`. Focus emulation enabled on every CDP connection before any DOM assertion. |
| Renderer | `ng serve` could **not** be used: it died with `The injectable '_PlatformLocation' needs to be compiled using the JIT compiler` and `app-root` bootstrapped with zero children. `npm run build:renderer` + a static server on `:4567` fixed it. This is the already-known `ng serve` JIT/linker failure, not a product defect — the production bundle builds and boots clean. |
| Shared tab | An **isolated** Chrome, so the packaged app keeps its own local extension channel. The dev app declined the machine-global manifest exactly as LT-520 intends (`app.log` 1789964230475: `Another Harness install owns the Chrome native-messaging manifest — leaving it alone`) but still laid down its own native-host wrapper under `/tmp/aio-lt-queue-0f6802a7/browser-gateway/native-host/`. This run then hand-wrote a native-messaging manifest pointing at that wrapper into the disposable Chrome profile's own `NativeMessagingHosts/` directory — Chrome reads that directory from `--user-data-dir`, so the two installs never compete. `~/Library/.../Google/Chrome/NativeMessagingHosts/…json` was read before and after: byte-identical, mtime unchanged at Sep 20 17:50. |
| Browser | **Chrome for Testing 152**, not stable Chrome. Stable Chrome 153 silently ignores `--load-extension` (M137 removal); `--enable-unsafe-extension-debugging` and `--disable-features=DisableLoadExtensionCommandLineSwitch` did not restore it. The extension's `key` in `resources/browser-extension/manifest.json` pins the ID, so the unpacked load produced the expected `jbkobgefdoglecnehdhfpgjamiginjfo`. |
| Agent identity | A real dev-app instance (`cxb5nk78h`, provider `claude`, **YOLO off**, `launchMode: 'orchestrated'`). `launchMode: 'interactive'` fails in this build (`Interactive Claude launch mode requires the terminal runtime`). Browser calls went over the dev app's Browser Gateway unix socket with that instance id — the same socket, envelope and `isKnownLocalInstance` gate the shipped `aio-mcp browser-gateway` forwarder uses. |

Two traps worth recording for the next run of any local-Chrome livetest:

- **Chrome for Testing hangs on macOS without `--use-mock-keychain --password-store=basic`.**
  Without them the browser blocks on an invisible Keychain prompt: the CDP target reports the
  right URL while the document is still `about:blank`, `chrome.tabs` shows `pendingUrl` with
  `status: loading` forever, and the HTTP server logs no request at all. This cost the most
  time in this run and looks nothing like a keychain problem.
- **No human has to share a tab.** The extension auto-reports every http(s) tab once its
  native bridge connects (`reportTabInventory`, gated only on `gatewayEnabled`, which defaults
  on); the popup's Share button is an extra, not the only route. Observed here: the tab became
  a Browser Gateway target with no popup interaction at all. That removes the human step this
  document's "Local Test Page" prerequisite implies.

### Step-by-step results

**Step 1 — agent requests the autonomous grant.** `browser.request_grant` on the shared tab,
origin `http://localhost:48765`, classes `read`/`navigate`/`input`, `allowExternalNavigation:
false`, no submit/destructive/credential/payment/upload class.

```
{ "decision": "requires_user", "outcome": "not_run",
  "requestId": "e693ff04-b6d4-4fe7-981f-b6322a80bcf1" }
```

The stored request (`browser.get_approval_status`) carries `actionClass: "read"`,
`proposedGrant.nodeId: "local"` — the node-scoped existing-tab shape LT-001 was about — and
exactly the three requested classes.

**Steps 2–3 — the bar.** Read from the live DOM with focus emulation on
(`document.hidden: false`), while the app sat on `/setup`, i.e. not the Browser page:

```
headline:  "Browser permission requested"
copy:      "request grant on localhost:48765 · session cxb5nk78h"
           "New request · Request 1 of 1 · #e693ff04 · received 05:28"
duration:  per_action => "Approve once"   session   => "Allow for session"
           autonomous => "Allow unattended" persistent => "Allow forever"
buttons:   "Approve"  "Deny"  "More options"  "×"
confirmation input present: false
```

**Divergence from this document's wording (not a defect, not filed).** Step 3 expects a button
labelled `Allow once`. The shipped bar offers the once/session/unattended/forever choice as a
duration `<select>` plus one `Approve` button, and the once option reads **`Approve once`**
(`bannerModeLabel`, `browser-approvals-banner.rules.ts`). All four decisions are present in the
global bar, one interaction away, which is what the check is actually testing; `Deny` and
`More options` match verbatim. The stale text is in this check, written 2026-07-17 before the
dropdown existed — treated as a documentation lag rather than a product fault, so no `LT-NNN`
was raised. Anyone re-running this should read step 3 as "`Approve once`".

**Step 4 — treatment and narrowing.** Compact amber confirmed: `min-height: 44px`, padding
`9.6px` block, status dot `rgb(217, 161, 61)`, top and bottom borders
`color(srgb 0.851 0.631 0.239 / 0.38)`, `z-index: 1002`. Screenshots:
`<root checkout>/_scratch/lt-2026-09-21-browser-permission/banner-{wide,narrow}.png`
(copied out of the queue worktree so they survive its removal).

Narrowed via `Emulation.setDeviceMetricsOverride` at 1400 / 860 / 760 / 520 px. At 1400 the
banner is `nowrap` and single-row; at and below 860 the `@media (max-width: 860px)` rule takes
effect and the actions drop to a second row. At every width `document.documentElement.scrollWidth`
equalled the viewport width and no child's right edge exceeded it — no clipping, no horizontal
scroll.

**Step 5 — `Allow for session` from the bar.** The duration `<select>` was set to `session`
by assigning `value` and dispatching a bubbling `change` event (a synthetic event, not a
trusted one — the component's `onModeChange` reads `event.target.value` and does not check
`isTrusted`); `Approve` was then pressed with a **real** `Input.dispatchMouseEvent`
press/release at the button's centre. Afterwards:

- route still `/setup` — **no navigation to Browser Control & Diagnostics**;
- no confirmation word was requested or typed (`.banner-confirm` never rendered);
- the banner disappeared and `browserListApprovalRequests({status:'pending'})` returned 0.

Resulting grant (`browser.list_grants`), saved at
`<root checkout>/_scratch/lt-2026-09-21-browser-permission/grant-after-approval.json`:

```
id 1f304bea-…  mode "session"   autonomous false   nodeId "local"
allowedOrigins      [{ scheme http, hostPattern localhost, port 48765, includeSubdomains false }]
allowedActionClasses ["read","navigate","input"]
allowExternalNavigation false   decidedBy "user"   decision "allow"
reason "Allowed for session from browser permission bar"
```

Non-autonomous, session scope, no action class beyond the three requested. Matches the
expectation exactly.

**Step 6 — the retry (the LT-001 regression).** Immediately after the approval:

```
browser.type  #message  "permission check"
→ { "decision": "allowed", "outcome": "succeeded" }
```

First attempt, no `requires_user`, no `no_matching_grant`, no new approval request. The page
itself confirms the effect — reading `document.getElementById('message').value` in the shared
tab returns `"permission check"`. The audit log's most recent entry is
`browser.type / allowed / succeeded / actionClass input / origin http://localhost:48765`, and
no `requires_user` entry follows the approval. **LT-001 is closed.**

### Gates

No source file was changed, so this item legitimately ends with **zero commits** on its
branch (`git status --short` in the worktree is empty). Gates run on the tree the evidence
came from, all green: `npm run build:main`, `npm run build:renderer`, `npx tsc --noEmit`, and
`npx tsc --noEmit -p tsconfig.spec.json` (the spec config needs
`NODE_OPTIONS=--max-old-space-size=8192`; it OOMs on the 4 GB default). The full suite was not
run — nothing was modified for it to gate, and the runbook reserves it.

### Cleanup performed

Disposable instance `cxb5nk78h` terminated; isolated Chrome, dev app, static renderer server
and the `:48765` fixture server stopped; `/tmp/aio-lt-queue-0f6802a7*` removed. No settings
were changed, no automations were created, and the packaged app's Chrome native-messaging
manifest was verified byte-identical before and after.
