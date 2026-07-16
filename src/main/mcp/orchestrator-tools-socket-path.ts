import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

export function createOrchestratorToolsSocketPath(userDataPath: string): {
  socketPath: string;
  cleanupDir: string | null;
} {
  if (process.platform === 'win32') {
    return { socketPath: `\\\\.\\pipe\\orchestrator-tools-${crypto.randomUUID()}`, cleanupDir: null };
  }
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const userDataSocketPath = path.join(userDataPath, `ot-${id}.sock`);
  if (Buffer.byteLength(userDataSocketPath, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
    return { socketPath: userDataSocketPath, cleanupDir: null };
  }
  const cleanupDir = path.join(os.tmpdir(), `aio-ot-${process.pid}-${id}`);
  fs.mkdirSync(cleanupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(cleanupDir, 0o700);
  return { socketPath: path.join(cleanupDir, 'ot.sock'), cleanupDir };
}
