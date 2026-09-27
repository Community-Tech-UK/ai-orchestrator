# Browser Approval Coherence — Live Test

## Final status — 2026-09-27

Open: 0 · Closed: 4 · Failed: 0

Checks 1–3 passed live. Check 4's exact-redemption and sensitive-action boundaries passed live;
its older statement that credential cards must offer only **Allow once** and **Deny** is superseded
by the later, explicit browser-persistent-approvals product decision. That completed plan makes
reusable credential approval an operator-only feature, preserves unknown actions as exact-only,
and records independent verification of the resulting boundary. The stale clause is therefore not
an unresolved decision or defect. LT-610, LT-611 and LT-620 were each confirmed fixed live in the
evidence runs below.

## Status — 2026-09-24 (verify-ui)

**LT-620 CONFIRMED FIXED LIVE** against the WORKING TREE's uncommitted fix, over the dev app's real
IPC (`window.electronAPI.browserRequestGrant`/`browserApproveRequest`), a real managed browser
profile and a real local static page — see
[Evidence run — 2026-09-24 (verify-ui)](#evidence-run--2026-09-24-verify-ui). **Routing correction:**
this batch's brief said to reproduce this over the `bg-*.sock` RPC socket "as the earlier run did",
but the `resume` batch's own 2026-09-24 evidence run below (see its "How this was run" table)
actually used `window.electronAPI.browserRequestGrant` etc., not that socket — and verifying against
the RPC server's own source confirms the socket cannot reproduce a no-`instanceId` caller at all:
its envelope schema throws `Browser Gateway RPC instanceId is required` whenever `instanceId` is
omitted (`browser-gateway-rpc-server.ts:535-536`), and unconditionally injects the envelope's
`instanceId` into every payload before dispatch (`:268-271`) — so `request.instanceId` can never be
`undefined` on that path. The renderer's own IPC channel is the only caller shape whose schema has
no `instanceId` field to omit, which is the actual LT-611/LT-620 scenario. This batch re-used that
same renderer-IPC method, matching what was actually run rather than the brief's description of it.

## Status — 2026-09-24
Check 2 step 5 (LT-610) and the incidental no-`instanceId` mutation defect (LT-611) were both
re-checked live against a rebuilt app (HEAD `f04f6748`) — see
[Evidence run — 2026-09-24 (resume batch)](#evidence-run--2026-09-24-resume-batch). **Both LT-610
and LT-611 are CONFIRMED FIXED LIVE.** Check 2 and check 1 are now fully closed. Check 4's
`credential`-clause decision still needs James (unchanged, not re-run per instruction). A new,
narrower sibling defect on the `browser.request_grant` tool (same sentinel-mismatch class as
LT-611, different code path) was found and filed as **LT-620**.

### Status — 2026-09-21 (superseded)
Open: 2 · Closed: 2 · Failed: 1
Checks 1 and 3 pass. Check 2 fails at step 5 — filed as **LT-610**. Check 4 passes steps 2 and 3 and
the `unknown` half of step 1; its `credential` half needs the check text reconciled with the
reusable-credential decision made in `ef4e7d90`. A further defect on the no-`instanceId` mutation
path was reproduced incidentally and filed as **LT-611**. Full evidence:
[Evidence run — 2026-09-21](#evidence-run--2026-09-21-dev-app-from-queue2026-09-01-browser-approval-co-ad14db).

_Superseded status (2026-09-06): Open: 4 · Closed: 0 · Failed: 0 — "needs a rebuilt + relaunched
coordinator/renderer, then agent-runnable via CDP and Browser Gateway automation". The rebuilt app
was run on 2026-09-21 and the Harness-UI-control caveat in Prerequisites no longer applies._

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-01-browser-approval-coherence_plan_completed.md](2026-09-01-browser-approval-coherence_plan_completed.md)

**Prerequisites:** Rebuild and restart the coordinator and renderer from this checkout. Use an
isolated dev profile and a synthetic local test page. Never enter, display, log, or store a real
password, verification code, payment value, or other secret. This check is deferred because the
current agent is prohibited from controlling the Harness UI.

## 1. Exact approval redemption and duplicate suppression

1. From a test instance, request a credential-like click or form action against the synthetic page.
2. Repeat the identical request before deciding it.
3. Confirm exactly one pending approval exists and the repeated response references the same request
   ID with `approval_already_pending`.
4. Approve it with **Allow once**, then retry with the returned request ID.
5. Confirm the synthetic mutation executes once, the approval disappears immediately from the
   banner and Permissions page, and another retry cannot execute under the spent approval.
6. Repeat with an intentionally uninspectable synthetic element and confirm the exact `unknown`
   approval can execute once without becoming stuck on another popup.

**Expected:** Identical requests coalesce; one exact approved retry executes and finalizes once; no
approval loop or duplicate mutation occurs.

## 2. Sequential-request identity and direct navigation

1. Create two safe, distinct pending requests in sequence.
2. Confirm the banner shows the pending count, `Request 1 of 2`, a short request identifier, and a
   received time so the second request cannot be mistaken for the first.
3. Click the banner body or **More options** for the displayed request.
4. Confirm Browser Gateway opens directly on **Permissions**, the matching card is highlighted, and
   keyboard focus moves to that card.
5. While already on the Browser page, navigate to a second request ID and confirm focus/highlight
   move to the new card.

**Expected:** Banner navigation lands on the exact approval rather than the default Browser tab, and
sequential approvals are visibly distinct.

## 3. Minimise, restore, and request-set changes

1. Click the banner's accessible × control.
2. Confirm the full banner becomes a compact reminder retaining the pending count, request identity,
   **Show**, and review navigation.
3. Add another safe request and confirm the banner expands automatically.
4. Resolve that new request so the set returns to its original request IDs.
5. Confirm the banner remains expanded and does not silently reapply the old minimized snapshot.
6. Click **Show** after minimizing again and confirm the full controls return.

**Expected:** Minimize never resolves or hides the pending state; any real request-set transition
clears the minimized snapshot permanently until the operator minimizes again.

## 4. Fail-closed boundaries and exact-only UI

1. Confirm credential and unknown cards expose only **Allow once** and **Deny**.
2. Confirm a wrong request ID, changed selector/target, or changed origin cannot redeem an approval.
3. With synthetic classifier fixtures only, confirm CAPTCHA, two-factor, payment, financial-identity,
   and sensitive-identity hard stops remain non-redeemable and do not gain broad approval choices.

**Expected:** The coherence fix does not broaden credential or sensitive-action authority.


---

## Evidence run — 2026-09-21 (dev app from `queue/2026-09-01-browser-approval-co-ad14db`)

**Result: 2 of 4 checks pass. Check 2 fails at step 5 (LT-610). Check 4 passes steps 2–3 and the
`unknown` half of step 1; the `credential` half of step 1 is superseded by a later product decision
(see below). One further defect was reproduced incidentally (LT-611).**

### How this was run

The doc's "the current agent is prohibited from controlling the Harness UI" caveat no longer holds:
James granted standing local UI authorisation on 2026-08-26, and the whole run was driven through a
dev app this worker launched itself. `windows-pc` was not used and could not be: the subject is the
Electron main process and Angular renderer built from *this worktree*, plus the managed Chrome that
this build launches, so there is nothing for the Windows worker to host.

| Item | Value |
| --- | --- |
| Build | `npm run build:main` + `npm run build:aio-mcp-dist` + `npm run build:renderer`, all exit 0, from the worktree |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-3fad14db PORT=4577 npx electron . --remote-debugging-port=9574` |
| Renderer | production bundle served from `dist/renderer/browser` on `127.0.0.1:4577` |
| Renderer driving | one persistent CDP connection with `Emulation.setFocusEmulationEnabled {enabled:true}` sent before every assertion (`document.hidden` read `false`) |
| Synthetic page | `http://127.0.0.1:4699/` (and a second origin on `:4700`), served from `_scratch/lt-queue-3fad14db/site/index.html` |
| Browser profile | managed, `mode: 'isolated'`, allowed origin `http://127.0.0.1:4699` — Chrome launched into a throwaway `/var/folders/.../ai-orchestrator-browser-bf1eda0d-…` user-data dir, CDP port 64795. James's own Chrome profile and the machine-global native-messaging manifest were never touched. |
| Agent path | a real instance `c1h7y2yqa` (provider `claude`, `browserToolsMode: 'eager'`), driven over the Browser Gateway RPC socket `/tmp/aio-lt-queue-3fad14db/bg-0188e538bbb6.sock` — the same seam the MCP forwarder uses, so every tool call carried a real `instanceId`/`provider` |

No real password, verification code, payment value or other secret was entered, displayed or
stored. Every "credential", "captcha", "two-factor", "payment", "IBAN" and "national insurance"
string on the synthetic page is a classifier fixture label on a plain `<button>`.

Two harness artefacts are worth recording so they are not mistaken for product faults. A fresh
`AIO_DEV_USER_DATA_PATH` profile opens on `/setup` and then renders the first-run
`app-role-choice` modal, which blocks the router outlet entirely — `/browser` renders nothing until
"Use this computer as the main Harness" is chosen. And the Browser Gateway RPC surface has no
`browser.list_approval_requests` or `browser.update_profile` method; those reads/writes were done
over the renderer IPC instead.

### Check 1 — Exact approval redemption and duplicate suppression — **PASS**

| Step | Result |
| --- | --- |
| 1. credential-like click | `browser.click #cred-one` → `requires_user` / `not_run`, `reason: credential_or_manual_challenge`, `requestId: a71580e7-bba6-4a42-ab40-c2e524f9fa84` |
| 2. identical repeat before deciding | same call again → `requires_user`, `reason: approval_already_pending`, **same** `requestId: a71580e7…` |
| 3. exactly one pending approval | `browserListApprovalRequests({status:'pending'})` returned exactly one row for the fingerprint; page title showed no `counts:`, so nothing had executed |
| 4. Allow once | banner → **More options** → `/browser?view=permissions&requestId=a71580e7…`; card `browser-approval-a71580e7…` was outlined and focused; its **Allow once** button created grant `254fe287-134b-4207-8d9e-5d9896509ffd` (`mode: per_action`, `allowedActionClasses: ['credential']`, `autonomous: false`) |
| 5. exact retry executes once, then cannot again | retry with `requestId: a71580e7…` → `allowed` / `succeeded`, page counts `{cred-one: 1}`. Banner disappeared and the Permissions card vanished in the same poll. A second retry with the same id → `requires_user` / `credential_or_manual_challenge` with a **new** request id and counts still `{cred-one: 1}`; `browser.list_grants` returned `[]` for the instance, i.e. the grant was consumed. |
| 6. uninspectable element | `#ghost-action` lives in an open shadow root, so `page.$eval` cannot see it while the page bridge's `deepQuerySelector` can still click it. First call → `requires_user`, `reason: element_context_unavailable`, `actionClass: unknown`, `requestId: e32cb504-7aa5-47fb-995b-6430030c09b6`; identical repeat → `approval_already_pending`, same id. Approved with the banner's **Approve once** (grant `7c6cf286…`, `per_action`/`['unknown']`). Exact retry → `allowed`/`succeeded`, counts `{cred-one:1, ghost-action:1}`. Next retry → a fresh `element_context_unavailable` approval, counts unchanged — one execution, no popup loop. |

### Check 2 — Sequential-request identity and direct navigation — **FAIL at step 5 (LT-610)**

Steps 1–4 pass. With three pending requests the banner read:

```
3 browser permissions requested
click on 127.0.0.1:4699 · session c1h7y2yqa
New request · Request 1 of 3 · #346b6770 · received 07:31
```

— pending count, position, short request identifier and received time all present, and the
sequential requests were plainly distinguishable (`#84b2a0f3`, `#e32cb504` and `#346b6770`, each
with its own `actionClass` badge and position). Worth noting for whoever reads this next: the
received time is rendered at minute resolution (`toLocaleTimeString` with `hour`/`minute` only), so
two requests raised within the same minute — `#84b2a0f3` and `#e32cb504` both showed 07:32 — are
separated by the short identifier and the action class, not by the timestamp. That is enough for
this check, which asks only that the second request cannot be mistaken for the first. Clicking the
banner **body** (not just **More options**) navigated to
`/browser?view=permissions&requestId=346b6770-…`; the Permissions panel was selected, the matching
card carried `outline: 2px solid var(--warning-color, #f59e0b)`, and `document.activeElement` was
that card.

**Step 5 fails.** With the Browser page already open and focus on card `#84b2a0f3`, clicking the
banner for a different request (`#e32cb504`) moved the URL and the highlight to the new card but
left `document.activeElement` on `browser-approval-84b2a0f3-…`, unchanged when re-read at 1.2 s and
again at 5.2 s.

A second, instrumented reproduction pinned down what is not happening. With
`HTMLElement.prototype.focus` patched and a capture-phase `focusin` listener attached *before* the
navigation, a router-level query-parameter change to a different `requestId` (`history.pushState` +
`popstate`, which is how the banner's `router.navigate` arrives) updated the URL and moved the
outline while the log stayed **completely empty** — zero focus calls attempted, zero focus changes
observed. So this is not focus being taken back by something else; `BrowserApprovalFocus.apply()`
never ran for the new request id.

Focus does catch up one step later: the next unrelated click inside the component (a card's
**Deny**) moved focus to the *previously* requested card. Filed as **LT-610**.

The existing renderer test for this exact transition passes only because it supplies the missing
call itself: `browser-page.approval-routing.spec.ts:136` invokes
`fixture.componentInstance.ngAfterViewChecked()` by hand right before
`expect(focus).toHaveBeenCalledTimes(2)` on line 147. Confirmed green on this tree while the live
behaviour was broken — `npm run test:quiet -- src/renderer/app/features/browser/browser-page.approval-routing.spec.ts`
→ `1 files · 1 tests passed in 4.1s`.

### Check 3 — Minimise, restore, and request-set changes — **PASS**

| Step | Result |
| --- | --- |
| 1. accessible × | `button.banner-close` with `aria-label="Minimize browser approval banner"` |
| 2. compact reminder | `2 browser approvals waiting · Request 1 of 2 · #e32cb504 · Show` — count, identity and **Show** retained; the compact body is itself the review control, and clicking it navigated to `/browser?view=permissions&requestId=8787d2fe-…` with the panel selected and the card focused |
| 3. new request arrives | a third pending request expanded the banner automatically, without operator action |
| 4–5. resolve back to the original set | denying that third request returned the set to the original two ids and the banner **stayed expanded** — the earlier minimised snapshot was not silently reapplied |
| 6. minimise then Show | compact again, then **Show** restored the full control set (Approve once / Deny / More options / ×) |

### Check 4 — Fail-closed boundaries and exact-only UI — **PARTIAL**

**Step 1 — `unknown` passes; `credential` does not match the doc, by a later deliberate decision.**
Every `unknown` card exposed exactly `["Allow once", "Deny"]` with no "Unattended options"
disclosure, and the banner offered only `Approve once` + `Deny`. Every `credential` card exposed
`["Allow once", "Allow for session", "Allow unattended", "Allow forever", "Deny"]`.

That is not a regression in the coherence work. Commit `ef4e7d90` ("some livetest fixes",
2026-09-20) deliberately removed `'credential'` from `EXACT_APPROVAL_CLASSES`
(`browser-approvals-banner.rules.ts:16`) and added the reusable-credential-consent feature —
`prepareReusableCredentialApproval()`, `BrowserPermissionGrant.userApprovedCredentials`, and
`normalizeApprovalGrant()`'s carve-out that narrows a credential approval to one-shot **only when
the operator chose `per_action`** (`browser-gateway-approval-operations.ts`). It ships with its own
tests (`browser-approvals-banner.rules.spec.ts:108` asserts the four modes;
`browser-persistent-approval.spec.ts`). So this check's step 1 now contradicts the current product,
and the spec sentence it came from — "The renderer exposes only `Allow once` and `Deny` for
credential and unknown approvals"
(`2026-09-01-browser-approval-coherence_spec_completed.md:43`) — is stale prose in a `_completed`
document. Recorded, not filed as a defect, and not edited: `_completed` files do not take new
content. It needs James's call only if the reusable-credential path was *not* meant to survive this
check.

**Step 2 — passes.** Against an approved credential approval (`selector: #cred-two`,
`targetId: …:0`, `origin: http://127.0.0.1:4699`), every altered retry was refused and nothing
executed:

| Variation | Result |
| --- | --- |
| request ID omitted | `requires_user` / `credential_or_manual_challenge`, new request id |
| unrelated, already-spent request ID | `requires_user` / `approval_already_pending` |
| request ID that does not exist | `requires_user` / `approval_already_pending` |
| correct request ID, changed selector (`#cred-one`) | `requires_user` / `credential_or_manual_challenge` |
| correct request ID + selector, changed target (second tab `…:1`) | `requires_user` / `credential_or_manual_challenge`; second tab's counts stayed empty |
| correct request ID + selector + target, changed origin (tab moved to `:4700` after widening the profile policy) | `requires_user` / `credential_or_manual_challenge`; the `:4700` page's counts stayed empty |
| **positive control** — exact request ID, selector, target and origin | `allowed` / `succeeded`, exactly one increment |

A navigation to an origin outside the profile policy was independently refused first
(`denied` / `port_not_allowed`), so the origin variation needed the policy widened before it could
even be attempted.

**Step 3 — passes.** With synthetic classifier fixtures only:

| Fixture | Decision |
| --- | --- |
| `Captcha challenge` (aria-label) | `requires_user` / `captcha_parked_to_escalation_queue` — **no `requestId` returned**, escalation `541dd9c3…` kind `captcha` |
| `Enter verification code` | `requires_user` / `two_factor_unavailable_parked_to_escalation_queue` — no `requestId`, escalation `601fbb27…` kind `two_factor_unavailable` |
| `Save card number` | `denied` / `payment_field_never_automated` |
| `Save IBAN` | `denied` / `financial_identity_requires_secure_broker` |
| `Save national insurance` | `denied` / `sensitive_identity_requires_secure_broker` |

None created an approval card, so none gained any approval choices at all, and nothing executed.
Retrying all five while supplying a **live, approved credential** request id
(`f0866d16-…`, grant `05cbf0a3-…`) changed nothing — identical refusals, page counts unchanged —
while the same id still redeemed its own exact action immediately afterwards (`allowed`/`succeeded`,
`{cred-one: 1}`). Exact redemption therefore cannot be used as a lever against a sensitive class.

### Defect reproduced outside the four checks

While reaching check 1 through the renderer's own `BROWSER_CLICK` IPC channel (no `instanceId`),
an approved exact retry returned `requires_user` / `no_matching_grant` and minted another approval
instead of executing — the approval loop this plan set out to end, on a different entry path.
Filed as **LT-611**.

### Status after this run

Open: 2 · Closed: 2 · Failed: 1 (check 2) · Partial: 1 (check 4)

- Check 1 — closed, passes.
- Check 2 — open. Steps 1–4 pass; step 5 is **LT-610**.
- Check 3 — closed, passes.
- Check 4 — open. Steps 2 and 3 pass and the `unknown` half of step 1 passes; the `credential` half
  needs the check text reconciled with the reusable-credential decision in `ef4e7d90` before it can
  close.

> Plan Queue parked work: `queue/2026-09-01-browser-approval-co-ad14db` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (resume batch)

**Result: check 2 step 5 (LT-610) and LT-611 are both CONFIRMED FIXED LIVE. A new, narrower sibling
defect (LT-620) was found on the `browser.request_grant` tool. Check 4's `credential`-clause decision
was recorded again, not re-run, per instruction.**

### How this was run

Per the campaign brief, this is not routed through `windows-pc`/Browser Gateway/Computer Use — the
subject is the Electron main process and Angular renderer built from HEAD `f04f6748`, driven through
this batch's own dev app over CDP, plus a real managed Chrome profile the dev app itself launches
(never James's browser or its native-messaging manifest).

| Item | Value |
| --- | --- |
| Dev app | `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-0924-resume npx electron . --remote-debugging-port=9711` |
| Renderer | shared campaign renderer on `:4567` |
| Synthetic page | `http://127.0.0.1:4701/` (`_scratch/lt-2026-09-24/resume/site/index.html`), a static two-element page (`#btn-one`, a `clicks:` counter) served by a disposable `http-server`, stopped and removed at the end of this run |
| Browser profile | managed, `mode: 'isolated'`, `allowedOrigins: [{http, 127.0.0.1, 4701}]`, created via `browserCreateProfile` and deleted via `browserDeleteProfile` at the end — a throwaway profile under `/tmp/aio-lt-0924-resume/browser-profiles/`, never James's Chrome |
| Approach for LT-610 | direct signal-level seeding, no real browser tab needed (see below) |
| Approach for LT-611 / LT-620 | real `window.electronAPI.browserClick`/`browserRequestGrant`/`browserApproveRequest`/`browserAccessibilitySnapshot` calls against the real managed profile/page above, exactly reproducing "the renderer's own IPC channel, no `instanceId`" from the 2026-09-21 finding |

### Check 2 step 5 — deep-link focus moves between two pending approvals — **PASS, LT-610 CONFIRMED FIXED LIVE (with a self-caught false alarm along the way)**

Reached `BrowserApprovalsStore.pendingRequests` (a public writable signal,
`src/renderer/app/core/state/browser-approvals.store.ts:15`) directly, patched
`ElectronIpcService.getApi` (same technique as the session-recovery checks) so the store's 5s poll
keeps re-serving the same two synthetic `BrowserApprovalRequest` fixtures instead of clobbering them
to empty, and called `BrowserApprovalsBannerComponent.review(approval)` — the exact method the
banner's own click handler invokes — to drive the deep-link navigation.

**First attempt falsely looked like a reproduction of LT-610, and was not one.** My first synthetic
fixture omitted `proposedGrant.allowedOrigins`, which crashed
`formatBrowserApprovalScope` (`browser-page-view.utils.ts:258`, `TypeError: Cannot read properties
of undefined (reading 'map')`) mid-render of the approval row template
(`BrowserPageComponent_Conditional_50_For_12_Template`). That aborted the whole change-detection
pass before the `afterRenderEffect` driving `BrowserApprovalFocus` could run for the second card —
which looks exactly like "focus never moved," but the cause was my malformed fixture, not the
product. Caught via `console.error` instrumentation, which surfaced three
`[RendererErrorHandler] Uncaught Angular error:` entries with that stack.

**Corrected fixture, clean result.** With a valid `proposedGrant.allowedOrigins: []`, navigating
A → B → A → B three times in a row:

```
nav B  → activeElement.id = browser-approval-lt610-req-b2
nav A  → activeElement.id = browser-approval-lt610-req-a2
nav B2 → activeElement.id = browser-approval-lt610-req-b2
```

Focus followed the deep-linked card every time, with no second click, matching the acceptance
("A click from A to B moves URL, highlight and active element to B without another click"). The
current code already uses `afterRenderEffect` in `bindBrowserApprovalFocus`
(`browser-approval-page.utils.ts:43-52`), not the `ngAfterViewChecked` hook the original LT-610
root-cause text named — this is the fix, and it works. This reverses the 2026-09-21 finding.

### LT-611 — a mutation with no `instanceId` can never redeem the approval it just raised — **CONFIRMED FIXED LIVE**

Reproduced the exact original repro: a real `browserClick({profileId, targetId, selector})` call
carries no `instanceId` field at all — `BrowserClickRequestSchema` extends
`BrowserTargetRequestSchema` (`packages/contracts/src/schemas/browser.schemas.ts:488-494,
620-630`), which only has `profileId`/`targetId`; there is no `instanceId` field to omit, this is
the only way this IPC channel can be called.

```
1. browserClick(#btn-one, no instanceId)        → requires_user / no_matching_grant, requestId R
2. browserGetApprovalRequest(R)                  → instanceId: "unknown" (the sentinel)
3. browserApproveRequest(R, grant: per_action)   → grant created, instanceId: "unknown"
4. browserClick(#btn-one, no instanceId, requestId: R)  → allowed / succeeded
5. browserAccessibilitySnapshot(...)             → "clicks: 1" (the click genuinely executed)
6. browserClick(#btn-one, no instanceId, no requestId)  → requires_user / no_matching_grant (fresh id)
```

Step 4 is the exact LT-611 scenario ("an approved exact retry returned `requires_user` /
`no_matching_grant` and minted another approval instead of executing") and it now succeeds. Step 6
confirms the `per_action` grant was correctly single-use, not silently broadened — the acceptance's
"a different scope still fails" clause holds too.

Root cause read at `src/main/browser-gateway/browser-gateway-action-guard.ts`: every sentinel in
this file (creation at line ~305 via `createOrReusePendingBrowserApproval`, matching at line ~228 via
`findMatchingBrowserGrant`, and the exact-redemption path) now consistently uses `request.instanceId
?? 'unknown'`. This is the actual code path `browser.click`/`browser.type`/other mutation tools go
through, and it is now internally consistent. LT-611 is fixed for its own reported path.

### New defect — LT-620: `browser.request_grant` still has the LT-611 sentinel mismatch, on its own "already granted" check

**Priority:** P2 (same approval-coherence subsystem the original spec targeted; produces a
duplicate/redundant approval prompt shape, which is the "approval loop" symptom the spec explicitly
guards against, though it is not a hard block the way LT-611 was).

**Observed behaviour:** A no-`instanceId` caller (the only kind `browser.request_grant`'s IPC schema
allows — `BrowserRequestGrantRequestSchema` also extends `BrowserTargetRequestSchema` with no
`instanceId` field, `packages/contracts/src/schemas/browser.schemas.ts:822-825`) requests and is
granted a **`session`-mode** grant (deliberately not single-use, unlike `per_action`, to isolate this
from LT-611's already-fixed consumption behaviour):

```
1. browserRequestGrant(session-mode, submit, no instanceId)  → requires_user, requestId R1
2. browserApproveRequest(R1, session grant)                   → grant created, instanceId: "unknown"
3. browserRequestGrant(identical scope, session-mode, no instanceId, no reuse of R1) → requires_user again, requestId R2 (fresh)
```

Step 3 should have returned `decision: 'allowed'` immediately (the "already granted" fast path,
`alreadyGrantedResult`) because a live, unexpired `session`-mode grant with the identical scope
already exists. Instead it raises a brand-new pending approval every time, which is exactly the
"approval loop" shape the parent plan set out to end — just on the `request_grant` tool rather than
`click`.

**Root cause (verified by reading code):**
`src/main/browser-gateway/browser-grant-request-operations.ts:97-110` calls
`findGrantCoveringProposal({ ..., instanceId: request.instanceId ?? '', ... })` — the covering-grant
check uses the empty-string sentinel — while the grant itself was created three lines away at
`browser-grant-request-operations.ts:136` (`approvalStore.createRequest({ instanceId: request.instanceId
?? 'unknown', ... })`) and the eventual `createGrant` call in
`browser-gateway-approval-operations.ts:199` persists `instanceId: approval.instanceId`, i.e.
`'unknown'`. `'' !== 'unknown'`, so `findGrantCoveringProposal` can never find a grant this same
function created for a no-`instanceId` caller. This is the identical bug class LT-611 fixed in
`browser-gateway-action-guard.ts`, left unfixed in this sibling file. Confidence: high — read both
sentinel call sites directly and reproduced the exact failure live with a grant whose `instanceId` we
independently confirmed via `browserGetApprovalRequest`/`browserApproveRequest` responses.

**Required behaviour:** Use the same sentinel (`'unknown'`, matching the rest of the browser-gateway
code) at `browser-grant-request-operations.ts:104` so the covering-grant and pending-request checks
in this file agree with what `createRequest`/`createGrant` actually persist.

**Acceptance criteria:** A no-`instanceId` caller who already holds an unexpired grant covering an
identical `request_grant` proposal gets `decision: 'allowed'` (or the existing `stillWaitingResult`
if a request is genuinely still pending) without a new pending approval being raised; a differently
scoped request still raises its own approval.

**Owning doc + check:** this document, incidental to LT-611's re-check (not one of the four named
checks; found while probing the sibling `browser.request_grant` tool for completeness after LT-611
passed).

### Check 4 — credential-card clause — not re-run

Unchanged from 2026-09-21: this clause of check 1's step 1 conflicts with the deliberate
reusable-credential-consent product decision in commit `ef4e7d90`, and needs James's call on whether
the spec text or the shipped behaviour is the one that should change. Not run again this batch, per
instruction.

### Cleanup

The synthetic profile `3627992c-d323-4b6d-890c-393a961b6a69` was closed and deleted
(`browserCloseProfile` / `browserDeleteProfile`); the leftover pending `request_grant` approval from
the LT-620 probe was denied; the synthetic `http-server` on `:4701` was stopped and its port
confirmed free. No real Chrome profile, native-messaging manifest, or James data was touched.

### Status after this run

Open: 1 (check 4, needs James's decision) · Closed: 3 (checks 1, 2, 3) · New: LT-620 filed

---

## Evidence run — 2026-09-24 (verify-ui)

Dev app built from the **working tree** (uncommitted LT-620 fix, not HEAD `f04f6748`), isolated
profile `/tmp/aio-lt-0924-verify-ui`, CDP on `:9731`. Synthetic page
(`_scratch/lt-2026-09-24/verify-ui/site/index.html`, a static button + click counter) served on
`127.0.0.1:4703` by a disposable `http-server`, stopped and removed afterward. Managed browser
profile `11b48805-89b5-477f-9d89-0eaf1eb0292f`, `mode: 'isolated'`, `allowedOrigins` scoped to that
one origin/port — a throwaway Chrome profile under
`/tmp/aio-lt-0924-verify-ui/browser-profiles/`, never James's Chrome. All calls went through
`window.electronAPI.browserRequestGrant`/`browserApproveRequest`/`browserDenyRequest`/
`browserListGrants`/`browserRevokeGrant` — see the routing correction above for why this, not
`bg-*.sock`, is the caller shape that can omit `instanceId`.

### LT-620 — `browser.request_grant`'s own "already granted" check — CONFIRMED FIXED LIVE

```
1. browserRequestGrant(session-mode, allowedActionClasses:['submit'], no instanceId)
   → requires_user, requestId ab7516e4-...
2. browserApproveRequest(ab7516e4-..., same proposedGrant)
   → grant 182ca80e-..., instanceId: "unknown" (the sentinel), mode: "session"
3. browserRequestGrant(IDENTICAL scope, no instanceId, no reuse of the requestId)
   → decision: "allowed", reason: "existing_grant_covers_request: you already hold a grant
     covering these action classes and origins. Do not ask the user again — retry the action
     that failed. ...", NO new pending approval raised.
```

Step 3 is the exact LT-620 scenario and now returns `allowed` immediately, matching the acceptance
criteria. Root cause fix confirmed present in the working tree by direct diff read across all four
files the register's fix note named
(`browser-grant-request-operations.ts` — both the managed-profile and existing-tab paths —,
`browser-close-tab-operations.ts`, `browser-existing-tab-operations.ts`, `browser-upload-grant.ts`):
every `request.instanceId ?? ''` became `request.instanceId ?? 'unknown'`, matching the sentinel
`createRequest`/`createGrant` actually persist. A fifth call site
(`browser-close-tab-operations.ts`'s `closeMatching`) also gained an unrelated `already_closed`
guard in the same diff, not part of LT-620's own scope.

**Differently-scoped request still raises its own approval** (the acceptance criteria's other
clause): a fresh `browserRequestGrant` with `allowedActionClasses: ['destructive']` against the same
profile/target correctly returned a brand-new `requires_user` with its own `requestId`
(`80b4aa6e-...`) — the existing `session` grant for `['submit']` did not broaden to cover it.

### Cleanup

The `80b4aa6e-...` pending request was denied; the `182ca80e-...` session grant was revoked; the
browser profile was closed and deleted (`browserCloseProfile`/`browserDeleteProfile`); the
disposable `http-server` on `:4703` was stopped and the port confirmed free. No real Chrome profile,
native-messaging manifest, or James data was touched.
