import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { DraftStore } from '../../core/draft-store';
import { VoiceInputService } from '../../core/voice-input.service';
import { ImageAttachmentService } from '../../core/image-attachment.service';
import { HapticsService } from '../../core/haptics.service';
import { ConversationComposerComponent } from './conversation-composer.component';

await resolveComponentResources(() => Promise.resolve(''));

function setup(load: (key: string) => Promise<string> = async () => '', voiceOverride?: object) {
  const sendInput = vi.fn().mockResolvedValue({ queued: false });
  const host = signal({ id: 'preview-host', name: 'Preview' });
  const gateway = { sendInput, snapshot: signal(null), online: signal(true), state: signal('connected'),
    dataHostId: signal('preview-host'), setActiveView: vi.fn(), clearActiveView: vi.fn(),
    messagesFor: () => [], loadMessages: vi.fn(), messageStateFor: () => ({ status: 'loaded', error: null }) };
  TestBed.overrideComponent(ConversationComposerComponent, { set: { template: '', imports: [], styleUrls: [] } });
  TestBed.configureTestingModule({ providers: [
    { provide: GatewayClient, useValue: gateway },
    { provide: HostStore, useValue: { activeHost: host } },
    { provide: DraftStore, useValue: { load, save: vi.fn(), attachments: () => [], saveAttachments: vi.fn() } },
    { provide: VoiceInputService, useValue: voiceOverride ?? { available: false, listening: signal(false), text: signal(''), stop: vi.fn() } },
    { provide: ImageAttachmentService, useValue: { available: false } },
    { provide: HapticsService, useValue: { tap: vi.fn(), error: vi.fn(), heavyTap: vi.fn(), success: vi.fn() } },
  ] });
  const fixture = TestBed.createComponent(ConversationComposerComponent);
  fixture.componentRef.setInput('instanceId', 'preview-session');
  fixture.componentRef.setInput('activityLabel', 'running');
  fixture.detectChanges();
  const component = fixture.componentInstance as unknown as {
    draft: ReturnType<typeof signal<string>>;
    notice: () => string | null;
    noticeIsError: () => boolean;
    onEnter(event: Event): void;
    send(event: Event): Promise<void>;
  };
  return { fixture, component, sendInput, host };
}

afterEach(() => vi.useRealTimers());

describe('Conversation drafting', () => {
  it('leaves Return and composition to the editor, sends only with Ctrl/Command Return', async () => {
    const { fixture, component, sendInput } = setup();
    await fixture.whenStable();
    component.draft.set('First paragraph');
    const newline = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    component.onEnter(newline);
    expect(newline.defaultPrevented).toBe(false);
    expect(sendInput).not.toHaveBeenCalled();
    component.onEnter(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, cancelable: true }));
    expect(sendInput).not.toHaveBeenCalled();
    component.onEnter(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true }));
    expect(sendInput).toHaveBeenCalledTimes(1);
  });

  it('preserves new draft text when a delayed send fails and keeps the failure visible', async () => {
    const { fixture, component, sendInput } = setup();
    await fixture.whenStable();
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    sendInput.mockReturnValue(new Promise((_, fail) => { reject = fail; }));
    component.draft.set('Original request');
    const pending = component.send(new Event('submit'));
    component.draft.set('Next request');
    reject(new Error('Preview rejection'));
    await pending;
    expect(component.draft()).toContain('Original request');
    expect(component.draft()).toContain('Next request');
    await vi.advanceTimersByTimeAsync(7000);
    expect(component.notice()).toContain('Preview rejection');
    expect(component.noticeIsError()).toBe(true);
  });

  it('merges a stored draft that arrives after typing starts', async () => {
    let release!: (text: string) => void;
    const waiting = new Promise<string>((resolve) => { release = resolve; });
    const { fixture, component } = setup((key) => key.startsWith('[') ? waiting : Promise.resolve(''));
    await fixture.whenStable();
    component.draft.set('New typing');
    release('Stored request');
    await fixture.whenStable();
    expect(component.draft()).toBe('New typing\n\nStored request');
  });

  it('does not replace newly typed text while sending waits for native dictation to stop', async () => {
    const listening = signal(false);
    const voiceText = signal('Dictated request');
    const stop = vi.fn().mockResolvedValue(undefined);
    const { fixture, component, sendInput } = setup(undefined, { available: true, listening, text: voiceText, stop });
    await fixture.whenStable();
    listening.set(true); await fixture.whenStable();
    let release!: () => void;
    stop.mockImplementation(() => { listening.set(false); return new Promise<void>((resolve) => { release = resolve; }); });
    const pending = component.send(new Event('submit'));
    component.draft.set('Next message');
    release(); await pending;
    expect(sendInput).toHaveBeenCalledWith('preview-session', 'Dictated request', undefined);
    expect(component.draft()).toBe('Next message');
  });
});
