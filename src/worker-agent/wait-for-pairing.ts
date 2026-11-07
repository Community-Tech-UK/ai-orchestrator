import * as fs from 'fs';
import { loadWorkerConfig, readConfiguredCoordinatorUrl, type WorkerConfig } from './worker-config';
import type { WorkerConnectionStatusWriter } from './worker-connection-status';

export const WAITING_FOR_PAIRING_MESSAGE =
  'This computer is not paired with Harness yet. Run aio-worker pair on it, or ask an agent in Harness for a pairing command.';

const CONFIG_CHECK_INTERVAL_MS = 5_000;

export interface WaitForPairingOptions {
  configPath: string;
  status: Pick<WorkerConnectionStatusWriter, 'set' | 'touch'>;
  load?: (configPath: string) => WorkerConfig;
  /** The coordinator address in the file, read without rewriting it. */
  readCoordinator?: (configPath: string) => string | undefined;
  /** The config file's modification time, or null when it is missing. */
  modifiedAt?: (configPath: string) => number | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  intervalMs?: number;
}

/**
 * An unpaired worker waits here instead of exiting. Exiting made the
 * supervisor give up after five quick failures and launchd start it again, so
 * an unpaired Mac filled its logs with stack traces for hours (7 November
 * 2026). While waiting it only reads the file, when it changes: loading
 * rewrites the file and could undo a pairing being saved at that moment.
 */
export async function waitForPairing(options: WaitForPairingOptions): Promise<WorkerConfig> {
  const load = options.load ?? loadWorkerConfig;
  const readCoordinator = options.readCoordinator ?? readConfiguredCoordinatorUrl;
  const modifiedAt = options.modifiedAt ?? readModifiedAt;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((line: string) => console.log(line));
  const intervalMs = options.intervalMs ?? CONFIG_CHECK_INTERVAL_MS;

  options.status.set('waiting_for_pairing', { message: WAITING_FOR_PAIRING_MESSAGE });
  log(`[WorkerAgent] ${WAITING_FOR_PAIRING_MESSAGE} Checking ${options.configPath} for a pairing.`);

  let seen = modifiedAt(options.configPath);
  for (;;) {
    await sleep(intervalMs);
    const current = modifiedAt(options.configPath);
    if (current === seen) {
      options.status.touch();
      continue;
    }
    let coordinator: string | undefined;
    try {
      coordinator = readCoordinator(options.configPath);
    } catch (error) {
      // `aio-worker pair` may be part-way through writing the file; the next
      // check reads it again because `seen` still holds the old time.
      log(`[WorkerAgent] Could not read ${options.configPath} yet: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    seen = current;
    if (coordinator) {
      log('[WorkerAgent] Paired; starting.');
      return load(options.configPath);
    }
  }
}

function readModifiedAt(configPath: string): number | null {
  try {
    return fs.statSync(configPath).mtimeMs;
  } catch {
    return null;
  }
}
