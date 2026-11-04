import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliAdapter, createCodexAdapter } from '../adapter-factory';
import type { CodexCliConfig } from '../codex-adapter-config';
import { applyInstanceSpawnPolicy } from '../../../instance/lifecycle/instance-spawn-policy';
import type { CodexEphemeralUsage } from '../../../../shared/types/codex-ephemeral-usage.types';
import { CodexEphemeralUsageTracker } from './ephemeral-usage';
import { CodexUsageAccounting } from './usage-accounting';
import { codexExecUsage } from './exec-ephemeral-usage';
import { createMockProcess } from '../codex-cli-adapter.test-helpers';

vi.mock('./codex-thread-policy', () => ({ codexTrialArm: () => 'unassigned' }));
vi.mock('../../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined, getAll: () => ({ providerAccountProfiles: [], providerAccountPools: {} }) }) }));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function receipt(config: CodexCliConfig, exec: boolean) {
  const dir = mkdtempSync(resolve('_scratch/step13-metadata-'));
  directories.push(dir);
  config.usageLogFile = join(dir, 'usage.jsonl');
  if (exec) {
    const usage = codexExecUsage(config);
    usage.observe({ type: 'thread.started', thread_id: 'thread-placeholder' });
    usage.observe({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } });
    usage.finish();
  } else {
    const tracker = new CodexEphemeralUsageTracker(config, new CodexUsageAccounting());
    tracker.bind('thread-placeholder');
    tracker.finish('stopped');
  }
  const raw = readFileSync(config.usageLogFile, 'utf8');
  return { raw, row: JSON.parse(raw) as CodexEphemeralUsage };
}
describe('Codex receipt metadata privacy and runtime identity', () => {
  it.each([false, true])('never relabels an arbitrary plan-queue grouping key as a job (exec=%s)', exec => {
    const { raw, row } = receipt({ ephemeral: true, sessionKind: 'plan-queue', trialKey: 'GROUPING_ONLY_DO_NOT_LOG' }, exec);
    expect(raw).not.toContain('GROUPING_ONLY_DO_NOT_LOG');
    expect(row).toMatchObject({ instanceId: null, jobId: null, kind: 'plan-queue', trialKey: createHash('sha256').update('GROUPING_ONLY_DO_NOT_LOG').digest('hex') });
  });
  it.each([
    { metadata: { planQueueRunId: 'queue-run-placeholder', planQueueItemId: 'queue-item-placeholder' }, kind: 'plan-queue', jobId: 'queue-item-placeholder' },
    { metadata: { automationId: 'automation-definition-placeholder', automationRunId: 'automation-run-placeholder' }, kind: 'automation', jobId: 'automation-run-placeholder' },
    { metadata: { loopRunId: 'loop-run-placeholder' }, kind: 'loop', jobId: 'loop-run-placeholder' },
  ])('retains $kind ownership from instance policy through the actual Codex factory and both writers', ({ metadata, kind, jobId }) => {
    const options = applyInstanceSpawnPolicy('codex', { id: 'instance-placeholder', depth: 1, parentId: 'parent-placeholder', metadata },
      { ephemeral: true, trialKey: 'GROUPING_ONLY_DO_NOT_LOG' });
    const adapter = createCliAdapter('codex', options);
    const config = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
    for (const exec of [false, true]) {
      const { raw, row } = receipt(config, exec);
      expect(row).toMatchObject({ instanceId: 'instance-placeholder', kind, jobId });
      expect(raw).not.toContain('GROUPING_ONLY_DO_NOT_LOG');
    }
  });
  it('preserves explicit review identity through the actual factory', () => {
    const adapter = createCliAdapter('codex', { ephemeral: true, instanceId: 'review-owner-placeholder', jobId: 'review-request-placeholder', sessionKind: 'review' });
    const config = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
    expect(receipt(config, false).row).toMatchObject({ instanceId: 'review-owner-placeholder', jobId: 'review-request-placeholder', kind: 'review' });
  });
  it('does not invent missing ownership in the factory', () => {
    const adapter = createCliAdapter('codex', { ephemeral: true });
    const config = (adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig;
    expect(receipt(config, true).row).toMatchObject({ instanceId: null, jobId: null, kind: 'chat', trialKey: null });
  });
  it('writes actual exec-fallback receipts with the factory identity and distinct token fields', async () => {
    const options = applyInstanceSpawnPolicy('codex', { id: 'instance-placeholder', depth: 1, parentId: 'parent-placeholder',
      metadata: { automationId: 'definition-placeholder', automationRunId: 'run-placeholder' } },
    { ephemeral: true, trialKey: 'GROUPING_ONLY_DO_NOT_LOG' });
    const adapter = createCodexAdapter(options);
    const access = adapter as unknown as { cliConfig: CodexCliConfig; spawnProcess: () => ReturnType<typeof createMockProcess> };
    const dir = mkdtempSync(resolve('_scratch/step13-factory-exec-'));
    directories.push(dir);
    const file = join(dir, 'usage.jsonl');
    access.cliConfig.usageLogFile = file;
    const child = createMockProcess();
    access.spawnProcess = () => child;
    try {
      const pending = adapter.sendMessage({ role: 'user', content: 'DO_NOT_RECORD' });
      await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
      child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'exec-placeholder' }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3 } }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DO_NOT_RECORD' } }) + '\n');
      child.emitClose(0);
      await pending;
      const raw = readFileSync(file, 'utf8');
      expect(JSON.parse(raw)).toMatchObject({ instanceId: 'instance-placeholder', jobId: 'run-placeholder', kind: 'automation',
        requests: null, requestsAvailable: false, tokens: { input: 10, cache: 4, output: 3, reasoning: null, total: 13 }, finishReason: 'exec-exit' });
      expect(raw).not.toContain('GROUPING_ONLY_DO_NOT_LOG');
      expect(raw).not.toContain('DO_NOT_RECORD');
    } finally { await adapter.terminate(false); }
  });
});
