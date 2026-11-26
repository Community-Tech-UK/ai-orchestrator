# Local AI Guard CLI Specification

**Status:** Completed

**Implementation plan:** [2026-07-30-local-ai-guard-cli_plan_completed.md](../plans/2026-07-30-local-ai-guard-cli_plan_completed.md)

## Problem

Local agents can repair ordinary Harness settings through `aio-mcp settings`, but
Local AI Guard targets are durable runtime entities rather than `AppSettings`
keys. The Health Centre is currently the only supported enrolment path. A
disabled form therefore leaves an agent unable to validate or enrol a discovered
worker endpoint for the user.

## Goal

Add a privileged, instance-scoped `aio-mcp local-ai` command family that lets a
local Harness-spawned agent discover, inspect, validate, and enrol Local AI Guard
targets through the running parent app.

## Command Contract

```text
aio-mcp local-ai discover [--json]
aio-mcp local-ai list [--json]
aio-mcp local-ai validate <config-json> [--json]
aio-mcp local-ai enrol <config-json> [--json]
```

- `discover` returns only the same bounded, sanitized endpoint metadata as the
  Health Centre.
- `list` returns bounded, schema-validated enrolled target configuration.
- `validate` runs the same functional worker, endpoint, model, and canary probes
  as the Health Centre without persisting a target.
- `enrol` validates the supplied configuration again inside the Electron parent
  and persists it only when the validation result is non-empty and every
  required probe passes.
- Every command supports machine-readable JSON. Human output must omit raw
  evidence values and secrets.

## Security and Integrity

- Requests use the existing orchestrator-tools socket and known-local-instance
  authentication. No new socket or credential mechanism is introduced.
- Payloads and results are parsed with the existing Local AI Guard Zod schemas.
- The SEA process never imports SQLite or other native modules.
- The CLI never writes the Local AI tables directly.
- Invalid, oversized, secret-bearing, or unsupported discovery candidates remain
  excluded by the canonical discovery sanitizer.
- A repeated enrolment request for an already managed endpoint must fail safely
  instead of creating a duplicate target.

## Defaults for James's Windows Target

The first live use will enrol the discovered `windows-pc` OpenAI-compatible
endpoint with:

- required models `qwen/qwen3.5-9b` and `qwen/qwen3.6-35b-a3b`;
- canary model `qwen/qwen3.5-9b`;
- routing roles for every currently used helper surface except disabled
  `subQueryExecution`;
- 60-second endpoint checks, 10-minute canaries, 30-second canary timeout,
  120-second freshness, and 2-second latency warning;
- default `notify-and-allow` fallback behaviour, bounded by the existing global
  paid-fallback controls;
- automatic repair disabled, two attempts, and a five-minute cooldown if later
  enabled.

## Acceptance

1. Focused CLI, dispatcher, RPC, and integration tests pass.
2. A failed required probe prevents the create operation.
3. A passing validation creates exactly one durable target and returns its safe
   public record.
4. `aio-mcp local-ai --help` documents the command family.
5. The rebuilt CLI can discover and validate the Windows endpoint.
6. When a live Harness restart/session is available, the CLI enrols the target
   and `local-ai list --json` confirms the persisted configuration.

## As Built

The shipped implementation adds all four commands to the SEA dispatcher, routes
them through the authenticated orchestrator-tools parent RPC, reuses canonical
bounded discovery and functional validation operations, and persists only after
non-empty required probes pass. Enrolment accepts only
`lifecycle: "enrolled"`, rejects duplicate endpoint identities before and after
validation, and gives schema-valid long-running probes enough bounded RPC time
to complete.

All agent-runnable acceptance criteria passed, including two independent
completion-gate reviews and a 1,646-file, 16,781-test full suite. Acceptance
items 5 and 6 require the rebuilt parent to be installed/restarted and are
recorded in the linked
[live-test plan](../plans/2026-07-30-local-ai-guard-cli_plan_livetest.md).
