# Browser Gateway restricted-session startup: installed-app check

Status: pending. Prerequisites: rebuild/install Harness through the normal local build pipeline with this repair, then restart the app. Do not replace a running app bundle from an agent or disable hardened mode to pass the check. The Windows worker must be online with a healthy extension channel. No worker update is required by this repair.

Plan: [Browser Gateway hardened startup repair](2026-10-18-browser-gateway-hardened-startup_plan_completed.md).

> **If a defect is reproduced:** read [the live-test campaign runbook](livetest-campaign-runbook.md), record it in [the remediation register](livetest-remediation-register.md), and link an active remediation plan. Never add content to a closed `_completed` plan. Keep per-check evidence here and never include capabilities, tokens, environment values or credentials.

## 1. A real restricted Codex session discovers the gateway

- [ ] In the rebuilt/restarted Harness, create a new local Codex session with hardened mode enabled and Browser Gateway enabled. Use an ordinary project directory. Do not use Computer Use to control Harness; the operator performs this app step.
- [ ] Ask that session: “Use Browser Gateway tool discovery to check browser health, preflight https://example.com on windows-pc, and list its shared tabs. Do not navigate, open tabs, sign in or change anything.”
- Expected: the gateway's search/describe/execute tools are callable, health is returned, and the Windows preflight/list request reaches the worker. No `MCP startup failed` or `connection closed: initialize response` error occurs. A worker-offline result is a separate prerequisite failure, not a pass.
- [ ] Send a second read-only request in the same session to repeat health and list its Windows tabs.
- Expected: the next Codex exec startup also discovers the tools and returns results.
- [ ] Inspect the session's forwarder log folder and redacted parent spawn log locally.
- Expected: its `logs/app.log` records the MCP server starting; granted roots include that exact instance folder without the whole Harness data folder or the parent `browser-forwarders` folder. Hardened mode remains enabled.
- Evidence: redacted tool outcome summaries, log startup timestamp and root-scope confirmation. Do not record socket paths, instance capabilities or complete generated configuration.
- Why deferred: this requires the installed application to be rebuilt/restarted. The current agent inherits a sandbox and cannot apply a nested Seatbelt profile (`sandbox_apply: Operation not permitted`). Source-level factory tests, real forwarder subprocesses and the rebuilt SEA binary have already exercised the agent-runnable portions.
