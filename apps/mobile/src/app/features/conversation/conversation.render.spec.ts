import { readFileSync } from 'node:fs';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { By } from '@angular/platform-browser';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import { DraftStore } from '../../core/draft-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { HapticsService } from '../../core/haptics.service';
import { HostStore } from '../../core/host-store';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import type { MobileMessageDto, MobileSnapshot } from '../../core/models';
import { VoiceInputService } from '../../core/voice-input.service';
import { ConversationComponent } from './conversation.component';
import { ConversationComposerComponent } from './conversation-composer.component';

await resolveComponentResources((url) => Promise.resolve(readFileSync(new URL(url, import.meta.url), 'utf8')));

const transcript: MobileMessageDto[] = [
  { id: 'answer', timestamp: 100, type: 'assistant', content: 'Hello **James**' },
  { id: 'tool', timestamp: 101, type: 'tool_use', content: 'Read file' },
];

async function setup(sendInput = vi.fn().mockResolvedValue({ queued: false }), options: {
  status?: string; isLooping?: boolean; online?: boolean; steerInput?: ReturnType<typeof vi.fn>;
} = {}) {
  const host = signal({ id: 'host', name: 'Preview' });
  const snapshot = signal<MobileSnapshot>({
    hostName: 'Preview', serverTime: 100,
    instances: [{ id: 'session', displayName: 'Agent', status: options.status ?? 'idle', isLooping: options.isLooping, attentionLevel: 'idle',
      provider: 'claude', workingDirectory: '/project', projectName: 'project', createdAt: 1,
      lastActivity: 100, pendingApprovalCount: 0, hasUnreadCompletion: false }],
    projects: [], prompts: [],
    pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  });
  TestBed.configureTestingModule({ imports: [ConversationComponent], providers: [
    { provide: GatewayClient, useValue: {
      snapshot, online: signal(options.online ?? true), state: signal('connected'), dataHostId: signal('host'),
      messagesFor: () => transcript, messageStateFor: () => ({ status: 'loaded', error: null }),
      hasEarlierFor: () => false, earlierStateFor: () => ({ status: 'idle', error: null }),
      loadMessages: vi.fn(), sendInput, steerInput: options.steerInput ?? vi.fn().mockResolvedValue(undefined), setActiveView: vi.fn(), clearActiveView: vi.fn(),
    } },
    { provide: HostStore, useValue: { activeHost: host } },
    { provide: DraftStore, useValue: { load: async () => '', save: vi.fn(), attachments: () => [], saveAttachments: vi.fn() } },
    { provide: ApprovalPresentationStore, useValue: { requests: signal([]), open: vi.fn() } },
    { provide: VoiceInputService, useValue: { available: false, listening: signal(false), text: signal(''), stop: vi.fn() } },
    { provide: ImageAttachmentService, useValue: { available: false } },
    { provide: HapticsService, useValue: { tap: vi.fn(), error: vi.fn(), heavyTap: vi.fn(), success: vi.fn() } },
    { provide: Router, useValue: { getCurrentNavigation: () => null, navigate: vi.fn() } },
  ] });
  await TestBed.compileComponents();
  const fixture = TestBed.createComponent(ConversationComponent);
  fixture.componentRef.setInput('instanceId', 'session');
  await fixture.whenStable();
  return fixture;
}

describe('Conversation rendered split boundary', () => {
  for (const status of ['busy', 'processing', 'thinking_deeply', 'waiting_for_permission',
    'idle', 'ready', 'waiting_for_input', 'respawning', 'interrupting', 'cancelling', 'interrupt-escalating',
    'initializing', 'waking', 'hibernating', 'degraded', 'error']) {
    it(`gates steering on the exact ${status} status even when looping`, async () => {
      const fixture = await setup(undefined, { status, isLooping: true });
      const button = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Steer current turn"]');
      expect(Boolean(button)).toBe(['busy', 'processing', 'thinking_deeply', 'waiting_for_permission'].includes(status));
    });
  }

  it('keeps steering disabled offline', async () => {
    const fixture = await setup(undefined, { status: 'busy', online: false });
    expect((fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Steer current turn"]')?.disabled).toBe(true);
  });

  for (const succeeds of [true, false]) {
    it(`uses a distinct steering transaction and ${succeeds ? 'consumes' : 'restores'} text and attachments`, async () => {
      let finish!: () => void;
      let reject!: (reason: Error) => void;
      const steerInput = vi.fn(() => new Promise<void>((resolve, fail) => { finish = resolve; reject = fail; }));
      const sendInput = vi.fn().mockResolvedValue({ queued: true });
      const fixture = await setup(sendInput, { status: 'busy', steerInput });
      const root = fixture.nativeElement as HTMLElement;
      const controller = fixture.debugElement.query(By.directive(ConversationComposerComponent)).componentInstance;
      const attachment = { name: 'photo.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' };
      controller.draft.set('Change course');
      controller.attachments.set([attachment]);
      fixture.detectChanges();
      const steer = root.querySelector<HTMLButtonElement>('[aria-label="Steer current turn"]')!;
      expect(steer).not.toBeNull();
      steer.click();
      fixture.detectChanges();
      expect(steerInput).toHaveBeenCalledExactlyOnceWith('session', 'Change course', [attachment]);
      expect(sendInput).not.toHaveBeenCalled();
      expect(steer.disabled).toBe(true);
      expect(root.querySelector<HTMLButtonElement>('.send')?.disabled).toBe(true);
      controller.draft.set('Typed meanwhile');
      steer.click();
      root.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
      expect(steerInput).toHaveBeenCalledTimes(1);
      expect(sendInput).not.toHaveBeenCalled();
      if (succeeds) finish(); else reject(new Error('Steer refused'));
      await fixture.whenStable();
      expect(controller.attachments()).toEqual(succeeds ? [] : [attachment]);
      expect(controller.draft()).toBe(succeeds ? 'Typed meanwhile' : 'Typed meanwhile\n\nChange course');
      if (!succeeds) expect(root.querySelector('[role="alert"]')?.textContent).toContain('Steer refused');
    });
  }
  it('shows rendered markdown and expands the collapsed tool group', async () => {
    const fixture = await setup();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.transcript .markdown-body strong')?.textContent).toBe('James');
    const toggle = root.querySelector<HTMLButtonElement>('.tool-toggle');
    expect(toggle?.textContent).toContain('1 activity entry');
    toggle?.click();
    fixture.detectChanges();
    expect(root.querySelector('.tool-entry summary')?.textContent).toContain('Read file');
  });

  it('keeps the composer usable and shows a queued-send notice', async () => {
    const fixture = await setup(vi.fn().mockResolvedValue({ queued: true }));
    const root = fixture.nativeElement as HTMLElement;
    const textarea = root.querySelector<HTMLTextAreaElement>('.composer textarea')!;
    textarea.value = 'Later';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
    root.querySelector<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await fixture.whenStable();
    expect(root.querySelector('.composer-notice')?.textContent).toContain('Queued. It will send when this session is free.');
  });
});
