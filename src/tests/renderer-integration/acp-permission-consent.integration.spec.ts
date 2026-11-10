import { signal, ɵresolveComponentResources as resolveComponentResources, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: IpcHandler) => { handlers.set(channel, handler); }) },
  app: { getPath: () => '/tmp/test' },
}));
vi.mock('../../main/logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../main/core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: vi.fn(), getAll: vi.fn().mockReturnValue({}) }),
}));
vi.mock('../../main/commands/command-manager', () => ({
  getCommandManager: () => ({ executeCommand: vi.fn(), getCommands: vi.fn().mockReturnValue([]) }),
  CommandManager: vi.fn(),
}));
vi.mock('../../main/remote/observer-server', () => ({ getRemoteObserverServer: () => ({ clearPrompt: vi.fn() }) }));
vi.mock('../../main/security/self-permission-granter', () => ({ getSelfPermissionGranter: () => ({ grant: vi.fn() }) }));
vi.mock('../../main/pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));

import { IpcEventBusService, IpcFacadeService, InstanceIpcService } from '../../renderer/app/core/services/ipc';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { UserActionRequestComponent } from '../../renderer/app/features/instance-detail/user-action-request.component';
import { registerInstanceHandlers } from '../../main/ipc/handlers/instance-handlers';
import { createInitializedAgentHarness, TestAcpCliAdapter, type FakeAcpProcess } from '../../main/cli/adapters/acp-cli-adapter.test-helpers';
import { PermissionRegistry } from '../../main/orchestration/permission-registry';
import type { InstanceManager } from '../../main/instance/instance-manager';
import type { WindowManager } from '../../main/window-manager';
import type { AcpJsonRpcSuccessResponse, AcpPermissionOption } from '../../shared/types/cli.types';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';

const resources = new Map<string, string>();
for (const directory of ['src/renderer/app/features/instance-detail']) {
  for (const name of readdirSync(directory)) {
    if (name.endsWith('.html') || name.endsWith('.scss')) resources.set(name, readFileSync(resolve(directory, name), 'utf8'));
  }
}
await resolveComponentResources(url => {
  const name = url.split('/').pop() ?? '';
  const content = resources.get(name);
  if (content !== undefined) return Promise.resolve(content);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

const INSTANCE = 'inst-acp-consent';
const alwaysFirst: AcpPermissionOption[] = [
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
];

describe('ACP permission consent: card -> IPC -> adapter', () => {
  let fixture: ComponentFixture<UserActionRequestComponent>;
  let proc: FakeAcpProcess;
  let adapter: TestAcpCliAdapter;
  let currentInstanceId: WritableSignal<string | null>;
  let release: () => void;
  let turn: Promise<unknown>;
  const decisions: { requestId: string; granted: boolean; decidedBy: string }[] = [];
  const answers = new Map<number, Promise<AcpJsonRpcSuccessResponse>>();
  const ipcResults: { success: boolean; error?: { code?: string } }[] = [];

  const fakeInstanceStore = { getInstance: vi.fn(), clearPendingApprovals: vi.fn(), decrementPendingApproval: vi.fn() };

  async function start(options: AcpPermissionOption[], requestIds: number[] = [71]) {
    proc = createInitializedAgentHarness();
    const finished = new Promise<void>(resolveFinished => { release = resolveFinished; });
    proc.onRequest('session/prompt', async message => {
      for (const id of requestIds) {
        answers.set(id, proc.waitForMessage(m => 'id' in m && m.id === id && 'result' in m) as Promise<AcpJsonRpcSuccessResponse>);
        proc.request(id, 'session/request_permission', {
          sessionId: 'sess-acp-1',
          toolCall: { toolCallId: `call-${id}`, title: 'rm answer.txt', kind: 'execute' },
          options,
        });
      }
      await finished;
      proc.respond(message.id, { stopReason: 'end_turn' });
    });
    adapter = new TestAcpCliAdapter(proc, {
      workingDirectory: '/tmp',
      permissionRegistry: PermissionRegistry.getInstance(),
      permissionContext: { instanceId: INSTANCE },
    });
    adapter.on('input_required', (payload: { id: string; prompt: string; timestamp: number; metadata: Record<string, unknown> }) => {
      onInputRequired({ instanceId: INSTANCE, requestId: payload.id, prompt: payload.prompt, timestamp: payload.timestamp, metadata: payload.metadata });
    });
    await adapter.spawn();
    turn = adapter.sendMessage({ role: 'user', content: 'delete it' });
    await vi.waitFor(() => expect(fixture.componentInstance.pendingRequests()).toHaveLength(requestIds.length));
    fixture.detectChanges();
  }

  let onInputRequired: (payload: { instanceId: string; requestId: string; prompt: string; timestamp: number; metadata?: Record<string, unknown> }) => void;

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
      await Promise.resolve();
      fixture.detectChanges();
    }
  };
  const cards = () => Array.from(fixture.nativeElement.querySelectorAll('.request-card') as NodeListOf<HTMLElement>);
  const buttonIn = (card: HTMLElement, text: string) =>
    Array.from(card.querySelectorAll('button')).find(button => button.textContent?.trim() === text) as HTMLButtonElement;
  const typeAndSubmit = async (card: HTMLElement, text: string) => {
    const box = card.querySelector('textarea') as HTMLTextAreaElement;
    box.value = text;
    box.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    buttonIn(card, 'Submit').click();
    await settle();
  };
  const outcomeOf = async (id: number) => (await answers.get(id))!.result;
  const grantedFor = (key: string) => decisions.filter(d => d.requestId === `${INSTANCE}:acp_permission:${key}`).map(d => d.granted);

  beforeEach(async () => {
    PermissionRegistry._resetForTesting();
    handlers.clear();
    decisions.length = 0;
    answers.clear();
    ipcResults.length = 0;
    PermissionRegistry.getInstance().on('permission:resolved', decision => decisions.push(decision));

    const instanceManager = {
      sendInputResponse: vi.fn((_id: string, response: string, key?: string) => adapter.sendRaw(response, key)),
      recordInputRequiredPermissionDecision: vi.fn(),
      clearPendingInputRequiredPermission: vi.fn(),
      getRequestReceipts: () => ({ beginReply: () => ({ commit: () => true, abort: () => undefined }) }),
    } as unknown as InstanceManager;
    registerInstanceHandlers({ instanceManager, windowManager: {} as WindowManager });

    // Mirrors the preload bridge: positional arguments become one INPUT_REQUIRED_RESPOND payload.
    const fakeIpc = {
      listUserActionRequests: vi.fn().mockResolvedValue({ success: true, data: [] }),
      listUserActionRequestsForInstance: vi.fn().mockResolvedValue({ success: true, data: [] }),
      onUserActionRequest: vi.fn(() => vi.fn()),
      onInputRequired: vi.fn((callback: typeof onInputRequired) => { onInputRequired = callback; return vi.fn(); }),
      onInputRequiredResolved: vi.fn(() => vi.fn()),
      onInstanceRemoved: () => () => undefined,
      onInstanceStateUpdate: () => () => undefined,
      onBatchUpdate: () => () => undefined,
      respondToInputRequired: vi.fn(async (instanceId, requestId, response, permissionKey, decisionAction, decisionScope, metadata, updatedInput) => {
        const result = await handlers.get(IPC_CHANNELS.INPUT_REQUIRED_RESPOND)!({}, {
          instanceId, requestId, response, permissionKey, decisionAction, decisionScope, metadata, updatedInput,
        }) as { success: boolean; error?: { code?: string } };
        ipcResults.push(result);
        return result;
      }),
    };
    currentInstanceId = signal<string | null>(INSTANCE);
    await TestBed.configureTestingModule({
      imports: [UserActionRequestComponent],
      providers: [
        { provide: IpcFacadeService, useValue: fakeIpc },
        { provide: InstanceIpcService, useValue: fakeIpc },
        { provide: InstanceStore, useValue: fakeInstanceStore },
      ],
    }).compileComponents();
    // The card reads runtime asks from the event bus, which InstanceStore subscribes at startup.
    TestBed.inject(IpcEventBusService).inputRequired$.subscribe();
    fixture = TestBed.createComponent(UserActionRequestComponent);
    (fixture.componentInstance as unknown as { instanceId: () => string | null }).instanceId = currentInstanceId;
    fixture.detectChanges();
    await settle();
  });

  afterEach(async () => {
    release?.();
    await turn?.catch(() => undefined);
    fixture?.destroy();
    TestBed.resetTestingModule();
    proc?.exit();
    PermissionRegistry._resetForTesting();
  });

  // The full reply and label tables live in acp-permission-outcome.spec.ts, which calls
  // selectAcpPermissionOutcome directly. These tables keep enough rows to prove each outcome and
  // input shape through the real card, IPC handler, adapter and registry, plus every reply the
  // unit spec does not have.
  it.each([
    'what does this do?',
    'maybe',
    'the docs say allow is dangerous',
    'yes if the command is safe',
    'allow only after I review it',
    'once?',
    'Always allow?',
  ])('never grants permission for the typed question or ambiguous reply %j', async reply => {
    await start(alwaysFirst);
    await typeAndSubmit(cards()[0], reply);

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([false]);
  });

  it('answers a question with a cancelled outcome and no grant when the agent offers no refusal', async () => {
    await start([{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }]);
    await typeAndSubmit(cards()[0], 'please explain');

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(grantedFor('71')).toEqual([false]);
  });

  it('does not treat a request routing key as consent when an option id equals the rpc id', async () => {
    await start([{ optionId: '71', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }]);
    await typeAndSubmit(cards()[0], 'please explain');
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([false]);
  });

  it('still accepts an explicitly selected option whose id equals the request rpc id', async () => {
    await start([{ optionId: '71', name: 'Always allow', kind: 'allow_always' }]);
    buttonIn(cards()[0], 'Always allow').click(); await settle();
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: '71' } });
    expect(grantedFor('71')).toEqual([true]);
  });

  it('keeps ordinary assent as a one-time allow and ordinary refusal as a refusal', async () => {
    await start(alwaysFirst, [71, 72]);
    await typeAndSubmit(cards()[0], 'yes');
    await typeAndSubmit(cards()[0], 'no');

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([true]);
    expect(grantedFor('72')).toEqual([false]);
  });

  it('sends the advertised option id from the agent button, including a lasting one', async () => {
    await start(alwaysFirst, [71, 72]);
    buttonIn(cards()[0], 'Always allow').click();
    await settle();
    buttonIn(cards()[0], 'Always reject').click();
    await settle();

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-always' } });
    expect(grantedFor('71')).toEqual([true]);
    expect(grantedFor('72')).toEqual([false]);
  });

  it('reads an exact typed option id or label as that choice', async () => {
    await start(alwaysFirst, [71, 72]);
    await typeAndSubmit(cards()[0], 'always');
    await typeAndSubmit(cards()[0], 'Allow once');

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'always' } });
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'once' } });
  });

  it('honours exact advertised labels that include words from refusal or question heuristics', async () => {
    await start([
      { optionId: 'remember', name: "Yes, and don't ask again", kind: 'allow_always' },
      { optionId: 'review', name: 'Review first', kind: 'other' },
      { optionId: 'never', name: 'Never ask again', kind: 'reject_always' },
      { optionId: 'later', name: 'Not now', kind: 'other' },
      { optionId: 'explain', name: 'Stop and explain', kind: 'other' },
      ...alwaysFirst,
    ], [71, 72, 73, 74, 75]);
    await typeAndSubmit(cards()[0], "Yes, and don't ask again");
    await typeAndSubmit(cards()[0], 'Review first');
    await typeAndSubmit(cards()[0], 'Never ask again');
    await typeAndSubmit(cards()[0], 'Not now');
    await typeAndSubmit(cards()[0], 'Stop and explain');
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'remember' } });
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'review' } });
    expect(await outcomeOf(73)).toEqual({ outcome: { outcome: 'selected', optionId: 'never' } });
    expect(await outcomeOf(74)).toEqual({ outcome: { outcome: 'selected', optionId: 'later' } });
    expect(await outcomeOf(75)).toEqual({ outcome: { outcome: 'selected', optionId: 'explain' } });
    expect(grantedFor('71')).toEqual([true]);
    expect(grantedFor('72')).toEqual([false]);
    expect(grantedFor('73')).toEqual([false]);
    expect(grantedFor('74')).toEqual([false]);
    expect(grantedFor('75')).toEqual([false]);
  });

  it('Cancel answers cancelled without a grant', async () => {
    await start(alwaysFirst);
    buttonIn(cards()[0], 'Cancel').click();
    await settle();

    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(grantedFor('71')).toEqual([false]);
  });

  it.each([
    ['What does this do', 'allow_once'],
    ['Allow, please explain', 'allow_always'],
    ['I do not consent', 'allow_once'],
    ['I shouldn’t approve this', 'allow_once'],
    ['Allow\nWhat will happen', 'allow_once'],
    // The unit spec's own "Allow once" control makes its row a duplicate label; only this row
    // reaches the one-time wording check on a lasting label.
    ['Allow once', 'allow_always'],
  ] as const)('never grants for the typed label %j but honours an explicit click', async (name, kind) => {
    const controls = alwaysFirst.filter(option => option.name !== name);
    await start([{ optionId: 'contradictory-label', name, kind }, ...controls], [71, 72]);
    await typeAndSubmit(cards()[0], name);
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([false]);

    buttonIn(cards()[0], name).click(); await settle();
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'contradictory-label' } });
    expect(grantedFor('72')).toEqual([true]);
  });

  it('answers only the card that was used and reports an already-answered card as stale', async () => {
    await start(alwaysFirst, [71, 72]);
    await typeAndSubmit(cards()[1], 'please explain');

    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([]);
    expect(grantedFor('72')).toEqual([false]);

    const stale = await handlers.get(IPC_CHANNELS.INPUT_REQUIRED_RESPOND)!({}, {
      instanceId: INSTANCE, requestId: 'acp_permission:72', response: 'yes', permissionKey: 'acp_permission:72',
    }) as { success: boolean; error?: { code?: string } };
    expect(stale.success).toBe(false);
    expect(stale.error?.code).toBe('INPUT_REQUIRED_NOT_PENDING');
    expect(grantedFor('72')).toEqual([false]);
    expect(grantedFor('71')).toEqual([]);
  });

  it.each([
    ['allow_if_safe', 'Use the advertised approval', 'Allow if safe'],
    ['limited', 'Allow one time', 'Allow one time'],
  ])('never grants for prose resembling option id %j, but honours that exact id', async (optionId, name, response) => {
    await start([{ optionId, name, kind: 'allow_always' }, ...alwaysFirst], [71, 72]);
    await typeAndSubmit(cards()[0], response);
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    expect(grantedFor('71')).toEqual([false]);
    buttonIn(cards()[0], name).click(); await settle();
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(grantedFor('72')).toEqual([true]);
  });

  it.each(['cancel', ' spaced '])('distinguishes the Cancel control from advertised option ID %j', async optionId => {
    await start([{ optionId, name: 'Allow once', kind: 'allow_once' }], [71, 72]);
    buttonIn(cards()[0], 'Allow once').click(); await settle();
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(grantedFor('71')).toEqual([true]);
    buttonIn(cards()[0], 'Cancel').click(); await settle();
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(grantedFor('72')).toEqual([false]);
  });

  it('preserves a clearly advertised remembered choice scoped by the agent to this session', async () => {
    await start([{ optionId: 'for-session', name: 'Allow for this session', kind: 'allow_always' }, ...alwaysFirst]);
    await typeAndSubmit(cards()[0], 'Allow for this session');
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'for-session' } });
    expect(grantedFor('71')).toEqual([true]);
  });

  it('selects a neutral inability choice without recording an approval', async () => {
    await start([{ optionId: 'unavailable', name: 'Unable to verify this', kind: 'other' }, ...alwaysFirst]);
    await typeAndSubmit(cards()[0], 'Unable to verify this');
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'unavailable' } });
    expect(grantedFor('71')).toEqual([false]);
  });

  it.each([
    ['if-safe', 'Allow if safe'],
    ['after-tests-leading', 'When tests pass, allow this operation'],
    ['unable-condition', 'Allow if I am unable to run tests'],
  ])('preserves the agent-offered scoped choice %j through the real card and registry', async (optionId, name) => {
    await start([{ optionId, name, kind: 'allow_always' }, ...alwaysFirst]);
    await typeAndSubmit(cards()[0], name);
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(grantedFor('71')).toEqual([true]);
  });

  it.each(['Allow'])('rejects an ambiguous duplicate label %j without losing explicit ID selection', async name => {
    await start([
      { optionId: 'approve-choice', name, kind: 'allow_always' },
      { optionId: 'reject-choice', name, kind: 'reject_once' },
    ], [71, 72]);
    await typeAndSubmit(cards()[0], name);
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-choice' } });
    expect(grantedFor('71')).toEqual([false]);
    await typeAndSubmit(cards()[0], 'approve-choice');
    expect(await outcomeOf(72)).toEqual({ outcome: { outcome: 'selected', optionId: 'approve-choice' } });
    expect(grantedFor('72')).toEqual([true]);
  });

  it.each(['Allow if safe', 'Allow for this session'])(
    'does not invent an unoffered permission scope from %j', async response => {
      await start(alwaysFirst);
      await typeAndSubmit(cards()[0], response);
      expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
      expect(grantedFor('71')).toEqual([false]);
    },
  );

  it.each([
    ['I approve this', 'once', true],
    ['I always approve this', 'always', true],
    ['I might approve this', 'reject-once', false],
    ['I do not approve this', 'reject-once', false],
  ])('handles the first-person reply %j through the actual card and registry', async (reply, optionId, granted) => {
    await start(alwaysFirst);
    await typeAndSubmit(cards()[0], reply);
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId } });
    expect(grantedFor('71')).toEqual([granted]);
  });

  it('preserves a typed opaque option ID byte for byte', async () => {
    await start([{ optionId: ' spaced ', name: 'Allow once', kind: 'allow_once' }]);
    await typeAndSubmit(cards()[0], ' spaced ');
    expect(await outcomeOf(71)).toEqual({ outcome: { outcome: 'selected', optionId: ' spaced ' } });
    expect(grantedFor('71')).toEqual([true]);
  });
});
