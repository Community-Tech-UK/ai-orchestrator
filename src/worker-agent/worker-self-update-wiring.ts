import * as fs from 'node:fs';
import * as path from 'node:path';
import { setWorkerBuildStatusProvider } from './capability-reporter';
import type { WorkerAgent } from './worker-agent';
import { DEFAULT_CONFIG_PATH, type WorkerConfig } from './worker-config';
import {
  resolveSelfUpdateTarget,
  WORKER_UPDATE_RESTART_EXIT_CODE,
  WorkerSelfUpdater,
} from './worker-self-update';

const RESTART_SHUTDOWN_TIMEOUT_MS = 30_000;

export interface StartWorkerSelfUpdateInput {
  agent: Pick<WorkerAgent, 'activity'>;
  config: WorkerConfig;
  configPath: string;
  /** WinSW/launchd/systemd own restarts there; never exit for an update. */
  serviceMode: boolean;
  /** Shut the worker down cleanly. The process then exits for the supervisor. */
  onRestart: () => Promise<void>;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Start automatic self-update when this process can safely use it, and report
 * its state in the heartbeat either way. Returns null when it is off.
 */
export function startWorkerSelfUpdate(input: StartWorkerSelfUpdateInput): WorkerSelfUpdater | null {
  const entrypoint = input.entrypoint ?? process.argv[1];
  const target = input.serviceMode
    ? { disabledReason: 'running as an operating-system service' }
    : resolveSelfUpdateTarget({
        enabledInConfig: input.config.autoUpdate?.enabled !== false,
        env: input.env ?? process.env,
        entrypoint,
      });

  if ('disabledReason' in target) {
    const buildCommit = readBuildCommit(entrypoint);
    setWorkerBuildStatusProvider(() => ({
      ...(buildCommit ? { buildCommit } : {}),
      autoUpdate: { state: 'disabled', reason: target.disabledReason },
    }));
    console.log(`[WorkerSelfUpdate] Automatic updates are off: ${target.disabledReason}`);
    return null;
  }

  const updater = new WorkerSelfUpdater({
    repoRoot: target.repoRoot,
    bundlePath: target.bundlePath,
    configPath: input.configPath,
    isBusy: () => input.agent.activity.isBusy(),
    lastActivityAt: () => input.agent.activity.lastActivityAt(),
    restart: async () => {
      // Exit no matter what. A shutdown that throws or hangs has already
      // stopped reconnecting, so staying alive would leave the node dead; the
      // supervisor respawns on this code either way.
      try {
        await Promise.race([
          input.onRestart(),
          // Deliberately NOT unref'd: if nothing else held the event loop, Node
          // would exit 0 here, which the supervisor reads as a deliberate stop.
          new Promise<void>((resolve) => setTimeout(resolve, RESTART_SHUTDOWN_TIMEOUT_MS)),
        ]);
      } catch (error) {
        console.warn('[WorkerSelfUpdate] Clean shutdown failed; exiting anyway', error instanceof Error ? error.message : String(error));
      } finally {
        process.exit(WORKER_UPDATE_RESTART_EXIT_CODE);
      }
    },
  });
  setWorkerBuildStatusProvider(() => {
    const buildCommit = updater.getRunningCommit();
    return { ...(buildCommit ? { buildCommit } : {}), autoUpdate: updater.getSummary() };
  });
  updater.start();
  console.log('[WorkerSelfUpdate] Automatic updates are on', {
    repoRoot: target.repoRoot,
    buildCommit: updater.getRunningCommit()?.slice(0, 8) ?? 'unknown',
  });
  return updater;
}

/**
 * `index.js --self-check [--config <path>]`. Loading the bundle already ran
 * every module's top level; this also proves the worker config still parses.
 * Read-only on purpose: the normal config loader writes the file back, which
 * must never race the live worker's own writes.
 */
export function runWorkerSelfCheck(argv: string[]): number {
  const configIndex = argv.indexOf('--config');
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : DEFAULT_CONFIG_PATH;
  try {
    if (configPath && fs.existsSync(configPath)) {
      JSON.parse(fs.readFileSync(configPath, 'utf-8').replace(/^﻿/, ''));
    }
    console.log('Worker self-check ok');
    return 0;
  } catch (error) {
    console.error('Worker self-check failed:', error instanceof Error ? error.message : String(error));
    return 1;
  }
}

function readBuildCommit(entrypoint: string | undefined): string | undefined {
  if (!entrypoint) return undefined;
  try {
    const stamp = fs.readFileSync(path.join(path.dirname(path.resolve(entrypoint)), '.source-commit'), 'utf8');
    const commit = stamp.trim().split(/\s+/)[0] ?? '';
    return /^[0-9a-f]{40}$/i.test(commit) ? commit.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
