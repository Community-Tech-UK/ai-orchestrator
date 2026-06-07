# ADR D5: Plugin Sandboxing and Isolation

**Date:** 2026-06-06  
**Status:** Proposed  
**Author:** Architecture review (D5 task)

---

## Parallel-Agent Ownership Boundary

> Added 2026-06-06. Verified against the live tree: this doc's file set is
> **fully disjoint** from D1 (thin-client event API), D4 (spawn offload), and the
> Auxiliary Local Model Routing doc — it can run in parallel with zero shared
> files. No splitting required.

**This doc OWNS (edit freely):**
- `src/main/plugins/**` — `plugin-manager.ts`, `plugin-source-resolver.ts`,
  new `plugin-worker-host.ts`.
- `src/shared/types/plugin.types.ts`.
- `packages/contracts/src/schemas/plugin.schemas.ts` (add `capabilities`).
- `packages/sdk/src/plugins.ts`.

**Shared boundary files:** none.

**Do NOT touch (owned by other docs):** everything outside the list above —
notably `src/main/event-bus/**` + `src/main/ipc/**` (D1), `src/main/cli/**` +
`src/main/providers/**` (D4), and `src/main/rlm|context|memory|remote-node/**`
(Auxiliary).
Note: `src/main/background-jobs/worker-thread-lane-gateway.ts` and
`process-lane-gateway.ts` are **read-only templates** — reference, never edit.

---

## Context

### Current Trust Model: Full In-Process Node.js Access

Plugins are loaded via dynamic ESM `import()` in the Electron main process.
The key load path is in `src/main/plugins/plugin-manager.ts:388-391`:

```ts
private async loadModule(filePath: string): Promise<OrchestratorPluginModule> {
  const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
  const mod = await import(moduleUrl);
  return (mod && (mod.default || mod)) as OrchestratorPluginModule;
}
```

There is no `vm` context, no `Worker` boundary, no `utilityProcess` fence.
The dynamically imported module executes in the same V8 isolate and OS process
as the Electron main thread.

Every loaded plugin also receives an `OrchestratorPluginContext`
(`plugin-manager.ts:146-150`) containing:

- `instanceManager: InstanceManager` — the live singleton with full public API
  (create, terminate, send input, export sessions, change agent mode, etc.)
- `appPath: string`
- `homeDir: string | null`

This means plugin code inherits the full Node.js ambient environment at the
module level (before `create(ctx)` or any hook is called):

| Capability                          | Available without restriction? |
|-------------------------------------|-------------------------------|
| `require('fs')` / `import 'fs'`     | Yes — full filesystem R/W     |
| `require('child_process')`          | Yes — arbitrary process spawn |
| `require('net')`, `fetch`           | Yes — arbitrary network I/O   |
| `process.env`                       | Yes — read all env vars        |
| `process.exit()`                    | Yes — kills the host app      |
| `require('electron')`               | Yes (main-process context)    |
| `instanceManager.createInstance()`  | Yes — via plugin context       |
| `instanceManager.terminateInstance()` | Yes — via plugin context     |
| `instanceManager.sendInput()`       | Yes — inject arbitrary prompts |

### What Plugins Can Declare (Slot Types)

`src/shared/types/plugin.types.ts:15-23` lists eight slot types:

| Slot                | Dispatched when…                          | Runs untrusted code? |
|---------------------|-------------------------------------------|----------------------|
| `hook`              | Any named lifecycle event                | Yes — in-process     |
| `notifier`          | `reaction:notify-channels` events        | Yes — in-process     |
| `tracker`           | `reaction:event` events                  | Yes — in-process     |
| `telemetry_exporter`| Every `provider:normalized-event`        | Yes — in-process     |
| `provider`          | Declared in manifest; not dispatched yet | Declared, not wired  |
| `channel`           | Declared in manifest; not dispatched yet | Declared, not wired  |
| `mcp`               | Declared in manifest; not dispatched yet | Declared, not wired  |
| `skill`             | Declared in manifest; not dispatched yet | Declared, not wired  |

All four currently-dispatched slots run untrusted code synchronously or via
`await` inside the Electron main thread.

### Existing Stability Guardrails (Not Security Boundaries)

`plugin-manager.ts:621-654` wraps each dispatch in `runPluginOperation`, which:

- Skips quarantined plugins (consecutive failures >= 3).
- Races the plugin call against a 5 s timeout (`PLUGIN_TIMEOUT_MS = 5_000`).
- Catches thrown errors and records them in `PluginRuntimeHealth`.

These are crash-damping mechanisms. A plugin that does not throw — but exfiltrates
data, spawns a shell, or calls `process.exit()` — bypasses them entirely.

The path-safety check in `walkJsFiles` (`plugin-manager.ts:83-87`) prevents
directory traversal when *scanning* for plugin files. It does not restrict what
a loaded plugin can access at runtime.

---

## Threat Model

### What a Malicious or Buggy Plugin Can Do Today

#### A. Actively Malicious Plugin

1. **Data exfiltration** — read `~/.ssh/id_rsa`, `~/.aws/credentials`, or any
   Electron app-data file and `fetch()` it to a remote server, silently, on
   every `instance.output` event.

2. **Prompt injection** — call `ctx.instanceManager.sendInput(instanceId, payload)`
   to inject arbitrary prompts into any running AI agent, redirecting its
   behaviour or extracting its conversation history.

3. **Lateral privilege escalation** — call `ctx.instanceManager.createInstance()`
   to spawn additional agent processes under the user's credentials, using them
   as a compute resource for attacker-controlled tasks.

4. **Session destruction** — call `ctx.instanceManager.terminateInstance()` or
   `ctx.instanceManager.terminateAll()` to destroy all running sessions.

5. **Persistence** — write to `~/.bashrc`, `~/.zprofile`, cron jobs, or launch
   agents; schedule itself to re-execute after uninstall.

6. **Host crash** — call `process.exit(1)` (or throw synchronously in a critical
   path) to kill the Electron main process immediately.

7. **Credential theft** — read `process.env` for `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, OAuth tokens cached by `claude-cli-auth.ts`,
   `codex-cli-auth.ts`, or the settings store on disk.

8. **Supply-chain attack** — the `source.type === 'url'` install path in
   `plugin-source-resolver.ts:43` fetches and installs arbitrary remote code.
   A compromised CDN or a developer machine running a malicious package update
   is sufficient.

#### B. Buggy (Non-Malicious) Plugin

1. **Infinite loop in a hook** — blocks the Electron main thread, freezing all
   AI interactions. The 5 s timeout covers async promises but not synchronous
   CPU spin.

2. **Memory leak** — holds references to large payload objects across every
   `instance.output` event; the host process OOMs.

3. **Unhandled Promise rejection** — because `runPluginOperation` uses
   `void` (fire-and-forget) emission on all event listeners
   (`plugin-manager.ts:901, 918, 927`, etc.), an unhandled rejection only logs
   a warning; it does not crash the host, but it can leave internal state
   inconsistent.

4. **Exception in synchronous `module.exports = …` body** — caught by the
   `try/catch` in `loadPluginsForWorkingDirectory`; the plugin registers as
   failed. Not a host crash, but the plugin's load-time side effects (e.g. a
   `setInterval`) may still be running.

#### C. Summary Risk Matrix

| Attack                       | Detected today? | Mitigated today? |
|------------------------------|-----------------|------------------|
| Data exfiltration via fetch  | No              | No               |
| Prompt injection via ctx     | No              | No               |
| Session termination via ctx  | No              | No               |
| credential read from env     | No              | No               |
| Async timeout crash          | No              | Partial (5 s)    |
| Sync CPU spin                | No              | No               |
| process.exit()               | No              | No               |
| Memory leak                  | No              | No               |

---

## Isolation Options

### Option 1 — `vm.runInNewContext` / vm2

**Mechanism:** Run the plugin body inside a new V8 context, replacing the
global with a curated sandbox object. Node.js `vm` module does not require
workers or OS process creation.

**What it stops:** Access to globals not in the sandbox (`require`, `process`,
`fetch`) from the module body.

**What it does NOT stop:**
- Prototype-pollution escapes (`({}).constructor.constructor('return process')()`)
  — the classic vm sandbox escape that vm2 patched but never fully sealed.
- Access to any object passed into the sandbox (the `ctx` reference leaks
  `instanceManager`, which has full control).
- Native Node addons — a plugin bundling `.node` binaries can call OS APIs
  regardless of the sandbox context.
- Worker threads spawned from within the sandbox (workers inherit process
  capabilities).

**Verdict for this codebase:** Insufficient. vm2 is deprecated and had
security CVEs (CVE-2023-29017). Node.js `vm` is explicitly documented as
**not a security boundary**. A plugin that passes a `vm.Script` test can still
use `({}).constructor.constructor('return process')()`. We would be trading
false confidence for marginal runtime overhead.

**Suitability:** Reject for security threat model; possibly useful as a
lint/API-shape check only.

---

### Option 2 — `worker_threads` Isolation (Current Codebase Pattern)

**Mechanism:** Run each plugin (or all plugins) in a `Worker`. The worker
communicates with the main thread via `postMessage` (structured clone).
The worker cannot hold a reference to main-thread objects.

**What it stops:**
- `ctx.instanceManager` cannot be directly called — the manager is never
  transferred, only event payloads.
- A plugin crash (`process.exit()` is blocked inside workers — only the
  worker terminates, not the main thread).
- Synchronous CPU spin in the worker does not freeze the main thread.
- Memory leaks are scoped to the worker; it can be terminated and restarted.

**What it does NOT stop:**
- Access to `require('fs')`, `child_process`, `net` inside the worker — unless
  the worker is started with restricted permissions (Node.js `--experimental-permission`
  flag, not yet stable or enforced by Electron's bundled Node).
- Exfiltration via network from within the worker.
- A worker that posts many large messages flooding the main thread's event queue.

**Main-thread capability RPC surface:** To be useful, the plugin worker needs
to call back to the manager. That requires a typed RPC contract. Each plugin
capability (e.g. `listenForEvents`, `notifyUser`) becomes an explicit IPC
method. The capability set is the security boundary.

**Codebase compatibility:** `worker_threads` is already used by six subsystems
in this codebase (conversation-ledger, log-writer, code-index, LSP-worker,
watchdog, observability trace sink). The `WorkerThreadLaneGateway` and
`ProcessLaneGateway` patterns (`src/main/background-jobs/`) provide a tested
template for bidirectional worker RPC. The `MEMORY.md` note
"Worker electron import isolation" documents the critical hazard: any transitive
`import 'electron'` inside a worker causes a crash. Plugin workers must use
deep-import guards, exactly as already done in the conversation-ledger worker.

**Performance:** Creating one Worker per plugin is feasible for O(10) plugins.
One shared Worker pool for all plugins is possible but serialises event
dispatch.

**Verdict:** Best fit for this codebase. Addresses the stability/crash threat
model. Does not solve network exfiltration without OS-level controls.

---

### Option 3 — `utilityProcess` / `child_process` with Capability RPC

**Mechanism:** Each plugin runs in a separate OS process (Electron
`utilityProcess.fork()` for packaged app, `child_process.fork()` for dev).
Communication via `process.send()` / `parentPort.postMessage()`.

**What it stops:** Everything Option 2 stops, plus:
- Worker crash takes down only the child process, not the Electron main thread.
- OS-level process limits (CPU, memory) are enforceable via `cpuUsage` limits
  or OS cgroups/sandbox profiles on macOS (`sandbox-exec`).

**What it does NOT stop:**
- Network access from the child process.
- Filesystem access from the child process (without further OS sandboxing).
- A malicious plugin that `require`s its own native addon.

**Tradeoffs vs Option 2:**
- Higher startup cost (full OS process vs thread).
- `electron.utilityProcess` is used once in `process-lane-gateway.ts:198`
  so the plumbing exists.
- Enables future OS-level sandboxing (macOS `sandbox-exec`, Linux seccomp).
- Communicating structured state across process boundary is heavier than
  `postMessage` in a worker.

**Verdict:** Preferred for a high-security posture (actively-malicious threat
model). Better process isolation comes at a moderate complexity premium.
`utilityProcess` in `process-lane-gateway.ts` provides the pattern.

---

### Option 4 — WebAssembly (WASM) Sandbox

**Mechanism:** Plugins are compiled to WASM (or to a WASM-targeted JS runtime
like Wasmtime's `wasmtime-js` or `deno_core`). Execution is constrained by
the WASM memory model — no implicit access to host memory or Node APIs.
Capability I/O is explicit host imports.

**What it stops:** Strongest isolation of all options. A correctly-compiled
WASM module cannot escape its linear memory.

**What it does NOT stop:**
- A WASM module that deliberately calls host-imported capabilities; those
  capabilities are explicit and must be carefully designed.
- Supply-chain attacks on the WASM toolchain itself.

**Tradeoffs:**
- Requires a WASM runtime (Wasmtime, wazero, or a custom embedder).
- All existing plugins are CommonJS/ESM JavaScript — a migration path to WASM
  is a breaking API change with no incremental path.
- Plugin authors must use a WASM-compatible language (C, Rust, AssemblyScript)
  or a JavaScript-to-WASM compiler.
- Debugging WASM is significantly harder than debugging Node.js.
- No existing pattern in this codebase; adds a new dependency class.

**Verdict:** Architecturally superior for the malicious-plugin threat model but
disproportionate for the current plugin ecosystem (a handful of user-written JS
files). Revisit if the plugin marketplace scales to untrusted third-party code.

---

## Recommended Approach

### Immediate: Option 2 (Worker-Thread Isolation) with Capability RPC

Run every plugin module in a dedicated `worker_threads.Worker`. The main thread
communicates via a thin capability RPC layer. The plugin worker:

1. Receives structured event payloads (serialisable data only — no object
   references, no proxies).
2. Calls back to the main thread via a capability interface; the main thread
   exposes only whitelisted operations.
3. Is terminated and replaced on quarantine, rather than merely skipped.

This directly addresses the stability threat model (Option B bugs) and partially
addresses the malicious threat model by removing direct handle access.

### Capability / Permission Model Per Slot Type

The RPC surface exposed to each slot type should follow least privilege:

| Slot                | Receives                            | Can call back              |
|---------------------|-------------------------------------|----------------------------|
| `hook`              | Named lifecycle event payload       | Nothing (read-only observer)|
| `notifier`          | `PluginNotification` payload        | Nothing                     |
| `tracker`           | `PluginTrackerEvent` payload        | Nothing                     |
| `telemetry_exporter`| `PluginTelemetryRecord` payload     | Nothing                     |
| `provider` (future) | Provider dispatch request           | Return completion response  |
| `channel` (future)  | Channel message                     | Post notification           |
| `mcp` (future)      | MCP tool invocation                 | Return tool result          |
| `skill` (future)    | Skill invocation context            | Return result               |

The four currently-dispatched slots (hook, notifier, tracker,
telemetry_exporter) are pure observers — they legitimately need zero callback
capability. They receive event payloads and are expected to side-effect only
their own subsystems (log files, webhook calls, analytics endpoints). Removing
the `instanceManager` reference from their context costs nothing.

**Transition for `ctx.instanceManager`:** The SDK (`packages/sdk/src/plugins.ts`)
already defines `SdkPluginContext` without `instanceManager` — it exposes only
`appPath` and `homeDir`. The `OrchestratorPluginContext` in
`plugin-manager.ts:146` is the main-process type that adds `instanceManager`.
Moving to worker isolation makes the divergence explicit: the worker receives
only `SdkPluginContext`, and any manager interaction is proxied via capability
RPC calls that are individually auditable.

### Mid-term: Option 3 (utilityProcess) for High-Risk Slots

When `provider`, `channel`, `mcp`, and `skill` slots become active, those
plugins will legitimately need richer callback capability (returning AI
responses, posting messages). For those slots, escalate to
`utilityProcess`-per-plugin. The `ProcessLaneGateway` in
`src/main/background-jobs/process-lane-gateway.ts` is the template; adapt it
for plugin processes with the same RPC pattern.

### Capability Declarations in Manifest

Extend `PluginManifestSchema` (`packages/contracts/src/schemas/plugin.schemas.ts:98-115`)
with a `capabilities` array:

```ts
capabilities: z.array(z.enum([
  'network',         // may make outbound HTTP/HTTPS calls
  'filesystem.read', // may read files outside plugin dir
  'filesystem.write',// may write files
  'spawn.process',   // may spawn child processes
  'manager.read',    // may query instance state (not mutate)
  'manager.write',   // may create/terminate/send instances (future hook types only)
])).max(10).optional()
```

The capability list does not enforce at the OS level yet, but it:
- Creates a visible, auditable contract between the plugin and the host.
- Allows the host to warn the user at install time ("This plugin requests
  network access").
- Gives the RPC layer a clear list of which callbacks to expose for each plugin.

---

## Migration Strategy

### Phase 1 — Hardening Without Isolation (Low-Risk, Immediate)

1. **Remove `instanceManager` from `OrchestratorPluginContext`** for all four
   currently-dispatched read-only slots. The SDK context (`SdkPluginContext`)
   already does this correctly; the main-process context should align.
   **File:** `plugin-manager.ts:146-149`, `plugin-manager.ts:351-357`.

2. **Add `capabilities` to `PluginManifestSchema`** and log a warning at load
   time if a plugin declares `network` or `spawn.process` (these are not
   currently enforceable but create an audit trail).

3. **Block `process.exit` side-effect** — no practical way to prevent this
   in-process; document it as a known gap pending Phase 2.

### Phase 2 — Worker-Thread Isolation (Recommended, Sandboxes New Slots)

1. Create `src/main/plugins/plugin-worker-host.ts` using the
   `WorkerThreadLaneGateway` pattern from
   `src/main/background-jobs/worker-thread-lane-gateway.ts`.
   - The worker host receives serialised event payloads and returns results.
   - The worker module file must not import from `electron` (existing guard
     pattern from MEMORY.md note "Worker electron import isolation").

2. New plugins load into the worker host by default.

3. Existing plugins continue in-process (legacy mode) with a deprecation
   warning at load time.

4. The worker host exposes a capability RPC that initially has zero outbound
   calls (pure observer mode for hook/notifier/tracker/telemetry_exporter).

### Phase 3 — Process Isolation for Active Slots (Future)

When `provider`, `mcp`, `skill` slots are dispatched:

1. Use `utilityProcess.fork()` (or `child_process.fork()`) via an adapted
   `ProcessLaneGateway`.
2. Expose only the capabilities declared in the plugin manifest.
3. Optionally apply macOS `sandbox-exec` profile to the child process for
   filesystem restriction.

### Opt-In Posture

For an existing plugin ecosystem, the safest rollout is:

- New installs → worker mode by default.
- Existing discovered plugins (from `~/.orchestrator/plugins/`) → in-process
  legacy mode with a console warning. The user or plugin author must opt in to
  worker mode by adding `"isolation": "worker"` to `plugin.json`.
- Worker mode becomes the default for all discovered plugins in a future
  version, at which point legacy mode requires an explicit opt-out.

---

## Performance Cost

| Change                                    | Estimated overhead per dispatch |
|-------------------------------------------|---------------------------------|
| Worker creation (per plugin, at load)     | ~30-80 ms (one-time)            |
| Structured-clone serialisation of payload | ~0.1–2 ms for typical payloads  |
| postMessage round-trip latency            | ~0.05–0.5 ms                    |
| Worker termination on quarantine          | ~10–20 ms                       |

For `hook` and `telemetry_exporter` plugins — which fire on every agent output
message — the serialisation cost is the dominant term. A 2 ms overhead per
output message per plugin is acceptable for O(5) plugins but would be
noticeable at O(50). Batched event dispatch (send a queue of payloads in one
`postMessage`) can reduce this to sub-millisecond amortised cost.

The 5 s timeout already in `runPluginOperation` naturally bounds async plugin
calls. In worker mode, a synchronous CPU spin in the worker no longer blocks
the main thread, eliminating the most dangerous tail latency path.

---

## Open Decisions for James

### 1. Which threat model?

This is the single most important decision and gates the entire approach:

- **Threat model A — Buggy-plugin stability:** The plugins are authored by
  you or trusted contributors. The concern is a well-intentioned plugin that
  throws, hangs, or leaks memory crashing or degrading the host.
  → Phase 1 + Phase 2 (worker threads) is sufficient and achievable in a day.
  The `instanceManager` removal + worker isolation closes all stability gaps.

- **Threat model B — Actively-malicious plugin:** The plugin registry will
  eventually accept third-party submissions, or a supply-chain attack could
  compromise a dependency. A plugin must not be able to read credentials, spawn
  processes, or exfiltrate data even if it tries to.
  → Requires Phase 3 (process isolation) plus OS-level sandboxing
  (`sandbox-exec` on macOS). This is a multi-week effort and changes the
  plugin authoring model significantly.

The current codebase has no mechanism to distinguish between the two. The ADR
recommends targeting threat model A immediately, with the architecture
explicitly designed to escalate to B without a rewrite.

### 2. Should `ctx.instanceManager` be removed from all contexts, or kept for future active slots?

Removing it now from hook/notifier/tracker/telemetry_exporter is low-risk and
closes a large attack surface for free. But `provider`, `mcp`, and `skill`
slots will need some manager access when they are dispatched. Should the
capability be added back via explicit RPC calls, or should those future slots
receive a scoped proxy?

**Recommendation:** Remove entirely from the current context. Add back as
explicit, named capability methods (e.g. `ctx.capabilities.queryInstanceState()`)
when the active slots are designed. Do not keep the full manager reference as
a "convenience for later."

### 3. Manifest `capabilities` field — advisory or enforced?

Making it advisory (log-only) gives zero security but creates an audit trail
with no implementation cost. Enforcing it requires the capability RPC to
gate calls at the RPC layer. Recommended stance: advisory in Phase 1,
enforced at the RPC boundary in Phase 2.

### 4. URL-sourced plugin installs

`plugin-source-resolver.ts:71-80` allows installing plugins from arbitrary
URLs. This is the widest attack surface — a URL pointing to a CDN can serve
different code to different installations. Should URL installs be:
- Blocked unless the manifest declares a checksum (it already has a `checksum`
  field in `PluginPackageSourceSchema`)?
- Require a user confirmation dialog showing requested capabilities?
- Disabled entirely pending a plugin marketplace with signed packages?

This is independent of the sandboxing work but is the most likely vector for
supply-chain compromise.

### 5. Plugin discovery from project directories

Plugins are currently loaded from `<project-scan-roots>/.orchestrator/plugins/**.js`
(`plugin-manager.ts:339-349`). A cloned repository can contain a `.orchestrator/plugins/`
directory that auto-executes on first workspace open. Should project-local
plugins require explicit opt-in (a settings flag or a confirmation prompt)?
This is a TOFU (trust on first use) decision.

---

## Summary of Evidence

| Claim | Evidence file:line |
|-------|--------------------|
| Plugins loaded via bare `import()` in main process | `plugin-manager.ts:388-391` |
| Context exposes full InstanceManager | `plugin-manager.ts:146-149`, `plugin-manager.ts:351-357` |
| Quarantine = stability only, not security | `plugin-manager.ts:628-631`, `plugin.types.ts:54-68` |
| 5 s timeout guards async dispatches only | `plugin-manager.ts:621` |
| All four dispatched slots run in-process | `plugin-manager.ts:731, 745, 759, 773` |
| SDK context already omits instanceManager | `packages/sdk/src/plugins.ts:290-293` |
| Worker pattern already in use (6 subsystems) | `src/main/background-jobs/worker-thread-lane-gateway.ts`, `src/main/conversation-ledger/` |
| utilityProcess pattern already in use | `src/main/background-jobs/process-lane-gateway.ts:198-201` |
| URL-sourced install path | `src/main/plugins/plugin-source-resolver.ts:43-52` |
| manifest `checksum` field exists | `packages/contracts/src/schemas/plugin.schemas.ts:77-80` |
