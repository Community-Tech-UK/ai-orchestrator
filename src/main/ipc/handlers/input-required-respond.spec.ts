import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isPaused: vi.fn(() => false),
  clearPrompt: vi.fn(),
  grant: vi.fn(),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: mocks.isPaused }) }));
vi.mock('../../remote/observer-server', () => ({ getRemoteObserverServer: () => ({ clearPrompt: mocks.clearPrompt }) }));
vi.mock('../../security/self-permission-granter', () => ({ getSelfPermissionGranter: () => ({ grant: mocks.grant }) }));

import type { InstanceManager } from '../../instance/instance-manager';
import type { NativeReply } from '../../instance/input-request-receipts';
import { respondToInputRequired } from './input-required-respond';

describe('respondToInputRequired and the receipt for the answer', () => {
  let calls: string[];
  let commit: ReturnType<typeof vi.fn<(reply: NativeReply) => boolean>>;
  let abort: ReturnType<typeof vi.fn<() => void>>;
  let beginReply: ReturnType<typeof vi.fn<(instanceId: string, requestId: string) => { commit: typeof commit; abort: typeof abort }>>;
  let manager: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    calls = [];
    mocks.isPaused.mockReturnValue(false);
    mocks.clearPrompt.mockReset();
    mocks.grant.mockReset();
    commit = vi.fn((reply: NativeReply) => { calls.push(`commit:${reply.response}`); return true; });
    abort = vi.fn(() => { calls.push('abort'); });
    beginReply = vi.fn((instanceId: string, requestId: string) => {
      calls.push(`begin:${instanceId}/${requestId}`);
      return { commit, abort };
    });
    manager = {
      getRequestReceipts: vi.fn(() => ({ beginReply })),
      sendInputResponse: vi.fn(async () => { calls.push('sent'); }),
      resumeAfterDeferredPermission: vi.fn(async () => { calls.push('resumed'); }),
      isPendingInputRequiredPermission: vi.fn(() => true),
      recordInputRequiredPermissionDecision: vi.fn(),
      clearPendingInputRequiredPermission: vi.fn(),
      respawnAfterUnexpectedExit: vi.fn(async () => undefined),
      emitSystemMessage: vi.fn(),
    };
  });

  const respond = (payload: unknown) => respondToInputRequired(manager as unknown as InstanceManager, payload);
  const base = { instanceId: 'inst-1', requestId: 'req-1' };

  describe('an ordinary answer', () => {
    it('holds the request before anything is sent, and commits once it has been', async () => {
      const result = await respond({ ...base, response: 'Bun' });

      expect(result).toMatchObject({ success: true, data: { requestId: 'req-1', responded: true } });
      expect(calls).toEqual(['begin:inst-1/req-1', 'sent', 'commit:Bun']);
      expect(commit).toHaveBeenCalledWith({ response: 'Bun', decision: undefined, receipt: undefined });
      expect(abort).not.toHaveBeenCalled();
    });

    it('rejects a stale request before dispatch', async () => {
      beginReply.mockImplementationOnce(() => { throw Object.assign(new Error('Already closed'), { code: 'INPUT_REQUIRED_NOT_PENDING' }); });
      const result = await respond({ ...base, response: 'Bun' });
      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_NOT_PENDING' } });
      expect(manager['sendInputResponse']).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
    });

    it('does not claim delivery when the request closed while sending', async () => {
      commit.mockReturnValueOnce(false);
      const result = await respond({ ...base, response: 'Bun' });
      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_NOT_PENDING' } });
    });

    it('passes the person\'s own summary of a question\'s answer along', async () => {
      await respond({ ...base, response: 'Q: Bun', receipt: { kind: 'answered', summary: 'Bun' } });

      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ receipt: { kind: 'answered', summary: 'Bun' } }));
    });

    it('commits the permission decision it recorded, not anything the window said about it', async () => {
      await respond({ ...base, response: 'Permission granted.', decisionAction: 'allow', decisionScope: 'session' });

      expect(manager['recordInputRequiredPermissionDecision']).toHaveBeenCalledWith({
        instanceId: 'inst-1', requestId: 'req-1', action: 'allow', scope: 'session',
      });
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: 'allow', scope: 'session' } }));
    });

    it('aborts, and does not commit, when sending fails', async () => {
      manager['sendInputResponse']?.mockRejectedValueOnce(new Error('pipe closed'));

      const result = await respond({ ...base, response: 'Bun' });

      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_RESPOND_FAILED', message: 'pipe closed' } });
      expect(calls).toEqual(['begin:inst-1/req-1', 'abort']);
      expect(commit).not.toHaveBeenCalled();
      expect(mocks.clearPrompt).not.toHaveBeenCalled();
    });

    it('reports a request that already closed as not pending, and aborts', async () => {
      manager['sendInputResponse']?.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'INPUT_REQUIRED_NOT_PENDING' }));

      const result = await respond({ ...base, response: 'Bun' });

      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_NOT_PENDING' } });
      expect(abort).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });
  });

  describe('a held permission being answered', () => {
    const deferred = { ...base, response: 'approved', metadata: { type: 'deferred_permission' } };

    it('commits an allow with its scope', async () => {
      await respond({ ...deferred, decisionAction: 'allow', decisionScope: 'always' });

      expect(manager['resumeAfterDeferredPermission']).toHaveBeenCalledWith('inst-1', true, undefined, { requestId: 'req-1' });
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: 'allow', scope: 'always' } }));
    });

    it('refuses a reply for a request the session is no longer waiting on, before anything resumes', async () => {
      manager['isPendingInputRequiredPermission']?.mockReturnValueOnce(false);

      const result = await respond({ ...deferred, decisionAction: 'allow', decisionScope: 'once' });

      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_NOT_PENDING' } });
      expect(manager['resumeAfterDeferredPermission']).not.toHaveBeenCalled();
      expect(beginReply).not.toHaveBeenCalled();
    });

    it('commits a deny', async () => {
      await respond({ ...deferred, response: 'denied', decisionAction: 'deny' });

      expect(manager['resumeAfterDeferredPermission']).toHaveBeenCalledWith('inst-1', false, undefined, { requestId: 'req-1' });
      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: 'deny', scope: undefined } }));
    });

    it('commits an allow with changes as such', async () => {
      await respond({
        ...deferred, decisionAction: 'modify', decisionScope: 'once', updatedInput: { command: 'echo safe' },
      });

      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: 'modify', scope: 'once' } }));
    });

    it('commits that auto-approve was switched on only when the approval did switch it on', async () => {
      await respond({ ...deferred, decisionAction: 'allow', decisionScope: 'once', metadata: { type: 'deferred_permission', enableYolo: true } });
      await respond({ ...deferred, requestId: 'req-2', decisionAction: 'deny', metadata: { type: 'deferred_permission', enableYolo: true } });

      expect(commit).toHaveBeenNthCalledWith(1, expect.objectContaining({ enabledYolo: true }));
      expect(commit).toHaveBeenNthCalledWith(2, expect.objectContaining({ enabledYolo: false }));
    });

    it('aborts when resuming fails', async () => {
      manager['resumeAfterDeferredPermission']?.mockRejectedValueOnce(new Error('resume failed'));

      const result = await respond({ ...deferred, decisionAction: 'allow', decisionScope: 'once' });

      expect(result).toMatchObject({ success: false });
      expect(abort).toHaveBeenCalledTimes(1);
      expect(commit).not.toHaveBeenCalled();
    });
  });

  describe('"always allow" for a tool the CLI refused', () => {
    const denial = {
      ...base,
      response: 'allow',
      decisionAction: 'allow' as const,
      decisionScope: 'always' as const,
      metadata: { type: 'permission_denial', tool_name: 'Edit', full_path: '/work/a.txt' },
    };

    it('commits that the rule was saved only when it really was', async () => {
      mocks.grant.mockReturnValue({ ok: true, rulePattern: 'Edit(/work/a.txt)', settingsFile: '/s.json', alreadyExisted: false });

      await respond(denial);

      expect(commit).toHaveBeenCalledWith(expect.objectContaining({ decision: { action: 'allow', scope: 'always' }, grant: 'saved' }));
    });

    it('leaves a failed permission write pending for a retry', async () => {
      mocks.grant.mockReturnValue({ ok: false, code: 'WRITE_FAILED', message: 'disk full', settingsFile: '/s.json' });

      const result = await respond(denial);

      expect(result).toMatchObject({ success: false, error: { code: 'PERMISSION_GRANT_FAILED' } });
      expect(commit).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledOnce();
      expect(manager['clearPendingInputRequiredPermission']).not.toHaveBeenCalled();
      expect(mocks.clearPrompt).not.toHaveBeenCalled();
      expect(manager['respawnAfterUnexpectedExit']).not.toHaveBeenCalled();
    });

    it('commits before the session restarts to pick the rule up', async () => {
      mocks.grant.mockReturnValue({ ok: true, rulePattern: 'Edit(/work/a.txt)', settingsFile: '/s.json', alreadyExisted: false });
      manager['respawnAfterUnexpectedExit']?.mockImplementation(async () => { calls.push('respawned'); });

      await respond(denial);

      expect(calls.indexOf('commit:allow')).toBeGreaterThan(-1);
      expect(calls.indexOf('commit:allow')).toBeLessThan(calls.indexOf('respawned'));
    });
  });

  describe('when no answer is applied', () => {
    it('holds nothing while the orchestrator is paused', async () => {
      mocks.isPaused.mockReturnValue(true);

      const result = await respond({ ...base, response: 'Bun' });

      expect(result).toMatchObject({ success: false, error: { code: 'ORCHESTRATOR_PAUSED' } });
      expect(beginReply).not.toHaveBeenCalled();
      expect(manager['sendInputResponse']).not.toHaveBeenCalled();
    });

    it('holds nothing for a payload that does not validate', async () => {
      const result = await respond({ requestId: 'req-1', response: 'Bun' });

      expect(result).toMatchObject({ success: false, error: { code: 'INPUT_REQUIRED_RESPOND_FAILED' } });
      expect(beginReply).not.toHaveBeenCalled();
    });

    it('refuses a modify decision with nothing to change, before holding anything for it to fail', async () => {
      const result = await respond({
        ...base, response: 'approved', decisionAction: 'modify', decisionScope: 'once', metadata: { type: 'deferred_permission' },
      });

      expect(result).toMatchObject({ success: false });
      expect(manager['resumeAfterDeferredPermission']).not.toHaveBeenCalled();
    });
  });
});
