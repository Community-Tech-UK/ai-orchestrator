import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SideChatPanelComponent } from './side-chat-panel.component';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('side-chat-panel.component.html')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './side-chat-panel.component.html'), 'utf8'),
    );
  }
  if (url.endsWith('side-chat-panel.component.scss')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './side-chat-panel.component.scss'), 'utf8'),
    );
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.resolve('');
});

function createMockChatStore() {
  return {
    details: vi.fn().mockReturnValue(new Map()),
    chats: vi.fn().mockReturnValue([]),
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureDetailLoaded: vi.fn().mockResolvedValue(undefined),
    sendMessageTo: vi.fn().mockResolvedValue({ ok: true }),
    createDetached: vi.fn().mockResolvedValue({ ok: false, error: 'unused' }),
    loadOlderMessagesFor: vi.fn().mockResolvedValue(null),
  };
}

function createMockSideChatStore() {
  return {
    stateFor: vi.fn().mockReturnValue({ selectedChatId: null, drafts: {}, pendingSelection: null }),
    selectedChatId: vi.fn().mockReturnValue(null),
    draftFor: vi.fn().mockReturnValue(''),
    setDraft: vi.fn(),
    setPendingSelection: vi.fn(),
    selectChat: vi.fn(),
    loadForParent: vi.fn().mockResolvedValue([]),
    loadAttention: vi.fn().mockResolvedValue(null),
    createSideChat: vi.fn().mockResolvedValue('new-side'),
    send: vi.fn().mockResolvedValue(true),
    markRead: vi.fn().mockResolvedValue(undefined),
    detailFor: vi.fn().mockReturnValue(null),
    sending: vi.fn().mockReturnValue(false),
    error: vi.fn().mockReturnValue(null),
    links: vi.fn().mockReturnValue(new Map()),
    sessions: vi.fn().mockReturnValue(new Map()),
    attention: vi.fn().mockReturnValue(new Map()),
    sessionKey: vi.fn().mockReturnValue('chat:parent-a'),
  };
}

function createMockInstanceStore() {
  return {
    getInstance: vi.fn().mockReturnValue(null),
    instanceActivities: vi.fn().mockReturnValue(new Map()),
    interruptInstance: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockSettingsStore() {
  return {
    showThinking: vi.fn().mockReturnValue(false),
    thinkingDefaultExpanded: vi.fn().mockReturnValue(false),
    showToolMessages: vi.fn().mockReturnValue(false),
    defaultYoloMode: vi.fn().mockReturnValue(false),
  };
}

describe('SideChatPanelComponent', () => {
  let fixture: ComponentFixture<SideChatPanelComponent>;
  let chatStore: ReturnType<typeof createMockChatStore>;
  let sideChatStore: ReturnType<typeof createMockSideChatStore>;

  beforeEach(async () => {
    chatStore = createMockChatStore();
    sideChatStore = createMockSideChatStore();

    await TestBed.configureTestingModule({
      imports: [SideChatPanelComponent],
      providers: [
        { provide: ChatStore, useValue: chatStore },
        { provide: SideChatStore, useValue: sideChatStore },
        { provide: InstanceStore, useValue: createMockInstanceStore() },
        { provide: SettingsStore, useValue: createMockSettingsStore() },
        { provide: ViewLayoutService, useValue: { sideChatWidth: 360, setSideChatWidth: vi.fn() } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SideChatPanelComponent);
  });

  it('does not create a runtime on first open', () => {
    fixture.detectChanges();
    expect(chatStore.createDetached).not.toHaveBeenCalled();
    expect(sideChatStore.createSideChat).not.toHaveBeenCalled();
  });

  it('shows the empty state before any conversation exists', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.empty-title')?.textContent).toContain('Ask on the side');
  });

  it('renders the panel header with close action', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.header-close')).toBeTruthy();
    expect(el.querySelector('.header-title')?.textContent).toContain('Side chat');
  });

  it('has accessible labels on the composer and buttons', () => {
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('textarea')?.getAttribute('aria-label')).toBeTruthy();
    expect(el.querySelector('.header-close')?.getAttribute('aria-label')).toBeTruthy();
  });
});
