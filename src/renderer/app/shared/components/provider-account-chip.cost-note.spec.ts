import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderAccountIpcService,
  type ProviderAccountView,
} from '../../core/services/ipc/provider-account-ipc.service';
import { RuntimeChangePreviewIpcService } from '../../core/services/ipc/runtime-change-preview-ipc.service';
import { defaultProviderAccountPools } from '../../../../shared/types/provider-account.types';
import { ProviderAccountChipComponent } from './provider-account-chip.component';
import { ConfirmService } from '../confirm/confirm.service';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import type { Instance } from '../../core/state/instance/instance.types';

const account = (overrides: Partial<ProviderAccountView>): ProviderAccountView => ({
  id: 'legacy', provider: 'claude', label: 'Max A', expectedIdentity: null, expectedAccountKey: null, planLabel: null,
  priority: 0, enabled: true, automationPolicy: 'allow-routed', isLegacy: true, createdAt: 1, updatedAt: 1, ...overrides,
});

const preview = vi.fn();
const switchSession = vi.fn(async () => ({ success: true }));
const acknowledgeOwnership = vi.fn(async () => ({ success: true }));
const update = vi.fn(async () => ({ success: true }));

describe('ProviderAccountChipComponent: the cost is said before the account move is confirmed', () => {
  beforeEach(async () => {
    preview.mockReset();
    switchSession.mockClear();
    acknowledgeOwnership.mockReset().mockResolvedValue({ success: true });
    update.mockReset().mockResolvedValue({ success: true });
    const pools = defaultProviderAccountPools();
    pools.claude = { ...pools.claude, acknowledgedOwnershipAt: 1 };
    const profiles = [account({}), account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false }),
      account({ id: 'account-c', label: 'Account C', priority: 2, isLegacy: false })];
    await TestBed.configureTestingModule({
      imports: [ProviderAccountChipComponent],
      providers: [
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn(async () => ({ profiles, pools })), previewRoute: vi.fn(async () => null), switchSession, acknowledgeOwnership, update } },
        { provide: RuntimeChangePreviewIpcService, useValue: { preview } },
      ],
    }).compileComponents();
  });

  afterEach(() => vi.unstubAllGlobals());

  async function moveToMaxB(): Promise<ReturnType<typeof vi.fn>> {
    // The chip asks through the app's confirm dialog; answer yes.
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ProviderAccountChipComponent);
    for (const [name, value] of Object.entries({ provider: 'claude', mode: 'session', instanceId: 'inst-1', accountProfileId: 'legacy' })) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'max-b-1a2b';
    await fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    return confirm;
  }

  it('adds the sentence to the question it already asks', async () => {
    preview.mockResolvedValue({
      kind: 'account', text: 'Switching account restarts this session, and the next message will re-read about 230K tokens at full price.',
      resendTokens: 230_000, carriedTokens: null, droppedTokens: null, large: true,
    });
    const confirm = await moveToMaxB();
    expect(preview).toHaveBeenCalledWith('inst-1', { accountProfileId: 'max-b-1a2b' });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(
      /Move this conversation to "Max B"\? The current session ends and the conversation continues on that account\. Switching account restarts this session, and the next message will re-read about 230K tokens at full price\.$/,
    ) }));
    expect(switchSession).toHaveBeenCalledWith('inst-1', 'max-b-1a2b');
  });

  it('asks the same question as before when the move costs nothing worth saying', async () => {
    preview.mockResolvedValue(null);
    const confirm = await moveToMaxB();
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Move this conversation to "Max B"? The current session ends and the conversation continues on that account.',
    }));
  });

  /** Starts a move to Max B whose cost preview never resolves until the test releases it. */
  async function holdMoveToMaxB(): Promise<{
    release: (text: string) => void;
    pending: Promise<void>;
    confirm: ReturnType<typeof vi.fn>;
    fixture: ComponentFixture<ProviderAccountChipComponent>;
  }> {
    let release!: (note: unknown) => void;
    preview.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    // The chip asks through the app's confirm dialog; answer yes.
    const confirm = vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ProviderAccountChipComponent);
    for (const [name, value] of Object.entries({ provider: 'claude', mode: 'session', instanceId: 'inst-1', accountProfileId: 'legacy' })) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }
    // The select and onSelect are started synchronously; the held preview parks the flow.
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'max-b-1a2b';
    const pending = fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    return {
      release: (text) => release({ kind: 'account', text, resendTokens: 230_000, carriedTokens: null, droppedTokens: null, large: true }),
      pending,
      confirm,
      fixture,
    };
  }

  it('drops a pending move when the conversation is replaced while its cost is being worked out', async () => {
    const move = await holdMoveToMaxB();
    move.fixture.componentRef.setInput('instanceId', 'inst-2');
    move.fixture.detectChanges();
    move.release('Switching account restarts this session.');
    await move.pending;
    expect(move.confirm).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('puts the dropdown back on the account the session is on when the conversation is replaced mid-move', async () => {
    const move = await holdMoveToMaxB();
    const select = move.fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('max-b-1a2b');
    move.fixture.componentRef.setInput('instanceId', 'inst-2');
    move.fixture.detectChanges();
    move.release('Switching account restarts this session.');
    await move.pending;
    expect(select.value).toBe('legacy');
  });

  it('leaves the dropdown on a newer pick when an older move is dropped', async () => {
    const move = await holdMoveToMaxB();
    preview.mockResolvedValueOnce(null);
    const select = move.fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'account-c';
    await move.fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    move.release('Old cost');
    await move.pending;
    expect(select.value).toBe('account-c');
  });

  it('drops a pending move when the chip goes away while its cost is being worked out', async () => {
    const move = await holdMoveToMaxB();
    move.fixture.destroy();
    move.release('Switching account restarts this session.');
    await move.pending;
    expect(move.confirm).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('still moves the conversation when nothing replaced it while the cost was worked out', async () => {
    const move = await holdMoveToMaxB();
    move.release('Switching account restarts this session.');
    await move.pending;
    expect(move.confirm).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledWith('inst-1', 'max-b-1a2b');
  });

  it('does not revive a pending move after the person selects the current account', async () => {
    const move = await holdMoveToMaxB();
    const select = move.fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'legacy';
    await move.fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    move.release('Old cost');
    await move.pending;
    expect(move.confirm).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });

  it('applies only the newest choice when previews resolve in the opposite order', async () => {
    const move = await holdMoveToMaxB();
    preview.mockResolvedValueOnce(null);
    const select = move.fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'account-c';
    await move.fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    move.release('Old cost');
    await move.pending;
    expect(move.confirm).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledExactlyOnceWith('inst-1', 'account-c');
  });

  function nativeSession(): Instance {
    return { id: 'inst-1', displayName: 'Session', createdAt: 1, historyThreadId: 'history', parentId: null,
      childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', accountProfileId: 'legacy',
      status: 'idle', contextUsage: { used: 230_000, total: 1_000_000, percentage: 23, occupancyReported: true },
      lastActivity: 1, sessionId: 'session-a', providerSessionId: 'native-a', restartEpoch: 0, adapterGeneration: 0,
      workingDirectory: '/tmp/account-cost-fixture', yoloMode: false, launchMode: 'interactive', outputBuffer: [] };
  }

  const replacements = {
    session: { sessionId: 'session-b' }, native: { providerSessionId: 'native-b' }, restart: { restartEpoch: 1 },
    adapter: { adapterGeneration: 1 }, account: { accountProfileId: 'account-c' }, model: { currentModel: 'other-model' },
    runtime: { runtimeSummary: { kind: 'local-model', label: 'Local', source: 'this-device', endpointProvider: 'ollama',
      endpointId: 'local-endpoint', modelId: 'local-model', selectorId: 'local-selector' } },
  } satisfies Record<string, Partial<Instance>>;

  it.each(Object.keys(replacements) as (keyof typeof replacements)[])(
    'drops the old preview after same-id %s replacement', async field => {
      const instances = TestBed.inject(InstanceStateService);
      instances.addInstance(nativeSession());
      const move = await holdMoveToMaxB();
      instances.updateInstance('inst-1', replacements[field]);
      move.fixture.detectChanges();
      move.release('Old cost');
      await move.pending;
      expect(move.confirm).not.toHaveBeenCalled();
      expect(switchSession).not.toHaveBeenCalled();
    },
  );

  it('keeps an ordinary move valid through busy and idle updates', async () => {
    const instances = TestBed.inject(InstanceStateService);
    instances.addInstance(nativeSession());
    const move = await holdMoveToMaxB();
    instances.updateInstance('inst-1', { status: 'busy' });
    move.fixture.detectChanges();
    instances.updateInstance('inst-1', { status: 'idle' });
    move.fixture.detectChanges();
    move.release('Current cost');
    await move.pending;
    expect(move.confirm).toHaveBeenCalledOnce();
    expect(switchSession).toHaveBeenCalledExactlyOnceWith('inst-1', 'max-b-1a2b');
  });

  it('does not enable an older chosen account after returning to the current account during ownership acknowledgement', async () => {
    const ipc = TestBed.inject(ProviderAccountIpcService);
    vi.mocked(ipc.list).mockResolvedValue({ pools: defaultProviderAccountPools(),
      profiles: [account({}), account({ id: 'max-b-1a2b', label: 'Max B', priority: 1, isLegacy: false, enabled: false })] });
    let acknowledge!: (result: { success: boolean }) => void;
    acknowledgeOwnership.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve; }));
    preview.mockResolvedValue(null);
    // The chip asks through the app's confirm dialog; answer yes.
    vi.spyOn(TestBed.inject(ConfirmService), 'confirm').mockResolvedValue(true);
    const fixture = TestBed.createComponent(ProviderAccountChipComponent);
    for (const [name, value] of Object.entries({ provider: 'claude', mode: 'session', instanceId: 'inst-1', accountProfileId: 'legacy' })) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'max-b-1a2b';
    const pending = fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    // The turn-on question is asked through the confirm dialog first, so the acknowledgement follows it.
    await vi.waitFor(() => expect(acknowledgeOwnership).toHaveBeenCalledOnce());
    select.value = 'legacy';
    await fixture.componentInstance.onSelect({ target: select } as unknown as Event);
    acknowledge({ success: true });
    await pending;
    expect(update).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(switchSession).not.toHaveBeenCalled();
  });
});
