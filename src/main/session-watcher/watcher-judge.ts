import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliResponse } from '../cli/adapters/base-cli-adapter';
import { recordModelCall } from '../core/system/model-call-recorder';
import { isModelCallCancelled, observeModelCallUsage } from '../core/system/observed-model-call-usage';
import { attachProviderRoutes } from '../instance/lifecycle/provider-route-preflight';
import { isProviderExcludedFromAutomation } from '../providers/automation-provider-exclusions';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { WATCHER_JUDGED_PROVIDER } from './watcher-gates';
import { QUALIFIED_WATCHER_JUDGE_MODEL, watcherJudgeSpawnOptions } from './watcher-judge-options';

const TASK_TYPE = 'aux:sessionWatch';

export interface WatcherJudgeReply {
  raw: string;
  provider: string;
  model: string;
  latencyMs: number;
}

/** Makes one judging call. Rejects on any failure, a timeout or an abort; the caller treats that as `unreliable`. */
export interface WatcherJudge {
  /** False when no judge that met the safety marks can be called right now. Checked before a call is queued. */
  available(): boolean;
  judge(prompt: { system: string; user: string }, instanceId: string, signal: AbortSignal): Promise<WatcherJudgeReply>;
}

function hasSendMessage(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<CliResponse> } {
  return typeof (adapter as unknown as { sendMessage?: unknown }).sendMessage === 'function';
}

function abortError(): Error {
  const error = new Error('Session watcher judge call aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * The judge that met the safety marks: one pinned Claude model as a plain one-shot completion (see
 * `watcherJudgeSpawnOptions`). It reads untrusted session text, so it has no tools, no MCP servers and none of
 * the user's settings; nothing it returns is forwarded, so a reply steered by that text can at worst pick one of
 * three verdicts. It is the session's own provider, so the conversation goes nowhere it has not been.
 */
export class ClaudeOneShotWatcherJudge implements WatcherJudge {
  available(): boolean {
    return !isProviderExcludedFromAutomation(WATCHER_JUDGED_PROVIDER);
  }

  async judge(prompt: { system: string; user: string }, instanceId: string, signal: AbortSignal): Promise<WatcherJudgeReply> {
    if (signal.aborted) throw abortError();
    const model = QUALIFIED_WATCHER_JUDGE_MODEL;
    const options = await attachProviderRoutes(WATCHER_JUDGED_PROVIDER, watcherJudgeSpawnOptions(prompt.system), 'internal', { instanceId });
    if (signal.aborted) throw abortError();
    const adapter = getProviderRuntimeService().createAdapter({ cliType: WATCHER_JUDGED_PROVIDER, options });
    if (!hasSendMessage(adapter)) throw new Error('The Claude adapter cannot make a one-shot call');

    const startedAt = Date.now();
    const observed = observeModelCallUsage(adapter);
    const record = (outcome: 'success' | 'error' | 'cancelled' | 'budget-exceeded'): void => {
      recordModelCall({ purpose: 'helper', taskType: TASK_TYPE, provider: WATCHER_JUDGED_PROVIDER, model, usage: observed.usage, outcome });
    };
    const stop = (): void => { void adapter.terminate(false).catch(() => undefined); };
    signal.addEventListener('abort', stop, { once: true });
    let response: CliResponse;
    try {
      response = await adapter.sendMessage({ role: 'user', content: prompt.user });
      observed.observe(response.usage);
    } catch (error) {
      observed.observeError(error);
      if (observed.dispatched) record(signal.aborted || isModelCallCancelled(error) ? 'cancelled' : 'error');
      throw signal.aborted ? abortError() : error;
    } finally {
      signal.removeEventListener('abort', stop);
      observed.dispose();
    }
    const overBudget = response.metadata?.['budgetExceeded'] === true;
    record(overBudget ? 'budget-exceeded' : 'success');
    if (signal.aborted) throw abortError();
    if (overBudget) throw new Error('The judge call went over its budget');
    return { raw: response.content ?? '', provider: WATCHER_JUDGED_PROVIDER, model, latencyMs: Date.now() - startedAt };
  }
}
