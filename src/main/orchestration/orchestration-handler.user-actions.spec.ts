import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  checkPermission: vi.fn(),
  recordUserDecision: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ workspaceSecretsEnabled: true, workspaceSecretsAllowAgentRequests: true }),
  }),
}));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('./consensus-coordinator', () => ({ getConsensusCoordinator: () => ({ query: vi.fn() }) }));
vi.mock('../automations/automation-create-service', () => ({ createAutomationWithScheduling: vi.fn() }));
vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => ({
    admitAutomatedWrite: () => ({ kind: 'admitted', admissionId: 'adm' }),
    markDelivered: vi.fn(),
    markFailed: vi.fn(),
    registerRedeliveryHandler: vi.fn(),
  }),
}));
vi.mock('../security/permission-manager', () => ({
  getPermissionManager: () => ({
    checkPermission: mocks.checkPermission,
    recordUserDecision: mocks.recordUserDecision,
  }),
}));
vi.mock('../tools/tool-registry', () => ({ getToolRegistry: () => ({ callTool: mocks.callTool }) }));

import { OrchestrationHandler } from './orchestration-handler';
import type { UserActionRequest } from './orchestration-handler.types';
import type { SettledUserAction } from './user-action-lifecycle';

const FIVE_MINUTES = 5 * 60 * 1000;

function commandBlock(command: Record<string, unknown>): string {
  return [':::ORCHESTRATOR_COMMAND:::', JSON.stringify(command), ':::END_COMMAND:::'].join('\n');
}

/** Lets an awaiting tool call carry on after its question ends. */
async function settleMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe('OrchestrationHandler user-action lifecycle', () => {
  let orchestration: OrchestrationHandler;
  let requests: UserActionRequest[];
  let resolved: SettledUserAction[];
  let injected: { instanceId: string; response: string }[];

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.checkPermission.mockReset().mockReturnValue({ action: 'ask', reason: 'needs approval' });
    mocks.recordUserDecision.mockReset();
    mocks.callTool.mockReset().mockResolvedValue({ ok: true, output: 'done' });
    orchestration = new OrchestrationHandler();
    orchestration.registerInstance('i-1', '/work', null);
    requests = [];
    resolved = [];
    injected = [];
    orchestration.on('user-action-request', (request: UserActionRequest) => requests.push(request));
    orchestration.on('user-action-resolved', (settled: SettledUserAction) => resolved.push(settled));
    orchestration.on('inject-response', (instanceId: string, response: string) => injected.push({ instanceId, response }));
  });

  afterEach(() => {
    orchestration.dispose();
    vi.useRealTimers();
  });

  /** The model asks to run a tool that needs the person's say-so; returns the question it raised. */
  async function askToRunTool(toolId = 'read_file'): Promise<UserActionRequest> {
    orchestration.processOutput('i-1', commandBlock({ action: 'call_tool', toolId, args: { path: 'a.txt' } }));
    await settleMicrotasks();
    const question = requests.at(-1);
    if (!question) throw new Error('no question was raised');
    return question;
  }

  function askModelQuestion(overrides: Record<string, unknown> = {}): UserActionRequest {
    orchestration.processOutput('i-1', commandBlock({
      action: 'request_user_action', requestType: 'confirm', title: 'Proceed?', message: 'Run the migration?', ...overrides,
    }));
    const question = requests.at(-1);
    if (!question) throw new Error('no question was raised');
    return question;
  }

  describe('a tool the person has to approve', () => {
    it('is answered once: announced as decided, the tool runs and the model is not told twice', async () => {
      const question = await askToRunTool();
      expect(question.title).toBe('Tool Permission Required');

      expect(orchestration.respondToUserAction(question.id, true, 'allow_once', 'window')).toBe('resolved');
      await settleMicrotasks();

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        request: { id: question.id },
        end: { reason: 'decided', approved: true, selectedOption: 'allow_once', via: 'window' },
      });
      expect(mocks.recordUserDecision).toHaveBeenCalledWith('i-1', expect.anything(), 'allow', 'once');
      expect(mocks.callTool).toHaveBeenCalledTimes(1);
      expect(injected).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is closed as timed out after five minutes: announced, the model is told, nothing runs', async () => {
      const question = await askToRunTool();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(FIVE_MINUTES);

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ request: { id: question.id }, waitedMs: FIVE_MINUTES, end: { reason: 'timeout' } });
      expect(mocks.callTool).not.toHaveBeenCalled();
      expect(injected).toHaveLength(1);
      expect(injected[0]?.response).toContain('timed out');
      expect(orchestration.getPendingUserActionsForInstance('i-1')).toEqual([]);
    });

    it('turns a reply that arrives after the timeout into a stale one, and the model hears nothing more', async () => {
      const question = await askToRunTool();
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES);
      injected.length = 0;

      expect(orchestration.respondToUserAction(question.id, true, 'allow_once', 'window')).toBe('not-pending');

      expect(resolved).toHaveLength(1);
      expect(injected).toEqual([]);
      expect(mocks.callTool).not.toHaveBeenCalled();
    });

    it('is cancelled when the turn is stopped: no run, nothing told to the model, a late reply is stale', async () => {
      const question = await askToRunTool();

      expect(orchestration.cancelToolPickers('i-1')).toBe(1);
      await settleMicrotasks();

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ request: { id: question.id }, end: { reason: 'cancelled' } });
      expect(mocks.callTool).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(orchestration.respondToUserAction(question.id, true, 'allow_once', 'window')).toBe('not-pending');
      await settleMicrotasks();
      expect(mocks.callTool).not.toHaveBeenCalled();
    });

    it('is closed as exited, with no timer left behind, when the session goes away', async () => {
      const question = await askToRunTool();

      orchestration.unregisterInstance('i-1');
      await settleMicrotasks();

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ request: { id: question.id }, end: { reason: 'exited' } });
      expect(mocks.callTool).not.toHaveBeenCalled();
      expect(injected).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is never reported as both answered and timed out', async () => {
      const question = await askToRunTool();
      await vi.advanceTimersByTimeAsync(FIVE_MINUTES - 1);

      orchestration.respondToUserAction(question.id, true, 'deny_once', 'window');
      await vi.advanceTimersByTimeAsync(10);

      expect(resolved.map((settled) => settled.end.reason)).toEqual(['decided']);
    });
  });

  describe('a question the model raised itself', () => {
    it('is answered once: announced, the answer goes to the model, and the channel is recorded', () => {
      const question = askModelQuestion();

      expect(orchestration.respondToUserAction(question.id, true, undefined, 'window')).toBe('resolved');

      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ end: { reason: 'decided', approved: true, via: 'window' } });
      expect(injected).toHaveLength(1);
      expect(injected[0]?.response).toContain('user_action_response');
    });

    it('counts an answer from the phone, a chat channel or another screen as elsewhere', () => {
      const question = askModelQuestion();

      orchestration.respondToUserAction(question.id, false);

      expect(resolved[0]).toMatchObject({ end: { reason: 'decided', approved: false, via: 'elsewhere' } });
    });

    it('reports a second answer as not pending and tells the model nothing more', () => {
      const question = askModelQuestion();
      orchestration.respondToUserAction(question.id, true, undefined, 'window');
      injected.length = 0;

      expect(orchestration.respondToUserAction(question.id, false)).toBe('not-pending');

      expect(injected).toEqual([]);
      expect(resolved).toHaveLength(1);
    });

    it('reports a request nobody raised as not pending', () => {
      expect(orchestration.respondToUserAction('uar-nope', true)).toBe('not-pending');
      expect(resolved).toEqual([]);
    });

    it('waits for as long as it takes: no timer, no timeout', async () => {
      const question = askModelQuestion();
      expect(vi.getTimerCount()).toBe(0);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

      expect(orchestration.getPendingUserActions().map((r) => r.id)).toEqual([question.id]);
      expect(resolved).toEqual([]);
    });

    it('cancels ordinary questions on a session interrupt and refuses late answers', () => {
      const question = askModelQuestion({ requestType: 'ask_questions', questions: ['Which?'] });
      expect(orchestration.cancelUserActions('i-1')).toBe(1);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({ request: { id: question.id }, end: { reason: 'cancelled' } });
      expect(orchestration.respondToUserAction(question.id, true, 'late', 'window')).toBe('not-pending');
      expect(injected).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('is left standing when the turn is stopped, because the answer is still wanted', () => {
      const question = askModelQuestion();

      expect(orchestration.cancelToolPickers('i-1')).toBe(0);

      expect(orchestration.getPendingUserActions().map((r) => r.id)).toEqual([question.id]);
      expect(resolved).toEqual([]);
    });

    it('is closed as exited, without telling the model, when the session goes away', () => {
      askModelQuestion();

      orchestration.unregisterInstance('i-1');

      expect(resolved.map((settled) => settled.end.reason)).toEqual(['exited']);
      expect(injected).toEqual([]);
      expect(orchestration.getPendingUserActions()).toEqual([]);
    });

    it('refuses a plain answer to a secret card and leaves it waiting', () => {
      const question = askModelQuestion({
        requestType: 'secret_required',
        title: 'Credential needed',
        message: 'Supply the credential',
        secretRequest: { name: 'DEPLOY_TOKEN', label: 'Deployment token', purpose: 'Deploy' },
      });

      expect(orchestration.respondToUserAction(question.id, true, 'PLACEHOLDER_ONLY', 'window')).toBe('dedicated-channel');

      expect(orchestration.getPendingUserActions().map((r) => r.id)).toEqual([question.id]);
      expect(resolved).toEqual([]);
      expect(injected).toEqual([]);
    });

    it('announces a saved secret as answered here, carrying only the reference', () => {
      const question = askModelQuestion({
        requestType: 'secret_required',
        title: 'Credential needed',
        message: 'Supply the credential',
        secretRequest: { name: 'DEPLOY_TOKEN', label: 'Deployment token', purpose: 'Deploy' },
      });

      expect(orchestration.resolveSecretRequest('i-1', question.id, true, 'secret://deploy-token')).toBe(true);

      expect(resolved[0]).toMatchObject({
        request: { secretRequest: { label: 'Deployment token' } },
        end: { reason: 'decided', approved: true, selectedOption: 'secret://deploy-token', via: 'window' },
      });
      expect(orchestration.resolveSecretRequest('i-1', question.id, true, 'secret://deploy-token')).toBe(false);
    });
  });

  describe('shutting down', () => {
    it('ends every open question and leaves no timer running', async () => {
      await askToRunTool();
      askModelQuestion();

      orchestration.dispose();
      await settleMicrotasks();

      expect(resolved.map((settled) => settled.end.reason).sort()).toEqual(['exited', 'exited']);
      expect(vi.getTimerCount()).toBe(0);
      expect(orchestration.getPendingUserActions()).toEqual([]);
    });
  });
});
