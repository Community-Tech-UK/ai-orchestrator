# Browser Gateway: HTTP Basic/Digest sign-in prompts — live checks

Status: pending. Prerequisites: this change committed and the `windows-pc`
worker updated through the normal deployment pipeline, so the unpacked
extension on disk is **0.2.43** (`webRequest` + `webRequestAuthProvider`
permissions, `http_auth_navigate`). The extension then reloads itself on the
version mismatch (at most once per six hours) or reload it manually via the
Harness popup on `windows-pc`. A real Bitwarden vault (AIO-Agent folder) is
required. Do not use the real dev site until check 5.

Plan: [Browser Gateway: answer HTTP Basic/Digest sign-in prompts from the vault](2026-10-17-browser-gateway-http-auth_plan_completed.md).

> **If a defect is reproduced:** read [the live-test campaign runbook](livetest-campaign-runbook.md), record it in [the remediation register](livetest-remediation-register.md), and link an active remediation plan. Never add content to a closed `_completed` plan. Keep per-check evidence here and never include cookies, signed URLs, tokens or credential screenshots.

## 1. Chrome accepts the new permissions without re-approval

- [ ] After the worker update and extension reload, open `chrome://extensions` on `windows-pc` and check the Harness Browser Gateway extension.
- Expected: still enabled, `installType: development` (unpacked), version
  0.2.43, no "re-approve permissions" banner. Its details list Web Request and
  Web RequestAuthProvider. The Browser Gateway channel shows fresh contact
  (`browser.health` ready) and extension version 0.2.43.
- Evidence: extension version + enabled state + a `browser.health` summary.
- Why deferred: needs the rebuilt extension on the real Chrome profile; the
  auto-reload path (`background.js` version-follow, at most once per six hours)
  has never been exercised with a permission change.

## 2. A protected fixture page signs in from the saved login

- [ ] Serve or use a Basic-Auth test endpoint (loopback fixture or a public
  test endpoint with placeholder credentials — NOT the dev site). Enrol a
  matching test login into the AIO-Agent vault folder and approve it for that
  origin (browser.request_credential_access), or reuse an already-approved
  saved login whose bound origin matches.
- [ ] Open the fixture URL through `browser.find_or_open` on `windows-pc` and
  confirm the result/`snapshot` payload reports `httpAuthChallenge`.
- [ ] Call `browser.fill_http_auth({profileId, targetId, vaultItemRef})`.
- Expected: result `{ httpAuth: 'answered', tab: {...} }`; the tab payload shows
  the protected page content; the password appears nowhere in the tool result,
  audit log, or page DOM.
- Evidence: the result JSON (redacted) + the post-sign-in snapshot text.
- Why deferred: needs a rebuilt extension on `windows-pc` and a vault item with
  a live authorisation for the fixture origin (only James can approve one).

## 3. A wrong saved password is refused once, with no prompt loop

- [ ] As check 2, but with a vault item whose password is wrong for the
  fixture, then call `browser.fill_http_auth`.
- Expected: result reports `httpAuth: 'rejected'` (reason `http_auth_rejected`)
  with a summary telling the agent not to ask the user to type it; Chrome's
  dialog does not keep re-appearing; after the command ends no credential
  remains staged (a repeat call must re-resolve from the vault, not reuse
  anything).
- Evidence: the result JSON + a screenshot of the tab state (no password).
- Why deferred: same prerequisites as check 2.

## 4. An unshared tab still gets Chrome's normal dialog

- [ ] On `windows-pc`, open the fixture URL in a NEW tab that is NOT shared
  with the Browser Gateway (not driven, not shared via the popup).
- Expected: Chrome's own username/password pop-up appears normally; the
  extension never records a challenge for it (`httpAuthChallenge` is absent
  from every payload for that tab) and never answers it.
- Evidence: screenshot of the dialog + a `browser.list_targets`/snapshot
  listing showing no `httpAuthChallenge` for that tab.
- Why deferred: needs the rebuilt extension and a human eye on the dialog.

## 5. The real dev site ("Dev site access" login)

- [ ] Once checks 2-4 pass: open the dev site on `windows-pc`, wait for the
  sign-in prompt, and call `browser.fill_http_auth` with the "Dev site access"
  vault item (approved for that origin via browser.request_credential_access).
- Expected: `httpAuth: 'answered'` and the protected area becomes readable to
  the agent; the password never appears in the tool result or page.
- Evidence: redacted result + a snapshot of the protected page.
- Why deferred: plan step 0 explicitly forbade using the real dev site for
  reproduction; only James can approve the real login for that origin.
