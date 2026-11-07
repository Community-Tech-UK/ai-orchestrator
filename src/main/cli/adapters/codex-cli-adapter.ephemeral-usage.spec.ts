import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { CodexCliAdapter } from './codex-cli-adapter';
import type { AppServerNotification } from './codex/app-server-types';
import type { CodexCliConfig } from './codex-adapter-config';
import { createMockProcess } from './codex-cli-adapter.test-helpers';

vi.mock('./codex/codex-thread-policy', () => ({
  codexThreadPolicyForConfig: () => ({ level: 'off', config: {}, outputLimit: null, postTurnCompactPercent: null }),
  codexExecContextWindowArgs: () => [],
}));
vi.mock('./codex/child-rollout-usage', () => ({ readChildRolloutUsage: async () => [] }));
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(ephemeral = true, configOverrides: Partial<CodexCliConfig> = {}) {
  mkdirSync(resolve('_scratch'), { recursive: true });
  const dir = mkdtempSync(resolve('_scratch/step13-runtime-')); directories.push(dir);
  const file = join(dir, 'usage.jsonl');
  const adapter = new CodexCliAdapter({ ephemeral, sessionKind: 'plan-queue', jobId: 'job-example', trialKey: 'job-example', trialArm: 'cheaper',
    env: { AI_ORCHESTRATOR_INSTANCE_ID: 'instance-example', UNUSED_PRIVATE_VALUE: 'DO_NOT_RECORD' },
    usageLogFile: file, ...configOverrides });
  let exit!: () => void;
  let root = 'root-1';
  let sequence = 0;
  let events: AppServerNotification[] = [];
  let exitDuringSend = false;
  const listeners = new Set<(n: AppServerNotification) => void>();
  const notify = (n: AppServerNotification) => { for (const listener of [...listeners]) listener(n); };
  const client = {
    exitPromise: new Promise<void>(resolve => { exit = resolve; }),
    subscribeNotifications: (listener: (n: AppServerNotification) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    setServerRequestHandler: () => undefined,
    isRunning: () => true,
    getExitError: () => null,
    close: async () => { exit(); },
    async request(method: string) {
      if (method === 'thread/start') return { thread: { id: root } };
      if (method === 'thread/backgroundTerminals/list') return { terminals: [] };
      const id = `turn-${++sequence}`;
      notify({ method: 'turn/started', params: { threadId: root, turn: { id } } });
      for (const event of events) notify(event);
      if (exitDuringSend) { exit(); return new Promise(() => undefined); }
      notify({ method: 'turn/completed', params: { threadId: root, turn: { id, status: 'completed' } } });
      return { turn: { id, status: 'completed' } };
    },
  };
  const access = adapter as unknown as {
    connectAppServer(): Promise<unknown>; initAppServerMode(epoch?: number): Promise<void>; reopenAppServerThread(): Promise<void>;
    appServerSendMessageInner(message: string): Promise<void>; usageAccounting: { ownsThread(id: string): boolean };
    config: { command: string; args: string[] }; spawnProcess: () => ReturnType<typeof createMockProcess>;
  };
  access.connectAppServer = async () => client;
  return { adapter, access, file, notify, exit: () => exit(),
    lines: () => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
    async start() { await access.initAppServerMode(); Object.assign(adapter, { useAppServer: true, isSpawned: true }); },
    async send(next: AppServerNotification[]) { events = next; await access.appServerSendMessageInner('DO_NOT_RECORD'); },
    async sendAndExit(next: AppServerNotification[]) { exitDuringSend = true; events = next; await access.appServerSendMessageInner('DO_NOT_RECORD'); },
    async reopen() { root = 'root-2'; await access.reopenAppServerThread(); },
  };
}
const update = (threadId: string, inputTokens: number, outputTokens: number): AppServerNotification => ({
  method: 'thread/tokenUsage/updated', params: { threadId, tokenUsage: {
    total: { inputTokens, outputTokens, cachedInputTokens: inputTokens / 2, reasoningOutputTokens: outputTokens / 2 },
  } },
});
describe('durable ephemeral Codex thread usage', () => {
  it('writes once per native thread, including late helper usage, without content or invented requests', async () => {
    const h = fixture(); await h.start();
    await h.send([update('root-1', 100, 20),
      { method: 'thread/started', params: { thread: { id: 'child' } } }, update('child', 40, 10)]);
    h.notify(update('child', 60, 20)); h.notify(update('child', 60, 20));
    const compact: AppServerNotification = { method: 'item/completed', params: { threadId: 'root-1', turnId: 'compact-turn', item: { id: 'compact', type: 'contextCompaction' } } };
    h.notify(compact); h.notify(compact);
    h.notify({ method: 'thread/compacted', params: { threadId: 'root-1', turnId: 'compact-turn' } });
    await h.adapter.terminate(false); await h.adapter.terminate(false);
    expect(h.lines()).toHaveLength(1);
    expect(h.lines()[0]).toMatchObject({ threadId: 'root-1', jobId: 'job-example', instanceId: 'instance-example',
      kind: 'plan-queue', trialArm: 'cheaper', requests: null, requestsAvailable: false,
      tokens: { input: 100, cache: 50, output: 20, reasoning: 10, total: 120 },
      helpers: { count: 1, tokens: { input: 60, output: 20, total: 80 } }, compactions: 1,
    });
    expect(h.lines()[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(h.file, 'utf8')).not.toContain('DO_NOT_RECORD');
    expect(h.access.usageAccounting.ownsThread('child')).toBe(false);
  });
  it('finishes replaced and exited threads separately and never charges the old helpers again', async () => {
    const h = fixture(); await h.start(); await h.send([update('root-1', 100, 20)]);
    await h.reopen(); await h.send([update('root-2', 30, 10)]); h.exit();
    await vi.waitFor(() => expect(h.lines()).toHaveLength(2));
    await h.adapter.terminate(false);
    expect(h.lines().map(line => [line.threadId, line.tokens.total])).toEqual([['root-1', 120], ['root-2', 40]]);
  });
  it.each(['failed', 'interrupted'])('saves partial usage from a %s native turn exactly once when the thread stops', async status => {
    const h = fixture(); await h.start();
    const pending = h.send([update('root-1', 100, 20), { method: 'turn/completed', params: { threadId: 'root-1', turn: { id: 'turn-1', status } } }]);
    if (status === 'failed') await expect(pending).rejects.toThrow('Codex turn failed'); else await pending;
    await h.adapter.terminate(false); h.exit(); await Promise.resolve();
    expect(h.lines()).toHaveLength(1); expect(h.lines()[0].tokens.total).toBe(120);
  });
  it('subtracts already recorded helper usage when a replacement thread sees the same native helper', async () => {
    const h = fixture(); await h.start();
    const child: AppServerNotification = { method: 'thread/started', params: { thread: { id: 'child' } } };
    await h.send([update('root-1', 100, 20), child, update('child', 40, 10)]);
    await h.reopen(); await h.send([update('root-2', 20, 10), child, update('child', 60, 20)]);
    await h.adapter.terminate(false);
    expect(h.lines().map(line => line.helpers.tokens.total)).toEqual([50, 30]);
  });
  it('counts completed compaction items once without turn ids and ignores interrupted compactions', async () => {
    const h = fixture(); await h.start();
    const params = { threadId: 'root-1', item: { id: 'compact-no-turn', type: 'contextCompaction' } };
    h.notify({ method: 'item/started', params }); h.notify({ method: 'item/completed', params });
    h.notify({ method: 'item/completed', params });
    h.notify({ method: 'thread/compacted', params: { threadId: 'root-1' } });
    h.notify({ method: 'item/started', params: { ...params, turnId: 'aborted', item: { id: 'aborted-item', type: 'contextCompaction' } } });
    h.notify({ method: 'turn/completed', params: { threadId: 'root-1', turn: { id: 'aborted', status: 'interrupted' } } });
    await h.adapter.terminate(false);
    expect(h.lines()[0].compactions).toBe(1);
  });
  it('finishes a native thread created by an abandoned initialization', async () => {
    const h = fixture(); await h.access.initAppServerMode(-1); await h.adapter.terminate(false);
    expect(h.lines()).toHaveLength(1);
    expect(h.lines()[0]).toMatchObject({threadId:'root-1',finishReason:'abandoned',tokens:{total:null}});
  });
  it('retains a complete final numeric event without a newline on exec cancellation', async () => {
    const h = fixture(); const child = createMockProcess(); h.access.spawnProcess = () => child;
    const controller = new AbortController();
    const pending = h.adapter.sendMessage({role:'user',content:'DO_NOT_RECORD'}, {signal:controller.signal});
    const settled = pending.catch(error => error);
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    child.stdout.write(JSON.stringify({type:'thread.started',thread_id:'exec-tail'}) + '\n');
    child.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2}}));
    controller.abort();
    await settled;
    expect(h.lines()).toMatchObject([{threadId:'exec-tail',tokens:{input:10,output:2,total:12}}]);
  });
  it('saves a thread whose resident process exits during an active turn', async () => {
    const h = fixture(); await h.start();
    await expect(h.sendAndExit([update('root-1',100,20)])).rejects.toThrow('exited');
    await h.adapter.terminate(false);
    expect(h.lines()).toHaveLength(1);
    expect(h.lines()[0]).toMatchObject({threadId:'root-1',finishReason:'runtime-exit',tokens:{total:120}});
    expect(h.access.usageAccounting.ownsThread('root-1')).toBe(false);
  });
  it('writes one thread receipt after multiple native user turns, rather than one receipt per turn', async () => {
    const h = fixture(); await h.start();
    await h.send([update('root-1',100,20)]); await h.send([update('root-1',150,30)]);
    expect(h.lines()).toEqual([]);
    await h.adapter.terminate(false);
    expect(h.lines()).toHaveLength(1);
    expect(h.lines()[0]).toMatchObject({tokens:{input:150,output:30,total:180},requests:null,requestsAvailable:false});
  });
  it('uses an available configured instance id when no tool environment was injected', async () => {
    const h = fixture(true, {env:{},browserGatewayInstanceId:'configured-instance',sessionKind:'review',jobId:undefined,trialKey:undefined});
    await h.start(); await h.adapter.terminate(false);
    expect(h.lines()[0]).toMatchObject({instanceId:'configured-instance',jobId:null,trialKey:null});
  });
  it('records a stopped thread with no usage as unavailable and ignores durable chats', async () => {
    const h = fixture(); await h.start(); await h.adapter.terminate(false);
    expect(h.lines()[0]).toMatchObject({ tokens: { input: null, output: null, cache: null, reasoning: null, total: null } });
    const chat = fixture(false); await chat.start(); await chat.send([update('root-1', 10, 2)]); await chat.adapter.terminate(false);
    expect(chat.lines()).toEqual([]);
  });
  it.each([0, 1])('records exec native usage before successful or failed close (%s)', async code => {
    const h = fixture(); const child = createMockProcess(); h.access.spawnProcess = () => child;
    const pending = h.adapter.sendMessage({ role: 'user', content: 'DO_NOT_RECORD' });
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'exec-thread' }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 80, cached_input_tokens: 60, output_tokens: 10 } }) + '\n');
    child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DO_NOT_RECORD' } }) + '\n');
    child.emitClose(code);
    await pending; await h.adapter.terminate(false);
    expect(h.lines()).toHaveLength(1);
    expect(h.lines()[0]).toMatchObject({ threadId: 'exec-thread', requests: null, tokens: { input: 80, cache: 60, output: 10, reasoning: null, total: 90 } });
    expect(readFileSync(h.file, 'utf8')).not.toContain('DO_NOT_RECORD');
  });
});
