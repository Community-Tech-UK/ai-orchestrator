# Bigchange: Settings Control Surface (MCP/CLI self-configuration)

**Date:** 2026-06-11
**Status:** IMPLEMENTED 2026-06-11 (policy/tools/wiring by in-app loop agent; trust-model fixes + IPC hardening corrections by chat agent — see §4 amendments). Verified: full gates green (974 files / 9,621 tests), independent end-to-end code review (no blockers), deployment reachability mapped. Live smoke test (list_settings/set_setting from an agent session) deferred to James after the next app rebuild — the running app's SEA predates the tools.

Two design amendments versus the original draft, settled during implementation:
1. `auxiliaryLlmEndpointsJson` ended up **secret** (agents can neither read nor
   write). The draft's final position was read-only (env-var *names*, not
   credentials, are stored — but an open write path would let an agent point
   aux-slot traffic at an exfiltration endpoint). Secret is strictly safer;
   revisit to read-only if agents need endpoint visibility.
2. Policy tiers gate the **MCP tool surface only**. The renderer IPC path got
   whitelist + value validation but deliberately NOT tier enforcement — the
   Settings UI legitimately writes secret-tier keys (enrollment-token
   regeneration, APNs .p8 upload, TLS paths). Enforcing tiers there broke
   those forms; `coerceRendererSettingValue` in `settings-control-policy.ts`
   is the renderer-trust variant.
**Goal:** Let AIO's settings be read and changed programmatically — by agents running inside AIO (via the orchestrator MCP tools), by automations, and by the CLI — instead of only through the renderer settings UI.

---

## 1. Problem & Motivation

Every settings change today requires a human in the renderer UI. Concrete pain
(2026-06-11): enabling the browser-extension relay on `windows-pc` required a
manual trip to Settings → Remote Nodes, even though the agent driving the E2E
knew exactly which toggle to flip. The same applies to automations ("turn off
auto-index during the nightly campaign"), doctor-style self-repair ("raise the
slot timeout that keeps tripping"), and remote administration from the mobile
gateway.

AIO already has a precedent: agents can create/update/delete **automations**
via MCP tools. Settings should get the same treatment.

## 2. Current State (verified against source, 2026-06-11)

**App settings:**
- Persistence: `electron-store` JSON at `<userData>/settings.json`, managed by
  the `SettingsManager` singleton (`src/main/core/config/settings-manager.ts:74-545`)
  with `set/update/reset/resetOne` and one-shot migrations (`:141-365`).
- Schema: `AppSettings`, 95+ keys in 6 UI domains
  (`src/shared/types/settings.types.ts:32-378`). Several keys are stringified
  JSON blobs (`auxiliaryLlmSlotsJson`, `auxiliaryLlmEndpointsJson`,
  `mobileGatewayDevices`, `defaultModelByProvider`).
- Validation (verified 2026-06-11 — narrower than it looks): `set()`/`update()`
  consult `PAUSE_SETTING_VALIDATORS` (`settings-validators.ts:110-122`), which
  covers **only the 9 pause/VPN keys** (regex safety, host/port, int ranges).
  Every other key is persisted with normalization but **no runtime validation**.
  Worse, the IPC `SETTINGS_SET` handler blind-casts an arbitrary string key
  (`settings-handlers.ts` — `validatedPayload.key as keyof AppSettings`), so
  there is no runtime key whitelist anywhere today. **Consequence for this
  spec: the MCP surface cannot lean on `SettingsManager` for validation — the
  policy map must carry a per-key Zod value schema (Phase 1).**
- Change propagation: `SettingsManager` emits `setting-changed` /
  `setting:{key}` / `settings-updated`; IPC handlers broadcast
  `SETTINGS_CHANGED` to the renderer
  (`src/main/ipc/handlers/settings-handlers.ts:42-232`). **No extra plumbing
  needed for the UI to live-update after a programmatic write.**
- IPC surface exists (get/set/update/reset/export/import channels in
  `packages/contracts/src/channels/infrastructure.channels.ts`, Zod payloads in
  `packages/contracts/src/schemas/settings.schemas.ts`) — but it is
  renderer-only via preload.

**Per-node worker config (separate domain):**
- `extensionRelay` / `browserAutomation` etc. live in the worker's
  `worker-node.json`, hot-pushed via the `config.update` RPC
  (`rpc-schemas.ts` `ConfigUpdateParamsSchema`, renderer form in
  `remote-nodes-settings-tab.component.ts`). The coordinator-side sender is
  invoked from the remote-node IPC handlers.

**Programmatic mutation today:** none for settings. The orchestrator MCP
server exposes automation CRUD + node tools only
(`src/main/mcp/orchestrator-tools-mcp-forwarder.ts:51-370` → RPC →
implementations wired in `orchestrator-tools-step.ts`). No CLI entrypoint
exists either.

## 3. Architecture Decision

**One new surface, three consumers.** Add settings tools to the existing
**orchestrator-tools MCP server**. That immediately serves:
1. **Agents in AIO chats** (this conversation's tooling),
2. **Automations** (each fire inherits the chat toolset),
3. **CLI / scripts** — any MCP client can call the SEA; an optional thin
   `aio-settings` wrapper CLI is a later nicety, not v1.

Do **not** build a parallel write path: the tools' RPC implementations call
the same `SettingsManager.set()/update()` the IPC handlers use, so validation,
migration, events, and renderer broadcast behave identically regardless of who
wrote the setting.

**Two tool families, because two domains:**
- `settings_*` → app settings (`SettingsManager`),
- `update_node_config` → per-node worker config (reuses the existing
  `config.update` RPC sender — the exact path the UI toggle uses). This is the
  tool that would have made today's relay-enable a one-liner.

## 4. Security Model (the real design work)

Settings include secrets and self-amplifying knobs. Three-tier key policy,
enforced in the RPC implementation (not in the forwarder, which runs in the
untrusted-adjacent SEA):

| Tier | Behavior | Examples |
|---|---|---|
| **open** | read + write | theme, fontSize, maxTotalInstances, defaultModel, codebase indexing, slot timeouts |
| **read-only via tools** | read yes, write refused with clear error | feature flags that gate security behavior (e.g. approval/pause settings), `defaultYoloMode` |
| **secret** | neither read nor write; redacted in `settings_list` output | `remoteNodesEnrollmentToken`, mobile-gateway TLS/APNs material, anything matching `/token|secret|key|cert|password/i` |

Decisions to make at implementation time (flagged, not hand-waved):
- The deny/redact list must be an explicit, tested constant
  (`SETTINGS_TOOL_POLICY` map keyed by `keyof AppSettings`), with the regex as
  a backstop for future keys — not the only guard. New keys default to
  **read-only** until classified (fail-closed).
- **JSON-blob keys need explicit classification — the name regex won't catch
  them:** `auxiliaryLlmEndpointsJson` is **secret** (endpoint configs can embed
  API keys/bearer tokens); `mobileGatewayDevices` is **secret** (device pairing
  material). `auxiliaryLlmSlotsJson` and `defaultModelByProvider` are **open**
  but require their object-shape Zod schema on write. None of these match
  `/token|secret|key|cert|password/i`, which is exactly why the explicit map is
  the primary guard and the regex only a backstop.
- Each **open**-tier key carries a Zod value schema in the policy map. This is
  not optional hardening: per §2, `SettingsManager` validates only the 9
  pause/VPN keys, so the tool layer is the *only* runtime validation most keys
  will ever get.
- `defaultYoloMode` and the pause/VPN guard settings are deliberately
  read-only: an agent must not be able to widen its own permissions or
  disable the safety pause.
- **Audit:** settings have no persistent audit trail today (unlike the
  security audit log). v1: every tool-initiated change logs
  `subsystem: SettingsTools` with key, old→new (values redacted for
  secret-tier), and the source (`mcp-tool`). A full audit store is out of
  scope.
- JSON-blob keys: tools accept/return real objects; the implementation
  validates then stringifies. Never make an agent hand-craft
  double-encoded JSON.

## 5. Tool Surface (v1)

All on the orchestrator-tools server, following the `create_automation`
registration pattern (`orchestrator-tools-mcp-forwarder.ts:174-222`):

1. `list_settings` — `{ category? }` → key, current value (redacted per
   policy), default, type, writable flag, restart-required flag, description.
   Discoverability first: an agent must be able to find the right key without
   reading source.
2. `get_setting` — `{ key }` → value (policy-checked).
3. `set_setting` — `{ key, value }` → `{ ok, oldValue, newValue, restartRequired }`.
   Single-key only; refuses read-only/secret tiers.
4. `reset_setting` — `{ key }` → restores default.
5. `update_node_config` — `{ nodeId, browserAutomation?, extensionRelay? }` →
   pushes `config.update` to a connected node, returns the worker's update
   summary. Validates against the existing `ConfigUpdateParamsSchema` blocks.

Deliberately **no** bulk `update_settings` and **no** `import_settings` in v1 —
single-key writes keep the audit trail readable and the blast radius small.

`restartRequired`: some settings only take effect on app/service restart.
Add a `restartRequired: boolean` flag to the per-key policy map (best-effort,
default false) so the tool can tell the caller instead of silently
half-applying.

## 6. Implementation Phases

### Phase 1 — Policy map + RPC implementations
- New `src/main/mcp/orchestrator-settings-tools.ts`: `SETTINGS_TOOL_POLICY`
  (tier + **Zod value schema** + restartRequired per key, fail-closed
  default), the five implementations calling `getSettingsManager()` / the
  node config-update sender, redaction helper, audit logging.
- Opportunistic hardening (small, rides along): make the IPC `SETTINGS_SET`/
  `SETTINGS_UPDATE` handlers validate keys against the same policy map instead
  of blind-casting (`settings-handlers.ts`) — closes the pre-existing
  no-whitelist gap for the renderer path with the same constant.
- Renderer broadcast: reuse the same post-write broadcast the IPC handlers do
  (extract a small shared helper from `settings-handlers.ts` rather than
  duplicating).

### Phase 2 — RPC server + forwarder wiring
- `orchestrator-tools-rpc-server.ts`: route `orchestrator_tools.settings.*`
  methods; inject implementations in `orchestrator-tools-step.ts`.
- `orchestrator-tools-mcp-forwarder.ts`: five tool definitions with JSON-Schema
  `inputSchema`s mirroring the Zod schemas.
- ⚠️ The forwarder runs inside the **aio-mcp SEA** — changes require
  `build:aio-mcp-dist`, not just an app rebuild (same gotcha as the browser
  gateway bridge).

### Phase 3 — Contracts & schemas
- Zod schemas for tool payloads. Prefer extending existing
  `packages/contracts/src/schemas/settings.schemas.ts` — avoids a new
  `@contracts` subpath (Packaging Gotcha #1's three-place alias rule).

### Phase 4 — Verification
- Unit: policy map covers every `AppSettings` key (compile-time
  `Record<keyof AppSettings, …>` makes unclassified keys a type error);
  secret-tier redaction; read-only write refusal; JSON-blob round-trip;
  node-config tool validates nodeId and rejects disconnected nodes.
- Integration: `set_setting('theme', …)` via the RPC path → renderer
  broadcast observed; audit line emitted.
- Gates: `npx tsc --noEmit`, spec tsc, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run test`, plus `build:aio-mcp-dist`.
- Manual: from an agent chat, `list_settings` → flip a benign setting → watch
  the open Settings UI update live → `reset_setting`. Then
  `update_node_config` toggling `extensionRelay.enabled` on `windows-pc` and
  confirm via `browser_health`.

## 7. Out of Scope (v1)

- Standalone CLI binary (`aio settings set …`) — any MCP client already
  works; revisit if there's demand outside agent contexts.
- Bulk update / import-export via tools.
- Persistent settings audit store.
- Mutating project-local `.ai-orchestrator.json` or provider CLI configs.
- A generic "node settings" beyond the existing `config.update` blocks.

## 8. Risks

1. **Self-modification loops** — an automation that changes a setting which
   changes automation behavior. Mitigated by read-only tier on
   orchestration-safety keys and the audit log; accept residual risk.
2. **Policy-map drift** — new settings keys added without classification.
   Mitigated by the compile-time exhaustive `Record<keyof AppSettings, …>`.
3. **SEA staleness** — forwarder tool list cached in an old aio-mcp build;
   document `build:aio-mcp-dist` in the phase and verify in manual E2E.
4. **Renderer staleness for non-broadcast consumers** — main-process services
   that read a setting once at startup won't see tool-driven changes; the
   `restartRequired` flag is the honest signal, but the per-key values need
   auditing during Phase 1 (grep each key's consumers).

## 9. Effort Estimate

| Phase | Scope | Est. |
|---|---|---|
| 1 | Policy map + implementations + audit | 0.75 day |
| 2 | RPC + forwarder wiring + SEA build | 0.5 day |
| 3 | Contracts/schemas | 0.25 day |
| 4 | Tests + manual E2E | 0.5 day |

**Total: ~2 focused days.**
