# Thin-Client Re-platform — Follow-up Plan (DEFERRED / contingent)

**Status:** FOLLOW-UP to `2026-05-28-first-class-remote-orchestration-plan.md` (the active plan). **DEFERRED — do not start** until the trigger condition below is met. UNTRACKED — do not commit.
**Date:** 2026-05-28
**Owner:** James
**History:** This file previously held the "Path A: extend the worker model" + terminal-first plan. Path A is now the **active** plan (`first-class-remote-orchestration-plan.md`): node-targeted child spawn = Piece A, verified convergent loop = Piece B, remote terminal = Piece C. This document retains **only** the genuine thin-client re-platform, as future/contingent work.

## What this is (and isn't)

- **Path A (active, being built):** the Mac runs the AIO control app; the Windows worker runs all heavy compute (agents/builds/tests). "Thin" = the Mac does no heavy *work*. Shipping now.
- **This follow-up (the strong "thin client"):** the Mac becomes *nothing but a screen* — the Angular renderer drives a **remote backend** over WebSocket, and the full orchestrator main process runs on the Windows box. Pursue only if Path A's residual Mac footprint (the renderer + orchestration brain, not builds) is itself a measured problem.

## Trigger condition (do not start unless ALL true)

1. Pieces A/B/C of the active plan are shipped and in daily use.
2. The Mac's **renderer/coordinator** resource use — not builds, those are already remote — is a real, *measured* complaint.
3. You genuinely want the Mac reduced to a pure display client (vs. today's "control app, no heavy compute").

If these aren't all true, **don't build this.** It's a large change for marginal benefit over Path A.

## Approach (if/when triggered)

Build it as a **transport mode of the existing worker connection** (`remote-node/worker-node-connection.ts` WS + JSON-RPC + `auth/remote-auth.ts`) — **not** a second bridge, and **not** on the read-only observer (`remote/observer-server.ts` is HTTP+SSE, monitor-only).

Verified mechanism (single seam):
- The renderer reaches the backend only through `window.electronAPI`, composed in `src/preload/preload.ts` from ~24 domain factories that use **only** `ipcRenderer.invoke/on/removeListener`.
- Provide a `WsIpcRenderer` implementing those three over a WebSocket to a chosen backend; feed it to the factories → the whole API becomes remote with **zero changes** to renderer/domain services. Reuse the existing `ipcAuthToken`.

## Hard parts (from two independent fresh-eyes reviews — do NOT under-weight)

1. **IPC trust gate** (`ipc-main-handler.ts:107`) rejects non-window senders (requires the app's own window + `file://`/localhost origin). WS clients fail outright → a security redesign, not just token reuse.
2. **Event fan-out is not a single choke point** — `webContents.send` is scattered across ~40 files (two paths). Fan-out to WS clients needs a funneling refactor first.
3. **The "feature tail" is ~⅓ of visible UX, not a tail:** native dialogs (`selectFolder`/`selectFiles`), drag-drop (reads local Mac paths), `revealFile`/`openPath`/`editorOpen`, clipboard, image attachments, the 50 MB base64 payload cap, ~293 local-path renderer sites — each needs an explicit client-vs-backend decision.
4. **Reconnect/resync is correctness, not polish** — the shim must buffer in-flight invokes and re-subscribe listeners after a drop.
5. **Multi-client** — one backend may have its own window + the Mac client connected at once.

## Why it's deferred (not rejected forever)

- The worker model already offloads the heavy work; the Mac running the UI was never the actual complaint.
- A second remote stack alongside the worker RPC risks a half-migrated regret state (two transports, two auth models, two reconnect paths) — hence "transport mode of the worker connection," not a parallel bridge.
- It's materially larger than it looks (see hard parts).

## Not here — moved to the active plan

- Remote terminal → active plan **Piece C** (incl. the node-pty delivery research + worker node-layout).
- Node-targeted child spawn → active plan **Piece A**.
- Verified convergent loop → active plan **Piece B**.
