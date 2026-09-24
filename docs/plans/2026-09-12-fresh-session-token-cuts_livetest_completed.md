# Fresh-session token cuts — live checks

Remediation flow: read [campaign runbook](livetest-campaign-runbook.md); a reproduced defect belongs in [remediation register](livetest-remediation-register.md) with its matching implementation status in [remediation plan](2026-07-19-livetest-failure-remediation_plan_completed.md). Keep per-check evidence here.
Implementation plan: [plan](2026-09-12-fresh-session-token-cuts_plan_completed.md).

Prerequisites: rebuilt/restarted Harness so new sessions pick up the orchestrator MCP surface and instruction skip. Existing provider processes keep the old tool list and prepend.

## 1. Orchestrator discovery on a new session

- [x] Fresh Claude (or Copilot) session: confirm spawn logs `toolMode: deferred` and a visible orchestrator tool count far below the full ~45-schema surface.
- [x] Search for a hidden capability (calendar, release, or file-transfer) and invoke it. Policy and RPC checks must still apply.
- [x] Fresh Codex session: `toolMode: stable`. Search/describe/execute a non-core orchestrator tool without relying on `tools/list_changed`.
- [x] Fresh Cursor session (or `orchestratorMcpToolDeferral=false`): full eager tool list still present.

## 2. Instruction skip

- [x] Fresh Claude session in this repo: context manifest / Usage panel must not show both AIO-prepended `~/.claude/CLAUDE.md` and the same file the CLI already loaded. Project `AGENTS.md` should appear once (native `@import`), not twice.
- [x] Fresh Codex session: AIO must not prepend project `AGENTS.md` again. `~/.claude/CLAUDE.md` may still appear if AIO injects it (Codex does not load that file).

## 3. Why these cannot run in-loop

They need a rebuilt app, a new provider process, and a real `/context` or Usage-panel observation of what that CLI retained.

## Evidence run — 2026-09-21

Environment: dev app built and launched from worktree `.worktrees/queue/2026-09-12-fresh-session-token-789255`
(`npm run build:main`, `npm run build:renderer`, `npm run build:aio-mcp-dist`), isolated profile
`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-43789255`, `--remote-debugging-port=9593`, focus emulation enabled
before every DOM/IPC read. Renderer served from the freshly built bundle on `:4567`. Every session below is a
real fresh spawn in that dev app; provider CLIs are the real local binaries.

Log lines are quoted from `~/Library/Application Support/harness/logs/app.log` (a dev app writes there — see the
campaign runbook), filtered by the instance id of each spawn and by a byte offset captured immediately before it.

Instances used and terminated: `cf2bjekoc` (claude), `x596pgzsa` (codex), `usc7dh9n1` (cursor),
`g8wsig157` (gemini→antigravity, control only).

### 1. Orchestrator discovery on a new session

**1.1 Fresh Claude session: `toolMode: deferred`, visible count far below the full surface — PASS**

Spawn log for instance `cf2bjekoc`:

```
{"timestamp":1789960616375,"level":"info","subsystem":"SpawnConfigBuilder","message":"Orchestrator tool schemas deferred","data":{"instanceId":"cf2bjekoc","toolMode":"deferred","visibleToolCount":8,"visibleSchemaBytes":7174,"fullToolCount":53,"fullSchemaBytes":52910}}
```

The MCP config actually handed to that CLI (read from the live `claude` process command line, pid 78442) carried
the deferral switch:

```
{"mcpServers":{"orchestrator":{"command":".../dist/aio-mcp-cli-sea/aio-mcp","args":["orchestrator-tools"],
"env":{"AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET":"/tmp/aio-lt-queue-43789255/ot-f4e6ccd64bb7.sock",
"AI_ORCHESTRATOR_INSTANCE_ID":"cf2bjekoc","AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY":"<redacted>",
"AI_ORCHESTRATOR_ORCHESTRATOR_TOOL_DEFERRAL":"1"}}}}
```

Asked in-session for its own visible orchestrator tools, the Claude session returned exactly 8 — the six core
tools plus the two discovery tools, and nothing else:

```
mcp__orchestrator__get_setting, mcp__orchestrator__list_remote_nodes, mcp__orchestrator__list_settings,
mcp__orchestrator__orchestrator_tool_describe, mcp__orchestrator__orchestrator_tool_search,
mcp__orchestrator__read_node_output, mcp__orchestrator__run_on_node, mcp__orchestrator__terminate_node_instance
```

8 of 53 tools, 7 174 of 52 910 schema bytes. The Usage panel (`contextAttributionGet`) priced the same session's
orchestrator surface at **2 393 tokens** against **17 652 tokens** measured on the eager Cursor session in 1.4 —
a ~15.3k-token saving per fresh session, matching the plan's stated goal.

**1.2 Search for a hidden capability and invoke it; policy and RPC checks still apply — PASS**

`orchestrator.tool_search` with "create a calendar event" returned 10 matches, all previously hidden, headed by
`graph_calendar_create_event`, `graph_calendar_status`, `graph_calendar_connect`, `create_automation`,
`execute_android_play_release`. The session confirmed none of them were in its visible list beforehand.

Invoking the revealed `mcp__orchestrator__graph_calendar_status` with `{}` succeeded and returned the real RPC
result from the dev app:

```
{"accounts":[]}
```

Validation was then probed on a second revealed tool, `upload_to_node`. Deliberately wrong arguments were
rejected by the tool's own Zod schema before any RPC:

```
[{"expected":"string","code":"invalid_type","path":["node"],"message":"Invalid input: expected string, received undefined"},
 {"code":"unrecognized_keys","keys":["nodeId"],"path":[],"message":"Unrecognized key: \"nodeId\""}]
```

and a schema-valid call against a fake node was rejected by the RPC layer:

```
node_not_found: Cannot run child on "definitely-not-a-real-node": no worker nodes are currently connected.
```

Both layers therefore still apply to a tool that only became callable through search. Residual, stated plainly:
because node resolution fails first, the local-path validation layer of `upload_to_node` was not exercised.

**1.3 Fresh Codex session: `toolMode: stable`, search/describe/execute without `tools/list_changed` — PASS**

Spawn log for instance `x596pgzsa`:

```
{"timestamp":1789960901907,"level":"info","subsystem":"SpawnConfigBuilder","message":"Orchestrator tool schemas deferred","data":{"instanceId":"x596pgzsa","toolMode":"stable","visibleToolCount":9,"visibleSchemaBytes":7436,"fullToolCount":53,"fullSchemaBytes":52910}}
```

In-session, Codex reported exactly the 9 expected tools: the six core tools plus
`orchestrator_tool_search`, `orchestrator_tool_describe` and `orchestrator_tool_execute`.

- `orchestrator.tool_search("upload a file to a worker node")` returned `upload_to_node`, `exec_on_node`,
  `sync_to_node`, `get_node_file_info`, `download_from_node`, with the instruction
  `Non-core tools run via orchestrator.tool_execute; the callable tool list stays fixed.`
- `orchestrator.tool_describe("graph_calendar_status")` returned
  `{"tool":"orchestrator.tool_execute","name":"graph_calendar_status"}` as its `invocation` field.
- Executing through that route returned `{"accounts":[]}`.
- After execution the visible orchestrator tool list was unchanged: still 9, same names. No `tools/list_changed`
  was needed or relied on.

**1.4 Fresh Cursor session: full eager tool list still present — PASS**

Spawn log for instance `usc7dh9n1`:

```
{"timestamp":1789961104866,"level":"info","subsystem":"SpawnConfigBuilder","message":"Orchestrator tool schemas injected eagerly","data":{"instanceId":"usc7dh9n1","toolCount":53,"schemaBytes":52910}}
```

The Cursor session enumerated **53** orchestrator tools by name, confirmed that no
`orchestrator_tool_search` / `orchestrator_tool_execute` wrapper exists in its list, and confirmed that
`graph_calendar_status`, `upload_to_node` and `create_automation` are all directly callable with no search step.
Its Usage panel priced `orchestrator-tools` (eager) at 17 652 tokens.

`orchestratorMcpToolDeferral` was left at its shipped default (`true`) throughout; Cursor reaches the eager path
through provider policy, which is the route that actually ships.

### 2. Instruction skip

**2.1 Fresh Claude session: no doubled instruction stack — PASS**

The `claude` process command line for `cf2bjekoc` was captured in full (10 247 bytes, `ps -ww`). Its
`--append-system-prompt` — the only channel AIO uses for the instruction stack — contains **zero** occurrences of
`# Global Agent Instructions`, `# AI Orchestrator Agent Instructions`, `# Angular Conventions`,
`Read before writing`, `Critical Rules`, `Plan and Spec Lifecycle` or `standalone components only`. It carries only
the agent BUILD MODE block, the repo map, tool permissions and the Browser Gateway block.

Context manifest for the spawn epoch records `instructions` supplied at **339 chars** — the BUILD MODE block alone.
The Usage panel reports `instructionFiles: 0 tokens, detail []`.

Control, to prove the stack was not simply empty: an instance created in the **same working directory** with a
provider the skip does not cover (`gemini`, resolved to `antigravity`, instance `g8wsig157`) recorded
`instructions` supplied at **34 187 chars** and a Usage panel reading:

```
instructionFiles 8458 tokens
  /Users/suas/.claude/CLAUDE.md                                  5938
  .../2026-09-12-fresh-session-token-789255/AGENTS.md            2510
  .../2026-09-12-fresh-session-token-789255/CLAUDE.md              10
```

So the stack resolves all three files, and the Claude skip is what removes them.

Asked what it can actually see, without tools, the Claude session reported four instruction documents, all
delivered in one native-CLI `<system-reminder>` block: `/Users/suas/.claude/CLAUDE.md`
(`# Global Agent Instructions`), the project `CLAUDE.md` (body is only `@AGENTS.md` and
`@docs/angular-conventions.md`), `AGENTS.md` (`# AI Orchestrator Agent Instructions`, pulled in by the `@` import)
and `docs/angular-conventions.md` (`# Angular Conventions`, same mechanism). It reported the orchestrator-prepended
material as containing none of those files, `AGENTS.md` as appearing **ONCE**, and `~/.claude/CLAUDE.md` as
appearing **ONCE**. It proved retention by quoting a rule from each without reading any file (the
`npm run build:renderer` gate from `AGENTS.md`; the branch/worktree policy from `~/.claude/CLAUDE.md`).

Nothing is doubled and nothing is lost: the CLI still carries the instructions, AIO no longer pays for them again.

**2.2 Fresh Codex session: AIO does not prepend project `AGENTS.md` again — PASS**

Same working directory, instance `x596pgzsa`. Context manifest records `instructions` supplied at
**24 143 chars**. Against the 34 187-char control that is a **10 044-char** reduction, and `AGENTS.md` is
10 048 bytes on disk. The Usage panel confirms which file went:

```
instructionFiles 5948 tokens
  /Users/suas/.claude/CLAUDE.md                                  5938
  .../2026-09-12-fresh-session-token-789255/CLAUDE.md              10
```

`AGENTS.md` is absent; `~/.claude/CLAUDE.md` is still injected, which is exactly what this check allows because
Codex does not load that file itself. Asked in-session, Codex reported `AGENTS.md` **ONCE** and
`~/.claude/CLAUDE.md` **ONCE**, quoting a specific rule from each to prove it holds both.

### Observations (no defect filed)

- With the skip active, a Claude session's Usage panel shows `instructionFiles: 0 tokens` even though the CLI
  natively carries roughly 8.5k tokens of `CLAUDE.md`/`AGENTS.md`. This is the plan's stated design — attribution
  measures what AIO composed — and the panel already labels itself "AIO-owned sources only", so it is recorded here
  as behaviour to be aware of rather than a defect.
- The eager spawn log line (`Orchestrator tool schemas injected eagerly`) omits the `toolMode` field that the
  deferred/stable line carries. The mode is unambiguous from the message text, so no defect is filed.

### Status

6 of 6 checks pass with live evidence. No defect reproduced, so no `LT-NNN` register entry was created for this
document. Dev app, renderer server and all four instances were stopped; `/tmp/aio-lt-queue-43789255` removed.
