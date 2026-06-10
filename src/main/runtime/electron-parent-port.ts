/**
 * Detection for the Electron `utilityProcess` parent port.
 *
 * Workers spawned via `createIsolatedWorkerProcess` run as Electron utility
 * processes in packaged builds (see isolated-worker-process.ts for why). In a
 * utility process the parent IPC channel is `process.parentPort` (an Electron
 * MessagePortMain), not `process.send`/`process.on('message')` as under
 * `child_process.fork`. Worker entrypoints use this helper as one branch of
 * their transport detection.
 */

export interface ElectronParentPort {
  start?: () => void;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

export function getElectronParentPort(): ElectronParentPort | null {
  const port = (process as NodeJS.Process & { parentPort?: ElectronParentPort }).parentPort;
  return port ?? null;
}
