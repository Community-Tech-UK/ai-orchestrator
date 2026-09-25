import { readFileSync } from 'node:fs';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
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

await resolveComponentResources((url) => Promise.resolve(readFileSync(new URL(url, import.meta.url), 'utf8')));

const transcript: MobileMessageDto[] = [
  { id: 'answer', timestamp: 100, type: 'assistant', content: 'Hello **James**' },
  { id: 'tool', timestamp: 101, type: 'tool_use', content: 'Read file' },
];

async function setup(sendInput = vi.fn().mockResolvedValue({ queued: false })) {
  const host = signal({ id: 'host', name: 'Preview' });
  const snapshot = signal<MobileSnapshot>({
    hostName: 'Preview', serverTime: 100,
    instances: [{ id: 'session', displayName: 'Agent', status: 'idle', attentionLevel: 'idle',
      provider: 'claude', workingDirectory: '/project', projectName: 'project', createdAt: 1,
      lastActivity: 100, pendingApprovalCount: 0, hasUnreadCompletion: false }],
    projects: [], prompts: [],
    pause: { isPaused: false, reasons: [], pausedAt: null, lastChange: 0 },
  });
  TestBed.configureTestingModule({ imports: [ConversationComponent], providers: [
    { provide: GatewayClient, useValue: {
      snapshot, online: signal(true), state: signal('connected'), dataHostId: signal('host'),
      messagesFor: () => transcript, messageStateFor: () => ({ status: 'loaded', error: null }),
      loadMessages: vi.fn(), sendInput, setActiveView: vi.fn(), clearActiveView: vi.fn(),
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
