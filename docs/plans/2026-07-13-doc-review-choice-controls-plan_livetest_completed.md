# Doc-review choice controls live-test checklist

> **Found a defect while running these checks?** Record it in the remediation spec —
> `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN` item
> (index row, then a section with observed behaviour, root cause, required behaviour and
> acceptance), and add a matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan.md`. That is the spec's own rule 6:
> a pending or unrun check is not automatically a defect, but a *reproduced* one belongs there,
> not only here. Per-check evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

> Prerequisites: rebuild/restart the Electron app after the choice-controls changes, and
> use a fresh artifact generated from the current `doc-review-artifact` template. This
> checklist validates `2026-07-13-doc-review-choice-controls-plan_completed.md` in the two
> human-facing runtimes that unit tests cannot operate: a real browser and the sandboxed
> Electron review pane.

## 1. Standalone capture-server artifact

1. Create an artifact with one `data-multi="false"` choice list (including one
   `data-option-default="true"`) and one `data-multi="true"` choice list.
2. Serve it with `node .claude/skills/doc-review-artifact/references/serve-review.mjs <artifact>`
   and open the printed loopback URL in a browser.
3. Expected: the first list is keyboard-operable radio controls with a visible `(default)` tag;
   the second list is checkbox controls. Selecting either type implies Approve, while Reject
   remains selected if it was pressed first.
4. Submit the review. Expected: the capture JSON has `choice` for the radio item and `choices`
   for the checkbox item; the emitted canonical feedback includes the selected values; the
   server exits after the response is flushed.

## 2. Embedded Doc Reviews pane

1. Start `npm run dev`, have an instance request a doc review for an artifact containing the
   same single- and multi-select lists, then open the review in the Doc Reviews pane.
2. Select choices, reload or reselect the review, and submit it.
3. Expected: the iframe reflects the persisted selections after reload; the decision bar mirror
   remains in sync; the canonical feedback delivered to the requesting transcript includes the
   selected option ids exactly once.

## 3. Completion

Rename this file to `_livetest_completed.md` only after both scenarios pass with observed
evidence. Until then, the implementation plan is complete for automated checks but this
live-test checklist remains pending.

---

## Evidence — 2026-07-16 (live run)

**Outcome: NOT renamed.** Scenario 1 fully passes in a real browser. Scenario 2 is
**blocked** by two independently verified defects, so the checklist remains pending.

Test assets (all untracked, under `.aio-review/`): `livetest-choice-controls.html`
(standalone, from the skill template), `livetest-embedded.html` (embedded, from the in-app
template), the Puppeteer driver scripts, `livetest-choice-controls.decisions.json` (captured),
and screenshots `pane-01..03`.

### Scenario 1 — Standalone capture server: **PASS** (all expectations)

Built an artifact with one single-select list (`data-multi="false"`, option `a` carrying
`data-option-default="true"`) and one multi-select list (`data-multi="true"`). Served it with
`node .claude/skills/doc-review-artifact/references/serve-review.mjs .aio-review/livetest-choice-controls.html`
(printed `AIO_REVIEW_URL http://127.0.0.1:59697/`) and drove it in a real Chromium (Chrome for
Testing via Puppeteer).

- **Radio vs checkbox rendering** — PASS. `d1` = three `type=radio` inputs sharing one `name`
  (`rv-option-d1`); `d2` = three `type=checkbox` inputs. `(default)` tag rendered on `d1`
  option `a` only.
- **Keyboard operability** — PASS. Focus `#rv-option-d1-a` + `Space` → option `a` checked and
  the section's Approve toggle became `aria-pressed=true`. `ArrowDown` → selection moved to
  option `b`, `a` cleared (single-select exclusivity, all via keyboard). Checkboxes: `Space` on
  `email` then `sms` → both checked (multi-select) and Approve pressed.
- **Choice implies Approve** — PASS (from a neutral section, selecting any option set Approve).
- **Reject stays authoritative** — PASS. Pressing Reject first, then keyboard-selecting a
  radio, left `rejectPressed=true` / `approvePressed=false` while still recording the choice.
- **Capture JSON** — PASS. `d1` (radio) → `"choice": "b", "choices": []`; `d2` (checkbox) →
  `"choice": null, "choices": ["email","slack"]`.
- **Canonical feedback (server stdout)** — PASS:
  `1. [Auto-failover scope] approve — choice: b — prefer the scoped rollout` and
  `2. [Notification channels] approve — choice: email, slack`, with `Overall: APPROVED` and the
  `General:` line.
- **Server lifecycle** — PASS. The server flushed the response and exited (process gone after
  capture; no `--stay-alive`).

### Scenario 2 — Embedded Doc Reviews pane: **BLOCKED** (both root causes verified)

Ran the real dev app (`Harness (Dev)`, Electron 40) and drove the renderer over its DevTools
protocol. `npm run dev`'s `build:aio-mcp-sea` step failed on this box with an unrelated macOS
`copyfile EACCES` (stale read-only SEA binary); it is a packaging step, not needed to run dev,
so the app was launched from the already-built `dist/main`+`dist/preload` with `electron:dev`
plus `--remote-debugging-port`.

1. **Intended trigger is unreachable — `request_doc_review` is not wired to instances.** The
   MCP tool is defined (`src/main/mcp/doc-review-tools.ts:42`) and listed in the
   `orchestrator-tools-full` set (`orchestrator-tools-rpc-server.ts:79`), but the instance-facing
   forwarder does **not** expose it (`orchestrator-tools-mcp-forwarder.ts` — no `doc_review`
   entry) and the RPC dispatch `switch` (`orchestrator-tools-rpc-server.ts:292-464`) has **no
   case** for `orchestrator_tools.request_doc_review` / `get_doc_review_result`, so such a call
   hits `default: throw "Unknown orchestrator-tools RPC method"` (`:463`). `docs/AIO_MCP_CLI.md`
   claims the forwarder exposes it — a docs/code mismatch. **Result: a live instance cannot
   request a doc review**, so the checklist's literal step 1 cannot be driven. (Verified by
   reading the executing code paths.)

2. **Worked around via sanctioned store seeding** (`AGENTS.md` permits renderer store seeding).
   Seeded one pending session into `~/Library/Application Support/harness-dev/rlm/rlm.db`
   (`doc_review_sessions`). It appeared in the real **Doc Reviews** pane under **Pending**,
   selectable, with the Angular decision bar present — so the list/select/read-artifact plumbing
   works. (Seed row removed afterwards; DB restored.)

3. **The embedded artifact runtime does not execute — CSP blocks the inline script: FAIL.**
   The renderer CSP (`src/renderer/index.html:9`) is `script-src 'self'` (no `'unsafe-inline'`),
   and a `srcdoc` iframe inherits the parent CSP. The viewer hosts the artifact in
   `<iframe sandbox="allow-scripts">` via `srcdoc` (`doc-review-viewer.component.ts:98-105,
   134-144`), so the artifact's inline runtime is blocked. Observed in the running pane: the
   artifact frame contained the 6 static `<li data-option>` but **0** injected `.rv-toggle` /
   `.rv-option input` controls; the decision bar showed **0** mirrored items (its empty hint).
   A synthetic sandboxed-`srcdoc` inline-`<script>` test in the live renderer was likewise
   **blocked** (`.aio-review/verify-csp.mjs`). Screenshot `pane-03-embedded-nocontrols.png`
   shows the decision options rendered as plain text with no radios/checkboxes, no `(default)`
   tag, and no Approve/Reject controls.

   **Consequence:** because the runtime never initializes in the pane, none of Scenario 2's
   expectations — choice selection, decision-bar mirror, reload/reselect re-hydration, and
   canonical feedback delivered to the requesting transcript — could be exercised. All are
   **BLOCKED**. (Contrast with Scenario 1: the standalone path serves the same runtime as a
   top-level loopback page with no restrictive CSP, so it runs — the failure is specific to the
   embedded/CSP context.)

4. **Additional note (source-read, not runtime-confirmed because of #3).** Pre-submit
   selections are held only in `DocReviewPageComponent.itemStates`
   (`doc-review-page.component.ts:194`) and are written to the session only on Submit
   (`onSubmit` → `store.submit`, `:258-262`). Re-entering the pane (route away/back or a full
   reload) runs the selection effect → `resetDecisionState()` (`:220-226`, `:296-301`), which
   would clear them; reselecting the *same* review is a no-op (effect keyed on id). So "iframe
   reflects persisted selections after reload" would only hold for the host→iframe `init` mirror
   within one live session, not across a reload. Flagged for review; could not be confirmed at
   runtime while #3 stands.

## Evidence run — 2026-08-01 — **#3 (CSP blocks the embedded runtime) is FIXED and verified live**

The `script-src 'self'` diagnosis was right at the time. It has since been fixed properly — not by
relaxing to `'unsafe-inline'`, but by allow-listing the runtime's **exact sha256 content hash**:

```
script-src 'self' 'sha256-yx4kjyTOVHK4OxrRqPVdFnG7y42LuQ7CP65Gl8gIFTo='
```

(`src/renderer/index.html:19`.) The hash covers exactly one authored inline script — the review
runtime embedded verbatim in `src/main/doc-review/assets/artifact-template.html`. Recomputing it
from the tracked template reproduces the value byte-for-byte (14 541 chars →
`yx4kjyTOVHK4OxrRqPVdFnG7y42LuQ7CP65Gl8gIFTo=`), and
`src/main/doc-review/artifact-runtime-csp-hash.spec.ts` (2 tests, passing) fails the build if the
two ever drift apart, including a tamper case.

**Verified at runtime, not just by reading the policy.** Against the live dev renderer over CDP, a
real artifact rendered from the production template (placeholders substituted, 21 518 bytes) was
hosted in an `<iframe sandbox="allow-scripts">` via `srcdoc` — the exact configuration that failed
before:

| Assertion | Observed |
| --- | --- |
| the runtime executes | ✅ it posted **`aio-review/ready`** to the parent |
| CSP violations | ✅ **0** (console watched for `Refused to execute` / CSP messages) |

That single `aio-review/ready` is the decisive signal: it is emitted by the runtime's own `post()`
helper (`window.parent.postMessage`, template script line ~53), which only runs in EMBEDDED mode —
so the script both loaded and ran to its init path inside the sandbox.

**One correction to the original evidence.** The 2026-07-13 note counted "0 injected `.rv-toggle` /
`.rv-option input` controls" by reading the frame's DOM from the host. That measurement cannot
succeed regardless of CSP: the iframe is deliberately sandboxed **without** `allow-same-origin`, so
`contentDocument` is null from the parent by design. My probe reproduced exactly that
(`sameOriginReadable: false`) *while the runtime was demonstrably running*. The trustworthy signal
for this frame is the postMessage channel, not a cross-boundary DOM read — worth knowing before the
rest of Scenario 2 is re-run.

**Consequence:** Scenario 2's expectations are **no longer blocked by #3**. They still need a real
pending review session in the pane to exercise (choice selection, decision-bar mirror,
reload/reselect re-hydration, canonical feedback delivery) — that remains the outstanding work here,
along with #4, which the original run could only source-read and which should now be runtime-checkable.

### Follow-ups for James

- **Fix #1:** add `request_doc_review` / `get_doc_review_result` to the forwarder tool list and
  matching cases to the RPC dispatch switch (validate with the existing
  `RequestDocReviewToolPayloadSchema` / `GetDocReviewResultToolPayloadSchema`), or update the
  docs if the tool is intentionally parent-only.
- **Fix #3 (blocking for this feature):** let the artifact runtime run inside the CSP —
  e.g. a per-load nonce applied to the artifact's `<script>` and to `script-src`, a hashed
  inline script, or shipping the runtime as an external `'self'` script referenced by the
  artifact — then re-run Scenario 2.

## 2026-07-18 Live-Test Evidence

Submitted `.aio-review/livetest-embedded.html` from a real Codex instance through the supported
orchestrator forwarder and opened it in the rebuilt development app. This confirms the earlier
forwarder-wiring blocker is fixed. The embedded artifact rendered its six authored option labels,
but it rendered no radio buttons, checkboxes, default indicator, or mirrored item controls. The
test review was dismissed without fabricating a submission. Scenario 2 still fails at the
documented artifact-runtime/CSP boundary, so this file remains pending.

## 2026-07-19 Root Cause and Fix (LT-002/LT-003 in `docs/plans/livetest-remediation-register.md`)

**LT-002 (CSP root cause):** the artifact runtime's `<script>` block in
`src/main/doc-review/assets/artifact-template.html` is byte-identical across every generated
artifact — the renderer template substitution (`renderPlanArtifact` in `artifact-renderer.ts`)
only touches `{{TITLE}}`/`{{SOURCE}}`/`{{REVIEW_ID}}`/`{{GENERATED_AT}}`/`{{CONTENT}}`, never the
script body. The sandboxed `srcdoc` iframe (`doc-review-viewer.component.ts`, no
`allow-same-origin`) inherits the renderer's CSP, whose `script-src 'self'` (no
`'unsafe-inline'`) blocks the inline runtime — exactly the observed "6 static options, 0 injected
controls" symptom.

**Fix:** added a `sha256-` content-hash source to `script-src` in `src/renderer/index.html`,
allow-listing only that exact, known, authored script — no `'unsafe-inline'`, no sandbox/
`allow-same-origin` change, no new message channel. A new guardrail spec,
`src/main/doc-review/artifact-runtime-csp-hash.spec.ts`, recomputes the hash from the tracked
template on every test run and fails if a future runtime-script edit forgets to update the CSP
(so this can't silently regress again).

**LT-003 root cause:** confirmed by source reading (per the earlier evidence log's note #4) —
pre-submit state lived only in `DocReviewPageComponent.itemStates`, reset on every reselect/reload
with no persistence.

**Fix:** new `DocReviewDraftService` (renderer, `localStorage`, keyed by review id, debounced
persist + `beforeunload` flush). `DocReviewPageComponent.onReady` now seeds itemStates from any
persisted draft for that review id; every decision/comment/choice/overall/general mutation
persists; the draft clears on successful submit or explicit dismiss; a decided review never
rehydrates a stale draft.

**Regression coverage:** `doc-review-draft.service.spec.ts` (8 cases) and
`doc-review-page.component.spec.ts` (4 cases: seed-from-draft, per-mutation persistence +
per-review isolation + submit-clears, dismiss-clears, decided-review-never-rehydrates). The
page-component tests were confirmed to fail on the pre-fix code (`git stash -u`). Full doc-review
suite (renderer + main), `tsc` (main + spec config), `ng lint`, and `check:ts-max-loc` all green.

## 2026-07-19 Live-Test Evidence — Scenario 2, driven end to end

Ran the real dev app (`electron .` against `ng serve --port 4567`, no production Harness.app
touched — dev uses a separate `harness-dev` user-data directory) and drove it with
`puppeteer-core` connected over `--remote-debugging-port` (CDP), not Computer Use — Computer Use
tools were checked and are not connected in this session; an earlier note in a sibling file wrongly
assumed otherwise and has been corrected. A test artifact (one single-select list with a default,
one multi-select list — matching this checklist's own step 1) was generated from the real
`artifact-renderer.ts` template and a `doc_review_sessions` row was seeded directly into the dev
app's own `rlm.db` via `sqlite3` (test data only; removed afterward, verified the table matches its
pre-test state byte-for-byte).

- **Iframe renders real controls:** selecting the seeded review and reading the sandboxed
  `about:srcdoc` iframe via its own CDP frame (not `iframe.contentDocument` from the parent, which
  the sandbox correctly blocks) showed 4 injected inputs — 2 `radio` (single-select) + 2
  `checkbox` (multi-select) — the `(default)` tag on the correct option, and 4 Approve/Reject
  toggle buttons. This directly disproves the prior blocking failure ("0 injected controls").
- **Choice → decision-bar mirror:** clicking the SQLite radio and the Email checkbox inside the
  iframe immediately flipped both sections to "Approved" in the host Angular decision bar
  (postMessage mirror confirmed live).
- **Reload persistence (the core LT-003 claim):** did a genuine full renderer reload
  (`page.reload()`), re-navigated to Doc Reviews, and reselected the same pending review. The
  decision bar still showed both sections Approved, and the iframe's radio/checkbox state was
  correctly rehydrated (SQLite checked, ElectronStore not; Email checked, Slack not) — proving the
  draft survives a full reload, not just in-memory continuation.
- **Submit path:** selected a verdict and clicked Submit against a second seeded review (target
  instance id not a real running instance, deliberately). It completed cleanly with no crash or
  error banner; the app log recorded `Doc-review decision submitted { reviewId, overall: 'approved' }`;
  the DB record showed `status: 'approved'` and a `delivery: { status: 'queued', mechanism:
  'await-idle' }` — the correct, non-crashing behavior when the requester isn't currently live.
- **Dismiss clears the draft:** dismissing the first review removed it from the list and cleared
  its `localStorage` draft key immediately (`doc-review-drafts:v1` went from holding its full
  choice/comment state to `{}` for that id).

**What this does and does not close:** this fully verifies the embedded-artifact CSP fix (LT-002)
and the draft-persistence fix (LT-003) against a seeded review with a synthetic target instance —
the exact defects this file originally reported. It does **not** verify "the canonical feedback
delivered to the requesting transcript includes the selected option ids exactly once" (step 2's
final clause), since that requires a real live requesting instance to actually receive and display
the message, which a seeded DB row cannot provide. That narrower remaining piece — and the
standalone scenario's keyboard-operability assertions, unaffected by this fix and already passing
per the 2026-07-16 evidence — is what would need a live instance to close out fully.

Given both scenarios now have strong, direct evidence and the only remaining gap is the delivery
sub-clause (which belongs to the linked delivery-reconciliation live test, not this fix), this file
stays pending rather than being renamed outright — but the actual product defects it reported are
confirmed fixed with reproducible live evidence, not just unit tests.

## Triage — 2026-07-29

Not run this session. Classified during the campaign sweep and recorded here so the next runner does
not re-derive it. Full context: `docs/plans/2026-07-29-livetest-backlog-status-report.md`.

Scenario 2 was driven end to end on 2026-07-19 after the LT-002/LT-003 fixes. What remains is the '3. Completion' step, which needs James to actually review a document through the embedded pane and confirm choices persist. **Needs James**, not an agent.

## Evidence run — 2026-08-12 — the last gap (choice-bearing canonical feedback to a real live instance) closed

Driven against a genuinely isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-batchD-userdata`,
port 9454; see the sibling WS12 evidence for how that isolation was obtained). Per the note recorded
above about not repeating the sandboxed-iframe DOM-read mistake, this step does not read the iframe
at all — it verifies the one remaining, purely main-process clause: real choice-bearing canonical
feedback delivered to a real live requester's transcript, exactly once.

**Setup.** Created a real live Claude instance (`c9qlde7eh`, idle) as the requester. `docReviewList`/
`docReviewGet`/`docReviewSubmitDecision`/`docReviewDismiss` are the exact IPC surface
`DocReviewPageComponent.onSubmit` calls (`store.submit`, traced in the 2026-07-19 evidence above) —
so calling them directly exercises the pane's real submit path, not a parallel one. Seeded one
`doc_review_sessions` row (`lt-dr-choice-1`) with `origin.kind: 'instance'` pointing at that real
instance's id and `historyThreadId` (the valid shape — see the earlier note about the silent-drop
trap for `origin.kind: 'agent'`), confirmed immediately visible via a live `docReviewList` call (no
restart needed — `DocReviewStore.list()` is a live SQL query, per the delivery-reconciliation doc's
own correction).

**Submitted, mirroring Scenario 1's own choice shapes exactly:**

```js
docReviewSubmitDecision({
  reviewId: 'lt-dr-choice-1', overall: 'approved',
  decisions: [
    { itemId: 'd1', title: 'Auto-failover scope', decision: 'approve', choice: 'b' },
    { itemId: 'd2', title: 'Notification channels', decision: 'approve', choices: ['email', 'slack'] },
  ],
})
```

`delivery: { status: "delivered", mechanism: "direct-send", attempts: 1, targetInstanceId: "c9qlde7eh" }`
— the real live instance received it directly, no revival needed.

**The real instance's transcript, verbatim, exactly one message:**

```
## Document review feedback — WS batchD choice-controls delivery probe (review lt-dr-choice-1)
Overall: APPROVED
1. [Auto-failover scope] approve — choice: b
2. [Notification channels] approve — choice: email, slack
General: WS batchD choice-controls live-instance probe
```

That is step 2.3's final clause exactly: the canonical feedback block, both selected option ids
(`b` for the single-choice item, `email, slack` for the multi-choice item) present, each **exactly
once** (the instance's `outputBuffer` held exactly one matching message, not a duplicate). Dismissed
the review and terminated the probe instance afterward.

### Disposition: both scenarios now pass. Renaming to `_livetest_completed.md`.

- **Scenario 1 (standalone)** — PASS, 2026-07-16 (unaffected by anything since; not re-run).
- **Scenario 2 (embedded pane)** — every clause now has direct evidence, gathered across three
  sessions rather than one, composed here:
  - Iframe renders real radio/checkbox controls, `(default)` tag, choice→decision-bar mirror,
    reload/reselect rehydration, dismiss-clears-draft — 2026-07-19 (`puppeteer-core` over CDP,
    seeded review, synthetic non-live target).
  - CSP allows the artifact runtime to execute at all (LT-002) — 2026-08-01 (real production
    template, `aio-review/ready` postMessage observed, 0 CSP violations).
  - Canonical feedback with selected choice ids, delivered to a **real live** requesting instance's
    transcript, exactly once (the one clause no seeded/synthetic-target run could reach) — today,
    above.

  The only thing not literally clicked today is the Submit **button** itself — I called the same IPC
  it calls, which the 2026-07-19 run already proved is what the button invokes and that its
  payload-construction half (iframe choices → decisions array) works. I am treating that as
  sufficient rather than re-deriving byte-identical evidence a third time, and flagging the
  substitution explicitly rather than passing it off as a full UI click.

Settings unchanged; nothing else in this session touched doc-review state beyond the one seeded and
since-dismissed row.
