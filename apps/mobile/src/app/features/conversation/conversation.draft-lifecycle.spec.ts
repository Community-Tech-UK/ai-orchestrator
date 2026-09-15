import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import { VoiceInputService } from '../../core/voice-input.service';
import { ConversationComponent } from './conversation.component';

vi.mock('@capacitor/preferences', () => ({ Preferences: { get: vi.fn(), set: vi.fn() } }));
await resolveComponentResources(() => Promise.resolve(''));

function setup() {
  let finish!: (value: { value: string | null }) => void;
  vi.mocked(Preferences.get).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  vi.mocked(Preferences.set).mockResolvedValue();
  const store = new DraftStore();
  const host = signal({ id: 'host-a', name: 'Host A' });
  TestBed.overrideComponent(ConversationComponent, { set: { template: '', templateUrl: undefined, imports: [], styleUrls: [] } });
  TestBed.configureTestingModule({ providers: [
    { provide: DraftStore, useValue: store },
    { provide: HostStore, useValue: { activeHost: host } },
    { provide: GatewayClient, useValue: {
      online: signal(true), state: signal('connected'), snapshot: signal(null), dataHostId: signal('host-a'),
      setActiveView: vi.fn(), clearActiveView: vi.fn(), messagesFor: () => [], loadMessages: vi.fn(),
      messageStateFor: () => ({ status: 'loaded', error: null }),
    } },
    { provide: HapticsService, useValue: { tap: vi.fn(), error: vi.fn(), success: vi.fn() } },
    { provide: ImageAttachmentService, useValue: { available: false } },
    { provide: VoiceInputService, useValue: { available: false, listening: signal(false), text: signal(''), stop: vi.fn().mockResolvedValue(undefined) } },
    { provide: ApprovalPresentationStore, useValue: { requests: signal([]), open: vi.fn() } },
    { provide: Router, useValue: { navigate: vi.fn(), getCurrentNavigation: () => null } },
  ] });
  const create = () => {
    const fixture = TestBed.createComponent(ConversationComponent);
    Object.defineProperty(fixture.componentInstance, 'instanceId', { value: signal('session-a') });
    fixture.detectChanges();
    const component = fixture.componentInstance as unknown as { draft: ReturnType<typeof signal<string>> };
    return { fixture, component };
  };
  return { store, host, finish, create };
}

beforeEach(() => vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(false));

describe('Conversation draft loading across teardown', () => {
  it('retains typing when leaving before the initial Preferences read completes', async () => {
    const { store, finish, create } = setup();
    const { fixture, component } = create();
    component.draft.set('Keep this early draft');
    fixture.detectChanges();
    fixture.destroy();
    finish({ value: null });
    await vi.waitFor(async () => {
      expect(await store.load(JSON.stringify(['instance', 'host-a', 'session-a']))).toBe('Keep this early draft');
    });
  });

  it('merges pending edits into a replacement composer without duplicating stored text', async () => {
    const { store, finish, create } = setup();
    const first = create();
    first.component.draft.set('Early typing');
    first.fixture.destroy();
    const next = create();
    next.component.draft.set('Replacement typing');
    const key = JSON.stringify(['instance', 'host-a', 'session-a']);
    finish({ value: JSON.stringify({ [key]: { text: 'Stored request', at: Date.now() } }) });
    await vi.waitFor(() => {
      expect(next.component.draft().split('\n\n').sort()).toEqual(['Early typing', 'Replacement typing', 'Stored request']);
    });
    next.fixture.destroy();
    await vi.waitFor(async () => {
      expect((await store.load(key)).split('\n\n').sort()).toEqual(['Early typing', 'Replacement typing', 'Stored request']);
    });
  });

  it('keeps pending text with its original host during an in-place host change', async () => {
    const { store, host, finish, create } = setup();
    const { fixture, component } = create();
    component.draft.set('Host A typing');
    host.set({ id: 'host-b', name: 'Host B' });
    fixture.detectChanges();
    component.draft.set('Host B typing');
    finish({ value: null });
    await vi.waitFor(async () => {
      expect(await store.load(JSON.stringify(['instance', 'host-a', 'session-a']))).toBe('Host A typing');
      expect(component.draft()).toBe('Host B typing');
    });
    fixture.destroy();
    await vi.waitFor(async () => {
      expect(await store.load(JSON.stringify(['instance', 'host-b', 'session-a']))).toBe('Host B typing');
    });
  });
});
