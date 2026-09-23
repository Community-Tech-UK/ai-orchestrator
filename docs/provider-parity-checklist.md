# Provider Parity Checklist

Tracks feature support per CLI provider adapter. Update this file when adding a new
provider or implementing a missing feature.

**Providers:** `claude`, `gemini`, `antigravity`, `codex`, `copilot`, `cursor`, `grok`, `opencode` (+ `acp` transport, `ollama`)

> `antigravity` (Google's `agy` CLI) is the live successor to the retired `gemini`
> adapter. It runs one process per message in non-interactive print mode
> (`agy --print`), emits plain text (no `stream-json`), and reports no token usage
> (usage is estimated from response length). The `gemini` column is retained for
> persisted-settings compatibility.

> `grok` (xAI's `grok` CLI) runs over the ACP transport (`grok agent … stdio`) via
> the shared `AcpCliAdapter`. Model selection (`-m`), reasoning effort
> (`--reasoning-effort`), resume, and MCP passthrough are wired at spawn time;
> approvals default to `--always-approve` (yolo) but honor interactive prompts when
> `yoloMode` is off. It has no vision/image support. Rows marked 🔲 are declared in
> `GROK_CAPABILITIES` but not yet exercised end-to-end.

> `opencode` (the `opencode` CLI, npm `opencode-ai`) runs over ACP (`opencode acp
> --cwd <dir>`) via the shared `AcpCliAdapter`, and is how Harness reaches Xiaomi
> MiMo Token Plan models and any other OpenCode backend. It takes no model or
> effort flag: both are applied after the session opens with ACP
> `session/set_config_option` (`acp-session-config-options.ts`). Model ids are
> OpenCode's `provider/model` pairs from `opencode models --verbose`
> (`OpenCodeCliDiscoveryService`); there is no house default model. Approvals are
> pinned by a permission block injected through `OPENCODE_CONFIG_CONTENT`
> (all `allow` with YOLO on; writes, commands and network `ask` with YOLO off).
> Thinking comes from `agent_thought_chunk`, the context meter from measured
> `usage_update` occupancy, and cost from OpenCode's reported session cost
> (turns without one record $0). Credentials stay in OpenCode's own store.

> **Generic ACP additions (2026-09-22):** `agent_thought_chunk` is now surfaced
> as thinking for every ACP agent (Grok sends it; Grok's thinking column moved
> from 🔲 to ✅), and `usage_update` drives a measured context meter. A 2026-09-22
> probe showed Grok sends no `usage_update`, so Grok's context meter is
> unchanged.
> A failed ACP prompt whose error reads as a rate or usage limit (`rate limited`,
> `too many requests`, `usage limit reached`, …) is now tagged with `quota`
> diagnostics for every ACP agent (`acp-provider-limit.ts`), so the provider-limit
> park-and-resume path can catch it. The Grok/Cursor/Copilot rate-limit rows stay
> 🔲 until one of their real limit errors is captured.

Legend: ✅ Implemented · ⚠️ Partial · ❌ Not supported · 🔲 Untested

> **WS14 Claude flag pack (2026-07-17):** the Claude adapter now supports
> `--fallback-model` (per-spawn option or global `claudeFallbackModel` setting;
> omitted when equal to the primary), `--json-schema` structured output for
> one-shot review verdict spawns (wire schema derived from the parser's own Zod
> schema — `serializeReviewResultJsonSchema`), and the hygiene env pack
> (`DISABLE_UPDATES=1`, per-session `CLAUDE_CODE_TMPDIR`, and
> `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` behind the default-OFF
> `claudeSubprocessEnvScrub` setting). Stream-idle/watchdog env vars were
> verified UNSUPPORTED in CLI 2.1.211 (binary-string search) and are omitted.

---

## Core Protocol

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Auth (API key / CLI login) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model discovery | ✅ | ✅ | ⚠️ passthrough | ✅ | ✅ | ⚠️ fixed list | ⚠️ fixed list | ✅ | ⚠️ passthrough |
| Spawn process | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming text output | ✅ | ✅ | ⚠️ batch (full on close) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Idle / turn-complete detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Exit code propagation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Session Management

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Resume (`--resume`) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Interrupt (mid-turn cancel) | ✅ | ✅ | ⚠️ SIGTERM only | ✅ | ⚠️ SIGTERM only | ⚠️ SIGTERM only | ✅ | ✅ | ⚠️ |
| Multi-turn session state | ✅ | ✅ | ⚠️ stateless per message | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session ID capture | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ |
| Conversation recovery | ✅ | 🔲 | 🔲 | ✅ | ✅ | ✅ | 🔲 | 🔲 | 🔲 |

## Approvals

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Tool approval prompts | ✅ | ✅ | ❌ (yolo only) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Approval response (allow/deny) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Approval with custom message | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Durable approval store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Attachments

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Image attachments | ✅ | ⚠️ inline only | ❌ | ✅ | ❌ | ❌ | ❌ | 🔲 | ❌ |
| File attachments (`--file`) | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | 🔲 | 🔲 | ❌ |
| Attachment size limits enforced | ✅ | 🔲 | N/A | ✅ | N/A | N/A | 🔲 | 🔲 | N/A |

## Model Options

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Model selection (`--model`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ✅ | ⚠️ |
| Reasoning effort | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Context window limit config | ✅ | ✅ | ✅ | ✅ | 🔲 | 🔲 | ✅ | ✅ | ⚠️ |

## Token Usage & Observability

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Token usage in output | ✅ | ⚠️ estimated | ⚠️ estimated | ✅ | ❌ | ❌ | ✅ | ✅ | ❌ |
| Span / trace coverage | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| Metrics instrumentation | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 |

## Context Management

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Compaction trigger | ✅ | ❌ | ❌ | ✅ native | ❌ | ❌ | ❌ | ❌ | ❌ |
| Context-overflow detection | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | ❌ |
| Checkpoint / snapshot | ✅ | 🔲 | 🔲 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 |

## Streaming Events

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Streaming text deltas | ✅ | ✅ | ⚠️ batch | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool-call events | ✅ | ✅ | ⚠️ text-parsed | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reasoning / thinking events | ✅ | ❌ | ⚠️ extracted | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Plan / step events | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Error events | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Error Normalization

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Rate-limit → retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | 🔲 | ⚠️ | ❌ |
| Auth-failed → non-retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | 🔲 | ✅ | ❌ |
| Context-overflow → non-retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | 🔲 | 🔲 | ❌ |
| Binary exit code classification | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Recovery Behavior

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| Auto-restart on crash | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stale-process detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Resume after restart | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ | 🔲 |
| Failover to alternate provider | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## MCP / Tooling

| Feature | claude | gemini | antigravity | codex | copilot | cursor | grok | opencode | acp |
|---------|--------|--------|-------------|-------|---------|--------|------|----------|-----|
| MCP server passthrough | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Tool execution gate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Maintenance

- **Adding a new provider**: Copy a row to each table above and fill in coverage.
- **Linking to tests**: Adapter spec files live at `src/main/cli/adapters/<name>-cli-adapter.spec.ts`.
- **CI enforcement**: `npm run check:provider-parity` validates that all provider IDs
  found in `src/shared/types/settings.types.ts` appear in this document.

### Known gaps (tracked)

- `gemini`: no resume support — Gemini CLI has no `--resume` flag; each turn is stateless.
- `antigravity`: print-mode adapter (`agy --print`) — no native streaming (full response
  on close), no resume/session ID (stateless per message), no token usage (estimated from
  length), no permission prompts (yolo only), and no vision/attachment support.
- `copilot` / `cursor`: no attachment support — CLI APIs do not expose file input paths.
- `grok`: ACP-transport adapter (`grok agent … stdio`) with no vision/image support.
  Models come from `grok models` via `GrokCliDiscoveryService`, with
  `PROVIDER_MODEL_LIST.grok` (`grok-4.7`, then `grok-4.6`) as the offline fallback. Error
  normalization, context-overflow detection, and thinking-event surfacing over
  ACP are declared but not yet exercised end-to-end (🔲 rows).
- `opencode`: no plan-quota source. MiMo's Token Plan usage (`/api/v1/tokenPlan/usage`)
  needs a MiMo console login and refuses the API key (401), so there is no quota
  chip. OpenCode retries rate limits silently inside the turn (no ACP
  notification), so AIO only sees the limit if OpenCode gives up; the ACP stall
  watchdog covers the quiet wait (rate-limit row ⚠️, live check pending). AIO's
  `plan` mode does not drive OpenCode's `mode` config option. The MiMo Code fork
  (`mimo`) is not supported. Simultaneous `opencode acp` startups race on
  OpenCode's database (`database is locked`), and so do `opencode models` and
  `opencode auth list`, so every OpenCode process AIO launches goes through one gate
  (`opencode-process-gate.ts`). A user's own extra permission keys or per-agent
  permission blocks in their OpenCode config can still relax YOLO-off prompts.
- `acp`: error normalization not implemented — ACP error codes are provider-specific.
- All providers: metrics instrumentation is wired (`initMetrics` runs at startup) but
  `withMetrics` call sites have not yet been added to individual adapter hot paths
  (tracked as `claude_todo #7` follow-on work).
