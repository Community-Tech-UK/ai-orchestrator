# Chrome DevTools ↔ Managed Profile Attach — follow-up

**Date:** 2026-06-02 (core), trimmed 2026-06-02, completed 2026-06-03
**Status:** **COMPLETE.** Core + both polish items shipped, verified, and in use.
The only remaining item (CDP reverse-proxy) is explicitly deferred — not in scope.
**Goal (delivered):** An agent authenticates **once** inside an AIO-managed Chrome
profile (persistent cookies, CDP-driven) and then drives that **same live browser**
with the richer `chrome-devtools` MCP tools, via a deterministic CDP port injected
as `--browserUrl` at spawn time.

---

## Shipped (verified in code, working in app)

The full functional pipeline is wired across all four providers and unit-tested:

- **Deterministic port + attach URL** — `chrome-devtools-attach.ts:46-59`
  (`deriveManagedDebugPort()` FNV-1a → 10000–49999, `resolveChromeDevtoolsBrowserUrl()`),
  tested in `chrome-devtools-attach.spec.ts`.
- **Per-provider MCP config builders** — `chrome-devtools-mcp-config.ts:40-124`
  (Claude JSON / Codex TOML / Gemini settings / ACP), tested
  (`chrome-devtools-mcp-config.spec.ts`, incl. the `130_000` host timeout).
- **Launcher port preference + hard-fail on collision** —
  `browser-process-launcher.ts:31-42, 235-248` (`preferredDebugPort`).
- **Settings keys** — `settings.types.ts:138-140`
  (`chromeDevtoolsAttachEnabled`, `chromeDevtoolsAttachProfileId`, default off).
- **Spawn-config assembly** — `spawn-config-builder.ts:145-150, 265-268`
  reads the settings and emits the dynamic chrome-devtools config.
- **Adapter merge** — `adapter-factory.ts:92, 284, 340, 478`
  (`chromeDevtoolsMcp` merged for Claude / Gemini / Codex / ACP, with dedupe fallback).

Real-Chrome behavior (former Phase 4) is **verified directly** (2026-06-02): a
throwaway headless Chrome launched on `deriveManagedDebugPort('verify-attach-profile')`
= port 48914, then the real `chrome-devtools-mcp@latest` server started with
`--browserUrl http://127.0.0.1:48914` (the exact URL our code builds) attached on
first tool use — `list_pages` returned `## Pages 1: about:blank [selected]`. Both a
`puppeteer.connect({ browserURL })` attach and the actual MCP server attach
succeeded, confirming the spawn-time URL matches the live CDP port and the lazy
connect works. (Verification scripts were throwaway under `_scratch/`.)

---

## Polish items — now also shipped

1. **Settings UI toggle (renderer).** ✅ Done via metadata-driven rows in the
   Advanced settings tab: a new "Browser DevTools attach" section
   (`advanced-settings-tab.component.ts`) renders the
   `chromeDevtoolsAttachEnabled` toggle + `chromeDevtoolsAttachProfileId` field
   (`settings-metadata-runtime.ts`). The toggle copy warns that when attach is on,
   AIO owns the single `chrome-devtools` server (don't also add a static one →
   `mcp__chrome-devtools__*` namespace collision). The profile id is now a
   **dynamic dropdown** (`type: 'select'`): `advanced-settings-tab.component.ts`
   loads managed profiles over IPC (`loadBrowserProfiles` → `profileOptions`,
   with running-status labels), feeds them through `dynamicOptionsFor` →
   `setting-row.component.ts`, plus a "Refresh profiles" button and empty-state
   hint. (The earlier free-text field has been replaced.)

2. **Agent-facing system-prompt hint.** ✅ Done — `CHROME_DEVTOOLS_ATTACH_PROMPT`
   in `adapter-spawn-helpers.ts` (`withBrowserGatewaySystemPrompt`) is appended
   for every provider whenever
   `chromeDevtoolsMcp` is set, instructing the agent to open/log into the managed
   profile via `browser.*` first, then use `chrome-devtools.*` on the same browser.

---

## Deferred (only if multi-profile / live-switching is needed)

- **CDP reverse-proxy** — a fixed orchestrator port forwarding to the *currently
  active* managed profile, enabling random per-launch ports + live profile
  switching without re-spawning. Removes the hard-fail-on-port-collision constraint
  and the one-attach-profile-at-a-time v1 limit. Not needed for current usage.
