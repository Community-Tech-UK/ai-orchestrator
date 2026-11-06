/** Ask a resident Claude session without writing the question to its transcript. */
import { recordModelCall } from '../core/system/model-call-recorder';
import type { ClaudeControlReply } from '../cli/adapters/claude-control-channel';
import { isAdapterOnLoan, isRuntimeChangeInFlight } from './lifecycle/adapter-loan-registry';
import type { InstanceManager } from './instance-manager';

export type QuickAskResult =
  | { ok: true; answer: string; elapsedMs: number; notice?: string }
  | { ok: false; code: 'not-found' | 'not-claude' | 'not-running' | 'no-history'
    | 'invalid' | 'busy' | 'loop' | 'no-answer'; message: string };

interface ControlCapableAdapter {
  requestControl?: (subtype: string, fields: Record<string, unknown>, timeoutMs: number) => Promise<ClaudeControlReply>;
  getAdapterCapabilities?: () => { residentSession?: boolean };
}

const inFlight = new Set<string>();

/**
 * Reads the real `side_question` reply data (Claude Code 2.1.303):
 * `{response: string|null, synthetic: boolean, refusal_fallback?: {original_model,
 * fallback_model, content}}`. A synthetic reply carries the CLI's own "(No answer
 * available ...)" placeholder in `response`, which is not a model answer. A refusal
 * fallback is a real answer from a different model, so it is shown with a notice.
 */
function readAnswer(payload: Record<string, unknown>): { text: string; notice?: string } | null {
  const text = payload['response'];
  if (typeof text !== 'string' || !text.trim() || payload['synthetic'] === true) return null;
  const fallback = payload['refusal_fallback'];
  if (fallback === null || typeof fallback !== 'object') return { text };
  const { original_model: original, fallback_model: used } = fallback as Record<string, unknown>;
  return typeof original === 'string' && typeof used === 'string'
    ? { text, notice: `This answer came from ${used} because ${original} declined the question.` }
    : { text };
}

export async function askQuick(
  manager: InstanceManager,
  instanceId: string,
  question: string,
): Promise<QuickAskResult> {
  const instance = manager.getInstance(instanceId);
  if (!instance) return { ok: false, code: 'not-found', message: 'This session is not running right now.' };
  if (instance.provider !== 'claude') {
    return { ok: false, code: 'not-claude', message: 'Quick ask is available for Claude sessions only.' };
  }
  const adapter = manager.getAdapter(instanceId) as ControlCapableAdapter | undefined;
  if (!adapter?.requestControl || !adapter.getAdapterCapabilities?.().residentSession) {
    return { ok: false, code: 'not-running', message: 'This session is not running right now.' };
  }
  if (!instance.outputBuffer.some((message) => message.type === 'assistant')) {
    return { ok: false, code: 'no-history', message: 'Ask again after the first reply has finished.' };
  }
  const trimmed = question.trim();
  if (trimmed.length < 1 || trimmed.length > 4_000) {
    return { ok: false, code: 'invalid', message: 'The question must be between 1 and 4,000 characters.' };
  }
  if (inFlight.has(instanceId)) {
    return { ok: false, code: 'busy', message: 'Another quick ask is still waiting for its answer.' };
  }
  if (isAdapterOnLoan(instanceId) || isRuntimeChangeInFlight(instanceId)) {
    return { ok: false, code: 'loop', message: 'A loop is using this session right now.' };
  }

  inFlight.add(instanceId);
  const startedAt = Date.now();
  try {
    const reply = await adapter.requestControl('side_question', { question: trimmed }, 60_000);
    const answer = reply.ok ? readAnswer(reply.payload) : null;
    recordModelCall({
      purpose: 'quick-ask', provider: 'claude', model: instance.currentModel,
      instanceId, outcome: answer ? 'success' : 'error',
    });
    return answer
      ? { ok: true, answer: answer.text, elapsedMs: Date.now() - startedAt,
        ...(answer.notice ? { notice: answer.notice } : {}) }
      : { ok: false, code: 'no-answer', message: 'No answer came back from this session.' };
  } catch {
    recordModelCall({ purpose: 'quick-ask', provider: 'claude', model: instance.currentModel,
      instanceId, outcome: 'error' });
    return { ok: false, code: 'no-answer', message: 'No answer came back from this session.' };
  } finally {
    inFlight.delete(instanceId);
  }
}
