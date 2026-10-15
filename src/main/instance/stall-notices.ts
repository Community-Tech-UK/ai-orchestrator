import type { OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { describeStallProcessFacts, sampleStallProcessFacts } from './stall-process-facts';
const logger = getLogger('StallNotices');

export function buildStuckNotice(input: { elapsedMs: number; pid: number | null }): Promise<OutputMessage> {
  const secs = Math.round(input.elapsedMs / 1000);
  return buildNotice('stuck-warn', input.pid, input.elapsedMs,
    `Instance may be stuck — no output for ${secs}s. Will auto-restart if unresponsive.`,
    { watchdogWarning: true, elapsedMs: input.elapsedMs });
}
export function buildSpawnStallNotice(input: { timeoutMs: number; pid: number | null }): Promise<OutputMessage> {
  const secs = Math.round(input.timeoutMs / 1000);
  return buildNotice('spawn-stall', input.pid, input.timeoutMs,
    `Instance started but produced no output for ${secs}s. It may be stuck. Will auto-restart if unresponsive.`,
    { spawnStall: true, timeoutMs: input.timeoutMs });
}

async function buildNotice(prefix: string, pid: number | null, silenceMs: number, content: string, metadata: Record<string, unknown>): Promise<OutputMessage> {
  const facts = await sampleStallProcessFacts(pid, { silenceMs });
  logger.info('Stall process check', facts ? { ...facts } : { pid, processFacts: null });
  const timestamp = Date.now();
  return { id: `${prefix}-${timestamp}`, timestamp, type: 'system',
    content: facts ? `${content} ${describeStallProcessFacts(facts)}` : content,
    metadata: facts ? { ...metadata, processFacts: facts } : metadata };
}
