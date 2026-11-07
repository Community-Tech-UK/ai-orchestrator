import { recordSessionPolicy } from '../../../core/system/session-policy-log';
import { startThreadWithRetry, type ThreadStartClient } from './thread-start-retry';
import { resumeThreadWithRetry, type ThreadResumeClient } from './thread-resume-retry';
import type { AppServerRequestParams } from './app-server-types';
import type { CodexCliConfig } from '../codex-adapter-config';
import type { CodexThreadPolicy } from './codex-thread-policy';
import { getLogger } from '../../../logging/logger';
const logger = getLogger('CodexThreadPolicy');
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * The overrides an error message rejects. Codex names the rejected field in backticks or quotes (serde gives only
 * the last part of a nested key, as in `include_instructions`), and often follows it with the valid alternatives
 * ("expected one of `a`, `b`"), which are not rejected and are ignored here. Without a quoted field the message
 * must name a whole key; a bare last part such as `enabled` is too generic to match.
 */
function namedKeys(message: string, config: Record<string, unknown>): string[] {
  const rejected = message.split(/,?\s*expected\s+(?:one of|any of|[`'"])/i)[0];
  const quoted = [...rejected.matchAll(/[`'"]([\w.]+)[`'"]/g)].map(match => match[1]);
  const keys = Object.keys(config);
  const byQuote = keys.filter(key => quoted.includes(key) || quoted.includes(key.slice(key.lastIndexOf('.') + 1)));
  if (byQuote.length) return byQuote;
  return keys.filter(key => new RegExp(`(?<![\\w.])${escaped(key)}(?![\\w.])`).test(rejected));
}
function unsupportedConfig(error: unknown, policy: CodexThreadPolicy): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|unsupported|invalid|unexpected)/i.test(message) && (/config/i.test(message) || namedKeys(message, policy.config).length > 0);
}
/** Compatibility retries remove only the rejected keys the error names; transport errors remain fatal. */
async function withPolicy<T>(request: (config: Record<string, unknown> | undefined) => Promise<T>, policy: CodexThreadPolicy): Promise<{ result: T; rejectedKeys: string[]; config: Record<string, unknown> }> {
  let config = { ...policy.config };
  const rejectedKeys: string[] = [];
  for (;;) {
    try { return { result: await request(Object.keys(config).length ? config : undefined), rejectedKeys, config }; }
    catch (error) {
      if (!unsupportedConfig(error, { ...policy, config }) || !Object.keys(config).length) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const named = namedKeys(message, config);
      // Old servers may reject the entire config field rather than an individual key.
      const removed = named.length ? named : Object.keys(config);
      config = Object.fromEntries(Object.entries(config).filter(([key]) => !removed.includes(key)));
      rejectedKeys.push(...removed);
      logger.warn('Codex rejected thread policy overrides; retrying supported keys', { level: policy.level, rejectedKeys: removed });
    }
  }
}
export function buildCodexThreadStartParams(config: CodexCliConfig, input: { cwd: string; sandbox: NonNullable<AppServerRequestParams<'thread/start'>['sandbox']>; approvalPolicy: AppServerRequestParams<'thread/start'>['approvalPolicy'] }): AppServerRequestParams<'thread/start'> {
  return { ...input, model: config.model || null, serviceName: 'ai-orchestrator', ephemeral: config.ephemeral ?? false, serviceTier: config.fastMode ? 'priority' : null };
}
export async function startCodexThread(client: ThreadStartClient, params: AppServerRequestParams<'thread/start'>, policy: CodexThreadPolicy, config?: CodexCliConfig): ReturnType<typeof startThreadWithRetry> {
  const attempt = await withPolicy(overrides => startThreadWithRetry(client, { ...params, ...(overrides ? { config: overrides } : {}) }), policy);
  logPolicy(attempt.result.threadId || attempt.result.thread?.id, policy, config, attempt, 'start');
  return attempt.result;
}
export async function resumeCodexThread(client: ThreadResumeClient, params: AppServerRequestParams<'thread/resume'>, policy: CodexThreadPolicy, config?: CodexCliConfig): ReturnType<typeof resumeThreadWithRetry> {
  const attempt = await withPolicy(overrides => resumeThreadWithRetry(client, { ...params, ...(overrides ? { config: overrides } : {}) }), policy);
  logPolicy(attempt.result.threadId || attempt.result.thread?.id, policy, config, attempt, 'resume');
  return attempt.result;
}
function logPolicy(threadId: string | undefined, policy: CodexThreadPolicy, config: CodexCliConfig | undefined, attempt: { rejectedKeys: string[]; config: Record<string, unknown> }, operation: 'start' | 'resume'): void {
  const contextWindow = typeof attempt.config['model_context_window'] === 'number' ? attempt.config['model_context_window'] : undefined;
  if (config) {
    config.effectiveContextWindow = contextWindow;
    // The turn adapter names required skills only while the catalog is really off, so this follows the thread that actually started.
    config.skillCatalogOmitted = attempt.config['skills.include_instructions'] === false;
  }
  if (!threadId) return;
  const applied = attempt.rejectedKeys.length === 0;
  recordSessionPolicy({ provider: 'codex', threadId, sessionKind: config?.sessionKind ?? 'chat', level: policy.level, operation,
    arm: policy.arm, armKey: policy.armKey ?? config?.trialKey, armSource: policy.armSource ?? config?.trialKeySource,
    instanceId: config?.harnessInstanceId, outputLimit: policy.outputLimit, postTurnCompactPercent: policy.postTurnCompactPercent, applied,
    helperPolicyApplied: !attempt.rejectedKeys.some(key => key.startsWith('agents.')),
    rejectedKeys: attempt.rejectedKeys, contextWindow, largeDocumentExempt: config?.planQueueLargeDocument === true,
    configKeys: Object.keys(attempt.config).sort(),
    // The catalog the surviving overrides ask for. Codex 0.167.0 accepts unknown keys silently and its reply does not echo
    // the settings in force, so this is what was requested, not what Codex confirmed.
    ...(policy.catalog ? { catalog: attempt.config['skills.include_instructions'] === false ? 'omitted' as const : attempt.config['skills.max_context_tokens'] !== undefined ? 'capped' as const : 'native' as const } : {}),
    ...(policy.checkerArm ? { checkerArm: policy.checkerArm } : {}) });
}
