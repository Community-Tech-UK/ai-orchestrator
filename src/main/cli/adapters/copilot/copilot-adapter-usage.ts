import type { BaseCliAdapter } from '../base-cli-adapter';
import type { ContextUsage } from '../../../../shared/types/instance.types';
import { CopilotUsageMonitor } from './copilot-usage-monitor';

/** Keeps numeric billing independent of whatever token/context telemetry the CLI also reports. */
export class CopilotAdapterUsage {
  readonly monitor: CopilotUsageMonitor;
  private context: ContextUsage = { used: 0, total: 0, percentage: 0, isEstimated: true };

  constructor(adapter: BaseCliAdapter, home: string | null) {
    this.monitor = new CopilotUsageMonitor(home, usage => {
      adapter.emit('context', { ...this.context, copilotUsage: usage });
    });
    adapter.prependListener('context', (context: ContextUsage) => {
      context.copilotUsage = this.monitor.snapshot();
      this.context = { ...context };
    });
    adapter.on('exit', () => this.monitor.stop());
  }
}
