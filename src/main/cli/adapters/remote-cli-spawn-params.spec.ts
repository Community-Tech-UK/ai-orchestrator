import { describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => settings.value }) }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { InstanceSpawnParamsSchema } from '../../remote-node/instance-spawn-rpc-schema';
import { workerSpawnMetadata } from '../../remote-node/remote-spawn-metadata';
import { remoteCliSpawnParams } from './remote-cli-spawn-params';

const options = { sessionId: 'worker-1', workingDirectory: '/tmp', sessionKind: 'chat' as const, trialArm: 'cheaper' as const, trialKey: 'chat-1' };

describe('remote spawn helper-agent level', () => {
  it('sends the level the controller resolved, and the worker rebuilds it as a spawn option', () => {
    settings.value = { codexHelperAgentsChats: 'trial' };
    const params = remoteCliSpawnParams('codex', options, '11111111-1111-4111-8111-111111111111', undefined, undefined);
    expect(params.codexHelperLevel).toBe('economy');
    const wire = InstanceSpawnParamsSchema.parse({ ...params, cliType: 'codex' });
    expect(workerSpawnMetadata({ ...wire, cliType: 'codex' }, () => true, () => undefined)).toMatchObject({ codexHelperLevel: 'economy', trialArm: 'cheaper' });
  });

  it('follows the controller setting, not the arm alone, and is not sent for other providers', () => {
    settings.value = { codexHelperAgentsChats: 'full' };
    expect(remoteCliSpawnParams('codex', options, 'i', undefined, undefined).codexHelperLevel).toBe('full');
    expect(remoteCliSpawnParams('claude', options, 'i', undefined, undefined).codexHelperLevel).toBeUndefined();
  });

  it('sends a checker its catalog choice and role, for Codex only, and the worker rebuilds them', () => {
    settings.value = { codexCheckerSkillCatalog: 'omit' };
    const checker = { sessionId: 'w', workingDirectory: '/tmp', sessionKind: 'plan-queue' as const, queueRole: 'verifier', trialKey: 'job-1' };
    const params = remoteCliSpawnParams('codex', checker, '11111111-1111-4111-8111-111111111111', undefined, undefined);
    expect(params).toMatchObject({ codexOmitSkillCatalog: true, queueRole: 'verifier' });
    const wire = InstanceSpawnParamsSchema.parse({ ...params, cliType: 'codex' });
    expect(workerSpawnMetadata({ ...wire, cliType: 'codex' }, () => true, () => undefined)).toMatchObject({ codexOmitSkillCatalog: true, queueRole: 'verifier' });
    expect(remoteCliSpawnParams('codex', { ...checker, queueRole: 'worker' }, 'i', undefined, undefined).codexOmitSkillCatalog).toBeUndefined();
    const other = remoteCliSpawnParams('claude', checker, 'i', undefined, undefined);
    expect(other.codexOmitSkillCatalog).toBeUndefined();
    expect(other.queueRole).toBeUndefined();
  });
});
