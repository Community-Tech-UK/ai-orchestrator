import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import type {
  Automation,
  AutomationRun,
  CreateAutomationInput,
} from '../../../../shared/types/automation.types';
import type {
  AutomationPreflightReport,
  AutomationPreflightRequest,
  AutomationTemplate,
} from '../../../../shared/types/task-preflight.types';
import { AutomationIpcService } from '../services/ipc/automation-ipc.service';

interface AutomationChangedEvent {
  automation: Automation | null;
  automationId: string;
  type: 'created' | 'updated' | 'deleted';
}

interface AutomationRunChangedEvent {
  automationId: string;
  run: AutomationRun;
}

export interface CreateThreadWakeupInput {
  instanceId: string;
  sessionId?: string;
  historyEntryId?: string;
  workingDirectory: string;
  prompt: string;
  runAt: number;
  intervalMinutes?: number;
  reviveIfArchived: boolean;
}

@Injectable({ providedIn: 'root' })
export class AutomationStore implements OnDestroy {
  private ipc = inject(AutomationIpcService);
  private cleanups: (() => void)[] = [];

  private _automations = signal<Automation[]>([]);
  private _runs = signal<AutomationRun[]>([]);
  private _templates = signal<AutomationTemplate[]>([]);
  private _preflight = signal<AutomationPreflightReport | null>(null);
  private _loading = signal(false);
  private _preflightLoading = signal(false);
  private _error = signal<string | null>(null);

  automations = this._automations.asReadonly();
  runs = this._runs.asReadonly();
  templates = this._templates.asReadonly();
  preflight = this._preflight.asReadonly();
  loading = this._loading.asReadonly();
  preflightLoading = this._preflightLoading.asReadonly();
  error = this._error.asReadonly();
  unreadCount = computed(() =>
    this._automations().reduce((total, automation) => total + (automation.unreadRunCount ?? 0), 0)
  );

  constructor() {
    this.cleanups.push(this.ipc.onChanged((event) => this.applyAutomationEvent(event as AutomationChangedEvent)));
    this.cleanups.push(this.ipc.onRunChanged((event) => this.applyRunEvent(event as AutomationRunChangedEvent)));
    void this.refresh();
  }

  ngOnDestroy(): void {
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.cleanups = [];
  }

  async refresh(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const [automations, runs] = await Promise.all([
        this.ipc.list(),
        this.ipc.listRuns({ limit: 100 }),
      ]);
      if (automations.success) {
        this._automations.set((automations.data as Automation[]) ?? []);
      } else {
        this._error.set(automations.error?.message ?? 'Failed to load automations');
      }
      if (runs.success) {
        this._runs.set((runs.data as AutomationRun[]) ?? []);
      }
    } finally {
      this._loading.set(false);
    }
  }

  async create(input: Parameters<AutomationIpcService['create']>[0]): Promise<boolean> {
    const response = await this.ipc.create(input);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to create automation');
      return false;
    }
    await this.refresh();
    return true;
  }

  async loadTemplates(): Promise<AutomationTemplate[]> {
    const response = await this.ipc.listTemplates();
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to load automation templates');
      return [];
    }
    const templates = (response.data as AutomationTemplate[]) ?? [];
    this._templates.set(templates);
    return templates;
  }

  applyTemplate(templateId: string): AutomationTemplate | null {
    const template = this._templates().find((item) => item.id === templateId);
    if (!template) {
      return null;
    }
    return {
      ...template,
      suggestedSchedule: { ...template.suggestedSchedule },
      tags: [...template.tags],
    };
  }

  async runPreflight(input: AutomationPreflightRequest): Promise<AutomationPreflightReport | null> {
    this._preflightLoading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.preflight(input);
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to run automation preflight');
        return null;
      }
      const report = (response.data as AutomationPreflightReport) ?? null;
      this._preflight.set(report);
      return report;
    } finally {
      this._preflightLoading.set(false);
    }
  }

  clearPreflight(): void {
    this._preflight.set(null);
  }

  async createThreadWakeup(input: CreateThreadWakeupInput): Promise<boolean> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const isLoop = input.intervalMinutes !== undefined;
    const payload: CreateAutomationInput = {
      name: isLoop ? 'Thread loop' : 'Thread wakeup',
      schedule: isLoop
        ? {
            type: 'cron',
            expression: this.intervalToCron(input.intervalMinutes!),
            timezone,
          }
        : {
            type: 'oneTime',
            runAt: input.runAt,
            timezone,
          },
      missedRunPolicy: 'notify',
      concurrencyPolicy: 'skip',
      destination: {
        kind: 'thread',
        instanceId: input.instanceId,
        sessionId: input.sessionId,
        historyEntryId: input.historyEntryId,
        reviveIfArchived: input.reviveIfArchived,
      },
      action: {
        prompt: input.prompt,
        workingDirectory: input.workingDirectory,
      },
    };
    return this.create(payload);
  }

  threadWakeupsForInstance(instanceId: string): Automation[] {
    return this._automations().filter((automation) =>
      automation.destination.kind === 'thread'
      && automation.destination.instanceId === instanceId
      && automation.active
      && automation.enabled
    );
  }

  async cancelThreadWakeups(instanceId: string): Promise<void> {
    const wakeups = this.threadWakeupsForInstance(instanceId);
    await Promise.all(wakeups.map((automation) => this.delete(automation.id)));
    await this.refresh();
  }

  async update(id: string, updates: Parameters<AutomationIpcService['update']>[1]): Promise<boolean> {
    const response = await this.ipc.update(id, updates);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to update automation');
      return false;
    }
    await this.refresh();
    return true;
  }

  async delete(id: string): Promise<void> {
    const response = await this.ipc.delete(id);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to delete automation');
      return;
    }
    this._automations.update((items) => items.filter((item) => item.id !== id));
    this._runs.update((items) => items.filter((item) => item.automationId !== id));
  }

  async runNow(id: string): Promise<void> {
    const response = await this.ipc.runNow(id);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to run automation');
      return;
    }
    await this.refresh();
  }

  async cancelPending(id: string): Promise<void> {
    const response = await this.ipc.cancelPending(id);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to cancel pending runs');
      return;
    }
    await this.refresh();
  }

  async markSeen(automationId: string): Promise<void> {
    const response = await this.ipc.markSeen({ automationId });
    if (response.success) {
      this._automations.update((items) =>
        items.map((item) => item.id === automationId ? { ...item, unreadRunCount: 0 } : item)
      );
    }
  }

  private applyAutomationEvent(event: AutomationChangedEvent): void {
    if (event.type === 'deleted') {
      this._automations.update((items) => items.filter((item) => item.id !== event.automationId));
      return;
    }
    if (!event.automation) {
      return;
    }
    this._automations.update((items) => {
      const index = items.findIndex((item) => item.id === event.automationId);
      if (index === -1) {
        return [event.automation!, ...items];
      }
      const next = [...items];
      next[index] = event.automation!;
      return next;
    });
  }

  private applyRunEvent(event: AutomationRunChangedEvent): void {
    this._runs.update((items) => {
      const index = items.findIndex((item) => item.id === event.run.id);
      if (index === -1) {
        return [event.run, ...items].slice(0, 100);
      }
      const next = [...items];
      next[index] = event.run;
      return next;
    });

    if (['succeeded', 'failed', 'skipped', 'cancelled'].includes(event.run.status) && !event.run.seenAt) {
      this._automations.update((items) =>
        items.map((item) => item.id === event.automationId
          ? { ...item, unreadRunCount: (item.unreadRunCount ?? 0) + 1 }
          : item)
      );
    }
  }

  private intervalToCron(minutes: number): string {
    if (minutes > 0 && minutes < 60 && 60 % minutes === 0) {
      return `*/${minutes} * * * *`;
    }
    if (minutes >= 60 && minutes % 60 === 0) {
      return `0 */${minutes / 60} * * *`;
    }
    throw new Error(`Unsupported wakeup interval: ${minutes}`);
  }
}
