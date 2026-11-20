import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSessionPolicyEvents, type SessionRequiredSkillsRecord } from '../../../core/system/session-policy-log';
import { recordCheckerSkillDelivery } from './codex-required-skills';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aio-required-skills-log-'));
  process.env['AIO_SESSION_POLICY_DIR'] = directory;
});
afterEach(() => {
  delete process.env['AIO_SESSION_POLICY_DIR'];
  rmSync(directory, { recursive: true, force: true });
});

const rows = () => readSessionPolicyEvents<SessionRequiredSkillsRecord>('required-skills', 0, directory);
const checker = { sessionKind: 'plan-queue' as const, queueRole: 'verifier', skillCatalogOmitted: true, harnessInstanceId: 'instance-1', workingDir: '/unused' };

describe('recordCheckerSkillDelivery', () => {
  it('records the skill names a checker turn named, and nothing else', () => {
    recordCheckerSkillDelivery(checker, 'thread-1', 'skill-item', ['task-completion-gate']);
    expect(rows()).toEqual([expect.objectContaining({
      event: 'required-skills', provider: 'codex', sessionKind: 'plan-queue', queueRole: 'verifier', threadId: 'thread-1',
      instanceId: 'instance-1', skills: ['task-completion-gate'], via: 'skill-item', catalogOmitted: true, governingSkillNamed: true,
    })]);
    expect(Object.keys(rows()[0]).sort()).toEqual([
      'at', 'catalogOmitted', 'event', 'governingSkillNamed', 'instanceId', 'provider', 'queueRole', 'sessionKind', 'skills', 'threadId', 'via',
    ]);
  });

  it('records a checker turn that named nothing, so a missing skill is visible', () => {
    recordCheckerSkillDelivery({ ...checker, skillCatalogOmitted: false }, undefined, 'mention', ['other-skill']);
    expect(rows()).toEqual([expect.objectContaining({ skills: ['other-skill'], catalogOmitted: false, governingSkillNamed: false })]);
    expect(rows()[0]).not.toHaveProperty('threadId');
  });

  it('writes nothing for workers, other roles, chats or an unlabelled session', () => {
    recordCheckerSkillDelivery({ ...checker, queueRole: 'worker' }, 'thread-1', 'mention', ['task-completion-gate']);
    recordCheckerSkillDelivery({ ...checker, queueRole: undefined }, 'thread-1', 'mention', ['task-completion-gate']);
    recordCheckerSkillDelivery({ ...checker, sessionKind: 'chat' }, 'thread-1', 'mention', ['task-completion-gate']);
    recordCheckerSkillDelivery({ ...checker, sessionKind: undefined }, 'thread-1', 'mention', ['task-completion-gate']);
    expect(rows()).toEqual([]);
  });
});
