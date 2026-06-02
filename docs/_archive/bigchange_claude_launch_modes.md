# Bigchange: Claude Launch Modes (Interactive vs Orchestrated)

> Status: PLAN / not started (no code written). Untracked — do not commit until implemented & verified.
> Context: Anthropic's June 15 2026 billing split (`claude -p` / Agent SDK usage moves to a metered
> credit pool; interactive terminal usage stays on the subscription). We are NOT removing `-p`.
> We make it an explicit, named launch choice so the user can keep attended Claude work on the free
> interactive pool, and deliberately spend the $200 metered credit / API budget on the orchestrated
> path when they want it. Both modes are permanent → if Anthropic reverts, zero rework.

## Decisions locked (2026-05-30) — all resolved, no open questions
- **Q1 PTY backend:** **Option C — local-loopback node.** Interactive `claude` runs on a local
  instance of the worker-agent node bundle; node-pty stays in the worker bundle (NOT in Electron main).
  See §3.
- **Q2 Dependencies:** approved — `xterm` (+ fit/webgl addons) in renderer; `node-pty` in the worker
  bundle only (already planned by Piece C; external/prebuilt, no SEA).
- **Q3 Names:** **Interactive** vs **Orchestrated** (with billing subtitles in the UI).
- **Q4 Default mode:** **last-used, remembered per provider** — reuse the existing
  `ProviderStateService.rememberModelForProvider` / `getLastModelForProvider` pattern that
  `new-session-draft.service.ts` already uses for model memory. Fallback `'orchestrated'`.
- **Q5 Direct Anthropic API (SDK) as a third mode:** **out of scope for now.**

---

## 1. Goal

When launching a **Claude** instance, the user picks one of two modes:

| Mode | Runtime | Claude billing | Orchestration |
|---|---|---|---|
| **Interactive** | Real `claude` TUI in an embedded terminal (PTY + xterm.js), human-driven | **Free** interactive subscription pool | None — human drives each turn; no stream-json |
| **Orchestrated** | Existing `claude --print --output-format stream-json` adapter | **Metered** after Jun 15 (Agent SDK credit → API) | Full — tool gating, usage, verification, debate, memory |

UI subtitles: Interactive = "Uses your Claude subscription (no metered cost)"; Orchestrated =
"Metered: Agent SDK credit, then API rate. Full orchestration."

## 2. Core architecture: two runtimes, not one flag
`--print` is what emits the stream-json the orchestrator parses. Interactive `claude` emits none of
it. So **Orchestrated** = the existing `ClaudeCliAdapter` (unchanged); **Interactive** = a separate
terminal-session runtime, treated as a human workbench (orchestration features gated off).

---

## 3. PTY backend — Option C: local-loopback node (DECIDED)

**What it is.** Interactive mode runs `claude` (no `--print`) inside a PTY hosted by a **local instance
of the worker-agent node bundle** (`dist/worker-agent/index.js`), which the coordinator launches and
connects to over the **same** worker WebSocket/JSON-RPC path used for remote workers
(`worker-node-connection.ts` + `auth/remote-auth.ts`, reusing `ipcAuthToken`). The renderer renders the
TUI with xterm.js over the existing `terminal.*` RPC. "Local" is therefore just a node whose host is
this machine — `nodeId` selects local-loopback vs a remote worker; the same `TerminalSession` contract
serves both.

**Why C (vs A/B), for the record:**

| Option | Verdict |
|---|---|
| A — node-pty in Electron main | Rejected: adds a 2nd native module to main and reverses the written "keep node-pty out of Electron main" stance. |
| B — worker-only | Rejected: no Claude window without a live remote worker; interactive Claude wouldn't run on the Mac; billing/login would follow the worker. |
| **C — local-loopback node** | **Chosen:** keeps node-pty confined to the worker bundle, still gives a fully **local** interactive Claude window on the Mac (uses the Mac's Claude login → free interactive pool), and reuses ~100% of Piece C. Cost: one extra moving part (a managed local node process). |

**Consequences / what stays deferred:**
- The `nodeId == null` "local-via-Electron-main" branch of `remote-terminal-manager.ts` is **not**
  implemented. Local sessions target the **local-loopback node id** instead. (Optionally alias
  `nodeId == null` → loopback node so callers can keep passing null.)
- node-pty delivery is the Piece C path: marked external, shipped prebuilt in the worker bundle's
  adjacent `node_modules`; mac/Linux spawn-helper `chmod 0o755` (ConPTY on Windows, no helper).
- Architectural upside: the local-loopback node is **reusable infra** — it unifies local + remote
  execution under one model and is available to any future local PTY/terminal need, not just Claude.

**Net-new work beyond Piece C** (Piece C already builds the worker node-pty host, `terminal.*` RPC,
coordinator routing, IPC/preload, renderer real `TerminalSession`, and terminal-drawer node wiring):
1. **Local-loopback node bootstrap** — coordinator launches/supervises `dist/worker-agent/index.js`
   locally, auto-connects it as a reserved local node (e.g. `nodeId: "local"`), lifecycle + restart.
2. **xterm.js renderer emulator** — shared with Wave 4b; render the TUI + input/resize/scrollback.
3. **`launchMode` end-to-end contract + selector** — §4/§5 (Phases 0–1), independent of the terminal host.
4. **Launch `claude` with no `--print`** as the terminal command for Interactive instances.

---

## 4. Verified seams (where the work lands)

**Orchestrated path (existing, unchanged):** `claude-cli-adapter.ts:727` always pushes `--print`;
`adapter-factory.ts:352` `createClaudeAdapter`.

**`launchMode` thread — mirror `yoloMode` exactly (proven precedent):**
1. Draft: `renderer/.../new-session-draft.service.ts` (`yoloMode: boolean|null` + `setYoloMode()` +
   localStorage v1) → add `launchMode` + `setLaunchMode()`; remember last-used via `ProviderStateService`.
2. IPC + Zod: `src/shared/validation/ipc-schemas.ts`; renderer `.../ipc/instance-ipc.service.ts`.
3. Model: `src/shared/types/instance.types.ts`.
4. `InstanceManager.createInstance`: `instance-manager.ts:2167` (`yoloMode: command.yoloMode === true`).
5. Spawn assembly: `instance-lifecycle.ts` `UnifiedSpawnOptions` sites (`:1341,:1805,:2456,:2634,:2865`);
   adapter via `getProviderRuntimeService().createAdapter(...)` (`:589`). Branch on mode here.

**Interactive runtime foundation (reused, not rebuilt):**
- Contract: `shared/types/terminal.types.ts` (`TerminalSession`, `nodeId` on `TerminalSpawnOptions`).
- Coordinator: `remote-node/remote-terminal-manager.ts` (remote branch done), `rpc-event-router.ts`
  (`terminal.output/exit` → registry events), `worker-node-rpc.ts` (`terminal.*` vocab), connection
  `remote-node/worker-node-connection.ts` + `auth/remote-auth.ts`.
- Worker host: `src/worker-agent/worker-terminal-handler.ts` (node-pty host).
- Renderer: `core/services/terminal-session.service.ts` (`TERMINAL_SESSION` token + stub),
  `features/terminal-drawer/terminal-drawer.component.ts` (stub) + a node-picker for host selection.

---

## 5. Phases

- **Phase 0 — Contract + naming (no behavior change).** Add `launchMode: 'orchestrated'|'interactive'`
  (default resolved from per-provider last-used, fallback `'orchestrated'`) end-to-end (draft → IPC/Zod
  → model → createInstance → UnifiedSpawnOptions → adapter branch). Default-orchestrated = no-op.
  Verify: both tsc, lint, instance specs.
- **Phase 1 — Launch selector (Claude only).** Segmented Interactive/Orchestrated control with billing
  subtitles; per-draft + per-provider memory; hidden for non-Claude. Verify: component spec + manual UI.
- **Phase 2 — Interactive runtime (Option C; rides Wave 4b / Piece C).** Build the local-loopback node
  bootstrap; add `xterm.js`; replace the `TERMINAL_SESSION`/terminal-drawer stub with a real impl bound
  to the loopback node (or a chosen remote node); launch `claude` with **no `--print`**. **Coupling:**
  do not fork Piece C — reuse its worker terminal host + RPC + renderer `TerminalSession`; sequence after
  Piece C's lane commits. Verify (NEEDS LIVE MACHINE — cannot verify headless): TUI renders,
  input/resize/exit work, `/status` shows subscription auth.
- **Phase 3 — Interactive instance UX.** Badge ("Interactive · subscription"); gate orchestration-only
  controls (verification/debate/auto-advance/permission UI) that need stream-json; sane status mapping.
- **Phase 4 — Policy/polish.** Per-provider last-used default wiring; cost badge on Orchestrated;
  optional soft-confirm when launching Orchestrated post-cutover. Verify: full test + lint + both tsc.

## 6. Open questions
**None — all five decisions are locked (see top).** Remaining items are implementation sub-tasks inside
the phases, not decisions.

## 7. Risks
- **Coupling to Piece C (claimed, in-flight):** reuse its terminal plumbing; do not fork it; respect the
  "don't touch a claimed lane until it commits" rule. Sequence Phase 2 after Piece C's renderer
  `TerminalSession` real impl + worker node-pty host land.
- **Headless verification gap:** Phase 2 (local-loopback node, node-pty, TUI) cannot be verified in a
  headless agent env — needs a live machine (per sequencing doc). Plan for manual verification.
- **Local-loopback node lifecycle:** supervise/restart the local worker process; reserved local
  `nodeId`; clean shutdown; don't double-spawn. New moving part — keep it small and well-owned.
- **Lifecycle assumptions:** much of the instance state machine assumes stream-json; interactive
  instances must bypass cleanly, not half-participate.
- **Scope discipline:** keep interactive instances human-driven — do not re-add orchestration hooks that
  need stream-json (and would re-cross the "automation on the subscription" line).
