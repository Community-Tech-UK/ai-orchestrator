import { EventEmitter } from 'events';
import type { Automation, AutomationRunStatus, AutomationRunChangedEvent } from '../../shared/types/automation.types';

export interface AutomationEventMap {
  changed: { automation: Automation | null; automationId: string; type: 'created' | 'updated' | 'deleted' };
  runChanged: AutomationRunChangedEvent;
  runTerminal: {
    automationId: string;
    runId: string;
    status: Exclude<AutomationRunStatus, 'pending' | 'running'>;
  };
  scheduleDeactivated: { automationId: string };
  orphanedFire: { automationId: string };
}

class AutomationEvents extends EventEmitter {
  emitChanged(event: AutomationEventMap['changed']): void {
    this.emit('automation:changed', event);
  }

  emitRunChanged(event: AutomationEventMap['runChanged']): void {
    this.emit('automation:run-changed', event);
  }

  emitRunTerminal(event: AutomationEventMap['runTerminal']): void {
    this.emit('automation:run-terminal', event);
  }

  emitScheduleDeactivated(event: AutomationEventMap['scheduleDeactivated']): void {
    this.emit('automation:schedule-deactivated', event);
  }

  emitOrphanedFire(event: AutomationEventMap['orphanedFire']): void {
    this.emit('automation:orphaned-fire', event);
  }
}

let instance: AutomationEvents | null = null;

export function getAutomationEvents(): AutomationEvents {
  if (!instance) {
    instance = new AutomationEvents();
  }
  return instance;
}

export function resetAutomationEventsForTesting(): void {
  instance?.removeAllListeners();
  instance = null;
}
