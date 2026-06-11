# Prompt: map AIO's Claude fan-out and build a cost-routing policy

Hand this to a coding agent working inside the `ai-orchestrator` repo. It assumes the
findings in `AIO_CLAUDE_BILLING_FEASIBILITY.md` and does not re-litigate them.

---

## Role

You are a senior TypeScript engineer working in our Electron + Angular orchestrator (AIO).
Your job is to find where AIO spends Claude tokens, prove it with data, then route the
cheap, high-volume work off Claude and onto local models and other providers, keeping
Claude only for steps that genuinely need it.

## Why this matters (context, already established, do not re-derive)

On June 15, 2026 Anthropic moves `claude -p` and Agent SDK usage off the interactive
subscription pool onto a separate monthly credit ($200 on our Max 20x plan) metered at full
API rates. AIO drives Claude exclusively via `claude --print` (headless), confirmed in
`src/main/cli/adapters/claude-cli-adapter.ts` `buildArgs()`. So after June 15, 100% of AIO's
Claude usage bills against that $200 credit, and our current workload exhausts it in roughly
ten minutes. We cannot afford to run this on a pay-as-you-go API key at current volume.

The fix is not a billing trick. It is to cut Claude consumption by routing the token-heavy
orchestration scaffolding to models that cost us nothing or near-nothing, on hardware we
already own (an RTX 5090 box and an M5 Max, both able to run strong local models).

## Hard constraints

1. Do not implement, scaffold, or research any approach that drives an interactive Claude
   session programmatically through a PTY, tmux, `node-pty`, `zmux`, `clarp`/`claude-p`
   wrappers, or any technique that makes automated usage look like a human at a terminal.
   `AIO_CLAUDE_BILLING_FEASIBILITY.md` rules this out as ToS circumvention with account-ban
   risk. If you find yourself reaching for it, stop and flag it instead.
2. Measure before you change anything. No routing edits until the audit data exists and a
   human has signed off on the classification (see the gate in Phase 1).
3. Stay on our stack: TypeScript, Angular (zoneless, signals), Vitest. Follow `AGENTS.md`.
4. Do not commit or push. Keep this plan and any new planning docs untracked until the work
   is implemented and verified, per `AGENTS.md`.
5. Preserve behavior. Routing a step to a cheaper model must not silently degrade output
   quality without it being a visible, configurable decision.

## Ground truth to start from (verify, do not assume still exact)

- Claude invocation: `src/main/cli/adapters/claude-cli-adapter.ts`, `buildArgs()` builds
  `claude --print --output-format stream-json ...`. Usage and `total_cost_usd` are parsed in
  `parseOutput()`.
- Provider selection / routing: `resolveCliType()` and `createCliAdapter()` in
  `src/main/cli/adapters/adapter-factory.ts`; task routing in `src/main/routing/route-task.ts`.
- Local models already supported: `createOllamaAdapter()` in `adapter-factory.ts` →
  `ollama-cli-adapter.ts` talks to a local Ollama REST API. Gemini, Codex, Copilot, Cursor
  adapters exist alongside it.
- Direct API SDK provider: `src/main/providers/anthropic-api-provider.ts` is registered
  (`provider-instance-manager.ts`) but thin: `subAgents:false`, `builtInCodeTools:false`, no
  tool-execution loop. Treat it as usable only for single-shot, no-tool calls (summaries,
  classifications, judging), never as a replacement for the agentic Claude harness.
- API-key billing for the full harness: the `bare` flag (`claude --print --bare` +
  `ANTHROPIC_API_KEY`) is plumbed end to end (`adapter-factory.ts` ~`bare: options.bare`,
  flag emitted in `claude-cli-adapter.ts` ~line 840, worker path in
  `cli/spawn-worker/cli-adapter-worker-args.ts`). But the user-facing toggle is NOT wired:
  `bareMode` exists in `src/shared/types/instance.types.ts` (~line 446) and is read nowhere.
- Suspected fan-out hotspots: the builtin skills `debate-topic`, `verify-implementation`,
  `summarize-children` under `src/main/skills/builtin/`, plus multi-agent coordination and
  any verification/debate orchestration paths.

## Phase 1: measure and map (no behavior changes)

Goal: a data-backed map of where Claude tokens and dollars go, broken down by call site and
by task purpose, not just a global total.

1. Enumerate every code path that ends in a Claude call. Start from `claude-cli-adapter`
   spawns and walk outward through the orchestration, skills, verification, and debate paths.
   For each, record: call site, the orchestration feature that triggers it, model used,
   whether it uses tools/subagents, and rough fan-out factor (calls per user action).
2. Add per-call-site usage attribution. The adapter already parses `result.usage` and
   `total_cost_usd`; tag each call with its originating feature/task-type and aggregate. Use
   the existing metrics collector if it fits; otherwise add lightweight instrumentation behind
   a flag. Capture input/output/cache tokens and estimated cost per task-type.
3. Produce real numbers from a representative run (a normal session that reproduces the heavy
   burn). Rank task-types by share of total Claude cost.

Deliverable for Phase 1: `claude-fanout-audit.md` (untracked) with the call-site map, the
per-task-type cost ranking from a real run, and your proposed scaffolding-vs-reasoning
classification (Phase 2 criteria). Then STOP and ask for human review before any routing
changes. Do not proceed to Phase 3 without sign-off.

## Phase 2: classify each call (criteria)

Label each Claude call site:

- Scaffolding (route off Claude): no tool use required, or mechanical work where a strong
  local or mid-tier model is adequate. Typical: summarizing child outputs, judging/scoring
  debate rounds, verification re-reads, classification, routing decisions, draft critiques.
- Reasoning (keep on Claude): the actual implementation, hard multi-step reasoning, or steps
  where output quality measurably depends on the frontier model. Be willing to argue that a
  step that looks like reasoning is actually scaffolding, and vice versa. Justify each call
  that stays on Claude.

Also flag any expensive pattern that may not earn its cost at all (for example multi-round
debate or redundant verification passes), and quantify what dropping or shrinking it saves.
Challenge the architecture, do not just re-route it.

## Phase 3: routing policy and implementation

1. Design a routing policy keyed on task-type, implemented against the existing selection
   layer (`route-task.ts` / `resolveCliType` / provider adapters), not a new bespoke system.
   Default scaffolding task-types to a local model via the Ollama adapter, with Gemini (or
   Codex) as fallback when local is unavailable or underpowered for a given step.
2. Make the policy configurable (per task-type provider/model overrides) and observable (log
   which provider served each step and the resulting cost). Default to the cost-saving routing
   but allow a step to be forced back onto Claude.
3. Keep Claude reasoning calls on the subscription credit by default. Where a step must stay on
   Claude and would blow the credit, surface that cost rather than hiding it.
4. Add tests (Vitest): routing-policy unit tests (task-type → provider), and at least one path
   asserting scaffolding does not hit the Claude adapter when local is configured.

## Phase 4: wire the API-key billing toggle (optional, parallel track)

So the Claude work that remains is predictable and isolated from our personal subscription:

1. Wire `bareMode` (`instance.types.ts`) through settings/IPC into `UnifiedSpawnOptions.bare`
   so a user can run Claude steps under `--bare` + `ANTHROPIC_API_KEY` (a separate Console
   account), instead of subscription OAuth.
2. Source the key safely: env or OS keychain only, never written to repo/config/logs
   (`AGENTS.md` secret-hygiene rule). Add a provider-doctor check that the key is present when
   bare mode is on.
3. Be explicit in the UI that bare mode bills API rates and does not draw from the
   subscription. This does not save money; it makes spend predictable and ring-fenced. State
   that plainly.

## Verification (per AGENTS.md)

- `npx tsc --noEmit` and `npx tsc --noEmit -p tsconfig.spec.json` pass.
- `npm run lint` and `npm run check:ts-max-loc` pass.
- New/affected Vitest suites pass.
- Re-run the representative session and report the before/after Claude cost. Success is a
  large drop in Claude spend per session with no visible quality regression on the steps that
  stayed on Claude.

## Deliverables

1. `claude-fanout-audit.md`: the measured map and classification (Phase 1, gated).
2. The routing policy implementation plus tests (Phase 3).
3. Optional: the bare/API-key toggle wiring (Phase 4).
4. A short summary: measured Claude cost before vs after, what now runs local vs Claude, and
   any scaffolding you recommend cutting entirely with the savings quantified.

## Out of scope / do not

- No PTY/tmux/node-pty/clarp/interactive-spoofing work of any kind.
- No commits or pushes; planning docs stay untracked until implemented and verified.
- Do not invest in the thin `anthropic-api-provider` as an orchestration engine; it is for
  single-shot no-tool calls only.
