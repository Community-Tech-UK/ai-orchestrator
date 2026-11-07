# Plan — two-factor stop driven by the page's own code box

**Status:** completed 2026-11-05 (code and agent-runnable gates); live checks deferred to
[2026-11-05-one-time-code-field-stop_livetest.md](2026-11-05-one-time-code-field-stop_livetest.md).
James approved the extension-based fix in chat ("yeah do that fix then").
**Follows:** the emailed-code fill fix (same session; brief at
`/Users/suas/work/communitytech/harness-email-code-fill-fix-2026-11-05_prompt.md`).

## Problem (verified)

- On shared extension tabs the action guard sees only the agent's own `actionHint`
  (`browser-gateway-action-guard.ts`, `elementContextSource: 'agent_hint'`). A click is a two-factor
  hard stop only if that hint contains a two-factor word (`browser-action-classifier.ts` `TWO_FACTOR_WORDS`).
- 5 Nov 2026 audit rows: the Report MI code was typed with `browser.type` into `#code` and the
  Continue click was classed an ordinary `submit` and auto-approved. Agents can also read codes
  with their own `imap` tools, so the stop is the only thing between an agent and a completed sign-in
  that the credential authorization never covered.
- The existing page probe (`browser-page-challenge-probe.ts`) uses `read_control`, which the extension
  refuses on any origin a password/secret fill has tainted (`SECRET_OBSERVATION_COMMANDS`,
  `assertSecretObservationAllowed`). Report MI fills the password on the same origin as the code page,
  so a `read_control`-based check would silently see nothing.

## Design

1. **Extension command `probe_one_time_code`** (new, NOT in `SECRET_OBSERVATION_COMMANDS`). Injects a
   self-contained function into every frame and returns booleans only:
   `{ codeField, filled, targetIsCodeField }`. Never the page, a selector match list, or a value.
   A code field is a visible text/tel/number/untyped `<input>` that has
   `autocomplete` containing `one-time-code`; or an `id`/`name` exactly `code`; or `id`/`name`/
   `placeholder`/`aria-label`/associated label text containing a two-factor term (otp, mfa, 2fa,
   totp, two-factor, one-time, verification code, recovery code, passcode, authentication code,
   auth code), camelCase/underscore split; or one of 4–8 visible single-character inputs sharing a
   parent (split-digit boxes). `filled` = any code field has a non-blank value. `targetIsCodeField`
   = the optional payload selector matches a code field (invalid selector → false).
   Leaks at most three bits about the page, which is acceptable on a tainted origin.
2. **Version floor** `BROWSER_EXTENSION_ONE_TIME_CODE_PROBE_MIN_VERSION = '0.2.50'` (manifest bumped,
   bundle hash recorded). An older or stale extension is not sent the command; the probe then
   reports `unavailable` and behaviour is exactly today's (hint-only).
3. **Probe** (`browser-page-challenge-probe.ts`) adds `oneTimeCode` evidence. Shared tabs use the new
   command; managed tabs evaluate the same detection (main frame) through the driver. Probe input
   gains `toolName` and the target `selector` (CSS only; `uid:` targets have no selector).
4. **Classification** (`withPageChallengeEvidence`): CAPTCHA first (unchanged). Then, unless the base is
   already a hard stop or payment/identity:
   - `browser.click` / `browser.press_key` / `browser.evaluate` with a FILLED visible code field →
     two-factor hard stop (`two_factor_challenge`).
   - `browser.type` / `browser.fill_form` whose target is a code field, or a `uid:` target while a
     code field is visible → two-factor hard stop (typing the code can itself submit it).
   An empty code box alone stops nothing (so "Validate Email", "Resend code", cookie banners pass).
5. **Unchanged:** the one-time-code ledger still releases the submit click after a gateway
   `fill_credential` (`email_code`/`totp`), because the reason stays `two_factor_challenge`;
   `fill_credential` itself bypasses the classifier as before.

## Tests

- Classifier: filled code field parks click/press_key/evaluate; empty does not; type into code
  field parks; type elsewhere does not; uid with visible code field parks; payment/CAPTCHA/hard stops win.
- Ledger: gateway code fill then click on a page with a filled `#code` → released as ordinary submit.
- Probe: version floor gating, strict result parsing (exact keys, booleans) fails closed to unavailable,
  managed path.
- Extension function run in JSDOM over fixtures (Report MI `#code`, autocomplete, split boxes, labelled
  OTP, postcode/CPV/discount code negatives, hidden field, blank value); parity with the TS copy on the
  same fixtures; command not in `SECRET_OBSERVATION_COMMANDS`; dispatcher case present.

## Gates

Canonical checklist (AGENTS.md) + fresh-eyes gate, both done (see Status). Live checks moved to the
livetest doc.

## Status

- [x] Extension command `probe_one_time_code` + manifest 0.2.50 + bundle hash
  (`resources/browser-extension/background.js`, `manifest.json`, `browser-extension-assets.spec.ts`).
- [x] Shared page function `ONE_TIME_CODE_FIELD_PROBE_SOURCE`
  (`browser-one-time-code-field-probe.ts`); background.js carries a byte-identical copy (spec-pinned).
  Masked (`type=password`) code boxes included; open shadow roots walked.
- [x] Version floor `BROWSER_EXTENSION_ONE_TIME_CODE_PROBE_MIN_VERSION` and
  `supportsBrowserExtensionOneTimeCodeProbe` (`browser-extension-credential-compatibility.ts`).
- [x] Probe (`browser-page-challenge-probe.ts`): code evidence for click/press_key/evaluate/type/fill_form;
  a refused CAPTCHA read (protected origin) no longer stops the code check, and a failed code read keeps
  CAPTCHA evidence.
- [x] Classification (`withPageChallengeEvidence(…, toolName)`): CAPTCHA now applies only to
  page-acting tools (`PAGE_ACTING_TOOLS`, replaces `PAGE_CHALLENGE_GATED_TOOLS`); code-box rules as designed.
- [x] Guard request type `BrowserGuardedMutationRequest` carries `selector`/`uid`/`fields`;
  targets derived in `browser-one-time-code-submit.ts` (`probeInputTargets`). Guard file stays at 700 lines.
- [x] Agent wording: `adapter-guidance-prompts.ts`, `browser-mcp-tools.ts` (`fields[].kind`).
- [x] Tests: page function over fixtures (Report MI `#code`, autocomplete, labels, split boxes, shadow
  root; postcode/discount/CPV/SIC/card/sort-code/hidden/disabled negatives), extension wiring and frame
  merge, probe, version floor, classifier, guard + ledger.
- [x] Canonical gates (final run after the last change): typecheck, lint, check:ts-max-loc,
  check:ui-hints, build:main, build:renderer all exit 0; full suite 2980 files / 37915 tests passed.
  `typecheck:spec` has one error, in another session's `plan-queue-group-landing.spec.ts`, not this change.
- [x] Fresh-eyes gate: gate 1 PASS; gate 2 FAIL (follow-up hid `emailCode` boxes), fixed; gate 3 PASS.
- Live checks: deferred — see the livetest doc (rebuilt app, restart, and extension 0.2.50 on windows-pc).

## Residual (accepted)

- Detection is name/attribute based: a code box with no identifying id, name, label, placeholder,
  autocomplete hint or split-box shape is not seen, and the hint-only rule still applies.
- A field named exactly `code` that is not a sign-in code (rare) parks a click once it holds a value.
- An accessibility-uid write target parks while any code box is visible (it cannot be resolved in-page).
- Older extensions (< 0.2.50) keep today's hint-only behaviour until updated.
- Label/placeholder/aria-label text alone never makes a field a code box when the field's own id/name
  says email/phone/mobile/telephone/username (or its autocomplete is email/username/tel*) and its
  id/name has no code-like word (code, pin, token, verification, verify). So a real code box named only
  `email` with no autocomplete hint is not seen, while `emailCode`/`phoneCode`/`emailOtp` are. Contact
  fields whose id/name has no separable contact word (`emailaddress`, `phonenumber`, `mailAddress`, an
  opaque `input-27`) and a code-mentioning label can still be read as code boxes (typing into them parks).
- Gate history: fresh gate 1 PASS (raised the email-label false positive); the follow-up fix was failed by
  gate 2 for hiding `emailCode`-style boxes; fixed by the code-word override above.
