import type { OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { describeStallProcessFacts, sampleStallProcessFacts, type StallProcessFacts } from './stall-process-facts';
const logger = getLogger('StallNotices');

export function buildInteractivePromptNotice(stdoutSilentMs: number): OutputMessage {
  const timestamp = Date.now();
  return { id: `interactive-prompt-${timestamp}`, timestamp, type: 'system',
    content: 'This session may be waiting for input from a program it started. Check the running command if it does not continue.',
    metadata: { watchdogWarning: true, interactivePrompt: true, elapsedMs: stdoutSilentMs } };
}

export function buildStuckNotice(input: { elapsedMs: number; pid: number | null; sampleProcessFacts?: (silenceMs: number) => Promise<StallProcessFacts | null> }): Promise<OutputMessage> {
  const secs = Math.round(input.elapsedMs / 1000);
  return buildNotice('stuck-warn', input.pid, input.elapsedMs,
    `No output for ${secs}s. If it stays silent, Harness will restart the session.`,
    { watchdogWarning: true, elapsedMs: input.elapsedMs, detail: `${secs}s without output` }, input.sampleProcessFacts);
}
export function buildSpawnStallNotice(input: { timeoutMs: number; pid: number | null }): Promise<OutputMessage> {
  const secs = Math.round(input.timeoutMs / 1000);
  return buildNotice('spawn-stall', input.pid, input.timeoutMs,
    `The session started ${secs}s ago and hasn't responded yet. It may still be loading. If nothing happens, restart the session.`,
    { spawnStall: true, timeoutMs: input.timeoutMs });
}

async function buildNotice(prefix: string, pid: number | null, silenceMs: number, content: string, metadata: Record<string, unknown>, sampleProcessFacts?: (silenceMs: number) => Promise<StallProcessFacts | null>): Promise<OutputMessage> {
  const facts = await (sampleProcessFacts ? sampleProcessFacts(silenceMs) : sampleStallProcessFacts(pid, { silenceMs }));
  logger.info('Stall process check', facts ? { ...facts } : { pid, processFacts: null });
  const timestamp = Date.now();
  return { id: `${prefix}-${timestamp}`, timestamp, type: 'system',
    content: facts ? `${content} ${describeStallProcessFacts(facts)}` : content,
    metadata: facts ? { ...metadata, processFacts: facts } : metadata };
}
