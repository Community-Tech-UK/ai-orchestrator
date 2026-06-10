# Remote Browser Automation — Operator Runbook

How to turn on browser automation for a worker node (e.g. `windows-pc`) so agents
spawned there get `mcp__chrome-devtools__*` tools driving a logged-in Chrome.

> **Implements Path 1 of** `docs/superpowers/specs/2026-06-09-remote-browser-automation-plan_completed.md`.
> The worker owns a single Chrome (remote-debugging, dedicated profile) and injects
> a `chrome-devtools` MCP server into every CLI instance it spawns.

---

## Security — read first

`chrome-devtools-mcp` has **no approval / grant / audit layer**. An agent on a
browser-enabled node can do *anything* in that Chrome — navigate, click, submit
forms, read page content.

- Enable **only** on trusted, owned nodes.
- Point `profileDir` at a **dedicated automation profile** that is logged into
  **only** the sites the agent should touch (e.g. the BinsOut Facebook page). Never
  the user's everyday Chrome profile holding banking / email / personal logins.
- The CDP port stays bound to **loopback** on the node — it is not exposed to the
  LAN. Agents reach it only by running on that node.

## Platform support

The worker resolves Chrome/Chromium (or Edge as a Chromium fallback) on
Windows / macOS / Linux. Node 18+ is required on the worker (for global `fetch`).

---

## Enabling from the app (recommended)

**Settings → Remote Nodes → Connected Computers.** Each node shows a
browser-automation readiness badge:

- **Ready** — enabled *and* the managed Chrome is verified up right now.
- **Enabled (starts on first use)** — configured, but Chrome launches lazily on
  the first browser-enabled spawn, so it isn't running yet. This is the normal
  state for a freshly-enabled node.
- **Chrome only** — Chrome is installed but automation isn't enabled.
- **Off** — no Chrome runtime detected.

On any
node with Chrome:

1. Click **Configure browser automation**.
2. Tick **Enable browser automation**, optionally set a profile directory and
   headless mode, and click **Apply**. This pushes the change to the node over a
   privileged (service-scoped) `config.update` RPC; the node persists it, restarts
   its managed Chrome if needed, and re-reports capabilities. A freshly-enabled
   node normally shows **Enabled (starts on first use)** within a heartbeat, then
   flips to **Ready** after the first browser-enabled spawn launches Chrome.
3. Under **One-time profile login**, use **Copy command** (run it on the node) or
   **Run on node** (launches the login Chrome on that machine's screen). Log in,
   then close that Chrome window.

> **Run on node** opens Chrome on the *node's* physical display — you must be at
> that machine, or connected via remote desktop, to complete the login.

The manual config-file path below is equivalent and still supported (e.g. for
headless servers or scripted provisioning).

## 1. Configure the worker (manual alternative)

Edit the worker's config file (`~/.orchestrator/worker-node.json`, or the
service-mode config path) and add a `browserAutomation` block:

```jsonc
{
  // ...existing nodeId / coordinatorUrl / token fields...
  "browserAutomation": {
    "enabled": true,
    // Optional. Defaults to ~/.orchestrator/browser-automation-profile.
    // MUST NOT be the user's everyday Chrome user-data-dir (Chrome locks it).
    "profileDir": "C:\\Users\\shutu\\.orchestrator\\fb-automation-profile",
    // Optional. false (headful) is recommended on an unattended node — some
    // sites behave differently headless, and you can watch/log-in headful.
    "headless": false
    // Optional: "chromePath", "remoteDebuggingPort" (default: ephemeral free port)
  }
}
```

Rules enforced by the loader (`worker-config.ts`):
- The block is **ignored unless `enabled` is exactly `true`** — a partial/malformed
  block can never silently turn automation on.
- Malformed optional fields are dropped (blank `profileDir`, non-boolean
  `headless`, out-of-range `remoteDebuggingPort`).

Restart the worker after editing.

## 2. Log the automation profile into the target site (one time)

Chrome locks a `user-data-dir` to a single process, so the automation profile is
**separate** from the user's normal Chrome and starts logged out. Log it in once:

1. On the node, close nothing — just launch Chrome **against the automation
   profile** manually (replace the path/port to match your config; pick any free
   port):

   ```powershell
   & "C:\Program Files\Google\Chrome\Application\chrome.exe" `
     --user-data-dir="C:\Users\shutu\.orchestrator\fb-automation-profile" `
     "https://www.facebook.com"
   ```

2. Log in (credentials + any 2FA), let "remember this browser" persist the session,
   then **fully quit** that Chrome window.

The session now lives in `profileDir` and the worker-managed Chrome will reuse it.

> Tip: keep `headless: false` while validating; the worker's Chrome reuses the same
> profile, so once login persists you can flip to headless if desired.

## 3. Verify the node advertises the capability

From the coordinator (the Mac app), the node should now report
`hasBrowserMcp: true`. Either check the node list UI, or via the orchestrator MCP
`list_remote_nodes` — look for `"hasBrowserMcp": true` on the node.

If it's still `false`:
- `enabled` isn't exactly `true`, **or**
- no Chrome/Chromium executable was found (set `chromePath` explicitly), **or**
- the worker wasn't restarted after the config change.

## 4. Run a browser job on the node

Spawn an agent on the node (e.g. orchestrator `run_on_node`, or target the
`browser` / `browser-mcp` capability tag). The agent will have
`mcp__chrome-devtools__*` tools. First browser tool call lazily launches the
managed Chrome (subsequent spawns reuse it).

Smoke test prompt: *"Use chrome-devtools to navigate to https://example.com and
report the page title."*

## 4.1 Browser audit tooling

Browser-enabled worker spawns also receive:

- `AIO_BROWSER_URL` — the managed Chrome CDP endpoint.
- `AIO_AXE_RUNNER` — the bundled axe runner path
  (`dist/worker-tools/axe-audit.mjs`).

Run accessibility checks from the agent shell:

```bash
"$AIO_AXE_RUNNER" --browser-url "$AIO_BROWSER_URL" --page-url "https://example.com" --viewport 1440x900 --tags wcag2a,wcag2aa
```

The runner opens a fresh page through the same managed Chrome, runs axe-core, and
prints JSON containing violations plus pass/incomplete counts. Pair it with
chrome-devtools screenshots and viewport emulation for UI/UX audits.

## 5. Routing notes

- `requiresBrowser` placement now **prefers** nodes with `hasBrowserMcp` (a +40
  score boost) over nodes that merely have Chrome installed.
- Capability tags: `browser` prefers an automation-ready node but falls back to
  Chrome-installed; `browser-mcp` matches **only** automation-ready nodes.

## Lifecycle / troubleshooting

- The managed Chrome launches on the **first** browser-enabled spawn and is reused.
- If Chrome fails to start, spawns still succeed **without** browser tools (logged:
  `browser automation enabled but Chrome failed to start`) — degrade, don't block.
- The worker kills the managed Chrome on shutdown.
- Ephemeral port: the worker reads Chrome's chosen port from the profile's
  `DevToolsActivePort` file. A stale file from a crash is cleared before each launch.

## Constraints & operational notes

Known limitations — none are bugs, but plan around them:

- **Worker redeploy required.** Enabling from the coordinator UI is not enough on
  its own: the **worker build on the node must include this feature** (the
  `config.update`, `browser.stopManaged`, and CDP-tunnel handlers). Update/redeploy
  the worker on the node before enabling. An older worker will reject the
  `config.update` RPC (`method not found`).
- **First spawn needs network.** The injected `chrome-devtools-mcp` server runs via
  `npx`, so the **first** browser-enabled spawn on a node fetches the package from
  npm (network + a few seconds) and caches it. The version is **pinned**
  (`CHROME_DEVTOOLS_MCP_VERSION` in `chrome-devtools-mcp-config.ts`, currently
  `1.2.0`) rather than `@latest`, so the cache is deterministic — the fetch happens
  once per pinned version with no mid-automation upgrades. Bump that constant
  deliberately to adopt a newer release. Pre-warm an offline node with
  `npx -y chrome-devtools-mcp@1.2.0 --help`.
- **Axe runner is bundled.** `@axe-core/puppeteer` is bundled into
  `dist/worker-tools/axe-audit.mjs` during `npm run build:worker-agent`; agents
  invoke it via `AIO_AXE_RUNNER`, so they do not need to install another MCP
  server.
- **Windows npx is handled automatically.** On Windows there is no `npx.exe` (only
  `npx.cmd`) and modern Node refuses to spawn a `.cmd` shell-less, so the config is
  emitted as `cmd /c npx …` on win32 — no operator action needed. (Without this the
  MCP server silently fails to start and no `mcp__chrome-devtools__*` tools appear.)
- **Login needs interactive access to the node.** "Run on node" (and any manual
  profile login) opens a **headful Chrome on that machine's physical screen** — you
  must be at the node, or on remote desktop, to complete the login. The coordinator
  only fires the command. Before launching, the node's managed Chrome is **stopped**
  so the login Chrome can take the profile-dir lock; it relaunches (now logged in)
  on the next browser-enabled spawn.
- **Opt-in only; no auto-migration.** Browser automation is **off by default** and is
  never auto-enabled on existing or newly-paired nodes — turning on an ungoverned
  automation surface must be a deliberate per-node choice. There is no bulk/migration
  enablement by design.
- **Reversible, but sticky until disabled.** Once enabled, agents on that node keep
  browser tools until you explicitly disable it. Disabling is immediate: it stops the
  managed Chrome and clears `hasBrowserMcp` within a heartbeat. Toggle it off from the
  same per-node form.
- **Authorization model.** The enable/login IPC handlers share the trusted-operator
  model of the other `service.*` node actions (anyone driving the desktop app can call
  them). The in-app **confirmation prompts** before enabling and before "Run on node"
  are the deliberate authorization gate at that layer.

## Product guardrails (for posting/commenting jobs)

When the job posts content (e.g. Facebook comments), rate-limit, randomize timing,
and cap volume per window. Bursts of business comments are exactly what trips
platform spam detection and can get the page restricted — a real risk to the asset.
