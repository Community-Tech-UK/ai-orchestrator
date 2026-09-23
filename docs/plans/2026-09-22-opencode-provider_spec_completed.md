# OpenCode Provider Specification

**Status:** Approved by James 2026-09-22 via review artifact `2026-09-22-opencode-provider`
(overall APPROVED). Decisions 1–7, 9 and 10 were approved as recommended; Decision 8 changed to
"investigate the MiMo console first" (recorded below). **Implemented and verified 2026-09-22**;
see As built below and the plan's per-phase notes. Live checks needing the Token Plan key are in
[2026-09-22-opencode-provider_livetest.md](./2026-09-22-opencode-provider_livetest.md).
**Date:** 2026-09-22
**Plan:** [2026-09-22-opencode-provider_plan_completed.md](./2026-09-22-opencode-provider_plan_completed.md)

## Problem

James wants AIO sessions that run on Xiaomi's MiMo models through his MiMo Token Plan (a
fixed-fee subscription, keys `tp-…` / `ttp-…`). AIO drives coding CLIs, not raw model APIs, so
it needs a CLI that can talk to MiMo and that AIO can drive the way it already drives Grok,
Cursor and Copilot.

OpenCode (`opencode`, the open-source coding CLI from `opencode.ai`, npm `opencode-ai`) fits.
MiMo's own docs list it as a supported client, and OpenCode already ships the Token Plan
endpoints as built-in providers. OpenCode is not MiMo-specific: the same provider also gives AIO
every other backend OpenCode supports (its free "Zen" models, OpenRouter, local servers, and so
on). MiMo is the first backend we build and test against.

MiMo also ships **MiMo Code** (`@mimo-ai/cli`, binary `mimo`), which is a fork of OpenCode. Its ACP
handshake reports itself as `"OpenCode"`, version `0.1.14`. This spec targets upstream OpenCode.
The fork is a possible second command later (Decision 1).

## Evidence gathered 2026-09-22

Everything below was run against OpenCode `1.18.29` (already installed at
`~/.nvm/versions/node/v24.15.0/bin/opencode`) in a throwaway `HOME`/`XDG_*` directory. James's
real OpenCode config and credentials were not touched. His `~/.local/share/opencode/auth.json`
holds 0 credentials and `~/.config/opencode/opencode.jsonc` sets only `$schema`.

1. **ACP server.** `opencode acp` speaks ACP (Agent Client Protocol) over stdio. `initialize`
   returns `protocolVersion: 1` and `loadSession: true`, with MCP over `http` and `sse` (stdio
   MCP is part of the ACP baseline). The prompt accepts `image` and `embeddedContext`. Sessions
   support `close`, `fork`, `list` and `resume`. There is one auth method, `opencode-login`
   ("Run `opencode auth login` in the terminal").
2. **Config options, not CLI flags.** `opencode acp` has no model or effort flag (flags:
   `--cwd`, `--port`, `--hostname`, `--pure`, `--print-logs`, `--log-level`, mDNS/CORS/`--no-auth`).
   `session/new` returns `configOptions`:
   - `model` (select; values are `provider/model`, e.g. `xiaomi-token-plan-ams/mimo-v2.6-pro`),
   - `effort` (select `low|medium|high`, current `low`), offered only for models that support it
     (shown for `mimo-v2.6-pro`, not for the free Zen default),
   - `mode` (select `build|plan`; `plan` disallows edit tools).
   `session/set_config_option {sessionId, configId: "model", value}` switched the model and
   returned the updated option list.
3. **Inline config.** `OPENCODE_CONFIG_CONTENT` (a JSON string in the environment) is honoured:
   `{"model": "..."}` changed the session's starting model, `opencode debug config` showed an
   injected `permission` block, and a `provider.<id>.options.apiKey` entry made that provider's
   models appear.
4. **A full turn works end to end.** With the free `opencode/mimo-v2.6-flash-free` model and no
   credentials, a prompt asking it to read a file produced `agent_thought_chunk` updates, then
   `tool_call` (`kind: "read"`, `status: pending`), then `tool_call_update` (`in_progress` with
   `rawInput.filePath`, then `completed` with the file text in `content` and `rawOutput`), then
   `agent_message_chunk` ("pineapple"), then
   `usage_update {used: 7813, size: 200000, cost: {amount: 0, currency: "USD"}}`. The prompt
   result was
   `{stopReason: "end_turn", usage: {inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens}}`.
   An earlier identical run stalled after `tool_call_update: in_progress` and produced no result
   within 150 s. It was not reproduced, so the cause is unknown (see Risks).
5. **Permissions.** OpenCode's default permission for `read` is `allow`. With
   `permission: {read|edit|bash: "ask"}` injected, the same turn sent
   `session/request_permission` with options `once` (`allow_once`), `always` (`allow_always`) and
   `reject` (`reject_once`). Answering `once` let the turn finish.
6. **MiMo Token Plan providers are built in.** models.dev (which OpenCode uses) defines
   `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp` and `xiaomi-token-plan-ams` (Europe), each an
   `@ai-sdk/openai-compatible` provider at `https://token-plan-<region>.xiaomimimo.com/v1` using
   `XIAOMI_API_KEY`. Their models are `mimo-v2.6-pro`, `mimo-v2.6-flash`, `mimo-v2.5-pro`,
   `mimo-v2.5`, `mimo-v2-pro`, plus TTS/voice models that are not chat models. AIO's
   `models-dev-snapshot.generated.ts` has no `xiaomi*` entries today.
7. **MiMo's own caveat.** MiMo's OpenCode page warns that under the *Anthropic* protocol, OpenCode
   returns HTTP 400 on multi-turn tool use (missing `reasoning_content`). The built-in providers
   above use the OpenAI-compatible protocol, which avoids this.

## What AIO has today (verified 2026-09-22)

- **ACP transport.** `AcpCliAdapter` (`src/main/cli/adapters/acp-cli-adapter.ts`, 2,405 lines) is
  shared by Grok, Cursor and Copilot. It handles `session/new`, resume via `session/load`
  (`:963-1010`, gated on `loadSession`), `session/cancel` (`:1055`), permission requests routed
  to the permission registry, the system prompt sent with the first prompt (`:2106`), and
  prompt-result `usage` (`acp-usage-estimator.ts`).
- **It never sets session config.** There is no `session/set_config_option` (or `set_model`) call
  anywhere in `src/main/cli/adapters`. Grok and Copilot choose the model with a CLI flag at spawn
  (`adapter-factory.ts:585-590`). `config_option_update` is only logged (`:1331`).
- **It drops two update types OpenCode sends.** `agent_thought_chunk` and `usage_update` fall
  through to `default: logger.debug('Ignoring ACP session update variant')` (`:1346`).
- **Provider registration is wide.** Grok is registered in roughly 40 required places (type
  unions, Zod enums, `cli-registry.ts`, adapter factory, provider class and descriptor, runtime
  registry, failover, loop/consensus/reviewer/automation unions, MCP tool schemas, remote-node RPC
  schema, context-window and model utils) and about 60 optional ones (renderer labels and icons,
  pickers, settings tabs, mobile gateway, doctor). `npm run check:provider-parity` checks that every
  `CanonicalCliType` appears in `docs/provider-parity-checklist.md`.

## Goal

A new AIO provider, **OpenCode** (`opencode`), that James can pick like Grok. With his Token Plan
connected in OpenCode, a session on `xiaomi-token-plan-ams/mimo-v2.6-pro` (or whichever region his
console gives) streams output, shows tool calls, asks for approval when YOLO is off, resumes after
restart, reports tokens, and can be used by loops, automations and reviews.

## Decisions (numbered for review; recommendation first)

1. **Which binary.** *Recommended:* upstream `opencode` only in v1. The MiMo Code fork (`mimo`) is
   a possible second command later, behind a setting, once its ACP behaviour is checked
   separately. Alternative: support both now.
2. **Who holds the MiMo key.** *Recommended:* OpenCode does. James runs `opencode auth login`,
   picks "Xiaomi Token Plan (Europe)" (or his console's region) and pastes the key. OpenCode stores
   it in `~/.local/share/opencode/auth.json`. AIO never reads, stores or passes the key. AIO's
   provider login action opens a terminal running `opencode auth login`. Alternative: AIO stores
   the key in the OS keychain and injects it with `OPENCODE_CONFIG_CONTENT`. This is more
   integrated but puts a secret in a child environment and duplicates OpenCode's own store.
3. **Model IDs.** *Recommended:* use OpenCode's `provider/model` IDs verbatim (for example
   `xiaomi-token-plan-ams/mimo-v2.6-pro`). The live list comes from the session's `model` config
   option and from `opencode models`, with non-chat models (TTS/voice) filtered out. There is no
   hard-coded default model: when James has not picked one, OpenCode's own default is used, as
   Grok does when no model is set.
4. **How model and effort are applied.** *Recommended:* a generic `AcpCliAdapter` feature. After
   `session/new` or `session/load`, the adapter sends `session/set_config_option` for each
   requested option (`model`, then `effort`) whose value the agent advertises. An unadvertised
   value is not sent; it is logged and surfaced as a warning instead of failing the spawn. AIO
   effort maps `minimal→low` and `xhigh|max→high`, matching Grok. This also gives Grok and Cursor
   a path to mid-session model changes later, but they keep their CLI flags in v1.
5. **Approvals.** *Recommended:* AIO always injects an explicit permission block with
   `OPENCODE_CONFIG_CONTENT`, so behaviour never depends on James's own OpenCode config. With YOLO
   on, every permission is `allow`. With YOLO off, `edit`, `bash`, `webfetch` and the other
   write-or-external tools are `ask`, and reads stay `allow`. `ask` becomes ACP
   `session/request_permission`, which AIO's existing approval UI already handles.
6. **Where OpenCode keeps sessions.** *Recommended:* in James's normal OpenCode data directory, as
   Grok uses `~/.grok`. OpenCode keeps credentials (`auth.json`) in the same data directory, so
   isolating sessions per AIO instance would also hide the login. The side effect is that AIO
   sessions appear in James's own `opencode` session list.
7. **Cost.** *Recommended:* use the `cost.amount` OpenCode reports in `usage_update` when present,
   and record tokens from the prompt result. No static price rows are added: OpenCode fronts many
   backends, and the Token Plan is flat-fee (OpenCode reported `$0` for the free model).
8. **Plan quota.** *Approved (changed from the draft):* investigate first. Before building the
   quota piece, find out whether MiMo's Token Plan console
   (`platform.xiaomimimo.com/#/console/plan-manage`) reads quota, usage and expiry from an
   endpoint AIO could call with the Token Plan key. If there is a stable endpoint that works with
   the key, add a quota probe modelled on `GrokBillingProbe`. If it only works with a browser
   login cookie, or isn't there at all, record that and ship without a probe. (The draft
   recommended no probe and no investigation.)
9. **Where OpenCode can be used.** *Recommended:* everywhere Grok can: new sessions, loops,
   automations, reviewer/consensus selection, `run_on_node`, and the mobile gateway's provider
   list. It is not excluded from automation by default.
10. **Thinking and context meter.** *Recommended:* in scope, as generic ACP improvements that also
    help Grok. `agent_thought_chunk` becomes thinking content on the assistant message, and
    `usage_update.used/size` drives the context meter.

## Requirements

- R1. `opencode` is a `CanonicalCliType`/`ProviderType` everywhere Grok is, and is detected on
  PATH with `opencode --version`.
- R2. Spawn: `opencode acp --cwd <workingDirectory>` through `AcpCliAdapter`, with an
  `OPENCODE_CONFIG_CONTENT` that carries only the permission block (Decision 5). The environment
  goes through the normal `mergeSpawnEnv`; RTK and the concurrency limiter are set up as for Grok.
- R3. The requested model and effort are applied through `session/set_config_option` (Decision 4)
  on both new and resumed sessions.
- R4. MCP passthrough: AIO's orchestrator, browser-gateway, chrome-devtools, mobile and inline MCP
  servers reach OpenCode through the `mcpServers` of `session/new`/`session/load`, as for Grok.
- R5. Approvals follow Decision 5, and both answers work end to end (allow, and reject that ends
  the tool call cleanly).
- R6. Resume after restart uses `session/load` with the captured OpenCode session ID.
- R7. Tokens (input, output, cached read, thought) are recorded from the prompt result, the
  context meter from `usage_update`, and cost per Decision 7.
- R8. Model discovery lists OpenCode's chat models for the picker and refreshes like
  `GrokCliDiscoveryService`. An unreachable CLI degrades to "use OpenCode's default".
- R9. Auth status: "authenticated" when `opencode auth list` reports at least one credential, or
  when the configured default model is a free Zen model. The provider login action runs
  `opencode auth login` in a terminal.
- R10. Error normalisation: OpenCode's auth-failure and rate-limit errors become AIO's
  non-retryable and retryable classes. Their exact shapes are captured first (plan Phase 0).
- R11. `docs/provider-parity-checklist.md` gains an `opencode` column, and
  `check:provider-parity` passes.
- R12. No secret ever appears in the repo, tests, fixtures or logs. Test fixtures use obvious
  placeholders.

## Out of scope (v1)

- The MiMo Code fork (`mimo`) as a command.
- AIO-managed MiMo keys and per-account OpenCode profiles (account pools).
- A Token Plan quota probe, unless the Decision 8 investigation finds an endpoint that works with
  the Token Plan key.
- Driving OpenCode's `plan` mode from AIO's plan mode (`mode` config option). A follow-up.
- Changing Grok, Cursor or Copilot to set their model through config options.

## Risks

- **Unexplained stall.** One of four probe turns stalled after `tool_call_update: in_progress`.
  AIO's ACP stall watchdog covers this at run time, but the plan must try to reproduce it before
  sign-off.
- **Shared data directory.** Several `opencode acp` processes may write the same OpenCode database
  at once. It needs a concurrency check (plan Phase 0).
- **Local HTTP port.** Each `opencode acp` opens a loopback HTTP server on a random port
  (`--port 0`, `127.0.0.1`), with no auth needed on loopback. That is OpenCode's normal
  behaviour. It is recorded here, not changed.
- **Young upstream.** OpenCode releases often (npm `opencode-ai` is at `1.18.32`; `1.18.29` is
  installed). The ACP details above (option IDs `model`/`effort`, permission option IDs) are
  observations, not a published contract, so the adapter must treat them defensively.

## As built (2026-09-22)

- R1–R12 are implemented as specified, with these recorded differences and findings:
  - **Decision 5 (approvals):** the injected block layers over the user's config (probe 0.1).
    It sets `"*"` and every known permission key; a user's own extra keys or per-agent
    permission blocks can still relax YOLO-off prompts (known gap).
  - **Decision 6 (shared data directory):** holds, but simultaneous `opencode` startups race on
    OpenCode's database (`PRAGMA journal_mode = WAL` before `busy_timeout`). AIO routes every
    OpenCode process it launches that opens the database (ACP sessions, `opencode models`,
    `opencode auth list`, `opencode debug config`) through one gate
    (`opencode-process-gate.ts`).
  - **Decision 7 (cost):** `usage_update.cost.amount` is the session's running total, so each
    turn records the change in it; a turn with no reported cost records $0 rather than a static
    default rate.
  - **Decision 8 (quota):** investigated; MiMo's `/api/v1/tokenPlan/usage` and `/detail` need the
    console login cookie and return 401 for the Token Plan key, so no quota probe was built.
  - **Decision 10 (thinking and meter):** `agent_thought_chunk` becomes thinking for every ACP
    agent (Grok included); `usage_update` drives a measured context meter.
  - **Decision 3 (model ids):** create-time and runtime model validation accept any OpenCode
    `provider/model` id, because OpenCode's catalog rows can lag the CLI; the adapter validates
    against the session's own options and warns instead.
- The stall risk did not reproduce (0/10). The dev-app check on the free Zen model passed for
  streaming, tool rows, thinking, context meter, YOLO-off allow and reject, interrupt, restart
  and resume, and a second concurrent session.
