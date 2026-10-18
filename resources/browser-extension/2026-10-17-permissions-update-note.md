# Extension manifest permissions — update note (2026-10-17)

`KNOWN_ISSUES_completed.md` (2026-06-02) says the permission list is
"debugger, scripting, tabs, downloads, `<all_urls>`". That list is stale. This
note is the correction; the `_completed` file is deliberately left unchanged.

The manifest today (v0.2.43) declares:

- `permissions`: activeTab, alarms, debugger, downloads, nativeMessaging,
  scripting, storage, tabGroups, tabs, webRequest, webRequestAuthProvider
- `host_permissions`: `http://*/*`, `https://*/*` (narrower than the note's
  `<all_urls>`)

What each addition since the note is for (each shipped in a versioned bundle —
see `BACKGROUND_BUNDLE_HISTORY` in
`src/main/browser-gateway/browser-extension-assets.spec.ts`):

- `nativeMessaging` — the native-messaging bridge to the gateway/worker relay.
- `storage`, `alarms` — gateway enablement, secret-taint persistence, the 30s
  inventory/recovery alarm, service-worker self-heal.
- `tabGroups` — the blue "Harness" control group for driven tabs.
- `activeTab` — the popup share-tab flow.
- `webRequest`, `webRequestAuthProvider` (0.2.43) — answering Chrome's own HTTP
  Basic/Digest sign-in prompt from a credential staged for one command only
  (`http_auth_navigate`, surfaced to agents as `browser.fill_http_auth`).
  MV3 requires both permissions for `webRequest.onAuthRequired` answering.
