# Browser Gateway: answer HTTP Basic/Digest sign-in prompts from the vault

Status: **IMPLEMENTED 2026-10-17**. Steps 0-3 and 5 implemented and verified in-loop; step 4 (managed profiles / Puppeteer) deliberately deferred per Decision 5 — the operation refuses managed profiles with `http_auth_managed_profiles_unsupported` before the vault read. Completion gate: two full fresh-eyes reviews (PASS after fixing 5 findings) plus a focused follow-up pass (PASS). Live checks are deferred to [2026-10-17-browser-gateway-http-auth_livetest.md](2026-10-17-browser-gateway-http-auth_livetest.md).
Owner: James / agent session
Trigger: a Codex session on `windows-pc` found the saved login ("Dev site access") for a
dev site behind HTTP Basic Auth, but told James to type it into Chrome by hand. Its words:
"Basic Auth uses Chrome's own password prompt, which the current secure browser tool cannot
fill." That is accurate for the current code, and it breaks unattended checks on any
password-protected staging or dev site.

## Summary for James

When a site asks for a username and password in Chrome's own pop-up box, rather than a box
on the web page, agents can't fill it today. The plan teaches the Harness Chrome extension
to answer that pop-up itself, using the saved login you have already approved for that site.
The password never reaches the agent. The pop-up stays as it is for every tab the Harness
isn't driving. If the saved password is wrong, the extension gives up after one try instead
of looping.

## What is actually broken (verified by reading code, 2026-10-17)

1. **The secure fill only writes into page fields.** `browser.fill_credential` resolves a
   receiving *frame* and types into a CSS selector (`browser-form-fill-operations.ts:241`,
   `browser-credential-fill-targeting.ts:159-201`, extension `runOriginBoundType`
   `background.js:4006-4125`, page writer `background.js:6256-6302`). Chrome's HTTP auth box
   is browser UI, not part of any frame, so there is nothing to target. The likely result is
   `dispatch:credential_authorized_origin_not_in_frames` or
   `dispatch:credential_selector_not_found`. Verified 2026-10-17 as far as the gates allow:
   on a live challenged test tab, `fill_credential` refuses at
   `credential_not_authorized` (no standing login exists for the test origin, and the plan
   forbids using the real dev site), so the dispatch-level failure remains code-verified
   and is covered by the unit tests.
2. **Nothing handles an HTTP auth challenge.** No `webRequest`, `onAuthRequired`, CDP
   `Fetch.*`, `page.authenticate` or 401 handling exists in `src/main/browser-gateway` or
   `resources/browser-extension`. The manifest has no `webRequest` permission
   (`resources/browser-extension/manifest.json:7-17`).
3. **Navigation reports a stuck prompt as success.** `waitForTabComplete`
   (`background.js:4726-4756`) *resolves* after 15 s even while the tab is still loading. A tab
   held by an auth prompt therefore returns a normal-looking payload from `navigate` /
   `open_tab` (`background.js:2132-2171`). The agent only learns about the prompt from a
   screenshot, if it takes one. **Reproduced live 2026-10-17 on `windows-pc`:**
   `browser.find_or_open` on a public Basic-Auth test endpoint returned
   `outcome: "succeeded"` with `textUnavailableReason: "page_text_read_failed"`, a blank
   screenshot, and no challenge field anywhere; `browser.navigate` returned `data: null`.
   Reproduced at unit level too: the harness test "reports a challenge waiting on a tab
   instead of a silent success" failed against the pre-change build exactly as predicted
   (a normal tab payload, no `httpAuthChallenge`).

## Design

### Mechanism: `chrome.webRequest.onAuthRequired` in the extension

Chrome's documented MV3 route (developer.chrome.com webRequest reference, checked
2026-10-17):

- It needs the `webRequest` and `webRequestAuthProvider` permissions.
- `onAuthRequired` accepts `'asyncBlocking'`, the only event that does.
- The listener can return `authCredentials`, return `cancel`, or take no action, in which
  case Chrome shows its own dialog.
- `details` carries `challenger {host, port}`, `isProxy`, `scheme` and `realm`.
- Chrome may call the listener repeatedly for the same request after bad credentials, and
  the docs warn against looping.

**Rejected: CDP `Fetch.enable({handleAuthRequests})`.** The extension deliberately attaches
the debugger briefly per command and detaches in `finally` (`background.js:2453-2538`). A
long-lived Fetch session would make every other command on that tab fail with
`browser_tab_debugger_busy` (`background.js:2577-2596`). Paused requests would then need
answering, the same trap that keeps `Page.enable` out (`background.js:3615-3620`). Persistent
attach also re-shows Chrome's "started debugging" banner (`background.js:5128-5132`).

### Stage first, then answer (avoid the command-chain deadlock)

The extension runs commands one at a time on `commandChain` (`background.js:1025,
1091-1092`). If the answer arrived as a queued command, it would sit behind the blocked
`navigate` until the watchdog fires. So the credential is **staged inside the command that
triggers the request**:

1. The coordinator runs every existing gate: authorisation, origin binding, extension
   version, then a vault read. It then sends one extension command, `http_auth_navigate`,
   with `{ url, credentialOrigin, username, password, protection }`.
2. The extension validates the origin. It stores
   `{ tabId, origin, username, password, expiresAt, answeredRequestIds: Set }` in
   service-worker memory only, never in `chrome.storage`. The staging key is `tabId`, and it
   lasts until the command ends, capped at the command timeout.
3. The extension calls `chrome.tabs.update(tabId, { url })` and waits for the tab to finish
   loading.
4. The top-level `onAuthRequired` listener answers from the stage only when **all** of these
   hold:
   - `details.tabId` equals the staged tab;
   - `details.isProxy === false` (proxy auth is never answered);
   - `scheme` is `basic` or `digest`;
   - the origin of `details.url` equals the staged origin exactly (scheme, host, port);
   - `challenger.host` and `challenger.port` agree with that origin;
   - the stage has not expired;
   - this `requestId` has not been answered already.
5. A second challenge for an already-answered `requestId` means the password was wrong. The
   listener returns `{ cancel: true }` and records `http_auth_rejected`, so it never loops.
6. In a `finally`, the extension clears the stage and the result carries fixed fields only:
   `{ completed, httpAuth: 'answered' | 'rejected' | 'not_challenged' }` plus the normal
   non-secret tab payload.

Same-origin subresources on the same tab may also challenge while the stage is live, for
example images in the protected area. They are answered under the same rules. Once the stage
clears, Chrome's per-realm credential cache normally covers later requests. If a later
request challenges with no stage, the observe-only path below reports it.

### Observe-only path (fixes the silent false success)

When there is no stage, the listener answers nothing (`{}`), so Chrome shows its dialog as it
does now. For tabs the gateway controls or has been shared, it also records
`{ origin, realm, scheme, at }` per tab, in memory, without credentials. `navigate`,
`open_tab`, `reload` and `snapshot` payloads gain an optional `httpAuthChallenge` field, so
the agent is told plainly to use the new tool. Unshared tabs and proxy challenges are not
recorded.

### Coordinator: new tool `browser.fill_http_auth`

- Inputs: `{ profileId, targetId, vaultItemRef, url? }`. Default `url` is the tab's current
  URL. This uses a strict Zod schema with no origin field: the origin comes from `url` and is
  checked against the live tab, matching `fill_credential`.
- It reuses the existing gates unchanged:
  - shared-tab opt-in `browserAllowSharedTabCredentialFill`;
  - `refreshTargetOrigin`;
  - authorisation `check()` with purpose `login`, secret types `username` and `password`, and
    the `taskScope` / `computerId` / `vaultItemRef` rules
    (`browser-form-fill-operations.ts:274-366`);
  - the origin binding (`browser-credential-vault.ts:383-388, 452-475`).
- **Origin rule:** `url` must be same-origin with the tab's current page, or with the
  authorised origin if the tab sits on Chrome's error or blank page. Anything else is refused
  before the vault is read.
- **Transport rule:** `https:` only, except loopback hosts, reusing `isLoopbackHost`
  (`browser-auto-approve.ts:30`). Basic Auth over plain http sends the password unencrypted.
  Refusal code: `http_auth_insecure_origin`. (Decision 3.)
- **Version gate:** add a new `BROWSER_EXTENSION_HTTP_AUTH_MIN_VERSION`, set to the bumped
  manifest version, beside the existing `0.2.18` gate
  (`browser-extension-credential-compatibility.ts:10`). It is checked before the vault read,
  with fixed code `shared_tab_http_auth_unavailable`. Pollers need the same
  `allowSecureCredentialCommands` capability as today
  (`browser-extension-command-store.ts:518-536`, remote at `remote-extension-bridge.ts:213,
  376`).
- **Output and audit:** fixed codes only, added to the allowlist in
  `browser-credential-fill-targeting.ts:45-77`. Success is
  `{ httpAuth: 'answered', tab: <non-secret payload> }`.
- **No observation taint.** The password never enters the page DOM, so the tab stays
  observable. That is the point: the agent must be able to carry on checking the site. Form
  fills still taint as before. (Decision 2.)
- **Wiring:**
  - `browser-mcp-tools.ts`: tool name list (`:40`), schema, and a description saying when to
    use it;
  - RPC method plus `requireMethod` in `browser-gateway-rpc-server.ts`;
  - the no-strip set and schema map in `browser-rpc-server-support.ts:76,128`;
  - remote offload classification in `browser-remote-offload-policy.ts:53`;
  - the service method in `browser-gateway-service.ts` beside `fillCredential` (`:1870`).
  - The worker relay forwards payloads generically (`worker-extension-relay.ts:287-330`), so
    no worker change is expected. Confirm this during implementation.

### Managed profiles (Puppeteer)

These are lower priority, because the reported case is a shared tab on `windows-pc`.
`page.authenticate({ username, password })` stays in the main process, so the secret never
leaves it. It must be scoped: turn it on only for this one navigation, then call
`page.authenticate(null)`, and check the origin with the same rules. Puppeteer turns on
request interception for this. Check for a clash with the passive `page.on('request')`
listener (`puppeteer-browser-driver.ts:621-623`). Phase 4, can ship separately.

### Agent guidance

- `adapter-guidance-prompts.ts:15` gains one line: "If a page is waiting on Chrome's own
  username/password prompt (reported as `httpAuthChallenge`), use `browser.fill_http_auth`
  with the saved login. Use `browser.request_credential_access` first if it is not approved.
  Do not ask the user to type it in Chrome."
- Follow `docs/prompt-engineering-house-style.md`. Update the guidance prompt specs, including
  the Copilot adapter spec that snapshots this block.

## Implementation steps (all done except 4, deferred by Decision 5)

0. **Reproduce first, on `windows-pc` only.** DONE 2026-10-17 (evidence under
   "What is actually broken" above): a public Basic-Auth test endpoint with
   placeholder credentials (the real dev site was not touched), driven through
   the gateway — silent success + absent challenge field confirmed live, plus a
   failing unit test against the pre-change build. `fill_credential` recorded
   refusing at the authorization gate for the test origin (no approved login
   there exists; approving one is James's call), which is as far as the live
   path can reach without the real site.
1. **Extension.** DONE. Manifest: `webRequest` + `webRequestAuthProvider`,
   version `0.2.43`. `background.js`: named `handleHttpAuthRequired` listener
   (registered `'asyncBlocking'`, the only MV3 mode), `httpAuthStages` /
   `httpAuthChallenges` maps (service-worker memory only), `executeHttpAuthNavigate`
   + `requireHttpAuthString` + `assertHttpAuthSecureTransport`, the
   `http_auth_navigate` case in `executeBrowserCommand`, the `httpAuthChallenge`
   field on tab payloads, fixed codes in `browserCommandErrorMessage`, the
   `BACKGROUND_BUNDLE_HISTORY` row for `0.2.43`, and the manifest assertion.
   The stage is set only AFTER the control lease exists and is cleared on
   success, failure, watchdog release and tab close (completion-gate finding 1).
2. **Contracts and coordinator.** DONE. `BrowserFillHttpAuthRequestSchema`
   (strict, no origin field), `BrowserHttpAuthChallenge` /
   `BrowserFillHttpAuthResult` types, `BROWSER_EXTENSION_HTTP_AUTH_MIN_VERSION`
   = `0.2.43` + capability check, `browser-http-auth-fill-operation.ts`
   (`fillHttpAuthOperation`; every refusal before the vault read),
   `fillHttpAuth` / `httpAuthNavigateForTarget` / `readTargetUrl` in the
   service, and the full wiring (RPC case + `requireMethod`, strict no-strip +
   schema map, remote offload target-scoped set, `http_auth_navigate` treated as
   an origin-bound credential command for the poller capability). The worker
   relay needed no change — its generic forwarding was confirmed, as asked.
3. **Guidance prompt** and tool description. DONE (the plan's wording verbatim;
   guidance-prompt + Copilot adapter snapshot specs updated).
4. **Managed-profile path.** DEFERRED per Decision 5 — `page.authenticate` is a
   separate step. `fill_http_auth` refuses managed profiles before the vault
   read with `http_auth_managed_profiles_unsupported`.
5. **Docs.** DONE: the dated permission note
   (`resources/browser-extension/2026-10-17-permissions-update-note.md`; the
   `_completed` KNOWN_ISSUES file untouched), a `browser.fill_http_auth` section
   in `docs/AIO_MCP_CLI.md`, and the LLM reference note.

## Tests

All the tests listed below are implemented and green (extension harness:
answer scoping, observe-only recorder, rejection anti-loop, untrackable
requestId refusal, stage cleanup on success/failure/watchdog/lease-failure,
storage/result/error secret-freeness, no taint, transport + origin refusals,
fixed validation codes; coordinator: the six gate refusals before the vault
read, answered/rejected/not_challenged mapping, TOCTOU drift refusal, fixed-code
classification, already-tainted refusal + concurrent-taint race, poller
capability both ways, completion-shape fail-closed; contracts: strict schema;
guidance: both snapshot specs). Full gate set from `AGENTS.md` was run green:
`npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, `npm run build:renderer`,
`npm run verify:ipc`, `npm run test:quiet` (33140 passed / 0 failed; the 7
platform skips are pre-existing), `npm run check:dead`.

## Live checks (moved to the livetest doc at completion)

All five live checks now live in
[2026-10-17-browser-gateway-http-auth_livetest.md](2026-10-17-browser-gateway-http-auth_livetest.md).
They need the rebuilt extension reloaded on `windows-pc` and a real vault.

## Decisions (recommendations; say if you want any changed)

1. **Answer the prompt in the extension (webRequest), not through the debugger.** The
   debugger route would fight the existing one-command-at-a-time design. Recommended.
2. **Don't block screenshots after a Basic Auth sign-in.** The password never appears on the
   page, so there is nothing to hide, and blocking would stop the agent doing the checks it
   signed in for. Recommended.
3. **Only send the password over https, or to the machine itself.** A plain-http dev site
   would be refused, because Basic Auth over http sends the password unencrypted. If the dev
   site is http-only, the alternative is a per-approval "allow insecure" switch that only
   James can set.
4. **Reuse the existing "login" approval.** A site already approved for form login can also
   answer its HTTP prompt with the same saved login, with no second approval. The
   alternative is a separate approval type.
5. **The Harness's own browser profiles come later**, as a separate step. The reported case
   is your real Chrome on the Windows PC.

All five recommendations were taken as written (Decision 5 means step 4 is deferred, not
dropped: `fill_http_auth` refuses managed profiles for now and `page.authenticate` is a
follow-up step).

## As-built notes (2026-10-17)

- Completion gate: independent fresh-eyes review #1 returned FAIL with 5 findings (a stage
  cleanup gap on the control-lease failure path; a documented "observation-locked" result
  that production wiring could not reach; post-rejection re-answers; untrackable empty
  requestIds; misleading collapsed code for pre-staging validation errors). All five were
  fixed with regression tests. Review #2 (fresh agent) returned **PASS** with two advisory
  notes; one (the `http_auth_managed_profiles_unsupported` fixed code missing from the
  failure allowlist) was fixed, and a focused third pass on that delta returned **PASS**.
  The other note (an in-flight stage still answers its one navigation if the operator
  switches the gateway off mid-command; the stage is exact-tab + exact-origin + expires at
  the command timeout and the finally still clears it) is accepted as-is and recorded here.
- The extension's fixed-code vocabulary and the main-process allowlist are pinned against
  each other in both directions by `browser-extension-origin-bound-secret.spec.ts`.
- One deliberate deviation from the draft: `attachRefreshedTab` in
  `browser-existing-tab-operations.ts` became a public method so the service can refresh the
  attachment from an `http_auth_navigate` payload without duplicating its options logic.

## Out of scope

- Proxy authentication (`isProxy: true`), which is never answered.
- Making `waitForTabComplete` report a general load timeout. The new `httpAuthChallenge`
  field covers the auth case. A general "still loading" flag is a separate change.
- Client-certificate prompts and NTLM/Negotiate (Windows integrated auth).
