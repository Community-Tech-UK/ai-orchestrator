# Host process tools and signal-fence off switch

Status: completed (2026-10-16). Code, tests and gates done; live checks deferred to the livetest doc.

## Why

On macOS every provider CLI is started inside the Seatbelt signal fence
(`src/main/sandbox/signal-fence.ts`). The fence stops a session from killing
processes outside its own sandbox. It was added after a sibling session's
`pkill -f "opencode acp"` killed a live session on 2026-09-26.

Two side effects annoyed James on 2026-10-16:

1. A session could not clean up orphaned test programs it had left behind.
   Once orphaned, they are re-parented to launchd and fall outside the fence's
   `same-sandbox` / `children` allowance.
2. A session could not see per-process CPU use. `/bin/ps` and `/usr/bin/top`
   are setuid-root, and macOS refuses to exec setuid binaries from inside a
   sandbox ("operation not permitted"). `pgrep` still works, so processes are
   visible by name, but CPU and memory figures are not.

James chose both remedies: (3) Harness-side process tools and (2) an off switch.

## Decisions

- **D1. Process tools run in the unsandboxed Harness main process** and are
  exposed to sessions as deferred `orchestrator` MCP tools (found through
  `orchestrator.tool_search`). No `$AIO_MCP` CLI command in this pass.
- **D2. `list_host_processes`** (read-only): top N processes by CPU (default
  20, max 100), optional name filter. Rows carry pid, parent pid, CPU %,
  memory MB, running time, a sanitised label (never the raw command line or
  environment, because tool results are captured as evidence), whether the
  process belongs to this user, and `leftover` / `stoppable` flags.
- **D3. `stop_leftover_processes`** (mutating, max 100 pids per call). A pid is
  stopped only if every check passes, re-read fresh at call time:
  1. same user as Harness, pid > 1, not Harness itself;
  2. orphaned (parent pid 1);
  3. its environment carries `AI_ORCHESTRATOR_INSTANCE_ID=<id>`, proving a
     Harness session started it;
  4. that originating session is the caller, or no longer live in Harness
     (a live sibling's detached server is refused);
  5. not a tracked live-session CLI process.
  Marked descendants of an approved leftover (same marker) are stopped with
  it, deepest first. `SIGTERM` by default, `SIGKILL` with `force: true`.
  Everything else is refused with a plain reason. No user approval prompt:
  the rules only reach programs a Harness session started and abandoned.
- **D4. Global setting `providerSignalFenceEnabled`** (default `true`), shown
  under Settings > Advanced > Security as dangerous. Agents cannot change it:
  `readOnly()` in the settings tool policy and listed in
  `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`. Read at spawn time, so it applies to
  sessions started (or restarted) after the change.
- **D5. Per-session override** chosen in the new-session composer on macOS
  ("Fence ON/OFF"). Sent as `signalFence: false` on create. Held in an
  in-memory registry like hardened mode, so it survives in-app respawns but
  not an app restart (the fence comes back on: fail-safe). In the composer it
  is held in memory for the open draft only, never saved, and resets after each create or reload.
- **D6. Effective fence = global setting AND per-session flag.** Hardened
  sessions are unaffected (their deny-default policy already blocks
  cross-sandbox signals). Fence-off sessions skip the gemini spawn-worker
  offload and warm-start reuse, both of which spawn with the default fence.
- **D7. Out of scope:** the shared Codex broker (no production caller found)
  and OpenCode pre-launch probes keep the default fence.

## Tasks

### A. Process tools
- [x] A1 `src/main/process/host-process-inspector.ts`: list + stop logic with
      an injectable runtime (`ps` exec, `kill`, uid, live-instance lookups).
      Reuse the sanitised label from `stall-process-facts.ts`.
- [x] A2 `src/main/mcp/orchestrator-host-process-tools.ts`: parent definitions
      and stdio forwarder definitions (pattern: `orchestrator-node-connection-tools.ts`).
- [x] A3 Wire into `orchestrator-tools.ts`, the forwarder, the RPC server
      switch, `orchestrator-tools-step.ts`, and tool-search category copy.
- [x] A4 Unit tests for parsing, every refusal rule, descendants, and tool wiring;
      update the forwarder tool-name spec.

### B. Fence off switch
- [x] B1 Global setting: type, default, surfacing, metadata row, security group,
      tool policy, privileged CLI key.
- [x] B2 Per-session flag: `Instance` / `InstanceCreateConfig`, Zod create schemas,
      IPC handlers, builder, `signal-fence-scoping.ts` registry set/remove.
- [x] B3 Spawn: factory configures the adapter; `BaseCliAdapter` passes
      `signalFence: false` when off; Codex app-server client honours it;
      spawn-worker offload and warm-start reuse skipped when off.
- [x] B4 Renderer: draft field (not persisted per folder), composer toggle (macOS),
      create payload.
- [x] B5 Tests for the registry, resolution, spawn args, schema, renderer payload.

### C. Verification
- [x] C1 Targeted tests, then the canonical gate list in `AGENTS.md`.
- [x] C2 Fresh-eyes completion gate.
- [x] C3 Live checks that need the rebuilt packaged app go to a `_livetest.md` doc.

## As-built notes

- **A1** `src/main/process/host-process-inspector.ts` (list + stop, injectable runtime; `ps` runs
  with `LC_ALL=C` so CPU figures parse in comma-decimal locales) and
  `src/main/process/host-process-instance-hooks.ts` (a session counts as live unless it is
  terminated, failed or unknown; live pids are each instance's `processId` plus its adapter's
  `getPid()`). The environment table is read with `ps axeww -o pid=,ppid=,command=`; a marker is
  ignored when the parent pid differs from the main table (pid-reuse guard). If the environment
  read fails, nothing is flagged as a leftover and every stop is refused.
  `sanitizeProcessLabel` is the former private `commandLabel` from `stall-process-facts.ts`; the
  listing keeps only its first word (program or script name), because the shared label can keep
  short positional arguments. A marker that also appears in the environment-free argv table was
  typed on the command line, so it is treated as invalid.
- **Wiring tests** (from the fresh-eyes review): factory → adapter
  (`adapter-factory-signal-fence.spec.ts`), create → registry (`instance-manager.create.spec.ts`),
  IPC pass-through (both handler specs), renderer store payloads (`instance-list.store.spec.ts`)
  and Codex `connectAppServer` (`codex-app-server-signal-fence.spec.ts`). The factory and create
  tests were mutation-checked: removing the wiring line makes them fail.
- **A2/A3** `src/main/mcp/orchestrator-host-process-tools.ts`, wired beside
  `reset_node_connection`. The RPC cases use `dispatchSameNameTool`. The caller id always comes
  from the RPC context, never from tool arguments. Neither tool is in the `full`/`leaf` toolsets,
  so depth-limited child sessions keep them.
- **B1** Setting `providerSignalFenceEnabled` with a policy spec
  (`settings-control-policy.signal-fence.spec.ts`); the operator-only anchor count is now 25 in
  the spec and both CLI docs. Reader: `src/main/sandbox/signal-fence-setting.ts` (lazy settings
  require, fails safe to ON, test seam `_setSignalFenceSettingForTesting`).
- **B2** Registry `src/main/instance/lifecycle/signal-fence-scoping.ts`; only an explicit
  `signalFence: false` is recorded. Not carried through history restore, by design.
- **B3** `BaseCliAdapter.disableSessionSignalFence()` / `isSignalFenceWanted()`; the Codex
  isolated app-server spawn moved into `buildIsolatedAppServerSpawn` (spawn-policy module), and a
  fence-off session never uses the shared broker. `WarmStartManager.preWarm` skips while the
  operator switch is off, so every warm process is fenced; preflight refuses warm reuse when
  either switch is off. Provider-runtime offload reads the switch through its injected settings.
- **B4** The composer's "Fence ON/OFF" button sits beside Hardened (macOS draft composer only),
  is disabled when Hardened is on or the Settings switch is off, and is never persisted.
  `CreateInstanceWithMessageOptions` moved to the renderer `instance.types.ts` (re-exported from
  the store) to keep `instance-list.store.ts` inside its size ratchet.
- **C2** Fresh-eyes gate: first review FAIL (missing wiring tests, two label/marker nits), fixed; second review PASS; follow-up nit fixes (shell label, `leftoverOnly`, stop audit log, typed setting key) re-reviewed PASS. Full suite 32,456 passed.
- **C3** Deferred live checks: [2026-10-16-host-process-tools-and-fence-switch_livetest.md](2026-10-16-host-process-tools-and-fence-switch_livetest.md).
