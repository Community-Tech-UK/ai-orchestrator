import { CopilotEventsTail } from './copilot-events-tail';
import type { CopilotNumericUsage } from '../../../../shared/utils/copilot-usage';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('CopilotUsageMonitor');

/** Account-local lifetime owner. No timer until a real provider session has opened. */
export class CopilotUsageMonitor {
  private tail: CopilotEventsTail | undefined;
  private sessionId: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private latest: CopilotNumericUsage | undefined;
  private generation = 0;

  constructor(private readonly home: string | null, private readonly publish: (usage: CopilotNumericUsage | undefined) => void) {}

  start(sessionId: string): void {
    if (!this.home || this.sessionId === sessionId) return;
    this.stop(); this.latest = undefined;
    this.publish(undefined);
    this.sessionId = sessionId;
    try { this.tail = new CopilotEventsTail(this.home, sessionId); }
    catch { this.publish(undefined); return; }
    this.timer = setInterval(() => { void this.refresh(); }, 1000);
    this.timer.unref();
  }

  snapshot(): CopilotNumericUsage | undefined { return this.latest ? { ...this.latest } : undefined; }

  async refresh(): Promise<void> {
    const tail = this.tail, generation = this.generation;
    if (!tail) return;
    let usage: CopilotNumericUsage | undefined;
    try { usage = await tail.poll(); }
    catch (error) {
      logger.warn('Copilot usage unavailable', { code: (error as NodeJS.ErrnoException).code ?? 'session-containment-or-read-failure' });
    }
    if (this.generation !== generation) return;
    const changed = JSON.stringify(usage) !== JSON.stringify(this.latest);
    this.latest = usage;
    if (changed) this.publish(this.snapshot());
  }

  stop(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined; this.tail = undefined; this.sessionId = undefined;
  }
}
