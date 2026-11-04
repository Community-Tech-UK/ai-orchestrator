import { describe, expect, it, vi } from 'vitest';
import { completeCopilotDiscoveredModels, toCopilotModelInfo } from './copilot-cli-adapter.models';
import { getModelsForProvider } from '../../../shared/types/provider.types';
import { resolveModelForInvocation } from '../../orchestration/invocation-model-resolver';
import { createCopilotAdapter } from './adapter-factory';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ loopModelByProvider: {} }) }) }));

describe('Copilot premium request labels and machine default', () => {
  it('labels discovered Opus 5.5 and direct model details without replacing wire IDs', () => {
    for (const models of [completeCopilotDiscoveredModels(['claude-opus-5.5']), [toCopilotModelInfo('claude-opus-5.5')]]) {
      expect(models.find(model => model.id === 'claude-opus-5.5')?.name).toBe('Opus 5.5 · 15 premium requests each');
    }
  });
  it('keeps account-specific Opus 5.5 out of the global fallback roster', () => {
    expect(getModelsForProvider('copilot').map(model => model.id)).not.toContain('claude-opus-5.5');
  });
  it('passes the current one-unit default through the real invocation resolver and factory spawn boundary', () => {
    const model = resolveModelForInvocation({ cliType: 'copilot', requestedProvider: 'copilot', prompt: 'Synthetic Harness task' });
    const previous = process.env['AI_ORCHESTRATOR_COPILOT_HOME'];
    const home = mkdtempSync(join(tmpdir(), 'aio-copilot-default-'));
    process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = home;
    try {
      const adapter = createCopilotAdapter({ model, workingDirectory: '/synthetic/project', copilotAccountRoute: {
        profileId: 'legacy', source: 'legacy', executionNodeId: 'local', profileLabel: 'Test account', expectedLogin: 'placeholder', host: 'github.com',
      } });
      const args = adapter.getConfig().args!;
      expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.1-pro-preview');
    } finally {
      if (previous === undefined) delete process.env['AI_ORCHESTRATOR_COPILOT_HOME']; else process.env['AI_ORCHESTRATOR_COPILOT_HOME'] = previous;
      rmSync(home, { recursive: true });
    }
  });
});
