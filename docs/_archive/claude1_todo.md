# AI Orchestrator — improvement backlog (learnings from t3code, opencode, and peers)

Based on a deep read of AI Orchestrator's own source plus the reference
projects checked out next to it in `/Users/suas/work/orchestrat0r/`:

- **opencode** (`opencode/packages/opencode/src/**`) — headless TS server, SSE
  event bus, AI-SDK + models.dev providers, part-based session store, glob
  permission model, plugin hook bus, LSP-as-feedback-loop.
- **t3code** (`t3code/apps/web/src/**`) — Theo's *direct competitor* to this
  app (Electron GUI wrapping Codex/Claude/OpenCode CLIs). Dual-stream sync,
  virtualized timeline, LRU highlight cache, resumable streams, per-instance
  model memory.
- **agent-orchestrator** (`agent-orchestrator/packages/core/src/**`) — plugin
  slot architecture, lifecycle state machine with stale-runtime reconciliation,
  6-state activity detection with mandatory fallback, cross-platform helpers.
- **CodePilot** (`CodePilot/src-tauri/src/chat/commands.rs`) — "magic prompts"
  via `--json-schema` one-shot structured extraction; string-based model routing.
- **jean** (`jean/CLAUDE.md`) — Zustand mutation-guard / no-op-update discipline.
- **Broader tool survey** — ACP/Zed external agents, aider, Cline, goose, Roo Code,
  Amp, Cursor, Windsurf, Continue, Crush (patterns cited inline, esp. in Tier 5).
- External research: Claude Code `stream-json`, `@openai/codex-sdk`, Gemini
  headless JSONL, xterm.js flow-control, Electron security checklist, models.dev.

> Context: this is a **mature** codebase (~975 main-process TS files, 6,200+
> tests, git-snapshot checkpoints, supervisor trees, MCP multi-provider, ACP
> adapter, anchored compaction). Most "obvious" features already exist. The
> items below are deliberately split into things that are **genuinely missing**,
> things that are **measurably weaker** than the references, and the big
> **architectural rocks** already named in `NOTES.md` that now have fresh
> competitive justification. Each item cites the concrete current gap.

Legend: **[NEW]** not in the existing deferred backlog · **[backlog]** already
named as deferred in `NOTES.md`/prior todos, re-prioritized here with evidence ·
**[done-ish]** largely solved — listed only to prevent rebuilding.

---

## Tier 0 — Architectural North Stars (highest leverage, multi-week)

1. **[backlog] Make the renderer a thin client over a typed event API, not an IPC-coupled twin.**
   - opencode's defining choice: the core runs as a **headless server** exposing
     an OpenAPI surface + a single `/event` **SSE firehose** (`{id, type, properties}`),
     and *every* client (TUI, Electron desktop, VS Code, web, CI) is just a
     subscriber. State lives server-side, so a client can crash, reload, or a
     second window can join **without losing in-flight runs**. See
     `opencode/packages/opencode/src/server/server.ts` and
     `.../routes/instance/httpapi/handlers/event.ts`, `.../bus/index.ts`.
   - **Current gap:** the renderer↔main data path is **775 generated IPC channels**
     (`docs/architecture.md:10`; DESIGN.md still says "460+"), and the primary
     output backbone is the `INSTANCE_OUTPUT` IPC channel. You already have the
     server pieces — `src/main/remote/observer-server.ts:70` (HTTP) and
     `src/main/remote-node/worker-node-connection.ts:77` (WSS) — but they're a
     *secondary* observer path, not the canonical one the main UI consumes.
   - **Do:** converge on one canonical event log per instance (ties to codex_todo
     #4 below), expose it over a typed transport, and make Electron IPC thin OS
     glue rather than the agent data path. This is the umbrella that makes #2,
     resumable streams (#10), and session sharing (#23) fall out cheaply.

2. **[backlog] Schema-first typed RPC over the IPC surface (claude_todo #2).**
   - 775 hand-aligned channels validated by Zod at the edges is a large drift
     surface (the `register-aliases.ts` packaging trap in `AGENTS.md` is a symptom).
   - **Borrow:** opencode generates **Stainless SDKs from one OpenAPI spec** so
     UI and backend can't drift; t3code uses **Effect.Schema with pre-decoding
     transforms** for backward-compatible payloads (`t3code/.../contracts/src/*`).
   - **Do:** define the contract once (you already have `packages/contracts`),
     code-generate both the preload bridge *and* the renderer client + types from
     it, so adding a channel is a one-file change verified at build time. Keeps
     `verify:ipc`/`check:contracts` but removes the manual 3-place sync.

3. **[backlog] Unify the adapter/provider layer (claude_todo #1, codex_todo #1).**
   - The adapters are enormous and clearly divergent: `codex-cli-adapter.ts`
     **3,003 LOC**, `acp-cli-adapter.ts` 2,070, `claude-cli-adapter.ts` 2,048,
     `cursor-cli-adapter.ts` 1,023, `copilot-cli-adapter.ts` 977, plus a 767-LOC
     `base-cli-adapter.ts` and 650-LOC `adapter-factory.ts`. That's ~15k LOC of
     hot path with per-provider reimplementation of framing/parsing/session logic.
   - **Borrow:** opencode reduces this to a tiny per-provider mapper because the
     **AI SDK owns transport** and a **normalized event union** is the only
     internal currency (`opencode/.../provider/provider.ts`). Define your own
     normalized union — `session_start | assistant_delta | tool_call | tool_result
     | usage | turn_end | retry | error | exit` — and make each adapter a thin
     JSONL→union mapper. You already have the envelope (`provider-interface.ts`
     `pushEvent`/`pushOutput`/…); the win is collapsing the 3k-LOC bodies onto it.
   - **Quick lever:** for Claude and Codex, **adopt the official SDKs**
     (`@anthropic-ai/sdk` Agent SDK you already depend on; add `@openai/codex-sdk`'s
     `thread.runStreamed()`) so you delete hand-rolled stdin/stdout JSONL framing
     and get typed messages + retries for free.
   - **Normalization target = ACP.** Zed's **Agent Client Protocol** (JSON-RPC over
     stdio; `session/update` chunks: `agent_message_chunk`, `thought_message_chunk`,
     `tool_call`/`tool_call_update`, `plan`, `current_mode_update`; client-owns-fs +
     `session/request_permission`) is "MCP inverted" and is exactly the union you
     need — adopted by 40+ agents. You already ship `acp-cli-adapter.ts` (2,070 LOC),
     so make ACP's chunk set your internal event union and converge the other
     adapters onto it; that also makes you a drop-in host for any ACP-native agent.

4. **[backlog] Provider-instance routing + canonical per-instance event log (codex_todo #4).**
   - Both references treat this as foundational. t3code routes by
     **`ProviderInstanceId`** (multiple instances per driver, e.g. `codex_personal`)
     and keeps **per-instance model memory** (`t3code/.../composerDraftStore.ts`
     `modelSelectionByProvider`). opencode tags every bus event with project/instance
     so multi-window routing is correct.
   - **Current gap:** `ProviderName` is CLI-identity only (per project memory), and
     routing/model selection isn't instance-scoped. This blocks "two Codex configs
     side by side" and clean multi-window output routing.

---

## Tier 1 — High-impact, concrete, mostly self-contained

5. **[NEW] Stop estimating cost — read it from the structured stream.**
   - `claude-cli-provider.ts:187-205` (`updateUsageFromContext`) fabricates a
     **70/30 input/output split** and multiplies by a pricing table. But the
     adapter already runs `--output-format stream-json --verbose`
     (`claude-cli-adapter.ts:729`), and Claude's terminal `result` event carries
     **exact** `total_cost_usd`, `usage`, and per-model `modelUsage`. Codex's
     `turn.completed` carries `input_tokens`/`cached_input_tokens`/`output_tokens`/
     `reasoning_output_tokens`; Gemini's `result` carries aggregated stats.
   - **Do:** thread the real `usage`/cost from the terminal event into
     `ProviderUsage` instead of estimating. Cached-token accounting alone makes the
     current estimate off by large factors on long sessions.
   - **And display it well:** aider prints `tokens / $message / $session` after every
     turn; Amp shows a clickable **per-thread cost split by provider** ("$2 Anthropic
     + $0.50 OpenAI"). Since sessions here can be mixed-provider, show running cost
     inline per-turn *and* per-session, broken down by provider — with a global hide
     toggle for managed setups. (Avoid Windsurf's opaque-credit trust backlash.)

6. **[NEW] Block-memoized streaming markdown (the single biggest renderer win).**
   - `markdown.service.ts:262` does `marked.parse(cleaned)` over the **entire
     message** every time content changes. For a streaming assistant turn that
     grows token-by-token, that's O(n²) re-parsing of the whole message per chunk
     — and it compounds when **multiple instances stream at once**, which is this
     app's whole premise (DESIGN.md: "10,000+ instances").
   - **Borrow:** t3.chat's well-documented fix (and t3code `ChatMarkdown.tsx`):
     split the message into **block-level tokens via the `marked` lexer**, render
     each block as a memoized unit keyed by index, and only re-parse/re-highlight
     the **last (still-streaming) block**. Completed blocks never re-render. Pair
     with t3code's **LRU highlight cache keyed by `lang+code`** (it caches up to
     500 blocks) so identical fences aren't re-highlighted.
   - You already defer highlight to idle (`markdown.service.ts:48`,
     `highlightCodeBlocksInElement`), which helps — but the whole-message re-parse
     is the dominant cost. Block memoization is the structural fix.

7. **[NEW] Virtualize the transcript (it currently isn't).**
   - DESIGN.md lists "virtual scroll" as a scalability pillar, and
     `instance-list.component.ts` *is* virtualized — but the transcript
     (`output-stream.component.ts`, 1,052 LOC) renders an `@for` over
     `visibleItems()` with a custom `transcript-scroll-strategy.ts` and a hard
     **1,000-item cap** (`instance-output.store.ts:124`), no windowing.
   - **Borrow:** t3code uses **`@legendapp/list`** for unbounded timelines
     (`t3code/.../components/chat/MessagesTimeline.tsx`). Angular's equivalent is
     `@angular/cdk` `cdk-virtual-scroll-viewport` with an `itemSize`/autosize
     strategy. Virtualize so the 1,000 cap can rise (or drop) without DOM cost,
     and so 4+ live transcripts stay at 60fps.

8. **[NEW] Reconcile "stale/dead runtime" into the instance state machine.**
   - agent-orchestrator persists a **`runtime_lost`** terminal reason when it
     detects a dead runtime during enrichment, so the UI never shows "active"
     forever (`agent-orchestrator/packages/core/src/lifecycle-manager.ts`,
     `lifecycle-state.ts`). Its provider plugins also implement a **6-state
     activity contract with a mandatory fallback** (process check → native signal
     → JSONL entry → fallback) so detection never returns null
     (`agent-orchestrator/packages/plugins/agent-*/src/index.ts`).
   - **Current gap:** you have `InstanceStateMachine`, `StuckProcessDetector`, and
     `activity-state-detector.ts`, but detection can leave instances in
     ambiguous/stale states. Adopt the **mandatory-fallback cascade** and a
     persisted `runtime_lost` reason. Reinforce with an **event-stream idle
     timeout** (no `assistant_delta`/`tool_*`/data within N s ⇒ "possibly hung",
     offer kill/resume) — process liveness alone misses wedged-but-alive CLIs.

9. **[NEW] Replace the hand-maintained model catalog with models.dev.**
   - `src/shared/data/models-catalog.ts` is a **429-line committed snapshot** of
     ~13 models' context windows / pricing / capabilities, and
     `model-discovery.ts:143` hard-codes "Anthropic models are relatively static,
     use known list." This goes stale every model release and drives the cost math.
   - **Borrow:** opencode pulls all model metadata from the **models.dev** registry
     (`@opencode-ai/core/models-dev`), so new models/pricing need zero code.
   - **Do:** fetch+cache models.dev (offline fallback = your current snapshot).
     One source feeds the picker, cost (#5), and context guards.

10. **[NEW] Guarantee resumable / detachable streams from a durable main-side buffer.**
    - t3.chat's signature reliability feature: close the laptop / refresh / navigate
      away and **reattach to the in-flight generation** with full backscroll.
      You're better positioned than a web app — the subprocess + buffer live in your
      main process. You already buffer 1,000 items (`instance-output.store.ts:124`).
    - **Do:** make the buffer **durable** (persist as it streams, à la t3code writing
      streaming chunks straight to the store) and verify the renderer can
      detach/reattach mid-turn with no loss after a window reload or
      `render-process-gone`. Carry a `resumeCursor` per turn like
      `t3code/.../contracts/src/provider.ts`. This is the renderer-crash payoff of
      Tier-0 #1.

---

## Tier 2 — Features worth stealing (orchestrator superpowers)

11. **[NEW] "Same prompt → N providers, compared side-by-side."**
    - This is the one thing a *single* CLI tool can't do, and both references lean
      on it: t3.chat ships model comparison; opencode added a `/multi` fan-out.
    - **Current gap:** you have powerful *agent-internal* fan-out
      (`orchestration/cross-model-review-service.ts`, `debate-coordinator.ts`,
      `consensus-coordinator.ts`) — but no simple **user-facing** "ask Claude +
      Codex + Gemini the same thing and diff the answers" view. The plumbing exists;
      this is mostly a renderer surface over `instance-manager` + a broadcast prompt.
    - **Go further with `best-of-n` in worktrees:** Cursor's `/best-of-n` runs one
      prompt across N models, each in its own git worktree, then you pick the winner.
      You already have `orchestration/parallel-worktree-coordinator.ts` +
      `workspace/git/worktree-manager.ts` — wire them to this view so fan-out includes
      *file edits*, not just chat answers. The marquee orchestrator-only move.

12. **[NEW] "Magic prompts": one-shot structured commands via `--json-schema`.**
    - CodePilot ships `/recap`, `/release-notes`, `/resolve-conflicts`,
      `/review-comments` as **single-turn structured extractions** using Claude's
      `--json-schema` and parsing the `structured_output` field
      (`CodePilot/src-tauri/src/chat/commands.rs` `extract_text_from_stream_json`).
      Claude Code supports `--json-schema`; Codex supports `--output-schema`.
    - **Do:** add a small library of schema-backed commands (recap a thread,
      generate a PR/commit message, summarize a diff) that return typed JSON in one
      turn instead of free-text you re-parse. Reliable and cheap.

13. **[backlog] LSP diagnostics as a first-class agent feedback loop (codex_todo #12).**
    - opencode's cleverest correctness trick: after every edit it sends
      `textDocument/didChange` and **feeds the returned diagnostics back into the
      model's context** so it self-corrects syntax/type errors immediately
      (`opencode/.../lsp/lsp.ts`). 30+ servers, off by default, auto-start by
      file extension.
    - **Current gap:** you have `lsp-manager.ts` + `lsp-worker/`, but LSP isn't
      wired as a post-edit feedback signal to the agent. This is a high-value, mostly
      additive use of infrastructure you already built.

14. **[NEW] Session sharing with web playback (opencode `/share`).**
    - opencode `/share` syncs a session and returns a public replay link;
      `/unshare` revokes. Modes: manual/auto/disabled. Your part/event log + the
      existing observer server make this a natural fit, and it's a strong
      collaboration/demo feature. Gate behind explicit opt-in (it's public).

15. **[NEW] Checkpoint *timeline* UI over the git snapshots you already take.**
    - You already snapshot via `git write-tree` and can `restore --worktree`
      (`session/git-checkpoint-store.ts:86,129`) — opencode's "undo without polluting
      history" is **already implemented in the backend**. The missing piece is the
      Cline-style **per-turn timeline with one-click "revert to here"** (messages +
      file edits) surfaced in the transcript. Cheap, high-trust UX on existing infra.
    - **Mechanism + granularity to copy from Cline:** snapshot into a **separate
      "shadow" git repo** whose `core.worktree` points at the project, so a checkpoint
      is `git add . && commit` and restore is `git reset --hard` — **never touching the
      user's real history/branches**. Offer the three-way restore: **Files only /
      Conversation only / Both** (and checkpoint *before* each edit, à la Cursor, not
      only after). "Restore conversation only" is uniquely useful when switching
      providers mid-task.

---

## Tier 3 — Reliability, security, and process model

16. **[NEW] Move provider subprocess spawning/parsing off the main process.**
    - CLI children are spawned and their stdout parsed **in the main process**
      (`base-cli-adapter.ts`; node-pty appears only in `remote-node/`). At the
      stated 10k-instance scale, JSON parsing + child management on the main thread
      will jank the UI and risk native-addon faults taking down everything.
    - **Borrow:** opencode isolates the agent core in a separate server process.
      Electron's analog is a **`utilityProcess`** pool that owns spawning + JSONL
      parsing and forwards normalized events; the main process just routes. Pairs
      with **batched/coalesced** main→renderer flushes (~16–60ms windows) and
      high/low-watermark backpressure so a runaway CLI pauses instead of flooding
      IPC. (You already have `KeyedCoalescingWorker` — reuse it here.)

17. **[NEW] Cross-platform process teardown + a platform helpers module.**
    - DESIGN.md targets Windows/Linux. Two concrete traps: `kill(signal)` with a
      signal **throws on Windows**, and killing only the direct child orphans the
      CLI's descendants (shells, MCP servers, language servers). ConPTY also has a
      ~1s post-exit flush.
    - **Borrow:** agent-orchestrator centralizes `isWindows()`, `killProcessTree()`,
      `pathsEqual()`, `getDefaultRuntime()` in `packages/core/src/platform.ts`
      instead of scattering `process.platform === 'win32'`.
    - **Do:** one teardown path — Unix: `SIGTERM`/`SIGHUP` to the process *group*
      then `SIGKILL` after a timeout; Windows: `taskkill /T` tree-kill, never pass a
      signal. On quit, drain + dispose every child so nothing leaks as a zombie.

18. **[backlog] Glob-pattern permission model (allow/ask/deny, last-match-wins, per-agent) (codex_todo #6).**
    - opencode's model is worth copying wholesale: rules are
      `{ tool/command-pattern → allow | ask | deny }`, **last match wins**, with
      `bash` taking globs (`"git *": allow`, `"rm *": deny`), an **"always for this
      session"** memory, and **per-agent overrides** (`opencode/.../permission/index.ts`,
      `agent/agent.ts`). Every tool gets an **abort signal** so the stop button
      reliably kills in-flight work.
    - **Current gap:** you have `src/main/security/` (secret detection, path
      validation) and per-spawn allowedTools, but not a pattern-matched, per-agent,
      session-memoized permission ruleset. codex_todo #6 ("parser-backed shell
      permission extraction") is the harder half of this.

19. **[NEW] Treat the CLIs' auto-approval flags as a security control you own.**
    - The orchestrator can hand each CLI dangerous autonomy: Claude
      `--dangerously-skip-permissions` (already used at `claude-cli-adapter.ts:762`),
      Codex `danger-full-access`, Gemini `--yolo`, Copilot `--allow-all-tools`.
    - **Do:** default to least privilege per provider, require **explicit per-session
      opt-in** for any "yolo"/skip-permissions mode, and surface the active trust
      level prominently in the instance header. Verify the Electron hardening
      checklist while here (sandbox, `contextIsolation`, no raw `ipcRenderer` over
      `contextBridge`, `event.senderFrame` validation on handlers).

20. **[backlog] Scripted mock provider adapter + Playwright E2E (claude_todo #5, #13).**
    - Depends on the #3 adapter seam: once adapters are thin JSONL→union mappers,
      a **scripted/replayable mock provider** (and CLI **fixture cassettes**,
      claude_todo #4) become trivial — feed canned JSONL, assert the normalized
      event stream and the rendered transcript. That unlocks deterministic
      **Playwright E2E** without spawning real CLIs or burning tokens. This is the
      test-confidence keystone behind several deferred items.

---

## Tier 4 — Config, portability, polish

21. **[NEW] Deep-merge config stack + portable `AGENTS.md`/`CLAUDE.md`.**
    - opencode merges config global → project → inline → admin/MDM with
      `{env:VAR}`/`{file:path}` substitution (secrets stay out of files), and reads
      a standard **`AGENTS.md`, falling back to `CLAUDE.md`** so instructions are
      portable across the very CLIs you orchestrate (`opencode/docs` rules; you
      already load CLAUDE.md per `architecture.md:189`).
    - **Do:** generalize CLAUDE.md loading into a documented, layered config/rules
      stack with env/file interpolation, and emit per-provider instruction files in
      each CLI's native format at spawn time.

22. **[NEW] Plugin hook bus + markdown slash-commands with interpolation.**
    - opencode plugins subscribe to a rich lifecycle bus (`tool.execute.before/after`,
      `session.idle`, `file.edited`, `tui.command.execute`) with an injected SDK
      client; commands are **markdown templates** supporting `$ARGUMENTS`/`$1`,
      `` !`shell` `` injection, and `@file` inlining (`opencode/.../plugin/index.ts`).
    - **Current gap:** you have `plugins/`, `commands/`, and `skills/`, but compare
      the *hook surface* and the command-template ergonomics — markdown commands with
      arg/shell/file interpolation are a low-effort, high-delight addition over the
      command registry you already merge.

23. **[backlog] Plugin sandboxing (claude_todo #14).** Before encouraging third-party
    plugins (#22), the execution model needs isolation. Re-prioritized because #22
    increases the blast radius if plugins run in-process.

24. **[backlog] Ship-readiness: auto-update + notarization (claude_todo #9).**
    - `electron-builder.json:63` has `notarize: false` and there is **no
      `electron-updater`/`autoUpdater` anywhere**. For a desktop app this is the gap
      between "I built a DMG" and "users get updates." Wire `electron-updater` + a
      release feed and turn on notarization (needs signing creds — the one true
      blocker, hence still backlog).

25. **[NEW] Zustand-style no-op mutation guards in the signal stores.**
    - jean's `CLAUDE.md` documents guarding store writes against no-op updates to
      avoid waking every subscriber. t3code does the same with **structural-equality
      checks before writing** (`store.ts` `threadShellsEqual`) and a **shell/detail
      split** so sidebar updates don't re-render the chat.
    - **Do:** audit the high-frequency signal stores (`instance.store.ts`,
      `instance-output.store.ts`, `loop.store.ts`) for equality short-circuits before
      `set`, and consider a shell(metadata)/detail(content) split so list/sidebar
      churn doesn't invalidate transcripts. (`output-stream.component.ts:233` already
      returns the same array reference when unchanged — extend that discipline to the
      stores feeding it.)

---

## Tier 5 — Orchestrator-only superpowers (from the broader tool survey)

These are the things a *single*-CLI tool structurally cannot do. They're where a
multi-provider orchestrator earns its name, and the whole field has converged on
them — so they double as competitive table stakes.

26. **[NEW] Phase / role-based provider routing — the defining multi-CLI feature.**
    - Everyone splits work across models by *phase or role*: Continue assigns models
      per role (`chat`/`edit`/`apply`/`summarize`/`embed`); goose's `GOOSE_LEAD_MODEL`
      runs a strong model for planning then **auto-switches to a cheap worker**; aider
      runs an "architect" model + a separate "editor" model; Cline's **Plan
      (read-only) / Act** split lets a strong planner hand off to a cheap executor
      with context carried over; Amp's read-only **Oracle** routes hard reasoning to a
      strong model.
    - **You're uniquely positioned** — your providers are whole CLIs, so one task can
      *plan on Claude, execute on Codex/Gemini, get reviewed by a read-only oracle
      provider*. You already have `cross-model-review-service.ts` + debate/consensus.
    - **Current gap:** routing is per-instance, not **per-phase within a task**. Make
      phase routing a first-class session setting (Plan→Act handoff, lead→worker
      auto-switch on a turn-count/plan-complete trigger) with seamless transcript
      handoff. Pairs with #4 (instance routing) and #26's sibling, best-of-n (#11).

27. **[NEW] Own a provider-agnostic shared-context layer; inject it into every CLI.**
    - aider's **repo-map** (tree-sitter symbols + PageRank ranking, token-budgeted to
      ~1k tokens, expands/contracts with the conversation) and Windsurf's **swe-grep
      retrieval subagent** (parallel search whose *distilled* result is fed to the main
      agent, keeping crawl noise out of its context) are both provider-independent.
      Continue/Cline `@`-mentions (`@file`, `@diff`, `@terminal`, `@symbol`, `@mcp`)
      resolve context *before* the prompt reaches a CLI.
    - **Current gap:** you have `codemem` indexing + BM25 + episodic/semantic memory,
      but they aren't packaged as a *ranked, token-budgeted repo-map* or an
      `@`-mention resolver injected into whichever provider is active. Build it once →
      every wrapped CLI gets cheap repo-wide awareness regardless of its own context
      tricks. Add **memories auto-distilled from user corrections** (Windsurf) into the
      memory system you already own.

28. **[NEW] Permission middleware with richer verbs + a per-capability matrix.**
    - (extends #18) Amp intercepts every tool call and returns `allow | reject |
      modify` (rewrite args — e.g. sanitize a shell command) `| synthesize` (return a
      stubbed result without executing), even using an LLM to *classify* a command as
      destructive. Cline exposes a **per-capability auto-approve matrix** (read project
      / read all / edit / exec-safe / browser / MCP) plus a **"check in after N actions
      or $X" circuit breaker** — not one "YOLO" switch.
    - **Do:** model permissions as a middleware pipeline over your normalized
      tool-call events with these four verbs + a capability matrix + an action/cost
      breaker, so one policy engine governs every provider consistently.

29. **[NEW] Diff/apply + plan UX table stakes (over your normalized event log).**
    - **Per-hunk inline accept/reject** with keyboard shortcuts (Cursor users
      *revolted* when it was removed — "your best UX advantage"; Zed/Cline/Windsurf all
      keep it). Render agent **plans as interactive Mermaid diagrams** (Cline) instead
      of text walls. Support **queued steering** (Amp's "Enter-Enter" injects guidance
      at the next checkpoint) and **force-interrupt** ("Esc-Esc") without killing the
      run — the same primitive as ACP's `session/update` + interrupt; converge them.
    - Optional but powerful (Cursor **Shadow Workspace**): apply a proposed edit in an
      isolated worktree/overlay, collect lint/type diagnostics, and feed them back to
      the provider's next turn — a correctness loop that lifts *any* wrapped CLI.

30. **[NEW] Central MCP host + in-app MCP marketplace.**
    - goose makes MCP its *only* extension mechanism; ACP's `session/new` carries the
      per-session `mcpServers` list; Cline ships a one-click **verified MCP marketplace**.
    - You have rich MCP multi-provider config (`src/main/mcp/*`). The additions:
      (a) **host MCP servers centrally** and inject the same set into every provider
      that supports MCP (one config, all providers — your `shared-mcp-coordinator.ts`
      is halfway there), and (b) a curated, one-click in-app marketplace so MCP is
      mainstream, not power-user-only.

31. **[NEW] Sessions as searchable, referenceable objects.**
    - Amp makes threads first-class: visibility levels, **search by keyword / file /
      repo / author / date**, and **`@T-<id>` cross-references** ("implement the plan
      from @T-7f39"). Hugely valuable when work spans multiple providers and sessions.
    - **Current gap:** you persist sessions (`session/`, `SessionArchive`) but expose
      no rich cross-session search + `@thread` reference surface. Cheap on the storage
      you already have; compounds with sharing (#14).

---

## Already solid — do **not** rebuild (verified in-tree)

- **Structured CLI consumption** is real: Claude runs `--print --input-format
  stream-json --output-format stream-json --verbose` (`claude-cli-adapter.ts:729`),
  Copilot uses `--output-format json --stream` (one-shot per turn), and there's a
  typed `ProviderRuntimeEvent` envelope (`provider-interface.ts`). You are *not*
  ANSI-scraping — the work is consolidating the adapters (#3) and using the exact
  usage/cost already in the stream (#5).
- **Undo via git snapshots** exists (`session/git-checkpoint-store.ts` write-tree /
  restore) — only the timeline UI (#15) is missing.
- **Session continuity / checkpoints / recovery**, **supervisor trees /
  hibernation / pools / load balancing / circuit breakers**, **MCP multi-provider**,
  **ACP adapter**, **anchored compaction**, **codemem indexing + BM25**,
  **`prepareCached` SQLite caching**, **crash capture + `render-process-gone`
  recovery** are all present and tested.

---

## Suggested sequencing

1. **Fast wins first** (days, isolated, high ROI): #5 exact cost (+ inline display),
   #6 block-memoized markdown, #9 models.dev, #25 store guards, #15 checkpoint
   timeline UI, #29 per-hunk diff accept/reject.
2. **Then the seam** that unlocks everything: #3 adapter unification onto an
   ACP-shaped event union (adopt `@openai/codex-sdk` + Agent SDK) → enables #20
   (mock adapter + E2E) and #4 (instance routing).
3. **Then the orchestrator-defining features** (your moat, on top of the seam):
   #26 phase/role routing (Plan→Act, lead→worker), #11 + best-of-n compare,
   #27 shared-context/repo-map injection.
4. **Then the platform shifts**: #1 thin-client/event-API + #2 typed RPC, #16
   utilityProcess isolation, #10 durable resumable streams.
5. **Reliability + security in parallel**: #8 stale-runtime, #17 cross-platform
   teardown, #18 + #28 permission model & middleware, #19 trust controls.
6. **Polish/ship**: #13 LSP feedback loop, #14 sharing, #30 MCP marketplace,
   #31 session search, #21 config stack, #22 commands, #24 auto-update.
