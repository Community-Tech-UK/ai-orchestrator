# Workspace Secret Card — Specification

**Status:** Completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. The historical status below is kept because it records a real correction — an earlier as-built claim overstated what was built, and the gap was then closed.

Superseded status: Planned — implementation active, and **less complete than the plan claimed**. A source
check on 2026-08-26 found that Phase 1's main-process half exists (store, migration 061, IPC
handlers, preload) but its **renderer card does not**, and that P2-1, P2-2, P2-3 and P3 are
entirely unwritten despite having been recorded as "verified". See the correction at the top of
the implementation plan before doing any work against this spec.

**Date:** 2026-08-23
**Owner:** James
**Implementation plan:** [2026-08-23-workspace-secret-card_plan_completed.md](./2026-08-23-workspace-secret-card_plan_completed.md)
**Prior art reviewed:** xAI Grok Bot "secure secret card" (see Appendix B)

---

## 1. Problem

An agent mid-turn often needs a credential it cannot obtain itself: a GitHub PAT to
install a connector, an API key for a service, a webhook secret. Today the only way
for the user to supply one inside the app is the `input_required` card, whose every
free-text control is a `<textarea>` (`user-action-request.component.html:16,72,104,165`).

Answers typed into that card are, by design, forwarded to the agent CLI:

- `instance-handlers.ts:1233-1238` — *"Standard input_required flow — send the response
  to the CLI via stdin"* → `instanceManager.sendInputResponse(...)`
- `instance-communication.ts:1104-1105` — `adapter.sendRaw(response, permissionKey)`

Two further sinks make this worse than a single disclosure:

- **Log sink.** `sendInputResponse` logs `summarizeInputResponse(response, ...)` at
  info level, which includes `responsePreview: summarizeLogText(response)`
  (`instance-communication.constants.ts:53`). The value reaches `app.log`.
- **History sink.** Every `message.type === 'user'` is enqueued to session continuity
  with `content` verbatim (`instance-event-forwarding.ts:252-268`). Unconditional.

Once a secret is in conversation history it is also in scope for loop memory, session
sharing, and **cross-model review**, which forwards context to other vendors
(Codex/Copilot/Gemini). A single pasted token therefore fans out to third parties.

## 2. Goal

Provide a **secure secret card**: an inline, masked input rendered in the conversation
that accepts a credential from the user, stores it encrypted, scoped to the workspace,
and returns to the agent only an opaque **reference**. The agent can cause the secret to
be *used* without being able to *read* it.

## 3. Non-goals

- Replacing Bitwarden or the existing browser Agent Credential Vault
  (`browser-credential-vault.ts`). This is for non-website secrets.
- Becoming a general password manager.
- Defending against a determined agent with shell access running as the user
  (see §9, Threat model — stated limits).
- Changing the `GITHUB_TOKEN` / `GH_TOKEN` env passthrough in
  `env-filter.ts:283-294`. Explicitly out of scope by decision (§10, D3).

## 4. Design invariant

> The plaintext never traverses any code path that can reach the CLI, the log, or the
> conversation history.

This is enforced **structurally, not conditionally**. The secret travels on a dedicated
IPC channel with no code path to `sendInputResponse`.

Rejected alternative: branching inside the existing `input_required` handler before
`sendInputResponse`. Rejected because that handler already logs a response preview and
falls through to the CLI write; a future edit adding another fall-through would silently
defeat a conditional branch. A separate channel cannot be defeated this way — it is
fail-safe by construction rather than by vigilance.

## 5. Architecture

### 5.1 Request (main → renderer)

New `UserActionRequest.requestType`: `'secret_required'`
(`user-action-request.types.ts`). Carries a new field:

```ts
secretRequest?: {
  /** Stable slug, unique per workspace. e.g. 'github-pat' */
  name: string;
  /** Human label shown on the card. e.g. 'GitHub personal access token' */
  label: string;
  /** What it will be used for; shown to the user and recorded in the audit row. */
  purpose: string;
  /** Optional shape hint used for a client-side format warning only. */
  expectedFormat?: 'github_pat' | 'openai_key' | 'bearer' | 'opaque';
};
```

The agent requests one by emitting an `input_required` with
`metadata.type === 'secret_required'`; the adapter maps it to this requestType.
The agent supplies `name`, `label`, `purpose` — never a value.

### 5.2 Card (renderer)

New branch in `user-action-request.component.html` rendering
`<input type="password" autocomplete="off" spellcheck="false">`, plus:

- a "Save securely" action and a "Decline" action;
- the `purpose` string, verbatim, so the user sees what they are authorising;
- footer: *"Stored encrypted on this Mac. Never shown to the agent."*;
- no value ever written to component state that is serialised, logged, or included in
  any existing IPC payload.

The component holds the plaintext in a local signal that is cleared in a `finally`
block immediately after submission.

### 5.3 Submission (renderer → main) — the dedicated channel

New channel pair in `packages/contracts/src/channels/`:

```
SECRET_CARD_SUBMIT : 'secret-card:submit'
SECRET_CARD_DECLINE: 'secret-card:decline'
```

Zod schema in `src/shared/validation/ipc-schemas.ts`. The submit payload carries
`{ instanceId, requestId, name, value }`.

Hard requirements on this handler:

- It **must not** import or call `sendInputResponse`, `sendRaw`, or any adapter method.
- It **must not** log the payload. A lint-visible comment states this; the handler logs
  only `{ name, workspaceId, valueLength }`.
- On success it calls `WorkspaceSecretStore.put(...)` and then notifies the agent via
  the *reference* path (§5.5).

### 5.4 Storage — `WorkspaceSecretStore`

New main-process singleton `src/main/secrets/workspace-secret-store.ts`, following the
established singleton pattern (lazy `getInstance()`, `getWorkspaceSecretStore()`,
`_resetForTesting()`).

Encryption uses `getSafeStorage()` from `src/main/session/safe-storage-accessor.ts`
— the canonical mockable seam — **not** a fresh inline `require('electron')`.
Encryption **fails closed**: if `isEncryptionAvailable()` is false the store throws and
the card reports that secrets cannot be stored on this machine. (This mirrors
`McpSecretStorage.encryptSecret`, `mcp/secret-storage.ts:33`, which throws rather than
writing plaintext. Note: its `plaintext-quarantined` status is honoured only on the
*decrypt* path for legacy rows; it is never produced on write.)

New migration, following the `034_automation_workspace_id` pattern
(`rlm-migrations-022-035.ts:625-640`):

```sql
CREATE TABLE IF NOT EXISTS workspace_secrets (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL,
  name          TEXT NOT NULL,
  label         TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  value_enc     TEXT NOT NULL,      -- base64 safeStorage ciphertext
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  UNIQUE(workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace
  ON workspace_secrets(workspace_id);
```

**No foreign key.** There is no `workspaces` table — workspace identity is derived, not
persisted (§5.6). An FK would fail to apply.

### 5.5 Reference, and how the agent learns of it

The agent never receives the value. On successful save the agent receives a normal
input response containing only:

```
secret://<name>
```

This response goes through the ordinary CLI path, which is safe because it contains no
secret material. The agent stores that string and passes it to tools.

### 5.6 Workspace scoping

Per decision D2 (§10), secrets are scoped per workspace.

Workspace identity today is **derived, not stored**: `toWorkspaceId(workingDirectory)`
in `src/shared/utils/workspace-key.ts:26-29` is `trim().toLowerCase()`, with
`NO_WORKSPACE_KEY = '__no_workspace__'` for blank. There is no workspaces table.

That normalisation is adequate for grouping automations in a UI but **too loose to key a
credential store**: `/Users/x/proj` and `/Users/x/proj/` produce different ids, as do a
symlink and its target. The failure is closed (a lookup misses) rather than open, so it
is a usability hazard, not a disclosure hazard — but it would present as "the agent
can't find the token I just saved."

This spec therefore introduces `toSecretWorkspaceId(workingDirectory)` in the same
module, deliberately stricter:

1. `path.resolve()` to remove `.`/`..` and trailing separators;
2. `fs.realpathSync.native()` where the path exists, to collapse symlinks;
3. lowercase **only** on `darwin`/`win32` (case-insensitive filesystems); preserve case
   on Linux, where `/A` and `/a` are genuinely different directories;
4. blank → `NO_WORKSPACE_KEY`.

It is documented as intentionally divergent from `toWorkspaceId`, with a test asserting
that `/p`, `/p/`, and a symlink to `/p` all map to one id while `toWorkspaceId` does not.

**Secrets in the `__no_workspace__` scope are refused.** A secret must belong to a real
directory; otherwise every scratch instance would share one credential pool.

### 5.7 Resolution and use (Phase 2)

`WorkspaceSecretStore.resolve(ref, { workspaceId, purpose })` returns plaintext **only**
to main-process callers. It:

- refuses if the calling instance's workspace ≠ the secret's workspace;
- refuses a `__no_workspace__` caller;
- stamps `last_used_at` and writes an audit row;
- never places the value in a thrown error or a log line
  (matching the vault contract, `browser-credential-vault.ts:20`).

Two consumers in Phase 2:

- **Workspace-bound MCP connector install.** The existing
  `CliMcpConfigService.providerUserUpsert`, shared, and orchestrator routes are global
  configuration scopes. They must reject `secret://` before writing: resolving there
  would leave a workspace credential reusable by a later instance from another workspace.
  A distinct workspace connector registry is keyed by canonical
  `toSecretWorkspaceId(workingDirectory)` and target provider. It stores opaque
  references in env entries only (ordinary sensitive values retain the established
  encrypted-at-rest MCP handling), and `SpawnConfigBuilder.getMcpConfig(...)` resolves
  them only while building an ephemeral config for a matching **local** instance/provider.
  The renderer-provided path is canonicalised in main; remote, unscoped, mismatched,
  disabled, and failed-decryption paths fail closed. Plaintext is never written into a
  reusable provider config file or returned over IPC.
- **Browser fill.** Bridge `secret://` refs to the existing `fillSecretOperation`
  (`browser-secret-fill-operation.ts:28-188`), which already types values straight into
  the page via `driverType` and verifies by worker-side non-reversible digest comparison
  — only `filled`/`verified` counts leave the function, never a value or digest
  (`browser-secret-fill-operation.ts:22-24,143-154,183`).

### 5.8 Settings and agent-proofing (Phase 3)

Two new keys, both classified in `SETTINGS_TOOL_POLICY`
(`settings-control-policy.ts`):

| Key | Default | Tier |
|---|---|---|
| `workspaceSecretsEnabled` | `true` | `readOnly()` |
| `workspaceSecretsAllowAgentRequests` | `true` | `readOnly()` |

`readOnly()` is enforced — `assertWritableSetting` refuses any tier that is not `open`
(`orchestrator-settings-tools.ts:352`), and mutations are audited via
`logSettingMutation`. An agent therefore cannot use the settings CLI to widen its own
access. No key in this feature may ever be `open`.

### 5.9 Management UI (Phase 3)

A Control Center panel listing, per workspace: name, label, purpose, created, last used.
Actions: rename, replace value, **forget**. Values are never rendered — only metadata.

Because there is no workspace-deletion cascade anywhere in the schema (verified: no
cleanup-hook registry exists), removing a workspace does **not** destroy its secrets.
"Forget" is the only deletion path, plus a "forget all for this workspace" bulk action.
This limitation is stated in the UI rather than papered over.

## 6. Audit

New `workspace_secret_audit` table: `{ id, workspace_id, secret_name, event, instance_id,
purpose, at }` where `event ∈ {created, updated, resolved, declined, forgotten}`.
Never stores the value. Surfaced in the management panel.

## 7. Redaction backstop

Belt and braces, because the invariant should not be the only defence. On save, register
the value with the existing detector/redaction layer so that if it ever appears in
egress content it is masked:

- `secret-detector.ts` gains a runtime-registered exact-value matcher;
- `redactForEgress` (`content-egress-gate.ts`, 11 non-test call sites) then covers loop
  memory, cross-model review, indexing and channels automatically.

Registered values live in memory only, never persisted to the detector's config.

## 8. Test plan

- `toSecretWorkspaceId`: trailing slash, `..`, symlink, case per-platform, blank.
- Store: fails closed when `isEncryptionAvailable()` is false; round-trips otherwise;
  `UNIQUE(workspace_id, name)` upsert semantics.
- **Invariant test (the important one):** submit via the secret channel, then assert
  that the plaintext appears in *none* of — adapter `sendRaw` calls (spy), the continuity
  queue, `app.log` output, or any `redactForEgress` output. A regression here is the
  whole feature failing.
- Cross-workspace refusal: workspace A cannot resolve workspace B's ref.
- `__no_workspace__` refusal on both store and resolve.
- Settings policy: `set_setting` on both new keys is refused.
- A deliberate revert-each-fix check: each guard's test must fail when its guard is
  removed (per the LT-018 lesson — a passing test that cannot fail proves nothing).

## 9. Threat model — stated limits

**Defends against** (the realistic threat): a token entering model context by paste,
prompt injection, or ordinary sloppiness, and from there fanning out to conversation
history, loop memory, `app.log`, and third-party vendors via cross-model review.

**Does not defend against:** an agent with shell access running as the user. Our agents
run locally with Bash on the same machine as the SQLite DB and the keychain, which is a
materially weaker position than Grok's remote-computer model. macOS keychain ACLs bind
the safeStorage key to the signed app, which raises the cost for a child shell but is not
an absolute boundary, particularly for unsigned dev builds.

Stated plainly so nobody later mistakes this for a sandbox. It is a blast-radius
reduction, and a large one.

## 10. Decisions taken

| # | Decision | Choice |
|---|---|---|
| D1 | Build scope | All three phases |
| D2 | Scope granularity | **Per workspace** (not per instance) |
| D3 | `GITHUB_TOKEN` env passthrough | **Leave as-is**; revisit after Phase 2 |
| D4 | Fork point | Dedicated IPC channel, not a branch in `input_required` |
| D5 | Workspace id | Stricter `toSecretWorkspaceId`, not reused `toWorkspaceId` |

D3 consequence, recorded deliberately: while the env passthrough stands, a GitHub token
supplied through the secure card is protected from transcript/history/vendor fan-out, but
an agent that can run `echo $GITHUB_TOKEN` may still read a token supplied by the
*environment*. These are different tokens by different routes; the card is not weakened,
but it is not a total solution for GitHub specifically until D3 is revisited.

## 11. Phases

- **Phase 1 — the card.** §5.1–5.6, plus §7 and the §8 invariant test. Ships the security
  property on its own.
- **Phase 2 — use by reference.** §5.7. MCP connector install and browser fill.
- **Phase 3 — scope, audit, management.** §5.8, §5.9, §6.

---

## Appendix A — Verified existing foundations

| Capability | Location | State |
|---|---|---|
| Encryption seam | `session/safe-storage-accessor.ts` | Lazy, mockable, canonical |
| Fails-closed encrypt | `mcp/secret-storage.ts:33` | Throws when unavailable |
| Scoped standing grants | `browser-credential-authorization-store.ts` | origin/purpose/expiry/revoke |
| Secret fill without model exposure | `browser-secret-fill-operation.ts:28-188` | digest-verified |
| Egress redaction | `content-egress-gate.ts` | 11 non-test call sites |
| Agent-proof settings | `settings-control-policy.ts` + `orchestrator-settings-tools.ts:352` | enforced |
| Workspace id derivation | `shared/utils/workspace-key.ts:26-29` | derived, no table |

## Appendix B — Prior art: Grok Bot

Contract, verbatim from xAI docs: *"The value is masked, excluded from the transcript,
and not shown to the model."* Interactive secrets (passwords, passkeys, 2FA, CAPTCHA,
payments) are refused and the user is handed the screen.

Their scoping is account-wide and explicitly not a security boundary: *"Do not place a
credential or file on it if another Bot on your account should not be able to use it"*;
screens are *"separate work surfaces, not separate security boundaries."* Storage and
injection internals are undocumented.

We take the UX and reject the scoping — the per-workspace boundary in D2 is strictly
tighter than theirs.
