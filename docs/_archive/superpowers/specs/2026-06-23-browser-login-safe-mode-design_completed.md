# Browser Login Safe Mode Design

## Status

Completed and verified on 2026-06-23. The implementation lives on the browser-login-safe-mode feature branch; keep this document uncommitted until it is included with the completed feature changes.

## Problem

The Harness Browser Gateway Chrome extension causes Cloudflare login verification to fail while the extension is enabled. A/B testing confirms that Cloudflare login works when the extension is disabled and fails when it is enabled.

The likely cause is that the extension is not passive:

- `resources/browser-extension/manifest.json` globally injects `open-shadow-roots.js` into every `http` and `https` page at `document_start`, in all frames, in the page `MAIN` world.
- `open-shadow-roots.js` patches `Element.prototype.attachShadow` and forces closed shadow roots to open.
- `background.js` starts the native bridge, inventories tabs, polls for commands, and can attach `chrome.debugger` or inject scripts when controlling a tab.

Cloudflare Turnstile and Cloudflare login verification probe browser and page behavior. A globally mutating extension is enough to make a real human login look suspicious.

## Goals

- Provide a global operator-controlled "CF Mode" / "Login Safe Mode" for human login flows.
- While Safe Mode is enabled, the extension must be installed but passive enough for Cloudflare-style verification.
- Make Safe Mode easy to toggle from the extension popup.
- Preserve current Browser Gateway automation behavior when Safe Mode is disabled.
- Add regression tests so future extension changes do not accidentally reintroduce global page mutation.

## Non-Goals

- Bypassing Cloudflare, Turnstile, or any anti-bot system.
- Making automation pass production CAPTCHA or challenge systems.
- Solving every challenge-provider issue. The first target is making human login work with the extension installed.
- Building a per-site policy system in the first slice.

## Product Behavior

The extension popup exposes a global toggle labeled "CF Mode". Supporting text describes it as "Login Safe Mode" so the behavior is clear outside the Cloudflare case.

When enabled:

- The extension does not patch `Element.prototype.attachShadow`.
- The extension does not globally inject page scripts.
- The extension does not start or reconnect the native bridge.
- The extension does not inventory or report tabs.
- The extension does not poll for browser commands.
- The extension rejects incoming automation commands with a clear `browser_safe_mode_enabled` error.
- The extension does not use `chrome.debugger`.
- The extension does not call `chrome.scripting.executeScript`.
- The extension does not add control glow or tab groups.

When disabled:

- The native bridge starts or reconnects.
- Existing tab inventory and command polling resume.
- Existing Browser Gateway behavior is preserved.

Safe Mode persists across browser restarts using Chrome extension storage. The default is Safe Mode off to preserve current automation behavior for existing users.

## Architecture

### Manifest

Remove the static `content_scripts` entry that injects `open-shadow-roots.js` globally.

This is the load-bearing change. A Safe Mode flag inside a globally injected script is not sufficient because the injection itself is observable and can still affect page timing or execution order.

### Background Worker

Add a Safe Mode state module inside `background.js`:

- Load state from `chrome.storage.local` at startup.
- Listen for popup messages to toggle state.
- When Safe Mode is enabled, stop polling and disconnect the native port.
- Gate every entry point that can touch pages or the native host.

Entry points to gate:

- `startBridge`
- `connectNativePort`
- `postNativeMessage`
- `pollForCommand`
- `reportTabInventory`
- `reportTab`
- `shareActiveTab`
- `executeBrowserCommand`
- `startControlledTab`
- `withDebugger`
- all `chrome.scripting.executeScript` paths

Gating should happen early so Safe Mode has one clear invariant: no browser-page or native-host activity.

### Dynamic Shadow Access

Because static content-script injection is removed, closed-shadow-root support must move to explicit command-time behavior.

Preferred first implementation:

- Do not dynamically inject `open-shadow-roots.js` at all in the first slice.
- Use the existing CDP accessibility UID path for closed shadow roots where possible.
- Keep selector-based open-shadow traversal for open roots only.

Optional later improvement:

- Add explicit dynamic injection for selected controlled tabs only, after Safe Mode is confirmed off and after a Browser Gateway command has been approved.
- Never inject on known challenge/login origins unless the user explicitly approves that origin.

### Popup

Extend `popup.html` / `popup.js` with:

- A visible Safe Mode toggle.
- Status text:
  - Safe Mode on: "Browser automation paused for human login."
  - Safe Mode off: "Browser automation active."
- Existing "Share active tab" action disabled while Safe Mode is on.
- A reload button remains available for extension development.

Popup changes should use simple native controls; no framework is involved in extension assets.

## Data Flow

1. User opens extension popup.
2. User turns on Safe Mode.
3. Popup sends `set_safe_mode` to background.
4. Background persists state in `chrome.storage.local`.
5. Background disconnects the native port, stops polling, and suppresses inventory.
6. User signs into Cloudflare or another sensitive site manually.
7. User turns Safe Mode off.
8. Background reconnects native bridge, sends fresh tab inventory, and resumes polling.

## Error Handling

- Commands received while Safe Mode is enabled return `browser_safe_mode_enabled`.
- Popup toggle failures surface a short error message in the popup.
- Native port disconnect during Safe Mode is treated as intentional and should not schedule reconnect.
- If storage read fails, default to Safe Mode off but log/surface the failure for debugging.

## Testing

Update `src/main/browser-gateway/browser-extension-assets.spec.ts` and related extension tests:

- Assert `manifest.json` no longer declares a global `content_scripts` entry.
- Assert `open-shadow-roots.js` is not globally injected.
- Assert `background.js` contains Safe Mode gates around bridge startup, command polling, tab inventory, debugger attach, and script injection paths.
- Assert popup code sends and renders Safe Mode state.
- Assert existing extension command serialization tests still pass.

Manual verification:

- With Safe Mode on, sign into Cloudflare in the same Chrome profile with the extension installed.
- Confirm `Element.prototype.attachShadow.__aioOpenShadow` is `undefined` on Cloudflare pages.
- Confirm extension popup shows Safe Mode on and Share active tab is disabled.
- Turn Safe Mode off and verify Browser Gateway can share/snapshot an ordinary non-sensitive page.

## Risks

- Removing global `open-shadow-roots.js` may reduce selector reach into closed shadow roots. The existing CDP accessibility UID path should cover many of those cases, but not every selector-based workflow.
- If any ungated background path still calls `chrome.scripting.executeScript`, Safe Mode may remain detectable.
- A global off switch is intentionally blunt. It may surprise an agent currently waiting on browser automation, so command failures must be explicit.

## Success Criteria

- Cloudflare login works with the extension installed and Safe Mode enabled.
- Cloudflare login still fails or behaves as before only when Safe Mode is disabled.
- Existing Browser Gateway automation works when Safe Mode is disabled.
- Tests prevent reintroducing global page-script injection.
