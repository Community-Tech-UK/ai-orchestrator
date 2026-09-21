# Fresh-session token cuts

Status: completed. Live `/context` checks: [livetest](2026-09-12-fresh-session-token-cuts_livetest.md).

## As-built

- Shared copy in `src/main/mcp/orchestrator-tool-copy.ts`. Long discovery paragraph is only on `list_remote_nodes`.
- Deferred/stable orchestrator surfaces: `orchestrator-mcp-deferral.ts`, `orchestrator-mcp-stable-tools.ts`. Stdio entry is `orchestrator-tools-mcp-forwarder-runtime.ts`. Reveal emits `notifications/tools/list_changed`.
- Setting `orchestratorMcpToolDeferral` (default on, operator-only). Codex = stable, Cursor = eager, other injection providers = deferred.
- `omitNativeOwnedInstructionStack` runs in `loadPromptHierarchy` before the instruction cap. Attribution skips the same native-owned files and measures the visible orchestrator surface.

## Goal

Cut the two uncapped fresh-session taxes identified on 2026-09-12: orchestrator MCP `tools/list` (~15k tokens) and AIO re-prepending instruction files the native CLI already loads (~8.5k, doubled on Claude). Also stop repeating the same remote-node paragraph on every node tool.

## Decisions

1. **Defer orchestrator-tools the same way as Browser Gateway.** Core listed tools plus search/describe; Codex gets a stable execute wrapper; Cursor stays eager until there is invocation evidence. Default on via `orchestratorMcpToolDeferral` (operator-only, like `browserMcpToolDeferral`).
2. **Skip native-owned instruction files per provider.** Claude: `CLAUDE.md` stack plus `@`-imported paths. Codex/Cursor: `AGENTS.md`. Gemini/Antigravity: `GEMINI.md`. Copilot: `.github/copilot-instructions.md`. Unknown providers keep today's prepend. Pure function of provider + paths + file text (WS-B4 byte-stable).
3. **One copy of the remote-node discovery paragraph.** Keep it on `list_remote_nodes` only. `run_on_node` / `exec_on_node` keep short tool-specific text and a pointer to `list_remote_nodes`.

## Non-goals

- Changing Computer Use / chrome-devtools defaults.
- Splitting orchestrator into multiple MCP servers.
- Relying on Claude/Codex native tool-search as the only mitigation (it does not help Gemini/Copilot/Cursor).
- Reveal-restore across orchestrator forwarder reconnects (browser has this; deferred tools stay callable by name without it).

## Acceptance

- Deferred visible orchestrator `tools/list` is a small core + discovery tools, not the full 45-schema surface.
- Stable Codex path can search, describe, and execute a hidden tool without `tools/list_changed`.
- Eager path (setting off, or Cursor) still lists every tool.
- Claude fresh spawn does not prepend `~/.claude/CLAUDE.md`, project `CLAUDE.md`, or files that `CLAUDE.md` `@`-imports when those files are already in the resolved stack.
- Codex/Cursor fresh spawn does not prepend `AGENTS.md`.
- `run_on_node` / `exec_on_node` descriptions do not repeat the full discovery paragraph.
- Context attribution measures the visible orchestrator surface, not the hidden one.
- Canonical gates pass. Live Claude/Codex `/context` comparison is livetest-only.
