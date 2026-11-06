import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({}) }),
}));
vi.mock('../../browser-gateway/browser-approval-store', () => ({
  getBrowserApprovalStore: () => ({ listRequests: () => [] }),
}));

import { CodexCliAdapter } from './codex-cli-adapter';
import { PlanQueueItemFlow } from '../../plan-queue/plan-queue-item-flow';
import { PlanQueueVerifierReminders } from '../../plan-queue/plan-queue-verifier-reminder';
import type { PlanQueueFlowHost } from '../../plan-queue/plan-queue-host';
import type { PlanQueueItem } from '../../plan-queue/plan-queue.types';
import { sendInitialPromptToAdapter } from '../../instance/lifecycle/initial-prompt-dispatch';
import type { Instance } from '../../../shared/types/instance.types';
import type { CodexCliConfig } from './codex-adapter-config';
import { _resetRequiredSkillsForTesting } from './codex/codex-required-skills';

type Notification = { method: string; params: Record<string, unknown> };
interface TurnClient {
  exitPromise: Promise<void>;
  notificationHandler: ((notification: Notification) => void) | null;
  request: Mock<(method: string, params?: Record<string, unknown>) => Promise<unknown>>;
  setNotificationHandler(handler: TurnClient['notificationHandler']): void;
  subscribeNotifications(handler: (notification: Notification) => void): () => void;
}

/** A client whose `turn/start` completes the turn at once, recording every request. */
function createClient(): TurnClient {
  const client: TurnClient = {
    exitPromise: new Promise<void>(() => undefined),
    notificationHandler: null,
    request: vi.fn(async (method: string) => {
      if (method === 'thread/inject_items') return {};
      if (method !== 'turn/start') throw new Error(`Unexpected RPC: ${method}`);
      client.notificationHandler?.({ method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1' } } });
      client.notificationHandler?.({
        method: 'item/completed',
        params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'm1', type: 'agentMessage', phase: 'final_answer', text: 'ok' } },
      });
      client.notificationHandler?.({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
      });
      return { turn: { id: 'turn-1', status: 'inProgress' } };
    }),
    setNotificationHandler(handler) { client.notificationHandler = handler; },
    subscribeNotifications(handler) {
      const previous = client.notificationHandler;
      client.notificationHandler = (notification) => { previous?.(notification); handler(notification); };
      return () => { client.notificationHandler = previous; };
    },
  };
  return client;
}

function connectedAdapter(config: CodexCliConfig) {
  const adapter = new CodexCliAdapter(config);
  const client = createClient();
  Object.assign(adapter, { appServerClient: client, appServerThreadId: 'thread-1', useAppServer: true, isSpawned: true });
  return { adapter, client };
}

function turnInput(client: TurnClient): Array<Record<string, unknown>> {
  const turn = client.request.mock.calls.find(([method]) => method === 'turn/start');
  return (turn?.[1] as { input: Array<Record<string, unknown>> }).input;
}

async function sentInput(config: CodexCliConfig, message: string): Promise<Array<Record<string, unknown>>> {
  const { adapter, client } = connectedAdapter(config);
  await adapter.sendInput(message);
  return turnInput(client);
}

describe('Codex turn input names required skills', () => {
  const folders: string[] = [];
  afterEach(() => {
    _resetRequiredSkillsForTesting();
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });
  function repoWithGateSkill(): string {
    const repo = mkdtempSync(join(tmpdir(), 'aio-codex-skill-repo-'));
    folders.push(repo);
    mkdirSync(join(repo, '.agents', 'skills', 'task-completion-gate'), { recursive: true });
    writeFileSync(join(repo, '.agents', 'skills', 'task-completion-gate', 'SKILL.md'), '---\nname: task-completion-gate\n---\n');
    return repo;
  }

  it('adds the governing skill to a checker turn once its catalog is omitted', async () => {
    const input = await sentInput({ sessionKind: 'plan-queue', queueRole: 'verifier', skillCatalogOmitted: true, workingDir: repoWithGateSkill() }, 'Judge the work.');
    expect(input).toEqual([{ type: 'text', text: 'Judge the work.\n\nSkills for this turn: $task-completion-gate', text_elements: [] }]);
  });

  it('leaves a checker turn alone while its catalog is on, and leaves chats alone', async () => {
    const workingDir = repoWithGateSkill();
    expect(await sentInput({ sessionKind: 'plan-queue', queueRole: 'verifier', skillCatalogOmitted: false, workingDir }, 'Judge the work.'))
      .toEqual([{ type: 'text', text: 'Judge the work.', text_elements: [] }]);
    expect(await sentInput({ sessionKind: 'chat', skillCatalogOmitted: true, workingDir }, 'Judge the work.'))
      .toEqual([{ type: 'text', text: 'Judge the work.', text_elements: [] }]);
  });

  it('names a skill that a capped worker prompt refers to', async () => {
    const input = await sentInput({ sessionKind: 'plan-queue', queueRole: 'worker', workingDir: repoWithGateSkill() }, 'Finish the plan. Use the `task-completion-gate` skill last.');
    expect(input).toHaveLength(1);
    expect(String(input[0]?.['text'])).toMatch(/\n\nSkills for this turn: \$task-completion-gate$/);
  });

  it('keeps initial lifecycle dispatch on the existing user-input mention path', async () => {
    const { adapter, client } = connectedAdapter({ sessionKind: 'plan-queue', queueRole: 'verifier', skillCatalogOmitted: true, workingDir: repoWithGateSkill() });
    await sendInitialPromptToAdapter({ id: 'verifier' } as Instance, adapter, 'Judge the work.');
    expect(turnInput(client)).toEqual([{ type: 'text', text: 'Judge the work.\n\nSkills for this turn: $task-completion-gate', text_elements: [] }]);
    expect(client.request.mock.calls.some(([method]) => method === 'thread/inject_items')).toBe(false);
  });

  it('selects required skills on an internal continuation without changing developer provenance', async () => {
    const workingDir = repoWithGateSkill();
    const { adapter, client } = connectedAdapter({ sessionKind: 'plan-queue', queueRole: 'worker', workingDir });
    const text = 'Continue the repair. Use the `task-completion-gate` skill last.';
    await adapter.sendInput(text, undefined, { internalSource: 'plan-queue' });
    expect(turnInput(client)).toEqual([{ type: 'skill', name: 'task-completion-gate', path: realpathSync(join(workingDir, '.agents/skills/task-completion-gate/SKILL.md')) }]);
    expect(client.request.mock.calls.find(([method]) => method === 'thread/inject_items')?.[1]).toEqual({
      threadId: 'thread-1', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }],
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(['thread/inject_items', 'turn/start']);
  });

  it('carries the real Queue worker continuation to explicit skill selection', async () => {
    const workingDir = repoWithGateSkill();
    const { adapter, client } = connectedAdapter({ sessionKind: 'plan-queue', queueRole: 'worker', workingDir });
    let item = { id: 'item', runId: 'run', workerInstanceId: 'worker' } as PlanQueueItem;
    const host = {
      getRun: () => ({ status: 'running' }), getItem: () => item,
      save: (next: PlanQueueItem) => { item = next; return next; }, registerRole: vi.fn(),
      instances: { getInstance: () => ({ status: 'idle' }),
        sendInput: (_id: string, text: string, _attachments: undefined, options: { internalSource: 'plan-queue' }) => adapter.sendInput(text, undefined, options) },
      tracker: { beginTurn: vi.fn() },
    } as unknown as PlanQueueFlowHost;
    const flow = new PlanQueueItemFlow(host) as unknown as { runWorkerTurn(item: PlanQueueItem, prompt: string): Promise<void> };
    const text = 'Repair the finding, then use the `task-completion-gate` skill.';
    await flow.runWorkerTurn(item, text);
    expect(item.pendingInstruction).toBeNull();
    expect(turnInput(client)).toEqual([{ type: 'skill', name: 'task-completion-gate', path: realpathSync(join(workingDir, '.agents/skills/task-completion-gate/SKILL.md')) }]);
    expect(client.request.mock.calls[0]).toEqual(['thread/inject_items', { threadId: 'thread-1', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] }] }]);
  });

  it('carries a real Queue verifier reminder through public adapter input to skill-selection wire items', async () => {
    const workingDir = repoWithGateSkill();
    const { adapter, client } = connectedAdapter({ sessionKind: 'plan-queue', queueRole: 'verifier', skillCatalogOmitted: true, workingDir });
    let sent: Promise<void> | undefined;
    const sendInput = vi.fn((_id: string, text: string, _attachments: undefined, options: { internalSource: 'plan-queue' }) => {
      sent = adapter.sendInput(text, undefined, options);
      return sent;
    });
    const host = {
      getRun: () => ({ status: 'running' }),
      instances: { getInstance: () => ({ status: 'idle' }), sendInput },
      tracker: { beginTurn: vi.fn(), isShuttingDown: () => false },
    } as unknown as PlanQueueFlowHost;
    const failed = vi.fn();
    const reminders = new PlanQueueVerifierReminders(host, failed);
    const item = { id: 'item', runId: 'run' } as PlanQueueItem;
    expect(await reminders.remind(item, 'verifier', { kind: 'turn-complete', lastAssistantOutput: null }, false, undefined)).toBe(true);
    await sent;
    expect(failed).not.toHaveBeenCalled();
    expect(sendInput).toHaveBeenCalledWith('verifier', expect.any(String), undefined, { automatedInput: true, internalSource: 'plan-queue' });
    expect(turnInput(client)).toEqual([{ type: 'skill', name: 'task-completion-gate', path: realpathSync(join(workingDir, '.agents/skills/task-completion-gate/SKILL.md')) }]);
    const injected = client.request.mock.calls.find(([method]) => method === 'thread/inject_items')?.[1];
    expect(injected).toEqual({ threadId: 'thread-1', items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: sendInput.mock.calls[0][1] }] }] });
  });

  it('preserves explicit skill references on internal turns without adding user prose', async () => {
    const workingDir = repoWithGateSkill();
    const { adapter, client } = connectedAdapter({ sessionKind: 'loop', workingDir });
    await adapter.sendInput('Continue with $task-completion-gate.', undefined, { internalSource: 'plan-queue' });
    expect(turnInput(client)).toEqual([{ type: 'skill', name: 'task-completion-gate', path: realpathSync(join(workingDir, '.agents/skills/task-completion-gate/SKILL.md')) }]);
  });

  it('leaves internal chats and missing skill references as developer text only', async () => {
    const workingDir = repoWithGateSkill();
    for (const config of [{ sessionKind: 'chat' as const }, { sessionKind: 'loop' as const }]) {
      const { adapter, client } = connectedAdapter({ ...config, workingDir });
      const text = config.sessionKind === 'chat' ? 'Use the `task-completion-gate` skill.' : 'Use the `not-installed-synthetic-skill` skill.';
      await adapter.sendInput(text, undefined, { internalSource: 'plan-queue' });
      expect(turnInput(client)).toEqual([]);
      expect(client.request.mock.calls[0][0]).toBe('thread/inject_items');
    }
  });

});
