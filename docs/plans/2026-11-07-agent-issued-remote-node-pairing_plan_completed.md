# Agent-issued remote node pairing: plan

Spec: [2026-11-07-agent-issued-remote-node-pairing_spec_completed.md](../specs/2026-11-07-agent-issued-remote-node-pairing_spec_completed.md)

Status: completed 7 November 2026, with live checks deferred to
[2026-11-07-agent-issued-remote-node-pairing_plan_livetest.md](2026-11-07-agent-issued-remote-node-pairing_plan_livetest.md).

## Goal

A Harness-spawned local agent can issue a one-time pairing credential and get the ready-to-run
`aio-worker pair "<link>"` command, through `$AIO_MCP remote-nodes pair` or the deferred
`issue_remote_node_pairing` MCP tool, without James opening Settings.

## Design

1. **One link builder for both callers.** Move `PairingCopyInput`, `PairingEndpointStatus`,
   `buildCanonicalConnectionConfig`, `buildPairingLink`, `buildPairingCommand`,
   `buildCoordinatorUrl`, `selectPairingConnectionHost` and `selectPairingConnectionPort` from
   `src/renderer/app/features/settings/remote-nodes-pairing-ui.ts` into
   `src/shared/remote-node/pairing-command.ts`. The Settings component and the main process both
   import it; no re-export shim stays behind.
2. **Reachable address (spec item 3).** When the coordinator listens on every interface
   (`0.0.0.0`), the shared builder also lists the other candidate hosts (MagicDNS name,
   Tailscale IP, LAN IPs) as repeated `fallbackHost` link parameters and as `coordinatorUrls` in
   the canonical config. The primary host selection is unchanged.
   The worker's `aio-worker pair` reads `fallbackHost`, probes the primary and then each
   fallback, and writes the first one that answers as `coordinatorUrl` (the rest stay as
   `coordinatorUrls`). This fixes the 7 November case where the Tailscale name timed out and only
   the home-network address worked. Older workers ignore the extra parameter.
3. **Main-process composer** `src/main/remote-node/agent-pairing-command.ts`: refuses when the
   worker server is not running (same rule as Settings), reads the endpoint (async Tailscale
   status, as `resolveAdvertisedCoordinatorUrls` does, so the main thread never blocks on the
   Tailscale CLI), issues the credential through `getRemoteAuthService().issuePairingCredential`
   with `issuedBy`, and returns `{ command, link, connectionConfig, label, createdAt, expiresAt }`.
   It never reads or writes `remoteNodesEnrollmentToken`.
4. **Audit.** `RemotePairingCredentialInfo` gains optional `issuedBy: { instanceId, name }`.
   `RemoteAuthService.issuePairingCredential` logs every issue (label, purpose, issuer, expiry;
   never the token). Settings shows "Requested by <session>" in the pending list and the active
   pairing details. Revoke is unchanged.
5. **Tool + RPC.** `issue_remote_node_pairing` joins `reset_node_connection` in
   `src/main/mcp/orchestrator-node-connection-tools.ts` (Zod schema
   `IssueRemoteNodePairingArgsSchema`: optional `label` 1-120 chars, optional `ttlMinutes` 1-60).
   Not in the core list, so it is deferred and found by tool search. RPC case
   `orchestrator_tools.issue_remote_node_pairing` in `orchestrator-tools-rpc-server.ts`; the
   server's existing `isKnownLocalInstance` gate (local execution only) and per-instance capability
   keep remote agents and automation invocations out. Wired in `orchestrator-tools-step.ts` with
   the session's display name.
6. **CLI.** `remote-nodes pair [--label <name>] [--ttl-minutes <n>] [--json]` in
   `src/main/mcp/remote-nodes-cli.ts`; text output prints the command, the config and the expiry
   plus a one-line handling warning. Help and the dispatcher summary updated.
7. **Docs.** `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`,
   `docs/WORKER_AGENT_SETUP.md` (agents can pair with `remote-nodes pair` instead of the
   two-sided flow).

Default lifetime stays `DEFAULT_PAIRING_TTL_MS` (60 minutes, applied by `RemoteAuthService` when
no TTL is passed); the tool and CLI cap it at 60 minutes.

## What could break

- Settings Copy Command / QR link gains `fallbackHost` parameters: covered by the shared builder
  tests and the settings component spec.
- Tool catalog tests that count or list forwarder tools, and the schema-size budget.
- Worker pair: probe order and config written; covered by pair-cli specs.

## Out of scope (spec "Related findings")

- Pair-both listener IPv6 binding and multi-address requests.
- `aio-worker pair-both` for headless workers (this feature replaces the need for it when an
  agent has shell access).
- Pair-both request lifetime.

## Checklist

- [x] Shared pairing-command module + spec; renderer imports updated
- [x] Fallback hosts in link/config; worker parses and probes them
- [x] `issuedBy` on credentials, audit log line, Settings display
- [x] Main-process composer + spec
- [x] Tool definition, forwarder tool, RPC case, wiring
- [x] CLI `pair` subcommand + spec, help, dispatcher summary
- [x] Docs
- [x] Canonical verification checklist
- [x] Live checks recorded in the livetest doc (needs a rebuilt app and a fresh worker)

## As built

- `selectPairingConnectionHost` became `selectPairingConnectionHosts` (primary plus fallbacks); the
  single-host form had no remaining caller.
- The pairing tool lives beside `reset_node_connection`; `createNodeConnectionForwarderTool` became
  `createNodeConnectionForwarderTools` and its one caller was updated.
- Error text and docs name the screen by its real title, "Other computers", not "Settings > Remote
  Nodes" as the spec wrote it.
- Verification on 7 November 2026: `npx tsc --noEmit`, `npm run typecheck:spec`, `npm run lint`,
  `npm run check:ts-max-loc`, `npm run check:ui-hints`, `npm run build:main`,
  `npm run build:renderer`, `npm run verify:architecture`, `build:aio-mcp-cli` and
  `build:worker-agent` passed. The full `npm run test:quiet` run (on the Windows test machine) had 7
  failures out of 46,686, all outside this change: `scripts/remote-checks/checks.spec.ts`
  (untracked work from another session) and `src/main/vcs/turn-file-baseline.spec.ts`; both files
  pass locally. The built worker paired against an unanswering primary address and a live fallback
  (`10.255.255.1` then `127.0.0.1`), printed the "did not answer; using" line and wrote the
  fallback as `coordinatorUrl`. The built `aio-mcp` printed `remote-nodes pair --help`, refused with
  "orchestrator-tools RPC unavailable" outside a Harness session, and rejected `--ttl-minutes 90`.
- Independent completion review: `VERDICT: PASS`, no code findings.
- Live checks (real worker pairing, second use and expiry against the live app, Settings display,
  chat tool, refusals, manual token untouched): see the livetest doc.
