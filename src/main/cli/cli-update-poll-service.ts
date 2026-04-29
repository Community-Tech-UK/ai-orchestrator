import { EventEmitter } from 'events';
import {
  CLI_REGISTRY,
  SUPPORTED_CLIS,
  getCliDetectionService,
} from './cli-detection';
import { getCliUpdateService } from './cli-update-service';
import type {
  CliUpdatePillEntry,
  CliUpdatePillState,
  CliUpdatePlanSummary,
} from '../../shared/types/diagnostics.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('CliUpdatePollService');
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class CliUpdatePollService {
  private static instance: CliUpdatePollService | null = null;
  private readonly events = new EventEmitter();
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: CliUpdatePillState = {
    generatedAt: 0,
    count: 0,
    entries: [],
  };
  private refreshPromise: Promise<CliUpdatePillState> | null = null;

  static getInstance(): CliUpdatePollService {
    if (!this.instance) {
      this.instance = new CliUpdatePollService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.stop();
    this.instance = null;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getState(): CliUpdatePillState {
    return this.state;
  }

  onChange(listener: (state: CliUpdatePillState) => void): () => void {
    this.events.on('change', listener);
    return () => this.events.off('change', listener);
  }

  async refresh(): Promise<CliUpdatePillState> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refreshInternal()
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  private async refreshInternal(): Promise<CliUpdatePillState> {
    const previous = JSON.stringify(this.state);
    try {
      const detection = await getCliDetectionService().detectAll(true);
      const installed = new Set(
        detection.detected
          .filter((cli) => cli.installed)
          .map((cli) => cli.name),
      );
      const detectedByName = new Map(detection.detected.map((cli) => [cli.name, cli]));
      const entries: CliUpdatePillEntry[] = [];

      for (const cli of SUPPORTED_CLIS) {
        if (!installed.has(cli)) {
          continue;
        }

        const plan = toPlanSummary(await getCliUpdateService().getUpdatePlan(cli));
        if (!plan.supported) {
          continue;
        }

        entries.push({
          cli,
          displayName: CLI_REGISTRY[cli]?.displayName ?? cli,
          currentVersion: plan.currentVersion ?? detectedByName.get(cli)?.version,
          updatePlan: plan,
        });
      }

      this.state = {
        generatedAt: Date.now(),
        count: entries.length,
        entries,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('CLI update poll failed', { error: message });
      this.state = {
        generatedAt: Date.now(),
        count: 0,
        entries: [],
        error: message,
      };
    }

    if (JSON.stringify(this.state) !== previous) {
      this.events.emit('change', this.state);
    }
    return this.state;
  }
}

function toPlanSummary(plan: CliUpdatePlanSummary): CliUpdatePlanSummary {
  return {
    cli: plan.cli,
    displayName: plan.displayName,
    supported: plan.supported,
    command: plan.command,
    args: plan.args,
    displayCommand: plan.displayCommand,
    activePath: plan.activePath,
    currentVersion: plan.currentVersion,
    reason: plan.reason,
  };
}

export function getCliUpdatePollService(): CliUpdatePollService {
  return CliUpdatePollService.getInstance();
}

export function _resetCliUpdatePollServiceForTesting(): void {
  CliUpdatePollService._resetForTesting();
}
