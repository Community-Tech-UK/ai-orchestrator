import { EventEmitter } from 'node:events';
import type { SubagentUsageSample } from '../../shared/types/cost-session.types';
const events = new EventEmitter();
/** Process-local live telemetry; durable helper records stay in the cost log. */
export function publishSubagentUsage(sample: SubagentUsageSample): void { events.emit('sample', sample); }
export function subscribeSubagentUsage(listener: (sample: SubagentUsageSample) => void): () => void {
  events.on('sample', listener);
  return () => events.off('sample', listener);
}
