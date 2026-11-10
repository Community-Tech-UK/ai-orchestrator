# Plan: the typing password stop reads the page's own box

**Status:** completed 2026-11-07 (code and agent-runnable gates). The live checks are deferred to
[2026-11-07-password-box-check_livetest.md](2026-11-07-password-box-check_livetest.md).
James approved in chat ("yeah check the box") after the click-side fix landed in `bdf416f21`.
**Follows:** the same-day change that limited the password words to `browser.type` / `browser.fill_form`
(`TEXT_ENTRY_TOOLS` in `browser-action-classifier.ts`).

## Problem (verified 2026-11-07)

- On shared extension tabs, the guard sees only the agent's own `actionHint`
  (`browser-gateway-action-guard.ts`, `elementContextSource: 'agent_hint'`). A write stops as a credential
  only if that hint contains password / passkey / secret / token.
- Approval log replay (71 recorded credential stops): 20 were typing. Only 4 were real passwords
  (Instagram). Ten were false, for example "Pre-fill DBT Jaggaer username (non-secret)", "Enter the known
  business email only; do not handle a password." and "Set a non-secret description for the ... client secret".
- The rule also misses real password boxes. An agent typing into `input[type=password]` with a hint
  that omits the word is not stopped. `browser.fill_form` on a shared tab passes an `input` override
  (`browser-gateway-service.ts` fillForm, existing-tab branch), so it never had the check at all.
  The extension's raw `type` command does not check the box either. Only the saved-login path
  (`credentialOrigin`) checks.
- Managed tabs inspect the element (`puppeteer-browser-driver.ts` inspectElement), but the rule matched
  words anywhere in the context, `nearbyText` included. So a username box beside "Forgot password?" stopped.

## Design

1. **Password box** = an `<input>` whose `type` is `password`, or whose `autocomplete` contains
   `current-password` or `new-password`. Text boxes labelled "secret" or "token" are not password boxes.
2. **Page function** `ONE_TIME_CODE_FIELD_PROBE_SOURCE` (the extension carries a byte-identical copy) also
   returns `targetIsPasswordField`. It is true when any element matching the target selector, in any
   open shadow root, is a password box. A selector the page cannot parse counts as a password box
   whenever a visible password box is on the page. This fails closed, the same as the code box rule.
   Booleans only, as before.
3. **Accessibility uid targets** (`uid:` writes cannot be resolved in the page). The extension's
   `probe_one_time_code` accepts `uids` and resolves them through the debugger with a small check
   (`uidPasswordBoxFn`, the same rule). The check is bounded at 1.5 s. If any uid cannot be resolved,
   the answer leaves `targetIsPasswordField` out (unknown), unless another target is already a password box.
4. **Wire compatibility.** The reply gains an optional fourth boolean. `parseOneTimeCodeEvidence` accepts
   exactly the three old keys, or those plus `targetIsPasswordField`. An older extension (0.2.50) ignores
   `uids` and answers three keys, so the result is unknown. The manifest goes to 0.2.51, with a new bundle
   hash row. No new version floor is needed, because absence means unknown.
5. **Classification.**
   - `classifyGuardedBrowserAction` runs the probe before classifying, and passes `passwordField` in.
   - `classifyBrowserAction` stops a text write as `credential_or_manual_challenge` when:
     - `passwordField` is known and true, or
     - it is unknown, and the context is inspected and its own `inputType` / `autocomplete` says
       password box, or
     - it is unknown, and the context is the agent's hint and the hint contains the password words
       (today's behaviour, kept only as the fallback).
   - `withPageChallengeEvidence` applies the box answer to overridden classifications too
     (shared-tab `fill_form`). A target that is also a sign-in code box (masked code boxes) stays the
     two-factor step, which has the better recovery path.
6. **Unchanged:** `fill_credential`, `fill_secret`, `fill_http_auth` (they bypass the classifier), and
   reusable credential approvals. Clicks, selects and key presses already ignore the password words.

## Tests

- Page function over fixtures: `type=password`, `autocomplete=new-password`, a username box beside
  "Forgot password?", a "Client secret" text box, a hidden password target, a shadow root, and an
  unparseable selector with and without a visible password box. The four booleans never carry a value.
- Extension: `uidPasswordBoxFn` on the same fixtures; frame merge with `uids` (resolved true, resolved
  false, unresolved means unknown, no targets means key absent); dispatcher unchanged; bundle hash row.
- Parser: old three-key and new four-key replies accepted; a non-boolean fourth key or any other key rejected.
- Probe: sends `uids`; a password answer surfaces as `passwordField`; a three-key answer leaves it unknown.
- Classifier and guard: the replayed false hints pass when the box says no; a hint without the word
  stops when the box says yes; the hint-word fallback applies only when unknown; inspected managed
  contexts follow the box, not nearby text; shared `fill_form` stops on a password box; masked code
  box stays two-factor.

## Residual (accepted)

- A shared-tab `fill_form` whose box is unknown (extension older than 0.2.51, probe failure or timeout,
  an unresolved uid) is not stopped. It has no hint fallback because it arrives with a fixed `input`
  classification. This is no weaker than before the change, when shared-tab `fill_form` was never checked.
- A password box the page has revealed (`type=text`, no password `autocomplete`) reads as an ordinary
  box. Once the page has answered, the hint words no longer apply.
- A text box that holds a secret but is not masked (an API token typed into a plain text box) is not
  stopped. This is the design James approved: check the box, not the label.
- An older app would reject the four-key reply of a newer extension and lose the code box evidence
  until it is updated. The app and the extension ship together, so this is theoretical.

## Gates

Canonical checklist (AGENTS.md) and the fresh-eyes gate. Live checks need the rebuilt app and
extension 0.2.51 on windows-pc, so they go to a livetest doc.

## Status

- [x] Page function: `targetIsPasswordField` added to `ONE_TIME_CODE_FIELD_PROBE_SOURCE`, with a byte-identical
  copy in `background.js`. Extension `probe_one_time_code` accepts `uids` and resolves them through the
  debugger (`uidTargetsIncludePasswordBox`, `uidPasswordBoxFn`). Each uid is checked separately; a stale,
  malformed or capped (over 50) uid makes the answer unknown, never "no". Manifest 0.2.51 with a bundle
  hash row.
- [x] `parseOneTimeCodeEvidence` accepts three or four boolean keys. `BrowserProbeInputTargets` is now
  `{ selectors, uids }`. Evidence carries `passwordField`. The managed page function's answer counts
  only for selector-only targets.
- [x] `classifyGuardedBrowserAction` probes before classifying. `writesPasswordBox`: a yes from the page,
  or from the inspected element's own type/autocomplete, stops the write. The agent's words count only
  when the page gave no answer. `withPageChallengeEvidence` stops overridden writes (shared
  `fill_form`) into a password box, and lets a code box take precedence over a password stop.
- [x] Tests: page function fixtures (yes/no lists shared with the uid check), extension merge and uid
  paths, parser, probe, classifier, guard (real approval-log hints), managed approval fixture.
- [x] Canonical gates. Results after the final review fix:
  - Passed: `tsc`, `typecheck:spec`, lint, `check:ts-max-loc`, `build:main`, and the browser gateway
    suite (2257 tests).
  - The earlier full run passed: `check:ui-hints`, `build:renderer`, and 39805 tests.
  - The last full run had 38 failures, all in `src/main/plan-queue/*`. Another session's uncommitted
    `plan-queue-run-readiness.ts` rejects runs ("no typecheck:spec command"). None of those failures
    are from this change.
- [x] Fresh-eyes gate:
  - Gate 1 FAILED with three findings: a stale uid hid a later password uid; dropped uids counted as
    "no"; the managed page answer could override an inspected password box. All three were fixed and
    tested.
  - Gate 2 PASSED.
- [x] Livetest doc written.
