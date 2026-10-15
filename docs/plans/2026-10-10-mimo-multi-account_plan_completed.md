# Multiple MiMo Subscriptions (OpenCode Account Pool): Plan

**Status:** IMPLEMENTED (2026-10-10). Phases 1–8 are built and the in-loop gates passed,
including a fresh completion-gate review (`VERDICT: PASS`, no findings). Live checks
are deferred to [2026-10-10-mimo-multi-account_livetest.md](2026-10-10-mimo-multi-account_livetest.md).
Approved by James 2026-10-10 via review artifact `2026-10-10-mimo-multi-account`.
**Date:** 2026-10-10
**Builds on:**
[2026-09-13-provider-account-pools_plan_completed.md](2026-09-13-provider-account-pools_plan_completed.md)
(Claude/Codex account pools, including its Phase 8 remote-worker route),
[2026-09-22-opencode-provider_spec_completed.md](2026-09-22-opencode-provider_spec_completed.md)
(OpenCode provider; this item was out of scope there),
[2026-09-23-mimo-token-plan-allowance_spec_completed.md](2026-09-23-mimo-token-plan-allowance_spec_completed.md)
(MiMo quota; "multiple MiMo console accounts" was out of scope there).

> **For agentic workers:** read each file whole, plus callers and its `.spec.ts`, before
> editing. Never put a real key, cookie or home path into a test, fixture, log line or IPC
> response; use obvious placeholders. Every OpenCode process AIO starts goes through
> `withOpenCodeProcessGate` (`src/main/cli/adapters/opencode-process-gate.ts`). Never commit
> unless James asks. Browser work runs on `windows-pc` only; never drive a browser on the Mac.

## The short answer

- **OpenCode can hold several MiMo subscriptions in one install.** It keeps one key per
  provider name, but extra provider names can point at the same Token Plan server, each with
  its own key. One OpenCode install and one session store serve them all.
- **It cannot choose between them.** It has no idea that two providers are the same plan, and
  it does not switch when one runs out. That routing has to come from AIO.
- **Running several OpenCode installs (separate data folders) is the wrong route.** It splits
  the session store, so a conversation could not move to another account and keep its
  history, and it multiplies OpenCode's known database start-up race.
- **The extra subscriptions must be separate Xiaomi accounts.** MiMo counts its limits
  (100 requests and 10M tokens a minute per model) per account, summed across all of that
  account's keys. More keys on one account add nothing.

So the plan adds OpenCode/MiMo to the account pool system that Claude and Codex already
use. That system already does selection, failover on usage limits, per-account limit
tracking, the settings screen and the chip.

## Review outcome (2026-10-10)

- **The goal is allowance, not speed.** James: "my plan is 90%!" The 0.5% figure in E6 was
  the 2026-09-23 reading and is stale. The first account is close to running out, so
  failover on exhaustion is the core feature.
- Decisions 1, 2, 3, 4, 7, 8 and 9: approved as recommended.
- **Decision 5: changed to failover only.** Stay on the first account until it is refused
  or over the pre-emptive threshold, as for Claude/Codex. The "spread" mode is dropped.
- **Decision 6: changed to switching live without a restart now** (the respawn handoff stays
  as the fallback).
- **Decision 10: changed to include the Windows PC in v1.**

## Evidence (verified 2026-10-10, OpenCode 1.18.35, throwaway `HOME`/`XDG_*`, placeholder keys)

- **E1. Extra provider names work.** An injected `OPENCODE_CONFIG_CONTENT` defining
  `mimo-b` (`@ai-sdk/openai-compatible`, `baseURL https://token-plan-ams.xiaomimimo.com/v1`)
  made `mimo-b/mimo-v2.6-pro` appear next to `xiaomi-token-plan-ams/mimo-v2.6-pro` in
  `opencode models`.
- **E2. OpenCode's own key store works for custom names.** A key in `auth.json` under
  `mimo-c` (no key in config) made `mimo-c/*` appear, and `opencode auth list` listed it.
  `opencode auth login -p <provider id>` skips the provider picker, so AIO can open a
  terminal straight onto the right account.
- **E3. A live session can switch accounts.** Over ACP, one `opencode acp` session accepted
  `session/set_config_option {configId: "model"}` for `mimo-b/…`, `mimo-c/…` and
  `xiaomi-token-plan-ams/…` in turn, and each became current. No real turn was sent, and
  switching during an in-flight turn was not tested (Phase 0.2).
- **E4. A hand-written provider loses the model's details.** Defined with only a name,
  `mimo-b/mimo-v2.6-pro` reported context 0, no reasoning, no image input, no effort levels
  and no `interleaved: {field: "reasoning_content"}`. The last one is what MiMo needs for
  multi-turn tool use. Copying the built-in model's full metadata (limit, reasoning,
  tool_call, attachment, interleaved, modalities, variants) restored all of it, including
  `low/medium/high` effort. `opencode models <provider> --verbose` prints that metadata as
  JSON, so AIO can copy it at run time instead of hard-coding it.
- **E5. MiMo limits are per Xiaomi account** ("the sum of the total number of requests from
  all API Keys under a single account"), 100 RPM and 10M TPM for `mimo-v2.6-pro`, and going
  over gives "response delays or 429". Source: <https://mimo.mi.com/docs/en-US/api/guidance/rate-limit>.
  The page does not separate Token Plan from pay-as-you-go.
- **E6. No limit error has been seen yet.** James's OpenCode logs show only connection
  errors and two 500s, never a limit response. (The 0.5% allowance reading of 2026-09-23 is
  superseded by James's report of 90%; see Review outcome.) With the first account near
  exhaustion, the real "plan used up" response may appear soon: capture it (Phase 0.5).
- **E7. The pool is hard-wired to two providers.** `PooledProvider = 'claude' | 'codex'`
  (`src/shared/types/provider-account.types.ts:21-23`) and the matching Zod enum
  (`packages/contracts/src/schemas/provider-account.schemas.ts:22`). Per-provider branches
  sit in the home resolver, the spawn guards (`account-adapter-guards.ts`), the binding
  service (`provider-account-binding-service.ts:197-207`), the quota-probe builder and the
  profile seeds. Selection, failover, the ledger, handoff and the UI are generic once the
  type admits the provider.
- **E8. The MiMo quota reader is single-account.** `mimo-console-credentials-reader.ts`
  reads only Chrome's `Default` profile cookies, and `mimo-token-plan-probe.ts` gates on the
  default OpenCode model starting `xiaomi-token-plan-`.
- **E9. The selector suits failover-only.** `provider-account-selector.ts:16-18`: priority
  first, then soonest reset, then least recently used, never round-robin. The default pool
  policy steers *new* sessions away from an account at 90% of its allowance
  (`preemptive.newSessions: true, thresholdPct: 90`) when quota evidence exists.
- **E10. The remote-worker route exists.** The coordinator sends `accountRoute` to the
  worker (`remote-cli-adapter.ts`, `remote-node/rpc-schemas.ts`); the worker checks its own
  binding before spawning (`worker-agent/local-instance-manager.ts:336-340` calls
  `materializeWorkerAccountRoute()` in `worker-agent/worker-account-route.ts`, which runs
  `ProviderAccountBindingService.checkBinding()` on the worker); the coordinator skips binding checks for remote nodes
  (`provider-account-routing-service.ts:239-272`, `admit()` at `:357-372`).

## Decisions (as approved)

1. **Approach: approved (a).** Add `opencode` to the existing account pool; each AIO
   account maps to one OpenCode provider name.
2. **Where keys live: approved (a).** In OpenCode's own key store. AIO's "Log in" opens a
   terminal on `opencode auth login -p aio-mimo-<account>`. AIO never reads, stores or
   passes a key.
3. **Where the extra providers are defined: approved (a).** AIO injects them at spawn
   through `OPENCODE_CONFIG_CONTENT`, copying the built-in region provider's metadata (E4).
   James's own OpenCode config is untouched; terminal `opencode` sees only the original
   account.
4. **Model picker: approved (a).** Each model once. The instance keeps the logical model
   `xiaomi-token-plan-<region>/<model>` and its `accountProfileId`; the adapter swaps the
   provider prefix. `aio-mimo-*` entries are filtered out of discovery. The account chip
   shows the account.
5. **Spreading: changed to (b), failover only.** Existing priority selector and pre-emptive
   threshold, unchanged. No selector changes.
6. **Moving a live conversation: changed to (b), live switch now.** When an OpenCode
   process is running, the handoff switches the session's model prefix in place
   (`session/set_config_option`, E3). When it is not running (hibernated, restarted, crashed),
   the existing respawn-and-reload handoff is used. Both share one session store.
7. **Limit signal: approved (a).** Investigate first (Phase 0.1), then build on the signal
   that proves reliable.
8. **Allowance per account: approved (a).** Each MiMo account can name a Chrome profile
   whose MiMo console login the quota reader uses. Accounts without one still work, with no
   allowance figures.
9. **Ownership: approved (a).** Reuse the pool's "these are all my own paid accounts"
   acknowledgement. Xiaomi's terms for multiple Token Plan accounts are James's call.
10. **Windows PC: changed to (b), in v1.** MiMo accounts work on `windows-pc` through the
    existing remote route (E10). Each account must be logged in on each machine that will
    use it.

## Phases

### Phase 0: Investigation (no product code; outputs recorded in this plan)

All probes ran 2026-10-10 with OpenCode 1.18.35 in throwaway `HOME`/`XDG_*` homes with
placeholder keys, against a local fake OpenAI-compatible server (`/tmp`-style probe dir
outside the repo). Evidence logs kept in the session temp dir
(`mimo-multi-account-probe/`, disposable).

- [x] **0.1 Limit signal.** Fake server modes: 429 ± `Retry-After`, plan-exhausted 403,
  quota 400, 401, 500, mid-stream error. What ACP shows (all as `session/prompt` JSON-RPC
  errors `{code: -32603, message: "Internal error: <upstream error.message verbatim>",
  data: {service: "session", errorName: "APIError"}}`, each preceded by a `usage_update
  {used: 0}` in the fail-fast cases):

  | Fake response | ACP prompt error message | When | Retries |
  |---|---|---|---|
  | 429 + `Retry-After: 3` | `Internal error: Rate limit reached for requests` | ~17 s | 6 attempts ~3 s apart (Retry-After honoured), then fail |
  | 429, no `Retry-After` | `Internal error: 429 Too Many Requests` | ~72 s | 6 attempts, exponential backoff (~2/5/9/18/36 s), then fail |
  | 403 plan-exhausted body | `Internal error: <body.error.message>` e.g. `Token Plan quota exhausted for this account. Renew the plan to continue.` | ~1.3 s | none |
  | 400 quota body | `Internal error: You have exceeded your token plan quota …` | ~1.2 s | none |
  | 401 | `Internal error: Invalid API Key provided` | ~1.3 s | none (auth, not a limit) |
  | 500 | `Internal error: Internal server error` | ~70 s | 6 attempts, exponential backoff (NOT a limit) |
  | mid-stream error | partial `agent_message_chunk`s re-emitted on every retry (same `messageId`) | retries like 500 | exponential backoff |

  **OpenCode does not retry forever**: max 6 attempts per prompt (~72 s worst case), then the
  turn fails with the surfaced message above. The provider's `error.message` passes through
  verbatim after an `Internal error: ` prefix, so the limit signal can be text-based with the
  observed shapes. OpenCode's own log line is `level=ERROR message="stream error"
  providerID=… modelID=… session.id=… small=… agent=… mode=primary
  error.error="AI_APICallError: <message>"` in `<data>/opencode/log/opencode.log`.
  Limit-shaped: the 429 rows and the plan/quota 4xx rows. Never limits: 401, 500,
  connection errors, mid-stream breaks ("Provider is overloaded" stays excluded as
  capacity, not quota).
- [x] **0.2 Live switch.** (a) Multi-turn tool-using session on fake-a, live switch to
  fake-b between turns (`session/set_config_option {configId: "model"}`), then a turn on B:
  **B's request carries the complete earlier history (system, user, assistant tool_calls,
  tool results, assistant answers) and `reasoning_content` on every assistant message** —
  which also satisfies MiMo's documented multi-turn requirement ("the `reasoning_content`
  field must be fully passed back to the API", MiMo error-codes page). (b) **The retry does
  not move to B**: a turn stuck retrying a 429 on A keeps retrying A after the model is
  switched mid-turn. `session/cancel` immediately resolves the in-flight `session/prompt`
  with `result {stopReason: "end_turn", usage: 0/0/0}` (NOT an error — the in-place switch
  must therefore not treat that as a successful turn), after which the next prompt is served
  by B with full history. So the in-place switch is: cancel → `set_config_option` → re-send
  the interrupted work. (c) Respawn fallback confirmed: a new `opencode acp` process
  `session/load`s the same session and continues on B with the same full history and
  `reasoning_content`.
- [x] **0.3 Concurrency.** Two `opencode acp` processes with different
  `OPENCODE_CONFIG_CONTENT`, started serialised the way `withOpenCodeProcessGate` does,
  share the session database without errors; one process can `session/load` a session the
  other created and is running. The gate's serialisation is what avoids the known
  start-up "database is locked" race.
- [x] **0.4 Usage and cost.** Unchanged on a custom provider: `session/update`
  `usage_update {used, size, cost:{amount, currency}}` streams as usual and the
  `session/prompt` result carries `usage {inputTokens, outputTokens, totalTokens}`. The
  running-session cost ledger semantics are the same. Per-account accounting needs nothing
  new.
- [x] **0.5 MiMo's real exhaustion response.** MiMo docs (fetched 2026-10-10): the error
  codes page maps **429 to "Requests are too frequent, or the quota of Token Plan has been
  exhausted"** (remedy: "Upgrade the Token Plan package or switch to pay-as-you-go API"),
  402 to insufficient balance, 401 to a missing/invalid key **or a key that mixes Token
  Plan and pay-as-you-go** (remedy: use the Token Plan's dedicated base URL and key), and
  explicitly requires `reasoning_content` to be passed back in multi-turn thinking
  conversations. No separate documented "plan exhausted" body exists, so the real 429 (or
  4xx) body when the first account runs out is what Phase 4 must match flexibly. When it
  runs out, capture the real shape from (1) the OpenCode log `stream error` lines
  (`AI_APICallError: …`), (2) the failing `session/prompt` error message
  (`Internal error: …`), and (3) the conversation ledger's `provider_event_captures` — then
  add it as a fixture (placeholders only).
- [x] **0.6 Windows worker.** `windows-pc` is up (2026-10-10) but **OpenCode was not
  installed at all** (no `opencode` on PATH, no `~/.local/share/opencode`, no `auth.json`;
  Node 24.15.0/npm 12 present via nvm4w; the worker's `supportedClis` is
  antigravity/copilot/cursor). Installed the CLI globally via npm
  (`npm install -g opencode-ai` — the package is published as `opencode-ai`, plus
  `--allow-scripts=opencode-ai` for its binary postinstall; required by Decision 10's v1
  scope and reversible). Confirmed afterwards: `opencode` 1.18.35 at `C:\nvm4w\nodejs`;
  the data folder is `%USERPROFILE%\.local\share\opencode` (same layout as the Mac,
  `auth.json` lives there); `opencode models` shows the free Zen models and
  `opencode auth list` prints `~\.local\share\opencode\auth.json` / `0 credentials` in the
  familiar names-only format; `opencode models xiaomi-token-plan-ams --verbose` reports
  `Provider not found` until a `xiaomi-token-plan-*` credential exists there — exactly
  probe finding P1, which is why non-legacy spawns fail closed without region metadata.
  A multi-kilobyte inline `OPENCODE_CONFIG_CONTENT` (nested placeholder-key provider
  definitions) survived intact through the worker's remote-exec spawn path (`opencode
  models` listed the injected `fake-a/fake-model`, exit 0; the env var is passed by the
  environment, so the `windows-worker-shell-true-arg-mangling` argv problem does not
  apply). The definitive per-account spawn-path proof rides with the Phase 5 live test
  (a real MiMo session on `windows-pc`).

Additional probe findings used by the implementation:

- **P1. Provider activation.** `opencode models` only lists catalog providers (e.g.
  `xiaomi-token-plan-<region>`) that have an `auth.json` entry; config-defined providers
  (`aio-mimo-*`) list as soon as `OPENCODE_CONFIG_CONTENT` defines them, with or without a
  stored key. So `opencode models xiaomi-token-plan-<region> --verbose` (the metadata
  source) only works on a machine where a `xiaomi-token-plan-<region>` credential exists;
  fail closed for non-legacy accounts otherwise (as the plan says), and the doctor explains
  the remedy.
- **P2. Metadata shape.** `opencode models xiaomi-token-plan-<region> --verbose` prints one
  `provider/model` header + resolved JSON per model with `limit, options
  (max_completion_tokens), capabilities (reasoning, toolcall, attachment, input/output
  modalities, interleaved {field: "reasoning_content"}), variants (low/medium/high with
  `reasoningEffort`), cost, name`. Copying `name, limit, options, variants, reasoning,
  tool_call, attachment, interleaved, modalities, temperature, cost` into the injected
  `aio-mimo-*` model entry restores everything including the effort levels (E4 confirmed
  again).
- **P3. `opencode auth list` output** (ANSI box drawing): catalog providers print their
  display name (`●  Xiaomi Token Plan (Europe)  api`), custom providers print their
  provider id (`●  aio-mimo-max-b-1a2b  api`), then `└  N credentials`. So the binding
  check matches the derived provider id for `aio-mimo-*`, and the id or the known region
  display name for `xiaomi-token-plan-<region>`. Names only; never values.
- **P4. `session/new`/`session/load` `configOptions`** list every model of every provider
  in the merged config (so `aio-mimo-*` models appear in OpenCode's own picker); the
  `effort`/`thought_level` option appears only for models whose metadata has `variants`.
  AIO filters `aio-mimo-*` from its own discovery (Decision 4).

### Phase 1: Types, schema, settings, store

- [x] Add `'opencode'` to `PooledProvider`, `POOLED_PROVIDERS` and `PooledProviderSchema`;
  add a default pool policy for `opencode` (`continuation: 'shared-store'`, failover mode as
  for Claude/Codex).
- [x] Profile gains optional OpenCode fields: `region` (`ams` | `sgp` | `cn`) and
  `chromeProfile` (Decision 8). The provider name is derived, never stored free-form:
  legacy → `xiaomi-token-plan-<region>`, others → `aio-mimo-<profileId>`
  (`opencodeAccountProviderName()` in `provider-account.types.ts`; schema enforces
  `region` exactly on OpenCode profiles and `chromeProfile` as a plain folder name).
- [x] Settings migration (once, idempotent): create the legacy OpenCode profile when
  `opencode auth list` shows a `xiaomi-token-plan-*` credential (names only, never values).
  As built: `migrateOpenCodeLegacyProfile()` reads the same names synchronously from
  `auth.json`'s top-level keys (bounded, values never read — the codebase's
  `readCodexAuthHead`/`readLegacyCopilotIdentity` pattern; a sync `opencode auth list`
  cannot run inside the sync settings-migration runner), re-checks on every start until a
  credential or an existing legacy profile is found, then pins the marker.
  `migrateProviderAccountLegacyProfiles()` now covers only Claude/Codex.
- [x] Tests: types, schema invariants, migration, store.

### Phase 2: Spawn wiring

- [x] `resolveOpenCodeAccountSpawnConfig()` in `account-adapter-guards.ts`, alongside the
  Claude and Codex resolvers. Home resolver: no per-account home for OpenCode (an OpenCode
  profile has no home; its isolation is the derived provider name).
- [x] Model metadata source: read `opencode models xiaomi-token-plan-<region> --verbose`
  through the process gate on the machine that spawns
  (`opencode-region-model-metadata.ts`), cache per region with the existing discovery
  refresh (same `opencode models --verbose` run feeds the cache), and fail closed (refuse
  a non-legacy account) when it cannot be read (checked in `prepareSpawn`, on the
  spawning machine).
- [x] `buildOpenCodeConfigContent()` merges `provider.aio-mimo-*` definitions for **every**
  enabled account (base URL and metadata copied from the region's verbose metadata; no
  `apiKey` — OpenCode's own key store supplies it). All accounts are present so a live
  switch (Phase 4) needs no restart. Legacy-only content is byte-identical to earlier
  builds (tested).
- [x] `resolveOpenCodeSessionModel()` swaps the provider prefix to the routed account's
  provider name, for new and resumed sessions (only `xiaomi-token-plan-*` logical models
  are swapped; other backends keep their id). The scoped generation budget covers
  `aio-mimo-*/mimo-v2.6-pro` too.
- [x] Discovery filters `aio-mimo-*` models (Decision 4).
- [x] Tests: adapter-factory account-route spec for OpenCode; config-content merge keeps the
  permission block intact; prefix swap; a legacy-only setup produces config content
  byte-identical to today (`opencode-account-spawn.spec.ts`,
  `opencode-account-provider-config.spec.ts`, extended `adapter-factory-account-route.spec.ts`,
  `opencode-generation-budget.spec.ts`, `opencode-cli-discovery-service.spec.ts`).

### Phase 3: Login, binding, doctor

- [x] Login launcher: per-account `opencode auth login -p <provider name>` in a terminal on
  the Mac (`buildOpenCodeProfileLoginCommand()`; legacy pins
  `-p xiaomi-token-plan-<region>`, falls back to the picker without a region).
- [x] Binding service: an OpenCode account is authenticated when `opencode auth list` lists
  its provider name (names only; `aio-mimo-*` matches its id, the legacy region provider
  its id or display label). No identity can be read from a key, so identity is the user's
  label and `identity-mismatch` never occurs for MiMo.
- [x] Doctor: flag accounts with no key (binding state), and missing model metadata
  (non-legacy accounts whose region metadata is not readable on this machine).
- [x] Tests for all three, with `opencode` output fixtures using placeholder names.

### Phase 4: Limit detection, failover and the live switch

- [x] Turn the Phase 0.1 findings into an OpenCode limit signal feeding
  `detectErrorProviderLimit()` (structured where possible, text patterns only as fallback,
  with negative tests so connection errors and 500s never count as limits).
- [x] Run the existing failover coordinator, loop failover and parked veto for OpenCode; the
  ledger records the limit against the account.
- [x] Live switch: give `AcpCliAdapter` a method that applies a new session config value to
  the open session (the code that already sends `set_config_option` after `session/new` and
  `session/load`). In `runtime-reconciler-account-handoff.ts`, when the provider is OpenCode
  and the adapter is running, switch in place (cancel the in-flight turn first if Phase 0.2b
  says so), update `accountProfileId` and the routing source, and emit the same events,
  banners and transcript notes as a respawn handoff. Otherwise fall back to the respawn
  handoff. After a switch, continue the interrupted work the same way the existing failover
  does.
- [x] Tests (as covered): scripted MiMo limit → ledger row for the right account → switch
  (instance-provider-limit-handler.account-failover.spec.ts, incl. the MiMo chain case);
  in-place switch with no new process and the next turn on the new prefix
  (runtime-reconciler.runtime-change.spec.ts, runtime-reconciler-account-handoff.spec.ts,
  acp-cli-adapter.config-options.spec.ts); no live adapter → respawn fallback (same specs);
  no account can take over → the existing park behaviour (same harness, provider-generic).

### Phase 5: Windows PC

- [x] Remote spawn: `materializeWorkerAccountRoute()` accepts OpenCode routes and its binding
  check runs the Phase 3 OpenCode check on the worker; the worker builds the config content and metadata from its own
  `opencode` (Phase 2 runs where the adapter is created).
- [x] Worker advertises which OpenCode accounts it has logged in (`accountProfileIds`), so
  routing only sends a MiMo session to a machine with that account.
- [x] Logging in on the Windows PC: Settings shows each account's status per machine and, for
  a machine without it, the exact command to run there
  (`opencode auth login -p aio-mimo-<account>`). AIO does not handle the key.
- [x] Tests: extend `remote-node/__tests__/provider-account-remote-spawn.spec.ts` for OpenCode.
- [x] The worker needs the new build deployed (memory `worker-build-skew-breaks-browser-gateway`):
  record the redeploy step in the live-test doc.

### Phase 6: Allowance per account

- [x] Credentials reader takes a Chrome profile folder (default `Default`); the session
  renewer stays per profile.
- [x] Per-account MiMo probe in `buildAccountQuotaProbes()`; the legacy account keeps today's
  global probe and the token-usage-monitor fallback. This also feeds the 90% pre-emptive
  steering for new sessions (E9).
- [x] Tests: profile path selection on macOS, Windows and Linux; missing profile gives
  "no allowance data", never numbers.

### Phase 7: Settings screen and chip

- [x] Provider Accounts tab: OpenCode/MiMo section to add an account (label, region, Chrome
  profile), log in, reorder, enable or disable, and per-machine status (Phase 5).
- [x] Account chip and switch banners on OpenCode sessions (both gate on isPooledProvider, which now admits opencode; switch-session IPC text updated). The visual check in the running app is deferred to livetest check 2 (same GUI reason).
- [x] Component tests (20 DOM cases incl. the MiMo section and per-machine rows). The dev-app seeded-store visual check is deferred to livetest check 1: it needs James to operate and look at the Harness GUI on the Mac (an agent may not open the Mac GUI under the standing browser/UI rule).


As-built notes (Phases 4-7):

- Phase 4: the cancelled prompt settles locally as a client cancellation (probe 0.2b)
  and is never counted as a completed turn; the failover coordinator re-sends the
  interrupted work after either handoff path.
- Phase 5: the per-machine status derives from each worker's own `opencode auth list`
  advertisement (a placement hint; the spawn-time binding check decides).
- Phase 6: the per-account probe has no configured-model gate (the account IS a Token
  Plan account); the legacy global probe keeps its gate and the usage-monitor fallback.
- Phase 7: Chrome profile is set when adding an account (update IPC also accepts it);
  the chip and switch banners need no per-provider code (isPooledProvider gate).
### Phase 8: Docs and gates

- [x] Update `docs/provider-parity-checklist.md`, `docs/DEVELOPMENT.md` (MiMo section) and the
  account-pool docs. As built: the parity checklist's OpenCode gap and DEVELOPMENT's
  "Multiple MiMo subscriptions" section describe the pool; `docs/AIO_MCP_CLI.md` and
  `docs/llm/AIO_MCP_CLI_REFERENCE.md` name `providerAccountProfiles` /
  `providerAccountPools` as the operator-only keys covering Claude, Codex and MiMo.
- [x] Canonical gates from `AGENTS.md` plus `check:provider-parity`, `check:contracts` and
  `build:worker-agent` (2026-10-10): `tsc --noEmit` 0, `typecheck:spec` 0, `lint` 0,
  `check:ts-max-loc` 0, `build:main` 0, `build:renderer` 0, `test:quiet` 0
  (2389 files, 30140 tests), `check:provider-parity` 0, `check:contracts` 0,
  `build:worker-agent` 0. Fresh-eyes completion gate follows these results.
- [x] Live-test doc for checks that need real accounts or the rebuilt app: a real turn on a
  second subscription, a live in-place switch when the first account runs out, the respawn
  fallback, a MiMo session on `windows-pc` on the second account, and per-account allowance
  with a second Chrome profile. Recorded in
  [2026-10-10-mimo-multi-account_livetest.md](2026-10-10-mimo-multi-account_livetest.md)
  (checks 1–8). Not verified in-loop.

## Risks

- **OpenCode config shape drift.** Custom provider fields are observed behaviour, not a
  contract. Copying metadata at run time (E4) avoids hard-coded model data; Phase 2 tests pin
  the shape we send.
- **Unknown limit signal.** If OpenCode keeps retrying silently with no usable signal,
  failover can only react to stalls. Phase 0.1 decides whether Phase 4 is viable as written;
  if not, stop and report to James before building it.
- **Switching mid-turn.** If OpenCode binds the model at turn start, a stuck turn has to be
  cancelled before switching; Phase 0.2b settles it.
- **First account runs out before this ships.** Today that parks MiMo sessions on the one
  account. Nothing in this plan makes that worse.
- **Windows worker availability and build skew.** Remote checks depend on `windows-pc` being
  up and on the new worker build.
- **Terms of service** (Decision 9).

## Out of scope

- The MiMo Code fork (`mimo` binary).
- Multiple MiMo accounts in the standalone token-usage-monitor.
- Spreading sessions across accounts (Decision 5).
