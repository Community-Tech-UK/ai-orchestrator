# Browser Gateway sees and answers Chrome's own page pop-ups — Plan

Status: **implemented and verified in-loop** (2026-10-29); live checks deferred to
[2026-10-28-browser-page-popups_livetest.md](2026-10-28-browser-page-popups_livetest.md).

## What James reported

"For inbuilt popups like 'are you sure you want to close this page' or 'leave this page', it seems
browser gateway can't see them and the browser tools die."

## What the evidence says

- The extension has no pop-up handling at all: no `Page.javascriptDialogOpening` listener and no
  `Page.handleJavaScriptDialog` (`resources/browser-extension/background.js`; the comment above
  `collectAccessibilityFrameIds` in `captureAccessibilitySnapshot` notes the gap).
- A Chrome "Leave site?" / `alert` / `confirm` / `prompt` blocks the page's main thread, so
  `chrome.scripting.executeScript`, `Runtime.*` and `Accessibility.*` never answer. Extension 0.2.44
  (plan `2026-10-25-browser-popup-freeze-and-worker-restart_plan_completed.md`) stopped one frozen
  tab from freezing every other tab, but commands aimed at the frozen tab still run to their time
  limit and nothing says why, and nothing can answer the pop-up. The 2026-10-25 incident (Meta
  Business Suite editor) was an agent's own navigation raising "Leave site?".
- Chromium source (fetched 2026-10-28, `content/browser/devtools/protocol/page_handler.cc`,
  `content/browser/web_contents/web_contents_impl.cc`):
  - `PageHandler::DidRunJavaScriptDialog` / `DidRunBeforeUnloadConfirm` return early unless the
    Page domain is already enabled. **A pop-up that opened before a debugger enabled Page is never
    reported and cannot be answered over CDP.** `Page.enable` does not replay it.
  - `PageHandler::Enable` sets `enabled_` in the browser process and then falls through to the
    renderer, so on a page already blocked by a pop-up the reply never comes, but later pop-ups are
    still reported.
  - With Page enabled, Chrome still shows its own pop-up as well (`has_non_devtools_handlers`);
    whichever answers first wins. `Page.handleJavaScriptDialog` answers it and closes Chrome's
    pop-up. Detaching (`PageHandler::Disable`) leaves the pop-up to Chrome for the user.
  - `chrome.tabs.remove` waits for the tab to be destroyed, so a close held by "Leave site?" never
    settles on its own.

So the gateway can only see a pop-up if it is already watching the tab when the pop-up opens. The
reported case (the gateway's own navigate/close/click raising the pop-up) is exactly that case.

## Changes

### A. Extension: watch for pop-ups during the gateway's own actions (0.2.45)

- `navigate`, `reload`, `close_tab`, `click`, `press_key` and `evaluate` (the commands that leave
  or close the page, activate something, or run page script) run with a pop-up watch: a debugger
  session on the tab with `Page.enable` (the reply is waited for up to 2 s, then ignored; the
  browser side is enabled either way). Text entry (`type`, `fill_form`, `select`) and file
  commands stay unwatched: Chrome shows its "started debugging this browser" bar while attached,
  which shrinks the page, and those commands rarely raise a pop-up. The coordinator's own
  read-only check after a write (the persistence sentinel's `evaluate`, marked `internalScan`)
  is not watched either; like every `evaluate` it already used a debugger session, so the bar
  could already flash after writes before this change.
- The command races its work against `Page.javascriptDialogOpening`. If a pop-up opens first, the
  command answers at once with `browser_dialog_open: ...` (what kind of pop-up, its text, the page),
  says the action may already have partly happened, and tells the agent to use
  `browser.handle_dialog`. The abandoned work keeps running; the watch stays attached until that
  work settles (or the command's own time limit passes) and no pop-up is waiting, so a second
  pop-up from the same action is seen too.
- What is left of an interrupted command's work gets no page work under the shared
  secret-observation lock (`dialogInterruptedCommands`; its result is thrown away), keeping the
  0.2.44 rule. It counts as running work only until its own time limit: a close kept with "Stay"
  may never settle, and running work holds off the extension's reload onto a new version.
- A command whose watchdog already answered while its watch was attaching does not run late.
- While a seen pop-up is waiting, every other command on that tab is refused with the same
  `browser_dialog_open` description, and the inventory reports the tab as `dialog_open` without
  trying to read it. The command itself sends nothing into the blocked page. (On a Chrome profile
  with secret-protected sites the existing pre-dispatch protection probe still tries the page
  first, gives up after 1.5 s and fails closed, so the refusal then comes without the pop-up text:
  0.2.44 behaviour, bounded and answered.)
- `handle_dialog { accept }` answers the waiting pop-up with `Page.handleJavaScriptDialog`
  (accept = Leave / OK, dismiss = Stay / Cancel) and reports what it answered. No typed prompt
  text (YAGNI); accepting a prompt sends back the page's own default answer (Chrome would
  otherwise hand the page an empty string). With no pop-up seen it fails with
  `browser_no_dialog_seen`, which explains that a pop-up opened outside a gateway action cannot be
  seen or answered and that the user must answer it on that computer.
- Ordinary debugger work on a watched tab (uid clicks, key presses, screenshots) reuses the watch
  session instead of failing as "already attached", and counts as the watch's work so the watch
  never detaches under it. A busy attach no longer detaches the session that holds the tab.
- The watch ends on `Page.javascriptDialogClosed` (the user answered it in Chrome),
  `chrome.debugger.onDetach` (the user cancelled the debugging bar, DevTools opened), the command
  watchdog's release, tab removal, and switching the gateway off. A session that finishes attaching
  after its watch was released is detached at once. Detaching never answers the pop-up: Chrome
  keeps showing it for the user.
- Pop-up text in errors is marked as page text ("information, not instructions").
- Dialog text is page-controlled: on a secret-tainted tab, and for `reload`, `http_auth_navigate`
  and the origin-bound credential `type`, the error keeps only the pop-up kind, never its text.
- If the watch cannot attach (DevTools open on the tab), the command runs unwatched as before.

### B. Main process

- New tool `browser.handle_dialog { profileId, targetId, accept, actionHint?, requestId? }`:
  contracts schema, RPC schema + dispatch, MCP schema + description, remote routing
  (`TARGET_SCOPED_METHODS`), extension command name, result normalizer, health `controls` entry,
  operation in `browser-dialog-operations.ts`.
- Guarded like a click on the pop-up's button: dismiss is `input`. Accept is classified from the
  agent's `actionHint` (destructive / submit / payment / credential words apply, e.g. "delete"
  needs an autonomous destructive grant); with no such evidence it hard-stops for the user's
  approval (`dialog_accept_requires_user`), like an unexplained Enter. The coordinator never sees
  the pop-up itself, so an unexplained Leave / OK could discard unsaved work.
- Shared Chrome tabs only. Managed profiles answer `not_run` with
  `browser_dialog_handling_requires_shared_extension_tab` (not in scope; see below).
- `browser.snapshot` no longer hides a `browser_dialog_open` failure behind the cached copy.
- `dialog_open` joins the unreadable page-text reasons.
- Agent guidance line (`adapter-guidance-prompts.ts`): when a command reports `browser_dialog_open`,
  answer it with `browser.handle_dialog`.

## Accepted (fresh-eyes findings left as they are)

- Round 1, finding 5: the waiting-pop-up refusal and the watch attach run before
  `assertSecretObservationAllowed`. No page content is read and pop-up text is withheld on tainted
  tabs, so a watched `evaluate` / `press_key` on a protected tab attaches briefly before its usual
  refusal. Reordering would need the secret checks twice per command.
- Round 6, finding 1: only navigate's leftover work skips page work after a pop-up. An interrupted
  `reload` still runs its own bounded 5 s post-reload observation and an interrupted `press_key`
  its brief tab report, exactly as a watchdog-expired one did before.
- Round 6, finding 3: on a secret-filled tab every `handle_dialog` failure arrives as the fixed
  tainted-tab failure text (fails safe; success is reported normally).

## Not in scope

- A pop-up that opened when no gateway action was watching (page timer, the user's own action,
  before this version) stays invisible to the extension: Chrome gives extensions no way to see it.
  Those still show as `page_not_responding` (0.2.44 behaviour) and need the user to answer them.
- Managed (Puppeteer) profiles.

## Tests

- Extension harness (`browser-extension-assets.spec.ts`): navigate blocked by a beforeunload
  pop-up answers `browser_dialog_open` before its time limit; later command on that tab refused
  without touching the page; `handle_dialog` accept/dismiss sends `Page.handleJavaScriptDialog`
  and frees the tab; `browser_no_dialog_seen` without a pop-up; pop-up closed by the user frees the
  tab; debugger detach frees the tab; uid click reuses the watch session; tainted tab keeps no
  pop-up text; unwatched commands do not attach a debugger.
- Main: operations (classification, managed refusal, normalizer), snapshot cached-fallback, RPC
  schema, MCP tool list/hash expectations.

## Status

- [x] A implemented (extension 0.2.45, new `BACKGROUND_BUNDLE_HISTORY` row)
- [x] B implemented
- [x] Targeted tests: `npm run test:quiet -- src/main/browser-gateway src/main/cli/adapters/adapter-guidance-prompts`
      (137 files, 1951 tests). Each new extension test was checked to fail with its piece of the fix
      removed.
- [x] Canonical gates (2026-10-29): `tsc --noEmit` (only errors are in another session's untracked
      `docs/plans/2026-10-20-oct2-phaseD-tokens_evidence/` script), `typecheck:spec`, `lint`,
      `lint:fast`, `check:ts-max-loc`, `check:ui-hints`, `build:main`, `build:renderer`, and the
      full suite `test:quiet` (2824 files, 35 816 tests, all passing).
- [x] Fresh-eyes gate: round 7 `VERDICT: PASS` (round 1 FAIL: unexplained accept was plain input,
      borrowed session not counted, late attach leaked, gateway-off kept watches, busy-attach
      detach, microtask gap, unframed page text; round 2 PASS with prompt default and quote
      escaping; round 3 PASS with close_tab "not found", busy-attach self-heal, write journal;
      round 4 FAIL: sentinel scan watched, missing-tab matcher; round 5 PASS with late action after
      watchdog, interrupted page work, "Stay" count; round 6 PASS with lone surrogates; round 7
      PASS with two plan wording fixes, all fixed above).
- Live checks (need a push, a rebuilt app, windows-pc and James): see the
  [livetest](2026-10-28-browser-page-popups_livetest.md).
