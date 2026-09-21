# Browser Gateway Secure Remote Credential Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each production change. Work in the existing checkout; do not create a branch or worktree and do not commit active documents.

**Goal:** Make the secure Instagram credential workflow callable from Codex and usable on an authorised `windows-pc` extension tab without exposing the generated password.

**Architecture:** Use an eager Browser Gateway surface for Codex because its `functions.exec` registry does not consume dynamic MCP list changes. Extend vault creation with explicit non-secret title/login-URI metadata and authorise it against the URI's origin plus the target's stable profile/node scope. For extension fills, carry that trusted origin into the worker, probe frame origins without the secret, and write only inside exact-origin isolated executions.

**Tech Stack:** TypeScript, Electron main process, MCP stdio/JSON-RPC, Zod 4, Bitwarden CLI, Vitest.

**Spec:** [2026-08-28-browser-gateway-secure-remote-credential_spec_completed.md](../specs/2026-08-28-browser-gateway-secure-remote-credential_spec_completed.md)

## Global constraints

- No branch, worktree, commit, push, or real Instagram account creation.
- No password in a model-facing argument/result, log, exception, audit, journal, trace, snapshot, fixture, or test output.
- Preserve the Bitwarden folder jail, exact vault-origin binding, credential authorisations, ordinary Browser Gateway grants, operator-only shared-tab setting, and escalation rules.
- Preserve unrelated dirty-worktree changes, especially the in-progress browser-extension accessibility and upload work.
- Use obvious test-only placeholders, never realistic credentials.

## Task 1: Codex-compatible Browser Gateway tool surface

**Files:**

- Modify: `src/main/browser-gateway/browser-mcp-config.ts`
- Modify: `src/main/browser-gateway/browser-mcp-config.spec.ts`
- Verify: `src/main/browser-gateway/browser-mcp-deferral.spec.ts`
- Verify: `src/main/browser-gateway/browser-gateway-reliability-reconnect.spec.ts`

**Interface:** `resolveBrowserGatewayBridgeSpec(options)` must omit `AI_ORCHESTRATOR_BROWSER_TOOL_DEFERRAL` when `provider === 'codex'`, even if `toolDeferral` was requested. Other providers keep the flag.

- [x] Add and run a failing focused test reproducing the Codex deferral mismatch.
- [x] Implement the provider compatibility policy with an explanatory comment.
- [x] Add coverage that non-Codex providers still receive the deferred flag.
- [x] Run focused config, deferral, normalization-contract, and reconnect tests.

## Task 2: Explicit vault metadata and fail-safe errors

**Files:**

- Modify: `src/main/browser-gateway/browser-credential-vault.ts`
- Modify: `src/main/browser-gateway/browser-credential-vault.spec.ts`

**Interface:**

```ts
interface CreateAgentCredentialInput {
  origin: string;
  username: string;
  itemTitle?: string;
  loginUri?: string;
}
```

- [x] Write failing tests proving the encoded Bitwarden item uses the supplied title and URI while the result contains only the opaque ref and username.
- [x] Write a failing test proving secret-bearing Bitwarden failures cannot surface the generated value or encoded item body.
- [x] Implement metadata mapping and safe error reporting.
- [x] Run the vault tests and confirm the return/error assertions failed before implementation and passed afterward.

## Task 3: Extension-target credential creation

**Files:**

- Modify: `packages/contracts/src/schemas/browser-form-fill.schemas.ts`
- Add: `packages/contracts/src/schemas/__tests__/browser-form-fill.schemas.spec.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service-types.ts`
- Modify: `src/main/browser-gateway/browser-mcp-tools.ts`
- Modify: `src/main/browser-gateway/browser-mcp-tools.spec.ts`
- Modify: `src/main/browser-gateway/browser-form-fill-operations.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service.credentials.spec.ts`

**Interface:** `BrowserCreateAgentCredentialRequestSchema` accepts optional `itemTitle` and URL-validated `loginUri`. `createAgentCredentialOperation` normalizes `loginUri` to its origin, checks the stable credential scope for `register`, and passes all non-secret metadata to the vault.

- [x] Write failing schema/tool-schema tests for the new metadata.
- [x] Write a failing service test: a `windows-pc`-scoped extension target plus Instagram register authorisation creates a credential bound to Instagram and returns no secret.
- [x] Write failing denial tests for missing register authorisation and invalid/credential-bearing URI; retain and run exact-origin fill mismatch coverage.
- [x] Implement the smallest schema, tool, and operation changes.
- [x] Run contract, MCP, form-fill, service-credential, grant, and origin-policy tests.

## Task 4: Secret non-observability and safety regressions

**Files:**

- Modify only if coverage is missing: `src/main/browser-gateway/browser-write-journal.spec.ts`
- Verify: `src/main/browser-gateway/browser-redaction.spec.ts`
- Verify: `src/main/browser-gateway/browser-extension-command-store.spec.ts`
- Verify: `src/main/browser-gateway/browser-gateway-action-guard.spec.ts`
- Verify: `src/main/browser-gateway/browser-mutation-safety.spec.ts`

- [x] Prove extension-fill MCP results and audits omit the generated value.
- [x] Prove the durable write journal records only redacted metadata.
- [x] Prove no model-facing operation resolves an opaque vault reference to plaintext.
- [x] Re-run CAPTCHA, 2FA, legal-declaration, receipt, and no-blind-retry tests.

## Task 5: Build, deploy, and live smoke

**Files:**

- Update only if code changes require it: affected local AIO build artifacts and `windows-pc` worker/extension deployment.
- Create if a genuinely human/external check remains: `docs/superpowers/plans/2026-08-28-browser-gateway-secure-remote-credential_livetest.md`.

Pending human/runtime checks are recorded in
[2026-08-28-browser-gateway-secure-remote-credential_livetest.md](2026-08-28-browser-gateway-secure-remote-credential_livetest.md).

- [x] Run focused suites for all affected surfaces.
- [x] Run `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and `npm run test:quiet`.
- [x] Rebuild the `aio-mcp` forwarder and restart only the affected local AIO components in an isolated profile.
- [x] Update/reload the changed Browser Gateway extension on `windows-pc` while preserving the shared sessions.
- [x] In a fresh Codex session, confirm the normalized credential/accessibility/query/grant/preflight wrappers exist in `ALL_TOOLS` and are callable before search and after restart/reconnect.
- [x] Use the real shared Meta target only for read-only inventory preflight and call the secure create tool no further than a deliberately unauthorised register boundary. Do not create a vault item or account.
- [x] Install/restart the coordinator build and repeat the non-writing live checks. **Deferred live check** — moved to [2026-08-28-browser-gateway-secure-remote-credential_livetest.md](./2026-08-28-browser-gateway-secure-remote-credential_livetest.md) (2 open). Replacing the running app is James's call and timing; the livetest doc also corrects the stale claim that a `Harness.secure-credential-gate19.app` bundle was staged and waiting (it does not exist; a current signed build does).

## Task 6: Independent completion gate and document closure

- [x] Run a genuinely fresh agent with the `task-completion-gate` skill against the acceptance criteria.
- [x] Fix every actionable finding, rerun relevant verification, and repeat with another fresh verifier until `VERDICT: PASS`.
- [x] Record as-built evidence in both documents.
- [x] Update the spec link to the completed plan filename.
- [x] Rename this plan to `_plan_completed.md` and the spec to `_spec_completed.md` only after all runnable checks and the fresh gate pass.

## Verification evidence (active)

- First fresh completion gate: `VERDICT: FAIL`. It reproduced a forged extension-profile/node-scope authorization path and found the Bitwarden encoded-payload error test was vacuous.
- Remediation: extension-shaped profile ids now require an exact trusted extension-store target before live-origin refresh or register authorization; the forged-target test proves authorization/vault code is not called. The Bitwarden test now records the real encoded create argv before simulating stderr echo.
- Second fresh completion gate: `VERDICT: FAIL`. It confirmed both critical fixes and the eager/deferred tool surfaces, but reproduced an unresolved managed-profile CDP call running beyond the AX-tree helper's claimed 20-second budget.
- Remediation: frame discovery and every AX-tree request now race the remaining whole-snapshot deadline; two new tests use unresolved promises for frame discovery and a child tree. The related partial-fill assertion was tightened to require the production message's per-frame and across-all-frames context.
- Third fresh completion gate: `VERDICT: FAIL`. It found a concurrently introduced independent 60-second main-frame allowance outside the 20-second deadline and reproduced the helper suite failing at review start.
- Remediation: domain enables, frame discovery, main AX, and child AX calls now consume one 20-second deadline. A genuinely unresolved main-frame fake-timer test asserts explicit timeout at that total ceiling; the focused set is 4 files / 104 tests green.
- Fourth fresh completion gate: `VERDICT: FAIL`. It proved that the extension command still injected a credential-bearing `type` into every frame before merging results, so a cross-origin iframe could receive the Instagram password and navigation could race the earlier top-level snapshot.
- Remediation: the trusted authorized origin is now carried only on the internal vault-fill command. The extension performs a secret-free all-frame origin probe, requires the main frame to match, rechecks the tab immediately before secret dispatch, targets only exact-origin frame IDs, and rechecks `location.origin` inside the isolated injected function before any DOM write. Secure results omit input values; ambiguous timeouts explicitly say the origin-bound secret write may have applied and must not be blindly retried.
- Fifth fresh completion gate: `VERDICT: FAIL`. It reproduced an origin-bound wrong-control refusal interpolating the credential into a `<select>` error, which the extension could then forward through `command_result.error`.
- Remediation: origin-bound page refusals are now opaque, secret-bearing Chrome injection exceptions are discarded, frame refusals are normalized before merge, and the final native command-result boundary replaces any remaining credential failure with a fixed do-not-retry message. Real shipped-function regressions cover the wrong-`<select>`, Chrome-error, and complete native response paths.
- Sixth fresh completion gate: `VERDICT: FAIL`. It proved a password could be written to an ordinary text input and recovered through `query_elements`; it also measured the managed AX helper settling at 22 seconds because the control-hop and main-frame timeout floors were additive.
- Remediation: extension password writes now require a real masked password input. Every sensitive extension write persists a per-tab taint before secret dispatch and re-arms it after dispatch/races; explicit read/evaluate/screenshot/download surfaces and autonomous inventory/attach payloads fail closed until a real loading navigation. Generic extension verification consumes only the secret-free `valueApplied` boolean. The AX helper now skips exhausted control phases and clamps the mandatory main request to the absolute remaining deadline; an all-phases-unresolved regression settles at 20 seconds.
- Seventh fresh completion gate: `VERDICT: FAIL`. It proved a tainted page could mirror the filled value into `document.title` or a same-origin URL path/query/hash, which the otherwise-redacted autonomous tab payload still returned.
- Remediation: while tainted, `buildTabPayload` now derives its URL only from the persisted trusted authorized origin plus `/` and emits the fixed title `Secret-filled tab`. A real extracted-function regression places the marker in page-controlled title and URL as well as the suppressed text/screenshot sources.
- Eighth fresh completion gate: `VERDICT: FAIL`. It proved a page could mirror the filled value into a later mutation target and recover it from an ordinary selector- or UID-based `command_result`; tainted mutation failures could likewise return page-controlled exception text.
- Remediation: a tab now remains persistently tainted across navigation until it closes. The central native-command boundary replaces every successful tainted-target result with fixed completion metadata and every failure with a fixed ambiguous/do-not-retry error. Extracted shipped-code regressions cover selector and UID click/type/select, fill-form, upload, failure, and navigation persistence.
- Ninth fresh completion gate: `VERDICT: FAIL`. It identified a tab-close race: `onRemoved` could clear persisted taint while a later mutation was still executing, before the central result sanitizer read the state.
- Remediation: the command boundary snapshots taint before dispatch and rechecks only an initially clean target after execution, covering both later mutations and the first origin-bound credential write. A real extracted-function regression closes the tab during the command and proves the page-controlled marker cannot cross the native response.
- Tenth fresh completion gate: `VERDICT: FAIL`. It found contract drift: explicit observation failures and autonomous tab payloads still said `until_navigation` even though navigation deliberately preserves taint until the tab closes.
- Remediation: every model-facing observation-block reason now uses one consistent constant, matching the enforced lifetime and the central fixed mutation result. (**Superseded name, corrected 2026-09-20:** this round shipped `browser_secret_observation_blocked_until_tab_close`; the 0.2.18 remediation below made taint persist *independently of tab lifetime*, so the constant was renamed to the currently-emitted `browser_secret_observation_blocked_for_tainted_origin`. Tab close is no longer the recovery boundary and the name no longer implies it.)
- Eleventh fresh review reproduced a critical first-write race before its provider blocked the formal final response. An authorized page could redefine `tagName` during the secret-bearing input event; if the tab then closed before the post-write taint read, the raw page-controlled status could cross the native response.
- Remediation: the central runner preclassifies every non-public internal origin-bound credential command as sensitive before dispatch, independent of taint storage. The origin-bound page bridge returns fixed `{ __found, valueApplied }` status only and never copies any DOM property. Extracted shipped-code regressions cover page-controlled status and first-write tab-close/storage-clear races.
- Twelfth fresh completion gate: `VERDICT: FAIL`. It found that shared-tab `browser.fill_secret` still accepted only the pre-sanitizer `valueApplied` result, while the shipped extension now returns fixed tainted completion metadata. Successful writes were therefore reported as verified 0/N.
- Remediation: the trusted main-process adapter recognizes only the exact fixed `{ completed: true, observationBlocked: <the observation-block constant> }` sentinel (or the fixed untainted `valueApplied` status). The constant is now `browser_secret_observation_blocked_for_tainted_origin` (`src/main/browser-gateway/browser-extension-credential-compatibility.ts:114`); it was `..._until_tab_close` when this round shipped. A real service integration test proves shared-tab secret fill reports 1/1 without restoring any DOM value or metadata.
- Thirteenth fresh completion gate: `VERDICT: FAIL`. It reproduced that the live 0.2.2 extension ignores the secure origin/protection payload, injects through its legacy all-frame path, and returns page-derived `valueApplied` metadata. The main adapter accepted that legacy boolean and had no runtime compatibility gate.
- Remediation: shared-tab credential and generic-secret fills now require fresh extension-runtime evidence at or above 0.2.17 for the exact local/remote channel before origin lookup, authorization, or vault resolution. The compatibility check repeats immediately before every sensitive dispatch, and password/secret writes accept only the exact two-field taint sentinel; legacy or extra-field acknowledgements fail closed. Focused regression tests prove the old `windows-pc` runtime is rejected before any vault or extension call and a page-derived response cannot validate or leak a secret.
- Fourteenth fresh completion gate review found two remaining delivery-time races before its formal verdict: runtime evidence was replaceable by delayed older-generation messages, and a compatible pre-enqueue check did not bind a queued secret-bearing command to the exact extension poll that dequeued it.
- Remediation: authenticated runtime evidence is now carried on every local/remote extension RPC, recorded monotonically by service-worker start time, and invalidated for missing, malformed, or same-generation-inconsistent evidence. A delayed 0.2.17 result cannot overwrite a newer 0.2.2/missing runtime. The command store independently requires a compatible exact poll before dequeuing every origin-bound credential `type`, including public username fields and requeued handoffs; the pending caller receives only `shared_tab_secure_credential_fill_unavailable`. Local, remote, malformed-evidence, downgrade-replay, and no-vault-resolution regressions are focused-test green.
- Fifteenth fresh completion gate: `VERDICT: FAIL`. It proved that a same-origin sibling tab (or same-origin frame/opener descendant) could mirror a filled value into its URL/title/DOM and leak it through autonomous inventory, and that disconnect/expiry could erase the runtime-generation watermark so a delayed old message restored trust. It also reproduced a compatible runtime downgrading during awaited origin refresh before vault/mailbox/generic-secret resolution.
- Remediation: bundle 0.2.18 persists tainted origins independently of tab lifetime, inherits taint across current and future same-origin tabs, opener descendants, and embedded frames, and fails closed when a potentially tainted frame cannot be inspected. Taint setup and every autonomous tab-payload capture share one serialized boundary, so an already-running capture finishes before any secret exists and every later capture observes taint. Local disconnect and remote expiry now retain a blocked generation tombstone; older/same-generation messages cannot restore trust, while a genuinely newer service-worker generation can. Credential, mailbox-code, and generic-secret operations repeat compatibility checks immediately before resolution and dispatch.
- Sixteenth fresh completion gate: `VERDICT: FAIL` only because the Windows worker/coordinator live deployment remains unavailable. Its review first found that an origin-bound public username command could be dequeued by a legacy poller, the public tool schema still claimed managed-only support, and an already-tainted origin returned the fixed sentinel that the public acknowledgement adapter rejected.
- Remediation: every origin-bound credential write now requires a compatible exact extension poll at dequeue and dispatch, including public usernames. The schema documents operator opt-in, stable node-scoped authorization, secure runtime, and exact vault-bound origin requirements for shared extension tabs. Public writes accept only exact `{ valueApplied: true }` or the exact two-field taint sentinel; password/secret writes still require only the sentinel. A service regression proves password-before-username ordering succeeds on an already-tainted origin without returning page fields.
- Fourth-gate remediation focused evidence: 6 origin-bound extension/service/journal files / 153 tests passed; the focused mutation-timeout set also passed (4 files / 52 tests). `npx tsc --noEmit`, lint, and the LOC ratchet pass; the spec TypeScript check initially found a missing `jsdom` suppression in the new test and was corrected, with rerun pending in the canonical gate.
- Post-sixteenth-remediation focused credential/runtime/origin/extension/MCP suite: 20 files / 422 tests passed, including the full shipped-extension autonomous-inventory race; the deferred registration/reconnect suite separately passed 4 files / 20 tests.
- Accessibility extraction/deadline regression set: 4 files / 104 tests passed after the third-gate remediation; unresolved frame-discovery, main-frame, and child-frame promises are all covered.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed after extracting the existing managed-profile iframe AX-tree walk into a tested helper; no ceiling was raised.
- `npm run build:main`: passed and refreshed `dist/main`/preload.
- `npm run build:aio-mcp-dist`: passed under repository-supported Node 24.15 and rebuilt the CLI bundle + SEA. Node 26.3 lacks the postject SEA sentinel; the two SEA repeatability tests pass under Node 24.15.
- `npm run test:quiet`: post-sixteenth-remediation full rerun passed under Node 24 — 1,814 files / 19,416 tests in 174.4s. A Node 26 run passed the tests except for the known SEA postject-sentinel incompatibility; Node 24 is the supported canonical runtime.
- Live restarted Codex smoke: all six formerly deferred wrappers initially present/callable; safe create call denied before vault access.
- Current bundle is 0.2.18. SHA-256 is `77c922098b1cb6ef46b6d2e5de3d63e755747ed0c7eec449cf63294029f6bed4` for `background.js` and `2b63f8ca7c59a1c1ac7d55276442c5eecde9807bb4f9d798bac3696a880f75f5` for `manifest.json`; the worker bundle `index.js` is `d99aa60c143c36d389c13d56eed5c42d51eeee5f2db44cbced8c7ff0b4a718e9`.
- The supported local packaging pipeline completed under Node 24, including native-module verification, renderer/main/helper/worker/loop-control/MCP SEA builds, Electron signing, and the packaged-startup smoke. The restarted `/Applications/Harness.app` matches the release candidate: its MCP SEA SHA-256 is `7c6b01d7248af1ae83d6012c501bb535671175fd77696f72735b60b80c1b36c1`, and its packaged extension files match the 0.2.18 hashes above.
- After James restarted the worker, the coordinator roster reported `windows-pc` connected with worker start `1788020810993`, the relay registered/running, extension 0.2.18, reload `1788020811771`, and fresh contact. Read-only target inventory confirmed the existing Meta Business Suite and Instagram `12steps.life` extension tabs survived unchanged.
- In the first `functions.exec` cell of the restarted Codex runtime, all six required normalized wrappers were simultaneously present in `ALL_TOOLS` and callable: credential creation, accessibility snapshot, element query, credential fill, grant request, and target preflight. The credential schema includes optional non-secret `itemTitle` and `loginUri` fields and documents secure shared-extension-tab support.
- The live non-writing smoke first confirmed zero active `register` authorisations at the stable `windows-pc` node scope and zero vault bindings for `https://example.invalid`. A single create call using obvious test-only metadata returned `credential_not_authorized:no_authorization_for_profile` with `outcome: not_run`; the binding count remained zero. The redacted audit recorded only the denial, and the write journal contained no credential entry. No password was generated, returned, logged, or displayed; no vault item, grant, browser fill, submit, or account creation occurred.
- Eighteenth fresh completion gate: `VERDICT: FAIL`. It reproduced that an incompatible post-fill extension runtime could still dequeue ordinary observation commands, refresh page-controlled inventory, and return a marker through command results. The compatibility gate covered only origin-bound credential writes, while a downgraded bundle does not enforce persisted origin taint for reads.
- Remediation: every local or remote extension poll now carries an exact-runtime `allowBrowserCommands` decision. An incompatible poll rejects every queued command before delivery; incompatible inventory is rejected before target attachment; incompatible results are replaced with a fixed error before page data can reach the pending caller; and incompatible receipts are ignored. Remote cached targets are suspended until a compatible runtime resumes. Local runtime evidence is stripped only after compatibility validation so the strict tab schema receives no transport-only fields.
- Post-eighteenth-remediation evidence: failing-first command-store, local-ingress, and remote-ingress regressions now pass. The focused security set passed 20 files / 494 tests; the deferred registration/reconnect set passed 4 files / 42 tests; both TypeScript checks, lint, LOC, `build:main`, Node-24 `build:aio-mcp-dist`, `git diff --check`, and the stable Node-24 full suite (1,814 files / 19,421 tests) pass.
- The supported local packaging pipeline and packaged-startup smoke pass after the remediation. The signed candidate is staged at `/Users/suas/Applications/Harness.secure-credential-gate19.app`; its `app.asar` SHA-256 is `0a7289f188999dce73e0b150d38777dbe0e68248864f62cba42c5001e24eb62f` and its MCP SEA SHA-256 is `81a5d8a1ba0900964fa6794c654bc7260e562af8a73feb880c7b7b1b1205cdd8`. Installation/restart and a repeated non-writing smoke remain pending before Gate 19.

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

**Gate 19 (2026-09-20).** A nineteenth fresh reviewer traced the leak paths (MCP results, IPC
responses, error `cause` chains, logs, audit rows, the write journal, snapshot/inventory/query
capture, page title/URL, serialization), origin binding and taint inheritance, runtime-generation
monotonicity, dispatch-time compatibility, concurrency, and authorization scope. `VERDICT: PASS` —
no security gap bypassing the Gate 1-18 remediations.

Its one actionable finding was prose-vs-code drift, now fixed: this plan and the spec still named
the observation-block constant `browser_secret_observation_blocked_until_tab_close`, but the 0.2.18
remediation made taint persist independently of tab lifetime and the emitted constant is
`browser_secret_observation_blocked_for_tainted_origin`
(`src/main/browser-gateway/browser-extension-credential-compatibility.ts:114`,
`resources/browser-extension/background.js:1287,1401,1660,3580`). Both documents now name the
current constant and record the rename.

**Remaining work is a live check, not implementation:** installing/restarting the signed build and
repeating the non-writing smoke on `windows-pc`. That is recorded in the livetest doc and is not
claimed as verified here.
