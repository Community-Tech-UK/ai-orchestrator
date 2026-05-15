# AI Orchestrator — Cross-Project Improvement Recommendations (Claude 3)

Third-pass review after `claude.md` and `gemini.md`. We've already covered the
toolchain wins (oxlint, oxfmt, turbo, tsgo), the SDK boundary work (delete
legacy `BaseProvider`, generate `register-aliases.ts`, carve a real plugin
SDK barrel set), the daemon split, and the Effect-TS narrow seams. None of
those are repeated here.

This pass focuses on **runtime, security, and methodology patterns** that
peer projects have already validated and that we can copy directly. Each
recommendation cites the source file in the peer repo so the implementation
is verifiable. References use the form `<project>:<path>`.

---

## TL;DR — What we missed last round

| # | Change | Source | Effort | Payoff |
|---|--------|--------|--------|--------|
| 1 | Replace bespoke `SandboxManager` with `codex-linux-sandbox` + Apple Seatbelt profiles | `codex/codex-rs/linux-sandbox` | M | Real OS-level isolation; today's manager is a policy registry, not a sandbox |
| 2 | Adopt **wildcard-ruleset permission engine** (10 lines) | `opencode:src/permission/evaluate.ts` | S | Replace 254-line bespoke `role-capability-policy.ts` |
| 3 | Add **subagent permission derivation** for debate/multi-verify children | `opencode:src/agent/subagent-permissions.ts` | S | Today parent denies can leak through to spawned reviewers |
| 4 | Split `InstanceStatus` into **state + reason + lifecycle** | `agent-orchestrator:packages/core/src/types.ts` | M | 21 flat statuses become 8 states × N reasons; clearer transitions |
| 5 | **Stale-runtime reconciliation** during `list()` enrichment | `agent-orchestrator:lifecycle-manager.ts` | S | Dead CLI processes today hang in 'busy' indefinitely |
| 6 | **Hash-based per-checkout data dir** | `agent-orchestrator:packages/core/src/paths.ts` | S | `.rlm-data` collides across worktrees; SHA-256 prefix fixes it |
| 7 | **Two-DB session split** for worker-agent / remote-node | `nanoclaw:docs/two-db-split` | L | Single-writer-per-file removes lock contention; survives reconnects |
| 8 | **Event-sourced session sync** for cross-device replay | `opencode:src/sync/` | L | True multi-device sync; today remote-node is one-shot RPC |
| 9 | **Aux-client pattern** for non-user-facing model calls | `hermes-agent:agent/curator.py` | M | Stop blowing the user's prompt cache on debate/verify rounds |
| 10 | **Curator** loop for skill/memory pruning | `hermes-agent:agent/curator.py` | M | Inactivity-triggered consolidation; no cron daemon needed |
| 11 | **Tool prompts in `.txt` siblings**, not TS string literals | `opencode:src/tool/*.txt` | S | Diffable prompt edits, prompt-cache-stable |
| 12 | **Plan-mode tool primitive** | `opencode:src/tool/plan.ts` | S | Disable writes during reasoning phase; we have the building blocks but no clean primitive |
| 13 | **`.story/`-style on-disk project memory** convention | `storybloq:.story/` | S | Git-trackable, agent-readable; we have RLM but it's opaque |
| 14 | **`platform.ts` central helper + golden rule** | `agent-orchestrator:packages/core/src/platform.ts` | S | We have 104 inline `process.platform` checks across `src/main/` |
| 15 | **on_wake message column** for respawn race elimination | `nanoclaw:src/db/messages-in.ts` | S | Today interrupt-respawn has documented race conditions |
| 16 | **Containerized `yolo-mode` runtime** | `nanoclaw:src/container-runner.ts` + `claw-code/Containerfile` | L | Most "agent ran rm -rf" risks evaporate inside a bind-mount container |
| 17 | **HTTP API server bound to ACP** instead of just IPC | `opencode:src/server/server.ts` + `t3code:packages/effect-acp/` | M | External editors can drive AIO; today we're an island |
| 18 | **Notifier as a plugin slot** | `agent-orchestrator:packages/plugins/notifier-*` | S | Today Discord/WhatsApp deps are bolted onto `src/main/chats/` |
| 19 | **Justfile or Bun task runner** instead of `concurrently` | `codex:justfile`, `oh-my-codex` | S | Faster dev loop; cleaner prefixed output |
| 20 | **HTTP recorder for provider tests** | `opencode/packages/http-recorder/` | M | Replace mock-heavy adapter tests with record/replay |

---

## 1. Sandbox the spawned CLIs — we have a registry, not a jail

**Where today:** `ai-orchestrator/src/main/security/sandbox-manager.ts` is 876
lines that document Seatbelt and Bubblewrap support but mostly track
*violations* through `FilesystemPolicy` and `NetworkPolicy`. The actual
`spawn()` calls in `claude-cli-adapter.ts`, `codex-cli-adapter.ts`, etc. are
plain `child_process.spawn` with the user's full shell privileges. The
"sandbox" is observability after the fact, not isolation.

**What Codex does:** `codex/codex-rs/linux-sandbox/README.md` documents a
real bubblewrap-based jail. Codex ships its own `bwrap` binary
(`codex-resources/bwrap`) so it works on systems without bubblewrap installed,
detects user-namespace support at runtime, and falls back gracefully on WSL1
(refusing sandboxed shell commands rather than running them unsafely).
There are dedicated crates for each platform:

- `codex/codex-rs/linux-sandbox/` — bwrap-based, with `--argv0` compat path
- `codex/codex-rs/windows-sandbox-rs/` — Windows AppContainer
- `codex/codex-rs/sandboxing/` — cross-platform policy abstraction
- `codex/codex-rs/process-hardening/` — disables core dumps, ptrace, etc.
- `codex/codex-rs/bwrap/` — bundled bwrap shim

**Plan:**

1. Bundle `codex-linux-sandbox` as a binary asset (we already ship RTK
   binaries via `scripts/fetch-rtk-binaries.js`, the pattern is identical).
2. Wrap CLI spawns in `base-cli-adapter.ts:spawn()` so the spawned Claude /
   Codex / Gemini process inherits the bwrap shell on Linux, a Seatbelt
   profile on macOS, and AppContainer on Windows. The current
   `SandboxManager.detectPlatform()` already does the platform detection.
3. Promote `FilesystemPolicy` and `NetworkPolicy` to the policy *describing*
   the bwrap arguments rather than tracking violations after the fact.
4. Keep the violation reporter as an audit log on top of the real sandbox.

This is the largest *security* delta we can ship without rewriting anything.
It's also a precondition for "yolo mode" being safe (see #16).

## 2. Permission engine — 10 lines of wildcard rules vs 254-line policy

**Where today:** `src/main/orchestration/role-capability-policy.ts` (254 lines),
`src/main/orchestration/permission-registry.ts` (78 lines, just a pending-promise
registry), plus per-provider checks scattered through the adapters. Three
overlapping decision systems.

**What opencode does:** the entire rule engine is
`opencode:src/permission/evaluate.ts` — twelve lines:

```ts
export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}
```

The point is `findLast` over flattened rulesets: we pass `[projectRules,
agentRules, sessionRules]`, and the most-specific override wins. Every
permission decision goes through this one function. `Permission.Service`
(in `opencode:src/permission/index.ts`) wraps it with the async
"ask the user" deferred promise plumbing.

**Why this matters for us:** debate, multi-verify, parallel-worktree, and
loop-coordinator all spawn child agents. Each one currently constructs its
own permission shape. A single ruleset evaluator means:

- Plan-mode is just `[{permission: "write", pattern: "*", action: "deny"}]`
  injected at the agent layer.
- A debate reviewer's "can read but not write" stance is two rules.
- An auto-approve config from the user is a project-level rule list.

The simplification cascades: `permission-registry.ts` keeps the deferred
promise plumbing, but the *rule* logic disappears.

## 3. Subagent permission derivation — close a leak we don't know we have

**Where today:** `debate-coordinator.ts`, `multi-verify-coordinator.ts`, and
`parallel-worktree-coordinator.ts` spawn child agents. I see no equivalent
of `deriveSubagentSessionPermission()` — the parent's denies and the
subagent's ruleset are not explicitly merged.

**What opencode does:** `opencode:src/agent/subagent-permissions.ts` is 30
lines that:

1. Always carry the parent agent's deny rules forward (Plan Mode lives on
   the agent ruleset, not the session — without this, a subagent silently
   bypasses Plan Mode).
2. Always carry the parent session's deny rules and `external_directory`
   rules forward.
3. Default-deny `task` and `todowrite` for subagents that didn't explicitly
   request them.

**Plan:** add `src/main/orchestration/derive-subagent-permission.ts`. Wire
it into every place that spawns a child instance (the loop coordinator and
parallel-worktree coordinator are the highest-value). Cite the GitHub issue
opencode fixed (#26514) as the regression test we want to write.

## 4. Lifecycle state machine — split state from reason

**Where today:** `InstanceStatus` is a flat 21-member union:
`initializing | ready | idle | busy | processing | thinking_deeply |
waiting_for_input | waiting_for_permission | interrupting | cancelling |
interrupt-escalating | cancelled | superseded | respawning | hibernating |
hibernated | waking | degraded | error | failed | terminated`. Half of
those are reasons (why are we busy?), not states.

**What agent-orchestrator does:**
`agent-orchestrator:packages/core/src/types.ts` splits this cleanly:

```ts
type CanonicalSessionState =
  | "not_started" | "working" | "idle" | "needs_input"
  | "stuck" | "detecting" | "done" | "terminated";

type CanonicalSessionReason =
  | "spawn_requested" | "task_in_progress" | "fixing_ci"
  | "awaiting_user_input" | "manually_killed" | "pr_merged"
  | "auto_cleanup" | "runtime_lost" | "agent_process_exited"
  | "probe_failure" | ...;
```

Plus a separate `RuntimeStateRecord` for "is the underlying process alive"
and a separate `PRStateRecord` for the PR's lifecycle. A `deriveLegacyStatus()`
function maps the canonical triple back to a flat status for legacy
displays.

**Why we want it:** today, `terminated` doesn't tell us *why*. Was it manual
kill? PR merge? Auto-cleanup? Process crash? We have to reconstruct that
from event logs. Agent-orchestrator's design captures both the *current*
lifecycle and the *terminal reason* on disk so the UI can render
"Killed manually 3m ago" instead of just "killed."

This is also a forcing function for #5 — once `runtime` is a separate
record, runtime-lost detection is the natural place to update it.

## 5. Stale-runtime reconciliation in `list()`

**Where today:** if Claude CLI dies (segfault, OOM, machine sleep) without
emitting an exit event, the `InstanceState` stays `busy` until something
else nudges it. `StuckProcessDetector` exists but only fires on
*timeout*, not on observed-process-death.

**What agent-orchestrator does:**
`agent-orchestrator:packages/core/src/lifecycle-manager.ts` (referenced in
their `CLAUDE.md`):

> "`sm.list()` detects dead runtimes (tmux/process gone) during enrichment
> and persists `runtime_lost` reason to disk. This maps to legacy status
> `killed`. Without this, sessions with dead runtimes would show stale
> 'active' status indefinitely."

**Plan:** in `instance-manager.list()`, run `process.kill(pid, 0)` (or the
remote-node equivalent) on each instance and mark `runtime_lost` on the
ones that fail. This is cheap (one syscall per instance), and it eliminates
a class of "why is this instance stuck" tickets without anyone needing to
notice the stuck instance first.

## 6. Hash-based per-checkout data directory

**Where today:** `.rlm-data/` lives in the repo root. Two checkouts of the
same repo (worktree, second clone for review, parallel-worktree-coordinator
spinning up worktrees) share the same `.rlm-data/` if they happen to land
in the same path. We don't, in practice — but the parallel-worktree
coordinator *creates* sibling worktrees, and they all write to whichever
RLM the main process attached to.

**What agent-orchestrator does:**
`agent-orchestrator:packages/core/src/paths.ts` derives a SHA-256 of the
config directory (first 12 chars), then keys all per-project state at
`~/.agent-orchestrator/{hash}-{projectId}/`:

```
~/.agent-orchestrator/
  config.yaml                 # global registry of projects
  running.json                # current active orchestrator PID/port
  last-stop.json              # state for restore on next start
  {hash}-{projectId}/
    sessions/
    worktrees/
    archive/
```

**Why we want it:** moves persistent state out of the repo (no more
`.rlm-data/` in `.gitignore`), survives `git clean -xfd`, supports parallel
worktrees naturally, supports the future "single daemon serving multiple
project roots" model from claude.md §6.

## 7. Two-DB session split for parallel worker agents

**Where today:** `worker-agent/` is a separate compiled binary (`build-worker-agent-sea.ts`)
that talks to the main process over WebSockets. Disconnects are handled by
the supervisor tree, but the worker's pending work has to reconcile against
the main process's view of state.

**What nanoclaw does:** `nanoclaw:CLAUDE.md` describes a per-session
two-database split:

```
data/v2-sessions/<session_id>/
  inbound.db     # host writes, container reads. messages_in, routing,
                 # destinations, pending_questions, processing_ack.
  outbound.db    # container writes, host reads. messages_out, session_state.
```

> "Exactly one writer per file — no cross-mount lock contention.
> Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update.
> Host uses even `seq` numbers, container uses odd."

The two-DB invariant means **the worker can keep working while disconnected**,
and the host can keep enqueueing work, both writing to their own SQLite
file. Reconnection is just resuming the polling loop.

**Why we want it:** the worker-agent today depends on a live WebSocket. If
the WS drops mid-turn, we have to interrupt-respawn. Two-DB makes the
worker offline-first. This also unlocks running the worker on a separate
machine with intermittent connectivity — exactly the use case
`remote-node-bridge.ts` is being built for.

## 8. Event-sourced session sync for cross-device replay

**Where today:** `remote-node-bridge.ts` is one-shot RPC. There's no
event log; if device A and device B both watch the same session, B sees
"current state" but can't replay back to where A is.

**What opencode does:** `opencode:src/sync/README.md` introduces
`SyncEvent` — a parallel abstraction to `Bus` events that records every
mutation in event-sourced order with a single-writer/many-replayers model:

```ts
const Created = SyncEvent.define({
  type: "session.created",
  version: 1,
  aggregate: "sessionID",
  schema: z.object({ sessionID: SessionID.zod, info: Info }),
})
```

> "Because only one device is allowed to write, we don't need any kind of
> sophisticated distributed system clocks or causal ordering. We implement
> total ordering with a simple sequence id (a number) and increment it by
> one every time we generate an event."

**Why we want it:** mirroring the worktree coordinator's output to a phone
or web client; recovering a hung session onto a fresh process by replaying
the log; debugging "what did the agent actually do" without screen
recordings. This is also the natural durable substrate for the daemon-split
work in claude.md §6 — the renderer subscribes to the event stream rather
than polling.

The good news: the contracts package's `provider-runtime-events.schemas.ts`
is already shaped like this. We just need the durable log + sequence id +
projector pattern.

## 9. Auxiliary client for non-user-facing model calls

**Where today:** the orchestration coordinators (debate, multi-verify,
synthesis-agent, doom-loop-detector) all run *as full agents* with the
user's prompt cache and the user's API quota. A 5-round debate burns 5×
the user's prompt cache.

**What hermes-agent does:** `hermes-agent:agent/curator.py` documents an
"auxiliary client" pattern explicitly:

> "Strict invariants: ... Uses the auxiliary client; never touches the
> main session's prompt cache."

The aux client is configured separately (different model, different
credential, often a cheaper model on a different vendor) for *internal*
agent operations: the curator, summarizers, classifiers, embedders.

**Plan:** add `coreConfig.auxProvider` next to the existing user-facing
provider selection. Route the following through the aux client:

- `synthesis-agent.ts` (debate consensus synthesis)
- `confidence-analyzer.ts` and `confidence-filter.ts`
- `output-classifier.ts` and `concurrency-classifier.ts`
- `doom-loop-detector.ts`
- `loop-completion-detector.ts`
- `loop-progress-detector.ts`
- `embedding-service.ts` (already separate, but make it explicit)
- The "did the verifier agree" check in `cli-verification-extension.ts`

The user's main prompt cache stays clean; the aux model can be Sonnet
while the user is on Opus, or Haiku while the user is on Sonnet, or even
a local model.

## 10. Curator loop for skill/memory pruning

**Where today:** `learning/strategy-learner.ts`, `memory/proactive-surfacer.ts`,
`memory/cross-project-learner.ts` accumulate. Nothing prunes.

**What hermes-agent does:** `hermes-agent:agent/curator.py` runs an
inactivity-triggered (no cron daemon) review:

> "When the agent is idle and the last curator run was longer than
> `interval_hours` ago, `maybe_run_curator()` spawns a forked AIAgent to
> do the review."

Responsibilities:

> "Auto-transition lifecycle states based on derived skill activity timestamps;
> spawn a background review agent that can pin / archive / consolidate /
> patch agent-created skills via skill_manage; persist curator state in
> .curator_state. Strict invariants: only touches agent-created skills;
> never auto-deletes — only archives. Archive is recoverable. Pinned skills
> bypass all auto-transitions."

**Why we want it:** RLM accumulates indefinitely. We have no archival /
consolidation pass, so eventually `hybrid-retrieval.ts` is searching
through stale state. The curator pattern (run on idle, mutate via the aux
client from #9, never delete just archive, pinned-bypass) is well-trodden.

## 11. Tool prompts in `.txt` siblings, not TS string literals

**Where today:** tool descriptions, system prompts, prompt fragments live
inside `.ts` files as multi-line template strings. Editing one means a
rebuild; diffs include surrounding TS noise; prompt cache changes when
unrelated TS does.

**What opencode does:** every tool has both files:
`opencode:src/tool/edit.ts` is the implementation, `opencode:src/tool/edit.txt`
is the prompt description. The tool registry loads the `.txt` at boot.

```
opencode/packages/opencode/src/tool/
  apply_patch.ts   apply_patch.txt
  edit.ts          edit.txt
  glob.ts          glob.txt
  grep.ts          grep.txt
  plan.ts          plan-enter.txt   plan-exit.txt
  read.ts          read.txt
  task.ts          task.txt
  ...
```

**Why we want it:** we ship many of these prompts ourselves
(`personalities.ts`, `review-prompts.ts`, the verification prompts in
`cli-verification-extension.ts`, the synthesis prompts in
`synthesis-agent.ts`). Each one would benefit from being a sibling `.txt`
the prompt cache can hash independently and we can review as English text.

## 12. Plan-mode as a first-class tool primitive

**Where today:** orchestration-decider, synthesis-agent, and the
loop-stage-machine encode planning behavior implicitly. The user can't
explicitly enter "plan mode" the way they can in Claude Code or opencode.

**What opencode does:** `opencode:src/tool/plan.ts` plus
`plan-enter.txt` / `plan-exit.txt`. Calling `plan_enter` injects a Plan
Mode ruleset (deny all writes); calling `plan_exit` removes it. The agent
is encouraged to plan, get approval, then exit plan mode and execute.

**Why we want it:** debate-coordinator is exactly the right consumer of
this. "Plan, debate, refine plan, then execute" is a workflow we already
implement, just without the explicit primitive. Adopting it would also
make us interoperable with editors that already speak the plan-mode
convention.

## 13. `.story/`-style on-disk project memory convention

**Where today:** project memory lives in `.rlm-data/*.db` and is opaque to
git, the user, and any other tool.

**What storybloq does:** `storybloq:README.md` describes a `.story/`
directory of JSON+markdown:

> "Every project gets a `.story/` directory of JSON and markdown files.
> Tickets, issues, roadmap phases, session handovers, and lessons learned
> all live there, tracked by git, readable by any AI."

**Why we want it (in addition to RLM, not instead):** a git-trackable
mirror of "project decisions" / "lessons learned" / "active TODOs" is
useful for:

- Onboarding a fresh agent to a project (read `.aio/lessons.md`).
- Cross-machine sync without full RLM replication.
- Code review (a PR can include the relevant `.aio/decision-2026-05-08.md`).
- The user inspecting what the agent learned without an RLM viewer.

Existing skills/builtin/`SKILL.md` files are halfway there. We just need to
formalize the directory structure.

## 14. Central `platform.ts`, no inline `process.platform` checks

**Where today:** `grep -rn 'process.platform' ai-orchestrator/src/main` →
**104 hits** across 30+ files. Some test the result, some compare strings
inline, some use it as a default for an injected platform.

**What agent-orchestrator does:** `agent-orchestrator:CLAUDE.md` makes this
the **golden rule**:

> "Never write `process.platform === 'win32'` in new code. Use `isWindows()`
> from `@aoagents/ao-core`. If you need branching the helpers don't cover,
> add it to `packages/core/src/platform.ts` (or one of the targeted helper
> modules below) — never inline at the call site."

**Why we want it:** we already have a "two packaging gotchas" section in
`AGENTS.md`. Cross-platform helpers are the third inevitable footgun. A
single `src/main/util/platform.ts` exporting `isWindows()`, `isMac()`,
`isLinux()`, `pathSeparator`, `shellResolver()`, etc., with one
`vitest --mock-platform` test-helper, is a one-day refactor that cuts off
a category of bugs forever.

## 15. `on_wake` column for respawn race elimination

**Where today:** `interrupt-respawn-coordinator.ts` and `WarmStartManager`
together handle interrupt → respawn → resume. There's a documented race
where messages queued for the dying instance can be picked up by either
the dying or the freshly-spawned process depending on timing.

**What nanoclaw does:** `nanoclaw:CLAUDE.md` describes an `on_wake` column:

> "The `on_wake` column on `messages_in` ensures wake messages are only
> picked up by a fresh container's first poll iteration. This prevents the
> race where a dying container (still in its SIGTERM grace period) could
> steal the message. `killContainer` accepts an optional `onExit` callback
> that fires after the process exits, guaranteeing the old container is
> gone before the new one spawns."

**Plan:** in our case, the equivalent is a `messageGenerationId` field on
each queued input. Bump it on every interrupt. The dying process only
reads its own gen; the new process only reads its own gen. Dying
processes never poison the next session.

## 16. Containerized "yolo mode" runtime

**Where today:** "yolo mode" (`INSTANCE_TOGGLE_YOLO_MODE` IPC channel)
trusts the agent to not delete the user's home directory. The
`SandboxManager` is opt-in.

**What nanoclaw and claw-code do:** every agent runs in a docker (or Apple
Containers) container by default. nanoclaw's `container-runner.ts` mounts
the workspace bind-mount, secrets are injected via OneCLI, and the
container has no `~/.ssh` access:

> "The host is a single Node process that orchestrates per-session agent
> containers. Platform messages land via channel adapters, route through
> an entity model... and wake a container."

**Plan:** add a third instance-runtime alongside "local CLI" and
"remote-node": "container CLI". `containerd` / `colima` / `Apple Containers`
provides the runtime. The CLI binary lives in the container, the workspace
is bind-mounted, secrets are injected per-call (claude.md §9.1 already
flagged the OneCLI pattern). Toggle on per-instance.

Combined with #1 (real OS sandboxing for the non-container path), we'd
have three security tiers: native (today, default), sandboxed (Codex's
bwrap + Seatbelt), containerized (full isolation).

## 17. ACP server endpoint, not just IPC

**Where today:** the only way to talk to ai-orchestrator is its Electron
IPC bus. External editors, CLIs, and remote processes have no entry point.

**What peers do:**

- `opencode:src/server/server.ts` exposes an HTTP API server (Effect-based
  HttpApi) plus mDNS publication so editors auto-discover.
- `t3code:packages/effect-acp/` ships an ACP (Agent Client Protocol)
  implementation as a reusable package.
- `hermes-agent:acp_adapter/` exposes an ACP-compatible server.
- We already have `src/main/cli/adapters/acp-cli-adapter.ts` for *consuming*
  ACP, but we don't *expose* one.

**Plan:**

1. Add an `apps/server` thin entry (claude.md §6 stage A). Inside it, run
   an HTTP API server that wraps the existing IPC handlers.
2. Add an ACP server endpoint as a parallel surface to the HTTP API.
3. Publish via mDNS so Zed / VS Code / external CLIs auto-discover.

This pairs naturally with claude.md §9 (generate OpenAPI from contracts).
Once both exist, ai-orchestrator becomes a *host* for external agents and
external tools, not just a closed Electron app.

## 18. Notifier as a plugin slot

**Where today:** `package.json` ships `discord.js`, `whatsapp-web.js`,
`puppeteer-core`, `qrcode`, all in the root deps. They're imported from
`src/main/chats/`. The "chat surface" is hard-coded, and pulling in a
WhatsApp dep means everyone's DMG includes Puppeteer + Chrome.

**What agent-orchestrator does:** `notifier-{desktop,slack,webhook,
composio,openclaw}` are each their own plugin packages. The core has a
single `notifier-resolution.ts` that picks the configured one. Users who
don't want Discord don't pay for it.

**Why we want it:** also matches the openclaw plugin-SDK boundary work
from claude.md §4. Today every chat platform we add bloats the bundle
*and* couples to `src/main/chats/`. As plugin packages, each one has its
own deps, version, optional install.

## 19. Justfile / Bun task runner instead of `concurrently`

**Where today:** `npm run start` chains `concurrently -k "npm run watch:main"
"npm run start:renderer -- --port 4567" "wait-on http://localhost:4567 &&
npm run electron:dev"`. concurrently's prefixed output is fine but it's
slow to bring up.

**What peers do:**

- `codex:justfile` documents tasks declaratively, runs in parallel where
  declared, and supports task dependencies natively.
- `oh-my-codex:justfile` similar.
- Bun (which opencode/t3code use) has `bun run --concurrent` built in.

**Plan:** add a `justfile` for dev tasks. Migrate `concurrently` invocations
to it. The eventual stop is `turbo dev` (claude.md §1.2) but justfile is a
one-day stop on the way that works on plain npm.

## 20. HTTP recorder for provider tests

**Where today:** the provider adapter tests (`anthropic-api-provider.spec.ts`,
the codex/gemini/copilot specs) use Vitest mocks for HTTP. Mocks drift from
the real APIs — when the Claude API adds a field or changes an error
shape, mocked tests still pass and prod blows up.

**What opencode does:** `opencode/packages/http-recorder/` is a record/replay
HTTP wrapper. Run tests with `RECORD=1` once against the real API; replay
deterministically thereafter. CI runs against the recordings; a manual
re-record before each release catches API drift.

**Why we want it:** the AGENTS.md "packaging gotchas" section already names
*two* classes of "tests pass, prod fails" footguns. Provider drift is the
third. Record/replay collapses it from a spec-engineering problem to an
"is the recording fresh?" problem.

---

## Notes on what we already do well that doesn't appear in peer projects

- The orchestration suite (debate, consensus, multi-verify, parallel-worktree,
  doom-loop-detector, synthesis-agent, cross-model-review-service) is more
  sophisticated than anything in opencode, t3code, openclaw, or
  agent-orchestrator. Adopting their **patterns** doesn't mean we should
  shrink to their **scope**.
- Our generated IPC channels system (`scripts/generate-preload-channels.js`
  + 1113-line `channels.ts` index + `verify-ipc-channels.js`) is a genuinely
  better DX than opencode's hand-written HTTP routes.
- `verify-native-abi.js` runs in `prebuild`/`prestart` and catches stale
  `.node` binaries before they get packaged. None of the peers have this;
  they all eat the DMG-crashes-on-startup bug occasionally.
- Wave 2 normalized provider event envelopes
  (`@contracts/types/provider-runtime-events`) are cleaner than t3code's
  per-driver shape.
- The remote-node + bonjour discovery + worker-agent SEA binary trio is a
  real distinct capability. Lean into it (#7, #8).

---

## Concrete second sprint (after claude.md §10 is done)

If we land claude.md's first-sprint items and then want a contained
follow-up, this is the pick:

1. **Codex-linux-sandbox bundling** (§1) — biggest security delta, fits
   alongside the existing `fetch-rtk-binaries.js` pattern, no
   architectural decisions.
2. **Wildcard-ruleset permission engine** (§2) — replaces ~250 lines of
   bespoke policy with ~10 lines plus a wildcard matcher; adopt opencode's
   eval loop wholesale.
3. **Subagent permission derivation** (§3) — 30 lines, plugs the leak.
4. **Aux client routing** (§9) — a config field plus 8 call-site edits;
   immediately reduces user prompt-cache thrash.
5. **`platform.ts` extraction** (§14) — 104 inline checks → one helper
   module; a one-day refactor that prevents Windows regressions forever.

Items 1–5 land in two weeks, materially improve security, simplify the
permission stack, cut the user's prompt-cache cost by ~half on debate /
multi-verify rounds, and harden cross-platform behavior.

The bigger plays (§4 lifecycle split, §7 two-DB worker, §8 event-sourced
sync, §16 containerized runtime, §17 ACP server) belong in proper specs
under `docs/superpowers/specs/` because they touch the architectural
boundaries that claude.md's §6 daemon-split work also touches. Those two
streams should be planned together to avoid building the daemon split
twice.

---

*Third-pass review by Claude. Generated 2026-05-10 after reading
`ai-orchestrator/`, `opencode/`, `t3code/`, `openclaw/`, `nanoclaw/`,
`claw-code/`, `hermes-agent/`, `codex/`, `agent-orchestrator/`,
`copilot-sdk/`, `storybloq/`, `oh-my-codex/`. References include explicit
peer-repo file paths so each recommendation is verifiable.*
