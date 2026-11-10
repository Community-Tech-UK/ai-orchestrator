# Agents can pair a new worker computer without the Settings screen

Status: completed 7 November 2026; live checks deferred to the plan's livetest doc. Written 7 November
2026 from the CT test Mac setup session.
Plan: [2026-11-07-agent-issued-remote-node-pairing_plan_completed.md](../plans/2026-11-07-agent-issued-remote-node-pairing_plan_completed.md)

As built: items 1-6 are implemented as written, plus the worker now tries every address in the
pairing link (item 3). The "Related findings" below were not part of this work.

## Problem

An agent setting up a new worker computer can install, build and start the worker itself,
but it cannot connect that computer to Harness. Every pairing route needs James at the
Settings > Remote Nodes screen:

- **Copy Command** is renderer-only: the IPC `remote-node:issue-pairing`
  (`src/main/ipc/handlers/remote-node-handlers.ts`) issues the one-time credential, and
  `buildPairingCommand` in `src/renderer/app/features/settings/remote-nodes-pairing-ui.ts`
  builds the `aio-worker pair "ai-orchestrator://remote-node/pair?..."` text.
- `aio-mcp settings get remoteNodesEnrollmentToken` refuses ("Cannot read secret setting"),
  which is right: that is a long-lived manual token and should stay secret.
- No orchestrator MCP tool issues a pairing credential (`orchestrator_tool_search` for
  "pair a new remote worker node" finds nothing).

On 7 November 2026 this forced several round trips with James for the test Mac. He
expects an agent he has asked to set up a computer to be able to pair it.

## Required behaviour

1. A new command, `$AIO_MCP remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]`,
   issues one fresh one-time pairing credential through the running app and prints the
   ready-to-run worker command (`aio-worker pair "<link>"`), the canonical connection config,
   and the expiry time. Default lifetime is the existing `DEFAULT_PAIRING_TTL_MS`. Maximum
   is 60 minutes.
2. The credential is single-use and short-lived, exactly like the one Copy Command issues.
   It goes through `getRemoteAuthService().issuePairingCredential(...)`. It never reads,
   prints or changes `remoteNodesEnrollmentToken`.
3. The host and port in the link are chosen the same way the Settings screen chooses them
   (`selectPairingConnectionHost` / `selectPairingConnectionPort`). Move that selection into
   shared or main-process code so both callers use one implementation. Don't copy it.
   Prefer an address the worker can actually reach (see Related findings).
4. Also expose it as an orchestrator MCP tool (deferred, found by tool search), for example
   `issue_remote_node_pairing`, so a chat agent can pair without a shell.
5. The audit trail records which session issued each credential, and the label. The
   Settings screen's pending-pairings list shows it, and it can be revoked there as today.
6. `$AIO_MCP remote-nodes pair --help` and `docs/AIO_MCP_CLI.md` /
   `docs/llm/AIO_MCP_CLI_REFERENCE.md` document it. Agents may run the printed command over
   SSH on the target computer. The credential appears in that command, so agents must not
   paste it into chat, logs or files beyond the target's worker config.

## Design pointers

- RPC: add `orchestrator_tools.issue_remote_node_pairing` beside
  `orchestrator_tools.list_remote_nodes` in `src/main/mcp/orchestrator-tools-rpc-server.ts`.
  The CLI goes in `src/main/mcp/remote-nodes-cli.ts` as a `pair` subcommand. Dispatch stays
  in `src/main/mcp/aio-mcp-dispatcher.ts`.
- Same environment gate as the other `remote-nodes` commands
  (`AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_*`), so only Harness-spawned local agents can use it.
  Remote agents running on workers must not be able to issue credentials.
- Validate the RPC payload with Zod, as the existing `RemoteNodeIssuePairingPayloadSchema` does.

## Acceptance

- From a Harness-spawned local session, `$AIO_MCP remote-nodes pair --label ct-test-mac`
  prints a working command. Running it on a fresh worker connects that worker, and it
  appears as connected in `$AIO_MCP remote-nodes`.
- A second use of the same credential is rejected. An expired credential is rejected.
- Without the Harness environment variables, the command fails with the usual
  "environment unavailable" message and issues nothing.
- `remoteNodesEnrollmentToken` is unchanged before and after.
- Unit tests for the CLI parsing, RPC handler and host selection. The canonical
  verification checklist in `AGENTS.md` passes.

## Related findings (7 November 2026, may need their own items)

- **Two-sided pairing ("Pair both") can't be reached over Tailscale from this Mac.** The
  request's listener binds IPv4 only (`*:63659`), and its advertised host is the Tailscale
  name, which resolves to the 100.x address. This Mac has no IPv4 Tailscale route (see the
  memory note "Mac Tailscale has no IPv4 route"), so the worker's connection timed out. Only
  the home-network address worked. The listener should also bind IPv6, and the request
  should list every reachable address (LAN and Tailscale IPv6), not just the name.
- **The headless worker can't accept a two-sided request.** The worker side
  (`connectWorkerToCandidate` in `src/main/remote-node/pair-both-rendezvous-service.ts`)
  runs only inside the Harness app. The test Mac had to be driven with a one-off tsx script.
  Either add `aio-worker pair-both <request-json>`, or rely on item 1 above and say so in
  `docs/WORKER_AGENT_SETUP.md`.
- **The request's lifetime is short for a paste-it-into-chat flow.** The 7 November request
  had about three minutes left by the time the agent first tried to connect, and it expired
  before James could approve.
