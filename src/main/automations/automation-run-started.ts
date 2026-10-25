import type { AutomationRun } from '../../shared/types/automation.types';
import { emitPluginHook } from '../plugins/hook-emitter';

export function emitAutomationRunStarted(run: AutomationRun): void {
  emitPluginHook('automation.run.started', {
    automationId: run.automationId, runId: run.id, trigger: run.trigger,
    source: run.triggerSource ?? undefined, deliveryMode: run.deliveryMode, timestamp: Date.now(),
  });
}
