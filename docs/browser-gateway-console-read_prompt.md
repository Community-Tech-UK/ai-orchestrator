# Prompt: make browser.console_messages / network_requests work on shared extension tabs

Paste to a coding agent in `~/work/orchestrat0r/ai-orchestrator`. Investigate before
editing. Companion to the archived `_archive/browser-gateway-reliability_prompt.md` and the
in-progress `src/main/browser-gateway/browser-gateway-reliability-reconnect.spec.ts` — this
one is narrowly about **reading console + network from the user's real, shared Chrome tab**.

## The gap (confirmed live, 2026-07-17)

Driving a shared, logged-in Chrome tab on a remote worker (`driver: "extension"`) via the
Browser Gateway:

- `browser.snapshot`, `browser.query_elements`, `browser.accessibility_snapshot`,
  `browser.click`, `browser.type`, `browser.fill_form`, `browser.navigate` — **all work**
  on the tab, using the `profileId` / `targetId` from `find_or_open` / `list_targets`.
- `browser.console_messages` and `browser.network_requests` — **always fail** with
  `{"reason":"profile_target_or_url_not_found"}`, using the *same* ids, on the same
  selected tab, immediately after a fresh `find_or_open`, and **even after the user
  re-shares the tab**. Retrying, reloading via `browser.navigate`, and re-acquiring ids do
  not help.

So: two read tools can't resolve (or can't attach to) an extension-driven target that every
other tool resolves fine. Net effect: the agent cannot read the console errors or failed
requests on the user's real browser session — the exact place a "prod has console errors"
report has to be diagnosed — and is forced to reproduce the site in a separate browser or
ask the user to paste the error by hand. That defeats the point of driving the user's tab.

## Likely root causes (confirm against the code)

- `console_messages` / `network_requests` probably resolve the target through a different
  path than the CDP click/read tools (e.g. they assume a managed/puppeteer profile, or look
  up a Network/Log domain buffer keyed on a target id that is only populated for
  managed profiles, not extension tabs) → the extension target isn't in that map → generic
  `profile_target_or_url_not_found`.
- For extension tabs, no CDP console/network **listener is attached**, so even if resolution
  were fixed there'd be nothing buffered. Extension-driven control uses the debugger
  differently than managed profiles; the console/network capture path may never be wired for
  it.

## Requirements

1. **Same target resolution as the working tools.** `console_messages` and
   `network_requests` must accept and resolve the exact `profileId`/`targetId` that
   `snapshot`/`click` accept for `driver: "extension"` tabs. No tool that can click a tab
   should be unable to read its console.
2. **Attach + buffer for extension tabs.** On (or before) first read, ensure a CDP listener
   is active for the target: console via `Runtime.consoleAPICalled` + `Log.entryAdded`
   (capture `error`, `warning`, and uncaught exceptions via `Runtime.exceptionThrown`);
   network via `Network.responseReceived` / `Network.loadingFailed`. Buffer entries per
   target. Because these are SPAs, **preserve across in-page (history) navigations**, not
   just full document loads — an Angular route change must not wipe the buffer.
3. **Structured output.** Return entries with: level/type, text, source URL, line/col,
   and stack (for exceptions); for network: method, URL, status, resourceType, failure
   text. Enough to pin an error to `file:line` without a screenshot.
4. **Honest failure.** If console/network capture genuinely can't be supported on a given
   driver, return a distinct, descriptive capability error (e.g.
   `console_capture_unsupported_for_driver`) — never the generic
   `profile_target_or_url_not_found`, which reads as "wrong ids" and sends the caller into a
   pointless retry/re-share loop (which is exactly what happened).
5. **Don't require re-share.** Re-sharing the tab must not be a prerequisite; if attach is
   lazy, do it on the first `console_messages`/`network_requests` call.

## Repro / acceptance test

1. Share a real Chrome tab on the worker (extension driver). `find_or_open` a page that
   logs a `console.error` and makes a request that 404s / 401s.
2. `browser.console_messages` returns the logged error(s) with text + source location;
   `browser.network_requests` returns the failing request with its status. (Today: both
   return `profile_target_or_url_not_found`.)
3. Trigger an in-app SPA route change, log another error, read again — the new error is
   present and the earlier ones are preserved.
4. Point at a driver/target that truly can't capture → a clear capability error, not
   `profile_target_or_url_not_found`.

## Constraints

- Preserve everything in `_archive/browser-gateway-reliability_prompt.md` and the reconnect
  work already underway. Don't use `browser.screenshot` as a substitute — it can crash the
  extension renderer (documented in `~/work/aio-remote-browser-gotchas.md`) and can't show
  DevTools anyway.
- Security: console/network payloads can contain tokens/PII. Don't log raw bodies; cap/redact
  as the rest of the gateway does.

## Deliverables

- Fix + unit test for target resolution parity, and one integration test for the repro above.
- Update `~/work/aio-remote-browser-gotchas.md`: note console/network reads now work on
  extension tabs (or the exact remaining limitation) and the new capability-error code.
