# Provider Parity Checklist

Tracks feature support per CLI provider adapter. Update this file when adding a new
provider or implementing a missing feature.

**Providers:** `claude`, `gemini`, `antigravity`, `codex`, `copilot`, `cursor` (+ `acp` transport, `ollama`)

> `antigravity` (Google's `agy` CLI) is the live successor to the retired `gemini`
> adapter. It runs one process per message in non-interactive print mode
> (`agy --print`), emits plain text (no `stream-json`), and reports no token usage
> (usage is estimated from response length). The `gemini` column is retained for
> persisted-settings compatibility.

Legend: ✅ Implemented · ⚠️ Partial · ❌ Not supported · 🔲 Untested

---

## Core Protocol

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Auth (API key / CLI login) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Model discovery | ✅ | ✅ | ⚠️ passthrough | ✅ | ✅ | ⚠️ fixed list | ⚠️ passthrough |
| Spawn process | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Streaming text output | ✅ | ✅ | ⚠️ batch (full on close) | ✅ | ✅ | ✅ | ✅ |
| Idle / turn-complete detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Exit code propagation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Session Management

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Resume (`--resume`) | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Interrupt (mid-turn cancel) | ✅ | ✅ | ⚠️ SIGTERM only | ✅ | ⚠️ SIGTERM only | ⚠️ SIGTERM only | ⚠️ |
| Multi-turn session state | ✅ | ✅ | ⚠️ stateless per message | ✅ | ✅ | ✅ | ✅ |
| Session ID capture | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ⚠️ |
| Conversation recovery | ✅ | 🔲 | 🔲 | ✅ | ✅ | ✅ | 🔲 |

## Approvals

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Tool approval prompts | ✅ | ✅ | ❌ (yolo only) | ✅ | ✅ | ✅ | ✅ |
| Approval response (allow/deny) | ✅ | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ |
| Approval with custom message | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Durable approval store | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Attachments

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Image attachments | ✅ | ⚠️ inline only | ❌ | ✅ | ❌ | ❌ | ❌ |
| File attachments (`--file`) | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| Attachment size limits enforced | ✅ | 🔲 | N/A | ✅ | N/A | N/A | N/A |

## Model Options

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Model selection (`--model`) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ⚠️ |
| Reasoning effort | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Context window limit config | ✅ | ✅ | ✅ | ✅ | 🔲 | 🔲 | ⚠️ |

## Token Usage & Observability

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Token usage in output | ✅ | ⚠️ estimated | ⚠️ estimated | ✅ | ❌ | ❌ | ❌ |
| Span / trace coverage | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ❌ |
| Metrics instrumentation | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 | 🔲 |

## Context Management

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Compaction trigger | ✅ | ❌ | ❌ | ✅ native | ❌ | ❌ | ❌ |
| Context-overflow detection | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | ❌ |
| Checkpoint / snapshot | ✅ | 🔲 | 🔲 | ✅ | 🔲 | 🔲 | 🔲 |

## Streaming Events

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Streaming text deltas | ✅ | ✅ | ⚠️ batch | ✅ | ✅ | ✅ | ✅ |
| Tool-call events | ✅ | ✅ | ⚠️ text-parsed | ✅ | ✅ | ✅ | ✅ |
| Reasoning / thinking events | ✅ | ❌ | ⚠️ extracted | ✅ | ❌ | ❌ | ❌ |
| Plan / step events | ❌ | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ |
| Error events | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Error Normalization

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Rate-limit → retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | ❌ |
| Auth-failed → non-retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | ❌ |
| Context-overflow → non-retryable | ✅ | ✅ | 🔲 | ✅ | 🔲 | 🔲 | ❌ |
| Binary exit code classification | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## Recovery Behavior

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| Auto-restart on crash | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stale-process detection | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Resume after restart | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | 🔲 |
| Failover to alternate provider | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

## MCP / Tooling

| Feature | claude | gemini | antigravity | codex | copilot | cursor | acp |
|---------|--------|--------|-------------|-------|---------|--------|-----|
| MCP server passthrough | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| Tool execution gate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

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
- `acp`: error normalization not implemented — ACP error codes are provider-specific.
- All providers: metrics instrumentation is wired (`initMetrics` runs at startup) but
  `withMetrics` call sites have not yet been added to individual adapter hot paths
  (tracked as `claude_todo #7` follow-on work).
