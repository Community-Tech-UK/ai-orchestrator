/**
 * Renderer ⇄ main IPC channels for the remote terminal (Piece C of the
 * first-class remote orchestration plan).
 *
 * These are DISTINCT from:
 *  - the worker-node RPC vocabulary (`terminal.create` / `terminal.output` …)
 *    in `src/main/remote-node/worker-node-rpc.ts`, which travels coordinator ⇄
 *    worker over the WebSocket, and
 *  - the loop's `loop:terminal-intent-*` channels, which are unrelated.
 *
 * Scope: REMOTE terminals only — a `nodeId` is always required. Local
 * terminals would pull node-pty into the Electron main process and are
 * intentionally deferred.
 */
export const TERMINAL_CHANNELS = {
  // invoke (renderer → main)
  TERMINAL_SPAWN: 'terminal:spawn',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_RESIZE: 'terminal:resize',
  TERMINAL_KILL: 'terminal:kill',
  /** WS11.7: retained-scrollback replay for renderer (re)attach. */
  TERMINAL_GET_BUFFER: 'terminal:get-buffer',

  // events (main → renderer)
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_SPAWNED: 'terminal:spawned',
} as const;
