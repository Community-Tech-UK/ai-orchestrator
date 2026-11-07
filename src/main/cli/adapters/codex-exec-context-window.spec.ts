import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsage } from '../../../shared/types/instance.types';
import type { CodexCliConfig } from './codex-adapter-config';
import { getModelCapabilitiesRegistry } from '../../providers/model-capabilities';
import * as costAttribution from '../../core/system/cost-attribution';

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ codexContextTuning: 'harness', codexHelperAgentsHarnessWork: 'off' }),
  }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';

vi.setConfig({ testTimeout: 15_000, hookTimeout: 15_000 });

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** One successful synthetic native exec turn, shaped like `codex exec --json` output. */
async function runExecTurn(config: CodexCliConfig): Promise<{ adapter: CodexCliAdapter; argv: string[]; contexts: ContextUsage[] }> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-exec-window-'));
  directories.push(directory);
  vi.spyOn(costAttribution, 'getCostAttributionDirectory').mockReturnValue(directory);
  const adapter = new CodexCliAdapter(config);
  Object.assign(adapter, { useAppServer: false, isSpawned: true });
  let argv: string[] = [];
  vi.spyOn(adapter as unknown as { spawnProcess(args: string[]): ChildProcess }, 'spawnProcess').mockImplementation((args: string[]) => {
    argv = args;
    const child = spawn(process.execPath, ['-e', `
      process.stdin.resume();
      process.stdin.on('end', () => {
        for (const event of [
          { type: 'thread.started', thread_id: 'fixture-thread' },
          { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'fixture answer' } },
          { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2 } },
        ]) process.stdout.write(JSON.stringify(event) + '\\n');
      });
    `], { stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    return child;
  });
  const contexts: ContextUsage[] = [];
  adapter.on('context', (usage: ContextUsage) => contexts.push(usage));
  adapter.on('error', () => {});
  await (adapter as unknown as { execSendMessage(message: string): Promise<void> }).execSendMessage('fixture task');
  return { adapter, argv, contexts };
}

describe('Codex exec context window diagnostics', () => {
  it('reports the configured machine cap as the effective window on exec context events', async () => {
    const { adapter, argv, contexts } = await runExecTurn({
      sessionKind: 'loop', ephemeral: true, model: 'gpt-6.1-sol', rtkEnabled: false, timeout: 5000,
    });
    expect(argv.slice(0, 2)).toEqual(['-c', 'model_context_window=272000']);
    expect(contexts.map(usage => usage.total)).toEqual([272000]);
    expect((adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig.effectiveContextWindow).toBe(272000);
    expect(adapter.getCapabilities().contextWindow).toBe(272000);
  });

  it('keeps uncapped exec sessions on the catalogue window without recording a machine window', async () => {
    const { adapter, argv, contexts } = await runExecTurn({ sessionKind: 'chat', timeout: 5000 });
    expect(argv).not.toContain('model_context_window=272000');
    const catalogue = getModelCapabilitiesRegistry().getCapabilities('codex', 'default').contextWindow;
    expect(contexts.map(usage => usage.total)).toEqual([catalogue]);
    expect((adapter as unknown as { cliConfig: CodexCliConfig }).cliConfig.effectiveContextWindow).toBeUndefined();
    expect(adapter.getCapabilities().contextWindow).toBe(catalogue);
  });
});
