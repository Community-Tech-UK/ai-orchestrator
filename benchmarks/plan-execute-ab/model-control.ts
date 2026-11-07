import { runCommand } from './exec';
import type { CommandResult, ModelControlConfig } from './types';

export interface RemoteResult {
  ok: boolean;
  command: string;
  result?: CommandResult;
  error?: string;
}

export class ModelControl {
  constructor(private readonly config: ModelControlConfig) {}

  private async remote(shellCommand: string): Promise<RemoteResult> {
    const argv = this.config.remoteArgv.map((part) => part.replace('{cmd}', shellCommand));
    if (argv.length === 0 || argv.every((part) => !part.includes(shellCommand))) {
      return { ok: false, command: shellCommand, error: 'model control: remoteArgv template lacks {cmd}' };
    }
    const result = await runCommand(argv, { timeoutMs: 120_000 });
    return {
      ok: result.exitCode === 0,
      command: shellCommand,
      result,
      error: result.exitCode === 0 ? undefined : `exit ${result.exitCode}: ${result.stderr.slice(0, 300)}`,
    };
  }

  async loadModel(modelKey: string): Promise<RemoteResult> {
    const command = this.config.loadCommands[modelKey];
    if (!command) {
      return { ok: false, command: '', error: `no load command configured for ${modelKey}` };
    }
    return this.remote(command);
  }

  async unloadModel(modelKey: string): Promise<RemoteResult> {
    const command = this.config.unloadCommands[modelKey];
    if (!command) {
      return { ok: false, command: '', error: `no unload command configured for ${modelKey}` };
    }
    return this.remote(command);
  }

  /** Decision 8: put Harness's helper models back after local runs finish or the runner stops. */
  async reloadHelperModels(): Promise<RemoteResult> {
    if (!this.config.helperReloadCommand) {
      return { ok: false, command: '', error: 'no helper reload command configured' };
    }
    return this.remote(this.config.helperReloadCommand);
  }

  async checkHealth(shellCommand: string): Promise<RemoteResult> {
    return this.remote(shellCommand);
  }
}

export function isModelControlConfigured(config: ModelControlConfig | undefined): config is ModelControlConfig {
  return Boolean(config && config.remoteArgv.length > 0 && config.remoteArgv.some((p) => p.includes('{cmd}')));
}
