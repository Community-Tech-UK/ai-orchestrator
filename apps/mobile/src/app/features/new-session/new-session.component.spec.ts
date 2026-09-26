import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NO_ERRORS_SCHEMA,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';
import { Preferences } from '@capacitor/preferences';
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import type { MobileQuotaStateDto, MobileSessionPlan } from '../../core/models';
import { VoiceInputService } from '../../core/voice-input.service';
import { NewSessionComponent } from './new-session.component';
import { UsageStore } from '../usage/usage.store';
import { MobileGatewayQuotaHandlers } from '../../../../../../src/main/mobile-gateway/mobile-gateway-quota-handlers';
import type { ProviderQuotaState } from '../../../../../../src/shared/types/provider-quota.types';

const NEW_SESSION_TEMPLATE = readFileSync(resolve('src/app/features/new-session/new-session.component.html'), 'utf8');

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: vi.fn(), set: vi.fn() } }));

await resolveComponentResources((url) => Promise.resolve(url.endsWith('new-session.component.html')
  ? readFileSync(resolve('src/app/features/new-session/new-session.component.html'), 'utf8') : ''));

const RESOLVED_PLAN: MobileSessionPlan = {
  provider: 'codex',
  providerLabel: 'Codex',
  model: 'gpt-5.6',
  modelLabel: 'GPT-5.6',
  reasoningEffort: 'high',
  reasoningEffortLabel: 'High',
};

function buttonContaining(root: HTMLElement, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.includes(text));
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button containing "${text}" was not rendered`);
  }
  return button;
}

describe('NewSessionComponent structure', () => {
  const source = readFileSync(
    resolve('src/app/features/new-session/new-session.component.ts'),
    'utf8',
  ) + readFileSync(resolve('src/app/features/new-session/new-session.component.html'), 'utf8');

  it('uses context selectors and one keyboard-anchored composer', () => {
    expect(source).toContain('class="session-context"');
    expect(source).toContain('class="new-session-composer"');
    expect(source).toContain('placeholder="Ask Harness"');
    expect(source).not.toContain('class="providers"');
    expect(source).not.toContain('class="cta"');
  });

  it('progressively discloses directory, settings, and attachment sheets', () => {
    expect(source).toContain('label="Working directory"');
    expect(source).toContain('label="Session settings"');
    expect(source).toContain('label="Add attachment"');
    expect(source).toContain('directorySheetOpen');
    expect(source).toContain('settingsSheetOpen');
    expect(source).toContain('attachmentSheetOpen');
  });

  it('keeps errors next to the composer and starts through form submission', () => {
    expect(source).toContain('role="alert"');
    expect(source).toContain('(submit)="create($event)"');
    expect(source).toContain('buildCreateInstanceRequest');
  });

  it('wires reasoning effort into the model sheet and session request', () => {
    expect(source).toContain('[reasoningOptions]="reasoningOptions()"');
    expect(source).toContain('[selectedReasoning]="reasoningEffort()"');
    expect(source).toContain('(chooseReasoning)="chooseReasoningEffort($event)"');
    expect(source).toContain('reasoningEffort: this.reasoningEffort()');
  });
});

describe('NewSessionComponent provider settings', () => {
  it('continues with the selected provider without forcing a model choice', async () => {
    const tap = vi.fn();
    TestBed.overrideComponent(NewSessionComponent, {
      set: {
        template: NEW_SESSION_TEMPLATE, templateUrl: undefined,
        imports: [FormsModule],
        schemas: [NO_ERRORS_SCHEMA],
        styleUrls: [],
      },
    });
    await TestBed.configureTestingModule({
      imports: [NewSessionComponent],
      providers: [
        {
          provide: GatewayClient,
          useValue: {
            online: signal(true),
            state: signal('connected'),
            snapshot: signal(null),
            recentDirs: vi.fn().mockResolvedValue([]),
            sessionPlan: vi.fn().mockResolvedValue(RESOLVED_PLAN),
          },
        },
        { provide: UsageStore, useValue: { isExhausted: () => false } },
        { provide: HostStore, useValue: { activeHost: signal(null) } },
        {
          provide: ImageAttachmentService,
          useValue: { available: false },
        },
        {
          provide: DraftStore,
          useValue: {
            loadNewSession: vi.fn().mockResolvedValue(null),
            saveNewSession: vi.fn(),
            clearNewSession: vi.fn(), claimNewSession: vi.fn(() => Symbol()), completeNewSession: vi.fn().mockResolvedValue(true), recoverLegacyNewSession: vi.fn().mockResolvedValue(true),
            load: vi.fn().mockResolvedValue(''),
            save: vi.fn(),
            clear: vi.fn(),
          },
        },
        {
          provide: HapticsService,
          useValue: { tap, success: vi.fn(), error: vi.fn() },
        },
        {
          provide: VoiceInputService,
          useValue: {
            available: false,
            listening: signal(false),
            text: signal(''),
            stop: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => null } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(NewSessionComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    fixture.nativeElement.querySelector('button[aria-label="Session settings"]').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).not.toBeNull();
    buttonContaining(fixture.nativeElement, 'Run with Codex').click();
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-model-sheet')).toBeNull();

    const continueButton = fixture.nativeElement.querySelector<HTMLButtonElement>(
      'button[aria-label="Continue with selected provider"]',
    );
    if (!(continueButton instanceof HTMLButtonElement)) {
      throw new Error('Continue with selected provider was not rendered');
    }

    continueButton.click();
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('app-mobile-sheet[label="Session settings"]'),
    ).toBeNull();
    expect(fixture.nativeElement.querySelector('app-model-sheet')).toBeNull();
    expect(fixture.nativeElement.querySelector('button[aria-label="Session settings"]').textContent).toContain('Codex');
    expect(tap).toHaveBeenCalledTimes(2);
  });
});


async function setupSession(options: { quota?: () => MobileQuotaStateDto; recentDirs?: ReturnType<typeof vi.fn>; createInstance?: ReturnType<typeof vi.fn>; draft?: string; draftLoad?: ReturnType<typeof vi.fn>; beforeReady?: (root: HTMLElement) => void; realDrafts?: DraftStore; hostId?: string; navigationState?: unknown; legacyText?: string; historyReentry?: boolean } = {}) {
  const gateway = {
    online: signal(true), state: signal('connected'), snapshot: signal(null),
    dataHostId: signal(options.hostId ?? 'host-a'), quotaEvent: signal<{ hostId: string; data: MobileQuotaStateDto } | null>(null),
    quota: vi.fn().mockImplementation(async () => options.quota?.()),
    recentDirs: options.recentDirs ?? vi.fn().mockResolvedValue([{ path: '/work/b', displayName: 'Project B', lastAccessed: 0, isPinned: false }]),
    sessionPlan: vi.fn().mockResolvedValue(RESOLVED_PLAN),
    models: vi.fn().mockResolvedValue({ codex: [] }),
    createInstance: options.createInstance ?? vi.fn().mockResolvedValue({ id: 'created', workingDirectory: '/work/b' }),
  };
  const drafts = { load: vi.fn().mockResolvedValue(options.legacyText ?? ''), save: vi.fn(), clear: vi.fn(),
    loadNewSession: options.draftLoad ?? vi.fn().mockResolvedValue(options.draft ? JSON.parse(options.draft) : null), saveNewSession: vi.fn(), clearNewSession: vi.fn(), claimNewSession: vi.fn(() => Symbol()), completeNewSession: vi.fn().mockResolvedValue(true), recoverLegacyNewSession: vi.fn().mockResolvedValue(true), attachments: vi.fn().mockReturnValue([]), saveAttachments: vi.fn() };
  const images = { available: true, pickImages: vi.fn().mockRejectedValue(new Error('Photo permission denied')), pasteImageFromClipboard: vi.fn().mockResolvedValue(null) };
  const voice = { available: true, listening: signal(false), text: signal(''), start: vi.fn().mockResolvedValue(false), stop: vi.fn().mockResolvedValue(undefined) };
  const activeHost = signal({ id: options.hostId ?? 'host-a', name: 'Host A' });
  const exhaustedProvider = signal<string | null>(null);
  const usage = { isExhausted: (provider: string) => activeHost().id === 'host-a' && provider === exhaustedProvider() };
  TestBed.overrideComponent(NewSessionComponent, { set: { template: NEW_SESSION_TEMPLATE, templateUrl: undefined, imports: [FormsModule], schemas: [NO_ERRORS_SCHEMA], styleUrls: [] } });
  await TestBed.configureTestingModule({ imports: [NewSessionComponent], providers: [
    { provide: GatewayClient, useValue: gateway },
    options.quota ? UsageStore : { provide: UsageStore, useValue: usage },
    { provide: HostStore, useValue: { activeHost } },
    { provide: DraftStore, useValue: options.realDrafts ?? drafts }, { provide: ImageAttachmentService, useValue: images },
    { provide: VoiceInputService, useValue: voice },
    { provide: HapticsService, useValue: { tap: vi.fn(), success: vi.fn(), error: vi.fn() } },
    { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => options.historyReentry ? null : ({ extras: { state: options.navigationState ?? { mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/a' } } } }) } },
  ] }).compileComponents();
  const fixture = TestBed.createComponent(NewSessionComponent);
  Object.defineProperty(fixture.componentInstance, 'dir', { value: signal('/work/a') });
  fixture.detectChanges();
  await Promise.resolve();
  fixture.detectChanges();
  options.beforeReady?.(fixture.nativeElement as HTMLElement);
  await fixture.whenStable(); fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  const settle = async () => { fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); };
  const type = (text: string) => { const area = root.querySelector('textarea')!; area.value = text; area.dispatchEvent(new Event('input')); fixture.detectChanges(); };
  return { fixture, root, gateway, drafts, images, voice, activeHost, exhaustedProvider, settle, type };
}

describe('New Session folder and submission behavior', () => {
  it('never warns for a full Claude plan with unknown credits through the real projection and usage store', async () => {
    const now = Date.now();
    const state: ProviderQuotaState = { snapshots: { claude: {
      provider: 'claude', takenAt: now, source: 'admin-api', ok: true,
      usageAccess: { ordinaryUsageAllowed: false, creditsAvailable: null },
      windows: [{ id: 'claude.5h', label: '5 hours', kind: 'rolling-window', unit: 'messages', used: 100, limit: 100, remaining: 0, resetsAt: now + 3_600_000 }],
    }, codex: null, gemini: null, antigravity: null, copilot: null, cursor: null, grok: null, opencode: null } };
    const handler = new MobileGatewayQuotaHandlers({ getSource: () => ({ getAll: () => state, on: vi.fn(), removeListener: vi.fn() }), broadcast: vi.fn(), sendExhaustedPush: vi.fn() });
    const { root, gateway, settle } = await setupSession({ quota: () => handler.read() });
    root.querySelector<HTMLButtonElement>('[aria-label="Session settings"]')!.click(); await settle();
    buttonContaining(root, 'Run with Claude').click(); await settle();
    expect(TestBed.inject(UsageStore).providers().find(provider => provider.provider === 'claude')?.windows[0].percentUsed).toBe(100);
    expect(root.querySelector('[data-testid="quota-warning"]')).toBeNull();
    state.snapshots.claude!.usageAccess!.creditsAvailable = false;
    gateway.quotaEvent.set({ hostId: 'host-a', data: handler.read() }); await settle();
    expect(root.querySelector('[data-testid="quota-warning"]')?.textContent).toContain('Claude');
    state.snapshots.claude!.usageAccess!.creditsAvailable = null;
    gateway.quotaEvent.set({ hostId: 'host-a', data: handler.read() }); await settle();
    expect(root.querySelector('[data-testid="quota-warning"]')).toBeNull();
  });
  it('warns only for the chosen exhausted provider and removes the chip on provider or host switch', async () => {
    const { root, fixture, exhaustedProvider, activeHost, settle } = await setupSession();
    exhaustedProvider.set('codex'); await settle();
    expect(root.querySelector('[data-testid="quota-warning"]')?.textContent).toContain('Codex');
    root.querySelector<HTMLButtonElement>('[aria-label="Session settings"]')!.click(); await settle();
    buttonContaining(root, 'Run with Claude').click(); await settle();
    expect(root.querySelector('[data-testid="quota-warning"]')).toBeNull();
    buttonContaining(root, 'Run with Codex').click(); await settle();
    expect(root.querySelector('[data-testid="quota-warning"]')).not.toBeNull();
    activeHost.set({ id: 'host-b', name: 'Host B' }); fixture.detectChanges();
    expect(root.querySelector('[data-testid="quota-warning"]')).toBeNull();
  });
  it('loads recent B when opening project A chooser and starts B with the preserved prompt', async () => {
    const { root, gateway, settle, type } = await setupSession();
    type('Keep this draft');
    buttonContaining(root, '/work/a').click(); await settle();
    buttonContaining(root, 'Project B').click(); await settle();
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); await settle();
    expect(gateway.createInstance).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: '/work/b', initialPrompt: 'Keep this draft' }));
  });

  it('retains the clicked folder control as the sheet focus-return target while loading', async () => {
    let finish!: (value: unknown[]) => void;
    const recentDirs = vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const { root, fixture, settle } = await setupSession({ recentDirs });
    const opener = buttonContaining(root, '/work/a');
    opener.focus(); opener.click(); opener.blur(); fixture.detectChanges();
    const sheet = root.querySelector('app-mobile-sheet[label="Working directory"]') as unknown as { returnFocusTo: HTMLElement };
    expect(sheet.returnFocusTo).toBe(opener);
    expect(opener.disabled).toBe(false);
    finish([]); await settle();
  });

  it('does not invent a focus-return target when the folder sheet opens automatically', async () => {
    const { root, fixture, settle } = await setupSession();
    await (fixture.componentInstance as unknown as { openDirectorySheet(): Promise<void> }).openDirectorySheet();
    await settle();
    const sheet = root.querySelector('app-mobile-sheet[label="Working directory"]') as unknown as { returnFocusTo: HTMLElement | null };
    expect(sheet.returnFocusTo).toBeNull();
  });

  it('keeps A selected after directory failure and offers a successful retry', async () => {
    const recentDirs = vi.fn().mockRejectedValueOnce(new Error('Directories unavailable')).mockResolvedValue([{ path: '/work/b', displayName: 'Project B', lastAccessed: 0, isPinned: false }]);
    const { root, settle, gateway } = await setupSession({ recentDirs });
    buttonContaining(root, '/work/a').click(); await settle();
    expect(root.textContent).toContain('Directories unavailable');
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
    buttonContaining(root, 'Retry').click(); await settle();
    expect(root.textContent).toContain('Project B');
    expect(gateway.recentDirs).toHaveBeenCalledTimes(2);
  });

  it('keeps model and reasoning changes in one open visit', async () => {
    const { fixture, root, settle } = await setupSession();
    const component = fixture.componentInstance as unknown as { selectProvider(value: 'codex'): void; openModelSheet(): Promise<void>; chooseModel(value: string): void; chooseReasoningEffort(value: 'high'): void };
    component.selectProvider('codex'); await component.openModelSheet(); await settle();
    component.chooseModel('example-model'); component.chooseReasoningEffort('high'); await settle();
    expect(root.querySelector('app-model-sheet')).not.toBeNull();
  });

  it('shows Starting, then preserves the draft and selections when Start fails', async () => {
    let rejectStart!: (reason: Error) => void;
    const createInstance = vi.fn().mockImplementation(() => new Promise((_, reject) => { rejectStart = reject; }));
    const { root, fixture, settle, type, drafts } = await setupSession({ createInstance });
    type('Retry my prompt');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true })); fixture.detectChanges();
    expect(root.textContent).toContain('Starting');
    rejectStart(new Error('Start failed')); await settle();
    expect(root.querySelector('textarea')!.value).toBe('Retry my prompt');
    expect(root.textContent).toContain('/work/a'); expect(root.textContent).toContain('Start failed');
    expect(drafts.clearNewSession).not.toHaveBeenCalled();
  });

  it('restores this host configuration while project-origin directory wins', async () => {
    const { root, drafts } = await setupSession({ draft: JSON.stringify({ text: 'Saved draft', directory: '/work/older', provider: 'codex', model: 'example-model', reasoningEffort: 'high' }) });
    expect(root.querySelector('textarea')!.value).toBe('Saved draft');
    expect(root.textContent).toContain('/work/a');
    expect(root.querySelector('button[aria-label="Session settings"]')!.textContent).toContain('Codex');
    expect(drafts.loadNewSession).toHaveBeenCalledWith('host-a');
    expect(drafts.saveNewSession).toHaveBeenLastCalledWith('host-a', expect.objectContaining({ directory: '/work/a', model: 'example-model' }), expect.any(Symbol));
  });

  it('preserves both new typing and saved text when draft storage finishes loading', async () => {
    let restore!: (value: unknown) => void;
    const draftLoad = vi.fn().mockImplementation(() => new Promise((resolve) => { restore = resolve; }));
    const { root, drafts } = await setupSession({ draftLoad, beforeReady: (element) => {
      const area = element.querySelector('textarea')!;
      area.value = 'New typing'; area.dispatchEvent(new Event('input'));
      restore({ text: 'Older saved draft', directory: '/work/a', provider: 'auto' });
    } });
    expect(root.querySelector('textarea')!.value).toBe('New typing\n\nOlder saved draft');
    expect(drafts.saveNewSession).toHaveBeenLastCalledWith('host-a', expect.objectContaining({ text: 'New typing\n\nOlder saved draft' }), expect.any(Symbol));
  });

  it('cannot submit the old host draft after the active host changes', async () => {
    const { root, fixture, activeHost, gateway } = await setupSession();
    activeHost.set({ id: 'host-b', name: 'Host B' }); fixture.detectChanges();
    expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(gateway.createInstance).not.toHaveBeenCalled();
  });


  it('preserves a recreated component draft when an old create acknowledgement arrives', async () => {
    vi.spyOn(Preferences, 'get').mockResolvedValue({ value: null });
    vi.spyOn(Preferences, 'set').mockResolvedValue();
    const store = new DraftStore();
    let acknowledge!: (value: unknown) => void;
    const createInstance = vi.fn().mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
    const { fixture, root, type } = await setupSession({ realDrafts: store, createInstance });
    await vi.waitFor(() => { fixture.detectChanges(); expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false); });
    type('Old submitted draft');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.destroy();
    const replacement = TestBed.createComponent(NewSessionComponent);
    Object.defineProperty(replacement.componentInstance, 'dir', { value: signal('/work/a') });
    replacement.detectChanges(); await replacement.whenStable(); replacement.detectChanges();
    await vi.waitFor(() => { replacement.detectChanges(); expect(replacement.nativeElement.querySelector('button[type="submit"]').disabled).toBe(false); });
    const area = replacement.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'New draft after Back'; area.dispatchEvent(new Event('input'));
    const next = replacement.componentInstance as unknown as { chooseDirectory(path: string): void; chooseModel(model: string): void; attachments: { set(value: unknown[]): void } };
    next.chooseDirectory('/work/new'); next.chooseModel('new-example-model');
    const image = { name: 'new.jpg', type: 'image/jpeg', size: 1, data: 'image-placeholder' };
    next.attachments.set([image]);
    replacement.detectChanges(); await replacement.whenStable();
    acknowledge({ id: 'old-created', workingDirectory: '/work/a' });
    await replacement.whenStable(); await Promise.resolve();
    expect(await store.loadNewSession('host-a')).toEqual(expect.objectContaining({ text: 'New draft after Back', directory: '/work/new', model: 'new-example-model' }));
    expect(store.attachments('new-session:host-a')).toEqual([image]);
  });

  it('routes a late native photo into the recreated composer without replacing its draft or images', async () => {
    vi.spyOn(Preferences, 'get').mockResolvedValue({ value: null });
    vi.spyOn(Preferences, 'set').mockResolvedValue();
    const store = new DraftStore();
    const { fixture, root, images } = await setupSession({ realDrafts: store });
    await vi.waitFor(() => { fixture.detectChanges(); expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false); });
    let finishPick!: (value: unknown[]) => void;
    images.pickImages.mockImplementation(() => new Promise((resolve) => { finishPick = resolve; }));
    const picking = (fixture.componentInstance as unknown as { pickImages(): Promise<void> }).pickImages();
    fixture.destroy();
    const replacement = TestBed.createComponent(NewSessionComponent);
    Object.defineProperty(replacement.componentInstance, 'dir', { value: signal('/work/a') });
    replacement.detectChanges();
    await vi.waitFor(() => { replacement.detectChanges(); expect(replacement.nativeElement.querySelector('button[type="submit"]').disabled).toBe(false); });
    const area = replacement.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'New composer text'; area.dispatchEvent(new Event('input'));
    const next = replacement.componentInstance as unknown as { chooseDirectory(path: string): void; chooseModel(model: string): void; attachments: { set(value: unknown[]): void } };
    const own = { name: 'own.jpg', type: 'image/jpeg', size: 1, data: 'own-image-placeholder' };
    const picked = { name: 'late.jpg', type: 'image/jpeg', size: 1, data: 'late-image-placeholder' };
    next.chooseDirectory('/work/new'); next.chooseModel('new-model'); next.attachments.set([own]);
    replacement.detectChanges(); await replacement.whenStable();
    finishPick([picked]); await picking; replacement.detectChanges(); await replacement.whenStable();
    expect(store.attachments('new-session:host-a')).toEqual([own, picked]);
    expect(await store.loadNewSession('host-a')).toEqual(expect.objectContaining({ text: 'New composer text', directory: '/work/new', model: 'new-model' }));
    expect([...replacement.nativeElement.querySelectorAll('.composer-attachment img')].map((image) => (image as HTMLImageElement).alt)).toEqual(['own.jpg', 'late.jpg']);
  });

  it('keeps a late photo on its original host after navigating away', async () => {
    vi.spyOn(Preferences, 'get').mockResolvedValue({ value: null });
    vi.spyOn(Preferences, 'set').mockResolvedValue();
    const store = new DraftStore();
    const { fixture, root, images, activeHost, type } = await setupSession({ realDrafts: store });
    await vi.waitFor(() => { fixture.detectChanges(); expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false); });
    type('Original host draft');
    let finishPick!: (value: unknown[]) => void;
    images.pickImages.mockImplementation(() => new Promise((resolve) => { finishPick = resolve; }));
    const picking = (fixture.componentInstance as unknown as { pickImages(): Promise<void> }).pickImages();
    fixture.destroy(); activeHost.set({ id: 'host-b', name: 'Host B' });
    const picked = { name: 'late.jpg', type: 'image/jpeg', size: 1, data: 'late-image-placeholder' };
    finishPick([picked]); await picking;
    expect(store.attachments('new-session:host-a')).toEqual([picked]);
    expect(store.attachments('new-session:host-b')).toEqual([]);
    expect((await store.loadNewSession('host-a'))?.text).toBe('Original host draft');
  });

  it('waits for replacement draft loading before merging a late photo', async () => {
    vi.spyOn(Preferences, 'get').mockResolvedValue({ value: null });
    vi.spyOn(Preferences, 'set').mockResolvedValue();
    const store = new DraftStore();
    const { fixture, root, images } = await setupSession({ realDrafts: store });
    await vi.waitFor(() => { fixture.detectChanges(); expect(root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false); });
    let finishPick!: (value: unknown[]) => void;
    images.pickImages.mockImplementation(() => new Promise((resolve) => { finishPick = resolve; }));
    const picking = (fixture.componentInstance as unknown as { pickImages(): Promise<void> }).pickImages();
    fixture.destroy();
    let finishLoad!: (value: { text: string; directory: string; provider: string }) => void;
    vi.spyOn(store, 'loadNewSession').mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    const replacement = TestBed.createComponent(NewSessionComponent);
    Object.defineProperty(replacement.componentInstance, 'dir', { value: signal('/work/a') });
    replacement.detectChanges(); await Promise.resolve(); replacement.detectChanges();
    const area = replacement.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'Typing while loading'; area.dispatchEvent(new Event('input'));
    const own = { name: 'own.jpg', type: 'image/jpeg', size: 1, data: 'own-image-placeholder' };
    const picked = { name: 'late.jpg', type: 'image/jpeg', size: 1, data: 'late-image-placeholder' };
    (replacement.componentInstance as unknown as { attachments: { set(value: unknown[]): void } }).attachments.set([own]);
    finishPick([picked]); await Promise.resolve();
    finishLoad({ text: 'Saved before navigation', directory: '/work/a', provider: 'auto' });
    await picking; replacement.detectChanges(); await replacement.whenStable();
    expect(area.value).toBe('Typing while loading\n\nSaved before navigation');
    expect(store.attachments('new-session:host-a')).toEqual([own, picked]);
  });

  it('preserves typing made while a native dictation stop acknowledgement is delayed', async () => {
    const { root, fixture, voice, type, settle } = await setupSession();
    voice.text.set('Dictated words'); voice.listening.set(true); await settle();
    let stopped!: () => void;
    voice.stop.mockImplementation(() => {
      voice.listening.set(false);
      return new Promise<void>((resolve) => { stopped = resolve; });
    });
    const stopping = (fixture.componentInstance as unknown as { toggleDictation(): Promise<void> }).toggleDictation();
    type('Typed while stop finishes');
    stopped(); await stopping; await settle();
    expect(root.querySelector('textarea')!.value).toBe('Typed while stop finishes');
  });

  it.each([false, true])('recovers detached early edits after real Preferences load (saved draft: %s)', async (hasSaved) => {
    let finish!: (value: { value: string | null }) => void;
    vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(Preferences.set).mockResolvedValue();
    const store = new DraftStore();
    const { fixture, type, activeHost } = await setupSession({ realDrafts: store });
    type('Early typing');
    const component = fixture.componentInstance as unknown as { chooseDirectory(path: string): void; selectProvider(provider: 'codex'): void };
    component.chooseDirectory('/early/project'); component.selectProvider('codex');
    fixture.destroy(); activeHost.set({ id: 'host-b', name: 'Host B' });
    const saved = { text: 'Previously saved', directory: '/saved/project', provider: 'claude', model: 'saved-model' };
    finish({ value: hasSaved ? JSON.stringify({ 'new-session:host-a': { text: JSON.stringify(saved), at: Date.now() } }) : null });
    await vi.waitFor(async () => expect(await store.loadNewSession('host-a')).toEqual(expect.objectContaining({
      text: hasSaved ? 'Early typing\n\nPreviously saved' : 'Early typing', directory: '/early/project', provider: 'codex',
    })));
    expect((await store.loadNewSession('host-a'))?.model).toBeUndefined();
    expect(await store.loadNewSession('host-b')).toBeNull();
  });

  it.each(['remove', 'add'] as const)('preserves early photo %s across teardown and recreation before storage loads', async (edit) => {
    let finish!: (value: { value: string | null }) => void;
    vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(Preferences.set).mockResolvedValue();
    const store = new DraftStore();
    const original = { name: 'original.jpg', type: 'image/jpeg', size: 1, data: 'original-placeholder' };
    const added = { name: 'added.jpg', type: 'image/jpeg', size: 1, data: 'added-placeholder' };
    store.saveAttachments('new-session:host-a', [original]);
    const { fixture, root, type } = await setupSession({ realDrafts: store });
    if (edit === 'remove') root.querySelector<HTMLButtonElement>('button[aria-label="Remove original.jpg"]')!.click();
    else {
      (fixture.componentInstance as unknown as { attachments: { set(value: unknown[]): void } }).attachments.set([original, added]);
      type('Early text with added photo');
    }
    fixture.destroy();
    const expected = edit === 'remove' ? [] : [original, added];
    expect(store.attachments('new-session:host-a')).toEqual(expected);
    const next = TestBed.createComponent(NewSessionComponent);
    next.detectChanges(); await Promise.resolve(); next.detectChanges();
    finish({ value: null });
    await vi.waitFor(() => {
      next.detectChanges();
      expect([...next.nativeElement.querySelectorAll('.composer-attachment img')].map((image) => (image as HTMLImageElement).alt)).toEqual(expected.map((image) => image.name));
    });
    if (edit === 'add') await vi.waitFor(async () => expect((await store.loadNewSession('host-a'))?.text).toBe('Early text with added photo'));
    expect(store.attachments('new-session:host-a')).toEqual(expected);
  });

  it('does not overwrite a newer attachment owner during early teardown', async () => {
    let finish!: (value: { value: string | null }) => void;
    vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(Preferences.set).mockResolvedValue();
    const store = new DraftStore();
    const { fixture } = await setupSession({ realDrafts: store });
    const image = { name: 'successor.jpg', type: 'image/jpeg', size: 1, data: 'successor-placeholder' };
    const successor = store.claimNewSession('host-a');
    store.saveAttachments('new-session:host-a', [image], successor);
    fixture.destroy(); finish({ value: null });
    await store.loadNewSession('host-a');
    expect(store.attachments('new-session:host-a')).toEqual([image]);
  });

  it('recovers config-only edits without losing stored text or untouched settings', async () => {
    let finish!: (value: { value: string | null }) => void;
    vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(Preferences.set).mockResolvedValue();
    const store = new DraftStore();
    const { fixture } = await setupSession({ realDrafts: store });
    (fixture.componentInstance as unknown as { chooseDirectory(path: string): void }).chooseDirectory('/early/project');
    fixture.destroy();
    const saved = { text: 'Previously saved', directory: '/saved/project', provider: 'claude', model: 'saved-model', reasoningEffort: 'high' };
    finish({ value: JSON.stringify({ 'new-session:host-a': { text: JSON.stringify(saved), at: Date.now() } }) });
    await vi.waitFor(async () => expect(await store.loadNewSession('host-a')).toEqual({ ...saved, directory: '/early/project' }));
  });

  it('delivers departed early typing to the successor while retaining its text and settings', async () => {
    let finish!: (value: { value: string | null }) => void;
    vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.mocked(Preferences.set).mockResolvedValue();
    const store = new DraftStore();
    const { fixture, type } = await setupSession({ realDrafts: store });
    type('Departed typing');
    fixture.destroy();
    const next = TestBed.createComponent(NewSessionComponent);
    next.detectChanges(); await Promise.resolve(); next.detectChanges();
    const area = next.nativeElement.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'Successor typing'; area.dispatchEvent(new Event('input'));
    const component = next.componentInstance as unknown as { chooseDirectory(path: string): void; selectProvider(provider: 'codex'): void; chooseModel(model: string): void };
    component.chooseDirectory('/successor/project'); component.selectProvider('codex'); component.chooseModel('successor-model');
    next.detectChanges();
    const saved = { text: 'Previously saved', directory: '/saved/project', provider: 'claude', model: 'saved-model' };
    finish({ value: JSON.stringify({ 'new-session:host-a': { text: JSON.stringify(saved), at: Date.now() } }) });
    await vi.waitFor(async () => {
      next.detectChanges();
      expect(await store.loadNewSession('host-a')).toEqual(expect.objectContaining({
        text: 'Successor typing\n\nPreviously saved\n\nDeparted typing', directory: '/successor/project', provider: 'codex', model: 'successor-model',
      }));
    });
  });

  it('focuses the composer only on entry and preserves the stable settings opener for both sheets', async () => {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    const { fixture, root, settle } = await setupSession();
    const component = fixture.componentInstance as unknown as { chooseDirectory(path: string): void; completeSettings(): void; modelSheetOpen: { set(value: boolean): void } };
    expect(focus).toHaveBeenCalledTimes(1);
    focus.mockClear();
    const opener = root.querySelector<HTMLButtonElement>('button[aria-label="Session settings"]')!;
    opener.click(); await settle();
    expect((root.querySelector('app-mobile-sheet[label="Session settings"]') as unknown as { returnFocusTo: HTMLElement }).returnFocusTo).toBe(opener);
    component.completeSettings(); await settle();
    expect(focus).not.toHaveBeenCalled();
    opener.click(); await settle();
    buttonContaining(root, 'Run with Codex').click(); await settle();
    buttonContaining(root, 'Model').click(); await settle();
    expect((root.querySelector('app-model-sheet') as unknown as { returnFocusTo: HTMLElement }).returnFocusTo).toBe(opener);
    component.modelSheetOpen.set(false); await settle();
    expect(focus).not.toHaveBeenCalled();
  });

  it('rejects an A folder from browser history when recreated on host B', async () => {
    window.history.replaceState({ mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/a' } }, '');
    const { root, gateway } = await setupSession({ historyReentry: true, hostId: 'host-b', draft: JSON.stringify({ text: 'Draft B', directory: '/host-b/project', provider: 'auto' }), navigationState: { mobileNewSessionPreset: { hostId: 'host-a', directory: '/work/a' } } });
    expect(root.textContent).toContain('/host-b/project');
    expect(root.textContent).not.toContain('/work/a');
    root.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(gateway.createInstance).toHaveBeenCalledWith(expect.objectContaining({ workingDirectory: '/host-b/project', initialPrompt: 'Draft B' }));
    window.history.replaceState(null, '');
  });

  it('offers explicit recovery of older unscoped text without overwriting current text', async () => {
    const { root, drafts, settle, type } = await setupSession({ legacyText: 'Older unscoped draft' });
    type('Current host draft');
    expect(root.textContent).toContain('Recover older draft');
    buttonContaining(root, 'Recover older draft').click(); await settle();
    expect(root.querySelector('textarea')!.value).toBe('Current host draft\n\nOlder unscoped draft');
    expect(drafts.recoverLegacyNewSession).toHaveBeenCalledWith('host-a', expect.any(Symbol), expect.objectContaining({ text: 'Current host draft\n\nOlder unscoped draft' }), 'Older unscoped draft');
  });

  it('shows attachment and dictation failures beside the composer', async () => {
    const { root, settle } = await setupSession();
    root.querySelector<HTMLButtonElement>('button[aria-label="Add attachment"]')!.click(); await settle();
    buttonContaining(root, 'Photo Library').click(); await settle();
    expect(root.textContent).toContain('Photo permission denied');
    root.querySelector<HTMLButtonElement>('button[aria-label="Dictate message"]')!.click(); await settle();
    expect(root.textContent).toContain('Dictation');
  });
});
