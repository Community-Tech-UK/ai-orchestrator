/**
 * InstanceSpawner — focused helper for CLI process spawning.
 *
 * This is NOT a singleton. It accepts its dependencies via constructor
 * injection so it can be used in isolation (test harnesses, future
 * simplified spawn flows) without pulling in the full InstanceLifecycleManager.
 *
 * The existing createInstance() flow in instance-lifecycle.ts stays as-is
 * for production use; InstanceSpawner is a clean extraction for new paths.
 */

import { getLogger } from '../../logging/logger';

const logger = getLogger('InstanceSpawner');

export interface CliAdapter {
  spawn: (args?: unknown) => Promise<number | undefined>;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  pid?: number;
}

export interface SpawnConfig {
  instanceId: string;
  workingDirectory: string;
  provider: string;
  model?: string;
  sessionId?: string;
  resumeSessionId?: string;
  env?: Record<string, string>;
  yoloMode?: boolean;
}

export interface SpawnResult {
  adapter: CliAdapter;
  pid: number | undefined;
  sessionId?: string;
}

export interface SpawnerDeps {
  createAdapter: (config: SpawnConfig) => Promise<CliAdapter>;
  loadInstructions?: (workingDirectory: string) => Promise<string | null>;
}

export class InstanceSpawner {
  private deps: SpawnerDeps;

  constructor(deps: SpawnerDeps) {
    this.deps = deps;
  }

  async spawn(config: SpawnConfig): Promise<SpawnResult> {
    logger.info(`Spawning instance ${config.instanceId} with provider ${config.provider}`);

    let instructions: string | null = null;
    if (this.deps.loadInstructions) {
      instructions = await this.deps.loadInstructions(config.workingDirectory);
    }

    const adapter = await this.deps.createAdapter(config);

    await adapter.spawn({
      workingDirectory: config.workingDirectory,
      model: config.model,
      sessionId: config.sessionId,
      resumeSessionId: config.resumeSessionId,
      env: config.env,
      yoloMode: config.yoloMode,
      instructions,
    });

    return {
      adapter,
      pid: adapter.pid,
      sessionId: config.sessionId,
    };
  }
}
