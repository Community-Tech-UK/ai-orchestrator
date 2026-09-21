# Workspace Secret Card — Implementation Plan

**Status:** Completed 2026-09-20. Live checks deferred to
[2026-08-23-workspace-secret-card_livetest.md](./2026-08-23-workspace-secret-card_livetest.md) (4 open —
real keychain, card rendering, agent reference round-trip, MCP materialisation).
**Date:** 2026-08-23
**Spec:** [2026-08-23-workspace-secret-card_spec_completed.md](./2026-08-23-workspace-secret-card_spec_completed.md)

Phases ship in order. Phase 1 delivers the security property on its own and is
independently valuable; Phases 2–3 add use-sites, scope controls and management.

## As-built status

> **Correction (2026-08-26).** The as-built section previously recorded in this
> plan claimed P2-1, P2-2 (registry/spawn *and* management IPC), P2-3 and P3 as
> "verified", including a migration 062, a workspace/provider-scoped MCP
> connector registry, `browser.fill_secret` accepting a `secret://` reference,
> and a workspace secret management panel. **None of that code is present in the
> repository**, on `main` or in the working tree. The claims were checked
> against source on 2026-08-26 and removed rather than carried forward, because
> a plan that reports unwritten work as verified is worse than no plan. What
> follows is what actually exists.

**Updated 2026-09-02 in this tree.** Phase 1 now has a renderer card. P2-1
`resolve()`, P2-3 `secret://` browser fill, P3 settings, and a metadata-only
Security-page management panel are implemented and unit-tested. P2-2's global
MCP routes now reject `secret://` before write. The workspace-bound MCP
connector registry (migration 062, spawn materialisation) is still absent.

**Verified present (read from source, 2026-08-26):**

- `src/main/secrets/secret-workspace-key.ts` — `toSecretWorkspaceId()` with the
  documented strict canonicalisation, plus its spec.
- `src/main/secrets/workspace-secret-store.ts` — singleton store with
  safeStorage encryption; methods `put`, `list`, `has`, `forget`,
  `recordDeclined`, `auditTrail`. Plus its spec.
- Migration `061_workspace_secrets` in
  `src/main/persistence/rlm/rlm-migrations-061-065.ts`.
- `packages/contracts/src/channels/secret.channels.ts` — `SECRET_CARD_SUBMIT`,
  `SECRET_CARD_DECLINE`, `SECRET_CARD_LIST`, `SECRET_CARD_FORGET`,
  `SECRET_CARD_AUDIT`.
- `src/main/ipc/handlers/secret-card-handlers.ts`, registered from
  `src/main/ipc/ipc-main-handler.ts:247`, with its spec.
- Preload exposure for all five channels at
  `src/preload/domains/instance.preload.ts:636-652`.
- The `'secret_required'` request-type entry in
  `src/renderer/app/features/instance-detail/user-action-request.types.ts`.

**Now present (2026-09-02, this tree):**

- Renderer secret card in `user-action-request` (password input, dedicated
  submit/decline IPC, YOLO does not auto-skip).
- `WorkspaceSecretStore.resolve()` with cross-workspace and unscoped refusal.
- Runtime exact-value redaction backstop registered on `put`, dropped on
  `forget`.
- `browser.fill_secret` accepts `secret://` via `resolveWorkspaceSecret`.
- Settings `workspaceSecretsEnabled` / `workspaceSecretsAllowAgentRequests`
  (read-only + privileged-CLI operator-only).
- Security page "Workspace secrets" panel (list / forget / forget-all).
- Global MCP upsert routes reject `secret://` env values.

**Now also present (2026-09-02, P2-2):**

- Migration `062_workspace_mcp_connectors`.
- Workspace-bound connector registry keyed by `toSecretWorkspaceId` + provider.
- Global MCP routes still reject `secret://`; workspace upserts allow it only in env.
- `SpawnConfigBuilder.getMcpConfig` materialises matching **local** connectors,
  resolving `secret://` in-process. Remote, disabled, unscoped, and mismatched
  providers inject nothing. Missing secrets fail the spawn.
- MCP page "Workspace" tab with an explicit limited-scope form.

This plan stays **active** until a fresh completion-gate pass on this tree
returns PASS. Live card/keychain/materialisation checks stay in the livetest.

---

## Phase 1 — The card

### P1-1 · `toSecretWorkspaceId`
**File:** `src/main/secrets/secret-workspace-key.ts` (new) + `.spec.ts`

> **Placement correction (from the original draft).** This must NOT go in
> `src/shared/utils/workspace-key.ts`. That module is currently *pure* — zero imports —
> and is imported by the renderer (`workboard-projection.ts:16`,
> `automations-page.component.ts:15`). Adding `node:fs`/`node:path` to it would pull Node
> builtins into the Angular bundle. It lives in main-process-only code and imports just
> the `NO_WORKSPACE_KEY` constant from the shared module.

Add `toSecretWorkspaceId(workingDirectory?: string | null): string`, deliberately
stricter than the existing `toWorkspaceId` (which stays untouched — automations and the
Workboard keep their current grouping):

1. blank → `NO_WORKSPACE_KEY`
2. `path.resolve()` — collapses `.`/`..`/trailing separators
3. `fs.realpathSync.native()` inside try/catch — collapses symlinks; on throw
   (path does not exist) fall back to the resolved path
4. lowercase only when `process.platform` is `darwin` or `win32`

Doc comment must state why it diverges, so a later reader does not "helpfully" merge
the two functions.

**Tests:** `/p`, `/p/`, `/p/./`, `/p/sub/..` all equal; symlink equals target; case
folding per-platform; blank → sentinel; a non-existent path still normalises.

### P1-2 · Migration 061
**Files:** `src/main/persistence/rlm/rlm-migrations-061-065.ts` (new),
`src/main/persistence/rlm/rlm-schema.ts` (import + spread)

`061_workspace_secrets` creating `workspace_secrets` and `workspace_secret_audit` per
spec §5.4 and §6. No foreign key — there is no `workspaces` table (workspace identity is
derived). `down` drops both tables.

Follow the shape of `056_governed_proposals` including the explanatory comment block.

### P1-3 · `WorkspaceSecretStore`
**Files:** `src/main/secrets/workspace-secret-store.ts` (new dir), `.spec.ts`

Singleton pattern: lazy `getInstance()`, `getWorkspaceSecretStore()`,
`_resetForTesting()`. Constructor-injected `{ db, safeStorage, now }` so tests never
touch Electron.

Encryption via `getSafeStorage()` from `src/main/session/safe-storage-accessor.ts`.
`isEncryptionAvailable() === false` → throw `SAFESTORAGE_UNAVAILABLE`; never write
plaintext.

API:
- `put({ workspaceId, name, label, purpose, value })` → upsert on
  `UNIQUE(workspace_id, name)`; refuses `NO_WORKSPACE_KEY`
- `list(workspaceId)` → metadata only, never values
- `forget(workspaceId, name)`
- `resolve(...)` — **Phase 2**, added with its scoped consumers rather than exposing a
  Phase 1 placeholder that could be called accidentally

Class doc carries the security contract, mirroring `browser-credential-vault.ts:8-21`:
value never in a thrown error, never in a log line.

**Tests:** fails closed without encryption; round-trip; upsert replaces; `list` returns
no value field; `NO_WORKSPACE_KEY` refused; audit row written per mutation.

### P1-4 · Contracts and schemas
**Files:** `packages/contracts/src/channels/*.channels.ts`,
`src/shared/validation/ipc-schemas.ts`,
`src/renderer/app/features/instance-detail/user-action-request.types.ts`

- `requestType` union gains `'secret_required'`; add the `secretRequest` field (spec §5.1)
- New channels `SECRET_CARD_SUBMIT` / `SECRET_CARD_DECLINE`
- Zod schemas for both payloads

Per AGENTS.md: if a new `@contracts/...` subpath appears, update `tsconfig.json`,
`tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`.

### P1-5 · Preload
**File:** `src/preload/domains/instance.preload.ts`

Expose `submitSecretCard(payload)` and `declineSecretCard(payload)`. No listener needed
— the request arrives on the existing `input-required` event stream.

### P1-6 · Dedicated IPC handler
**File:** `src/main/ipc/handlers/secret-card-handlers.ts` (new)

A separate file, not an added branch in `instance-handlers.ts`. This is the design
invariant made structural (spec §4).

Hard constraints, stated in a header comment:
- must not import `instance-communication`, `sendInputResponse`, or any adapter
- must not log the payload; log only `{ name, workspaceId, valueLength }`

Flow: validate → derive `workspaceId` from the instance's `workingDirectory` via
`toSecretWorkspaceId` → `store.put(...)` → register with redaction backstop (P1-10) →
emit the reference to the agent (P1-9).

Register in the IPC bootstrap alongside existing handler modules.

### P1-7 · Adapter → request mapping
**File:** `src/main/cli/adapters/claude-cli-adapter.ts` (near the existing
`input_required` emission ~1807-1861)

When `metadata.type === 'secret_required'`, carry `name`/`label`/`purpose` through onto
the emitted payload so the renderer can build the card. Agent supplies no value.

### P1-8 · The card UI
**Files:** `user-action-request.component.ts` / `.html` / `.scss`

New branch rendering `<input type="password" autocomplete="off" spellcheck="false">`,
"Save securely" / "Decline", the `purpose` text verbatim, and the footer
*"Stored encrypted on this Mac. Never shown to the agent."*

Plaintext lives in a component-local signal cleared in a `finally` after submit. It must
not be written into `inputRequiredTexts` or any map that feeds `respond()`.

`OnPush`, signals, `inject()` per `docs/angular-conventions.md`.

### P1-9 · Reference emission
Agent receives `secret://<name>` — and only that — through the ordinary input-response
path. Safe because it carries no secret material.

Decline sends a plain refusal string.

### P1-10 · Redaction backstop
**Files:** `src/main/security/secret-detector.ts`, `src/main/secrets/*`

Runtime-registered exact-value matcher so a stored value is masked if it ever reaches
`redactForEgress` (11 non-test call sites). In-memory only; never persisted into
detector config. Registered on `put`, dropped on `forget`.

### P1-11 · Invariant test — the important one
**File:** `src/main/secrets/secret-card-invariant.spec.ts`

> **Placement correction.** The neighbouring secret tests are flat in
> `src/main/secrets/`, so the invariant test follows that local convention rather than
> introducing a one-file `__tests__` directory.

Submit through the secret channel, then assert the plaintext appears in **none** of:
- adapter `sendRaw` (spy)
- the continuity queue (`instance-event-forwarding` path)
- captured logger output
- `redactForEgress` output

Plus the LT-018 discipline: each guard's test must be shown to fail when its guard is
removed. A test that cannot fail proves nothing.

---

## Phase 2 — Use by reference

### P2-1 · `resolve()`
`WorkspaceSecretStore.resolve(ref, { workspaceId, purpose, instanceId })`:
refuses cross-workspace, refuses `NO_WORKSPACE_KEY`, stamps `last_used_at`, writes an
audit row, never logs or throws the value.

**Tests:** workspace A cannot read workspace B's ref; audit row written; error messages
contain no value.

### P2-2 · Workspace-bound MCP connector install

> **Scope correction (2026-08-24).** The original `CliMcpConfigService` route writes
> provider-user, shared, or orchestrator configuration. All three are global/reusable,
> so resolving `secret://` there would make a workspace-scoped credential available to
> an instance from another workspace. Those routes now reject the reference before any
> write. They are not a safe consumer.

Add a workspace-bound connector registry, surfaced as a distinct MCP-management scope:

- registry records are keyed by canonical `toSecretWorkspaceId(workingDirectory)` and
  a selected target provider; they retain only the opaque reference in a connector env
  value. The registry must use the existing encrypted-at-rest MCP secret handling for
  any ordinary sensitive fields and must reject a `secret://` value outside `env`.
- the renderer supplies a working-directory path, but the main process canonicalises it
  before persistence. The workspace connector form must make its limited scope explicit
  and must not silently fall back to a global provider/shared/orchestrator record.
- `SpawnConfigBuilder.getMcpConfig(...)` receives the instance working directory and
  materialises only matching records for that local instance and provider. It resolves
  the reference immediately before building the ephemeral local MCP config, attributes
  the audit record to the instance, and never writes the plaintext to a reusable CLI
  config file or returns it over IPC.
- remote instances receive no local connector materialisation. Missing, disabled,
  unscoped, cross-workspace, and failed-decryption paths fail closed without including
  a plaintext in an error or log.

Tests must prove matching workspace/provider injection, non-matching and remote
exclusion, failure-before-spawn on unavailable secrets, audit attribution, and that the
global MCP persistence routes continue to refuse references.

### P2-3 · Browser fill bridge
Map a `secret://` ref onto `fillSecretOperation`
(`browser-secret-fill-operation.ts:28-188`), reusing its digest verification and
counts-only return. Gate behind the existing credential-authorization checks rather than
inventing a second authorisation model.

---

## Phase 3 — Scope, audit, management

### P3-1 · Settings
`workspaceSecretsEnabled` and `workspaceSecretsAllowAgentRequests`, both defaulting
`true`, both classified `readOnly()` in `SETTINGS_TOOL_POLICY`. Touch all the sites the
existing `browserAllowSharedTabCredentialFill` touches: `settings.types.ts`,
`settings-defaults.ts`, `settings-metadata-runtime.ts`, `settings-control-policy.ts`,
`settings-export.ts`.

**Test:** `set_setting` on both keys is refused.

### P3-2 · Audit surfacing
Read API over `workspace_secret_audit`, metadata only.

### P3-3 · Management panel
Control Center page: per workspace list (name, label, purpose, created, last used) with
rename / replace / forget and a bulk "forget all for this workspace". Values never
rendered. States plainly that removing a workspace does not auto-delete its secrets,
since no cascade exists.

Check the page against the Control Center layout constraint (`.control-body` grid row)
that clipped 52 routes previously.

---

## Verification gate (run before completion)

```
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run build:main
npm run test:quiet
```

`build:main` is mandatory — it is the only gate that runs `sync-dist.js`, and the only
one that catches a broken Electron build while both `tsc --noEmit` runs stay green.

Then the Completion Fresh-Eyes Gate: an independent agent reviews merge-base→HEAD using
`task-completion-gate`, and every actionable finding is fixed and re-reviewed until
`VERDICT: PASS`.

## Live-test deferral

Anything needing a rebuilt app (the card rendering, real keychain encryption, the real
agent round-trip) goes into `2026-08-23-workspace-secret-card_livetest.md` rather than
being claimed as verified. Unit/integration-testable behaviour is verified in-loop.

---

## Risks

| Risk | Mitigation |
|---|---|
| A future edit routes the secret back into the CLI | Separate handler file + invariant test (P1-11) |
| Stricter workspace id confuses users vs Workboard grouping | Documented divergence; failure is closed, not open |
| Keychain unavailable | Fails closed; card reports it cannot store |
| Dirty tree (94 unrelated modified files) | Never `git add -A`; stage only this feature's paths |

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.
