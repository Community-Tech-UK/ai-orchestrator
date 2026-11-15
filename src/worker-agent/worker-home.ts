import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** One checkout owns one worker. The installer writes an absolute path here. */
export const WORKER_HOME_MARKER = '.aio-worker-home';
export const DEFAULT_WORKER_HOME = path.join(os.homedir(), '.orchestrator');

export function resolveWorkerHome(checkoutRoot = path.resolve(__dirname, '..', '..')): string {
  const marker = path.join(checkoutRoot, WORKER_HOME_MARKER);
  if (!fs.existsSync(marker)) return DEFAULT_WORKER_HOME;
  const configured = fs.readFileSync(marker, 'utf-8').replace(/^\uFEFF/, '').trim();
  if (!configured || !path.isAbsolute(configured) || /[\r\n]/.test(configured)) {
    throw new Error('The worker home marker must contain one absolute folder path.');
  }
  return path.resolve(configured);
}

export function isDefaultWorkerHome(home: string): boolean {
  const resolved = path.resolve(home);
  return process.platform === 'win32'
    ? resolved.toLowerCase() === DEFAULT_WORKER_HOME.toLowerCase()
    : resolved === DEFAULT_WORKER_HOME;
}

/** Provider accounts are deliberately shared by both workers for this OS user. */
export function workerProviderStateRoot(workerHome: string, serviceMode: boolean): string {
  return serviceMode ? workerHome : DEFAULT_WORKER_HOME;
}

export function workerRelayHostName(home: string): string {
  return isDefaultWorkerHome(home)
    ? 'com.ai_orchestrator.browser_gateway_relay'
    : 'com.ai_orchestrator.browser_gateway_relay_home_base';
}

export function workerRelaySocketPath(home: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.join(home, 'browser-gateway', 'extension-relay.sock');
  const suffix = isDefaultWorkerHome(home) ? '' : `-${createHash('sha256').update(path.resolve(home).toLowerCase()).digest('hex').slice(0, 12)}`;
  return `\\\\.\\pipe\\ai-orchestrator-browser-gateway${suffix}`;
}
