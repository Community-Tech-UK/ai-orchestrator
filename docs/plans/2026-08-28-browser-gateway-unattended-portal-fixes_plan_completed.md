# Browser Gateway: unattended portal work on shared tabs

Status: COMPLETED 2026-09-20. The three portal live checks are deferred to
[2026-08-28-browser-gateway-unattended-portal-fixes_livetest.md](./2026-08-28-browser-gateway-unattended-portal-fixes_livetest.md)
(3 open) — they need a rebuilt app, the extension reloaded on `windows-pc`, and a real portal page.
Date: 2026-08-28
Owner: James Lawrence

## Why

On 2026-08-28 a fully-approved ProContract submission (Liverpool City Region /
Merseytravel, DN827315) could not be completed unattended on the `windows-pc`
shared Chrome tab. Three things stopped it. Two were real defects in this repo;
independent review then found a third. The login gate is one-time operator
setup, not code.

This plan fixes the three defects so the same job runs end to end without James
at the keyboard.

## Defect 1: remote upload staging renames the file the site receives

`src/main/browser-gateway/browser-remote-upload-staging.ts:49` builds the staged
basename as:

```
`${randomUUID()}-${sanitizeBasename(localPath)}`
```

`DOM.setFileInputFiles` points the page's `<input type=file>` at that staged
path, so the filename the **site and the buyer** receive is
`1f1c30b4-6125-4d9b-9710-f5a47d01196b-Liverpool-LCRCA-CRM-CCaaS-PME-Community-Tech-DRAFT.docx`.

Observed live on the Chest attachments dialog. The upload was cancelled rather
than send a mangled filename to a public-sector buyer, which blocked the whole
submission.

The UUID exists only to stop concurrent uploads colliding. That guarantee does
not require touching the basename.

### Fix

Move the UUID into a directory component and keep the real basename:

```
<root>/_scratch/aio-browser-uploads/<uuid>/<sanitized-basename>
```

`FileTransferService.copyToRemote` already sends `mkdirp: true`
(`src/main/remote-node/file-transfer-service.ts:130`), so the nested directory is
created without further change.

Collision safety is preserved (one UUID directory per staged upload) and the
filename is preserved.

Round 6 correction: it was NOT byte-identical. `sanitizeBasename` used an
`[A-Za-z0-9._-]` allowlist, so "CommunityTech Lot9 Response.docx" still reached
the buyer as "CommunityTech_Lot9_Response.docx" -- the same rename, just quieter
than a UUID prefix. It now strips only what a filesystem cannot accept (Windows
illegal characters, path separators, control codes, leading/trailing dots and
spaces), so spaces, brackets, commas and accents survive.

## Defect 2: accessibility snapshot stops at every iframe boundary

`resources/browser-extension/background.js` calls:

```
chrome.debugger.sendCommand(debuggee, 'Accessibility.getFullAXTree', {})
```

with no `frameId`. CDP therefore returns the **main frame's** tree only. Child
frames appear as a childless `Iframe` node.

The comment above `captureAccessibilitySnapshot` and the
`browser.accessibility_snapshot` tool description both claim the tree "pierces
open AND closed shadow roots (and same-origin iframes)". The shadow-root half is
true. **The same-origin iframe half is false**, and it actively misleads: an
agent that follows the documentation reaches for a `uid` inside an iframe, gets
a node that cannot be addressed, and `browser.type` reports `succeeded` while
writing nothing.

That is exactly what happened against the ProContract TinyMCE body editor. Two
type calls returned success and left the field empty.

Note `DOM.resolveNode({ backendNodeId })` (background.js:1557) already resolves
cross-frame within the target, so once iframe nodes are present in the tree,
uid-based click/type work inside them with no further change.

### Fix

Enumerate frames and merge a per-frame tree:

1. `Page.getFrameTree` to collect frame ids (no `Page.enable`; see F6).
2. `Accessibility.getFullAXTree({ frameId })` per frame.
3. Merge, de-duplicating by `backendDOMNodeId`, then apply the caller's limit.
4. Per-frame failures are skipped, not fatal. Cross-origin OOPIFs legitimately
   refuse and must not break the whole snapshot. A MAIN-frame failure still
   throws: a confidently empty tree is worse than an error.
5. Cap the frame count to bound the NUMBER of CDP round trips, and spend a
   single shared deadline across the walk to bound wall-clock (see F2).

Correct the stale comment and the tool description in the same change.

## Not a defect: the login gates

`browser.fill_credential` could not log in to ProContract for three separate
reasons, all deliberate security controls, none agent-writable:

- `browser_vault_item_bindings` holds **0 rows**, so `getSecretForFill` throws
  `origin_binding_missing` (`browser-credential-vault.ts:296`, `:335`).
- The only ProContract authorization is scoped to the `aio-procurement` managed
  profile, not the `windows-pc` node scope.
- `browserAllowSharedTabCredentialFill` is `false`, policy tier read-only.

The code to close this already exists and is wired:
`enrolExistingCredential` (`browser-credential-vault.ts:250`) via
`BROWSER_ENROL_CREDENTIAL` (`browser-unattended-handlers.ts:80`).

**This plan does not weaken these gates.** They are the control that stops an
agent reading James's vault. Closing them is a one-time operator action:

1. Unlock the vault.
2. Enrol the existing `ProContract (AIO-Agent)` item (already in the `AIO-Agent`
   folder, has username + password, no TOTP) against
   `https://procontract.due-north.com`.
3. Create a credential authorization scoped to the `windows-pc` **node**, not
   `aio-procurement`, purposes `login`.
4. Turn on `browserAllowSharedTabCredentialFill`.

Then `remember_login_fingerprint` + `check_session(autoRelogin: true)` gives
unattended re-login.

## Scope boundaries

- No branch or worktree. Work on `main` in the existing checkout.
- The repo has unrelated uncommitted work in `src/main/history`,
  `src/main/instance` and `src/main/ipc`. Do not touch or stage it.
- No change to any credential gate, policy tier, or authorization scope.

## Defect 3 (found by review): `type` reports success for a target that cannot hold a value

`uidTypeFn` (`resources/browser-extension/background.js`) ended in a bare
`element.value = value`. On an element with no `value` property -- an
`<iframe>`, a `<div>` -- that assignment only creates an expando, which the
read-back immediately reports as `valueApplied: true`.

That is the *actual* "type said success and wrote nothing" defect. Defect 2
removed the trigger by making the editable body addressable, but the false
success remained for any uid pointing at a non-editable element. For an
unattended run, "the agent will notice" is not a control.

### Fix

Sample `'value' in element` BEFORE assigning, and refuse honestly when the
element never had the property -- the pattern `uidSelectFn` already uses for a
non-native `<select>`. The error names the tag and points at the remedy (a
`query_elements` selector, which is injected into every frame). Custom elements
that genuinely expose a `value` accessor keep working.

## Review round 1 (completion gate returned FAIL)

An independent fresh-context review found seven confirmed findings. All are
addressed:

- **F1 Extension version not bumped.** `extensionVersion` is the only signal a
  node gives about which bundle it runs, so a silently-failed reload would look
  identical to a successful one and every live check would validate old code.
  `manifest.json` bumped (now `0.2.4` after later rounds), plus a new test in
  `browser-extension-assets.spec.ts` that pins the manifest version against a
  hash of `background.js`, so this can never be forgotten again.
- **F2 Per-frame timeout could blow the outer watchdog.** The first
  implementation re-armed the full page-work budget on every frame: 25 frames x
  24s against a watchdog of at most 120s. Replaced with ONE deadline computed at
  loop start; each frame gets only the remaining budget, and the walk stops
  early returning partial results rather than failing.
- **F3 Silent truncation, over-promising description.** Two truncations exist
  (the 25-frame cap, and main-frame-first ordering filling a small `limit`
  before iframe content). Both are now stated in the
  `browser.accessibility_snapshot` description and asserted explicitly in the
  spec rather than demonstrated without comment.
- **F4 False success on non-value targets.** Defect 3 above.
- **F5 Tautological tests.** The frame-cap test used `toBeLessThanOrEqual`,
  which also passes if traversal regresses to main-frame-only. Now asserts the
  exact count and the exact frame ids requested; the limit test likewise proves
  child frames were read.
- **F6 Unnecessary `Page.enable`.** Removed. `Page.getFrameTree` does not need
  it (this file already issues other `Page.*` reads without it), and enabling
  Page routes JS dialogs to a debugger client with no
  `Page.handleJavaScriptDialog`, so a `beforeunload` during a snapshot would be
  held rather than shown.
- **F7 Restricted-name guard now reachable.** With the real basename restored,
  `SecurityFilter.isRestrictedPath` can now match a staged upload's filename
  (`token.json`, `passwords.docx`, ...) and return EACCES. This is the guard
  working as designed and is arguably an improvement, but it is a NEW failure
  mode for browser uploads: a legitimately-named document can now be refused.
  Recorded here deliberately; not worked around.

## Review round 2 (second gate returned FAIL, with live CDP probes)

A second independent reviewer ran real Chrome CDP probes and found the headline
fix incomplete. All findings addressed:

- **FR-1 The primary fix did not fix the target page.** CRITICAL. The snapshot
  drops `role === 'generic'` when `interestingOnly`, and Chrome exposes a
  `contenteditable` body -- the body of every rich-text editor -- as role
  `generic` with an `editable` property, NOT as `textbox`. So the merged tree
  fetched the editable body and then filtered it straight back out. The frame
  walk was real but useless for the exact case it was written for. Fixed: any
  node the platform marks `editable` survives the generic/none filter, and the
  value is emitted as `entry.editable` so a caller can identify it. Plain
  generic wrappers are still dropped.
- **FR-2 The honest refusal did not fire for the likeliest wrong uid.** Every
  merged frame now contributes a `RootWebArea` node whose uid resolves to a
  `#document`, not an Element, and `uidTypeFn`/`uidClickFn` called
  `scrollIntoView` before the new guard -- producing an opaque
  `TypeError: not a function`. Both now check `nodeType === 1` first and explain
  what happened.
- **FR-3 The new error message was stale on arrival.** It told callers the tree
  exposes the frame and not the editable body, which the same change made false.
  Rewritten to point at the editable node.
- **FR-4 The shared deadline did not bound total wall-clock.** It was armed
  AFTER `DOM.enable`, `Accessibility.enable` and `Page.getFrameTree` (up to 15s),
  so worst case became 15s + 0.8x budget = 39s against a 30s watchdog -- worse
  than before. The deadline is now armed before the first CDP call.
- **FR-5 One truncation was still undocumented** (frames dropped when the budget
  expires), and nothing pinned the description text. Both fixed; a spec now
  asserts every withholding path is named in the tool description.
- **FR-6 The version guard did not enforce a bump.** Two loose literals could be
  updated together. Replaced with an append-only `version -> hash` history plus a
  uniqueness assertion. Honest limit: no test can force a human to bump a
  version, but a wrong edit is now obvious in review.
- **FR-7 Restricted-filename interaction now pinned** by two tests: `token.json`
  is refused by `SecurityFilter`, an ordinary tender document is not.
- **FR-10 `<button>`/`<option>`/`<data>` still reported false success**, because
  they carry a `value` IDL attribute. The permissive path is now restricted to
  custom elements (which must contain a dash); built-ins that cannot accept
  typed text are refused.
- **FR-9 accepted, not fixed.** The merge accumulates every frame's tree before
  applying `limit`. Bounded by the 25-frame cap and the deadline; restructuring
  to filter inline was judged higher risk than the memory it saves. The F-C
  focusable condition also cuts retained nodes substantially.
- **Cross-frame read scope needs James's explicit sign-off.** The frame merge
  means `browser.accessibility_snapshot` can now return the accessibility tree of
  a same-site but cross-origin in-process subframe, which the top-level origin
  gate (`browser-gateway-service.ts:1291`) does not separately authorize. Not new
  in kind -- `pageBridgeScript` has always injected with `allFrames: true`, so the
  WRITE surface was already this wide -- but this is the first time the READ
  surface follows it, and two reviewers have now flagged it. It is an effective
  widening and should be a decision, not a footnote.
- **`fill_form` cannot be made atomic across frames.** Frames are injected
  simultaneously; a refusal in one cannot call back a write already made in
  another. The report is now accurate about what landed, which is the most this
  layer can offer.
- **FR-10 residual accepted.** A custom element with a non-text `value` (a custom
  slider or checkbox) is still typed into and still reports success, and
  `uidSelectFn` refuses a custom dropdown that `uidTypeFn` would accept. Narrowing
  further needs a per-component judgement this layer cannot make.

### FR-8: the working tree is shared

Flagged by the reviewer and confirmed: a SEPARATE credential workstream appeared
in `src/main/browser-gateway/` during this work (`browser-credential-vault.ts`,
`browser-form-fill-operations.ts`, `browser-gateway-service-types.ts`,
`browser-mcp-config.ts`, `packages/contracts/.../browser-form-fill.schemas.ts`
and their specs), plus a second hunk inside `browser-mcp-tools.ts`. It is not
this author's work and has not been audited here.

Consequences James should know:
- These fixes cannot be committed as a unit without hunk-level staging.
- Any "suite green" claim in this plan measures a MIXED tree.
- The plan's "no change to any credential gate" boundary holds for this author's
  changes but not for the tree as a whole.

## Review round 3 (third gate returned FAIL; two blockers)

The third reviewer also probed live Chrome and found the round-2 fix still did
not reach the caller. Both blockers and the rest are now fixed.

- **F-A BLOCKER: `editable` never left the extension.** The FR-1 exemption
  emitted `entry.editable`, but `normalizeAccessibilityNodes` is an ALLOWLIST
  with no `editable` case and `BrowserAccessibilityNode` had no such field, so
  the value was dropped at the process boundary. (Correction from round 5:
  `BrowserAccessibilityNodeSchema` is NOT invoked at runtime -- its only
  consumers are a type alias and a spec -- so it was two layers on the live path,
  not three. The schema edit is still correct for type parity.)
  Live Chrome reports the editor body with an EMPTY accessible name, so after
  normalization the agent received a bare `{ uid, role: 'generic' }` among other
  unnamed generics -- the node was no longer filtered out, merely unidentifiable.
  Fixed in all three layers, with a test that runs the normalizer AND parses the
  result through the strict schema.
- **F-B BLOCKER: the recommended remedy led into the same bug.** The uid refusal
  tells callers to retry with a CSS selector. That selector path
  (`applyType` -> `setNativeValue`) still ended in `element.value = value` and
  still reported `valueApplied: true` for an iframe or div. So the honest error
  routed an unattended agent straight into an identical silent failure. `applyType`
  now applies the same element-ness and typeability guards.
- **F-C The `editable` exemption over-retained.** `editable` is inherited by every
  node inside an editable region, and Chrome also stamps it on each text input's
  shadow-internal div; retained nodes went 12 -> 27 on the reviewer's probe.
  I re-probed live Chrome 151 independently: only the editable HOST also reports
  `focusable`. The exemption now requires `editable` AND `focusable`, which keeps
  `<body id=tinymce contenteditable>` and the contenteditable div and drops every
  descendant.
- **F-D The deadline still was not armed before the first CDP call.** It sat
  inside the `withDebugger` callback, after the attach (up to 10s) and two
  keep-alive sendCommands (5s each). Moved outside `withDebugger`. The main frame
  now also gets a guaranteed minimum slice, so a slow attach can never turn this
  into a confidently EMPTY tree.
- **F-E `uidSelectFn` was the third uid entry point and had no guard.** Added, and
  the message no longer blames RootWebArea for a `#text` node.
- **F-F `fill_form` discarded its per-field report on failure.** With the new
  refusals, aborting mid-form became far more likely. It still stops at the first
  failure -- writing the rest into a half-filled form is worse -- but the thrown
  error now names which field it stopped at and which fields already applied.
- **F-G The managed-profile path had none of this.** `puppeteer-browser-driver`
  still called `getFullAXTree({})` and its normalizer still dropped every
  `generic`, while sharing the tool description that now promises otherwise. Both
  brought in line: frame walk with the same 25-frame cap and dedupe, plus the
  editable+focusable exemption and `editable` emission.
- **F-H** Description said "Three things" and listed four. Fixed.
- **F-I** Both bundle hashes independently verified genuine by the reviewer.

### Data-scope note

The frame merge means the READ surface now follows the write surface across
frames: a same-site but cross-origin in-process subframe's accessibility tree can
be returned, which the top-level origin gate does not separately authorize. Not
new in kind -- `pageBridgeScript` has always injected with `allFrames: true` --
but this is the first time reads cross frames, and it is recorded here rather
than left implicit.

## Review round 4 (fourth gate returned FAIL)

- **F1 BLOCKER: the new marker pointed at the wrong node.** `case 'editable'` sat
  in the generic property switch, which runs for EVERY retained node, so the
  frame document, every paragraph and every text run inside an editor were all
  stamped `editable: "richtext"` -- four marked nodes for one right answer. A
  paragraph inside a contenteditable ACCEPTS a write and reports
  `valueApplied: true`, so an agent following the tool description would
  overwrite one paragraph of the editor and be told it worked. That is the same
  confident-wrong-write class this work exists to remove, recreated by the fix's
  own marker. Now emitted only when the node is the editable HOST, and the host
  predicate excludes `RootWebArea` (the frame document reports editable AND
  focusable but is a `#document`). Fixed on both the extension and
  managed-profile paths.
- **F2 The `applyType` refusal never reached the caller.** It throws inside the
  injected page function; that frame then contributes no result and
  `mergeFrameResults` reports `No element matches selector` -- false, since the
  element matched and was refused. The refusal now travels back as a
  `__refusal` sentinel that the merge rethrows verbatim.
- **F3 F-F's partial-field report covered only the uid path.** The selector-only
  path (`runInTargetTab`) never reached it, and reported the FIRST field's
  selector while earlier fields were already written. The page-bridge
  `fill_form` now stops at the first refusal and carries back which selectors
  already landed; the merge names the failing field index and that list.
- **F4 The managed-profile walk had no time budget** -- up to 25 sequential CDP
  calls bounded only by puppeteer's per-call timeout, so a snapshot that used to
  be one call could run ~25x longer. Added a 20s wall-clock budget with the same
  "never skip the main frame" rule as the extension path.
- **F5 The managed-profile changes were untested.** Added
  `puppeteer-browser-normalizers.spec.ts` (host-gating, descendant drop,
  RootWebArea, paragraph) and frame-cap + budget tests to
  `puppeteer-accessibility-tree.spec.ts`, including the exact-count assertion the
  extension side already had.
- The comment claiming "only the editable HOST reports focusable" was overstated
  and is corrected: it holds among the roles this filter can drop, which is what
  matters, and RootWebArea is excluded explicitly.

### Concurrent edit by another session

Between round 3 and round 4 another session refactored the puppeteer frame walk
out of `puppeteer-browser-driver.ts` into `puppeteer-accessibility-tree.ts(.spec)`.
That refactor is faithful and has been kept; round 4's fixes were applied on top
of it rather than reverting it. This is the second concurrent change to this
directory (see FR-8) and reinforces that these fixes need hunk-level staging.

## Review round 5 (fifth gate returned FAIL)

The fifth reviewer live-probed Chrome 151 and **confirmed round 4's blocker is
genuinely fixed**: exactly the editable hosts are marked (input, textarea,
contenteditable div, `role=textbox` variant, `tabindex=-1` variant,
`body#tinymce` in a child frame, a designMode body, and a body in a NESTED
iframe), while every paragraph, StaticText, InlineTextBox, input-internal shadow
div and the RootWebArea are left unmarked. Running the shipped `uidTypeFn`
against each marked node succeeded; iframe, button and `#document` were refused.
The selector remedy the refusal recommends was also verified to work in real
Chrome. Four findings remained:

- **1 CONFIRMED, serious: `fill_form`'s "stop at the first failure" does not stop
  across frames.** The page bridge is injected with `allFrames: true` and each
  frame runs the whole field loop independently, so the `break` only stops the
  refusing frame. The reviewer reproduced a sibling frame writing field 3 while
  the error reported "stopped at field 2, already applied: #a" -- an unaudited
  write. On the target page that is an overwrite of the tender response body,
  reported as not having happened. `mergeFrameResults` now unions the applied
  selectors across ALL frames and the message states plainly that the stop is
  per-frame. The concurrency itself cannot be prevented: frames are injected
  simultaneously and cannot be called back.
- **2 CONFIRMED: the managed-profile budget was not a wall-clock bound.** Armed
  after `Page.getFrameTree`, and `BrowserCdpSession.send` takes no timeout, so a
  single wedged call still ran to puppeteer's 180s `protocolTimeout`. **Fixed by
  the other session working in this directory**, not by me: the deadline is now
  armed first and `sendWithDeadline` bounds every call. Verified and kept.
- **3 CONFIRMED: my new budget test was the exact tautology its sibling warns
  against.** `toBeLessThan(5)` also passes at 1, i.e. against regression to
  main-frame-only. Now asserts the exact frame ids requested.
- **4 CONFIRMED: the two round-4 wiring changes had no coverage.** The `type`
  try/catch that converts a thrown `applyType` into a `__refusal` sentinel, and
  the `fill_form` loop that builds `__applied` and breaks, were verified only at
  their two ends and never joined -- which is where finding 1 actually lived.
  Added tests that run the real `pageBridgeScript` in jsdom and assert the
  sentinel, the stop, and the cross-frame union through `mergeFrameResults`.

## Review round 6 (sixth gate returned FAIL)

Three of the five findings were the same defect class this whole effort exists to
remove -- **a real write into a live submission form, reported as not having
happened** -- and all three were reachable through the published tool schema.

- **1 CONFIRMED: an invalid CSS selector discarded the whole frame.**
  `findElement` sat OUTSIDE the try that catches refusals, and `querySelector`
  THROWS on an invalid selector. The frame then contributed no result at all and
  the merge reported `No element matches selector` naming FIELD 1 -- which had
  already been written. `div:contains("Response")` is a textbook unattended-agent
  mistake, so this was live. `findElement` is now inside the try and reports as a
  refusal with the applied list.
- **2 CONFIRMED: the `invalid` branch neither stopped nor reported.** A field with
  no selector pushed `{invalid:true}` and CONTINUED, writing the remaining
  fields, then threw a bare "Invalid form field selector." with no index and no
  applied list. `selector` and `uid` are both optional in the published schema, so
  this is normal input. It now stops and reports like every other failure.
- **3 CONFIRMED: a refusal masked a sibling frame's completed write.** The `type`
  merge took the FIRST frame reporting a match and rethrew its refusal. Chrome
  returns the main frame first, so a selector matching a wrapper `<div>` there and
  the editable body in the editor frame refused AND wrote: the tender body was
  overwritten and the caller told the type failed -- an unattended retry would
  then write twice. The merge now prefers the frame that actually applied and
  surfaces the others' refusals as `ambiguousMatch` + `refusedInOtherFrames`,
  rather than discarding either fact.
- **4 CONFIRMED: the managed-profile budget still did not bound the snapshot.**
  `DOM.enable` and `Accessibility.enable` were issued by the driver BEFORE the
  deadline was armed and were unbounded, so worst case was two 180s
  protocolTimeouts plus the walk. Both hops moved inside the budgeted function.
  Round 7 correction: the 60s main-frame bound described here was overwritten by
  the concurrent author, who deliberately pins the main frame to ONE
  whole-snapshot deadline and has a test asserting it. Their design is coherent;
  the problem was the main frame's SHARE, since three 5s control hops could
  leave it ~5s of a 20s budget. A `MIN_MAIN_FRAME_SLICE_MS` of 15s now raises
  the floor without exceeding the shared deadline, so their tests still hold.
  This file is contested -- see the ownership note below.
- **5 CONFIRMED: the plan claimed a filename guarantee the code did not give.**
  See the Defect 1 correction above.

Also noted and not treated as defects: `__applied` is now dead data on the merge
path (the cross-frame union supersedes it) but is harmless and still accurate
per-frame; and the jsdom page-bridge tests cannot assert the contenteditable
remedy because jsdom does not implement `isContentEditable` -- round 5 and 6
reviewers both verified that path against real Chrome instead.

## Review round 7 (seventh gate returned FAIL)

- **F1 CONFIRMED, blocker: round 6's fix was dead data.** `ambiguousMatch` and
  `refusedInOtherFrames` were built by the merge and then discarded --
  `browser-gateway-service.ts` does not assign the command result and
  `mutationSucceeded` returns `data: null` with a fixed summary. Nothing in the
  repo consumed them. So round 6 converted a loud wrong failure into a QUIET
  UNQUALIFIED SUCCESS, which is worse. The only channel from the extension to the
  caller on a mutation is throw-or-not, so the ambiguity is now an ERROR that
  states the write DID land and must not be retried.
- **F2 CONFIRMED: two frames both applying gave no signal at all.** A generic
  selector present in both the page and an editor iframe wrote twice and reported
  one write. Same error path now covers it.
- **F3 CONFIRMED: `fill_form` still did what `type` was fixed for.** Its per-index
  loop threw on the first frame carrying a refusal without ever checking whether
  a later frame applied that field, so a form whose every field landed reported a
  failed fill. It now prefers the applying frame.
- **F4 CONFIRMED: the plan claimed a 60s main-frame bound that no longer existed.**
  See the Defect 2 correction above.
- **F5 CONFIRMED: `findElement` was moved inside the try for `fill_form` only.**
  `click`, `type`, `select`, `read_control` and `find` still discarded the whole
  frame on an invalid selector, so the caller was told the element was absent and
  would wait for a page state that never arrives. A `findElementSafe` wrapper now
  reports the real reason on all five.
- **F6 CONFIRMED (pre-existing, same class): `select` on a custom dropdown
  reported success having selected nothing.** It resolved with
  `note: 'custom_select_option_not_found'`, and that note was discarded by the
  same boundary as F1 -- so the dropdown was clicked open, left open, and the
  agent told the selection happened. It now rejects.
- **F7 CONFIRMED (low): filename edge cases.** Windows reserved device names
  (`CON.docx` on a Windows node) and names over the 255-character NTFS component
  limit are now handled, extension preserved.

### Ownership note

`puppeteer-accessibility-tree.ts(.spec)` is actively edited by another author.
Round 6's main-frame change was overwritten between gates. Round 7 therefore
adapts to their design rather than reasserting mine, and this plan now records
what the code does rather than what I intended.

## Review round 8 (eighth gate returned FAIL)

All three blockers were created BY round 7. That is the second round in a row
where a fix introduced a fresh instance of the defect it was removing, and it is
the clearest signal in this whole exercise that the gate is doing real work.

- **B1 CONFIRMED: `browser.wait_for` reported SUCCESS for a malformed selector.**
  `findElementSafe` returned `{__found: true, __refusal}` and the wait_for poll
  selects purely on `__found`, so an invalid selector made the first poll report
  that the awaited element had appeared. An agent gating a submission on
  `wait_for` would proceed on a confirmation that never rendered. Pre-round-7 the
  poll correctly timed out. Fixed with a DISTINCT `__invalidSelector` sentinel,
  raised by the merge for every action and by the poll itself.
- **B2 CONFIRMED: a read action was routed through a "the value WAS applied"
  throw.** `read_control` shares the mutation merge branch and writes nothing, so
  round 7 broke `assert_persisted` -- and worse, a `type` that genuinely landed
  reported as FAILED whenever its independent `verify` selector matched in two
  frames. The ambiguity check is now restricted to the value-carrying mutations
  (`type`, `select`). `click` is excluded too: `click('body')` legitimately
  matches every frame and a click carries no value that can overwrite content.
- **B3 CONFIRMED: the custom-dropdown rejection never reached the caller.** The
  round-7 rejection escaped the injected function, so the frame contributed no
  result and the merge reported "No element matches selector" -- replacing a
  silent success with a FALSE FAILURE, telling the agent the control does not
  exist while the dropdown sat open. It now comes back as a refusal sentinel the
  merge rethrows verbatim.
- **4 CONFIRMED: `fill_form` had no double-write signal** though the plan claimed
  it did; its per-index branch is separate from `type`'s. The same form failed
  loudly or silently depending only on whether any field used a uid. Fixed.
- **5 CONFIRMED (same class): a native `<select>` given an unmatched value
  CLEARED the control** -- `selectedIndex` to -1, destroying an existing correct
  selection -- and reported success, because `matchedOption: null` was discarded
  by the same boundary as B3. ProContract's mandatory dropdowns are native
  selects. It now changes nothing and raises, listing the available options.
- **6 CONFIRMED: the stated time bound was wrong for the fourth round running.**
  A 15s main-frame floor plus 15s of control hops was 30s against a documented
  20s ceiling. The control hops are now clamped to
  `remaining - MIN_MAIN_FRAME_SLICE_MS`, so the floor is RESERVED rather than
  additive and the ceiling is real.
- **7 CONFIRMED (low): filename edge cases.** Leading dots were stripped
  (`.htaccess` renamed), the cap counted UTF-16 units where ext4 counts BYTES,
  and `slice` could split a surrogate pair. Now byte-measured, code-point safe,
  and dotfiles are preserved.

## Review round 9 (ninth gate returned FAIL)

- **F1/F2 BLOCKERS CONFIRMED: round 8 fixed ONE of four paths that can blank a
  native `<select>`, and the plan stated it as done.** Round 8 changed only
  `selectValue` (the `browser.select` selector path). Three others still assigned
  an unmatched value straight through the `HTMLSelectElement.prototype` setter,
  which sets `selectedIndex` to -1, CLEARS the control and destroys whatever was
  already chosen -- then reported success, because the payload is discarded:
    - `uidSelectFn` -- `browser.select` by **uid**, the path this entire
      accessibility-snapshot effort exists to promote;
    - `uidTypeFn` -- `browser.type` / `fill_form` by uid;
    - `applyType` -- `browser.type` / `fill_form` by selector, which did NO option
      matching at all, so even a CORRECT visible label ("Yes" where the option
      value is "1") blanked the control.
  `fill_form`'s schema is a flat `{selector|uid, value}[]` with no per-field kind,
  so nothing tells an agent to route a dropdown through `browser.select`: one
  `fill_form` over a ProContract page would blank every mandatory dropdown and
  report the form filled. All four paths now resolve the option first and raise
  with the available options, changing nothing.
- **F3 CONFIRMED: exempting `click` wholesale was the wrong correction.** Round 7
  raised on every action (wrong); round 8 exempted `click` entirely (also wrong).
  Every matching frame has ALREADY dispatched a real click by the time the merge
  runs, so `click('button[type=submit]')` on a page with a same-origin iframed
  form submits BOTH and reports one success. Now raises only when the duplicate
  match is an activating control, which keeps the routine `click('body')` working.
- **F4 CONFIRMED: round 8's clamp starved the later control hops to 1 ms.** Once
  hop 1 used its 5s, hops 2 and 3 got `max(1, ...)` = 1 ms, timed out, left
  `frameIds = [undefined]` and silently reverted the snapshot to MAIN-FRAME ONLY
  -- the original defect, unsignalled, on exactly the heavy pages the budget
  exists for. A `MIN_CONTROL_HOP_MS` floor fixes it.
- **F5 CONFIRMED: the deployment instruction named the wrong version.** It said
  confirm `0.2.3` while the manifest had moved to `0.2.4`. It now says to read
  the version from the manifest rather than trusting the prose.
- **F6 CONFIRMED: the surrogate-pair assertion was vacuous.** The fixture used a
  BMP character (no surrogates), and `normalize()` cannot detect a lone surrogate
  anyway -- it is its own NFC form. Now uses emoji and asserts on lone-surrogate
  patterns directly.
- **F7 CONFIRMED: Windows naming rules were applied on POSIX nodes**, renaming
  legal names (`Q1: Response.docx`, `CON.docx`) in front of the recipient --
  Defect 1's own class. The rules are now chosen from the node's path flavour,
  which was already computed.
- **F8 CONFIRMED (low): `download_file` leaked a pending promise and a listener**
  when its click raised, which the new invalid-selector raise made far more
  reachable.

### Accepted, not fixed

- **F9: `read_control` still takes the first matching frame with no ambiguity
  signal.** A `verify` readback whose selector matches an unwritten main-frame
  wrapper as well as the real control can read the wrapper. Changing the shape of
  a read result risks the internal `verifyMutationReadback` and `assert_persisted`
  consumers, so this is recorded rather than changed. It needs a decision about
  the read contract, not a patch.

## Review round 10 (tenth gate returned FAIL)

- **1 BLOCKER CONFIRMED: `<select multiple>` lost its other selections.** All four
  paths round 9 "fixed" then wrote through the `HTMLSelectElement.prototype.value`
  setter, which per spec deselects EVERY option first. Live-probed: a multi-select
  with `a` and `b` chosen became `['c']`. On a ProContract lot/region multi-select
  that silently unticks existing choices and reports success -- the exact class
  round 9 claimed to have closed on all four paths. They now set
  `option.selected = true` on a multi-select and leave the rest alone.
- **2 CONFIRMED: `MIN_CONTROL_HOP_MS` made the main-frame floor additive again**,
  putting the worst case at 22s against a documented 20s ceiling. Fifth
  consecutive round in which this file's stated bound did not match its
  behaviour, so the comment now states the real arithmetic instead of asserting a
  ceiling the code does not hold.
- **4 CONFIRMED: the click activating-tag rule was tag-only**, so `<div
  role=button>`, `<span onclick>` and `<label>` -- what portals actually use --
  activated in every frame with no raise, while `input[type=text]` over-raised.
- **5 CONFIRMED: four inline option matchers diverged from the repo's own
  `resolveSelectOption`.** `.trim()` does not collapse INTERNAL whitespace, so an
  ordinary indented `<option>Yes,\n  please</option>` was refused on the shared
  tab and accepted on the managed profile -- the two drivers disagreeing about the
  same page. All four now mirror the existing resolver (NFC, collapse whitespace,
  strip trailing `.:*`).
- **6 CONFIRMED: disabled options were selectable**, submitting a value no human
  could choose. Now filtered out.
- **7 CONFIRMED: two paths called `focus()` before deciding to refuse**, firing
  `focus`/`focusin` and potentially arming on-blur validation, contradicting
  "changes nothing". Focus now happens after the match.
- **9 CONFIRMED: the byte cap was applied on Windows too**, where NTFS counts
  UTF-16 units, so a legal CJK/emoji filename was truncated on `windows-pc` --
  the mirror of the POSIX bug round 9 had just fixed.
- **10 CONFIRMED: the deployment note named the wrong version for the third
  consecutive bump.** The literal is gone; it now says to read the manifest.
- **11 CONFIRMED, scope: `background.js` also carries the concurrent credential
  workstream** (`normaliseCredentialOrigin`, `runOriginBoundType`, the
  `expectedCredentialOrigin` parameter). The bundle-history row therefore pins,
  and the deployment note asks James to load, an artifact containing code this
  plan has not audited. The "no credential change" boundary holds for these hunks,
  NOT for the shipped bundle.
- **12 CONFIRMED: the round-9 reason for deferring F9 was wrong.** Preferring the
  frame whose `read_control` result has any of `value`/`selectedLabel`/`checked`
  defined needs no change to the result shape, so the stated risk to
  `verifyMutationReadback`/`assert_persisted` does not apply. Recorded as a cheap
  deferred patch, not a contract question.

## Known limitations (deliberate)

- **No truncation signal in the response.** `browser.accessibility_snapshot`
  returns a bare node array, so there is nowhere to report "frames were skipped"
  without changing the tool's data shape across the whole MCP surface. Deferred
  as a breaking change; the caps are documented in the tool description instead.
- **Defect 2's premise IS now live-verified.** Round 2 probed real Chrome:
  `getFullAXTree({})` is main-frame only, per-frame calls surface the child,
  `Page.getFrameTree` works without `Page.enable`, and `DOM.resolveNode`
  resolves cross-frame. What remains unverified is the behaviour through
  `chrome.debugger` in a loaded extension (extensions do not load in headless
  Chrome) and, above all, **whether ProContract's TinyMCE body is reachable on
  the real page**. FR-1 means that was previously going to fail; it should now
  work, but nobody has run it against the live portal. Do that live check on
  `windows-pc` before trusting this for the 10 September deadline.

## Verification

- `npm test` (quiet runner) for the touched areas, then a full gate run.
- Update `browser-remote-upload-staging.spec.ts` for the new path shape.
- Add extension capture coverage for multi-frame merge + per-frame failure.
- Completion Fresh-Eyes Gate before this is called done.

## Deployment note

All three fixes need an AIO rebuild and restart, and Defects 2 and 3 additionally
need the Chrome extension reloaded on `windows-pc` -- confirm the node then
reports the `extensionVersion` recorded in `manifest.json` -- read it from the
manifest, do not trust a literal in this document. Anything older means the reload did not take and every check below it
is invalid. Read the version from the manifest rather than trusting this line,
which has already gone stale once. A restart drops the Browser Gateway
this session is using and the Liverpool draft is live in a tab, so the restart
is James's call and timing.

Deadline on that bid is 10 September 2026, 11:00.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
