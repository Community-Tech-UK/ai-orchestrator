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

`aio-mcp` has four human-facing command groups:

| Command | Purpose |
| --- | --- |
| `settings` | Inspect and repair Harness app settings through the running parent app. |
| `remote-nodes` | Print the safe remote worker roster. |
| `release-readiness` | Build a mobile release readiness report from evidence JSON and live captures. |
| `local-ai` | Discover, validate, list, and enrol Local AI Guard targets through the running parent app. |

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

## Runtime Requirements

Settings, remote-node roster, and remote-node release-readiness captures need a
local orchestrator-tools RPC socket and a known Harness instance id. Harness
injects these into local spawned agent shells:

```bash
AIO_MCP
AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET
AI_ORCHESTRATOR_INSTANCE_ID
```

`$AIO_MCP` points at the packaged or locally built `aio-mcp` binary. Harness also
prepends the binary's directory to `PATH`, so `aio-mcp` may work directly in that
agent shell. Use `$AIO_MCP` in scripts because it is explicit and survives path
differences between packaged and development builds.

These commands will fail outside a local Harness-spawned process unless you
provide the same socket and instance id environment. Remote agents do not receive
the local repair environment.

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
17 operator-only authorization anchors — the two credential-vault unlock keys,
shared-tab credential fill, the five Computer Use policy keys, the four
Microsoft Graph OAuth and calendar-allowlist keys, the context-evidence rollout
mode, the three Local AI Guard fallback-policy and budget keys, and the
WS-B1 per-project PR-creation opt-in map (`allowPrCreation`). Those are
changed from the Settings UI by the operator, never by an agent.
`PRIVILEGED_CLI_OPERATOR_ONLY_KEYS` in
`src/main/core/config/settings-control-policy.ts` is the authoritative list.

Secret-tier keys are not readable through `settings get`, so `settings list` is
the only place their `CLI-Write` value appears. Most are writable;
`browserVaultMasterPasswordFile` is both secret-tier and operator-only, so it is
not.

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

The table output is easier for a person to read. Use `--json` when another tool
will parse the result.

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

The command is not running inside a local Harness-spawned agent, or the required
environment was not forwarded. Check:

```bash
env | rg '^(AIO_MCP|AI_ORCHESTRATOR_)='
```

Do not print these values in public logs.

`connect ENOENT` or a timeout

The parent Harness app is not running, the socket path is stale, or the agent was
resumed after the parent restarted. Start a fresh local agent from the running
app and retry.

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
