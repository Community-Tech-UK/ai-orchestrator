# Browser Gateway keyboard, viewport and zoom controls — implementation plan

Status: **implemented and verified in-loop** (2026-10-15). Independent completion gate:
VERDICT: PASS (fifth fresh-eyes pass, no findings). Live Windows acceptance evidence is deferred
to [2026-10-14-browser-gateway-input-controls_livetest.md](2026-10-14-browser-gateway-input-controls_livetest.md)
— it requires a rebuilt coordinator app and the updated 0.2.41 extension bundle on windows-pc
(deploy/restart steps not yet authorised).

Source spec: `/Users/suas/work/Dingley/dingley-kpi/dingley-kpi-be/docs/handover/2026-10-14-browser-gateway-controls-build-prompt.md`
(Windows Browser Gateway keyboard, viewport and zoom controls build prompt, 14 October 2026).

## Goal

Add three Browser Gateway tools usable on real shared Chrome tabs through the
Windows worker (`windows-pc`), with full policy/audit coverage:

1. `browser.press_key` — native keyboard input (Tab, Shift+Tab, Enter, Escape,
   arrows at minimum), real input mechanism (CDP `Input.dispatchKeyEvent` on the
   extension path; Puppeteer keyboard on managed profiles), correct modifier
   send/release including on failure, focused-element read-back without secret
   values, and retry-dedupe so a retried Enter cannot double-activate.
2. `browser.set_viewport` — target content width/height in CSS px (tablet
   testing). Tab-scoped emulation by default (`Emulation.setDeviceMetricsOverride`
   / `page.setViewport`), explicit `scope: 'window'` for real Chrome window
   resize with affected window + other tabs reported and original bounds
   retained/restored. Responses report requested vs actual dimensions including
   `window.innerWidth/innerHeight`, and always say which mode was used.
3. `browser.set_zoom` — real Chrome zoom (100% / 200%) via `chrome.tabs.setZoom`
   with per-tab scope (`setZoomSettings` scope changed to `per-tab`, original
   settings preserved and restored). Read-back of actual zoom + viewport dims.
   Managed profiles fail clearly (no real browser-zoom surface over CDP; CSS
   zoom / transforms / device-scale are explicitly not acceptable substitutes).

## Non-goals

- No rerun of the deferred Dingley keyboard/tablet/zoom test scripts; no KPI
  figure changes; no deploy/push.
- No printable-character text entry through press_key (text stays on
  `browser.type`, which carries the credential/identity hard stops — a
  character-key primitive would bypass them).
- No Mac browser fallback; remote preference + `browser_remote_computer_offline`
  behaviour unchanged.

## Architecture trace (verified by reading, 2026-10-14)

Tool path: `browser-mcp-tools.ts` (tool names/schemas/descriptions) →
`browser-mcp-stdio-server.ts` / deferral / stable surfaces (all derive from
`createBrowserMcpTools`) → `browser-gateway-rpc-server.ts` (offload routing,
`validateBrowserRpcPayload`, switch) → `BrowserGatewayService` →
`BrowserGatewayActionGuard.prepareMutatingAction` (classification + grants +
approvals) → either `PuppeteerBrowserDriver` (managed profiles) or
`BrowserExistingTabOperations.sendCommand` → `BrowserExtensionCommandStore` →
local native host or worker relay on windows-pc →
`resources/browser-extension/background.js` `executeBrowserCommand` →
result normalization + `BrowserAuditStore` + safe DTO.

Nothing exists today for keyboard/viewport/zoom: zero `Input.*` CDP usage in the
extension; typing is JS value-setting/`execCommand`; extension command union has
20 commands and none of these.

## Design decisions

### press_key classification (policy)

- Key allowlist only (Tab, Enter, Escape, arrows, Home, End, PageUp, PageDown,
  Space, Backspace, Delete) — no printable characters, so credential/secret
  typing rules cannot be bypassed through raw keystrokes.
- Activation keys (`Enter`, `Space`) without an informative actionHint classify
  `unknown` + `hardStop` (`press_key_activation_requires_user`), exactly like
  `browser.evaluate`: every activation requires an explicit user-approved grant,
  exact-approval redemption, or a YOLO auto-approve predicate. Hint words still
  classify first (submit → `submit` class (needs autonomy), destructive words →
  `destructive`, password/2FA/CAPTCHA words → credential hard stops), so
  submission/destructive rules are never weaker than `browser.click`.
- Focus-movement keys (Tab/Shift+Tab/Escape/arrows/Home/End/PageUp/PageDown)
  classify `input` + no hard stop — the existing input/navigation approvals.
- `browser.press_key` joins `PAGE_CHALLENGE_GATED_TOOLS` (live CAPTCHA on page →
  credential-class hard stop) and the action guard's existing-tab and
  managed-profile flows (origin policy, denied targets, grants, approvals).
- `press_key` joins `MUTATING_BROWSER_COMMANDS` (not blind-retry-safe) and
  `APP_STATE_MUTATING_COMMANDS` (Enter can save/submit).

### Retry safety for Enter

`browser.press_key` accepts an optional `idempotencyKey`. The extension keeps a
small per-tab recent-command memory: a repeat with the same key returns the
prior result marked `deduplicated: true` and does not press again. Timeouts
therefore cannot double-activate on retry.

### Viewport semantics

- `scope: 'tab'` (default): per-tab emulation only; response reports
  `mode: 'tab_emulation'` plus requested/actual `window.innerWidth/innerHeight`.
- `scope: 'window'`: real `chrome.windows.update`; response reports
  `mode: 'window_resize'`, the affected `windowId`, the other tab ids in that
  window, and the original bounds (retained on the extension side and returned
  in `previous`); `reset` restores them and reports restoration failure
  explicitly if the baseline is gone.
- Neither mode silently stands in for the other; managed profiles support
  `scope: 'tab'` only and fail clearly for `window`.

### Zoom semantics

- Shared extension tabs only. Sequence: capture original zoom factor + zoom
  settings per tab → `setZoomSettings({scope:'per-tab'})` → `setZoom(factor)` →
  read back `getZoom` + viewport dims. `reset` restores the original settings
  and factor and reports restoration failure explicitly if the baseline was
  lost (MV3 worker restart). Response always includes the actual zoom so the
  caller can also restore via an ordinary set.
- Managed profiles: clear unsupported error
  (`browser_zoom_requires_shared_extension_tab`) — CSS zoom/transform/device
  scale are refused substitutes.

### Capability advertisement

- `browser.health` gains a `controls` block naming the three control tools,
  which execution paths support them (shared-tab vs managed-profile), and the
  known limitations (window scope, zoom managed-profile gap).
- Unknown extension commands already fail with a clear `Unsupported browser
  command` error (old extension + new coordinator). Tool schemas/descriptions
  state path support and restoration behaviour.

## Work items

1. Contracts: `BrowserPressKeyRequestSchema`, `BrowserSetViewportRequestSchema`,
   `BrowserSetZoomRequestSchema` (+ result types) in
   `packages/contracts/src/schemas/` with strict objects and key allowlists.
2. `browser-mcp-tools.ts`: names, schemas, descriptions (untrusted warning
   prefix), tool_search wording in `browser-mcp-deferral.ts`.
3. RPC: `browser-rpc-server-support.ts` schema map + `STRICT_NO_STRIP_METHODS`;
   `browser-gateway-rpc-server.ts` switch → `pressKey`/`setViewport`/`setZoom`.
4. Routing/safety: `browser-remote-offload-policy.ts` TARGET_SCOPED_METHODS;
   `browser-mutation-safety.ts`; `browser-target-persistence-sentinel.ts`.
5. Policy: `classifyPressKeyAction` in `browser-action-classifier.ts`;
   `PAGE_CHALLENGE_GATED_TOOLS` += `browser.press_key`.
6. Service: `BrowserGatewayService.pressKey/setViewport/setZoom` following the
   `click`/`evaluate` mutation pattern (guard → recheck → dispatch → effect
   verification for press_key → audit).
7. Managed driver: `pressKey` (page.keyboard), `setViewport`/read/reset
   (page.setViewport), zoom unsupported error.
8. Extension `background.js`: `press_key` (CDP `Input.dispatchKeyEvent` with
   modifier down/up in try/finally + focus read-back + idempotency memory),
   `set_viewport` (Emulation override + window scope with bounds retention),
   `set_zoom` (chrome.tabs zoom APIs + per-tab baseline + restore).
9. Health: `controls` capability block.
10. Tests: contracts, tool surface, RPC schema map, classification, offload,
    mutation safety, sentinel, service routing (existing-tab + managed),
    puppeteer driver, extension harness (modifier release on failure, dedupe,
    zoom restore, window-bounds restore), existing suites stay green.
11. Docs: `docs/BROWSER_AUTOMATION_SETUP.md` tool table; guidance prompts;
    tool_search description; plan/livetest lifecycle documents.
12. Verification: focused tests, canonical checklist
    (`tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`,
    `build:main`, `build:renderer`, `test:quiet`), independent completion gate.
    **As-built:** all gates green (final run: 31,723 tests); completion gate PASS after
    fix → fresh-review cycles (9 findings fixed across 4 review passes).
13. Live acceptance evidence via the Windows Gateway on a benign fixture
    (capture/restore original viewport, window bounds and zoom around every
    check; report restoration failures), then summary to James.
    **Deferred** to the livetest doc: the running production coordinator bridge
    predates the change and the PC's extension runs the 0.2.40 bundle; both
    need rebuild/deploy steps that require James's authority.

## As-built notes

- Tools: `browser.press_key`, `browser.set_viewport`, `browser.set_zoom` (schemas in
  `packages/contracts/src/schemas/browser-input-controls.schemas.ts`, tool catalog in
  `src/main/browser-gateway/browser-mcp-control-schemas.ts` + `browser-mcp-tools.ts`).
- Coordinator logic: `src/main/browser-gateway/browser-input-control-operations.ts`
  (guard/classification/dedupe) and `browser-input-control-driver.ts` (managed-profile page
  operations); service delegates in `browser-gateway-service.ts`.
- Extension: `resources/browser-extension/background.js` commands `press_key` (CDP
  `Input.dispatchKeyEvent`, modifier release in `finally`, idempotency state machine, secret-free
  focus read-back), `set_viewport` (tab emulation + window resize with bounds retention), `set_zoom`
  (`chrome.tabs.setZoom` with per-tab settings and baseline restore). Bundle version **0.2.41**.
- Policy: `classifyPressKeyAction` (Enter/Space gated like `browser.evaluate`; hint words keep
  submit/destructive/credential rules), `PAGE_CHALLENGE_GATED_TOOLS`, `MUTATING_BROWSER_COMMANDS`,
  `APP_STATE_MUTATING_COMMANDS`, `TARGET_SCOPED_METHODS`, `STRICT_NO_STRIP_METHODS` all updated.
- Idempotent activations: `idempotencyKey` dedupe on BOTH paths (coordinator memory + extension
  memory) with started/failed/done states — a retry never re-presses; an unfinished/failed
  original is never claimed as success; the write journal records dedupe dispatches as
  `press_key_deduplicated_no_op`.
- Capability advertisement: `browser.health` `controls` block; clear capability denials
  (`browser_zoom_requires_shared_extension_tab`, `browser_window_resize_requires_shared_extension_tab`).
- Health/self-limit: printable characters are refused (credential hard-stop bypass prevention);
  managed profiles refuse real zoom and window resize; window scope is shared-tab only.

## Acceptance mapping (from the build prompt)

- Tab/Shift+Tab/Enter on a shared windows-pc tab → livetest Check 1 (deferred).
- Tablet layout at verified content width; menus and wide tables → livetest Check 2 (deferred).
- Real zoom reads back 200%, returns to original → livetest Check 3 (deferred).
- Same tab + authenticated session survive → livetest Check 1/4 (deferred).
- Failed/rejected/cancelled/timed-out actions cannot claim success; retries do not duplicate
  Enter → implemented (idempotencyKey state machine + journal honesty) and covered by unit/
  integration/extension-harness tests; live confirmation in livetest Check 4 (deferred).
- Existing navigation/click/fill/snapshot/secure-login coverage unchanged → full suite green
  (31,723 tests) + livetest Check 5 (deferred).

## Notes / constraints honoured

- Work on the supplied checkout/branch (`main`); no new branch or worktree.
- This plan stays untracked until the work is complete and verified; then it is
  renamed `_plan_completed` (or `_livetest` items are split out first).
- No secrets in code, tests or fixtures.
