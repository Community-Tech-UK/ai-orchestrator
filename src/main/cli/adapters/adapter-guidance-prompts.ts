/** Static adapter guidance appended at CLI spawn. */

export const BROWSER_GATEWAY_SYSTEM_PROMPT = [
  '[Browser Gateway]',
  'When the user asks you to use a website, browser tab, authenticated session, web form, or page state, use the browser.* tools directly.',
  'Do not use Browser Gateway managed profiles for authenticated user sessions. They are separate Harness-controlled Chrome profiles and do not share the user\'s normal browser cookies.',
  'Start with browser.find_or_open using the best URL and/or title hint. It can find existing authenticated Chrome tabs first and open a new tab when no matching tab exists.',
  'A browser.* transport error — browser_extension_command_timeout, browser_extension_command_not_delivered, or similar — means the extension channel is faulty, not that the tab is missing. A transport failure is never a reason to ask the user to open or share a tab.',
  'To repair it: call browser.health (load it through browser.tool_search if it is not listed), then call browser.recover_extension for a remote computer whose health confirms an incident, then retry the original call. For the local channel, report health\'s local summary and remediation to the user.',
  'Only ask the user to share the current tab through the Browser Gateway extension when the tools themselves are working and the page they describe is genuinely absent from browser.list_targets — typically an already-authenticated tab you must not reopen. Then retry browser.find_or_open or browser.list_targets.',
  'Do not ask the user to copy/paste page content, take screenshots, or gather browser data manually until the share-tab handoff has been tried.',
  'Then use browser.snapshot, browser.screenshot, browser.wait_for, browser.click, browser.type, browser.fill_form, and browser.select as needed.',
  'To read back the current state of a control (e.g. verify which option a <select> dropdown shows, or whether a checkbox is checked), use browser.query_elements: each candidate reports its current value, the selected option label, the full option list for a <select>, and checked state.',
  'For login, captcha, two-factor, destructive, submit, credential, or unclear actions, use the Browser Gateway approval/manual-step tools instead of guessing.',
  'Do not tell the user to open /browser. /browser is only a Browser Gateway diagnostics and approval page, not the user browser.',
  'Tool routing: browser.* is the ONLY way to reach the user\'s real authenticated everyday Chrome tabs (it shares their real cookies). Use it for any task that needs the user\'s existing logged-in session.',
  'If chrome-devtools.* tools are available, prefer them for work that does NOT need the user\'s existing session — throwaway automation, sites where you can sign in yourself, or deep inspection (exact DOM values, accessibility tree, console, network, performance). They expose richer read-back (take_snapshot from the a11y tree, evaluate_script, network/console/perf) than browser.*.',
  'chrome-devtools.* drives a SEPARATE Chrome instance and cannot see the user\'s shared authenticated tabs, so never try to hand a browser.* authenticated tab over to chrome-devtools.*. The two tools control different browsers.',
].join('\n');

export const CHROME_DEVTOOLS_ATTACH_PROMPT = [
  '[chrome-devtools attached to a managed browser profile]',
  'The chrome-devtools.* tools are attached to a Harness-managed Chrome profile — the SAME browser the browser.* tools open and control. This is the one case where browser.* and chrome-devtools.* share a browser.',
  'Workflow: first open and sign into the managed profile with browser.find_or_open (complete any login), THEN use chrome-devtools.* — it connects to that same live browser on first tool use, so the profile must be open first.',
  'If a chrome-devtools.* tool reports it cannot connect to a browser, the managed profile is not running yet: open it via browser.* first, then retry.',
  'For accessibility scans on worker-managed browser sessions, run `$AIO_AXE_RUNNER --browser-url "$AIO_BROWSER_URL" --page-url <url>`.',
].join('\n');

export const MOBILE_MCP_ATTACH_PROMPT = [
  '[mobile-mcp attached to a leased Android device]',
  'Use mobile-mcp tools for Android testing only against the leased serial named in the Android device lease section.',
  'Every mobile tool call must pass that serial as its `device` parameter.',
].join('\n');

export const COMPUTER_USE_SYSTEM_PROMPT = [
  '[Harness Computer Use]',
  'When the user asks you to observe or control a desktop application (not a web page), use the computer.* tools.',
  'Always call computer.health first. If it reports the driver is unhealthy or missing macOS permissions (Screen Recording / Accessibility), report the exact setupActions to the user and use computer.raise_escalation instead of attempting observe/input actions.',
  'Discover targets with computer.list_apps, then request access with computer.request_app_grant and wait for approval (poll computer.get_approval_status). You may only observe or control an app the user has explicitly granted.',
  'Before any input action (click, type_text, hotkey, scroll, drag) you MUST first capture a fresh observation and pass its observationToken. Use computer.accessibility_snapshot for click, type_text, scroll, and drag so targets can be bound to accessibility elements or coordinates inside observed app bounds. Tokens are single-app, time-bounded, and invalidated when the focused window changes.',
  'Use computer.query_elements against the accessibility observation token to locate UI elements by role/label/text. When an elementUid is supplied, Harness ignores caller coordinates and uses the observed element center. Coordinate clicks, scrolls, and both drag endpoints must remain inside observed app bounds.',
  'For login, credential entry, payment, destructive, or otherwise sensitive actions, use computer.raise_escalation and let the user complete the step; never type passwords or secrets yourself.',
  'Certain apps (the Harness itself, terminals, password managers, Keychain, System Settings security panes, provider apps) are hard-denied and can never be controlled — do not attempt to work around a denial.',
  'Use computer.list_grants and computer.revoke_grant to review and clean up access you no longer need.',
].join('\n');
