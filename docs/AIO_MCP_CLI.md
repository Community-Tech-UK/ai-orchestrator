# aio-mcp CLI

`aio-mcp` is the command-line binary Harness ships for local bridge work. It is
used by MCP forwarders, the browser extension native host, and a few operator
commands that need to talk back to the running Harness app.

Most users should not need to run it directly. When you do, prefer the path from
`$AIO_MCP` inside a Harness-spawned agent shell:

```bash
$AIO_MCP --help
```

In a local development checkout, build the binary first:

```bash
npm run build:aio-mcp-dist
dist/aio-mcp-cli-sea/aio-mcp --help
```

## What It Can Do

`aio-mcp` has seven human-facing command groups:

| Command | Purpose |
| --- | --- |
| `settings` | Inspect and repair Harness app settings through the running parent app. |
| `remote-nodes` | Print the safe remote worker roster. |
| `release-readiness` | Build a mobile release readiness report from evidence JSON and live captures. |
| `local-ai` | Discover, enrol, inspect, check, rename, edit, pause, and retire Local AI Guard targets, read effectiveness, and acknowledge incidents through the running parent app. |
| `copilot-account` | Inspect GitHub Copilot account routing: profiles, rules, what a workspace resolves to, and routing health. Read-only. |
| `browser-credentials` | Request James's approval to use a saved login, inspect or cancel that request, and manage existing credential authorizations. |
| `loop` | List parked loops and resume one, including after an app restart. |

It also has MCP and integration forwarders:

| Command | Purpose |
| --- | --- |
| `orchestrator-tools` | Stdio MCP forwarder for Harness orchestration tools. |
| `codemem` | Stdio MCP forwarder for code memory and symbol search. |
| `browser-gateway` | Stdio MCP forwarder for browser automation. |
| `computer-use` | Stdio MCP forwarder for desktop computer-use tools. |
| `native-host` | Chrome native-messaging host for the browser extension. |

Those forwarder commands are normally launched by Harness or by MCP config. They
are not interactive user commands.

### Doc review tools

The `orchestrator-tools` forwarder also exposes two instance-scoped MCP tools for
handing a document to James for review:

| Tool | Args | Purpose |
| --- | --- | --- |
| `request_doc_review` | `artifact_path`, `title`, `source_path?` | Register an HTML review artifact (already written under the workspace's `.aio-review/` dir) as a pending review. Returns `{ reviewId }`. James decides in-app and the canonical feedback block arrives back as a user-role message. |
| `get_doc_review_result` | `review_id` | Poll a review's status. Returns pending until James decides, then the overall verdict and per-item decisions. |

Build the artifact with the `doc-review-artifact` skill first, then call
`request_doc_review` with its path. Markdown stays the source of truth; apply the
returned decisions to the `.md` source and re-render. The artifact path is validated
to sit inside the workspace's `.aio-review/` directory (never committed).

### Plan Queue tools

The same forwarder exposes the Plan Queue (see `src/main/plan-queue/`). A session
calls `plan_queue_start` and becomes the parent of one nested worker session per
document; each worker gets its own `queue/*` branch and `.worktrees/queue/...`
worktree, a verifier on a different provider judges each round, and verified work
lands on the checked-out branch as one local squash commit (never pushed).

| Tool | Args | Purpose |
| --- | --- | --- |
| `plan_queue_start` | `kind` (`plans`\|`livetests`), `glob?`, `worker_slots?`, `verification_slots?`, `max_rounds?`, `relax_settings?`, `verifier_gates?`, `post_merge_gate?` | Discover documents and start a run with the caller as parent. The gate lists default to this app's checklist; pass the target repository's own commands (or `[]`) elsewhere. Not available to queue-spawned sessions. |
| `plan_queue_status` | `run_id?` | One run's items (state, round, question, park reason, findings), or recent runs plus reconciler alerts. |
| `plan_queue_answer` | `item_id`, `option_id` | Record James's answer to a readiness or worker question. Parent session only. |
| `plan_queue_control` | `action`, `run_id?`, `item_id?` | Pause, resume or cancel a run; skip, resume, land-anyway or discard an item. Parent session only, except the stranded-run rescue: once the parent session no longer exists, any session that the queue did not spawn may `cancel` the run or `discard-item` a parked item. Each affected item's detail and the log record which session did it. |
| `plan_queue_report_triage` | `run_id`, `records` | Triage agent only (caller-checked). |
| `plan_queue_report_verdict` | `item_id`, `verdict`, `findings?`, `gates_run?`, `document_complete?`, `need_james?` | The item's current verifier only (caller-checked); a worker cannot report its own verdict. |

## `copilot-account` (read-only)

```bash
$AIO_MCP copilot-account list            # profiles and their sign-in state
$AIO_MCP copilot-account rules           # routing rules
$AIO_MCP copilot-account route ~/work/x  # which account this folder uses, and why
$AIO_MCP copilot-account route ~/work/x --origin=automation   # ...for an automated run
$AIO_MCP copilot-account doctor          # conflicts, warnings, ambient token vars
```

Add `--json` to any of them for machine-readable output.

`route` assumes an **interactive** session unless you pass `--origin`. That
assumption changes the answer: `automationPolicy` and the provider-exclusion list
only apply to automatic origins, so a workspace can resolve fine interactively
and be refused for every automated run. The assumed origin is always printed
(`Enterprise (owner, as interactive)`), and `--origin automation` (or `--origin=review`,
`loop`, ...) asks the question an automation would actually get. Both the spaced
and `=` forms work; `--origin` with no value is an error rather than a silent
fallback.

**There are deliberately no write commands.** `copilotAccountProfiles` and
`copilotAccountRoutingRules` are operator-only anchors: they decide which GitHub
identity services a repository, and this CLI cannot tell the operator apart from
an agent — `$AIO_MCP` is injected into every agent shell. An agent able to add a
profile or move the default could route enterprise code through a personal seat,
which is the exact mistake Copilot account routing exists to prevent. Changes are
made in **Settings › GitHub Copilot Accounts**.

Results are re-parsed through `.strict()` schemas on the way out, so a Copilot
profile home path or a token cannot reach a terminal, a pipe, or a log even if a
future change adds one upstream.

## Runtime Requirements

Settings, loop control, remote-node roster, and remote-node release-readiness
captures need a local orchestrator-tools RPC socket and a known Harness instance
id. Harness injects these into local spawned agent shells:

```bash
AIO_MCP
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET
AI_ORCHESTRATOR_INSTANCE_ID
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY
```

`$AIO_MCP` points at the packaged or locally built `aio-mcp` binary. Harness also
prepends the binary's directory to `PATH`, so `aio-mcp` may work directly in that
agent shell. Use `$AIO_MCP` in scripts because it is explicit and survives path
differences between packaged and development builds.

These commands fail outside a local Harness-spawned process. The capability is
private to the current spawn: never copy connection values from another session
or put them in command arguments. Remote agents do not receive the local repair
environment. The browser credential request tools remain the available route
when a session's shell does not have the CLI connection.

For Codex, Harness preserves these four injected names in the private prepared
configuration's shell environment policy. Existing inheritance, exclusions and
other variables remain unchanged. Initial launches and supported native resumes
use the current spawn's bridge; already running children keep their previous
configuration until that session reconnects.

Browser-gateway forwarders and `release-readiness --capture-browser-health` use
separate browser gateway environment variables:

```bash
AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET
AI_ORCHESTRATOR_BROWSER_INSTANCE_ID
AI_ORCHESTRATOR_BROWSER_PROVIDER
```

Those values are normally passed to the browser-gateway MCP forwarder. They are
not part of the generic `$AIO_MCP settings ...` shell repair environment. If
they are missing during a browser-health release capture, the command records
browser gateway health as unavailable rather than opening a browser connection.

## Settings

The settings command is the main self-repair interface for local agents. It
uses the running Harness app, not direct file edits, so validation, normalization,
renderer broadcasts, restart flags, and cache invalidation stay consistent.

```bash
$AIO_MCP settings list [--json] [--category <category>] [--all]
$AIO_MCP settings get <key> [--json]
$AIO_MCP settings set <key> <json-value> [--json]
$AIO_MCP settings reset <key> [--json]
```

Examples:

```bash
$AIO_MCP settings list --all
$AIO_MCP settings list --category mcp --json
$AIO_MCP settings get maxTotalInstances --json
$AIO_MCP settings set remoteNodesEnabled true
$AIO_MCP settings set maxTotalInstances 20
$AIO_MCP settings set defaultModelByProvider '{"codex":"gpt-5.1-codex"}'
$AIO_MCP settings reset remoteNodesEnabled
```

`settings set` parses the value as JSON first. That means `true`, `20`, arrays,
and objects become typed values. If JSON parsing fails, the value is treated as a
plain string.

Useful categories include:

- `general`
- `display`
- `orchestration`
- `memory`
- `advanced`
- `review`
- `network`
- `mcp`
- `rtk`
- `remote-nodes`
- `mobile`
- `auxiliary-llm`

The privileged list surface currently returns all classified `AppSettings` keys.
`--all` is accepted and forwarded for audit-style calls, but it does not
currently reveal extra rows.

### Settings Safety

The settings CLI is privileged when it runs from a known local Harness instance.
It can update settings that the ordinary safe MCP `set_setting` tool cannot
write. This is deliberate: it gives Harness-owned agents a repair path when a
broken setting prevents normal operation.

Because of that, the two surfaces have different write boundaries:

| Surface | Boundary |
| --- | --- |
| `set_setting` / `reset_setting` MCP tools | `open`-tier keys only. |
| `$AIO_MCP settings set` / `reset` | Every key except the operator-only anchors. |

The `CLI-Write` column (`cliWritable` under `--json`) answers "can this CLI
change it". The `Policy` column reports the safe MCP tool tier instead, so a
`read-only` policy does not imply the CLI is blocked. `CLI-Write: no` marks the
23 operator-only authorization anchors: the six Computer Use policy keys, the
four Microsoft Graph OAuth and calendar-allowlist keys, the context-evidence
rollout mode, the three Local AI Guard fallback-policy and budget keys, the
WS-B1 per-project PR-creation opt-in map (`allowPrCreation`), the licence-scoping
automation-provider block-list (`providersExcludedFromAutomation`), the two GitHub
Copilot account-routing keys (`copilotAccountProfiles`, `copilotAccountRoutingRules`),
the two Claude/Codex account-pool keys (`providerAccountProfiles`,
`providerAccountPools`), the two Workspace Secret Card keys (`workspaceSecretsEnabled`,
`workspaceSecretsAllowAgentRequests`), and the post-fill observation lock
(`browserSecretObservationProtectionEnabled`).
Those are changed from the Settings UI by the operator, never by an agent.

On 2026-08-29 the two credential-vault unlock keys
(`browserVaultMasterPasswordFile`, `browserVaultAutoUnlock`) and the shared-tab
credential-fill switch (`browserAllowSharedTabCredentialFill`) were deliberately
removed from this set, on the operator's instruction, so that unattended portal
logins do not require a GUI step. They remain closed to the safe `set_setting`
MCP tool and are writable only through this privileged CLI.
`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` in
`src/main/core/config/settings-control-policy.ts` is the authoritative list.

Secret-tier keys are not readable through `settings get`, so `settings list` is
the only place their `CLI-Write` value appears. All of them are writable,
including `browserVaultMasterPasswordFile`, which is secret-tier (so its value
is redacted in `list` and refused by `get`) but no longer operator-only.

Secret-tier values are not printed:

- `list` shows redacted secret values.
- `get` refuses secret keys.
- `set` and `reset` can operate on secret keys other than the operator-only
  anchors, but report only redacted old and new values.

Do not paste CLI output into issues, docs, or chat if it contains local paths,
hostnames, socket paths, or any value you have not checked. The command is
designed to redact secrets, but the surrounding environment may still be
sensitive.

## Remote Nodes

Use this command to check the safe worker roster exposed by the running Harness
app:

```bash
$AIO_MCP remote-nodes
$AIO_MCP remote-nodes --json
```

## Local AI Guard

Local AI Guard targets are durable runtime records rather than ordinary
`AppSettings` keys. Use the dedicated command family instead of editing the
database or trying to write them through `settings set`:

```bash
$AIO_MCP local-ai discover [--json]
$AIO_MCP local-ai list [--json]
$AIO_MCP local-ai validate '<config-json>' [--json]
$AIO_MCP local-ai enrol '<config-json>' [--json]
$AIO_MCP local-ai set-lifecycle <target-id> <enrolled|paused|retired> [--paused-until <epoch-ms>] [--json]
$AIO_MCP local-ai status [--json]
$AIO_MCP local-ai recheck <target-id> [--kind lightweight|functional] [--json]
$AIO_MCP local-ai rename <target-id> <label> [--json]
$AIO_MCP local-ai update <target-id> <patch-json> [--json]
$AIO_MCP local-ai summary [--window 24h|7d|30d] [--json]
$AIO_MCP local-ai acknowledge <incident-id> [--json]
```

`discover` returns the same bounded, non-secret endpoint metadata used by the
Health Centre. `validate` runs the worker, endpoint, model, and functional
canary checks without writing a target.

`enrol` is deliberately not a blind create operation. The Electron parent:

1. rejects an already managed endpoint;
2. runs functional validation against the supplied configuration;
3. refuses empty results or any failed required probe;
4. checks for a duplicate again; and
5. writes the target through the authoritative repository.

Use `--json` for agent-driven work. The configuration must satisfy
`LocalAiTargetConfigSchema`, including at least one expected model, a canary
chosen from those models, and at least one routing role for an enrolled target.
Endpoint URLs may not contain userinfo and must use a literal loopback, private,
or Tailscale IPv4 host.

`set-lifecycle` makes the same repository change as the Settings UI. A paused
or retired target stops its health checks and canaries at once; `retired` is
the way to stop managing an endpoint you no longer route to. `--paused-until`
is accepted only with `paused` and must be a future epoch-milliseconds time.
Take the target id from `local-ai list --json`.

The remaining subcommands mirror the Health Centre and make the same runtime calls:

- `status` is the Health Centre page: overall state, then per target its label, id, state,
  the helper roles it may take, and the age and outcome of the worker, endpoint, model and
  canary checks, followed by open and acknowledged incidents. Probe messages and evidence are
  left out.
- `recheck` is "Run check". `--kind functional` also runs the canary. The CLI waits as long as
  the target's own probe settings allow; if it still times out, the check may be running (a
  functional check waits for a busy target), so read the result with `status`.
- `rename` changes only the display label: it does not reset health checks or routing. New
  targets are named like `windows-pc · LM Studio`.
- `update` is "Edit". The patch uses the same strict schema as the UI: it cannot change a
  target's location, provider, or endpoint id, but it can change the base URL and lifecycle,
  as the UI can. Prefer `set-lifecycle` for lifecycle changes.
- `summary` is "Local AI effectiveness": local versus fallback tasks, tokens, and cost.
- `acknowledge` is the incident "Acknowledge" button.

The table output is easier for a person to read. Use `--json` when another tool
will parse the result.

## Loop

Lists parked loops and restarts one. A loop parks in two ways that outlive the
process that started it: `paused` (an operator pause, or the boot-time
running→paused reconcile) and `provider-limit` with no end time (usage-aware
throttling). Both are resumable; every other terminal status is not.

```bash
$AIO_MCP loop list [--all] [--limit <n>] [--json]
$AIO_MCP loop resume <loop-run-id> [--json]
```

`list` shows only resumable loops by default, each with the exact `resume`
command for it. `--all` adds the terminal runs and says why each one cannot
resume.

`resume` re-hydrates the loop from its stored checkpoint when the app has been
restarted since it parked, then starts the next iteration — the same parent-side
path as the renderer's Resume button. It exits non-zero with the refusal reason
when the loop is terminal, unknown, already running, or has no checkpoint to
restore from. Restoring an isolated loop whose managed worktree has been deleted
fails closed rather than silently falling back to the workspace root.

Resuming spends provider tokens and starts agent work that writes to the loop's
workspace or worktree. It is a deliberate write command, unlike
`copilot-account`, because the alternative was that only a human at the renderer
could ever restart a parked loop.

Be clear about what does and does not gate it:

- There is **no approval prompt**. Unlike the release and calendar mutations on
  the same socket, `loop resume` does not raise a permission request — that
  would put a human click back in the path this command exists to remove. The
  comparable precedent is `run_on_node`, which also starts fresh agent work
  without a dialog.
- Following that precedent, `loop resume` **is** refused for a session that has
  reached `maxSpawnDepth`, the same guard that strips `run_on_node` from such a
  session. `loop list` stays available to it.
- There is **no per-loop ownership check**: any local instance the parent knows
  may resume any resumable loop, and `loop list` shows every recorded run's
  workspace path and goal preview. That is the same visibility an agent shell
  already has by reading `.aio-loop-state/` or the loop-mode database directly,
  so it is not a new disclosure, but it is worth knowing before you widen who
  gets a Harness shell.

This is not `aio-loop-control`. That separate binary is the control channel
*inside* a running loop iteration — it needs the per-iteration
`AIO_LOOP_CONTROL_FILE` in its environment and only records `complete`,
`block`, `wakeup` and `fail` intents for the loop it is running in. Nothing
there can restart a loop that has already parked.

## Browser Credentials

### Saved-login approval for sessions

Request the exact saved login against the live browser target. Take `profileId`
and `targetId` from Browser Gateway; for a shared tab these identify that tab,
not a managed profile to create or a computer name to guess.

```bash
$AIO_MCP browser-credentials request --profile <profileId> --target <targetId> \
    --item "Portal test login" --reason "Sign in to finish this task" --json
$AIO_MCP browser-credentials status --id <requestId> --json
$AIO_MCP browser-credentials cancel --id <requestId> --json
```

`request` defaults to the `login` purpose. Repeat `--purpose login` and
`--purpose totp` if both are needed. The session cannot select a lifetime or
approve its own request. James sees the session, reason, exact website and
computer, saved-login title, requested purposes, duration, and any proposed move
into the agent vault folder. Access defaults to the current task; remembering it
for a limited period is a separate choice in that approval.

The request stays `pending` until James decides, including in YOLO mode.
Existing valid permission may be reused within its scope. Repeated requests for
the same task and access reuse the pending reference. Read the actual
`data.status`: `pending`, `approved`, `denied` or `expired`. Only `approved` with
credential authorization metadata permits a retry of secure fill. A manual
handoff, parked escalation or read-only browser grant does not grant saved-login
access. Denial and expiry never perform enrolment or authorization.

After approval, Harness enrols the item and authorizes the exact website,
computer, vault item and purposes. The originating session receives the decision
and can retry `browser.fill_credential`; no password appears in the result.
The live website and computer are checked again before approval is applied and
before secure fill. Navigation, disconnection, a locked vault or changed login
can prevent completion; inspect status rather than treating a button click as
successful authorization.

When the shell connection is unavailable, call
`browser.request_credential_access` with `{profileId, targetId, item, reason,
purposes?}`. Poll with `browser.get_credential_access_status({requestId})` or
cancel with `browser.cancel_credential_access({requestId})`. These tools and CLI
commands use the same service and permission checks. Do not repair this by
editing permission records or borrowing another session's connection.

### Legacy operator management

`list` and `revoke` remain available to authenticated sessions. Legacy enrol and
authorize payload formats remain documented below, but the session CLI refuses
both with `operator_credential_approval_required`; a session connection does not
prove operator consent. Use `request` above for new session access. Operator
management through the Browser Gateway settings and explicitly configured
bootstrap services retains its own route.

Historical enrol/authorize command forms, rejected from the session CLI:

```
aio-mcp browser-credentials enrol --item "ProContract (AIO-Agent)" \
    --origin https://procontract.due-north.com

aio-mcp browser-credentials authorize --node windows-pc \
    --origin https://procontract.due-north.com \
    --purpose login --purpose totp \
    --vault-folder AIO-Agent --expires-in 90d \
    --note "ProContract unattended login"

aio-mcp browser-credentials list [--profile default]
aio-mcp browser-credentials revoke --id <authorizationId>
```

### Scope: the part that is easy to get wrong

`authorize` needs exactly one of `--local`, `--node <nodeId>` or
`--profile <id>`. This is not cosmetic. At fill time
`credentialAuthorizationProfileScope` resolves a shared existing tab to its
**node** scope, because a shared tab's own profile id is per-tab and ephemeral;
only a managed browser profile authorizes by its own id. A grant on the wrong
scope is created happily and can never match, and the failure appears much later
as `credential_not_authorized:no_authorization_for_profile`.

- Your everyday Chrome on a worker machine: `--node windows-pc`
- Your everyday Chrome on this machine: `--local`
- An agent-managed browser profile: `--profile aio-procurement`

`--node` takes either the friendly name (`windows-pc`) or the roster UUID; the
name is resolved to the id, because the id is what the fill actually looks up. An
unknown scope is refused main-side and the error lists the real ones with both
name and id. The scope is printed back on success, so a wrong one is visible at
the point of creation.

### Origins

`--origin` and `--purpose` may be repeated. Origins take the form `https://host`
or `https://*.host` for a subdomain wildcard, and are normalised the way a
browser normalises them, so an international host is punycoded and a trailing dot
is dropped rather than stored in a form that could never match.

A non-default port is KEPT, because the fill-time matcher compares against
`new URL(pageUrl).host`, which includes one. A council portal on `:8443` works.
The scheme's own default port is dropped, as a browser drops it.

Refused: a path in a host field, embedded credentials (`https://user@host`),
empty labels, and a non-leading wildcard. A path in a full URL is dropped
rather than refused, so you can paste an address bar.

Also refused: a wildcard whose base is a public suffix. `*.com` and `*.co.uk`
are grants over an entire registry rather than an organisation.

The same origin rules apply to `enrol`, so a login you can bind is always a login
you can authorize. All of it is enforced in the main process rather than in the
CLI process, because the CLI binary is not the only thing that can reach the RPC
socket.

Purposes are `login`, `register`, `totp` and `email_code`. `secret_fill` is
deliberately not offerable here, so financial and identity secret fills stay off
this door.

Expiry is required, never defaulted: `--expires-in 90d` or `12w`, or
`--expires-at <epoch ms>`. Standing consent is capped at one year, enforced in
the main process by the same `assertAuthorizationExpiry` the Settings UI uses.

`--move-into-folder` moves a vault item into the agent folder when it lives
elsewhere. It widens what an authorized fill can reach, so it is never implied.

No command prints a password. Enrolment returns a vault item reference and a
username only.

### Why this exists

Until 2026-08-29 enrolment and authorization were renderer-only, and the enrol
schema stated that an agent must never enrol its own credential. The operator
overruled that: a required GUI step per portal was the one thing preventing
unattended operation, and the work being blocked was always authentication
rather than approval. The legacy formats reuse the Settings UI's request
schemas. The saved-login approval flow now supersedes direct session enrolment
and authorization: agents request access, and the operator decides before the
services perform either operation. Approval to send anything a person will see
is a separate control and is unaffected.

## Release Readiness

Use this command to build the mobile release readiness report from evidence:

```bash
$AIO_MCP release-readiness --evidence release-evidence.json
$AIO_MCP release-readiness --evidence release-evidence.json --json
$AIO_MCP release-readiness \
  --evidence release-evidence.json \
  --expected-worker-version <version> \
  --expected-extension-version <version>
```

It can also capture live remote-node and browser-gateway evidence:

```bash
$AIO_MCP release-readiness \
  --capture-remote-nodes \
  --capture-browser-health \
  --evidence release-evidence.json \
  --expected-worker-version <version> \
  --expected-extension-version <version> \
  --write-evidence release-evidence.merged.json
```

Pass the expected version flags when this command is used as a release gate:

```bash
--expected-worker-version <version>
--expected-extension-version <version>
```

Without those flags, the worker redeploy and browser-extension reload checks
only require deployment/reload evidence. They do not prove the deployed worker
or extension matches a specific version.

Manual evidence flags are available for the release steps that cannot be
captured automatically:

```bash
--harness-restarted-at <ms|iso|now>
--native-host-drill-ran-at <ms|iso|now>
--native-host-drill-passed
--native-host-drill-node <name>
--native-host-drill-summary <text>
--testflight-released-at <ms|iso|now>
--testflight-bundle-id <id>
--testflight-build-number <number>
--testflight-beta-group-attached
--testflight-smoke-passed
--play-released-at <ms|iso|now>
--play-package-name <name>
--play-version-code <code>
--play-track internal
--play-committed
--play-smoke-passed
```

Run `$AIO_MCP release-readiness --help` for the current concise usage text.

## Troubleshooting

`orchestrator-tools RPC unavailable: parent socket/instance id missing`

The shell lacks one or more connection values, including its private capability.
Check presence only:

```bash
node -e 'for (const key of ["AIO_MCP", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET", "AI_ORCHESTRATOR_INSTANCE_ID", "AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY"]) console.log(key + ": " + Boolean(process.env[key]))'
```

Never print the values. For saved-login access, use
`browser.request_credential_access` immediately if that tool is available.
After installing a rebuilt Harness, reconnect only the affected Codex session:
open its session menu and choose **Restart and resume**. This refreshes its
current-spawn bridge while preserving the conversation. Then send:
"Continue the saved-login request for the same website and computer. Check its
status, wait for approval if pending, then retry secure fill and verify sign-in."
Do not restart unrelated sessions or copy connection values into the shell.

`connect ENOENT` or a timeout

These errors show that this shell cannot reach the parent connection. Check the
running app and whether this session was launched before an app restart; they
do not prove the app is down. Use available browser tools for saved-login access,
or reconnect the affected session through Harness and retry.

`Unknown settings option` or `Unexpected settings ... argument`

Run:

```bash
$AIO_MCP settings --help
```

For strings that begin with `--`, put the option after the required positional
arguments only when the command supports it, or encode the value as JSON if that
fits the setting.

`settings set` wrote a string instead of a structured value

Quote valid JSON as a single shell argument:

```bash
$AIO_MCP settings set defaultModelByProvider '{"codex":"gpt-5.1-codex"}'
```

## Development Notes

The dispatcher lives in:

- `src/main/mcp/aio-mcp-dispatcher.ts`
- `src/main/mcp/settings-cli.ts`
- `src/main/mcp/remote-nodes-cli.ts`
- `src/main/mcp/release-readiness-cli.ts`

The binary path resolver checks:

1. `<resourcesPath>/aio-mcp-cli/aio-mcp[.exe]`
2. `dist/aio-mcp-cli-sea/aio-mcp[.exe]`

When adding a new `AppSettings` key, keep the settings CLI surface in sync:

1. Add the key and default to `AppSettings` and `DEFAULT_SETTINGS`.
2. Add user-visible metadata when appropriate.
3. Classify the key as `open`, `read-only`, or `secret`.
4. Confirm `aio-mcp settings list --all --json` reports it with safe redaction.
5. Add or update tests for the key's safe MCP behavior and privileged CLI behavior.

Focused verification for CLI changes:

```bash
npm run test:quiet -- \
  src/main/mcp/settings-cli.spec.ts \
  src/main/mcp/aio-mcp-dispatcher.spec.ts \
  src/main/mcp/orchestrator-tools-rpc-server.spec.ts \
  src/main/mcp/orchestrator-settings-tools.spec.ts \
  src/main/mcp/remote-nodes-cli.spec.ts \
  src/main/mcp/release-readiness-cli.spec.ts

npm run build:aio-mcp-dist
dist/aio-mcp-cli-sea/aio-mcp --help
dist/aio-mcp-cli-sea/aio-mcp settings --help
dist/aio-mcp-cli-sea/aio-mcp local-ai --help
```
