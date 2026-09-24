# Live tests — Workspace Secret Card

## Status — 2026-09-24 (verify-ui)

Open: 0 · Closed: 4 · Failed: 0
Re-ran check 1 live against the WORKING TREE's uncommitted LT-641 fix (`secret_required` added to
the strict `UserActionRequestEventSchema`), in an already-open instance view, without navigating
away and back — see
[Evidence run — 2026-09-24 (verify-ui)](#evidence-run--2026-09-24-verify-ui). **LT-641 CONFIRMED
FIXED LIVE**, resolving the 2026-09-24 orchestrator correction below: the agent's `secret_required`
request rendered via the live push channel (`user-action:request`) with the view already mounted,
and `app.log` shows zero `Blocked invalid renderer event payload` entries for that channel in this
run's window. The failed-save clearing half of check 1 was re-run too (placeholder
`lt-placeholder-0924`) and still clears the password input on a failed save. **This document's four
checks now all pass with current evidence, including the push-channel path the orchestrator
correction below said still needed re-verification.**

## Status — 2026-09-24 (settings)

Open: 0 · Closed: 4 · Failed: 0
Re-ran all four checks against HEAD `f04f6748` with a real macOS keychain, a real Claude session,
and the agent driving the whole flow itself (not adapter-injected) — see
[Evidence run — 2026-09-24 (settings)](#evidence-run--2026-09-24-settings). **LT-548, LT-549,
LT-550 and LT-551 are all CONFIRMED FIXED LIVE.** All four checks in this doc now pass with current
evidence; this document is a candidate for `_livetest_completed` (the orchestrator renames it).

## Status — 2026-09-20
Open: 4 · Closed: 0 · Failed: 4
All four checks ran to completion against a rebuilt dev app with a real macOS keychain and real
provider sessions — see [Evidence run — 2026-09-20](#evidence-run--2026-09-20--dev-app-from-the-queue-worktree).
Each one reproduced a defect, so none closes: **LT-548** (the materialised secret is passed to the
CLI on its command line), **LT-549** (the card keeps a rejected credential in its password input),
**LT-550** (management hides the name, the timestamps and the audit trail) and **LT-551** (no agent
can raise the card at all). Nothing here needs James; none of the four is an operator boundary.

### Status — 2026-09-06 (superseded)
Open: 4 · Closed: 0 · Failed: 0
Needs a rebuilt/restarted app with an available macOS keychain and a real provider session. All four checks are runnable — the feature is built (verified against source 2026-09-06, see the correction below).

> **Found a defect while running these checks?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-23-workspace-secret-card_plan_completed.md](./2026-08-23-workspace-secret-card_plan_completed.md)

> **✅ Correction, 2026-09-06 — these checks are now runnable.** A 2026-08-26 audit found the
> feature did not exist and this file carried a "do not run" warning for eleven days. That
> warning was correct on the day and is now obsolete. Re-verified against the source tree, not
> against any plan's own as-built claim:
>
> - migration `062_workspace_mcp_connectors` — `src/main/persistence/rlm/rlm-migrations-061-065.ts:64`
> - `WorkspaceSecretStore.resolve()` — `src/main/secrets/workspace-secret-store.ts:175`
> - workspace-bound connector registry — `src/main/mcp/workspace-mcp-connector-repository.ts`
> - spawn materialisation — `src/main/mcp/workspace-mcp-connector-materialize.ts`
> - `secret://` handling — `src/main/secrets/workspace-secret-fill.ts`, and the renderer panel at
>   `src/renderer/app/features/mcp/workspace-mcp-connectors-panel.component.ts`
>
> Landed in commit `ca09eeefb` ("livetest fixes"). Check 4 in particular was recorded as blocked
> on unbuilt work; it is not.

## Prerequisites

- A rebuilt and restarted Harness app running this worktree's main and renderer
  (`npm run build:main`, current renderer server, then Electron relaunch). The
  already-open installed app cannot provide evidence for this uncommitted code.
- A macOS login keychain available to the running Electron app. Never disable
  encryption or substitute a plaintext test double for this check.
- A locally authenticated provider session able to request a `secret_required`
  input card. The agent must be instructed to request a value by metadata only;
  it must not be given a value in its prompt.
- For browser-fill check 4, a separate disposable site/account, explicit
  `secret_fill` authorization, and a page owned by the operator. Do not use a
  personal, production, or government credential.

Why deferred: unit/integration checks prove the handler, encryption seam,
reference routing, and redaction invariants, but only a rebuilt Electron runtime
with an available OS keychain and a real provider/session can prove the card,
native keychain, and agent boundary together.

## 1. Card rendering and failed-save clearing

1. Launch the rebuilt app with a fresh disposable development profile and open
   an instance that emits a `secret_required` request with name `demo-token`, a
   human-readable label, and purpose `Live-test only`.
2. **Expected:** the request renders one masked password input, its purpose,
   `Save securely` / `Decline`, and the exact footer `Stored encrypted on this
   Mac. Never shown to the agent.` No generic free-text `input_required`
   textarea appears for the request.
3. Temporarily make the keychain unavailable using the supported test profile
   or cancel its prompt; enter an obvious non-production test value and select
   `Save securely`.
4. **Expected:** the request remains, an error is visible, its password input
   is empty, and `Save securely` is disabled until the operator enters a new
   value. The failed value must not appear in the rendered transcript, devtools
   console, or app log.

## 2. Native keychain persistence and metadata-only management

1. Restore keychain availability and enter a fresh disposable test value in the
   same card, then select `Save securely`.
2. **Expected:** the card resolves; Workspace Secrets management for that
   exact canonical workspace lists the name, label, purpose and timestamps but
   never the value. Its audit trail records metadata-only creation/use fields.
3. Restart the rebuilt app, return to the same workspace, and open the panel.
4. **Expected:** the metadata remains available, no value is rendered or
   returned by the renderer IPC surface, and the value cannot be recovered from
   logs or SQLite inspection. Do not print ciphertext or query any value-bearing
   field while collecting evidence.

## 3. Agent reference-only round trip

1. Start a fresh authenticated local provider instance in the same workspace.
   Ask it to request `demo-token` using `metadata.type = secret_required`; do
   not put a credential value in the agent prompt.
2. Submit a disposable test value through the card.
3. **Expected:** the agent receives only `secret://demo-token`; no value is
   present in streamed output, conversation history, continuity queue, app log,
   loop artefacts, or cross-model review context. The metadata audit captures
   the request/store event without a value.
4. Ask the agent to repeat the reference. **Expected:** it can refer to the
   opaque name but cannot read, display, or infer the stored value.

## 4. Authorized local consumer materialisation

1. Configure a workspace-bound local MCP connector using only
   `secret://demo-token` in its allowed environment reference field, with a
   matching local provider and canonical workspace path.
2. Launch a local instance for that provider and workspace.
3. **Expected:** the connector receives its ephemeral materialised value only
   at spawn, the workspace audit records the authorized use, and neither the
   connector-management UI nor reusable provider/shared/orchestrator MCP
   configuration exposes the value.
4. Repeat with a different workspace, provider, and remote instance.
5. **Expected:** no materialisation occurs; the failed path is value-free.

## Evidence

- Recorded in [Evidence run — 2026-09-20](#evidence-run--2026-09-20--dev-app-from-the-queue-worktree).
- Recording rule for any future run: capture the app build/relaunch, keychain
  state (available/unavailable only), provider/runtime used, and observed
  results per item without recording a credential, ciphertext, token-shaped
  string, or secret-derived digest.

## Current status clarification — 2026-08-31

This document is pending live validation, not pending implementation. The main-process secret store,
secret-card IPC handlers, IPC registration, preload list/forget/audit bindings, renderer
`secret_required` request type, migration, and focused tests exist in the current tree. The remaining
work is the rebuilt runtime boundary described above. It needs James only for entering an obvious
disposable test value and handling any native keychain prompt; an agent may drive and inspect the
value-free metadata/reference flow but must never receive or print the value.

## Evidence run — 2026-09-20 — dev app from the queue worktree

**Environment.** Dev app built and launched from
`/Users/suas/work/orchestrat0r/ai-orchestrator/.worktrees/queue/2026-08-23-workspace-secret-ca-4b8813`
(branch `queue/2026-08-23-workspace-secret-ca-4b8813`). `npm run build:main` green;
renderer served from `ng build --configuration development` on `:4567` via `http-server` after
`ng serve` failed with the known Angular JIT/linker error and left `app-root` empty — clearing
`.angular/cache` did not help, so the built-bundle route from the campaign notes was used instead.
Isolated profile `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-d34b8813`, renderer CDP on `:9544` with
`Emulation.setFocusEmulationEnabled` applied before every DOM assertion (`document.hidden: false`),
main-process inspector on `:9545`. Main process confirmed `isPackaged: false`,
`userData: /tmp/aio-lt-queue-d34b8813`, `safeStorage.isEncryptionAvailable(): true` — a real macOS
login keychain, never a test double.

Disposable workspace `/tmp/aio-lt-queue-d34b8813-ws` (canonical
`/private/tmp/aio-lt-queue-d34b8813-ws`) and a second `…-ws2` for the negative cases. Provider:
locally authenticated Claude, real sessions, real turns. Every value used was an obvious
non-credential placeholder of the form `LIVETEST-PLACEHOLDER-NOT-A-CREDENTIAL-<n>`; no value,
ciphertext, length-derived digest or token-shaped string is recorded below.

**Result: 0 of 4 checks close. All four ran to completion and each reproduced a defect** — LT-548,
LT-549, LT-550, LT-551. Nothing here needs James; none of the four is an operator boundary.

---

### Check 1 — card rendering and failed-save clearing — FAILS at step 4 (LT-549)

Steps 1–2 pass. The `secret_required` request was injected at the real adapter boundary —
`ClaudeCliAdapter.processCliMessage({type:'input_required', metadata:{type:'secret_required',
name:'demo-token', label:'Demo live-test token', purpose:'Live-test only'}})` on the live adapter of
a running instance — so the whole main-side path ran: adapter → `InstanceCommunicationManager` →
`InstancePermissionRequestFlow` (including the LT-537 operator gate) → renderer. Injecting there was
necessary, not a shortcut: see check 3, no provider can emit this itself.

Rendered card, read from the live DOM:

| Assertion | Observed |
| --- | --- |
| Masked password inputs | 1 |
| Generic free-text textareas for the request | 0 |
| Purpose | `Live-test only` |
| Label | `Demo live-test token` |
| Buttons | `Decline` (enabled), `Save securely` (disabled until a value is typed) |
| Footer, verbatim | `Stored encrypted on this Mac. Never shown to the agent.` |

Steps 3–4 fail. `safeStorage.isEncryptionAvailable` was patched to return `false` in the running
main process — the real seam `WorkspaceSecretStore.put` reads, so the store's fail-closed path,
`SafeStorageUnavailableError`, and the handler's `SECRET_CARD_ENCRYPTION_UNAVAILABLE` mapping all
executed for real. A placeholder was typed and `Save securely` clicked:

- Request remains — **pass**
- Error visible: `This Mac cannot encrypt secrets right now, so nothing was saved.` — **pass**
- `Save securely` disabled — **pass**
- Password input empty — **FAIL**, `input.value.length === 39`, still the rejected value

Reproduced a second time with a fresh placeholder: identical result, and `Save securely` correctly
re-enabled on retype before failing again. Filed as **LT-549**.

No leak on the failed path. 0 occurrences of the placeholder in the renderer console across the
submit (25 console messages captured over the CDP connection), 0 in `document.body.innerText`, 0 in
the transcript, 0 in the 9.3 MB `app.log`. The two main-process warn lines carried metadata only:

```
"Refusing to store secret; safeStorage unavailable"
{"workspaceId":"/private/tmp/aio-lt-queue-d34b8813-ws","name":"demo-token"}
```

That `workspaceId` also confirms `toSecretWorkspaceId` canonicalising the `/tmp` symlink live.

### Check 2 — native keychain persistence and metadata-only management — FAILS at step 2 (LT-550)

Keychain restored (`isEncryptionAvailable(): true`), a fresh placeholder entered, `Save securely`
clicked: the card resolved and disappeared.

Storage and scoping — **pass**:

- `listWorkspaceSecrets` returns `{id, workspaceId, name, label, purpose, createdAt, updatedAt,
  lastUsedAt}`. No value field exists on the type or in the payload.
- `/tmp/…-ws`, `/private/tmp/…-ws` and `/private/tmp/…-ws/` all resolve to the one row;
  `/private/tmp` returns 0.
- `WorkspaceSecretStore.resolve` for workspace `/private/tmp` was refused:
  `That workspace secret does not exist`.
- Audit after the save: one `created` row with `instanceId`, `purpose`, `at` — no value column.

Restart — **pass**. The app was stopped and relaunched on the same isolated profile. Metadata
survived unchanged, the panel still listed the secret, and `resolve()` decrypted the stored value
successfully after the restart (reported only as `valueLength: 39`, prefix check `true`), proving
the OS keychain round trip rather than an in-memory cache. `last_used_at` and a second audit row
`resolved / purpose livetest-persistence-proof` appeared as expected.

Not recoverable from logs or storage — **pass**. Binary-safe sweep (`LC_ALL=C grep -ral`) of the
entire isolated profile — `rlm.db` and its WAL, `conversation-ledger.db`, `session-events/*.jsonl`,
`session-continuity/`, `prompt-history.json`, `logs/*.ndjson`, everything — returned **0 files**
containing the placeholder, against a positive control for `demo-token` that returned 6 files
including `rlm/rlm.db-wal` and `conversation-ledger/conversation-ledger.db-wal`. (The control
matters: an earlier sweep without `-a` silently missed the binary databases.) `app.log`: 0. The
`workspace_secrets` row was read with metadata columns and `length(value_enc)` only; no
value-bearing field was selected or printed.

Step 2 fails on the management surface. The Workspace secrets panel (Security → Workspace secrets),
full rendered text for the stored secret:

```
Demo live-test token
Live-test only
Forget
```

The name `demo-token` — the slug the agent quotes as `secret://demo-token` — is not shown, because
the template renders `label || name`. Neither timestamp is shown, though both are in the IPC
payload. No audit surface exists anywhere in the UI: `getWorkspaceSecretAudit` is wired through
preload, `InstanceIpcService` and `IpcFacadeService`, and no component calls it. Filed as **LT-550**.

### Check 3 — agent reference-only round trip — FAILS at step 1 (LT-551)

Steps 2–4 pass, and pass well. On submit, the agent received exactly one message:

> The requested credential is stored. Refer to it as secret://demo-token — its value is not
> available to you.

and replied, in a real turn:

> Noted — the credential is registered as `secret://demo-token` and I'll reference it by that handle
> only; I don't have (and won't ask for) its value.

Asked afterwards to repeat the reference and say plainly whether it could read the value:

> The exact reference is: `secret://demo-token` … no, I cannot read, display, or infer its actual
> value. All I was given is the handle itself.

The instance output buffer contained `secret://demo-token` and zero occurrences of the value. The
profile-wide sweep above covers conversation history, the continuity queue and session events — all
clean. No loop ran and no cross-model review ran in this session, so there were no loop artefacts or
review context to sweep; both are built from conversation history and the output buffer, which were
verified value-free.

Step 1 cannot be performed at all. There is no agent-reachable way to raise the card:

- The only entry point is a CLI stream message shaped
  `{type:'input_required', metadata:{type:'secret_required'}}` (`claude-cli-adapter.ts:1776`). No
  supported provider CLI emits it; the shape exists only in this repository and its own unit test.
- The agent-facing orchestration protocol has no such request type — `UserActionRequestType` is
  `switch_mode | approve_action | confirm | select_option | ask_questions`
  (`orchestration-protocol.types.ts:130-134`).
- There is no `request_secret` tool in `orchestrator-tools.ts`.

Confirmed against the live session rather than by source search alone. Asked to name any tool it had
for requesting a credential from the operator, it answered:

> NONE — I have no tool for requesting a credential or secret from the operator (no
> `secret_required` card, no `request_secret`) … If I needed an API token today, I'd use
> `request_user_action` with `requestType: "ask_questions"`.

That fallback routes the answer through `respond()` — `adapter.sendRaw`, a logged response preview,
and a `user` message persisted to conversation history — which is the exact sink
`secret-card-handlers.ts` exists to avoid. Filed as **LT-551**.

### Check 4 — authorized local consumer materialisation — FAILS at step 3 (LT-548)

Step 1 done through the real UI (MCP → Workspace): connector `lt-secret-consumer`, provider
`claude`, workspace `/tmp/aio-lt-queue-d34b8813-ws`, command `/bin/echo`,
`env = {"LT_DEMO_TOKEN": "secret://demo-token"}`. Stored and listed back with the opaque reference
intact and no value anywhere in the response or the panel HTML.

Step 2: a local Claude instance was created for that provider and workspace.

Step 3 passes on everything except the transport. The workspace audit recorded the authorised use —
`resolved / instanceId cfuk5kibx / purpose workspace-mcp-connector` — and `last_used_at` updated.
The connector-management UI never exposed the value. The reusable scopes refuse the reference
outright, verified live over real IPC:

| Attempt | Result |
| --- | --- |
| Orchestrator connector with `secret://` env | refused — `Workspace secret references cannot be stored on a global MCP connector (LT_DEMO_TOKEN)` |
| Shared connector with `secret://` env | refused — same message |
| Provider-user connector with `secret://` env | refused — same message |
| Workspace connector, `secret://` in `headers` | refused — `only allowed in connector env values (Authorization)` |
| Workspace connector, `secret://` in `url` | refused — `only allowed in connector env values` |
| Workspace connector, `secret://` in `args` | refused — `only allowed in connector env values` |

But the materialised plaintext is passed to the spawned CLI on its command line.
`ps -ww -p 48746 -o command` — the Claude CLI for the authorised instance, parented to the dev app's
main process — printed as argv token 196, immediately after `--mcp-config`:

```
{"mcpServers":{"lt-secret-consumer":{"command":"/bin/echo","args":[],"env":{"LT_DEMO_TOKEN":"<redacted placeholder>"}}}}
```

That read was made from an unrelated shell in a different working directory, with no access to the
workspace, the keychain or the store — which is exactly the boundary
`WorkspaceSecretStore.resolve`'s per-workspace refusal is there to hold. Filed as **LT-548**. Nothing
leaked to disk: `app.log` 0, whole-profile sweep 0, and only that one process carried the value.

Steps 4–5 pass. Two further real instances were created — Claude in `/tmp/aio-lt-queue-d34b8813-ws2`,
and Codex in the connector's own workspace. Neither produced a new `resolved` audit row and neither
process carried the value. The remote and failure paths were then exercised by calling
`materializeWorkspaceMcpConnectors` directly against the live repository (the dev profile has no
paired worker, so a genuine remote spawn was not available — this is a direct-call check, labelled
as such):

| Case | Configs | Value present |
| --- | --- | --- |
| local / claude / correct workspace (control) | 1 | yes |
| **remote** / claude / correct workspace | 0 | no |
| local / codex / correct workspace | 0 | no |
| local / claude / other workspace | 0 | no |
| local / claude / unscoped workspace | 0 | no |
| local / claude / `workspaceSecretsEnabled` off | 0 | no |
| local / claude / missing secret ref | throws | no — `Workspace MCP connector "lt-secret-consumer" could not resolve env LT_DEMO_TOKEN` |

The failure path is value-free in both the thrown message and the warn line.

### Cleanup

Isolated profile `/tmp/aio-lt-queue-d34b8813`, workspaces `/tmp/aio-lt-queue-d34b8813-ws` and
`…-ws2`, all instances created during the run, and the dev app itself were removed or stopped.
`safeStorage.isEncryptionAvailable` was restored before check 2 and verified `true`. No automation
was created. No setting outside the isolated profile was changed.

> Plan Queue parked work: `queue/2026-08-23-workspace-secret-ca-4b8813` — 1 commit(s), reason: land-blocked.

---

## Evidence run — 2026-09-24 (settings)

Dev app from HEAD `f04f6748`, isolated profile `/tmp/aio-lt-0924-settings`, CDP on `:9712`, a real
macOS login keychain (`safeStorage.isEncryptionAvailable(): true`, confirmed via a Node-inspector
connection to the running main process, `--inspect=19712`, not a test double), and a real,
locally-authenticated Claude session in a disposable workspace. Every value used was the obvious
placeholder `lt-placeholder-0924`/`lt-placeholder-0924-retry` (never a real credential).

**Check 1 (card rendering, failed-save clearing) — PASS.** The agent itself raised the card through
the real orchestration protocol — `request_user_action` / `requestType: "secret_required"` — with
no adapter-boundary injection needed this time (that alone reopens LT-551 as fixed; see below).
Rendered card: 1 masked password input, purpose "Live-test only", label "Demo live-test token",
footer verbatim `Stored encrypted on this Mac. Never shown to the agent.`. With
`safeStorage.isEncryptionAvailable` patched to return `false` on the live main process: the request
stayed open, error text `This Mac cannot encrypt secrets right now, so nothing was saved.` rendered,
**`input.value` was empty (length 0)** after the failed save (previously it kept the rejected
value — **LT-549 CONFIRMED FIXED LIVE**), `Save securely` was disabled, and retyping re-enabled it.

**Check 2 (native keychain persistence, metadata-only management) — PASS.** Keychain restored, save
succeeded. Security → Workspace secrets → "Workspace secrets" tab now shows, for the exact
canonical workspace: `Demo live-test token / Name: demo-token / Live-test only / Created: … /
Updated: … / Last used: …` and a "Recent secret activity" audit list with the `created` event,
purpose and session id — **LT-550 CONFIRMED FIXED LIVE** (previously the panel showed only
label/purpose, no slug, no timestamps, no audit surface).

**Check 3 (agent reference-only round trip) — PASS, including the previously-unreachable step 1.**
The same live Claude session, asked to request `demo-token` by metadata only, emitted a real
`:::ORCHESTRATOR_COMMAND::: {"action":"request_user_action","requestType":"secret_required",…}`
on its own — no adapter injection was needed, which is the fix for **LT-551 (CONFIRMED FIXED
LIVE)**: `secret_required` is now a member of `UserActionRequestType`
(`orchestration-protocol.types.ts:135`), gated by `areAgentSecretCardRequestsAllowed()`
(`secret-card-policy.ts:4-12`, both `workspaceSecretsEnabled` and
`workspaceSecretsAllowAgentRequests` — the LT-537 gate — checked, fail-closed) in both
`orchestration-handler.ts:874` and `instance-permission-request-flow.ts:75`. After submitting the
card, the agent's turn showed only `secret://demo-token`; asked to repeat the reference and say
whether it could read the value, it replied *"The exact reference I was given is: `secret://demo-token`
… I can't read, display, or infer its actual value."*

**Check 4 (authorized local consumer materialisation) — PASS.** A real workspace MCP connector
(`lt-secret-consumer`, `claude`, the disposable workspace, `env: {LT_DEMO_TOKEN:
"secret://demo-token"}`) was stored via the real UI-equivalent IPC and a real local Claude instance
was spawned for that provider/workspace. `ps -axww` for the spawned CLI (pid, parent = the dev
app's own main pid) showed `--mcp-config` followed by **four file paths**
(`/var/folders/.../aio-claude-args-*/arg-{0..3}.json`), never inline JSON — **zero occurrences** of
the placeholder value anywhere in `ps` output. The last temp file (`0600`, owner-only, in a `0700`
temp dir) contained the real materialised value
(`{"mcpServers":{"lt-secret-consumer":{...,"env":{"LT_DEMO_TOKEN":"lt-placeholder-0924-retry"}}}}`) —
**LT-548 CONFIRMED FIXED LIVE** via `materializeInlineJsonArg(entry, true)`
(`claude-cli-argv-builder.ts:304-309`, `claude-cli-adapter.ts:464-476`). The Workspace Secrets audit
recorded the authorised use (`demo-token resolved / workspace-mcp-connector / Session: <instanceId>`)
and `Last used` updated. The documented refusals still hold, verified live over real IPC: orchestrator
scope (`Workspace secret references cannot be stored on a global MCP connector`), and workspace
connector `secret://` in `headers` (`only allowed in connector env values`).

### Cleanup

All instances terminated; the workspace MCP connector deleted; the stored secret forgotten (its own
audit trail records the `forgotten` event); fixture workspaces under `/tmp` removed;
`safeStorage.isEncryptionAvailable` restored before check 2 and re-verified `true`; no automation
created; no setting outside the isolated profile changed.

**This document's four checks now all pass with current evidence** — every check that was open is
closed, and none reopened. Candidate for `_livetest_completed` (left to the orchestrator per the
campaign's document-lifecycle rule).

## Status — 2026-09-24 (orchestrator correction)

Open: 1 · Closed: 3 · Failed: 0
**Not ready to close.** The `settings` batch recorded check 1 as passing because the card rendered
after an agent's `request_user_action`. The same day, the `loops` batch found that this request type
is **blocked** on the live push channel (`user-action:request`): the strict event schema did not
allow `secret_required` or `secretRequest`, and the production log shows `Blocked invalid renderer
event payload` for it at `1790212064202`, inside the `settings` batch's run window. So the card that
batch saw most likely arrived when the view pulled its pending requests
(`user-action:list-for-instance`, which is not event-validated), not through the live push that
check 1 describes. Filed and fixed in code as
[LT-641](livetest-remediation-register.md). Check 1 must be re-run with that fix before this document
closes. Checks 2–4 (keychain and metadata management, reference-only round trip after submission,
materialisation without argv exposure) do not depend on the push path and stand as passed.

---

## Evidence run — 2026-09-24 (verify-ui)

Dev app built from the **working tree** (uncommitted LT-641 fix, not HEAD `f04f6748`), isolated
profile `/tmp/aio-lt-0924-verify-ui`, CDP on `:9731`; main-process Node inspector enabled at runtime
via `kill -USR1 <main pid>` (no restart, no `--inspect` flag at launch) to patch
`safeStorage.isEncryptionAvailable` for the failed-save half, restored immediately after. A real
locally-authenticated Claude instance (`c43ddcbf7`) was created in a disposable workspace,
**selected once via the store (`store.setSelectedInstance(...)`) and left mounted for the entire
test** — the instance-detail view was never left and re-opened, satisfying the check's "already-open
... without navigating away and back" condition precisely.

**Push-channel rendering (LT-641) — CONFIRMED FIXED LIVE.** Sent the live instance a message asking
it to request `demo-token` via `request_user_action`/`secret_required` (metadata only, no value in
the prompt). ~20s later the DOM showed a real `.request-card.request-secret_required` with exactly
the expected content:

```
Demo live-test token
Please store the demo live-test token securely using this card.
Live-test only
Demo live-test token
Stored encrypted on this Mac. Never shown to the agent.
Decline
Save securely
```

— 1 password input, rendered while the view had been continuously mounted since before the request
was ever raised (never navigated away and back, so this cannot be explained by the
`user-action:list-for-instance` pull-on-mount path the orchestrator correction above flagged as the
alternative explanation for the `settings` batch's earlier PASS). Checked `app.log`
(`~/Library/Application Support/harness/logs/app.log`, the dev app's actual log destination per the
campaign's known logging gotcha) for the exact window of this test
(`1790216590000`–`1790216660000` ms): **zero** `Blocked invalid renderer event payload` entries for
any channel in that window (the prior two hits this doc's correction cited, at `1790212064202` and
`1790213021146`, are both from an earlier batch's run, well before this window).

**Failed-save clearing (check 1, second half) — re-confirmed, still PASS.** With
`safeStorage.isEncryptionAvailable` patched to return `false` on the live main process (via the
runtime-enabled inspector, not a restart), typed `lt-placeholder-0924` into the card's password
input and clicked **Save securely**:

| Assertion | Observed |
| --- | --- |
| Request remains open | yes |
| Error text | `This Mac cannot encrypt secrets right now, so nothing was saved.` |
| Password input value length | **0** (cleared) |

`safeStorage.isEncryptionAvailable` was restored to the real implementation immediately afterward
and re-verified `true`. No value was ever saved (the save failed before reaching the keychain), so
there was nothing to forget from the keychain; the pending card was declined to leave no dangling
request.

### Cleanup

Instance `c43ddcbf7` terminated; workspace `/tmp/aio-lt-0924-verify-ui-secret-ws` removed;
`safeStorage.isEncryptionAvailable` restored and re-verified; the pending secret card declined
before termination; no automation created; no setting outside the isolated profile changed.

## Closing note — 2026-09-24 (orchestrator)

The "orchestrator correction" status block above (Open: 1) is **superseded**. The concern it raised,
that check 1's card might have arrived only through the pull route, was resolved the same day. The
`verify-ui` re-run, on a build containing the LT-641 schema fix, saw the agent's `secret_required`
card render live through the push channel in an already-open view, with zero `Blocked invalid
renderer event payload` lines in its window. Failed-save clearing was re-confirmed. See the
`## Status — 2026-09-24 (verify-ui)` block at the top. All four checks pass with current evidence.
The independent completion gate for the campaign's code changes returned `VERDICT: PASS`.
