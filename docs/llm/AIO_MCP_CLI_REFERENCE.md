# LLM Reference: aio-mcp CLI

Use this when you are an AI agent running inside a local Harness-spawned CLI
session and need to inspect or repair Harness state.

## First Checks

Run commands through `$AIO_MCP`:

```bash
$AIO_MCP --help
```

Required environment for settings repair, loop control, remote-node roster
checks, and remote-node release-readiness capture:

```text
AIO_MCP
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET
AI_ORCHESTRATOR_INSTANCE_ID
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY
```

For settings repair, if any are missing, do not attempt privileged writes.
Report that the local Harness repair CLI environment is unavailable.

Do not print the values of these environment variables. Socket paths and instance
ids and capabilities are local auth material. Never borrow another session's
environment or pass these values in command arguments. For saved-login access,
the browser credential request tools work independently of the shell bridge.

## Main Commands

```bash
$AIO_MCP settings list [--json] [--category <category>] [--all]
$AIO_MCP settings get <key> [--json]
$AIO_MCP settings set <key> <json-value> [--json]
$AIO_MCP settings reset <key> [--json]
$AIO_MCP loop list [--all] [--limit <n>] [--json]
$AIO_MCP loop resume <loop-run-id> [--json]
$AIO_MCP plan-queue list [--all] [--json]
$AIO_MCP plan-queue move <run-id> [--to <session-id>] [--json]
$AIO_MCP plan-queue jobs [--all] [--json]
$AIO_MCP plan-queue discard <item-id> [<item-id>...] [--json]
$AIO_MCP remote-nodes [--json]
$AIO_MCP remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]
$AIO_MCP local-ai --help
$AIO_MCP release-readiness --help
```

`loop` is how you restart a loop that has parked. Only two statuses can resume:
`paused`, and `provider-limit` with no end time. `loop list` shows exactly those
and prints the resume command for each; `--all` adds terminal runs with the
reason they cannot resume. `loop resume` re-hydrates the loop from its stored
checkpoint when the app restarted since it parked, then starts the next
iteration. It exits non-zero with the reason when the loop is terminal, unknown,
already running, or has no checkpoint.

Resuming spends provider tokens and takes effect immediately, and nothing
prompts James to approve it. That instruction is on you, not on a dialog: before
you resume a loop James did not just ask you to resume, say which loop and why.
The one hard gate is `maxSpawnDepth` — a session at the ceiling is refused,
because resuming starts new agent work. `loop list` still works there.

`plan-queue move <run-id>` makes you (or the `--to` session) the owner of a Plan
Queue run with James's authority, as Move on the Plan Queue page does. Use it only
for work James has asked you to do, typically when the owner has not answered a
`request-handover`, and say which run you moved and why. It is refused for sessions
the queue started, for a finished run with no set-aside jobs left, and while any of the
run's documents is being worked on or checked: pause the run first. The previous
owner is told unless it is asleep. `plan-queue list` shows the runs that can be moved
(every running or paused run, and finished runs in your folder that still hold
set-aside jobs; `--all` adds other folders) with their owners and the command to
take each over.

`plan-queue jobs` lists the set-aside jobs in your folder with their ids (`--all` adds
other folders). `plan-queue discard <item-id> [<item-id>...]` removes those jobs and
deletes their branches, like Discard on the Plan Queue page. You do not need to own the
run. Sessions the queue started are refused, and only parked jobs can be discarded. A
parked job always leaves the list: any work a branch held is kept for 30 days, and
`restore-discarded` on `plan_queue_control` brings a job back. Anything git will not
release stays on disk and is listed in the output. A job that fails does not
stop the others, the command exits with an error if any failed, and it is safe to run
it again.

`loop` is not `aio-loop-control`. `aio-loop-control` is the control channel
inside a running loop iteration (`complete`, `block`, `wakeup`, `fail`) and
needs `AIO_LOOP_CONTROL_FILE` in its environment. It cannot restart a parked
loop; do not report a parked loop as unresumable because that binary has no
command for it.

`orchestrator-tools`, `codemem`, `browser-gateway`, `computer-use`, and
`native-host` are forwarder subcommands. Do not run them as interactive repair
commands unless a human specifically asks you to debug the forwarder.

The `orchestrator-tools` forwarder exposes `request_doc_review` (args:
`artifact_path`, `title`, `source_path?`) and `get_doc_review_result` (arg:
`review_id`) as MCP tools. Use them to have James review a plan/spec/report:
build the HTML artifact with the `doc-review-artifact` skill into the workspace's
`.aio-review/` dir, call `request_doc_review`, then apply the returned decisions
to the Markdown source. These are MCP tools, not `$AIO_MCP` CLI subcommands.

It also exposes the Plan Queue tools: `plan_queue_start` (args: `kind` =
`plans` or `livetests`, optional `glob`, `worker_slots`, `verification_slots`,
`max_rounds`, `relax_settings`, `verifier_gates`, `post_merge_gate`, and
`workers` / `verifiers` provider-and-account choices in preference order, and one
`step_up` choice a document is handed to once when its worker fails every round — pass
those only when James asks for specific providers or accounts; his saved Plan
Queue lists always win for any role he set; the gate lists default to this app's checklist, so pass the
target repository's own commands or `[]` for any other repository), `plan_queue_status` (`run_id?`),
`plan_queue_answer` (`item_id`, `option_id`) and `plan_queue_control`
(`action`, `run_id?`, `item_id?`, `routing?`, `move_in_progress?`). Use them when James asks to work through the
plan or livetest documents; ask James any question the queue sends back and
record his choice with `plan_queue_answer`. Answer and control are refused
from anyone but the session that started the run, with two exceptions. Any session
the queue did not start may `discard-item` a parked item or `restore-discarded` it
(do it only when James asked or you have checked its work is on the base branch; the
item records who discarded it). Once the starting
session no longer exists, another session may also `cancel` the stranded run. To take over a run whose owner is still there but
will not hand it over, use `$AIO_MCP plan-queue move <run_id>` (see Main Commands). `plan_queue_report_triage`,
`plan_queue_report_verdict` and `plan_queue_report_ready` belong to the queue's own triage,
verifier and worker sessions and are refused from anyone else (a worker may report
only its own item). These are MCP tools, not `$AIO_MCP` CLI
subcommands, though `plan-queue discard` does the same as `discard-item`.

`plan_queue_status` shows an `accountRules` line with account labels when James has set
never-use or use-last account rules.

Without `run_id`, `plan_queue_status` lists every running or paused run and every
finished run with parked documents, including branchless triage failures, plus the
ten most recent runs. Results are deduplicated and newest first. The page's list
snapshot includes those same operational runs alongside its requested recent
window (fifty by default). The list IPC's `limit` bounds that recent window only;
active runs and runs with parked work can take the total above it. Ordinary
terminal history stays bounded.

To check how a run went, call `plan_queue_status` with `run_id` and `evidence: true`.
This works for finished runs. It adds the exact words the Plan Queue page shows
(`onPage`: the run's checks line, each job's "Checked together" label and live step),
the settings, each document's commits and check receipts (`head`, `testedTree`,
`checkGroup`), and a timeline of states, `checklist-run` events, checker sessions,
`slot-wait` waits and landing timings. A long run's timeline keeps the newest 500
events and sets `earlierEventsLeftOut`. Use it rather than reading the database or
asking James to look at the page. Finished runs sit in the page's collapsed History
section, not under Runs. The words come from the same code as the page, and the
component tests cover the template, so this proves the data and wording rather than
the pixels on his screen.

Plan Queue Pause stops workers, triage and checkers immediately, saving work on
each document's branch. A merge already landing finishes; Resume starts fresh
sessions on those same branches. Paused documents remain waiting, never parked
just because the run paused.

The parent's `plan_queue_control` action `set-routing` takes `run_id` and
`routing: { workers: [{ provider, model?, account_ids?, copilot_account_id? }],
verifiers: [<same choice shape>], step_up?: <same choice shape> }`, each in preference order. `workers: []`
inherits the starting session; an empty checker list means automatic selection; no `step_up` means stop and wait. This replaces the run's choice
for future sessions, including resumed parked work, triage and checkers, without
changing the saved default. Invalid or unavailable providers/accounts are refused
before saving. Per-run agent checker lists still cannot replace a protected work
Copilot seat. Only the parent may change routing, even when the run is stranded;
adopt first if authorized to continue its work.

On a running run, optional `move_in_progress: true` stops and checkpoints current
sessions and starts fresh ones using the changed choice; default false lets their
current sessions finish. Pause → set-routing → resume is the simple path. The
parent receives a routing-change message, and the log records it. Pause all and
Resume all are page controls only, unavailable through MCP.

## What This CLI May Change

There are two settings surfaces with different write boundaries. Do not confuse
them.

| Surface | Boundary |
| --- | --- |
| `set_setting` / `reset_setting` MCP tools | `open`-tier keys only. |
| `$AIO_MCP settings set` / `reset` (this CLI) | Every key except the operator-only authorization anchors. |

This CLI is the trusted local repair surface, so a `read-only` or `secret`
policy tier does **not** mean you cannot change the key here. Roughly 90% of
keys are writable through this CLI.

Decide from the `CLI-Write` column, or the `cliWritable` field under `--json`:

- `yes` — this CLI can set and reset the key.
- `no` — an operator-only anchor. `set`/`reset` fails with `Setting is
  operator-only and cannot be changed by agents`. Ask the user to change it in
  the Settings UI instead.
- `unknown` — the running app predates the field. Fall back to trying the write
  and reporting the exact error.

Ignore the `writable` field for this purpose. It describes the safe MCP tool
tier, not this CLI, and reports `false` for many keys this CLI can change.

Secret-tier keys are readable only through `settings list` — `settings get`
refuses them — so `list` is the only place their `cliWritable` shows up. Most of
them are writable, including `browserVaultMasterPasswordFile`: it is
secret-tier, so its value is redacted, but since 2026-08-29 it is no longer
operator-only. See "Redaction And Secrets" below.

The operator-only anchors are the six Computer Use policy keys, the four Microsoft
Graph OAuth and calendar-allowlist keys, the context-evidence rollout mode,
the three Local AI Guard fallback-policy and budget keys, the WS-B1
per-project PR-creation opt-in map (`allowPrCreation`), the licence-scoping
automation-provider block-list (`providersExcludedFromAutomation`), the two GitHub
Copilot account-routing keys (`copilotAccountProfiles`, `copilotAccountRoutingRules`),
the two account-pool keys (`providerAccountProfiles`,
`providerAccountPools`, covering Claude, Codex and MiMo), the Plan Queue
provider-and-account choice (`planQueueRouting`), the Plan Queue never-use and use-last account lists (`planQueueAccountRules`), the Plan Queue checklist for each project folder (`planQueueFolderChecklists`), the two Workspace Secret Card keys (`workspaceSecretsEnabled`,
`workspaceSecretsAllowAgentRequests`), the post-fill observation lock
(`browserSecretObservationProtectionEnabled`), and the macOS session signal
fence (`providerSignalFenceEnabled`).
`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` in
`src/main/core/config/settings-control-policy.ts` is the authoritative list.
`planQueueAccountRules` (26th anchor) is the never-use and use-last account list for
Plan Queue sessions and fresh automation sessions: operator-only, read live, not
changeable by agents, and it does not affect sessions James opens himself, loops, or
automations that wake an existing session.
`planQueueFolderChecklists` (27th anchor) is the saved per-folder checklist for Plan Queue
checks and post-merge commands: operator-only, and it overrides the `verifier_gates` and
`post_merge_gate` a session passes to `plan_queue_start` (callers may add gates only where no
list is saved).

The credential-vault unlock keys and the shared-tab credential-fill switch were
anchors until 2026-08-29, when the operator had them widened so unattended
portal logins need no GUI step. This CLI can now write them.

When the user asks you to change one of your own Harness settings, check
`CLI-Write` first and say plainly which of the two answers applies. Do not
report a key as unchangeable on the strength of its policy tier alone.

## Settings Repair Workflow

1. Inspect before writing:

   ```bash
   $AIO_MCP settings list --all --json
   $AIO_MCP settings get <key> --json
   ```

2. Choose the smallest repair:

   ```bash
   $AIO_MCP settings set <key> <json-value> --json
   $AIO_MCP settings reset <key> --json
   ```

3. Verify the setting afterward:

   ```bash
   $AIO_MCP settings get <key> --json
   ```

   For a secret-tier key `get` refuses, so verify from the redacted `oldValue`
   and `newValue` that `set` returned, or from `settings list`.

4. Tell the user exactly what key changed and whether `restartRequired` is true.

The CLI writes through the parent Harness app. Do not edit settings files by hand
unless the user explicitly asks and the app path is unavailable.

## Value Rules

`settings set` parses the value as JSON first.

Use:

```bash
$AIO_MCP settings set remoteNodesEnabled true
$AIO_MCP settings set maxTotalInstances 20
$AIO_MCP settings set defaultModelByProvider '{"codex":"gpt-5.1-codex"}'
$AIO_MCP settings set defaultModel '"gpt-5.3-codex"'
```

If the value is not valid JSON, it is treated as a plain string:

```bash
$AIO_MCP settings set defaultModel gpt-5.3-codex
```

Prefer valid JSON for booleans, numbers, arrays, objects, and strings where
quoting matters.

## Redaction And Secrets

Secret-tier settings are intentionally protected:

- `settings list` returns redacted secret values.
- `settings get` refuses secret keys.
- `settings set` and `settings reset` can change secret keys, except the
  operator-only anchors, but output redacted old and new values.

Never print, summarize, or infer secret values from settings output, local files,
logs, process environments, screenshots, or shell history.

## Categories

Common `settings list --category` values:

```text
general
display
orchestration
memory
advanced
review
network
mcp
rtk
remote-nodes
mobile
auxiliary-llm
```

Use `--all` on audit-style list calls to make intent explicit. The current
parent implementation returns the same classified key set with or without it.

## Remote Nodes

Use this to inspect worker availability:

```bash
$AIO_MCP remote-nodes --json
```

Prefer JSON if you need to parse fields such as `status`, `activeInstances`,
`maxConcurrentInstances`, `platform`, `address`, `supportedClis`,
`hasBrowserMcp`, `hasAndroidMcp`, `hasDocker`, or `gpuName`. The table output
derives Capacity and Capabilities from those fields. Do not treat a missing or
disconnected node as proof that the machine is off; only report what the roster
says.

To pair a new worker computer you are setting up:

```bash
$AIO_MCP remote-nodes pair --label <computer-name> --json
```

This issues one single-use pairing credential (60 minutes by default, 60 at
most) and returns `command`, `link`, `connectionConfig`, `label`, `createdAt`
and `expiresAt`. Run `command` on the new computer, for example over SSH, then
confirm the computer shows as connected in `$AIO_MCP remote-nodes --json`.
The command and config contain the credential: never paste them into chat,
logs, or any file except that computer's worker config. It fails while
Harness is not accepting worker connections ("Let your other computers
connect" on the Other computers page). Without a shell, use the deferred
`issue_remote_node_pairing` orchestrator tool. Never read or change
`remoteNodesEnrollmentToken` for pairing.

## Local AI Guard Targets

Local AI Guard target configuration is not an `AppSettings` surface. Never edit
the Local AI SQLite tables directly and do not try to encode target records as
settings keys.

Use:

```bash
$AIO_MCP local-ai discover --json
$AIO_MCP local-ai list --json
$AIO_MCP local-ai validate '<config-json>' --json
$AIO_MCP local-ai enrol '<config-json>' --json
$AIO_MCP local-ai set-lifecycle <target-id> <enrolled|paused|retired> --json
$AIO_MCP local-ai status --json
$AIO_MCP local-ai recheck <target-id> [--kind lightweight|functional] --json
$AIO_MCP local-ai rename <target-id> <label> --json
$AIO_MCP local-ai update <target-id> '<patch-json>' --json
$AIO_MCP local-ai summary [--window 24h|7d|30d] --json
$AIO_MCP local-ai acknowledge <incident-id> --json
```

Use these instead of asking James to click through the Local AI Health Centre or
reading `rlm.db`: `status` answers "is local AI healthy and taking work?",
`recheck` is "Run check", `summary` gives the local-versus-fallback figures, and
`rename`/`update`/`acknowledge`/`set-lifecycle` cover the card actions.

Recommended agent workflow:

1. Read the relevant auxiliary-model and fallback settings.
2. Run `local-ai discover --json` and select one exact discovered identity.
3. Build a strict `LocalAiTargetConfig` using only advertised models.
4. Run `local-ai validate ... --json` and inspect every required result.
5. Run `local-ai enrol ... --json`. The parent repeats validation and refuses
   persistence if the result is empty or a required probe fails.
6. Run `local-ai list --json` and verify the persisted target.

To stop managing an endpoint (for example after moving auxiliary models off
it), run `local-ai set-lifecycle <target-id> retired --json` with the id from
`local-ai list --json`. Use `paused` (optionally `--paused-until <epoch-ms>`)
for a temporary stop. Retired targets stop health checks and canaries
immediately and no longer appear in `local-ai list`.

The command uses the existing known-local-instance RPC authentication. Human
output omits raw evidence; JSON contains only the existing bounded public Local
AI schemas and never secret resolvers or model output.

## Browser Credentials

When a browser task needs an existing saved login, request James's approval:

```bash
$AIO_MCP browser-credentials request --profile <profileId> --target <targetId> \
    --item <exact saved login name or id> --reason <task reason> --json
$AIO_MCP browser-credentials status --id <requestId> --json
$AIO_MCP browser-credentials cancel --id <requestId> --json
```

Use the live `profileId` and `targetId` reported by Browser Gateway. Default
purpose is `login`; `--purpose login` and `--purpose totp` may repeat. Agents
cannot set the lifetime, request other purposes or approve their own request.
James's visible approval defaults to the current task. A separate explicit
choice can remember permission for a limited period (up to one year, never
indefinitely), and the approval tells him whether the saved login will move
into the agent vault folder.

If the shell cannot connect, use `browser.request_credential_access` with
`{profileId, targetId, item, reason, purposes?}`. Read the decision with
`browser.get_credential_access_status({requestId})` or cancel with
`browser.cancel_credential_access({requestId})`. Both routes use the same
permission service. New requests remain pending in YOLO mode too; existing valid
permission is reusable only within its scope. A duplicate request reuses its
pending reference rather than generating another prompt.

Keep the returned reference and use the real `data.status`: `pending`,
`approved`, `denied` or `expired`. Only approved credential access permits retrying
`browser.fill_credential` on the same website and computer, using the returned
vault item reference. For Chrome's own HTTP Basic/Digest pop-up (not a page
form), use `browser.fill_http_auth` with the same vault item reference instead.
Approval performs enrolment and authorization in Harness
and notifies the requesting session. A manual login handoff, parked escalation,
read-only browser grant or auto-approved manual step never proves saved-login
authorization. Navigation, disconnection, locked vault or revocation may still
block access; report the actual result and never expose the password.

Authenticated session CLI calls to legacy `enrol` and `authorize` are refused
with `operator_credential_approval_required`. The per-session transport
capability identifies the requester; it never proves James's consent. Use the
request flow above, including when he has authorized the task in chat. Operator
management through Browser Gateway settings and explicitly configured bootstrap
services remains separate. Never edit permission records directly.

Sessions may still inspect and revoke existing permissions:

```bash
$AIO_MCP browser-credentials list [--profile <stored scope>] --json
$AIO_MCP browser-credentials revoke --id <authorizationId> --json
```

`list` filters on the stored permission scope. A shared existing tab uses its
computer scope (`local` or the worker node), while a managed profile uses its
profile id. A list entry is evidence of an existing record, not proof that it
matches this task's exact website, computer, vault item, purpose and lifetime.
The request/secure-fill service performs those checks. No command returns the
password: the secure fill resolves it in the main process.

## Release Readiness

Use the help output first:

```bash
$AIO_MCP release-readiness --help
```

Typical machine-readable run:

```bash
$AIO_MCP release-readiness \
  --evidence release-evidence.json \
  --expected-worker-version <version> \
  --expected-extension-version <version> \
  --json
```

Live capture run:

```bash
$AIO_MCP release-readiness \
  --capture-remote-nodes \
  --capture-browser-health \
  --evidence release-evidence.json \
  --expected-worker-version <version> \
  --expected-extension-version <version> \
  --write-evidence release-evidence.merged.json \
  --json
```

Use the expected version flags for release gates. Without them, worker redeploy
and browser-extension reload checks only prove deployment/reload evidence exists;
they do not prove the exact worker or extension version is running.

`--capture-browser-health` also needs the browser gateway environment:

```text
AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET
AI_ORCHESTRATOR_BROWSER_INSTANCE_ID
AI_ORCHESTRATOR_BROWSER_PROVIDER
```

If those values are missing, the browser-health evidence is recorded as
unavailable and the report may be blocked.

Only claim release readiness from the command's report. If the report is blocked,
surface the blockers and next actions.

## Failure Handling

`orchestrator-tools RPC unavailable: parent socket/instance id missing`

The shell lacks the local Harness bridge. Report presence only, never values.
For saved-login access, call `browser.request_credential_access` through the
available browser tools. Codex initial and supported native resume launches
preserve only the current spawn's four injected bridge names through its shell
filter; an already running child needs a reconnect to pick up the fix.

After the rebuilt app is installed, use the affected Codex session's menu
**Restart and resume**, then send: "Continue the saved-login request for the same
website and computer. Check its status, wait for approval if pending, then retry
secure fill and verify sign-in." Leave unrelated sessions running. Never copy
connection values from another session, global configuration or a log.

`connect ENOENT`, connection refused, or timeout

This shell cannot reach its parent connection. Check whether it predates the
running app; the error alone does not prove the app is unavailable. Reconnect
the affected session through Harness, or use the available browser tools for
the saved-login request.

Unknown command or option

Run the relevant help command:

```bash
$AIO_MCP --help
$AIO_MCP settings --help
$AIO_MCP local-ai --help
$AIO_MCP remote-nodes --help
$AIO_MCP release-readiness --help
```

## Reporting Back

When you use `aio-mcp`, report:

- command family used, for example `settings` or `remote-nodes`
- keys changed, if any
- whether `restartRequired` is true
- any blocker or missing environment

Do not report:

- raw socket paths
- instance ids
- secret or redacted values
- full JSON blobs that contain local machine details unless the user asked for
  raw output

## Pause new work and workload

```bash
$AIO_MCP pause status [--json]
$AIO_MCP pause hold [--json]
$AIO_MCP pause release [--json]
$AIO_MCP settings get workloadLevel --json
$AIO_MCP settings set workloadLevel 1 --json
$AIO_MCP settings get maxConcurrentWorktrees --json
$AIO_MCP settings set maxConcurrentWorktrees 30 --json
```

Hold lets running work finish and keeps new unattended work waiting. It survives a restart and never expires automatically.
Release only releases Hold; it cannot resume a restart pause. Pause for restart, Resume and Discard are actions for James
in the Work panel. Status reports the phase, time and reason; it does not expose session notes.

The workload setting accepts whole numbers 1–5, with 3 (Balanced) preserving the existing limits. Lowering it changes
what starts next; it never stops running work. Remote work does not count against local capacity.

`maxConcurrentWorktrees` (default 20, 0 = no limit, applies at once) caps the worktrees that loops, repo jobs,
campaigns, branch-select and the Worktrees page may have in use together. Plan Queue checkouts do not count and are not
held to it; the queue's worker slots limit them. When a loop fails with "Harness allows N worktrees in use at once",
finish or remove one, or raise this setting.

## Microsoft 365 accounts

```bash
$AIO_MCP microsoft365 add <connector-name> [--mail] [--json]
```

Adds one Microsoft 365 account as a connector, for example `m365-fortitude`. Harness first asks James to approve the
request (five minutes to answer; automatic approval never counts). Only after he approves does Microsoft sign-in open in
his browser on the Mac, and he completes it himself. The command blocks until then, for up to 30 minutes, so run it
in the background or with your longest command timeout. If it is stopped before James approves, the request disappears
from Harness and must be run again; if it is stopped after he approves, a sign-in he finishes still adds the connector,
so check before retrying. `--mail`
adds email search, reading, drafting and sending to the calendar tools. Run it only when James asked for that account.

The new connector reaches sessions started afterwards, not ones already running. Whether agents may write (calendar
changes, sending mail) stays James's switch on the connector; this command cannot set it, and the Microsoft sign-in
settings remain operator-only. Another organisation may require its IT administrator to approve the app before anyone
there can sign in, and the sign-in then fails. Report what Microsoft said; do not try to work around it.
