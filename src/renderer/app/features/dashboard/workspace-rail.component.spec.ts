import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationStore } from '../../core/state/automation.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import type { SideChatAttention } from '../../../../shared/types/side-chat.types';
import { WorkspaceRailComponent } from './workspace-rail.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(resolve(specDirectory, './workspace-rail.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('workspace-rail.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('WorkspaceRailComponent', () => {
  let fixture: ComponentFixture<WorkspaceRailComponent>;
  const unreadCount = signal(2);
  const markAllSeen = vi.fn().mockResolvedValue(undefined);
  const sideChatAttention = signal<SideChatAttention[]>([]);
  const requestOpen = vi.fn();

  beforeEach(async () => {
    unreadCount.set(2);
    sideChatAttention.set([]);
    requestOpen.mockClear();
    markAllSeen.mockClear();
    await TestBed.configureTestingModule({
      imports: [WorkspaceRailComponent, RouterTestingModule.withRoutes([])],
      providers: [
        {
          provide: AutomationStore,
          useValue: {
            unreadCount: unreadCount.asReadonly(),
            markAllSeen,
          },
        },
        {
          provide: SideChatStore,
          useValue: {
            attentionList: sideChatAttention.asReadonly(),
            attentionBadgeCount: () => sideChatAttention().reduce((sum, entry) => sum + entry.unread + entry.needsAttention, 0),
            requestOpen,
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceRailComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    document.querySelectorAll('.cdk-overlay-container').forEach((node) => node.remove());
  });

  function automationsLink(): HTMLAnchorElement {
    return fixture.nativeElement.querySelector('a[aria-label="Automations"]') as HTMLAnchorElement;
  }

  function renderedMenu(): HTMLElement | null {
    return document.body.querySelector('.context-menu');
  }

  it('shows the unread automations badge on the rail destination', () => {
    expect(automationsLink().querySelector('.rail-badge')?.textContent).toBe('2');
    expect(automationsLink().getAttribute('aria-haspopup')).toBe('menu');
    expect(automationsLink().getAttribute('aria-expanded')).toBe('false');
  });

  it('opens a clear-notifications menu on right-click and marks every run seen', () => {
    automationsLink().dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 42,
    }));
    fixture.detectChanges();

    expect(automationsLink().getAttribute('aria-expanded')).toBe('true');

    const item = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(item?.textContent).toContain('Clear notifications');
    expect(item.disabled).toBe(false);

    item.click();
    fixture.detectChanges();

    expect(markAllSeen).toHaveBeenCalledTimes(1);
  });

  it('disables clear-notifications when nothing is unread', () => {
    unreadCount.set(0);
    fixture.detectChanges();

    automationsLink().dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: 18,
      clientY: 42,
    }));
    fixture.detectChanges();

    const item = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(item.disabled).toBe(true);

    item.click();
    expect(markAllSeen).not.toHaveBeenCalled();
  });

  function sideChatButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button[aria-haspopup="menu"][title^="Sidechats"]') as HTMLButtonElement;
  }

  it('names parent sessions in the sidechat attention list and opens the exact conversation', () => {
    const parent = { kind: 'session' as const, historyThreadId: 'thread-1', originNodeId: null };
    sideChatAttention.set([{
      parent, parentTitle: 'Provider Hardening', total: 2, running: 1, unread: 1, needsAttention: 0, targetChatId: 'side-9',
    }]);
    fixture.detectChanges();

    expect(sideChatButton().querySelector('.rail-badge')?.textContent).toBe('1');
    expect(sideChatButton().getAttribute('aria-label')).toBe('Sidechats, 1 need a look, 1 running');

    sideChatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    fixture.detectChanges();
    const item = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(item.textContent).toContain('Provider Hardening — 1 unread, 1 running');

    item.click();
    expect(requestOpen).toHaveBeenCalledWith(parent, 'side-9');
  });

  it('shows a running indicator, not a count, when sidechats are only working', () => {
    sideChatAttention.set([{
      parent: { kind: 'chat', chatId: 'c1' }, parentTitle: 'Chat', total: 1, running: 1, unread: 0, needsAttention: 0, targetChatId: 'side-1',
    }]);
    fixture.detectChanges();

    expect(sideChatButton().querySelector('.rail-badge')).toBeNull();
    expect(sideChatButton().querySelector('.rail-activity-dot')).not.toBeNull();
  });
});
