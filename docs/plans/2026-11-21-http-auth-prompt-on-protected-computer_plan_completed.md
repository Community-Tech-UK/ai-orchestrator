# Browser Gateway: answer Chrome's HTTP sign-in prompt on a computer with a protected site (LT-1197)

## Status

Implemented and verified in code on 21 November 2026: targeted tests, `npm run checks`, full
`npm run test:quiet` (51,603 tests), and two independent reviews (the first found two
protection gaps, now fixed; the second passed). Live checks that need the released extension
on `windows-pc` and a rebuilt, restarted Harness are deferred to
[the live-test document](2026-11-21-http-auth-prompt-on-protected-computer_plan_livetest.md);
they are not verified. Defect: [LT-1197](livetest-remediation-register.md#lt-1197). Known,
not changed here: `open_tab` sets its lease after `tabs.create`, so a very fast 401 on a fresh
tab could go unrecorded (timing-dependent, unmeasured; live check 1 will show it).

## Problem

On 21 November 2026 an agent could not get past the HTTP Basic prompt of
`https://dev.myshellartstudio.com` on `windows-pc`: `request_credential_access` and
`fill_http_auth` were refused with `target_unavailable`, or `invalid_url` with no `url`, and
the tab's address read `https://redacted.invalid/`. The same login worked on `ct-test-mac`.

## Root cause (evidence)

1. Harness log, 01:34-01:35: four `Saved-login tab check failed` lines, every one
   `cause: snapshot_allowed_failed, detail: browser_secret_inspection_unavailable`. Reproduced
   at 11:17 the same day: `browser.find_or_open` on `windows-pc` gave `inspection_unavailable`,
   `https://redacted.invalid/`, and no `httpAuthChallenge`.
2. `windows-pc` has five `login.lcn.com` tabs under secret protection, so the extension checks
   every tab for frames of that site (`taintedFrameOriginsForTabId` runs only when a protected
   origin exists). `ct-test-mac` has no protected tab, so the check never runs there. That is
   the difference between the two computers. `ct-test-mac` runs Chrome 157.0.8103.39; the
   `windows-pc` Chrome version was not read (no route to it short of driving its browser).
3. Throwaway Chrome for Testing 158 on `ct-test-mac` with a probe extension, against
   `https://httpbin.org/basic-auth/user/passwd`: `onAuthRequired` fires, then about 20 ms later
   Chrome commits a blank error page at the challenged URL and `tabs.onUpdated` reports
   `status: complete` while the prompt is still showing. `scripting.executeScript` on the tab
   fails: `Frame with ID 0 is showing error page`. `webNavigation.getAllFrames` lists one active
   frame, `frameId 0`, `errorOccurred: true`, the challenged URL. `webRequest.onCompleted`
   fires at once with status 401, so request events cannot tell when the prompt ends; a new
   top-level navigation can.
4. Consequences. The frame check throws, so `snapshot` (the only read Harness used for the
   tab's origin in `readCredentialTarget`, `refreshTargetOrigin` and `readTargetUrl`) is
   refused. Separately, the extension deleted its `httpAuthChallenges` record on every
   `status: complete`, so the record never survived. That explains the "no challenge reported"
   open question in the 2026-10-17 HTTP auth live test (seen on both computers).

The hypothesis in the source prompt was right about the frame check and the deadlock. It missed
the second fault: the challenge record it suggested using was always deleted.

## Change

- Extension (`resources/browser-extension/background.js`, version 0.2.59):
  - The challenge record is no longer deleted on `status: complete`. It is deleted when a
    top-level navigation starts after it (`webNavigation.onBeforeNavigate`), when the stage
    answers it, or when the tab closes.
  - `pendingHttpAuthChallenge` confirms the record against `getAllFrames` whenever it is used:
    exactly one active frame, the top frame, an error page on the challenged origin. A failing
    frame read reports nothing.
  - A challenge's origin and realm come from wherever the tab navigated, which a page holding a
    typed secret can choose. So nothing about a prompt is reported (tab payloads or the command
    below) when the tab has known protection (own lineage, opener, or site:
    `knownSecretTaintOrigin`, split out of `secretTaintOriginForTab`), when the payload found it
    protected, or when the origin or realm carries a value typed on an auto-released site
    (`writtenSecretOriginIn`). Uncertainty withholds (`httpAuthChallengeMayCarrySecret`). The
    record keeps Chrome's own timestamp so the navigation comparison uses one clock.
  - New command `http_auth_challenge` returns only `{ origin }` of a confirmed prompt. It refuses
    a tab that could pass a secret through the challenge with
    `browser_secret_observation_blocked_for_tainted_origin`, and a tab with no confirmed prompt
    with `http_auth_no_pending_challenge`. It is not a page
    read; `snapshot`, `evaluate`, `screenshot` and the other observation commands stay refused
    exactly as before. Its result passes the native boundary through a fixed-field sanitizer.
- Harness:
  - `readCredentialTarget` (saved-login requests): when the snapshot is refused with
    `browser_secret_inspection_unavailable` on a shared tab, it asks `http_auth_challenge` as the
    requesting session and uses that origin; protection still maps to `target_secret_protected`.
  - `fillHttpAuthOperation`: when the live page reads fail, it uses the prompt's origin for the
    page origin and for the pre-dispatch recheck. With no `url`, it signs into the site's home
    page. Authorisation, vault origin binding, and the extension's exact-origin stage are
    unchanged, so a prompt for another site is refused.
  - `readHttpAuthChallengeOrigin` on the gateway service; sent only to a fresh 0.2.59 or newer
    extension (`supportsBrowserExtensionHttpAuthChallenge`), with a strict reader of the answer.

## Verification

- New tests: extension (prompt kept while Chrome marks the page loaded; record confirmed against
  frames; dropped on a later top-level navigation; origin given on an uncheckable tab while
  snapshot/evaluate/screenshot/query_elements stay refused; refused for a protected tab; refused
  with no confirmed prompt), fill operation (answered for its own site; another site's prompt
  refused by authorisation and by origin mismatch; no prompt or protected still refused;
  recheck), credential target read, service path end to end, compatibility gate and reader.
  The six new extension tests fail against the previous `background.js`.
- `npm run checks` and `npm run test:quiet` pass.
