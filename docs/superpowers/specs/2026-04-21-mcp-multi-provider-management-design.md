# MCP Multi-Provider Management — Design

**Date:** 2026-04-21
**Status:** Draft, pending user review
**Owner:** James (shutupandshave)

## 1. Overview

AI Orchestrator already ships a partial MCP subsystem: `McpManager` (**in-memory only — no persistence today**, verified at `src/main/mcp/mcp-manager.ts:93–165`), a dedicated `/mcp` page, 15 IPC handlers, 7 built-in presets, and the existing lifecycle model (`transport → initialize → discover → ready`). That page manages MCPs **that Orchestrator itself connects to as a client** — a registry entirely separate from the MCPs configured for the CLIs Orchestrator spawns.

The current page is effectively empty for most users because its registry is a different thing from "the MCPs my Claude Code session sees." Users open `/mcp` expecting the latter and find the former. Worse, anything a user adds via the page today is lost on app restart.

**There are four distinct surfaces through which MCP servers enter the system today. This design makes all of them visible and, where appropriate, editable:**

| Surface | What it is today | v1 treatment |
|---|---|---|
| Orchestrator client registry | `McpManager` in-memory store; current `/mcp` page's subject. | Gains DB persistence (small additive migration); UI preserved in Orchestrator tab. |
| Orchestrator bootstrap | `config/mcp-servers.json` (ships with app; contains a bundled `lsp` entry today). Merged via `--mcp-config` into **Claude-only** spawns. | Surfaced read-only inside the Orchestrator tab. Hand-edit + restart to change. |
| Orchestrator codemem bridge | Dynamically built JSON via `buildCodememMcpConfig()`; injected via `--mcp-config` into **Claude-only** spawns when `settings.codememEnabled` (`src/main/instance/instance-lifecycle.ts:308–324`). | Surfaced read-only inside the Orchestrator tab with a toggle bound to the existing setting. |
| Provider user configs | `~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, `~/.copilot/mcp-config.json` — read natively by each CLI at startup. Orchestrator never touches them today. | **New** — per-provider tabs read/write user scope; project/local/workspace/managed scopes surfaced read-only; Shared tab fans out to multiple providers. |

Three load-bearing facts the design must accommodate (verified against the current code):

1. **`--mcp-config` injection is Claude-only.** `src/main/cli/adapters/claude-cli-adapter.ts:755–756` is the sole adapter that adds the flag. Gemini/Codex/Copilot adapters add no equivalent — which is correct; they read their user configs natively. For Claude specifically, Phase 0's manual verification step must confirm whether `--mcp-config <path>` **merges with** or **replaces** `~/.claude.json` entries in the installed Claude CLI version. The design assumes merge semantics (that is the documented behavior at the time of writing); the plan includes a single Claude-spawn observation test to lock that assumption in before any UI claims are made. If the observed behavior is replace-not-merge, the Shared tab's Claude fan-out guidance changes (users would need to include bootstrap + codemem entries in their fan-out, or the adapter would start passing user-config-through on the `--mcp-config` path).
2. **Remote workers explicitly receive `mcpConfig: []`** (`instance-lifecycle.ts:289–295` — "MCP config paths are local filesystem paths. Remote workers have their own MCP config on their filesystem"). Local fan-out **does not affect remote workers**. v1 treats this as a documented limitation with a UI disclaimer; v2 can build on the existing `SyncHandler` / `FileTransferService` to push shared records out to remote workers.
3. **Codex exec-mode strips `[mcp_servers.*]` by design.** `src/main/cli/adapters/codex-cli-adapter.ts:2882–2936` (`prepareCleanCodexHome`) creates a symlink-farm `CODEX_HOME` with all `[mcp_servers.*]` TOML sections removed whenever Codex is running in **exec mode**. The adapter's own comments explain why (Codex CLI loads MCP tool descriptions into the system prompt at ≈87K tokens + 60–90s per server — unacceptable). Exec mode is the fallback when `codex app-server` isn't available (`codex-cli-adapter.ts:471–504`). Therefore: **Codex fan-out is visible to app-server-mode sessions; it is invisible to exec-mode sessions by Orchestrator's own choice.** The UI surfaces Codex's active mode so the user knows which applies. This is not fixable at the fan-out layer without reverting the stripping; revert is out of scope.

**What this design adds:** CLI-level MCP management (per-provider tabs), a Shared fan-out layer, DB persistence for the Orchestrator client registry, surfaced visibility into the bootstrap file + codemem bridge, and health-check via ephemeral spawn. The existing Orchestrator client-side behavior is preserved inside a reorganized Orchestrator tab with zero functional regressions.

## 2. Scope Decisions

Captured from brainstorming:

- **Unified + Shared (option C).** One UI covers Orchestrator's own MCPs and each CLI's MCPs, plus a "Shared" layer that fans out one MCP config into multiple provider configs in one click.
- **Config + health check (scope 2).** View, add, remove, edit MCPs per scope. Orchestrator can ephemerally launch any `stdio`- or `sse`-transport config to verify it starts and report its capabilities (`McpManager` today throws for anything else — `mcp-manager.ts:183–189`). `http`-transport configs are **not** health-checkable in v1; the Test button is disabled for them and the handler returns `{ ok: false; error: 'HTTP_TRANSPORT_NOT_SUPPORTED'; transportSupported: false }` without spawning. HTTP health-check is a deferred follow-up (see §17). **No** tool-invocation UI on CLI-scoped servers (the existing orchestrator-local tool/resource/prompt UI stays for orchestrator-scoped servers only).
- **User-level writes only (project 1).** User-scope configs are editable. Project, local, workspace, and managed scopes are surfaced **read-only**. Users edit those scopes by hand.

Additional scope commitments (post-reviewer-round-3):

- **Orchestrator client registry gains DB persistence in v1.** The existing `McpManager` is in-memory-only today; any user addition via the current page is lost on restart. The management UX we're building is unusable if that stays. A new `orchestrator_mcp_servers` table becomes the source of truth; `McpManager` loads from it at startup and writes through on mutations.
- **Remote workers are local-only in v1 with a UI disclaimer.** Shared fan-out writes to the machine running Orchestrator. Remote workers read MCP configs from their own filesystem. Both Shared tab and provider tabs show a disclaimer ("This affects this machine only — N remote worker(s) detected") when at least one remote worker is registered. v2 concern: sync via existing `SyncHandler`.
- **`config/mcp-servers.json` and the codemem bridge are read-only in v1.** Exposed for visibility inside the Orchestrator tab. `config/mcp-servers.json` changes require hand-edit + restart (the file's location differs packaged-vs-dev; writing would modify app resources). The codemem bridge has one degree of user control — the `settings.codememEnabled` flag — which the UI surfaces via a toggle bound to the existing settings channel.

Design pattern: **Approach B — unified page, split managers.**

- `McpManager` (existing, extended): owns orchestrator-local persistent MCPs, now persisted via `orchestrator_mcp_servers`; still owns all ephemeral health-check spawns.
- `CliMcpConfigService` (new): pure file I/O for the four CLI config files. Never spawns anything.
- `OrchestratorInjectionReader` (new, tiny): reads `config/mcp-servers.json` and builds the codemem bridge spec for display. No write surface.
- `SharedMcpRegistry` (new): DB-backed shared-MCP fan-out, with safeStorage.

UI is single-page, internally dispatches by tab.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (Angular)                                           │
│                                                              │
│  McpPageComponent (host, top-tab router)                     │
│    ├── OrchestratorMcpTabComponent  (restructured)           │
│    │     ├── ClientRegistrySection  (existing UI + persist.) │
│    │     ├── BootstrapFileSection   (read-only view)         │
│    │     └── CodememBridgeSection   (read + toggle)          │
│    ├── SharedMcpTabComponent         (new)                   │
│    ├── ProviderMcpTabComponent × 4   (claude/codex/gem/copi) │
│                                                              │
│  Services (signal-backed, same pattern as existing):         │
│    McpIpcService         (existing — orchestrator scope)     │
│    CliMcpIpcService      (new)                               │
│    SharedMcpIpcService   (new)                               │
│    OrchInjectionIpcService (new — bootstrap + codemem view)  │
└──────────────────────────────────────────────────────────────┘
                              │ IPC (generated channels)
┌──────────────────────────────────────────────────────────────┐
│ Main (Electron/Node)                                         │
│                                                              │
│  IPC handlers                                                │
│    mcp-handlers.ts           (existing + persistence calls)  │
│    mcp-cli-handlers.ts       (new)                           │
│    mcp-shared-handlers.ts    (new)                           │
│    mcp-injection-handlers.ts (new — bootstrap + codemem)     │
│                                                              │
│  Services                                                    │
│    McpManager                (existing — now persistence-    │
│                               backed for client registry)    │
│    CliMcpConfigService       (new — reads/writes CLI files)  │
│      ├── ClaudeCodeAdapter                                   │
│      ├── CodexAdapter                                        │
│      ├── GeminiAdapter                                       │
│      └── CopilotAdapter                                      │
│    SharedMcpRegistry         (new — DB + safeStorage)        │
│    SecretClassifier          (new — shared utility)          │
│    SecretsCapability         (new — safeStorage detection)   │
│    OrchestratorInjectionReader (new — reads bootstrap file,  │
│                                 builds codemem spec for view)│
│                                                              │
│  Persistence                                                 │
│    better-sqlite3                                            │
│      ├── orchestrator_mcp_servers (NEW — client registry)    │
│      └── shared_mcp_servers        (NEW — shared registry)   │
│    Electron safeStorage (OS keychain)                        │
└──────────────────────────────────────────────────────────────┘
                              │ file I/O
┌──────────────────────────────────────────────────────────────┐
│ Disk                                                         │
│    <app>/config/mcp-servers.json        (read-only bootstrap)│
│    ~/.claude.json, .mcp.json, (managed) managed-mcp.json     │
│    ~/.codex/config.toml, .codex/config.toml, /etc/codex/…    │
│    ~/.gemini/settings.json, .gemini/settings.json, /etc/…    │
│    ~/.copilot/mcp-config.json                                │
└──────────────────────────────────────────────────────────────┘
                              │ (separate, untouched)
┌──────────────────────────────────────────────────────────────┐
│ Remote workers (out-of-scope for v1 writes)                  │
│    Workers receive mcpConfig: [] at spawn. They read their   │
│    own ~/.claude.json etc. from their own filesystems.       │
│    v1 surfaces a UI disclaimer when workers are registered.  │
└──────────────────────────────────────────────────────────────┘
```

Invariants:

1. `McpManager` is the only component that spawns processes. `CliMcpConfigService` is pure file I/O. `OrchestratorInjectionReader` is read-only.
2. Renderer-bound DTOs are `*Redacted` variants. Secret plaintext crosses IPC only as ephemeral one-shot payloads on user-initiated writes or tests — it is consumed immediately in the main process (spawn, write-to-provider-file, or safeStorage-encrypt), then the local reference is dropped. Plaintext is never logged, never persisted in a long-lived in-memory structure, and never written to disk unencrypted in an Orchestrator-owned store. Electron in-process IPC is the only wire; we do not treat it as a hostile boundary.
3. Every on-disk write of a provider config uses a best-effort atomic pattern (`write-temp + rename` on POSIX; `write-temp + fs.copyFile + unlink` fallback on Windows when `fs.rename` fails — see §6.2.3), preserves non-MCP sections verbatim, preserves file mode from the source (fallback 0o600 on POSIX if creating new), and is preceded by a first-write-per-session `.orch-bak` copy next to the source file (matching source file mode).
4. `providerRaw` preservation is invariant — no round-trip through Orchestrator may lose a field the adapter didn't explicitly own.
5. No write to any provider config happens until the user takes an explicit UI action. No background reconciliation.
6. Orchestrator-injection surfaces (bootstrap, codemem) are visibility-only in v1. The app never mutates `config/mcp-servers.json`.

## 4. Data Model

### 4.1 Scope union

```ts
export type McpScope =
  // Orchestrator's own scopes
  | 'orchestrator'              // client registry (was in-memory; now DB-backed)
  | 'orchestrator-bootstrap'    // config/mcp-servers.json (read-only)
  | 'orchestrator-codemem'      // dynamic codemem bridge (read-only, toggle-controlled)
  // v1 writable provider scopes
  | 'claude-code-user'
  | 'codex-user'
  | 'gemini-user'
  | 'copilot-user'
  // v1 read-only: project / local / workspace (lower precedence than user)
  | 'claude-code-project'     // .mcp.json at repo root
  | 'claude-code-local'       // ~/.claude.json, nested under project-path key
  | 'codex-project'           // .codex/config.toml, walked root→cwd, trust-gated
  | 'gemini-workspace'        // .gemini/settings.json in repo
  // v1 read-only: managed / system (higher precedence than user)
  | 'claude-code-managed'     // managed-settings.json + managed-mcp.json
  | 'codex-managed'           // /etc/codex/managed_config.toml + MDM plist
  | 'gemini-system'           // /etc/gemini-cli/settings.json + system-defaults.json
  // (no copilot-managed: GitHub's admin policy is server-enforced, no local file)
  | 'shared';

export type McpWritableProviderScope =
  | 'claude-code-user' | 'codex-user' | 'gemini-user' | 'copilot-user';

export type McpProviderScope =
  | McpWritableProviderScope
  | 'claude-code-project' | 'claude-code-local'
  | 'codex-project'
  | 'gemini-workspace'
  | 'claude-code-managed' | 'codex-managed' | 'gemini-system';

export type McpOrchestratorScope =
  | 'orchestrator' | 'orchestrator-bootstrap' | 'orchestrator-codemem';
```

### 4.2 Extensions to `McpServerConfig`

All additions are optional — existing orchestrator records get sensible defaults on read.

```ts
export interface McpServerConfig {
  // ... existing fields unchanged (id, name, description, transport,
  //     command, args, env, url, headers, auth, autoConnect,
  //     capabilities, status, error, lifecycle) ...

  scope?: McpScope;                         // defaults to 'orchestrator' on first read
  enabled?: boolean;                        // defaults true; maps to native enable/disable
  installedTo?: McpWritableProviderScope[]; // only set for scope === 'shared'

  providerRaw?: {
    providerScope: McpProviderScope;        // which provider emitted this
    raw: unknown;                           // untouched source record (TOML table / JSON object)
    knownFields: string[];                  // fields owned by our generic model
    preservedFields: string[];              // everything else — must survive round-trip
  };
}
```

### 4.3 Redacted DTO for IPC

The renderer only ever sees redacted shapes. No plaintext secret crosses the wire.

```ts
export interface McpServerConfigRedacted extends Omit<
  McpServerConfig,
  'env' | 'headers' | 'auth' | 'url' | 'args' | 'providerRaw'
> {
  env?: Record<string, { present: true; envRef?: string; hint?: string }>;
  headers?: Record<string, { present: true; hint?: string }>;
  auth?: {
    type: McpAuthConfig['type'];
    present: Partial<Record<keyof McpAuthConfig, true>>;
  };
  url?: string;                       // with userinfo + matched query params redacted
  args?: string[];                    // with matched arg values redacted to `•••`
  urlUserinfoRedacted?: boolean;
  argSecretsRedacted?: boolean;
  providerRaw?: {
    providerScope: McpProviderScope;
    // raw object/table pruned of secret-classified keys at any depth
    redactedRaw: unknown;
    knownFields: string[];
    preservedFields: string[];
  };
  secretsUnrecoverable?: boolean;     // surfaced when safeStorage decrypt failed
}
```

Writes from the renderer carry new secret values as one-shot payloads; main encrypts and drops the plaintext immediately.

### 4.4 Shared MCP record (DB)

```sql
CREATE TABLE shared_mcp_servers (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  config_public_json          TEXT NOT NULL,      -- generic fields, scrubbed of secrets
  config_secret_ciphertext    BLOB,               -- NULL when no secrets OR safeStorage unavailable
  installed_to_json           TEXT NOT NULL,      -- ["claude-code-user", ...]
  enabled                     INTEGER NOT NULL DEFAULT 1,
  secrets_unrecoverable       INTEGER NOT NULL DEFAULT 0,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_shared_mcp_servers_name ON shared_mcp_servers(name);
```

`config_public_json` stores generic fields + secret-field **keys** (so UI knows what's present) but never secret values. `config_secret_ciphertext` is the safeStorage-encrypted map of secret key → value.

### 4.5 Orchestrator client registry (DB)

New v1 table backing the formerly-in-memory `McpManager`. Straightforward, no secret handling on this table (Orchestrator-scope servers do not currently support safeStorage in the existing code; that's a separable v2 story that does not block this feature).

```sql
CREATE TABLE orchestrator_mcp_servers (
  id                          TEXT PRIMARY KEY,
  name                        TEXT NOT NULL,
  config_json                 TEXT NOT NULL,   -- full McpServerConfig
  enabled                     INTEGER NOT NULL DEFAULT 1,
  auto_connect                INTEGER NOT NULL DEFAULT 0,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_orchestrator_mcp_servers_name ON orchestrator_mcp_servers(name);
```

`McpManager` gains two new entry points: `loadFromStore()` (called at startup) and `writeThrough(server)` / `removeFromStore(name)` called inside `addServer` / `removeServer`. The existing in-memory Maps are kept verbatim as the hot cache — this is a persistence layer, not a rewrite. v1 NOTE: the config blob stores env as plaintext (as it does today in-memory); any future move to safeStorage for Orchestrator-scope env happens in a separate change.

### 4.6 Read-result DTOs for IPC

Returned by adapter reads and surfaced by `MCP_CLI_LIST_ALL`. Shape mirrors `McpProviderAdapter` (§6).

```ts
export interface ProjectReadResult {
  scope: McpScope;                              // e.g., 'claude-code-project' | 'claude-code-local' | 'codex-project' | 'gemini-workspace'
  sourcePath: string;                           // absolute path to the file this was read from
  servers: McpServerConfigRedacted[];           // each tagged with scope above
  warnings: string[];                           // e.g., 'malformed JSON at line N', 'untrusted project — skipped'
}

export interface ManagedReadResult {
  scope: McpScope;                              // 'claude-code-managed' | 'codex-managed' | 'gemini-system'
  sourcePath: string;
  servers: McpServerConfigRedacted[];
  note?: string;                                // e.g., 'pushed by org policy (cannot be overridden)'
  warnings: string[];
}
```

Both shapes are redacted at the IPC boundary by the same logic that redacts `McpServerConfig` into `McpServerConfigRedacted` (§4.3).

### 4.7 Shared record DTO for IPC

```ts
export interface SharedMcpRecordRedacted {
  id: string;
  name: string;
  config: McpServerConfigRedacted;      // with scope='shared'
  installedTo: McpWritableProviderScope[];
  enabled: boolean;
  secretsUnrecoverable: boolean;
  createdAt: number;
  updatedAt: number;
}
```

`MCP_SHARED_LIST` returns `Array<SharedMcpRecordRedacted & { drift: Record<McpWritableProviderScope, 'in-sync' | 'drifted' | 'missing' | 'not-installed'> }>`. `not-installed` means the scope is in `installedTo` but the provider's adapter reports the target file is absent.

## 5. Verified Provider Matrix

Confirmed via direct documentation review (2026-04-21). Adapter implementations cite these in comments.

| Provider | User config (v1 writable) | Project/workspace (read) | Local (read) | Managed/system (read) | Format | Section key | Transport detection |
|---|---|---|---|---|---|---|---|
| Claude Code | `~/.claude.json` | `.mcp.json` at repo root | `~/.claude.json` nested under project-path key | macOS: `/Library/Application Support/ClaudeCode/managed-settings.json` + `managed-mcp.json`; Linux: `/etc/claude-code/...`; Windows: `HKLM\SOFTWARE\Policies\ClaudeCode` — **highest precedence, cannot be overridden** | JSON | `mcpServers` | explicit `"type"` |
| Codex CLI | `~/.codex/config.toml` | `.codex/config.toml` — walked project-root → cwd, **trusted projects only** (project root = `.git` by default) | — | `/etc/codex/managed_config.toml` + macOS MDM plist `com.openai.codex` | TOML (comment-preserving parser) | `[mcp_servers.<name>]` (snake_case) | implicit: `command` → stdio, `url` → http; SSE unverified for Codex |
| Gemini CLI | `~/.gemini/settings.json` | `.gemini/settings.json` in repo | — | `/etc/gemini-cli/settings.json` + `system-defaults.json` (plus `GEMINI_CLI_SYSTEM_SETTINGS_PATH` override) | JSON | `mcpServers` | implicit: `command`/`url`/`httpUrl` |
| Copilot CLI | `~/.copilot/mcp-config.json` (honors `XDG_CONFIG_HOME`) | — (not documented) | — | **no local managed file** — GitHub.com admin policy is server-enforced; surfaced in UI as an informational note only | JSON | `mcpServers` | explicit `"type"`: `"stdio"` / `"local"` (synonym) / `"http"` / `"sse"` (deprecated) |

Provider-specific fields the adapter must preserve verbatim via `providerRaw`:

- **Claude:** `oauth`, any future additions to the stdio/http variants
- **Codex:** `startup_timeout_sec`, `tool_timeout_sec`, `enabled`, `required`, `cwd`, `env_vars`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `enabled_tools`, `disabled_tools`, `supports_parallel_tool_calls`, `default_tools_approval_mode`, `[mcp_servers.<name>.tools.<toolname>]` per-tool override tables, `scopes`, `oauth_resource`
- **Gemini:** `timeout`, `trust`, `includeTools`, `excludeTools`, `authProviderType`, `cwd`
- **Copilot:** `tools` (per-server allowlist; accepts string or array)

### 5.1 What each spawned CLI actually sees (verified against current adapter code)

This is the practical concern behind the "does fan-out actually work?" question. Verified against the current spawn code in `src/main/cli/adapters/` and `src/main/instance/instance-lifecycle.ts`:

| CLI | Receives `--mcp-config` injection? | Reads its user config? | Therefore, a Shared-tab fan-out to user scope affects spawns? |
|---|---|---|---|
| Claude (local) | Yes — `config/mcp-servers.json` + codemem bridge when enabled (`claude-cli-adapter.ts:755–756`). Claude CLI is **assumed** to merge these with `~/.claude.json` (documented behavior at the time of writing, but **unverified by this codebase** — Phase 0 locks this in; see §1 fact #1). | Yes | **Assumed yes, pending Phase 0 observation.** Under merge semantics, Shared fan-out lands in `~/.claude.json` and is visible to Claude spawns in addition to the injected pair. If Phase 0 observes replace-not-merge, this row flips to "No (injection wins); fan-out only reaches Claude when injection isn't active" and the Shared-tab UI copy changes accordingly (see §1 fact #1 for the knock-on effects). |
| Gemini (local) | No (no `--mcp-config` in `buildArgs`) | Yes — default config path | **Yes.** Fan-out is the only source. |
| Codex (local) **app-server mode** | No | Yes — reads the real `~/.codex/config.toml` | **Yes.** Fan-out is the only source. |
| Codex (local) **exec mode** | No | No — adapter overrides `CODEX_HOME` to a symlink farm with all `[mcp_servers.*]` sections stripped (`codex-cli-adapter.ts:2882–2936`); done deliberately for startup-performance reasons (see §1 fact #3) | **No.** Fan-out writes land in `~/.codex/config.toml` but exec-mode Codex never reads them. UI surfaces which mode is active. |
| Copilot (local) | No | Yes — default config path | **Yes.** Fan-out is the only source. |
| Any CLI on a remote worker | No — `mcpConfig: []` is explicit (`instance-lifecycle.ts:293–295`) | Yes, but to the **remote machine's** filesystem | **No** — local fan-out does not reach remote workers. UI disclaimer required. |

Implications for the UI (consistent with §11.3):

- Target-provider checkboxes in the Shared tab's Add/Edit form are **enabled when the adapter's `isSupported()` returns true** (the CLI appears installed); disabled with a tooltip when not installed. They are not gated on remote-worker count (that concern is surfaced via the persistent banner) nor on Codex's exec-vs-app-server mode (fan-out still writes the file; the warning is surfaced separately so users aren't blocked from writing when they're about to switch modes).
- The Codex provider tab, the Shared tab's Codex checkbox label, and any Codex server with "(shared)" tag carry a small status pill showing `Codex: app-server` or `Codex: exec` driven by a new `MCP_CLI_GET_CODEX_MODE` channel or a derived signal from the existing Codex status metadata (`appServerAvailable` — see `codex-cli-adapter.ts:423–471`). When `exec`, the tooltip uses the exact wording defined in §11.1 for the mode pill: the explanation sentence ("Codex is running in exec mode; MCP entries in `~/.codex/config.toml` are ignored because Orchestrator strips them for startup performance. Upgrade Codex CLI for app-server mode.") followed by a `Learn more` link that opens the Codex exec-mode docs section (docs target tracked in §17). The `Learn more` label is final UI copy.
- A separate persistent banner above the Shared tab explains remote-worker coverage when any remote worker is registered.

## 6. Provider Adapter Interface

```ts
export interface McpProviderAdapter {
  readonly providerScope: McpWritableProviderScope;
  readonly displayName: string;                      // "Claude Code"

  isSupported(): Promise<boolean>;                   // gates UI when CLI isn't installed

  readUserConfig(): Promise<{
    servers: McpServerConfig[];                      // scope stamped on each
    warnings: string[];                              // file missing, malformed, etc.
  }>;

  readProjectConfig(cwd: string): Promise<Array<{
    scope: McpScope;                                 // e.g., 'claude-code-project', 'codex-project', 'claude-code-local'
    sourcePath: string;
    servers: McpServerConfig[];                      // each tagged with the scope above
  }>>;

  readManagedConfig(): Promise<Array<{
    scope: McpScope;                                 // e.g., 'claude-code-managed'
    sourcePath: string;
    servers: McpServerConfig[];
    note?: string;                                   // e.g., "pushed by org policy"
  }>>;

  writeServer(server: McpServerConfig): Promise<void>;      // upsert by name at user scope
  removeServer(name: string): Promise<void>;                // remove from user scope

  // Validation rules (per-provider, e.g., Gemini forbids '_' in names)
  validateServerName(name: string): { ok: true } | { ok: false; reason: string };
}
```

### 6.1 Per-adapter notes

**Claude Code adapter.** Reads top-level `mcpServers` from `~/.claude.json` for user scope; walks the same file's per-project-path sections to surface `claude-code-local` entries (tagged with the project path). Reads `.mcp.json` from the provided cwd for `claude-code-project`. Managed-scope read paths are OS-specific (see matrix). `settings.json` is **never** read for MCP data.

**Codex adapter.** Uses a comment-preserving TOML parser. Walks from project root (`.git` marker) down to cwd, stacking `.codex/config.toml` files for `codex-project` scope; respects trust (untrusted projects skip project layer). `bearer_token_env_var` is surfaced in the UI as "Reference by env-var name" and is preferred for tokens to avoid inlining secrets in TOML. Managed-scope reads `/etc/codex/managed_config.toml` (+ MDM plist on macOS).

**Gemini adapter.** Reads `~/.gemini/settings.json` for user; `.gemini/settings.json` at cwd for workspace; `/etc/gemini-cli/settings.json` + `system-defaults.json` (honoring `GEMINI_CLI_SYSTEM_SETTINGS_PATH`) for system. Enforces: server names may **not contain `_`** (breaks Gemini's `mcp_<server>_<tool>` parser). Transport detection is implicit from `command` / `url` / `httpUrl`.

**Copilot adapter.** Reads `~/.copilot/mcp-config.json` (or `$XDG_CONFIG_HOME/copilot/mcp-config.json`). No project or managed local scope. UI displays an informational note about server-side GitHub policy but makes no claims about its content.

### 6.2 Write safety (applies to all adapters)

1. **Preserve every non-MCP section** by parse → mutate → serialize. No regex-edit or filter-model serialization.
2. **Comment-preserving TOML** for Codex (JSON adapters parse-mutate-serialize; no comments to worry about).
3. **Best-effort atomic writes** — temp file in the same directory as the target (so it lives on the same filesystem as the rename target), written with mode matching the source file (fallback `0o600` on POSIX for new files), then `fs.rename`. Temp files created with `O_EXCL` to avoid collision. `fs.rename` on POSIX same-filesystem is atomic. On Windows, `fs.rename` may fail when the target is held by another process; the adapter falls back to `fs.copyFile(temp, target)` + `fs.unlink(temp)` (not atomic, but small window; readers see a consistent file state because `copyFile` writes fully before releasing). POSIX cross-filesystem rename (should not occur for same-directory writes) is treated as an error and surfaced to the user — we do not silently fall back.
4. **First-write-per-session backup** — copy `<file>` → `<file>.orch-bak` the first time we mutate it in a session.
   - **File mode** on the backup matches the source exactly (`fs.stat().mode & 0o777`); new backups never loosen permissions. On POSIX if source mode cannot be determined, backup is written `0o600`.
   - **Single-generation.** Overwritten on each new Orchestrator session's first write; the backup is not a rolling history.
   - **Location.** Same directory as source (same filesystem, same permission boundary).
   - **Cleanup policy.** Backups persist for the session (so a user can roll back manually); removed on clean app shutdown if the `mcpCleanupBackupsOnQuit` setting is true (default: false, conservative).
   - **Opt-out.** `mcpDisableProviderBackups = true` skips backup creation entirely for users who manage their own backup strategy.
   - **Rationale for plaintext:** the source files already contain plaintext tokens (see Section 7.3 — that is how the CLIs need them). The backup introduces no new secret exposure beyond what the source file already creates; the mitigation is mode preservation + single-generation + same-filesystem + opt-out.
5. **Directory permission check.** Before first write in a session, `fs.stat` the parent directory. If mode is world-writable (`0o002` bit set) on POSIX, refuse to write and surface a specific UI error ("Parent directory `<path>` is world-writable — refusing to write secrets. Fix with `chmod o-w <path>` and retry."). Override via `mcpAllowWorldWritableParent = true` (default: false).

These three settings (`mcpCleanupBackupsOnQuit`, `mcpDisableProviderBackups`, `mcpAllowWorldWritableParent`) are added as **flat keys** on `AppSettings` (`src/shared/types/settings.types.ts:18`), matching the existing naming convention (`codememEnabled`, `crossModelReviewEnabled`, etc.); they also get `SETTINGS_METADATA` entries so the Settings UI exposes them under an `advanced` category. No nested `settings.mcp.*` object is introduced.
6. **Process-level lock** against the corresponding CLI's instance manager so we don't race with a mid-reload CLI.

## 7. Secret Handling

### 7.1 Classifier

Secrets can appear in more places than just `env`:

| Surface | Rule |
|---|---|
| `env.*` values | All routed through safeStorage unless the key matches a public allowlist (`PATH`, `HOME`, `USER`, `LANG`, `LC_*`, `SHELL`, `TERM`) |
| `headers.*` values | Secret by default |
| `auth.apiKey`, `auth.clientSecret`, `auth.token` | Secret. `auth.type`, `auth.apiKeyHeader`, `auth.scopes`, `auth.tokenUrl`, `auth.clientId` are public. |
| `args` | Scan for `--?(token\|key\|secret\|bearer\|apikey\|password)(=\|\s+)<value>` (case-insensitive). Matched `<value>` is routed through safeStorage; the arg is rewritten to reference a stored secret slot. |
| `url` userinfo | `https://user:pass@host/…` — userinfo stripped to safeStorage, URL rewritten with the userinfo redacted |
| `url` query params | Keys matching `/token\|key\|auth\|secret\|bearer/i` have their values encrypted and redacted in the redacted DTO |
| Codex `bearer_token_env_var` | The value is the **name** of an env var (e.g., `GITHUB_TOKEN`). The name is **not** secret; its dereferenced value is — but that dereference happens in the CLI at runtime, not in our process. We treat the field itself as public metadata. |

The regex used for env-var names (`/token\|key\|secret\|password\|auth\|credential\|bearer/i`) deliberately matches Gemini's documented auto-redaction set so our classification agrees with the CLI's own behavior.

### 7.2 Encryption via Electron safeStorage — capability + quarantine model

State is always one of three:

| State | Trigger | Behavior |
|---|---|---|
| `available` | `safeStorage.isEncryptionAvailable() === true` | Secret-classified values encrypted per record into `{ key → ciphertext }`, stored in `config_secret_ciphertext`. Decryption only in main, only at write-to-provider-config or test-spawn time. |
| `unavailable` | `isEncryptionAvailable() === false` (headless Linux w/o libsecret, locked keychain at startup, etc.) | Shared-MCP creation **with secret fields** is refused in the IPC handler with a typed error (`SAFESTORAGE_UNAVAILABLE`). UI surfaces a blocking state on the Shared-tab add form explaining limits + two escape hatches: (a) provider-level env-var reference (e.g., Codex `bearer_token_env_var`), (b) install a keyring backend and restart. Non-secret Shared MCPs are unaffected. Per-provider CLI-scope writes are unaffected (they write directly to the provider's own config file; Orchestrator does not mirror their secrets in its DB). The existing `/mcp` client registry is unaffected — env remains plaintext in the DB blob as it was in memory today, with a one-line UI note. |
| `quarantine` (per-record) | `safeStorage.decryptString()` throws on a stored ciphertext (corrupted blob, rotated OS key, cross-machine restore, etc.) | The row is flagged `secrets_unrecoverable = 1` in the DB. No automatic deletion. No silent zero-out. Redacted DTO sets `secretsUnrecoverable: true`. UI replaces secret-value cells with inline inputs + "Save" button that dispatches `MCP_SHARED_REENTER_SECRETS`. Writes to targets for that record are blocked until re-entry. Drift detection continues to run (non-secret diffing is still meaningful). Logs record the decrypt failure with a redacted error — never the ciphertext — and surface a notification banner the first time it's seen in a session. |

An explicit migration path out of `quarantine`: after `MCP_SHARED_REENTER_SECRETS` succeeds, the row's secrets are re-encrypted fresh, `secrets_unrecoverable` cleared, and the row returns to normal.

App-start capability is cached as `SecretsCapability` singleton (Section 12.1 step 2) and rechecked only on explicit "Retry" from a UI error state — never polled.

### 7.3 Provider files still contain raw secrets

On-disk provider configs (`~/.claude.json`, etc.) carry raw secret values — that's what the CLIs need. Orchestrator's encryption contract applies to **Orchestrator's own DB** (the Shared MCP registry). We do not re-encrypt provider files.

## 8. Shared MCPs

### 8.1 Operations

**Add.** User fills the add-server form, ticks target providers (`installedTo`). `SharedMcpRegistry.create(config, installedTo)` →
1. Classify secrets and encrypt.
2. Insert DB row.
3. For each target: `adapter.writeServer(config)`. Collect per-target results.
4. Return `{ record, perTarget: { [scope]: { ok, error? } } }`. Partial success is surfaced in UI without rolling back successful writes.

**Edit.** Diff `newConfig` vs. old. `SharedMcpRegistry.update(id, newConfig, newInstalledTo)` →
- For unchanged targets, rewrite with new config.
- For added targets, write.
- For removed targets, `adapter.removeServer(name)`.
- Row is updated after file ops complete (writes first, DB last, so a half-applied state on crash shows the shared record still pointing at the old config — conservative).

**Remove.** For each target in `installedTo`: `adapter.removeServer(name)`. Collect per-target results.
- All targets succeeded → delete the DB row.
- One or more targets failed → **do not** delete the DB row. Instead, update `installed_to_json` to drop the successful targets (so retry applies only to the unresolved ones) and set `updated_at`. Return `{ perTarget }` to the renderer, which surfaces a "Partially removed — click Retry" state on the row.
- A subsequent retry runs `adapter.removeServer(name)` on the still-listed targets and deletes the row once they all succeed.
- If the user wants to abandon the shared record while leaving the dangling targets behind, the UI offers an explicit "Forget shared record (leave provider files untouched)" action that deletes the DB row unconditionally. This mirrors the `unmanage` drift-resolution action (Section 8.2).

### 8.2 Drift detection (read-side)

On every read of a Shared record, compare the record's stored config against each target provider's on-disk entry. Per-target drift states:

- `in-sync` — provider's entry matches the shared record.
- `drifted` — entry exists but differs from the shared record.
- `missing` — provider file exists, entry of this name does not.
- `not-installed` — provider config file itself is absent (e.g., user ticked Copilot but never ran Copilot).

Displayed as badges next to each provider checkbox in the detail panel; surfaced as a banner above the detail when any target is `drifted`, `missing`, or `not-installed`.

**Resolve options, user-triggered only:**
- `push-shared` — overwrite provider config with the shared record's config.
- `adopt-current` — overwrite the shared record with what's currently on disk (the provider "wins").
- `unmanage` — remove this target from `installedTo`, converting the target's entry into a standalone per-provider record in Orchestrator's mental model (the file is untouched).

No automatic reconciliation, ever. Silent overwrite of user-edited provider configs is a data-loss hazard we refuse.

## 9. IPC Surface

Existing 15 MCP channels remain untouched and scoped to orchestrator-local. New channels are additive.

### 9.1 New read channels

| Channel | Payload | Returns |
|---|---|---|
| `MCP_CLI_LIST_ALL` | `{ cwd?: string }` | `Record<'claude-code' \| 'codex' \| 'gemini' \| 'copilot', { supported: boolean; user: { servers: McpServerConfigRedacted[]; warnings: string[] }; project: ProjectReadResult[]; managed: ManagedReadResult[]; codexMode?: 'app-server' \| 'exec' \| 'unknown' }>` (keys are one per provider; `codexMode` is present only on the `codex` entry) |
| `MCP_CLI_GET_CODEX_MODE` | — | `{ mode: 'app-server' \| 'exec' \| 'unknown' }` — convenience wrapper over `CodexCliAdapter.getUseAppServer()`; renderer polls this once on tab mount + listens for `mcp:codex-mode-changed` |
| `MCP_SHARED_LIST` | — | `Array<SharedMcpRecordRedacted & { drift: Record<McpWritableProviderScope, 'in-sync' \| 'drifted' \| 'missing' \| 'not-installed'> }>` (see Section 4.7) |

### 9.2 New write channels

| Channel | Payload | Returns |
|---|---|---|
| `MCP_CLI_WRITE_SERVER` | `{ providerScope: McpWritableProviderScope; server: McpServerConfig; secrets: Record<string, string> }` | `{ ok: true } \| { ok: false; error }` |
| `MCP_CLI_REMOVE_SERVER` | `{ providerScope; serverName }` | `{ ok; error? }` |
| `MCP_CLI_SET_ENABLED` | `{ providerScope; serverName; enabled: boolean }` | `{ ok; error? }` |
| `MCP_SHARED_CREATE` | `{ config; installedTo; secrets }` | `{ record; perTarget }` |
| `MCP_SHARED_UPDATE` | `{ id; config; installedTo; secrets? }` | `{ record; perTarget }` |
| `MCP_SHARED_REMOVE` | `{ id }` | `{ perTarget }` |
| `MCP_SHARED_RESOLVE_DRIFT` | `{ id; providerScope; resolution: 'push-shared' \| 'adopt-current' \| 'unmanage' }` | `{ ok; error? }` |
| `MCP_SHARED_REENTER_SECRETS` | `{ id; secrets }` | `{ ok; error? }` — used when `secretsUnrecoverable` is true |

### 9.3 Health check

Two shapes, union-typed. The renderer must pick one. (A redacted config from the renderer is never a viable spawn input on its own — main cannot re-hydrate without either the plaintext or a stored record's secrets.)

| Channel | Payload | Returns |
|---|---|---|
| `MCP_TEST_CONFIG` | `{ mode: 'stored'; source: 'orchestrator' \| 'shared' \| 'provider-user'; recordId: string; providerScope?: McpWritableProviderScope }` **or** `{ mode: 'draft'; config: McpServerConfig; secrets: Record<string, string> }` | `{ ok: true; capabilities; tools; resources; prompts; phases } \| { ok: false; error; phases; transportSupported: boolean }` |

**Stored mode.** Renderer references an existing record by source + ID. Main looks it up:
- `source: 'orchestrator'` → fetch from `orchestrator_mcp_servers`; env is already plaintext in the DB blob (current behavior, see §4.5 and §15.14).
- `source: 'shared'` → fetch from `shared_mcp_servers`; decrypt `config_secret_ciphertext` via safeStorage and merge into the spawn config.
- `source: 'provider-user'` → read the provider's user config file via the adapter (`providerScope` required) and pull the named entry. Secrets are read straight from the provider file (they are plaintext there by CLI requirement — see §7.3).

Main composes the full `McpServerConfig`, hands it to `McpManager.testConfig(config)`, then drops the plaintext reference. The renderer never sees secret values.

**Draft mode.** Used by the Add/Edit form before Save so the user can test an unsaved config. Renderer sends the composed plaintext config and its secret map (the form holds them in-memory, bound to the inputs). Main uses and drops them immediately; nothing persists.

**Transport support.** `McpManager` today supports `stdio` and `sse` transports only (`mcp-manager.ts:183–189`). If the config's transport is `http`, the handler returns `{ ok: false; error: 'HTTP_TRANSPORT_NOT_SUPPORTED'; phases: []; transportSupported: false }` without spawning; the UI disables the `Test` button for http configs and shows a tooltip. Adding http support is listed as a deferred follow-up in §17 (separate, non-blocking).

**Secret handling across IPC (uniform rule, applies to every write/test channel that carries secrets — `MCP_TEST_CONFIG` draft mode, `MCP_CLI_WRITE_SERVER`, `MCP_SHARED_CREATE`, `MCP_SHARED_UPDATE`, `MCP_SHARED_REENTER_SECRETS`):** renderer sends a plaintext `secrets: Record<string, string>` map alongside the redacted or generic config. Main treats the plaintext as ephemeral: uses it immediately (to spawn, to write a provider file, or to safeStorage-encrypt for the shared-registry DB), then drops the reference. No plaintext is logged, persisted un-encrypted, or echoed back. Electron's in-process IPC is the only wire; no additional at-rest encryption of the payload is attempted. This is not a TLS-style threat model — the mitigation is short lifetime + never-log, not wire encryption.

`MCP_TEST_CONFIG` in stored mode does **not** require `safeStorage` availability for `source: 'orchestrator'` or `source: 'provider-user'`; it does for `source: 'shared'` (the ciphertext must decrypt). If decrypt fails for a shared record, the handler returns the record's `secretsUnrecoverable` path instead of spawning.

### 9.4 Events

Existing `server:connected` / `server:disconnected` / `server:error` / `server:phase` remain orchestrator-only.

New events:
- `mcp:cli-config-changed { providerScope, source: 'write' | 'watcher' }` — after any write, or from the debounced fs watcher (200 ms).
- `mcp:shared-registry-changed` — after any shared mutation.
- `mcp:orchestrator-registry-changed` — after any `McpManager` add/remove/update (so UI refreshes after a persistence write-through).
- `mcp:injection-changed` — after `config/mcp-servers.json` changes on disk (watcher) or `settings.codememEnabled` toggles.
- `mcp:codex-mode-changed { mode: 'app-server' | 'exec' | 'unknown' }` — emitted when a Codex adapter transitions modes (typically at spawn/respawn; the adapter exposes `useAppServer` via `codex-cli-adapter.ts:630–632`). Drives the exec-mode status pill on the Codex tab.

**Remote worker count** is derived in the renderer from the **existing** `REMOTE_NODE_NODES_CHANGED` event (emitted by `WorkerNodeConnection.broadcastNodesToRenderer`, `src/main/remote-node/worker-node-connection.ts:158`). The MCP renderer stores subscribe to that channel and surface a reactive `remoteWorkerCount` signal; no new MCP-specific channel is added.

### 9.5 Validation

All new payloads validated with Zod schemas co-located with existing MCP schemas (`@contracts/schemas/provider/mcp.schemas.ts` or adjacent). Every handler runs `validateIpcPayload(schema, payload, 'CHANNEL_NAME')` before dispatch.

### 9.6 Wiring checklist (repo-specific — do not skip any step)

The repo uses a **generated IPC channel registry** plus an **explicitly composed preload**. Adding a channel requires touching every one of these files/locations in order:

1. **Channel names** — create `packages/contracts/src/channels/mcp-cli.channels.ts`, `mcp-shared.channels.ts`, `mcp-injection.channels.ts` as `const` objects with string-literal values and `as const`, exporting `MCP_CLI_CHANNELS`, `MCP_SHARED_CHANNELS`, `MCP_INJECTION_CHANNELS`.
2. **Register in `index.ts`** — open `packages/contracts/src/channels/index.ts` and add (a) an `import { MCP_CLI_CHANNELS } from './mcp-cli.channels';` (and the other two), (b) a re-export in the `export { ... };` block, and (c) a spread inside the `IPC_CHANNELS = { ... }` object. **The generator reads only `index.ts`** — if a new `*.channels.ts` file isn't imported + spread in `index.ts`, its keys will not appear in `IPC_CHANNELS` no matter how many times you run the generator.
3. **Zod schemas** — `packages/contracts/src/schemas/provider/` (or the nearest existing MCP schema location) — one `*.schemas.ts` file per grouping, with `requestSchema` / `responseSchema` per channel.
4. **Schema tests** — `packages/contracts/src/schemas/__tests__/*.spec.ts` — positive and negative payload cases for each schema.
5. **Regenerate preload channels** — run `npm run generate:ipc`. The generator (`scripts/generate-preload-channels.js:24`) reads **only** `packages/contracts/src/channels/index.ts`, extracts the merged `IPC_CHANNELS` body lines, and writes `src/preload/generated/channels.ts`. Do not hand-edit the generated file. Commit the regenerated file.
6. **Handler registration (main)** — `src/main/ipc/handlers/mcp-cli-handlers.ts`, `mcp-shared-handlers.ts`, `mcp-injection-handlers.ts`. Each handler calls `validateIpcPayload(schema, payload, CHANNEL_NAME)` before dispatch. Register via `ipcMain.handle(CHANNEL_NAME, ...)`.
7. **Preload domain modules** — `src/preload/domains/mcp-cli.preload.ts`, `mcp-shared.preload.ts`, `mcp-injection.preload.ts`. Each is a factory `(ipcRenderer, IPC_CHANNELS) => ({...methods})` matching the shape used by existing domains (`instance.preload.ts`, `workspace.preload.ts`, etc.).
8. **Compose into `electronAPI`** — open `src/preload/preload.ts` and (a) add `import { createMcpCliDomain } from './domains/mcp-cli.preload';` (and the other two), (b) add `...createMcpCliDomain(ipcRenderer, IPC_CHANNELS),` (and the other two) to the `electronAPI` object at `src/preload/preload.ts:41`. **There is no auto-discovery** — preload is explicit imports and explicit spreads.
9. **Existing MCP APIs stay put.** The current MCP client-registry methods live inside `src/preload/domains/workspace.preload.ts:254–` (not a dedicated `mcp.preload.ts`, which does not exist). Do not move them. New CLI/Shared/Injection methods live in the new modules above; existing orchestrator-scope methods remain in `workspace.preload.ts` and its matching handlers.
10. **Renderer services** — `src/renderer/app/core/services/ipc/cli-mcp-ipc.service.ts`, `shared-mcp-ipc.service.ts`, `mcp-injection-ipc.service.ts`. Signal-backed, following `mcp-ipc.service.ts` as template. Add barrel exports in `src/renderer/app/core/services/ipc/index.ts`.
11. **Event subscriptions (main → renderer)** — `mcp:cli-config-changed`, `mcp:shared-registry-changed`, `mcp:orchestrator-registry-changed`, `mcp:injection-changed`, `mcp:codex-mode-changed` emitted from main; renderer stores subscribe in their constructor via the existing `onEvent` pattern. Also subscribe to `REMOTE_NODE_NODES_CHANGED` (existing) and derive `remoteWorkerCount` from its payload.

**Packaging reminder (from `AGENTS.md`):** any new `@contracts/schemas/...` subpath added must be mirrored in (a) `tsconfig.json`, (b) `tsconfig.electron.json`, (c) `src/main/register-aliases.ts` `exactAliases`, and (d) `vitest.config.ts` if imported by tests. Missing #c silently breaks the packaged DMG. The plan will include a prebuild verification step (`scripts/verify-native-abi.js` already covers ABI; the alias mirroring check is a separate lint).

### 9.7 New channels for Orchestrator surfaces

| Channel | Payload | Returns |
|---|---|---|
| `MCP_ORCH_INJECTION_LIST` | — | `{ bootstrapFile: { path: string; entries: McpServerConfigRedacted[]; readOnly: true }; codememBridge: { enabled: boolean; entry?: McpServerConfigRedacted; readOnly: true }; claudeInjectionActive: boolean; remoteWorkerCount: number }` |
| `MCP_ORCH_CODEMEM_SET_ENABLED` | `{ enabled: boolean }` | `{ ok; error? }` — thin wrapper over the existing `settings.codememEnabled` channel; included here for symmetry with the UI section's toggle |

## 10. Health Check Flow

1. User clicks "Test" on any server in any tab.
2. **Pre-spawn gating** (renderer, before IPC): if the config's `transport === 'http'`, the Test button is disabled with a tooltip linking to §17; `MCP_TEST_CONFIG` is never invoked. `stdio` and `sse` are allowed.
3. Renderer sends `MCP_TEST_CONFIG` using one of the two payload shapes from §9.3:
   - **Stored mode** for records that already exist (orchestrator / shared / provider-user): sends `{ mode: 'stored'; source; recordId; providerScope? }`. Main looks up the full config, decrypts any secrets if needed, composes the spawn input.
   - **Draft mode** for unsaved Add/Edit form state: sends `{ mode: 'draft'; config; secrets }`. Main uses the payload directly, drops the plaintext after spawn.
4. Main hands the composed config to `McpManager.testConfig(config)` — an ephemeral operation that does not persist anything.
5. `McpManager` spawns via its existing stdio/SSE client path (`mcp-manager.ts:183–189`), runs `transport → initialize → discover`, captures capabilities, tools, resources, prompts, disconnects cleanly. 30-second overall timeout.
6. Main returns `{ ok: true; capabilities; tools; resources; prompts; phases }` on success, `{ ok: false; error; phases; transportSupported }` on failure. `transportSupported: false` signals the UI to render "transport not supported" rather than "transport errored".
7. UI renders "transport ✓ → initialize ✓ → discover ✓ → ready ✓ — exposes N tools, M resources" or stops at the failing phase with the error.

## 11. UI

### 11.1 Page structure — Layout A

Horizontal tabs across the top of the existing `/mcp` page:

```
┌───────────────────────────────────────────────────────────┐
│ MCP Servers                                Back | Refresh │
├───────────────────────────────────────────────────────────┤
│ [Orchestrator] [Shared] [Claude] [Codex] [Gemini] [Copilot]│
├───────────────────────────────────────────────────────────┤
│ (tab content)                                             │
└───────────────────────────────────────────────────────────┘
```

- **Orchestrator tab** — restructured into three explicit sub-sections, preserving the current page's behavior verbatim inside sub-section #1:
  1. **Client registry** (default view) — the existing `/mcp` page: metric cards, Browser Automation health panel, server sidebar with add/connect/disconnect/restart/remove, Config/Tools/Resources/Prompts tabs. Zero regressions. v1 change: user additions now persist across restarts via `orchestrator_mcp_servers`.
  2. **Bootstrap file** (read-only) — shows `config/mcp-servers.json` contents with a "Source: `<path>`" header, a copy-to-clipboard action, and a note explaining this file is merged into Claude spawns via `--mcp-config` and edits require hand-edit + restart.
  3. **Codemem bridge** — a one-row card reading `enabled | disabled` from `settings.codememEnabled` with an enable toggle, a "Preview config" disclosure showing the current bridge spec (read-only), and a note explaining it's injected into Claude spawns only when enabled.

  Sub-section nav is a segmented control at the top of the Orchestrator tab; default selection is #1 for continuity.
- **Shared tab** — server list sidebar with "+ Add Shared", detail panel shows the single shared config, per-target checkboxes with sync status badges (`in-sync` / `drifted` / `missing` / `not-installed`; unticked providers show no badge), drift banner at top when any target is `drifted`, `missing`, or `not-installed`, `Test` / `Edit` / `Remove all` actions. **Persistent banner at tab top** when `MCP_ORCH_INJECTION_LIST.remoteWorkerCount > 0`: "Shared MCP fan-out edits this machine only. N remote worker(s) registered will continue using their own MCP configs." followed by a `Learn more` link that opens the remote-worker docs section (the final link target is tracked as a v1 docs deliverable — see §17; the label itself is final UI copy).
- **Provider tab (×4)** — server list sidebar split into sections:
  - **User** — editable, has `+ Add` button. Each row shows name, enable toggle, "(shared)" badge if `installedTo` contains this provider.
  - **Project / Workspace / Local** — read-only, lock icon, source file path in the section header. Each row shows name + scope badge. Clicking shows details in the right panel but the Edit/Remove buttons are replaced with "Source: `<path>` — edit by hand." Section shown as "— switch cwd to view —" when lazy watchers have no cwd context (§12.1 step 8).
  - **Managed / System** — read-only, distinct badge ("managed"), note "pushed by system policy, cannot be overridden." If a managed entry shadows a user entry (same name), the user entry is flagged "Shadowed by managed config — CLI will use the managed version."
  - **Codex-only mode pill** — small status pill in the Codex tab header showing `app-server` (green) or `exec` (amber) or `unknown` (gray). Amber variant opens a tooltip with the explanation copy ("Codex is running in exec mode; MCP entries in `~/.codex/config.toml` are ignored because Orchestrator strips them for startup performance. Upgrade Codex CLI for app-server mode.") followed by a `Learn more` link that opens the Codex exec-mode docs section (docs target tracked in §17; the label is final UI copy). See §1 fact #3.
  - **Copilot-only note** — small info strip beneath the list: "GitHub org/enterprise policies may restrict which MCPs are allowed at the server level. Orchestrator has no visibility into that — it only manages your local `~/.copilot/mcp-config.json`."
  - **Remote-worker disclaimer** (all provider tabs) — small info strip in the tab header when any remote worker is registered: "User-scope edits affect this machine. Your remote workers read their own `<config file>` on their own filesystem."

### 11.2 Server detail panel

Shared across Shared and Provider tabs:

1. **Header** — name + scope badge + enable toggle + `(shared)` tag if applicable.
2. **Generic fields** — transport, command/args (with redactions shown as `•••`), url (with userinfo redacted if present), env (keys listed; values shown as `•••` or `→ $ENV_VAR`).
3. **Auth** (if `auth.type !== 'none'`) — auth type + presence indicators for credential fields.
4. **Provider-specific settings** — expandable section, shows `providerRaw.preservedFields` as read-only key-value pairs with their raw values (v1 — no editor for these; v2 might add JSON/TOML edit mode).
5. **Source** — file path the entry comes from (e.g., `~/.claude.json`, `~/.config/codex/config.toml`).
6. **Actions row** — `Test` (always), `Edit` / `Remove` (only at editable scopes), `Resolve drift` (shared, if drifted).

### 11.3 Add-server form

Reached via `+ Add` at user scope or `+ Add Shared` in the Shared tab.

- **Name** — validated per selected target provider (Gemini: no `_`, etc.). Real-time validation.
- **Scope target** — in provider tabs: fixed (user scope of this provider). In Shared tab: multi-select checkboxes for writable providers. Checkbox is **enabled** when the adapter's `isSupported()` returns true; **disabled with tooltip** otherwise ("Claude Code CLI not detected — install it and reopen this page to enable fan-out").
- **Transport** — radio group of `stdio` / `http` / `sse`. The Save button is gated by transport compatibility with every selected target; the transport radios themselves are **not** disabled so the user can see why Save is blocked. Per-target constraints displayed as inline badges beside each provider checkbox: Codex has no documented SSE support → `sse` shows "Codex: not supported" next to the Codex checkbox; Copilot's `sse` is deprecated → deprecation warning; Claude's `sse` is deprecated → deprecation warning. The pre-spawn gating in §10 also disables the Test button when transport is `http` (health check limitation, separate from fan-out).
- **Command/args OR URL/headers** — based on transport.
- **Env** — key/value pairs. Each value has a "use env-var reference" toggle (preferred for secrets on Codex).
- **Auth** — same structure as existing `McpAuthConfig`.
- **Provider-specific advanced** — v1: an informational note listing which preserved fields would be inherited on edit (none on create; the field is added empty). v2: advanced editor.

### 11.4 Drift banner

Shown above the detail panel in the Shared tab when any target's drift state is not `in-sync`. Copy:

> **Drift detected** — 1 provider's copy differs from the shared config.

Two action buttons follow the copy, labeled exactly `View diff` and `Resolve…`:

- The `View diff` button opens a side-by-side diff of the shared record's config vs. the on-disk entry.
- The `Resolve…` button opens a per-target chooser with the three resolution options (overwrite provider / adopt provider as new shared / unlink) and previews of what each would do.

### 11.5 Secrets re-entry flow

When a record's `secretsUnrecoverable === true`:

- Row is badged "Secrets unrecoverable — action needed."
- Detail panel replaces secret-value cells with inline text inputs + "Save" button that dispatches `MCP_SHARED_REENTER_SECRETS` (or the equivalent for per-provider records, stored transiently only).

## 12. Startup & Shutdown Wiring

### 12.1 Startup (in `src/main/index.ts`)

1. **Existing DB init runs migrations.** The repo's migration system is the TypeScript `MIGRATIONS` array at `src/main/persistence/rlm/rlm-schema.ts:51` (the `db/migrations/*.sql` directory referenced in an earlier draft of this spec does not exist). The last committed migration at the time of writing is `014_add_summary_scan_index` (line 530 of that file). This feature appends two new entries to the array, numbered next in sequence:
   - `015_orchestrator_mcp_servers` — creates the client-registry persistence table (schema in §4.5). Down migration drops it.
   - `016_shared_mcp_servers` — creates the shared-fan-out registry + unique index on name (schema in §4.4). Down migration drops them.
   Both entries follow the existing `{ name, up, down }` shape using raw SQL strings. No new build step or migration runner is introduced.
2. `safeStorage.isEncryptionAvailable()` called once, cached as `SecretsCapability`. Logged.
3. `McpManager.loadFromStore()` runs — replaces the existing "Map starts empty" initialization. Any orchestrator-scope records are hydrated from `orchestrator_mcp_servers` before any connection logic runs. `autoConnect` records proceed through their existing connection flow.
4. `CliMcpConfigService` instantiated with the four adapters. Each adapter resolves its **static** config paths (user, managed/system — expanding `~`, reading `XDG_CONFIG_HOME`, `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, etc.) and verifies the binary's installed status via `isSupported()`.
5. `SharedMcpRegistry` instantiated with DB handle + `SecretsCapability`.
6. `OrchestratorInjectionReader` instantiated — reads `config/mcp-servers.json` once at startup (cheap) and subscribes to the existing `settings.codememEnabled` change channel so the codemem section refreshes live.
7. New IPC handler modules registered alongside existing `mcp-handlers.ts`: `mcp-cli-handlers.ts`, `mcp-shared-handlers.ts`, `mcp-injection-handlers.ts`.
8. **Watcher model** (split by scope lifetime):
   - **Startup-persistent watchers** run for the whole app lifetime: each adapter's **user** config file, `config/mcp-servers.json`, and each **managed/system** config file. Debounce: 200 ms. User/managed watchers emit `mcp:cli-config-changed`. The bootstrap-file watcher emits `mcp:injection-changed`. Managed-scope paths that live on `/etc` or similar where inotify/fsevents may be unreliable additionally run a 60 s poll as belt-and-suspenders. `OS_POLL_FALLBACK` config controls the poll interval.
   - **Lazy/cwd-bound watchers** for **project / local / workspace** scopes are started only when the MCP page is mounted **and** a cwd is known (either the user's current working-directory selection from the app's existing cwd signal, or one they type into the provider tab's path input). The adapter walks from repo root (`.git` marker) down to the cwd to enumerate relevant `.mcp.json` / `.codex/config.toml` / `.gemini/settings.json` / `~/.claude.json` project-path sections, and a watcher is registered for each distinct file. When the cwd changes or the page is unmounted, the lazy watcher set is torn down and rebuilt. The MCP page explicitly renders "no project context — switch cwd to view project-scope entries" when cwd is unset.
   - **Self-write debounce.** Every adapter write increments a per-file write-token before calling `fs.rename`; the watcher handler reads the token on event fire and suppresses `mcp:cli-config-changed` events for the write-token window (200 ms default, tuned in tests). Prevents self-echo loops when the user writes via Orchestrator.
9. Preload composition is explicit (see Section 9.6 step 8): `src/preload/preload.ts` is edited to import and spread the three new domain modules alongside the existing 10.
10. Remote-worker count: subscribe to the **existing** `REMOTE_NODE_NODES_CHANGED` event (`worker-node-connection.ts:162`). Renderer derives `remoteWorkerCount` from the payload length. No new worker-registry observer is introduced.

### 12.2 Shutdown

1. Flush any pending debounced write (so user-triggered actions mid-quit don't get dropped).
2. Close fs watchers for provider configs + bootstrap file + managed-scope pollers.
3. Unsubscribe the renderer-side `REMOTE_NODE_NODES_CHANGED` listener in the MCP page's `onDestroy`.
4. Optional: run `.orch-bak` cleanup if `mcpCleanupBackupsOnQuit === true` (default false).
5. Close DB (existing path) — `McpManager` persistence closes here alongside all other DB-backed services.

### 12.3 Renderer wiring

- New `CliMcpIpcService`, `SharedMcpIpcService`, `OrchInjectionIpcService` follow the existing signal-backed pattern (same shape as `McpIpcService`). Barrel-exported from `src/renderer/app/core/services/ipc/index.ts`.
- `McpPageComponent` refactored into a host that contains the tab router and delegates to `OrchestratorMcpTabComponent` (existing logic lifted to its `ClientRegistrySection` verbatim; new sub-sections added alongside), `SharedMcpTabComponent` (new), `ProviderMcpTabComponent` (new, parameterized by which provider).
- Sidebar nav entry `MCP Servers` → `/mcp` is unchanged.

## 13. Migration & Back-Compat

- **Two new DB migration entries appended to `MIGRATIONS` at `src/main/persistence/rlm/rlm-schema.ts:51`** — the repo's TypeScript `Migration[]` array is the migration system (there is no `db/migrations/` directory). Both are strictly additive:
  - `015_orchestrator_mcp_servers` — `CREATE TABLE` + unique index per §4.5. Backs `McpManager`. Orchestrator-scope records today are in-memory only; nothing pre-exists to migrate. On first startup after this change, the table is empty and `McpManager.loadFromStore()` is a no-op; subsequent user additions persist through the new write-through path. Down drops the table.
  - `016_shared_mcp_servers` — `CREATE TABLE` + unique index per §4.4. New Shared registry. Empty on first startup. Down drops the table and index.
- **`McpManager` constructor/startup change is behavior-visible only for additions/removals** — connection lifecycle, event shape, IPC channel signatures, and preset registration are unchanged. Existing 15 MCP IPC channels keep identical signatures and returns.
- **`config/mcp-servers.json` is read, never written.** Existing `lsp` entry stays where it is.
- **Codemem bridge** — same runtime behavior as today; the UI exposes the existing `settings.codememEnabled` toggle. No change to the `buildCodememMcpConfig()` contract or the `--mcp-config` injection path.
- **Remote workers** — no change. `instance-lifecycle.ts:289–295` continues to pass `mcpConfig: []` to remote spawns. v1 introduces no wire changes to `worker-node-connection.ts` or the RPC schemas.
- **Codex exec-mode behavior unchanged.** `prepareCleanCodexHome()` continues to strip `[mcp_servers.*]` in exec mode exactly as today. The UI makes this visible; it does not change the underlying behavior.
- **No provider config writes** until the user takes an explicit UI action.
- **`.orch-bak` backup** created the first time each provider file is written in a session, with the policies in Section 6.2.4.
- **New `AppSettings` keys** (`mcpCleanupBackupsOnQuit`, `mcpDisableProviderBackups`, `mcpAllowWorldWritableParent`) added with conservative defaults (`false` each). Persisted-settings load continues to work for users on old settings files — missing keys fall through to the default.
- **No feature flag.** Single-user desktop app; direct ship. The Orchestrator tab's client-registry sub-section preserves all prior behavior.

## 14. Testing Strategy

### 14.1 Unit — adapters

For each of Claude / Codex / Gemini / Copilot:
1. Read fixture → assert generic fields populated correctly, `providerRaw.preservedFields` captures every non-generic field.
2. Upsert generic-only change → re-read fixture → assert preserved fields are byte-equivalent (comment-preserving snapshot test for Codex TOML).
3. Upsert new server → assert non-MCP sections of the file are byte-equivalent to before.
4. Remove server → assert clean removal, no dangling references.
5. Validation rules tested per-provider (Gemini `_` ban, Codex trust gating, Claude managed-scope read).
6. `isSupported()` returns false when binary/config absent (mocked filesystem).

### 14.2 Unit — Shared registry

1. Create with secrets → DB row has ciphertext, plaintext not in `config_public_json`.
2. Update → diff produces correct add/remove/rewrite sets.
3. Partial failure on create → per-target results reflect reality, DB row still persisted; renderer shows partial state.
4. **Partial failure on remove** → DB row retained with `installed_to_json` narrowed to the still-failing targets; retry removes them and finally deletes the row (per §8 Remove).
5. **Forget shared record** (explicit action) → deletes DB row unconditionally without touching provider files.
6. Drift detection against hand-mutated fixtures.

### 14.3 Unit — secrets

1. Classifier regex tables (env names, arg patterns, URL shapes, query-param names).
2. `safeStorage` round-trip for the encrypted map.
3. `SecretsCapability.unavailable` path — Shared creation with secrets refused with typed error.
4. Decryption failure path — record flagged `secretsUnrecoverable`, UI-bound DTO reflects it, writes blocked until `MCP_SHARED_REENTER_SECRETS`, reentry clears the flag.
5. Redacted DTO invariant: no plaintext secret byte appears in any `*Redacted` output across a property-based test.

### 14.3a Unit — McpManager persistence

1. Fresh DB + add server via existing `addServer()` → row lands in `orchestrator_mcp_servers`.
2. Restart (destroy in-memory Map, re-run `loadFromStore`) → server present with original config.
3. Remove server → row deleted.
4. Simulated crash between in-memory add and DB write → startup detects inconsistency and logs a warning (acceptance: DB is the source of truth; Map is rebuilt from DB on every startup).
5. Migration applied to DB with pre-existing orchestrator-scope in-memory-only sessions → no data lost (there was no data to lose; smoke test verifies empty table on first boot, subsequent adds persist).

### 14.3b Unit — Write safety

1. File-mode preservation on atomic writes (POSIX; skip on Windows).
2. `.orch-bak` created with matching mode; overwritten on second write in same session; not created if `mcpDisableProviderBackups === true`.
3. World-writable parent directory refusal surfaces the expected typed error; `mcpAllowWorldWritableParent === true` bypasses.
4. Temp-file cleanup on rename success and on rename failure.
5. **Self-write suppression.** Fire an adapter write, assert that the fs watcher's debounced handler sees the event but suppresses `mcp:cli-config-changed` because the write-token matches; fire an external write (write via `fs.writeFile` directly, no token), assert the event propagates.
6. **Watcher debounce.** Fire three rapid external writes within 50 ms; assert exactly one `mcp:cli-config-changed` event emitted at ~200 ms.
7. **Cross-filesystem rename** (simulate via fs mock throwing `EXDEV`) surfaces a typed error — not a silent fallback (POSIX rule per §6.2.3). Windows path simulates `EBUSY` on first rename; fallback to `copyFile + unlink` succeeds; asserted via second-attempt file content.

### 14.4 Integration — health check

- In-repo echo MCP server stub (stdio transport). Assert full phase progression, capability capture, 30 s timeout behavior.
- SSE test fixture against a minimal in-process SSE server. Assert phase progression under the sse client path.
- **HTTP transport test**: feed a config with `transport: 'http'` to `MCP_TEST_CONFIG` (draft mode). Assert handler returns `{ ok: false; error: 'HTTP_TRANSPORT_NOT_SUPPORTED'; transportSupported: false }` **without** calling `connectStdio` or `connectSse`. No spawn attempted.
- **Stored-mode lookup**: create a shared record (with secrets), invoke `MCP_TEST_CONFIG` in `stored` mode with `source: 'shared'`, assert main reads the record, decrypts, spawns, disconnects; assert no plaintext ever crosses back to the renderer in the response.
- **Stored-mode with quarantine**: same setup but corrupt the ciphertext; assert handler returns the `secretsUnrecoverable` error path instead of spawning.

### 14.5 IPC schema

Every new Zod schema: valid payload parses, malformed payload rejects with a readable error.

### 14.6 Renderer component

One per tab (Orchestrator, Shared, each provider). Empty states, drift banner visibility, enable toggle semantics, read-only section rendering, managed-scope shadow warning, secrets-unrecoverable UI, remote-worker disclaimer conditional on a mock `REMOTE_NODE_NODES_CHANGED` stream, Codex-mode pill reacts to a mock `mcp:codex-mode-changed` stream, Orchestrator tab's three sub-section navigation.

### 14.6a Integration — generated channels

1. Running `npm run generate:ipc` produces a deterministic `src/preload/generated/channels.ts` — snapshot test against the committed generated file.
2. **`index.ts` integrity test:** parse `packages/contracts/src/channels/index.ts` and assert that for every `*.channels.ts` file in the same directory, there is (a) a matching `import` statement, (b) a re-export in the `export { ... };` block, and (c) a spread into `IPC_CHANNELS`. Catches the "new file not wired into index" failure mode.
3. **Preload composition test:** parse `src/preload/preload.ts` and assert every `create*Domain` factory exported from `src/preload/domains/*.preload.ts` is imported and spread into `electronAPI`. Catches the "new preload module not wired" failure mode.
4. Every new handler registered in main has a matching preload binding (cross-check test: iterate `IPC_CHANNELS` and assert each has a renderer-accessible wrapper).

### 14.7 Manual verification checklist (in plan)

After implementation:
- Open `/mcp` → each tab loads with live data from the user's actual configs. Orchestrator tab's Bootstrap section shows the `lsp` entry from `config/mcp-servers.json`. Codemem toggle reflects `settings.codememEnabled`.
- Add a server via the Orchestrator tab's Client Registry sub-section, quit the app, reopen → server is still there (persistence verification).
- Add a Shared MCP with env secrets → verify it lands in each selected provider's config on disk with correct per-provider formatting (`type` vs. implicit, snake_case for Codex, etc.). File mode is `0o600` on POSIX. `.orch-bak` exists beside each source file.
- Spawn a Claude session post-fan-out → the newly-added MCP should appear in the session's MCP list (visibility verification for Claude, which uses `--mcp-config` merging).
- Spawn a Gemini / Copilot session post-fan-out → the newly-added MCP should appear in the session's MCP list (visibility verification for natively-read configs).
- Spawn a Codex session **in app-server mode** post-fan-out → MCP should appear in the session's MCP list. Force exec mode (by running against an older Codex CLI or temporarily disabling app-server detection) and spawn again → MCP should **not** appear (verifies §1 fact #3 + §5.1 behavior). Codex tab's status pill reflects the active mode in both runs.
- Attempt `Test` on a config with `transport: 'http'` → button is disabled with tooltip; clicking has no effect; IPC not invoked.
- Register a remote worker → disclaimer banners appear on Shared and each provider tab. Fan-out actions still work on local; remote worker's configs are untouched (verify via SSH).
- Hand-edit one provider's config → see drift banner within ~300ms.
- Resolve drift with `push-shared` → verify file matches shared record. Resolve with `adopt-current` → verify shared record adopts provider's version. Unmanage one target → `installedTo` shrinks, provider file untouched.
- Toggle safeStorage off (simulate on Linux by setting `--password-store=basic` or equivalent) → Shared-with-secrets creation refused with the right UI state. Non-secret Shared creation still works.
- Corrupt one shared record's ciphertext in the DB → restart → record shows `secretsUnrecoverable`. Re-enter via UI → writes re-enabled.
- Run `npm run generate:ipc` → `src/preload/generated/channels.ts` is unchanged (deterministic regen). Run `npm run build` → packaged DMG starts and the `/mcp` page works.
- Test button on an intentionally-broken config → phase report stops at the failing phase with a clear error.

## 15. Explicit Non-Goals (v1)

1. **No project-scope writes.** `.mcp.json`, `.gemini/settings.json`, `.codex/config.toml` — read-only surfacing only. Edit by hand. (v2 concern: must refuse to write secret-bearing configs into VCS-tracked files without explicit confirmation.)
2. **No managed-scope writes.** System configs require elevation Orchestrator will not request.
3. **No tool playground on CLI-scoped servers.** Health check only verifies startup + capabilities. Orchestrator-scope servers keep their existing tool/resource/prompt UI.
4. **No OAuth token refresh.** Auth fields stored; flows happen at the CLI level.
5. **No CLI-flag runtime override modeling.** Users who pass `--config` to Codex etc. will see "configured" state diverge from actual CLI behavior; documented limitation.
6. **No Copilot server-policy modeling.** GitHub admin-console allowlists are not visible to Orchestrator.
7. **No auto-fix for drift.** User-triggered resolution only.
8. **No cross-machine sync.** Shared registry is local to this install's DB.
9. **No MCP server discovery / marketplace.** Existing 7 presets stay; no dynamic catalog.
10. **No advanced editor for `providerRaw` preserved fields in v1.** They're visible read-only; round-trip preservation is the guarantee. Full editor is v2.
11. **No remote-worker MCP propagation.** Shared fan-out writes land on the machine running Orchestrator only. Remote workers keep using their own filesystem's configs. UI shows a persistent disclaimer when workers are registered. v2 may add opt-in sync over the existing RPC + sync infrastructure.
12. **No `config/mcp-servers.json` edits.** Read-only in v1; the file is an app resource (location differs packaged vs dev) and is the wrong surface to write to. Users who want their own injected MCPs use the Shared tab (which edits user configs and works for Claude + the other three).
13. **No rewrites of McpManager's connection logic.** The persistence layer is strictly additive; lifecycle, events, auto-connect, and the existing tool/resource/prompt surfaces are untouched.
14. **No safeStorage migration for orchestrator-scope env in v1.** Today those fields are plaintext in `McpManager`'s in-memory Maps; v1 moves them to plaintext in the DB blob. Upgrading to safeStorage for orchestrator scope is a separable follow-up and explicitly outside this feature.
15. **No HTTP transport health check.** `McpManager` today supports `stdio` and `sse` only (`mcp-manager.ts:183–189` throws for anything else). Adding an http client is non-trivial (auth flows, session lifecycle, streaming semantics) and is listed as a deferred follow-up in §17. v1's `MCP_TEST_CONFIG` rejects http configs at the handler with a typed error; the UI disables the Test button for http configs.
16. **No change to Codex exec-mode MCP stripping.** Orchestrator continues to strip `[mcp_servers.*]` in exec mode as it does today (per `codex-cli-adapter.ts:2882–2936`) because reverting costs 60–90 s + 87 K tokens per server. v1 makes this behavior visible through the UI's mode pill; it does not alter it. A future v2 could pursue a "let a user opt-in per-server" marker, but that's out of scope here.

## 16. Phase Breakdown

- **Phase 0 — Types + schemas + migrations + capability detection + channel generation + settings.**
  - Extend `mcp.types.ts` with full scope union (`McpScope`, `McpWritableProviderScope`, `McpProviderScope`, `McpOrchestratorScope`), `enabled`, `providerRaw`, `McpServerConfigRedacted`, `SharedMcpRecordRedacted`, `ProjectReadResult`, `ManagedReadResult`. No changes to `McpAuthConfig` — existing shape already covers v1 needs.
  - New channel-name files: `packages/contracts/src/channels/mcp-cli.channels.ts`, `mcp-shared.channels.ts`, `mcp-injection.channels.ts`. **Wire them into `packages/contracts/src/channels/index.ts`** (import, re-export, spread into `IPC_CHANNELS`) per §9.6 step 2 — the generator reads only `index.ts`.
  - Zod schemas: `packages/contracts/src/schemas/provider/mcp-cli.schemas.ts`, `mcp-shared.schemas.ts`, `mcp-injection.schemas.ts` with schema unit tests under `__tests__/`.
  - Run `npm run generate:ipc` to regenerate `src/preload/generated/channels.ts`. Commit the generated file.
  - **Two DB migration entries** appended to `MIGRATIONS` in `src/main/persistence/rlm/rlm-schema.ts:51` — named `015_orchestrator_mcp_servers` and `016_shared_mcp_servers`. Each is a `{ name, up, down }` object with raw SQL strings; no new migration files or directories.
  - **Add three new `AppSettings` keys** (`mcpCleanupBackupsOnQuit`, `mcpDisableProviderBackups`, `mcpAllowWorldWritableParent`) to `src/shared/types/settings.types.ts:18` with `false` defaults; add matching `SETTINGS_METADATA` entries under `category: 'advanced'`.
  - `SecretsCapability` singleton with safeStorage detection, logged at startup.
  - **Codex mode surfacing**: expose a typed getter on `CodexCliAdapter` (e.g., `getAppServerMode(): 'app-server' | 'exec' | 'unknown'`) that returns the current `useAppServer` state (already tracked at `codex-cli-adapter.ts:305`). Emit a `mcp:codex-mode-changed` event whenever that flag transitions. Handler for `MCP_CLI_GET_CODEX_MODE` reads the getter.
  - Default-fill for McpManager reads (`scope: 'orchestrator'` stamped on hydrated records).
  - Update `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts` if any new `@contracts/schemas/...` subpaths require it.
  - **One-time behavioral observation:** spawn the installed Claude CLI with a minimal `--mcp-config <temp>.json` that defines one server name not present in `~/.claude.json`, and also verify an existing `~/.claude.json` server is still available. Record whether the result is merge (both visible) or replace (only injected visible). Document the observed behavior in an ADR-style note inside the spec file. This single observation is the basis for all Shared-tab Claude fan-out claims; if Claude's semantics change in a future version, the observation test catches it via the manual checklist.
  - **Acceptance:** typecheck passes, existing tests untouched, migrations apply cleanly on a fresh DB and on an existing DB, `IPC_CHANNELS` contains the new names after regen, `index.ts` integrity test passes, capability detection result surfaces in logs, new settings keys round-trip through load/save, Claude `--mcp-config` merge-vs-replace semantics recorded, Codex mode getter returns a correct value for both modes.

- **Phase 1 — McpManager persistence + Adapters with `providerRaw` round-trip.**
  - `McpManager.loadFromStore()` + `writeThrough()` + `removeFromStore()` wired to `orchestrator_mcp_servers`. Existing in-memory Map behavior unchanged at the API surface — this is strictly a persistence layer addition. Tests: startup hydration, add/remove round-trip, crash-recovery (simulated mid-write failure leaves DB in a consistent state).
  - `McpProviderAdapter` interface.
  - Four implementations: Claude Code, Codex (comment-preserving TOML), Gemini (with `_` validation), Copilot.
  - `OrchestratorInjectionReader` for the read-only bootstrap + codemem view.
  - Per-adapter fixture-based read/write tests including managed + project/local/workspace scope reads and the `providerRaw` preservation invariant.
  - Write-safety tests: mode preservation on atomic writes, `.orch-bak` creation/overwrite semantics, world-writable-parent refusal, disable-backups setting honored.
  - **Acceptance:** round-trip invariant tests pass for every provider; unknown fields byte-equivalent in snapshot tests; Codex comments survive; McpManager restart test shows user-added server hydrated on second startup; file mode on written config + `.orch-bak` is preserved (POSIX test).

- **Phase 2 — Secrets, Shared registry, IPC, watchers.**
  - `SecretClassifier` utility.
  - `SharedMcpRegistry` with safeStorage-backed encryption.
  - `CliMcpConfigService` wiring adapters + fs watchers (debounced 200ms) + managed-scope 60s poll.
  - New IPC handler modules.
  - `McpServerConfigRedacted` conversion at the IPC boundary.
  - Renderer-side IPC services.
  - **Acceptance:** secret round-trip tests pass, DB never contains plaintext, renderer DTOs prove redacted via property test, unavailable + decryption-fail paths both tested.

- **Phase 3 — UI restructure.**
  - `McpPageComponent` refactored into host + tab components. **Risk mitigation:** the existing page is ~1600 lines of specialized behavior. Refactor extracts sub-components **without rewrites**: the existing DOM, template bindings, and signal wiring move into `OrchestratorMcpTabComponent > ClientRegistrySection` as-is. A render-parity test (existing `/mcp` snapshot vs. post-refactor snapshot under the Client Registry sub-section) gates the merge.
  - `OrchestratorMcpTabComponent` with segmented sub-section nav (Client Registry / Bootstrap / Codemem).
    - `ClientRegistrySection` — existing behavior preserved verbatim; gains persistence integration (no visible change to users except that additions now survive restart).
    - `BootstrapFileSection` — read-only list + copy-path action.
    - `CodememBridgeSection` — toggle bound to existing `settings.codememEnabled` channel + read-only spec preview.
  - `SharedMcpTabComponent` with drift banner, fan-out checkboxes, `Resolve` flow, secrets re-entry, remote-worker disclaimer banner.
  - `ProviderMcpTabComponent` with user/project/local/workspace/managed section layout, enable toggles, shadow warning, add/edit/remove forms, remote-worker disclaimer.
  - Managed-scope treatment + Copilot policy info strip.
  - **Acceptance:** component tests cover every scope including managed; drift E2E; Gemini name validation end-to-end; secrets-unrecoverable flow usable; render-parity test for Client Registry passes; disclaimer banners conditional on `remoteWorkerCount > 0`.

- **Phase 4 — Health check generalization + manual verification + docs.**
  - `MCP_TEST_CONFIG` handler via `McpManager.testConfig()`.
  - `Test` button in every tab's detail panel.
  - Manual verification checklist run (Section 14.7).
  - Docs update (architecture.md pointer, brief README section).

## 17. Deferred / Open Items

- **HTTP transport health check.** `McpManager` supports `stdio` and `sse` today. Adding an http client is a standalone piece of work (spec-side: a new `connectHttp()` method, spec-exercise of Streamable HTTP or a legacy HTTP+SSE hybrid depending on the server's MCP spec version, session lifecycle). Scope a small follow-up after v1 ships. Until it lands, the UI disables the Test button for http configs.
- **Codex SSE transport.** Not documented in Codex CLI; adapter does not expose SSE as a transport option for Codex in v1. Re-verify if user feedback requests it.
- **Codex exec-mode MCP injection.** v1 leaves exec-mode MCP-stripping as-is (see §1 fact #3 and §15.16). A future v2 could pursue a per-server opt-in marker that instructs `prepareCleanCodexHome` to retain specific entries. Requires measuring the startup-cost tradeoff per server.
- **Project-scope writes** — v2 planning with VCS-tracked file guard.
- **Advanced `providerRaw` editor** — v2.
- **Server-side Copilot policy visibility** — not feasible without GitHub API integration; no v2 commitment yet.
- **Remote-worker Shared sync** — v2. Design sketch: Shared record writes originate on the coordinator; an RPC on `WorkerNodeConnection` pushes the (redacted) record + secret re-entry prompt to the worker, which applies it to its local provider configs via a worker-side `CliMcpConfigService` mirror. Would reuse existing `SyncHandler` / `FileTransferService` patterns. Explicitly out of scope for v1.
- **safeStorage for Orchestrator-scope env.** v1 stores env as plaintext in the DB blob (matching current in-memory behavior). Moving to safeStorage for orchestrator scope is a small separable change — needs a migration that re-encrypts existing rows + the same quarantine model as Shared.
- **Bootstrap-file user-override.** A user-editable `userData/mcp-servers.json` layered on top of the bundled `config/mcp-servers.json` would let users inject MCPs into Claude spawns without touching provider user configs. Reasonable v2; bundled file stays read-only.
- **User-facing help pages for MCP `Learn more` links.** The Shared-tab remote-worker banner (§11.1) and the Codex exec-mode tooltip (§11.1) each expose a final `Learn more` link whose destination URL is not yet decided. v1 targets the in-app architecture docs or a README section as a placeholder (resolved during Phase 4 "Docs update"); longer-term, the app ships a dedicated user-docs surface with sections on (a) remote workers + MCP scope and (b) Codex exec vs app-server mode. The labels themselves are final UI copy; only the link targets are deferred.

---

## Appendix A — Existing Subsystems Reused

- `McpManager` (`src/main/mcp/mcp-manager.ts`) — spawn/lifecycle. Gets a new `testConfig(config): Promise<TestResult>` method for ephemeral health checks.
- `McpIpcService` (renderer) — existing orchestrator-scope signals. Unchanged.
- `validateIpcPayload` — existing Zod runner at IPC boundary.
- `getLogger` — structured logging per service.
- `better-sqlite3` — already present for RLM/persistence.

## Appendix B — File layout (new)

```
src/main/mcp/
  mcp-manager.ts                 (existing, +loadFromStore/writeThrough/testConfig)
  mcp-store.ts                   (new — orchestrator_mcp_servers persistence)
  cli-config-service.ts          (new)
  shared-mcp-registry.ts         (new)
  orchestrator-injection-reader.ts (new — bootstrap + codemem view)
  secret-classifier.ts           (new)
  secrets-capability.ts          (new)
  adapters/
    adapter.ts                   (interface)
    claude-code.adapter.ts
    codex.adapter.ts
    gemini.adapter.ts
    copilot.adapter.ts
    __fixtures__/
      claude-code.sample.json
      codex.sample.toml
      gemini.sample.json
      copilot.sample.json

src/main/ipc/handlers/
  mcp-handlers.ts                (existing, unchanged public surface)
  mcp-cli-handlers.ts            (new)
  mcp-shared-handlers.ts         (new)
  mcp-injection-handlers.ts      (new)

src/preload/
  preload.ts                     (existing — EDITED to import + spread the three new domain factories into electronAPI)

src/preload/domains/
  workspace.preload.ts           (existing — contains current orchestrator-scope MCP methods at workspace.preload.ts:254; untouched)
  mcp-cli.preload.ts             (new — createMcpCliDomain factory)
  mcp-shared.preload.ts          (new — createMcpSharedDomain factory)
  mcp-injection.preload.ts       (new — createMcpInjectionDomain factory)

src/preload/generated/
  channels.ts                    (regenerated by npm run generate:ipc; source is packages/contracts/src/channels/index.ts)

src/renderer/app/core/services/ipc/
  mcp-ipc.service.ts             (existing, unchanged)
  cli-mcp-ipc.service.ts         (new)
  shared-mcp-ipc.service.ts      (new)
  mcp-injection-ipc.service.ts   (new)

src/renderer/app/features/mcp/
  mcp-page.component.ts          (refactored to host)
  orchestrator-mcp-tab.component.ts
  orchestrator/
    client-registry.section.ts   (lifted from existing mcp-page component)
    bootstrap-file.section.ts
    codemem-bridge.section.ts
  shared-mcp-tab.component.ts
  provider-mcp-tab.component.ts
  shared/
    server-detail.component.ts
    add-server-form.component.ts
    drift-banner.component.ts
    remote-worker-disclaimer.component.ts
    codex-mode-pill.component.ts  (renders 'app-server' / 'exec' / 'unknown' badge)

packages/contracts/src/channels/
  index.ts                       (existing — EDITED to import, re-export, and spread the three new channel objects)
  mcp-cli.channels.ts            (new)
  mcp-shared.channels.ts         (new)
  mcp-injection.channels.ts      (new)

packages/contracts/src/schemas/provider/
  mcp-cli.schemas.ts             (new)
  mcp-shared.schemas.ts          (new)
  mcp-injection.schemas.ts       (new)
  __tests__/
    mcp-cli.spec.ts
    mcp-shared.spec.ts
    mcp-injection.spec.ts

src/main/persistence/rlm/
  rlm-schema.ts                  (existing — EDITED: append two entries to the MIGRATIONS array at line 51; no new files or directories)

src/shared/types/
  mcp.types.ts                   (existing — EDITED: add the scope union, Redacted DTOs, ProjectReadResult, ManagedReadResult)
  settings.types.ts              (existing — EDITED: three new flat keys on AppSettings + matching SETTINGS_METADATA entries)
```
