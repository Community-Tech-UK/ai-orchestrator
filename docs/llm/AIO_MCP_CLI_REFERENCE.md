# LLM Reference: aio-mcp CLI

Use this when you are an AI agent running inside a local Harness-spawned CLI
session and need to inspect or repair Harness state.

## First Checks

Run commands through `$AIO_MCP`:

```bash
$AIO_MCP --help
```

Required environment for settings repair, remote-node roster checks, and
remote-node release-readiness capture:

```text
AIO_MCP
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET
AI_ORCHESTRATOR_INSTANCE_ID
```

For settings repair, if any are missing, do not attempt privileged writes.
Report that the local Harness repair CLI environment is unavailable.

Do not print the values of these environment variables. Socket paths and instance
ids are local auth material.

## Main Commands

```bash
$AIO_MCP settings list [--json] [--category <category>] [--all]
$AIO_MCP settings get <key> [--json]
$AIO_MCP settings set <key> <json-value> [--json]
$AIO_MCP settings reset <key> [--json]
$AIO_MCP remote-nodes [--json]
$AIO_MCP release-readiness --help
```

`orchestrator-tools`, `codemem`, `browser-gateway`, `computer-use`, and
`native-host` are forwarder subcommands. Do not run them as interactive repair
commands unless a human specifically asks you to debug the forwarder.

The `orchestrator-tools` forwarder exposes `request_doc_review` (args:
`artifact_path`, `title`, `source_path?`) and `get_doc_review_result` (arg:
`review_id`) as MCP tools. Use them to have James review a plan/spec/report:
build the HTML artifact with the `doc-review-artifact` skill into the workspace's
`.aio-review/` dir, call `request_doc_review`, then apply the returned decisions
to the Markdown source. These are MCP tools, not `$AIO_MCP` CLI subcommands.

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
- `settings set` and `settings reset` can change secret keys, but output redacted
  old and new values.

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

The required local Harness environment is absent. Stop and report that this
command must run inside a local Harness-spawned agent.

`connect ENOENT`, connection refused, or timeout

The parent app is unavailable, the socket is stale, or the agent environment came
from an old app session. Ask for or start a fresh local Harness-spawned agent.

Unknown command or option

Run the relevant help command:

```bash
$AIO_MCP --help
$AIO_MCP settings --help
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
