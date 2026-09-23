# OpenCode Provider Implementation Plan

**Status:** Completed 2026-09-22. Approved by James 2026-09-22 via review artifact
`2026-09-22-opencode-provider` (overall APPROVED; spec Decision 8 changed to "investigate the
console first", which adds Task 0.7 and Task 3.7). Phases 0–6 implemented and verified; Task 3.7
skipped (Task 0.7: the quota endpoint is console-cookie only); checks needing James's Token Plan
key or `windows-pc` are deferred to
[2026-09-22-opencode-provider_livetest.md](./2026-09-22-opencode-provider_livetest.md).
Two independent completion gates returned `VERDICT: PASS`; the first gate's one finding
(provider-limit text coverage) and the second's doc gap were fixed.
**Date:** 2026-09-22
**Spec:** [2026-09-22-opencode-provider_spec_completed.md](./2026-09-22-opencode-provider_spec_completed.md)

**Goal:** Add `opencode` as an AIO provider that runs `opencode acp` through the shared
`AcpCliAdapter`, so James can run sessions on MiMo Token Plan models (and any other OpenCode
backend) the same way he runs Grok.

**Architecture:** A thin OpenCode layer (provider class, adapter factory, discovery service, CLI
registry entry) on top of two generic `AcpCliAdapter` additions: applying session config options
(model and effort) after the session opens, and handling `agent_thought_chunk` and
`usage_update`. Grok is the template for every registration point. The spec's numbered decisions
are assumed as recommended. If James changes one at review, update the affected tasks before
starting.

## Global Constraints

- Work in James's current checkout. Do not create a branch or worktree.
- Do not stage or commit this plan, the spec, or any implementation unless James asks.
- The tree has uncommitted work from other sessions. Several of those files are ones this plan
  touches (`provider-login-launcher.ts`, `provider-doctor.ts`, `provider-doctor-repair.ts`,
  `unified-model-catalog-service.ts`, `docs/provider-parity-checklist.md`). Before editing any file,
  run `git diff -- <file>`, keep those changes intact, and never `git stash`, `git checkout --` or
  `git reset` in this repo.
- Read every affected file, its callers and its tests in full before editing it.
- File-size gate (`npm run check:ts-max-loc`, slack 50):
  - `src/main/cli/adapters/adapter-factory.ts` is at 824 of 825. Move `createGrokAdapter` out
    first (Task 1.1) and put `createOpenCodeAdapter` in its own file.
  - `src/main/cli/adapters/acp-cli-adapter.ts` is at 2,405 of 2,429. New ACP logic goes in new
    modules, and only call sites are added to the adapter.
  - `src/shared/types/provider.types.ts` (654) is not on the allowlist, so it has a hard limit of
    700.
  - New files stay under 700 lines.
- No new package dependencies. OpenCode is an external CLI found on PATH, like `grok`.
- Probes and tests never use James's real OpenCode home. Use a temporary `HOME` plus
  `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME`, as in the spec's
  evidence runs.
- No keys in the repo, fixtures or logs. Fixtures use obvious placeholders such as
  `placeholder-not-a-key`.
- Check `uptime` before running the full suite.

---

## Phase 0: Probes before building

These probes use the free `opencode/mimo-v2.6-flash-free` model and a throwaway home, so they need
no credentials. Record each result (command and observed output) in this plan under the task.

### Task 0.1: Config layering

- [x] With a temp-home `opencode.json` that sets `"permission": {"bash": "deny"}` and a `provider`
      block, start `opencode acp` with `OPENCODE_CONFIG_CONTENT` setting
      `permission.bash = "allow"`. Confirm with `opencode debug config`, run under the same
      environment, that the injected block wins over the file for the keys it sets, and that the
      file's other keys (the provider block) survive. This decides whether R2's permission
      injection is safe to layer over James's own config.

      **Result (2026-09-22, OpenCode 1.18.29): layers, does not replace. Stop gate 1 not hit.**
      Global file `{"permission":{"bash":"deny","edit":"deny"},"provider":{"xiaomi-token-plan-ams":{"options":{"timeout":123456}}},"model":"opencode/mimo-v2.6-flash-free"}`
      plus `OPENCODE_CONFIG_CONTENT='{"permission":{"bash":"allow","read":"ask"}}'` gave
      `permission {bash: allow, edit: deny, read: ask}`, with the provider block and model intact.
      A project `opencode.json` in the cwd (`bash: deny, webfetch: deny`) also lost `bash` to the
      injection and kept `webfetch: deny`. Source (`config/config.ts:468`) merges the inline
      config after global and project files; only managed/MDM config and per-agent
      `agent.<name>.permission` blocks are applied later.
      Consequences for Task 3.1: (a) keys AIO does not set survive from the user's file, so AIO
      must set every known key plus `"*"`; (b) evaluation is last-match-wins over keys in their
      merged order (`permission/index.ts:28`, `findLast`), and a merge keeps the user's key
      order, so a `"*"` the user placed after a specific key overrides it. Setting `"*"` to the
      same action as the non-read keys (`ask` with YOLO off, `allow` with YOLO on) means any
      reorder can only turn a read into `ask`, never a write into `allow`. Known keys from
      `ConfigPermissionV1`: `read edit glob grep list bash task external_directory todowrite
      question webfetch websearch lsp doom_loop skill`. Residual: a user's own extra keys (for
      example an MCP tool pattern set to `allow`) or per-agent permission blocks can still
      relax YOLO-off prompts; this is recorded as a known gap, not a stop condition.

### Task 0.2: Concurrency on the shared data directory

- [x] Start two `opencode acp` processes on the same temp data directory and run one prompt in
      each at the same time. Both must finish with `end_turn`, with no `SQLITE_BUSY` or lock
      errors in `--print-logs`.

      **Result (2026-09-22): running sessions share the database safely; simultaneous process
      startup does not.** Probes: `_scratch/opencode-probe/p02-concurrency.mjs`,
      `p02b-stagger.mjs`, `p02c-window.mjs`.
      - Staggered: A started and began a long turn; B started 3 s later and C after B's
        `initialize`. All three ran turns at the same time and all ended `end_turn`, with no lock
        errors.
      - Simultaneous start (two spawns in the same tick): the second process died at startup in
        3 of 3 fresh-or-warm paired runs in `p02`, and in 1 of 3 same-tick pairs in `p02c`.
        It exits with code 1 and stderr `Error: Unexpected error / database is locked` (on a
        brand-new database the loser instead fails a `CREATE TABLE workspace` migration). No
        failures with a 50, 150, 400 or 800 ms offset.
      - Root cause (OpenCode, not AIO): `packages/core/src/database/sqlite.bun.ts:164` runs
        `PRAGMA journal_mode = WAL` on open, before `database.ts:29` sets
        `PRAGMA busy_timeout = 5000`, so a racing opener gets an immediate `SQLITE_BUSY` and the
        startup effect dies (`Effect.orDie`). Migrations also race on a fresh database.
      - Stop gate 2 judgement: not hit. Concurrent sessions neither corrupt nor lock the
        database once started, so Decision 6 (shared data directory) stands. The startup race
        is handled in AIO instead (Task 3.1): OpenCode process startups are serialised through
        a module-level startup gate held until `initialize` answers or the process exits. An
        in-adapter retry was considered and rejected: a failed start emits the child's `exit`
        event to listeners already attached to the instance, so a hidden retry could leave the
        instance marked exited while the retry succeeded.
      - Follow-up probe (2026-09-22, after build, `p08-models-race.mjs`): `opencode models
        --verbose` and `opencode auth list` also open the database and collide with a
        same-instant `opencode acp` start (each side died once in 6 paired starts per command);
        `opencode --version` never did (0 of 12). So the gate covers every OpenCode process AIO
        launches that opens the database: ACP sessions (held until `initialize`), model
        discovery and the sign-in status commands (held for their whole run). It lives in
        `opencode-process-gate.ts`. OpenCode processes James starts himself cannot be gated;
        that residual race is OpenCode's bug.

### Task 0.3: Resume, cancel and replay

- [x] Run one turn, kill the process, start a new `opencode acp` and call `session/load` with the
      saved `sessionId`. Record which `session/update` messages replay history (user and agent
      chunks, tool calls) and whether `session/load` returns `configOptions`. Then send
      `session/cancel` during a long turn and record the `stopReason`, which should be
      `cancelled`.

      **Result (2026-09-22, `_scratch/opencode-probe/p03-resume.mjs`): works.**
      - `session/new` returns `{sessionId, configOptions}`; for the free Zen model the options are
        `model` and `mode` only (no `effort`).
      - After `SIGKILL` and a fresh process, `session/load {sessionId, cwd, mcpServers}` succeeds
        and **returns `configOptions`** (same shape as `session/new`), so Task 2.1 validates
        writes on the load path too.
      - `session/load` replays the whole history as `session/update`s before it answers:
        1 `user_message_chunk`, 3 `agent_thought_chunk`, 3 `tool_call` + 3 `tool_call_update`,
        1 `agent_message_chunk`, then `available_commands_update`. Chunks carry `messageId`.
        The adapter's existing replay suppression must cover the new thought-chunk case.
      - A follow-up prompt on the loaded session remembered the earlier answer (`end_turn`).
      - `session/cancel` mid-turn: the prompt resolved 23 ms later with
        `{stopReason: "cancelled", usage: {inputTokens: 0, outputTokens: 0, totalTokens: 0}}`.
      - `session/list {cwd}` returns `{sessions: [{sessionId, cwd, title, updatedAt}]}`.
      - Prompt-result usage shape: `{inputTokens, outputTokens, totalTokens, thoughtTokens,
        cachedReadTokens}` (`totalTokens` includes cached reads).

### Task 0.4: MCP passthrough

- [x] Pass a stdio MCP server (a tiny echo server under `_scratch/`) in `session/new.mcpServers`
      and confirm that the model can call it and that the call shows up as a `tool_call`.

### Task 0.5: Error shapes

- [x] **Auth failure:** configure `xiaomi-token-plan-ams` with apiKey `placeholder-not-a-key`,
      select `mimo-v2.6-pro` and prompt. Record the exact JSON-RPC error or update, and any
      `stopReason`.
- [x] **Unknown model:** send `set_config_option` for `model` with a value that is not offered.
      Record the error.
- [x] **Rate limit:** cannot be forced without a key. Record it as a live check (Phase 6) and
      search the OpenCode source for its rate-limit error text so the classifier has a candidate
      pattern.

      **Results (2026-09-22, `_scratch/opencode-probe/p05-errors.mjs`):**
      - Auth failure (`xiaomi-token-plan-ams` with apiKey `placeholder-not-a-key`, model
        `mimo-v2.5-pro`): the `session/prompt` request fails with JSON-RPC
        `{code: -32603, message: "Internal error: Invalid API Key", data: {service: "session",
        errorName: "APIError"}}`. Only a `usage_update` arrives before it; no assistant text, no
        `stopReason`. `--print-logs` shows `error.error="AI_APICallError: Invalid API Key"`.
        With no credential at all, OpenCode's ACP layer uses `RequestError.authRequired`
        ("provider authentication required", `acp/error.ts`).
      - Unknown model: `{code: -32602, message: "Invalid params: model not found:
        nope/not-a-model", data: {providerId, modelId}}`. Unoffered effort: `{code: -32602,
        message: "Invalid params: effort not found: high", data: {effort}}`. The session stays
        usable after both.
      - Effort option: after switching to `xiaomi-token-plan-ams/mimo-v2.5-pro` the returned
        options are `model`, `effort` (`category: "thought_level"`, values `low|medium|high`,
        current `low`) and `mode`; `set_config_option effort=high` succeeded.
      - Model list freshness: a brand-new home's first `session/new` offered only six
        `xiaomi-token-plan-ams/*` models (no `mimo-v2.6-*`) until OpenCode refreshed its
        models.dev cache; later calls listed `mimo-v2.6-pro`/`mimo-v2.6-flash`. Model IDs are
        therefore never hard-coded (spec Decision 3).
      - Rate limit (not forced; source reading, `session/retry.ts`): OpenCode retries retryable
        API errors inside the session with exponential backoff (30 s cap without retry headers)
        and **sends no ACP notification while retrying**, so AIO sees a quiet, long-running turn;
        the ACP stall watchdog is the backstop. Its retry text, if it ever reaches the client as
        an error, matches `rate limit`, `too many requests`, `rate increased too quickly`,
        `Rate Limited`, `Provider is overloaded`, `usage limit reached`, `FreeUsageLimitError`
        and `GoUsageLimitError`. The real behaviour stays a live check (Task 6.3 item 5).

### Task 0.6: The stall

- [x] Re-run the spec's read-a-file prompt 10 times on a fresh home. If any run stalls after
      `tool_call_update: in_progress`, capture `--print-logs --log-level DEBUG` and find the
      cause before Phase 3. Otherwise record "0/10" and rely on the ACP stall watchdog.

      **Result (2026-09-22, `_scratch/opencode-probe/p06-stall.mjs`): 0/10.** Ten sequential
      fresh processes on one fresh home, each a new session on `opencode/mimo-v2.6-flash-free`
      with `--print-logs --log-level DEBUG`; every run ended `end_turn` in 5.8–12.2 s with the
      tool call reaching `completed`. Stop gate 4 not hit; the ACP stall watchdog remains the
      runtime backstop (it also covers OpenCode's silent in-session rate-limit retries, 0.5).

### Task 0.7: Token Plan quota endpoint (spec Decision 8)

- [x] Using the Browser Gateway on `windows-pc` (James's default browser computer), open James's
      logged-in MiMo console at `platform.xiaomimimo.com/#/console/plan-manage` and record the
      network requests that load the plan's quota, usage and expiry: URL, method and response
      shape. Record which credential each one uses, a browser cookie or a bearer key, but never
      the value itself. If a login is needed, use the approval/escalation flow; never type
      credentials.
- [x] If an endpoint looks usable, test it once from the command line with James's Token Plan
      key, read from Bitwarden or from OpenCode's `auth.json` through an environment variable and
      never printed. Record the status code and the response's field names only.
- [x] Outcome: either "usable with the key" (Task 3.7 goes ahead) or "cookie-only or none" (Task
      3.7 is skipped, and the parity checklist records no quota source).

      **Result (2026-09-22): cookie-only. Task 3.7 is skipped (stop gate 3: record and carry on).**
      - Browser route: `windows-pc` was not connected to the coordinator (`list_remote_nodes`:
        all three workers `disconnected`; Browser Gateway health: `node_disconnect` for
        `windows-pc`, no remote extensions), so `browser.recover_extension` had nothing to
        recover. The documented fallback, local Mac Chrome, also failed: health reported the
        local channel polling, but `find_or_open` and a refreshed `list_targets` returned
        `browser_extension_command_timeout` three times. The network requests were therefore
        read from the console's public bundle instead of a live tab.
      - Console source (`https://platform.xiaomimimo.com/static/main.<hash>.chunk.js`, no login
        needed): the plan page's store loads `GET /api/v1/tokenPlan/detail` and
        `GET /api/v1/tokenPlan/usage` together. The request helper sends
        `credentials: "same-origin"` (the console login cookie) plus a `userId` parameter and no
        `Authorization` header.
      - One command-line test with the Token Plan key (from Bitwarden, env var only, value never
        printed): both endpoints return **401** `{code, loginUrl}` with and without
        `Authorization: Bearer <key>`. On the key's API host
        (`token-plan-ams.xiaomimimo.com`), `GET /v1/models` returns 200
        `{object, data: [{id, object, owned_by}]}` (the key is valid), and `/v1/usage`,
        `/v1/dashboard/billing/usage`, `/v1/dashboard/billing/subscription` and
        `/v1/tokenPlan/usage` return 404.
      - Conclusion: there is no quota endpoint AIO can call with the Token Plan key. The parity
        checklist records "no quota source" for OpenCode. The live-tab confirmation of the
        network requests is not needed for this decision, since the key is refused either way.

---

## Phase 1: Registration (type-level; no behaviour yet)

### Task 1.1: Make room in adapter-factory

- [x] Move `createGrokAdapter` (`adapter-factory.ts:567-635`) unchanged into
      `src/main/cli/adapters/grok-adapter-factory.ts`, re-export it from `adapter-factory.ts` so
      imports keep working, and lower the `adapter-factory.ts` ceiling in
      `scripts/check-ts-max-loc.ts` to its new size. Existing `adapter-factory-grok.spec.ts` must
      still pass without changes.

### Task 1.2: Provider ID in the shared unions and schemas

Add `'opencode'` next to `'grok'` in each place below. The line numbers are from a 2026-09-22
inventory, so re-grep `'grok'` to confirm each one.

- [x] Types: `src/shared/types/provider.types.ts` (`ProviderType`),
      `settings-primitives.types.ts` (`CanonicalCliType`), `provider-quota.types.ts`
      (`ProviderId`), `automation-provider.types.ts` (IDs and definitions, label "OpenCode"),
      `loop.types.ts` (`LoopProvider`), `reviewer-provider.types.ts`, and
      `src/main/orchestration/consensus.types.ts`.
- [x] CLI registry: `src/main/cli/cli-registry.ts` `CliType`, `SUPPORTED_CLIS`, and a
      `CLI_REGISTRY.opencode` entry. It has `command: 'opencode'`, `displayName: 'OpenCode'`,
      `versionFlag: '--version'`, and the capabilities `streaming`, `tool-use`, `file-access`,
      `shell`, `multi-turn` and `mcp-servers`. Alternative paths are
      `~/.opencode/bin/opencode` (the official install script's location, to be confirmed by
      reading the script without running it), `/opt/homebrew/bin/opencode`,
      `/usr/local/bin/opencode`, `~/.local/bin/opencode` and the Windows npm shim locations.
- [x] Zod enums and schemas: `packages/contracts/src/schemas/*` wherever `grok` appears
      (instance, loop, automation, orchestration, quota, remote-node, provider-runtime-events),
      `src/main/core/config/settings-control-policy.ts` (CLI enum and
      `providersExcludedFromAutomation`; the file is at its 840 ceiling plus 50 slack, so check
      the size after editing), `src/main/remote-node/rpc-schemas.ts`,
      `src/main/mcp/orchestrator-tools.ts`, `orchestrator-automation-tools.ts` and
      `orchestrator-tools-mcp-forwarder.ts`.
- [x] Preload and renderer IPC unions: `src/preload/domains/*.preload.ts`,
      `instance-ipc.service.ts`, `loop-ipc.service.ts`, `provider-state.service.ts`, and
      `core/state/instance/instance.types.ts`.
- [x] Runtime switches: `adapter-factory.ts` (`mapSettingsToDetectionType`, the
      `resolveCliType` priority list and the create switch), `provider-runtime-registry.ts`,
      `failover-manager.ts`, `instance/provider-runtime-helpers.ts`,
      `history/ingest-missing-last-stop-history.ts`, `app/run-on-node-support.ts`,
      `worker-agent/provider-runtime-diagnostics.ts` and `worker-agent/capability-reporter.ts`.
- [x] Model utils: `provider-context-window.ts` (take the window from `usage_update.size` when
      known; otherwise use a conservative default), `provider-model-utils.ts` (normalisation keeps
      `provider/model` IDs verbatim; model-to-provider inference must not claim bare `mimo-*` IDs
      for OpenCode), and `getDefaultReasoningEffort('opencode')`, which returns `undefined` so
      OpenCode's own per-model default applies.
- [x] `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` pass. Every exhaustive
      switch that now fails is either handled or intentionally routed to its default branch, with
      a comment.

**As built (Phase 1):** `createGrokAdapter` moved unchanged to `grok-adapter-factory.ts` and
re-exported; the `adapter-factory.ts` ceiling went 775 → 748 (file now 757 with the OpenCode
switch cases). `opencode` was added to every union, Zod enum and MCP tool schema that lists
`grok` (array `.max(7)` limits became `.max(8)`), the CLI registry (alternative paths include
`~/.opencode/bin/opencode`, confirmed by reading opencode.ai/install), the runtime switches,
the renderer IPC unions and the phone app's provider list. Deliberate differences:
`DEFAULT_MODELS` and `DEFAULT_REVIEWER_MODEL_BY_PROVIDER` are typed to allow OpenCode to have no
entry (spec Decision 3); `getDefaultReasoningEffort('opencode')` already returned `null`, which
means "provider decides"; `provider-context-window.ts` needed no change because OpenCode falls
through to the conservative 200k default and the measured `usage_update.size` replaces it at
runtime; `normalizeModelForProvider('opencode', id)` keeps ids containing `/` and drops anything
else (a stale `sonnet` becomes "OpenCode default"). OpenCode is not added to the provider-quota
`PROVIDERS` probe list (no quota source, Task 0.7) but has a `null` snapshot slot.

---

## Phase 2: Generic ACP additions

### Task 2.1: Session config options (spec Decision 4)

- [x] New module `src/main/cli/adapters/acp-session-config-options.ts`:
  - `parseAcpConfigOptions(raw: unknown)` turns an untrusted `configOptions` array into typed
    `{id, category, currentValue, values[]}` entries, dropping malformed ones.
  - `planConfigOptionWrites(advertised, requested: {model?, effort?})` returns an ordered list:
    `model` first, because the `effort` option only exists for some models. Each entry is either
    `{configId, value}` to send or `{skipped, reason}` when the option or value is not advertised.
  - `mapAcpEffort(reasoningEffort)` maps `minimal→low`, `xhigh|max→high`, `none|workflow→`
    omitted, and passes `low|medium|high` through.
- [x] `AcpCliAdapterConfig` gains an optional `sessionConfig?: {model?: string; effort?: string}`.
      After `openSession()` returns (both the new and load paths, `acp-cli-adapter.ts:963`), the
      adapter:
      1. sends each planned write with `session/set_config_option`,
      2. re-parses the returned `configOptions` before writing `effort`, since changing the model
         changes that list,
      3. turns skips and errors into a single `system` warning output line plus a `logger.warn`,
         and never fails the spawn.
      Keep the addition to the adapter under 24 lines by putting the loop in the new module as
      `applyAcpSessionConfig(send, initialOptions, requested)`.
- [x] Capture `configOptions` from the `session/new` response. For `session/load`, which returns
      `null` in the current typing, re-read the options when Phase 0.3 shows it returns them;
      otherwise send the writes without pre-validation and accept the agent's error as the
      signal.
- [x] Unit tests in `acp-session-config-options.spec.ts` (pure functions) and one adapter-level
      test in a new `acp-cli-adapter.config-options.spec.ts`, using the existing
      `acp-cli-adapter.test-helpers.ts` fake process. Cover: model then effort in order; effort
      skipped when not offered after the model switch; unadvertised model produces a warning and
      the session continues; `set_config_option` rejected produces a warning and the session
      continues; the load path.

### Task 2.2: Thinking chunks

- [x] Find how Claude and Codex thinking reaches the renderer (`ThinkingContent` on messages,
      `src/shared/types/instance.types.ts:227-262`, and the `thinking-extractor` utilities).
      Route ACP `agent_thought_chunk` the same way, attached to the current assistant turn, in a
      helper module outside `acp-cli-adapter.ts`, and add a `case` in the update switch
      (`:1294`).
- [x] Test that thought chunks never appear as assistant text (the risk is thinking leaking
      into the answer), and that they are attached to the turn's message.

### Task 2.3: Usage updates

- [x] Handle `usage_update {used, size, cost?}`: emit the adapter's existing `context` event
      (`acp-cli-adapter.ts:2212`, `acp-usage-estimator.ts`) with measured `used`/`size`, and keep
      `cost.amount`/`currency` on the turn for Task 3.4. Don't overwrite measured prompt-result
      usage with estimates.
- [x] Tests: the context event carries measured values; a missing `cost` is fine; a turn with a
      prompt-result `usage` and a `usage_update` reports tokens once, not twice.
- [x] Check Grok's captured fixtures (`provider_event_captures`, and `acp-cli-adapter.spec.ts`
      fixtures) for whether Grok sends `usage_update`. If it does, this changes Grok's context
      meter, which is intended. Record it in the parity checklist.

**As built (Phase 2):**
- `acp-session-config-options.ts` (`parseAcpConfigOptions`, `planConfigOptionWrite(s)`,
  `mapAcpEffort`, `applyAcpSessionConfig`). Options are matched by ACP category first
  (`model`, `thought_level`) and id second, so Grok's `reasoning_effort` id would also match.
  An already-selected value is skipped silently. `session/load`'s `configOptions` are captured
  (Task 0.3 shows OpenCode returns them); a `null` load result sends writes unvalidated.
  Warnings become one `system` line ending "The agent's own default is used instead."
- `acp-thought-stream.ts`: thought text is collected per turn (keyed by `messageId`) and
  attached as `thinking` blocks (`format: 'sdk'`, stable `<responseId>-thought-<n>` ids) to the
  turn's final non-streaming assistant flush; a thinking-only turn still flushes an empty
  assistant message carrying the thinking. Thought chunks outside a live or recent turn
  (history replay on `session/load`) are dropped.
- `acp-usage-update.ts`: `usage_update.used/size` emits a measured `context` event and flips
  `getContextCapabilities().occupancyReporting` to `current`; the prompt-result aggregate event
  is then suppressed so the meter is not overwritten by a summed figure. OpenCode's
  `cost.amount` is the session's running total (`acp/usage.ts` `totalSessionCost`), so
  `AcpSessionCostLedger` records each turn's cost as the change in that total; a loaded
  session's first turn records no cost until a baseline is known.
- Prompt-result `thoughtTokens`/`cachedReadTokens`/`cachedWriteTokens` now map onto
  `reasoningTokens`/`cacheReadTokens`/`cacheWriteTokens` for every ACP agent.
- To fit the adapter's size ceiling, the pure elicitation-response helpers moved to
  `acp-elicitation-response.ts`; `acp-cli-adapter.ts` went from 2,405 to 2,398 lines overall.
  The two new ACP update types live in `src/shared/types/acp-session-update.types.ts` so
  `cli.types.ts` stays at its 700-line limit.
- Grok check (2026-09-22, one real `grok agent stdio` turn): Grok sends 30
  `agent_thought_chunk` updates per turn and no `usage_update`, so Grok now shows thinking and
  its context meter is unchanged. Recorded in the parity checklist.

---

## Phase 3: The OpenCode provider

### Task 3.1: Adapter factory

- [x] New `src/main/cli/adapters/opencode-adapter-factory.ts` with
      `createOpenCodeAdapter(options: UnifiedSpawnOptions): AcpCliAdapter`, modelled line by line
      on `createGrokAdapter`:
  - `command: 'opencode'`, `args: ['acp', '--cwd', workingDirectory]`,
    `adapterName: 'opencode-acp'`.
  - MCP server assembly is the same as Grok's (browser gateway with provider `'opencode'`,
    chrome-devtools, mobile, inline).
  - `env = mergeSpawnEnv(options)` plus
    `OPENCODE_CONFIG_CONTENT = JSON.stringify({permission: buildOpenCodePermissionBlock(yoloMode)})`.
    With YOLO on, every permission is `"allow"`. With YOLO off: `read`/`list`/`glob`/`grep` are
    `"allow"`, and `edit`/`bash`/`webfetch`/`task` and others are `"ask"`. Build the permission key
    list from OpenCode's documented permission keys, confirmed against `opencode debug config` in
    Phase 0.1. If an `OPENCODE_CONFIG_CONTENT` is already in the environment, merge into it rather
    than replacing it.
  - `sessionConfig: {model: requested model when explicit and not 'auto', effort: mapAcpEffort(...)}`.
  - `extendEnvWithRtk`, `permissionRegistry`,
    `permissionContext: buildAcpPermissionContext(options, 'opencode')`,
    `concurrencyKey: 'opencode'`, `concurrencyAcquireTimeoutMs: 60_000`, and stall-warning and
    overflow priority handling as for Grok.
- [x] Wire it into the `adapter-factory.ts` create switch.
- [x] `adapter-factory-opencode.spec.ts`, mirroring `adapter-factory-grok.spec.ts`: args,
      permission block for each YOLO state, merging with an existing `OPENCODE_CONFIG_CONTENT`,
      MCP servers, `sessionConfig` mapping, and no model when the model is `auto` or absent.

### Task 3.2: Provider class and registration

- [x] New `src/main/providers/opencode-cli-provider.ts` modelled on `grok-cli-provider.ts`
      (204 lines): `DEFAULT_OPENCODE_CONFIG`, `OPENCODE_DESCRIPTOR`, and
      `checkStatus`/`initialize`/`sendMessage`/`updateUsageFromContext`. Its capabilities are
      interruption, permissions, resume, streaming, usage reporting, images, and no subagents.
- [x] Register it in `register-built-in-providers.ts` and `provider-instance-manager.ts`
      (defaults and the provider-to-CLI map).
- [x] Update `register-built-in-providers.spec.ts` and
      `__tests__/parity/provider-parity.spec.ts`.

### Task 3.3: Model discovery

- [x] New `src/main/providers/opencode-cli-discovery-service.ts` modelled on
      `grok-cli-discovery-service.ts`. It runs `opencode models --verbose` under the spawn
      environment, parses the `provider/model` lines, and drops non-chat models using the
      verbose metadata (modalities). If the metadata turns out not to include modalities, use a
      name filter for `tts|voiceclone|voicedesign|embedding` and note this in the service.
      Refresh on the same schedule as Grok, and fail soft.
- [x] Feed the results into the unified model catalog the way Grok's are fed
      (`unified-model-catalog-service.ts` and `unified-model-catalog-normalizers.ts`; the first has
      uncommitted changes from another session, so preserve them). `PROVIDER_MODEL_LIST.opencode`
      stays empty and `DEFAULT_MODELS.opencode` stays undefined (spec Decision 3). Confirm the
      picker handles an empty static list and shows "OpenCode default".
- [x] Tests covering parsing, the filter, and a failing CLI.

### Task 3.4: Usage and cost

- [x] `updateUsageFromContext` records input, output, cached-read and thought tokens from the
      prompt result, and cost from the turn's `usage_update.cost.amount` when present (Task 2.3).
      Add `opencode` to whichever pricing path lets a reported cost win over the static table
      (`src/shared/data/model-pricing.ts`), and never price `provider/model` IDs from Claude or
      Grok rows.
- [x] Test: reported cost wins; missing cost records tokens with cost 0 and does not crash.

### Task 3.5: Auth status and login

- [x] `checkStatus` runs `opencode --version`, then `opencode auth list` under the spawn
      environment. Count credentials from the output **without reading or logging values**, and
      treat an empty list as "not authenticated" unless the configured default model starts with
      `opencode/` (free Zen). Its output format was seen once (`Credentials <path>` then
      `N credentials`); parse defensively and put a fixture in the test.
- [x] Provider login: add `opencode` to `provider-login-launcher.ts` so the login action opens a
      terminal running `opencode auth login`. The file has another session's uncommitted changes,
      so read `git diff` first and preserve them.
- [x] Provider doctor (`provider-doctor.ts`, `provider-doctor-repair.ts`; both have uncommitted
      changes): add a binary check and the repair hint
      `npm install -g opencode-ai` / `curl -fsSL https://opencode.ai/install | bash`.

### Task 3.6: Error normalisation

- [x] Using the shapes captured in Phase 0.5, classify OpenCode auth failures as non-retryable
      auth errors and rate limits as retryable, through the path Grok and Cursor use for ACP
      transport and provider notices (`acp-transport-failure.ts`, `isProviderNotice`). Also make
      sure a provider error delivered as assistant text is not recorded as a clean completion (the
      failure mode Cursor's `[resource_exhausted]` text and ACP transport errors hit before).
- [x] Tests built from the captured shapes.

**As built (Phase 3):**
- 3.1 `opencode-adapter-factory.ts`: `opencode acp --cwd <dir>`; `OPENCODE_CONFIG_CONTENT`
  carries only the permission block, merged into any existing value. The block starts with
  `"*"` and sets every known key (Task 0.1 consequences); YOLO off asks for `edit bash task
  external_directory webfetch websearch question doom_loop` and allows `read list glob grep
  lsp todowrite skill`. `sessionConfig` carries an explicit `provider/model` and mapped effort.
  `startupGate` is the shared `openCodeProcessGate` (`opencode-process-gate.ts`, built on
  `acp-startup-gate.ts`, 30 s maximum hold), which also serialises the discovery and sign-in
  status commands (Task 0.2 follow-up). `reportedCostOnly: true` records $0 when OpenCode reports no cost, instead of
  the $3/$15 default rate `computeTokenCost` would apply to an unknown `provider/model` id.
- 3.2 `opencode-cli-provider.ts` registered in `register-built-in-providers.ts` and
  `provider-instance-manager.ts`; parity matrix now 9 × 7. Its usage accumulates from the
  `complete` event (measured tokens plus reported cost) rather than estimating from context.
- 3.3 `opencode-cli-discovery-service.ts` runs `opencode models --verbose` every 5 minutes;
  the verbose metadata carries `capabilities.toolcall` and `capabilities.output.text`, which
  is the chat filter (name filter only as fallback). Family is a backend label such as
  "Xiaomi Token Plan (Europe)". Started from `unified-model-catalog-initialization.ts`. The
  catalog also now skips models.dev's own `opencode` (Zen) namespace, whose bare ids OpenCode
  cannot use. The picker shows "OpenCode default" when no model is chosen.
- 3.4 See 3.1 (`reportedCostOnly`) and Phase 2 (cost ledger, token mapping). No price rows
  were added and `STATIC_TABLE_PROVIDERS` does not include `opencode`.
- 3.5 `opencode-auth-status.ts`: counts from `opencode auth list` (credentials plus provider
  env vars, names only); with none, the effective model is AIO's configured one, else the
  `model` in `opencode debug config`, and a free `opencode/...` or absent model counts as
  usable (probe: a no-credential home defaults to `opencode/big-pickle`). A non-empty
  `provider.<id>.options.apiKey` in OpenCode's own config (which `auth list` does not show) also
  counts for that backend; only its presence is checked. Login command
  `opencode auth login` with a region hint; doctor binary check, shadow check and install hint;
  CLI update spec (`npm opencode-ai`, `opencode upgrade`).
- 3.6 "Invalid API Key" already matched the auth-failure detector; added OpenCode's
  `provider authentication required` and `opencode auth login` phrasing. OpenCode is not given
  a live auth probe on purpose: counting stored credentials would call a wrong-but-present key
  "authenticated" and veto the repair banner. `acp-provider-limit.ts` tags failed prompts whose
  error reads as a rate or usage limit (`rate limited`, `rate increased too quickly`, `too many
  requests`, `usage limit reached`, `Free/GoUsageLimitError`) with `quota` diagnostics (and parses
  "reset in 3 hours 20 minutes"), so the existing park-and-resume path treats them as retryable.
  "Provider is overloaded" is deliberately not tagged: it is backend capacity with no reset time,
  and the shared `overloaded` pattern in `core/error-recovery.ts` already classifies it as
  retryable. OpenCode sends
  provider errors as JSON-RPC errors, not assistant text (Task 0.5), so the existing
  "error text on an `end_turn` reply" detector already covers the remaining case.

### Task 3.7: Token Plan quota probe (only if Task 0.7 found a key-authenticated endpoint)

**Skipped (2026-09-22):** Task 0.7 found the console quota endpoints are cookie-only; the Token
Plan key gets 401. Stop gate 3 applies. The tasks below are left unticked on purpose.

- [ ] New `src/main/core/system/provider-quota/mimo-token-plan-probe.ts`, modelled on
      `grok-billing-probe.ts`. It gets the key the same way the OpenCode child does, from
      OpenCode's credential store, reading only the Token Plan entry in memory and never logging
      it. It maps the response to a `ProviderQuotaSnapshot` for provider `opencode`, and it only
      runs when the configured model's provider ID starts with `xiaomi-token-plan-`.
- [ ] Register it where Grok's probe is registered (`provider-quota/index.ts`,
      `usage-monitor-source.ts`, `provider-quota-service.ts`, `quota-auto-refresh.ts`).
- [ ] Tests use a recorded response with placeholder values, covering both a failing request and
      a changed response shape.

---

## Phase 4: Renderer and optional surfaces

- [x] Picker and menus: `provider-menu.constants.ts`, `compact-model-picker.types.ts`,
      `model-picker.controller.ts`, `model-selection-panel.component.ts` (`case 'grok'`
      equivalents), and `unified-catalog.store.ts`. The picker shows OpenCode models grouped by
      their `provider/` prefix, for example "Xiaomi Token Plan (Europe)".
- [x] Labels and icons: `instance-row.component.ts`, `instance-header.component.ts` (3 sites),
      `instance-detail-history-preview.utils.ts`, `message-format.service.ts`,
      `input-panel-formatters.ts` and `instance-list-provider-helpers.ts`. Use a neutral glyph;
      no new image assets are needed.
- [x] Settings: `general-settings-tab.component.ts`, `orchestration-settings-tab.component.ts`,
      `provider-quota-settings-tab.component.ts` (with or without a quota source, per Task 0.7) and
      `provider-quota-chip.component.ts` ordering.
- [x] Loops and automations: `loop-config-panel.component.ts`,
      `automations-page.component.ts`, `workboard-handlers.ts` and
      `plan-queue/plan-queue-relaxation.ts`.
- [x] Mobile gateway: `mobile-gateway-server.ts`, `mobile-gateway-model-handlers.ts` and
      `mobile-gateway-session-plan.ts`.
- [x] `cli-verification-ipc-handler.ts` mapping.
- [x] Renderer specs for the picker and menu constants are updated the way Grok's were.

**As built (Phase 4):** OpenCode appears in the instance picker order, labels ("OpenCode"),
a neutral colour (`var(--text-secondary)`) and a terminal-style glyph in the picker, instance
row and header; loop, automation, default-model and loop-provider settings lists; the quota
settings row (text explains there is no quota source) and chip maps; the mobile gateway's
provider sets and the phone app's new-session list. `plan-queue-relaxation.ts` has no provider
list, so it needed no change. The ACP send-timeout exemption in
`instance-messaging-send-utils.ts` now covers OpenCode.

---

## Phase 5: Docs

- [x] `docs/provider-parity-checklist.md`: add an `opencode` column to every table and a
      "Known gaps" entry (quota source per Task 0.7; plan mode not wired; `mimo` fork not supported). The
      file has another session's uncommitted edits, so preserve them. `npm run
      check:provider-parity` must pass.
- [x] `AGENTS.md` or `docs/architecture.md`: add one line to the provider list if Grok is listed
      there.
- [x] Add a short "Using MiMo Token Plan with OpenCode" section to `docs/DEVELOPMENT.md` (or the
      provider docs this repo already uses): install OpenCode, run `opencode auth login`, pick
      the region that matches the console's base URL, and choose the model in AIO.

**As built (Phase 5):** parity checklist has an `opencode` column in every table, an OpenCode
provider note, a generic-ACP note (thinking for all ACP agents; Grok thinking 🔲 → ✅), and a
Known-gaps entry; the other session's `grok-4.7` edit is intact and `check:provider-parity`
passes. Neither `AGENTS.md` nor `docs/architecture.md` lists Grok, so no line was added there.
`docs/DEVELOPMENT.md` has the "Using MiMo Token Plan with OpenCode" section and an updated
CLI prerequisite line.

---

## Phase 6: Gates, live checks and close-out

### Task 6.1: Gates

- [x] Targeted: every new or changed spec, via `npm run test:quiet -- <files>`.
- [x] `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
      `npm run check:ts-max-loc`, `npm run check:provider-parity`, `npm run build:main`,
      `npm run build:renderer` and `npm run test:quiet` (full suite; check `uptime` first).

**Result (2026-09-22, final code):** `tsc --noEmit` 0; spec `tsc` 0 (needs
`NODE_OPTIONS=--max-old-space-size=8192`; the default 4 GB heap ran out of memory); `npm run lint` 0;
`check:provider-parity` 0; `build:main` 0; `build:renderer` 0. `check:ts-max-loc` exits 1 only on
`src/renderer/app/features/instance-detail/input-panel.component.ts` (1,910 lines vs 1,857 + 50),
which is unchanged from HEAD and fails there too. Full suite: 25,880 of 25,881 passed; the one
failure (`history-manager.spec.ts`, ENOENT copying a temp file under load) is untouched by this
work and passed 3 of 3 runs alone; the first full run passed it.

### Task 6.2: Dev-app check with the free model (agent-runnable, no key)

- [x] In the dev app, create an OpenCode session on `opencode/mimo-v2.6-flash-free`, ask it to
      read a file and edit another, and confirm:
  - streaming,
  - tool-call rows,
  - thinking shown as thinking, not answer text,
  - context meter,
  - a YOLO-off approval prompt, with both allow and reject,
  - interrupt,
  - restart and resume,
  - a second concurrent session.

**Result (2026-09-22, dev app on fresh profiles, OpenCode in throwaway `XDG_*` homes, driven over
CDP by `_scratch/opencode-devapp/stage*.mjs`; screenshots in the same folder):**
- Streaming: assistant text grew live (`streaming: true` rows, 142 → 300+ characters) before the
  final flush.
- Tool-call rows: each turn rendered as a work cycle ("2 thoughts · 1 read · 1 edit",
  "1 thought · 1 execute"), with tool_use/tool_result rows (`read` → "pineapple",
  `write` → "Wrote file successfully.").
- Thinking: rendered as thoughts in the work cycle and a separate "Thought process" group; the
  assistant bubble read "Created answer.txt with the word pineapple." with no reasoning text.
- Context meter: header showed measured occupancy (24,742 / 200,000, 12%) while cumulative
  spend was 98,246, i.e. `usage_update` drives it, not the summed aggregate.
- YOLO-off approvals: reads ran without a prompt; a write raised the generic ACP "Input
  Required" card (Allow once / Always allow / Reject). "Allow once" → file written with
  "pineapple"; for `rm answer.txt`, "Reject" → tool refused, file kept, turn ended `idle`.
- Interrupt: `interruptInstance` mid-essay → idle in 4 s, text stopped growing.
- Restart and resume: `restartInstance` → `ready` with the same `ses_…` id; asked without tools,
  the model answered "pineapple" from the earlier conversation (`session/load`).
- Second concurrent session: B was created and ran a read while A was mid-turn; both finished
  with their own `ses_…` ids, no startup lock errors.
- Quitting the dev app left no `opencode acp` processes behind; Chrome's native-messaging
  manifest was unchanged afterwards.
- **Defect found and fixed here:** on a fresh OpenCode home the catalog briefly holds OpenCode's
  bundled models.dev list, so AIO's create-time validation rejected
  `opencode/mimo-v2.6-flash-free` ("no longer available … using the provider default") and the
  session silently ran OpenCode's default while the chip showed MiMo. Fixed by
  `isDynamicProviderModelId` (Codex rule unchanged; OpenCode accepts any `provider/model` id,
  since the adapter validates against the session's own options) used by the create-time
  resolver, the runtime reconciler and the mobile session plan (`allowDynamicCodexModel` renamed
  `allowDynamicModel`). Re-verified after a rebuild on a new fresh home: no notice, and OpenCode's
  own database recorded `providerID opencode`, `modelID mimo-v2.6-flash-free` for the reply.
- Observed, not changed (generic ACP behaviour shared with Grok/Cursor/Copilot): an "Input
  Required" card whose request timed out (60 s, auto-reject) stays on screen and its Cancel does
  not remove it; the free Zen model sometimes sent no update for ~70 s before streaming, which
  correctly raised AIO's standard "may be stuck" notice without a restart.

### Task 6.3: Live checks needing James's Token Plan key

- [x] Moved to [2026-09-22-opencode-provider_livetest.md](./2026-09-22-opencode-provider_livetest.md)
      (six checks: sign-in, Token Plan multi-turn tool use, effort `high`, 1M context meter,
      rate-limit handling, `run_on_node` on `windows-pc`).

### Task 6.4: Close-out

- [x] Fresh-eyes completion gate (`task-completion-gate` skill, separate agent) until
      `VERDICT: PASS`.
- [x] Update the as-built notes in this plan and the spec, rename the plan to `_plan_completed`
      and the spec to `_spec_completed`, and update the spec's plan link.

**Result (2026-09-22):** first fresh gate `VERDICT: PASS` with one Medium finding (OpenCode's
"rate increased too quickly" not tagged as a limit; "Provider is overloaded" excluded without a
stated reason) — fixed and documented. Second fresh gate `VERDICT: PASS`, reproducing every gate
(full suite 25,880 passed) with two Low findings: the livetest link to this file's completed name
(resolved by this rename) and the generic-ACP limit tagging missing from the parity checklist
(added).

## Stop-and-Confirm Gates

1. If Phase 0.1 shows `OPENCODE_CONFIG_CONTENT` replaces James's config instead of layering over
   it, stop and bring James a revised Decision 5.
2. If Phase 0.2 shows concurrent sessions corrupt or lock the shared OpenCode database, stop and
   bring James a revised Decision 6.
3. If Task 0.7 finds that quota can only be read with a browser login cookie, don't build a probe
   that borrows the browser session. Record it and carry on without one.
4. If Phase 0.6 reproduces the stall and the cause is in OpenCode, not AIO, report it before
   building on it.
