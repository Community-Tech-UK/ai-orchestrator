# Local AI CLI parity — plan

Status: COMPLETED (2026-10-04). Live checks after rebuild:
[2026-10-04-local-ai-cli-parity_livetest.md](2026-10-04-local-ai-cli-parity_livetest.md).

## Why

James (2026-10-04): "We should set up the CLI so you can do this shit yourself in the future."
While moving auxiliary models to LM Studio, agents had to ask James to click through the Health
Centre (retire a target, read health, find which target is which) or read
`rlm.db` directly, because `aio-mcp local-ai` only had discover, list, validate, enrol and
set-lifecycle. Target labels were also unreadable (`<node uuid>: worker:<node uuid>:ollama:…`)
and could not be changed anywhere, not even in the UI.

## Scope

New `aio-mcp local-ai` subcommands, each reusing the same runtime call as the Health Centre's
IPC handler, through `LocalAiPublicOperations` and the existing authenticated CLI RPC:

1. [x] `status [--json]` — aggregate state plus, per enrolled or paused target: id, label,
       lifecycle, state, routable roles, consecutive failures, and per-layer ok/age/failure code;
       open and acknowledged incidents. Bounded DTO with no free-text evidence or messages.
2. [x] `recheck <target-id> [--kind lightweight|functional] [--json]` — "Run check".
3. [x] `rename <target-id> <label> [--json]` — new repository `rename`; labels were immutable.
4. [x] `update <target-id> <patch-json> [--json]` — "Edit", same strict patch schema as the UI.
5. [x] `summary [--window 24h|7d|30d] [--json]` — the "Local AI effectiveness" figures.
6. [x] `acknowledge <incident-id> [--json]` — "Acknowledge".
7. [x] `list` human output includes each target id (it was only in `--json`).
8. [x] Readable default labels for new targets, from both the CLI and the Health Centre:
       `windows-pc · LM Studio`, `windows-pc · Ollama`, `This computer · Ollama`; host:port is
       appended only for a non-default port.
9. [x] Docs: `docs/AIO_MCP_CLI.md`, `docs/llm/AIO_MCP_CLI_REFERENCE.md`, top-level
       `aio-mcp --help` line for `local-ai`.

10. [x] Effectiveness counts local work. Investigation (2026-10-04) found that successful local
        auxiliary calls were never written to `local_ai_routing_events`, the only table the
        summary reads; only fallbacks were. The panel therefore showed 0% local (0 of 137) while
        about 2,657 of 2,794 calls in that window ran locally (cost-attribution file and app.log).
        Fix: `LocalAiRoutingGuard.recordLocalCompletion` appends an `actualRoute: 'local'` event,
        reached through a new `recordLocalCompletion` auxiliary hook from
        `recordSuccessfulAuxiliary` whenever the call ran locally (with the managed target when
        there is one). Disposition is `not-needed`: fallback spend sums `allowed` rows, so an
        `allowed` local row would have charged the avoided frontier cost to the paid budget.
        Recording failures are swallowed so they can never fail the call.

Out of scope: `diagnose`/`repair` (repair restarts Ollama processes; keep it a UI action).

## As built

- Management actions live in `local-ai-management-operations.ts`; the default CLI operations
  combine them with the existing public operations. The status DTO is bounded and carries no
  probe messages or evidence; the RPC layer re-validates it, so a leaking result is refused.
- `LocalAiTargetRepository.rename` and `create(config, { label })`; labels from
  `friendlyLocalAiTargetLabel`, worker names from the worker-node registry. The Health Centre's
  create handler now goes through the same public `create`, so both entry points name targets
  the same way.
- Rename is label-only: it neither notifies repository subscribers nor bumps `updatedAt`, the
  two triggers of the health scheduler's target reset, so a rename never drops an in-flight
  check or briefly un-routes the target. Views refresh through `notifyChanged`.
- `recheck` reads the target first and waits as long as the parent's `healthRpcBudget` allows
  for that target (requests × canary timeout + margins); a timeout tells the operator the
  check may still be running and to read `status`.
- Migration `068_local_ai_routing_spend_indexes` adds partial indexes over paid-fallback rows
  (disposition `allowed`/`pending-confirmation`) so fallback budget checks never read the
  local-completion rows (~2.7k/day, ~245k at 90-day retention). A spec pins the query plans.
- Live checks: [2026-10-04-local-ai-cli-parity_livetest.md](2026-10-04-local-ai-cli-parity_livetest.md).

## Verification

- [x] Unit specs per layer: CLI parsing/formatting/errors, RPC dispatch and payload rejection
      (including a status result that would leak evidence), management operations, public
      create label, repository rename/label, label helper, IPC create label, routing-guard local
      completion (summary counts it, spend ignores it, retired target untargeted), auxiliary
      service records local calls only and survives a recording failure. Mutation-checked: the
      service test fails without the hook call, the spend test fails with an `allowed`
      disposition.
- [x] `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`,
      `build:aio-mcp-cli`, eslint on touched files. Built CLI `--help` lists the commands; against
      the not-yet-rebuilt app it reports the expected unknown RPC method.
- [x] Full `test:quiet`: 1 of 29,608 failed, a 5 s timeout in `local-ai-health-repository.spec.ts`
      ("keeps daily aggregation idempotent across a repository restart"); neither that spec nor
      the repository is touched here, and the file passes alone (64 tests). Load-related.
- [x] Fresh-eyes completion gate: pass 1 FAIL (spend queries would scan local rows, rename
      reset health checks, recheck timeout too short, `update` doc overstated; all fixed);
      pass 2 VERDICT PASS, no actionable findings (it also rebuilt the live table shape with
      245k local rows and no statistics and confirmed every spend query uses a paid-only index).
- Live (after rebuild): the livetest doc above.
