# Cursor CLI Provider — Design Spec

**Status:** Draft — pending implementation plan
**Author:** Orchestrator session (brainstorming flow)
**Date:** 2026-04-21
**Scope:** Add Cursor (`cursor-agent`) as a fifth first-class CLI provider alongside Claude, Codex, Gemini, and GitHub Copilot.

---

## 1. Background & Motivation

Cursor launched a standalone CLI (`cursor-agent`, also aliased `agent`) that exposes the Cursor Agent outside the Cursor editor. Like the GitHub Copilot CLI, it is a multi-model router: the underlying model (Claude Opus/Sonnet, GPT-5.4, Gemini 3 Pro, xAI Grok, etc.) is chosen via `--model`, but the transport is one single binary running against the user's Cursor subscription.

Users on plans that include Cursor want to orchestrate with it the same way they already orchestrate the other four CLIs. This spec adds Cursor as a first-class provider with full feature parity — streaming output, session resume, tool-use surfacing, cross-model review eligibility, UI provider-selector integration, and detection registry — following the precedent established by the Copilot adapter.

### Goals

- Add `'cursor'` as a valid `ProviderName` / `ProviderType` / `CliType` / `InstanceProvider` throughout the stack.
- Implement `CursorCliAdapter` (spawns `cursor-agent -p`) and `CursorCliProvider` (wraps the adapter for the provider interface).
- Surface Cursor in the provider selector UI, model dropdown, settings, and cross-model-review options.
- Support multi-turn conversations via Cursor's native `--resume <session_id>`.
- Parse Cursor's `--output-format stream-json` NDJSON event stream and map it to the project's `OutputMessage` / `ProviderRuntimeEvent` types.

### Non-Goals

- Cursor's cloud/background agents (`-c` / `--cloud`): orchestrator runs locally.
- Cursor's plan/ask modes (`--mode plan|ask`): the orchestrator's agent-mode layer handles this differently.
- Image attachments via `@filepath`: matches Copilot/Gemini behavior — documented as a future extension.
- Native reasoning event types: Cursor doesn't emit them today; inline-text `<thinking>` extraction covers models that embed reasoning in their text output.
- Refactoring Copilot/Gemini to share a `BaseSessionResumeAdapter` abstract class — out of scope; noted as a future opportunity.

---

## 2. Reference Research

Primary sources consulted:

- [Cursor CLI docs — Overview](https://cursor.com/docs/cli/overview)
- [Cursor CLI docs — Headless](https://cursor.com/docs/cli/headless)
- [Cursor CLI docs — Using Agent in CLI](https://cursor.com/docs/cli/using)
- [Cursor CLI docs — Parameters](https://cursor.com/docs/cli/reference/parameters)
- [Cursor CLI docs — Output Format](https://cursor.com/docs/cli/reference/output-format)
- [Cursor CLI blog](https://cursor.com/blog/cli)
- [CLI Agent Modes and Cloud Handoff changelog (Jan 2026)](https://cursor.com/changelog/cli-jan-16-2026)
- [Tarq: Prettifying Cursor CLI Agent's Stream Format](https://tarq.net/posts/cursor-agent-stream-format/)

### Key facts extracted

- **Binary:** `cursor-agent` (install: `curl https://cursor.com/install -fsSL | bash`). Docs use the alias `agent` in examples. We standardize on `cursor-agent` because `agent` is too generic a name to reliably detect on arbitrary systems.
- **Non-interactive flag:** `-p` / `--print`.
- **Output formats:** `text` | `json` | `stream-json` (NDJSON).
- **Auth (capability — not a strict precedence order):** the CLI accepts `--api-key <key>`, reads `CURSOR_API_KEY` from the environment, and honors an authenticated session from `cursor-agent login` (also invokable as `agent login`). Official docs do not publish a guaranteed precedence order; the adapter will not assert or rely on one.
- **Model override:** `--model <model>`.
- **Yolo / force:** `-f` / `--force` / `--yolo`.
- **Session resume:** `--resume [chatId]`, `--continue` (= `--resume=-1`).
- **Sandbox:** `--sandbox enabled|disabled`.
- **Streaming deltas:** `--stream-partial-output` appears in local `cursor-agent --help` output but is not prominently documented on the public docs site. The adapter passes it conditionally: we attempt it first and fall back to plain `--output-format stream-json` if the flag is rejected. **Verify during implementation** against the installed `cursor-agent` version on the developer machine; gate the flag behind a feature-detect on first `checkStatus()`.
- **Agent mode:** `--mode plan|ask` (default mode is "agent").

### Stream-JSON event schema (confirmed from docs)

```
{"type":"system","subtype":"init","apiKeySource":"env|flag|login","cwd":"<path>","session_id":"<uuid>","model":"<name>","permissionMode":"default"}
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]},"session_id":"<uuid>"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"<chunk>"}]},"session_id":"<uuid>"}
    # With --stream-partial-output, may include timestamp_ms and model_call_id for delta filtering.
{"type":"tool_call","subtype":"started","call_id":"<id>","tool_call":{...},"session_id":"<uuid>"}
{"type":"tool_call","subtype":"completed","call_id":"<id>","tool_call":{...with result...},"session_id":"<uuid>"}
{"type":"result","subtype":"success|error","is_error":false|true,"duration_ms":<n>,"duration_api_ms":<n>,"result":"<text>","session_id":"<uuid>","request_id":"<uuid>?"}
```

---

## 3. Architecture & File Layout

### New files

| File | Purpose |
|---|---|
| `src/main/cli/adapters/cursor-cli-adapter.ts` | Spawns `cursor-agent -p`, parses NDJSON events, emits `OutputMessage` + lifecycle events. Mirrors `copilot-cli-adapter.ts` structure (~600 LOC). |
| `src/main/cli/adapters/__tests__/cursor-cli-adapter.spec.ts` | Vitest unit tests for the adapter. |
| `src/main/providers/cursor-cli-provider.ts` | Wraps the adapter for the `BaseProvider` interface, forwards events to the normalized `events$` stream. Mirrors `copilot-cli-provider.ts` (~250 LOC). |
| `src/main/providers/__tests__/cursor-cli-provider.spec.ts` | Vitest unit tests for the provider. |

### Modified files — type/enum literal additions

> **`ProviderType` taxonomy note.** The repo has *four* distinct provider-type unions that all need a `'cursor'` literal, plus a fifth abstract provider union used by the registry/adapter layer. They are not unified (pre-existing inconsistency — e.g., `packages/sdk/src/providers.ts` also lacks `'copilot'`). Each touch-point below references the specific union or record that needs updating. Full unification is out of scope for this change; flagged as future cleanup in §10.

All pattern-additions of the `'cursor'` literal to existing unions and lookup tables:

#### Contract schemas & types

| File | Change |
|---|---|
| `packages/contracts/src/types/provider-runtime-events.ts` | `ProviderName` union += `'cursor'`. |
| `packages/contracts/src/schemas/provider-runtime-events.schemas.ts` | `ProviderNameSchema` enum += `'cursor'`. |
| `packages/contracts/src/schemas/instance.schemas.ts` | `InstanceCreatePayloadSchema.provider` zod enum += `'cursor'`; same for `InstanceCreateWithMessagePayloadSchema.provider`. **Blocker** — without this the IPC layer Zod-rejects any `provider: 'cursor'` payload at the main/renderer boundary. |
| `packages/contracts/src/schemas/orchestration.schemas.ts` | `SpawnChildPayloadSchema.provider` zod enum += `'cursor'`. **Blocker** — without this `spawn_child` commands targeting Cursor fail validation. |

#### Shared types

| File | Change |
|---|---|
| `src/shared/types/provider.types.ts` | `ProviderType` += `'cursor'`; `CURSOR_MODELS` const (see §5); `DEFAULT_MODELS['cursor']`; `PROVIDER_MODEL_LIST['cursor']`; `CLI_TO_PROVIDER_TYPE['cursor']`. |
| `src/shared/types/settings.types.ts` | `CanonicalCliType` += `'cursor'`; `defaultCli` select options include Cursor; `crossModelReviewProviders` multi-select options include Cursor. |
| `src/shared/utils/id-generator.ts` | `INSTANCE_ID_PREFIXES` += `cursor: 'u'` (pick unused prefix letter — current set: `c`/`g`/`x`/`p`/`a`/`i`). `InstanceProvider` type (the `keyof typeof` union) updates automatically. Restored-session/provider inference relies on this prefix. |

#### Main-process integration

| File | Change |
|---|---|
| `src/main/cli/cli-detection.ts` | `CliType` += `'cursor'`; `SUPPORTED_CLIS` includes it; `CLI_REGISTRY.cursor` entry added with command `'cursor-agent'`, version flag, alternative paths (§4). |
| `src/main/cli/adapters/adapter-factory.ts` | Export `createCursorAdapter`; `CliAdapter` union += `CursorCliAdapter`; switch cases in `createCliAdapter` and `resolveCliType`/priority; `getCliDisplayName` entry; `mapSettingsToDetectionType` entry. |
| `src/main/providers/register-built-in-providers.ts` | Register `CURSOR_DESCRIPTOR`. |
| `src/main/providers/provider-instance-manager.ts` | `DEFAULT_PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig>` needs a `cursor: DEFAULT_CURSOR_CONFIG` entry (§5). **Blocker** — type error without it. |
| `src/main/instance/instance-manager.ts` | `resolveProviderName()` switch (currently `case 'claude' \| 'codex' \| 'gemini' \| 'copilot'`) += `case 'cursor'`. **Blocker** — without it, normalized runtime events from a Cursor instance silently drop. |
| `src/main/ipc/handlers/session-handlers.ts` | `getProviderDisplayName()` switch += `case 'cursor': return 'Cursor'`. |
| `src/main/routing/hot-model-switcher.ts` | `getProviderType()` detection by name-substring match (`if (name.includes('cursor')) return 'cursor'`); prompt-adaptation `switch` cases updated if Cursor needs any provider-specific prompt munging. |
| `src/main/security/env-filter.ts` | Add `CURSOR_API_KEY` to the allowlist so the Cursor child process sees it. Pattern verified during implementation against how existing provider-specific keys are handled. |
| `src/main/orchestration/orchestration-protocol.ts` | `SpawnChildCommand.provider` union += `'cursor'`. |
| `src/main/orchestration/consensus.types.ts` | `ConsensusProviderSpec.provider` union += `'cursor'`. |
| `src/worker-agent/capability-reporter.ts` | Provider-name substring match for remote capability reporting += `'cursor'`. |

#### Renderer (Angular)

| File | Change |
|---|---|
| `src/renderer/app/core/state/instance/instance.types.ts` | `InstanceProvider` += `'cursor'`; `CreateInstanceConfig.provider` += `'cursor'`. |
| `src/renderer/app/core/services/provider-state.service.ts` | `ProviderType` union += `'cursor'`; `normalizeProvider()` accepts `'cursor'`. |
| `src/renderer/app/features/providers/provider-selector.component.ts` | `ProviderType` union += `'cursor'`; add Cursor to the option list (label, color, icon, available flag). |

#### Renderer / UI touch points — provider enumeration

These files switch on or enumerate provider names. Each needs a literal `'cursor'` case added. **"verify during implementation"** on each — the exact shape of the update may differ per file.

- `src/renderer/app/features/instance-list/instance-row.component.ts` — provider badge rendering.
- `src/renderer/app/features/instance-detail/instance-header.component.ts` — provider label.
- `src/renderer/app/features/instance-detail/instance-detail.component.ts` — provider display.
- `src/renderer/app/features/instance-detail/message-format.service.ts` — provider-name display.
- `src/renderer/app/features/instance-detail/input-panel.component.ts` — provider-aware behavior (if any; verify).
- `src/renderer/app/features/instance-list/history-rail.service.ts` — persisted-provider lists.
- `src/renderer/app/features/models/models-page.component.ts` — model page provider enumeration.
- `src/renderer/app/core/state/instance/instance-list.store.ts` — provider-aware filtering.
- `src/renderer/app/core/state/instance/instance.store.ts` — provider-aware state.
- `src/renderer/app/core/state/cli.store.ts` — known-CLI list.
- `src/renderer/app/core/services/new-session-draft.service.ts` — default-selection handling.
- `src/renderer/app/core/services/ipc/instance-ipc.service.ts` — provider type in payloads.
- `src/preload/domains/instance.preload.ts` — provider type in IPC bridge (if branded; verify).
- `src/shared/types/history.types.ts` — persisted-provider type.
- `src/main/instance/tool-output-parser.ts` — per-provider tool-name dispatch (verify; Cursor's tool names largely overlap Claude's).
- `src/main/orchestration/cross-model-review-service.ts` — eligible reviewer providers.
- `src/main/orchestration/consensus-coordinator.ts` — consensus-capable providers.
- `src/main/orchestration/reviewer-pool.ts` — reviewer pool membership.
- `src/main/providers/__tests__/parity/provider-parity.spec.ts` — parity-test fixture.
- `src/main/providers/__tests__/adapter-descriptors.spec.ts` — descriptor-test fixture.
- `src/shared/validation/ipc-schemas.spec.ts` — if any tests assert the provider list, update fixture.

### Already-handled plumbing — no changes needed

Verified during exploration:

- `src/main/cli/adapters/base-cli-adapter.ts` (shared superclass — generic).
- `src/main/providers/provider-interface.ts` / `BaseProvider` (generic).
- `src/shared/validation/ipc-schemas.ts` (validates `provider` via the contract `ProviderNameSchema` which we are updating).
- `src/main/register-aliases.ts` — no new `@contracts/...` subpaths are introduced, so the Node runtime resolver doesn't need a new alias. (Verified: this spec only modifies existing files under `packages/contracts/src/{schemas,types}/`.)

---

## 4. Cursor CLI Adapter Design

### Binary detection

- Primary command: `cursor-agent`.
- Fallback paths checked in order:
  - `/opt/homebrew/bin/cursor-agent`
  - `/usr/local/bin/cursor-agent`
  - `~/.local/bin/cursor-agent`
  - `~/.cursor/bin/cursor-agent`

Not falling back to the bare name `agent` (too generic; high collision risk with unrelated binaries).

### Non-interactive invocation

```
cursor-agent -p \
  --output-format stream-json \
  [--stream-partial-output] \
  --force \
  --sandbox disabled \
  [--model <model>] \
  [--resume <session_id>] \
  "<prompt>"
```

Flag rationale:

- `-p` enables non-interactive print mode — required for scripting.
- `--output-format stream-json` — NDJSON one-event-per-line; machine parseable.
- `--stream-partial-output` — assistant text deltas during generation. Passed only if a one-shot `cursor-agent --help` probe (during `checkStatus()` or first `spawn()`) confirms the flag is recognized; otherwise omitted. See §2 caveat.
- `--force` — auto-approve Cursor's own command-approval prompts. **Safety rationale:** the orchestrator already runs per-instance inside its own working-directory boundary, and this spec pairs `--force` with `--sandbox disabled`; those are equivalent to how Claude adapter runs with `--dangerously-skip-permissions` and Copilot runs with `--allow-all-tools`/`--allow-all-paths`. The orchestrator's tool-approval UX is a separate layer above the CLI; when present (future feature), it gates at the orchestrator level before `sendMessage()` dispatches. Running with `--force` today matches existing CLI adapters' posture and is documented in §10 as a parity trade-off.
- `--sandbox disabled` — Cursor's sandbox would double-gate operations the orchestrator already mediates via working-directory scoping + yolo flag. Matches existing adapters' approach.
- `--model` — omitted when `cliConfig.model` is unset **or equals the `'auto'` sentinel (case-insensitive)**, letting the CLI pick based on the user's subscription default (see §5 for Auto/Max Mode handling).
- `--resume <id>` — added only after we've captured a `session_id` from a prior `result` event. On `--resume`-specific failure (e.g., `invalid session id`, `session expired` stderr pattern), the adapter clears the cached session_id and retries the turn **once** without `--resume`. Documented per-turn in logs so the UX doesn't silently restart a multi-turn conversation.

### Prompt delivery

Positional argument (no stdin). Stdin is closed immediately after spawn. When `systemPrompt` is configured, it is prepended to the user message with a blank line separator: `${systemPrompt}\n\n${message.content}`. (Cursor has no dedicated `--system-prompt` flag in non-interactive mode.)

### Authentication

Cursor CLI supports three auth modes:

- `--api-key <key>` CLI flag (**the adapter does not set this** — avoids leaking keys into process-args visible to `ps`).
- `CURSOR_API_KEY` environment variable.
- Cached authenticated session from `cursor-agent login` (also invokable as `agent login`).

The adapter relies on either `CURSOR_API_KEY` being in the parent process env (passed through by allowlisting it in `env-filter.ts`) or a prior login. The official docs do not publish a guaranteed precedence order among these modes — the adapter does not test for or depend on one.

### Event-to-OutputMessage mapping

| Cursor NDJSON event | Adapter action |
|---|---|
| `{type:"system", subtype:"init", session_id, model}` | Capture `session_id` (also captured later from `result` for robustness); emit `status: 'busy'`; log model for diagnostics. |
| `{type:"user"}` | Ignore — this is our own prompt echoed back. |
| `{type:"assistant", message:{content:[{type:"text",text}]}}` | Assistant content. With `--stream-partial-output`, arrives as deltas; without it, arrives as a single final message. Append to `streamingContent`; emit `output` `OutputMessage` with `streaming: true`, stable `messageId` per turn, `accumulatedContent` in metadata. **Dedupe rule:** if a final assistant message arrives after partial-output deltas (same `model_call_id` when present, else same turn), compare its content to `streamingContent`. If final ⊆ streaming (prefix or equal), emit only a terminal `streaming: false` flush with no new text. If final extends streaming, emit the suffix delta then the flush. Never concatenate naïvely. |
| `{type:"tool_call", subtype:"started", call_id, tool_call}` | Emit `tool_use` `OutputMessage`. **Tool-name extraction:** Cursor tool payloads are keyed objects (`{readToolCall:{…}}`, `{writeToolCall:{…}}`, `{bashToolCall:{…}}`), not a flat `tool_name` field. Extract: first key of `tool_call` object → strip trailing `ToolCall` suffix → fallback `"unknown_tool"` if the shape is unexpected. Tool `input` = the value at that first key. |
| `{type:"tool_call", subtype:"completed", call_id, tool_call}` | Same name-extraction rule. Detect failure via `tool_call.<toolKey>.error`, `tool_call.<toolKey>.success === false`, or a top-level `is_error` flag on the event. Emit `tool_result` `OutputMessage`; on failure also emit `error` `OutputMessage` so it reaches child-summary fallback. |
| `{type:"result", subtype, is_error, duration_ms, result, session_id, request_id}` | Terminal event. Store `session_id` for subsequent `--resume`. Emit `context` event with estimated usage (token counts are directional — see §5). Emit `complete`. If `is_error: true`, also emit `error` and reject. |

### Multi-turn session resume

Identical pattern to Copilot, with a self-healing retry on stale-session failure:

1. On the terminal `result` event of every turn, capture `event.session_id` into `this.cursorSessionId`.
2. On every subsequent `sendMessage()` call, `buildArgs()` includes `--resume ${this.cursorSessionId}` before the positional prompt.
3. **Resume-failure fallback:** if the Cursor CLI rejects the resume (stderr/result patterns like `invalid session id`, `session not found`, `session expired`, or `is_error: true` explicitly tied to the resume attempt), clear `this.cursorSessionId`, log a user-visible notice, and retry the turn **once** without `--resume`. Subsequent turns resume off the new `session_id`. Prevents a single expired session from bricking the instance for the user.
4. `terminate()` clears `this.cursorSessionId` so the next `spawn()` starts a fresh conversation.

### Thinking / reasoning extraction

Cursor does not document a dedicated reasoning event type. We still run the shared `extractThinkingContent()` helper on assembled assistant text so that inline `<thinking>...</thinking>` blocks emitted by reasoning-capable underlying models (Claude 4.x, Gemini 3 Pro) are surfaced to the UI. If Cursor adds a native reasoning event in a future release, extend the event dispatcher.

### Error surfacing (summary — full details in §6)

- **Spawn `ENOENT`** → reject with install-hint message.
- **Unknown-flag fallback** — retry without `--stream-partial-output` if the installed CLI rejects it.
- **Stderr matching `/error|fatal|failed/i`** → emit `error` `OutputMessage` + EventEmitter error.
- **Stderr matching `/SecItemCopyMatching|keychain|login item/i`** → emit `error` with keychain remediation text.
- **`result.is_error: true`** → emit `error` + reject; resume-retry fallback first if the error looks session-related.
- **Resume-specific failures** → clear `cursorSessionId`, retry once without `--resume`.
- **Non-zero exit code** → reject with `"Cursor exited with code N"` (after retry logic).
- **Partial trailing JSON line on close** → drop silently.
- **Stream idle** → inherited 90-second `BaseCliAdapter` watchdog.

### Lifecycle

Exec-per-message (identical to Copilot/Gemini):

- `spawn()` — validates CLI is available via `checkStatus()`, sets `isSpawned = true`, emits synthetic PID + `status: 'idle'`.
- `sendInput(message)` — spawns a fresh `cursor-agent -p` child via `sendMessage()` internal helper; emits streaming `OutputMessage` events during the turn; resolves when the child exits.
- `terminate(graceful)` — kills any in-flight child (via base class process-group kill), clears `isSpawned` + `cursorSessionId` + any reasoning buffers.

### Capabilities

```ts
getCapabilities(): CliCapabilities {
  return {
    streaming: true,
    toolUse: true,
    fileAccess: true,
    shellExecution: true,
    multiTurn: true,            // via --resume
    vision: false,              // Cursor supports images via @filepath but orchestrator attachment path is not wired (see §10)
    codeExecution: true,
    contextWindow: 200_000,     // Conservative default; varies by underlying model
    outputFormats: ['text', 'json', 'stream-json'],
  };
}

getRuntimeCapabilities(): AdapterRuntimeCapabilities {
  return {
    supportsResume: true,
    supportsForkSession: false,
    supportsNativeCompaction: false,
    supportsPermissionPrompts: false,  // we run with --force; orchestrator mediates
    supportsDeferPermission: false,
  };
}
```

---

## 5. Provider & Model Configuration

### Why this section is light on hardcoded model IDs

Cursor rotates its first-class model list frequently; the official docs expose "Auto", "Max Mode", and a set of named models that change across releases. An older draft of this spec hardcoded `claude-opus-4-6`, `gpt-5.4`, `grok-4`, etc. — but those IDs are neither guaranteed by the docs nor stable across CLI versions. Copilot's existing implementation has the same problem and mitigates it by dynamically fetching models from the CLI at runtime (`copilot-cli-provider.ts:59` — _"Copilot dynamically fetches available models from the CLI at runtime; don't pin a default."_).

**Design decision:** Cursor follows Copilot's pattern — **live-fetch first, minimal static fallback**.

### `CURSOR_MODELS` constant (in `provider.types.ts`)

A minimal, safe set of identifiers. The adapter and provider layers do not hard-fail on an unknown model string — `cliConfig.model` is passed through to `--model` verbatim unless it matches the `'auto'` sentinel.

```ts
/**
 * Cursor model identifiers.
 *
 * Cursor rotates its first-class model list frequently. The adapter treats
 * `cliConfig.model` as opaque — this constant is only a minimal set of
 * well-known aliases for UI tiering and pricing fallback. The real list is
 * fetched dynamically via `cursor-agent models` (or equivalent) at runtime.
 */
export const CURSOR_MODELS = {
  /** Sentinel: omit --model flag entirely so the CLI picks from subscription. */
  AUTO: 'auto',
} as const;
```

### `DEFAULT_MODELS['cursor']`

The `DEFAULT_MODELS` record is typed `Record<ProviderType, string>` with all concrete strings. Set to `CURSOR_MODELS.AUTO` so the default selection surfaces "Auto" in the UI and the adapter omits `--model` for actual invocation (see §4 normalization rule). This matches how `defaultCli: 'auto'` is a valid sentinel elsewhere in the codebase.

**Not** equivalent to Copilot's `DEFAULT_COPILOT_CONFIG` which omits `defaultModel` entirely — that strictly Copilot-shaped config relies on the renderer to discover the list at runtime. Cursor could follow that approach (omit from `DEFAULT_MODELS` and flex the type), but changing the `Record<ProviderType, string>` type to allow omissions is out of scope. `'auto'` sentinel is the smaller, local change.

### `PROVIDER_MODEL_LIST['cursor']`

Static fallback only — populated until a live `cursor-agent models` fetch succeeds, after which the dynamic list (per-model + "Auto" + "Max Mode") replaces it in the UI. Contents intentionally small and safe:

```ts
cursor: [
  { id: CURSOR_MODELS.AUTO, name: 'Auto (let Cursor pick)', tier: 'balanced' },
  // NO hardcoded per-model entries. Dynamic list populates UI after first
  // successful `cursor-agent --help`/`cursor-agent models` probe.
],
```

**Live-fetch hook** — documented in §10 as a follow-up (non-blocking): on successful `checkStatus()`, parse `cursor-agent --help` output (or shell out to `cursor-agent models` if the subcommand exists on the installed version) and merge discovered models into the renderer's model list. Until this is wired, UI shows only "Auto" and users type a concrete model ID via the manual-override text field.

### Auto / Max Mode handling

- **Auto** → `CURSOR_MODELS.AUTO` sentinel; adapter omits `--model` flag (per §4).
- **Max Mode** → intentionally *not* exposed in this change. Max Mode is Cursor's frontier-tier offering that changes underlying routing; adding it would require additional config (a boolean flag on `ProviderConfig` or a special model-ID sentinel `cursor:max`). Flagged as future work in §10.
- **Named models** → passed through to `--model <value>` as-is; orchestrator does not validate against an allowlist.

### `CLI_TO_PROVIDER_TYPE`

Add `cursor: 'cursor'`.

### `MODEL_PRICING`

No new entries keyed on Cursor model names. The provider's `updateUsageFromContext()` uses these rules in priority order:

1. If `cliConfig.model` matches a known entry in `MODEL_PRICING` (e.g. user picked a Claude/GPT/Gemini model routed via Cursor), use that entry's rates.
2. Otherwise, fall back to Sonnet-class rates (`input: 3.0, output: 15.0`) and mark `ProviderUsage.estimatedCost` as directional in the UI.

**Pricing rationale correction:** Cursor bills through a subscription, but per Cursor's pricing docs (`docs.cursor.com/account/pricing`), agent usage is metered at the underlying model's inference API rates and drawn from the subscription's included credit. So per-token cost estimation is meaningful — it's the best approximation we have for what a given turn "cost" against the subscription quota. It is *not* literal cash billed per turn, which is why we surface it as directional in the UI and in-code comments.

### `ProviderAdapterCapabilities` (registry descriptor)

```ts
const CURSOR_CAPABILITIES: ProviderAdapterCapabilities = {
  interruption: true,          // SIGINT via base adapter
  permissionPrompts: false,    // CLI runs --force + --sandbox disabled (see §4 rationale)
  sessionResume: true,         // --resume
  streamingOutput: true,       // stream-json [+ --stream-partial-output when supported]
  usageReporting: true,        // result.duration_ms; token counts directional
  subAgents: false,
};
```

### Default provider config

```ts
export const DEFAULT_CURSOR_CONFIG: ProviderConfig = {
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: false,
  defaultModel: CURSOR_MODELS.AUTO,
  // User can override via settings; dynamic model list populates at runtime.
};
```

### Settings UI additions

`settings.types.ts`:

- `defaultCli` select options: add `{ value: 'cursor', label: 'Cursor CLI' }`.
- `crossModelReviewProviders` multi-select options: add `{ value: 'cursor', label: 'Cursor CLI' }`.

---

## 6. Error Handling

Spawn errors (`ENOENT`) reject with a helpful install hint pointing to `https://cursor.com/cli`.

**Unknown-flag fallback.** If the first invocation exits non-zero and stderr mentions `--stream-partial-output` (e.g. `unknown flag --stream-partial-output`), the adapter clears the partial-output feature flag, retries once without it, and caches the result so subsequent turns skip the flag. This handles older `cursor-agent` versions where the flag is not yet shipped (see §2 caveat).

**Authentication errors — two flavors:**
1. `{type:"result", is_error:true, result:"authentication failed..."}` — terminal event the normal result handler catches.
2. **macOS keychain stderr** — `ERROR: SecItemCopyMatching failed -50` or similar keychain errors emitted on stderr before any stream-json event is produced. The adapter matches `/SecItemCopyMatching|keychain|login item/i` on stderr and emits a distinguished `error` `OutputMessage` with a remediation hint: "Cursor CLI couldn't read its credentials from Keychain. Try re-running `cursor-agent login`, grant Keychain access when prompted, or set `CURSOR_API_KEY` in your environment."

Both paths emit:
- An `error` `OutputMessage` (visible in UI + captured by child-summary fallback).
- An EventEmitter `'error'` event (triggers provider `pushError`).

**Tool failures** from `{type:"tool_call", subtype:"completed"}` with an error on the inner tool-key object (see §4 extraction rule) emit both a `tool_result` message and an `error` message, so child-exit summaries never come back as "child exited without producing any output."

**Resume-specific failures.** When the terminal event is `is_error: true` and the message or stderr matches resume-failure patterns (`/invalid session id|session not found|session expired/i`), the adapter clears `this.cursorSessionId`, emits a user-visible `error` noting "Previous session expired; starting fresh," and retries the turn **once** without `--resume`. If the retry also fails, reject normally. Prevents an expired session from bricking the instance.

**Stream-idle watchdog** (90 s of stdout silence) is inherited from `BaseCliAdapter` with no customization — emits `stream:idle` diagnostics event.

**Non-zero exit codes** reject with `"Cursor exited with code N"` (after the retry logic above has had a chance to recover).

**Partial trailing JSON lines** at process close are discarded silently (matches Copilot's defensive handling).

---

## 7. Testing Strategy

### Adapter tests (`cursor-cli-adapter.spec.ts`)

1. `buildArgs()` — required flags present: `-p`, `--output-format stream-json`, `--force`, `--sandbox disabled`. `--stream-partial-output` present when the feature-flag is set; absent after unknown-flag fallback.
2. `buildArgs()` — `--model <x>` present when configured to a concrete value; **absent when `cliConfig.model` is unset, equals `'auto'`, or equals `'AUTO'`** (case-insensitive).
3. `buildArgs()` — `--resume <session_id>` present iff a prior `result` captured one.
4. `buildArgs()` — system prompt prepended to user message when configured (with blank-line separator).
5. Assistant delta events accumulate into streaming `output` emissions with stable per-turn `messageId`.
6. **Dedupe — final ⊆ streaming:** partial deltas stream "Hello wo" then "rld"; final assistant message arrives as "Hello world" — adapter emits a terminal flush only, no duplicate text. `accumulatedContent` length equals 11.
7. **Dedupe — final extends streaming:** partial deltas stream "Hello"; final assistant message arrives as "Hello world" — adapter emits the suffix " world" delta then flush. `accumulatedContent` length equals 11.
8. `tool_call.started` with `{readToolCall: {...}}` → `tool_use` `OutputMessage` with `toolName: 'read'` + call_id metadata.
9. `tool_call.started` with `{bashToolCall: {...}}` → `toolName: 'bash'`.
10. `tool_call.started` with unexpected shape → `toolName: 'unknown_tool'`; no crash.
11. `tool_call.completed` with inner error payload → both `tool_result` and `error` `OutputMessage` emitted.
12. `result` event (success) → captures `session_id`, emits `context` with directional usage, emits `complete`.
13. `result` event (`is_error: true`) → emits `error` `OutputMessage` and rejects.
14. `result` event with `/invalid session id/i` text → clears `cursorSessionId`, retries once without `--resume`; retry success resolves the turn.
15. `result` event with `/session expired/i`, retry also fails → rejects with last error.
16. `checkStatus()` happy path: returns `available: true` with version parsed.
17. `checkStatus()` timeout path: resolves `available: false` with timeout error.
18. `sendMessage()` spawn `ENOENT` → rejects with install-hint message.
19. Multi-turn: first `sendMessage()` captures `session_id`; second `sendMessage()` args include `--resume`.
20. `terminate()` clears state including `cursorSessionId` and `isSpawned`.
21. Stderr matching `/error|fatal|failed/i` → `error` `OutputMessage` emitted.
22. Stderr matching `/SecItemCopyMatching|keychain|login item/i` → `error` `OutputMessage` with keychain-specific remediation text.
23. First spawn exits non-zero with stderr mentioning `--stream-partial-output` → second invocation omits the flag; `checkStatus()` result cached so third invocation also omits it.

### Provider tests (`cursor-cli-provider.spec.ts`)

1. `initialize()` instantiates adapter with mapped config and wires all event handlers.
2. Forwards adapter `output` / `status` / `context` / `error` / `exit` / `spawned` events to `events$` via `pushOutput` / `pushStatus` / etc.
3. `sendMessage()` delegates to adapter `sendInput()`.
4. `updateUsageFromContext()` applies 70/30 input-output split; looks up model-specific pricing for the selected underlying model; falls back to Sonnet pricing when unknown.
5. `checkStatus()` returns `available: false` cleanly when the CLI is missing.
6. `terminate()` cleans up adapter, nulls reference, clears `isActive`.

### Registration tests (`register-built-in-providers.spec.ts`)

- Add `'cursor'` to the list of expected registered descriptors.

### Parity tests (`provider-parity.spec.ts`)

- New provider satisfies the structural shape asserted for the other four.

### Mocking

Reuse the `spawn`-mocking pattern from `copilot-cli-adapter.spec.ts` — a fake `ChildProcess` with controllable stdout/stderr streams and exit code.

---

## 8. Packaging & Environment

### `env-filter.ts` update

Add `CURSOR_API_KEY` to the allowlist so it reaches the spawned Cursor child. Pattern to match during implementation:

- Look for how `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, or similar provider-specific keys are handled today in `getSafeEnvForTrustedProcess()`.
- If existing provider keys are stripped unconditionally (with each adapter re-injecting their own), replicate that pattern.
- If there's a named-allowlist, add `CURSOR_API_KEY` to it.

### No path-alias changes

No new `@contracts/schemas/...` or `@contracts/types/...` subpaths are introduced — we're only modifying existing files under `packages/contracts/src/{schemas,types}/`. No updates to:

- `tsconfig.json` path aliases
- `tsconfig.electron.json` path aliases
- `src/main/register-aliases.ts` runtime resolver
- `vitest.config.ts`

### No Electron bump

No native-module ABI concerns.

---

## 9. Verification

Run after every significant change:

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm test -- cursor
```

Run post-full-implementation:

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm test
```

Final integration audit (manual, per AGENTS.md "Implementation Requirements"):

- [ ] New descriptor is registered in `register-built-in-providers.ts`.
- [ ] New CLI appears in `cli-detection` registry.
- [ ] New adapter is returned from `adapter-factory.createCliAdapter` for `cliType === 'cursor'`.
- [ ] Provider selector dropdown shows "Cursor CLI" when available.
- [ ] Settings "Default CLI" dropdown includes Cursor.
- [ ] Cross-model review settings include Cursor.
- [ ] `CURSOR_API_KEY` is propagated to spawned child processes (verified by running with `CURSOR_API_KEY=sk-test... && DEBUG=1`).
- [ ] Instances created with `provider: 'cursor'` successfully spawn and stream output.
- [ ] Multi-turn conversations resume via `--resume` correctly (verified by second-message flow).

---

## 10. Known Limitations & Future Work

Documented in-code on the adapter class:

- **Attachments (images):** Cursor supports them via `@filepath` in the prompt. Adapter throws if `attachments` is passed, matching Copilot/Gemini. Could be wired as a follow-up by inlining `@` references in the prompt text.
- **Cloud/Background agents:** `-c` / `--cloud` not exposed — orchestrator runs locally.
- **Plan/Ask modes:** `--mode plan|ask` not exposed — the orchestrator's agent-mode layer handles planning/review at a different architectural level.
- **Max Mode:** Cursor's frontier-tier routing option is not exposed in this change. Would need a boolean flag on `ProviderConfig` or a `cursor:max` sentinel. Tracked as future work.
- **Dynamic model discovery not wired yet:** The spec plans for live-fetch (§5) but this change ships with a minimal static fallback containing only the `'auto'` sentinel. Populating `PROVIDER_MODEL_LIST['cursor']` from a live `cursor-agent --help` / `cursor-agent models` probe is deferred to a follow-up.
- **Native reasoning events:** Cursor doesn't emit them yet. Inline `<thinking>` text extraction via the shared helper covers today's reasoning-capable models.
- **Shared `BaseSessionResumeAdapter` refactor:** Cursor, Copilot, and Gemini all share similar exec-per-message / session-resume patterns. Extracting an abstract base class would reduce duplication — but is a separate refactor and not part of this change.
- **Cost precision:** Cursor bills via subscription, and agent usage is metered at underlying-model inference rates. The UI "estimated cost" is directional — a best-approximation of the subscription-quota draw rather than literal per-turn cash.
- **`ProviderType` taxonomy is split across multiple files** (see §3 note). Full unification into a single source of truth is valuable but out of scope for this change. Notably, `packages/sdk/src/providers.ts:18` already lacks a `'copilot'` literal (pre-existing inconsistency); we do not add `'cursor'` to that specific union either — if/when the unions are reconciled, both should land together.
- **`--stream-partial-output` version drift:** If Cursor adds or removes the flag across releases, the adapter's feature-detect fallback (§6) handles it gracefully. No action needed unless the detection pattern itself breaks.

---

## 11. Implementation Order (high-level)

To be expanded into a full implementation plan by the `writing-plans` skill. Can ship as a single PR or as a 3-PR sequence — the review preferred a split, noted here as an alternative framing.

### Single-plan phase breakdown

1. **Contract updates** — add `'cursor'` to `ProviderName` type + schema, `InstanceCreatePayloadSchema`, `InstanceCreateWithMessagePayloadSchema`, `SpawnChildPayloadSchema`; typecheck.
2. **Provider/CLI type updates** — `ProviderType` (in `provider.types.ts`), `CanonicalCliType`, `InstanceProvider` (in `instance.types.ts` + `id-generator.ts`), `CURSOR_MODELS`, `DEFAULT_MODELS`, `PROVIDER_MODEL_LIST`, `CLI_TO_PROVIDER_TYPE`, renderer `ProviderType` unions (in `provider-state.service.ts` + `provider-selector.component.ts`); typecheck.
3. **Orchestration unions** — `SpawnChildCommand.provider`, `ConsensusProviderSpec.provider`; typecheck.
4. **CLI detection registry** — add `cursor` entry to `CLI_REGISTRY` + `SUPPORTED_CLIS`; typecheck.
5. **Adapter** — `cursor-cli-adapter.ts` full implementation (including `--stream-partial-output` feature detect, dedupe rule, resume-retry fallback, keychain error mapping); write adapter unit tests alongside.
6. **Provider** — `cursor-cli-provider.ts` full implementation; write provider unit tests alongside.
7. **Adapter factory** — `createCursorAdapter`, switch wiring, display name.
8. **Provider registration** — `register-built-in-providers.ts` + `provider-instance-manager.ts` `DEFAULT_PROVIDER_CONFIGS` entry.
9. **Main-process wiring** — `instance-manager.ts:resolveProviderName()`, `session-handlers.ts:getProviderDisplayName()`, `hot-model-switcher.ts:getProviderType()`, `capability-reporter.ts` substring match.
10. **Env filter** — allowlist `CURSOR_API_KEY`.
11. **Settings UI** — `defaultCli` and `crossModelReviewProviders` option lists.
12. **Renderer touch-ups** — walk through all UI files that enumerate providers; add Cursor case to each.
13. **Parity + registration specs** — update fixtures.
14. **Full verification** — `tsc`, `lint`, `test`; manual smoke test in dev mode.

### Alternative: 3-PR split

Reviewer suggestion for smaller-diff review cycles:

- **PR 1 (foundations):** steps 1–4 + 7 + 10 + 13 (types, contracts, detection, factory, env, parity specs). No user-visible behavior change — "Cursor" appears as a non-functional provider target; tsc/lint/tests pass with the enum expansion.
- **PR 2 (runtime):** steps 5–6 + 8–9 (adapter + provider + registration + main-process wiring + adapter/provider unit tests). End-to-end Cursor instance creation works from the main process; renderer selector may still show the provider as missing.
- **PR 3 (surface):** steps 11–12 + 14 (settings UI + all renderer touch-ups + integration verification). Full user-visible feature.

Writing-plans skill to pick one framing based on reviewer feedback when the plan is drafted.
