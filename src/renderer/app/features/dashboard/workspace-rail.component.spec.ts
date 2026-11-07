import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { AutomationStore } from '../../core/state/automation.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { TerminalDrawerStore } from '../../core/state/terminal-drawer.store';
import type { SideChatAttention } from '../../../../shared/types/side-chat.types';
import { KeybindingService } from '../../core/services/keybinding.service';
import { WorkspaceRailComponent } from './workspace-rail.component';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { NeedsYouStore } from '../workboard/needs-you.store';

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
  const dispatch = vi.fn();
  const attentionLoadState = signal<'idle' | 'loading' | 'loaded' | 'error'>('loaded');
  const retryAttentionLoad = vi.fn().mockResolvedValue(undefined);
  const needsYouCount = signal(3);
  const connectedNodes = signal<unknown[]>([]);

  beforeEach(async () => {
    unreadCount.set(2);
    connectedNodes.set([]);
    sideChatAttention.set([]);
    requestOpen.mockClear();
    retryAttentionLoad.mockClear();
    attentionLoadState.set('loaded');
    markAllSeen.mockClear();
    await TestBed.configureTestingModule({
      imports: [WorkspaceRailComponent, RouterTestingModule.withRoutes([])],
      providers: [
        { provide: ActionDispatchService, useValue: { dispatch } },
        { provide: NeedsYouStore, useValue: { count: needsYouCount } },
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
            attentionLoadState: attentionLoadState.asReadonly(),
            retryAttentionLoad,
          },
        },
        { provide: RemoteNodeStore, useValue: { connectedNodes: connectedNodes.asReadonly() } },
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

  it('opens the session finder from Search', () => {
    const search = fixture.nativeElement.querySelector('[aria-label="Search"]') as HTMLElement;
    search.click();
    expect(dispatch).toHaveBeenCalledWith('open-session-picker');
    expect(search.tagName).toBe('BUTTON');
  });

  it('keeps every control named with a real tooltip and retains distinct old names', () => {
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    for (const host of fixture.debugElement.queryAll(By.css('a, button.rail-btn'))) {
      expect(host.nativeElement.getAttribute('aria-label')).toBeTruthy();
      expect(host.injector.get(AioTooltipDirective)).toBeTruthy();
    }
    const search = fixture.debugElement.query(By.css('button[aria-label="Search"]'));
    expect(search.injector.get(AioTooltipDirective).appTooltip()).toBe(copyFor('findSession'));
  });
  it('shows live rebound shortcut chips and keeps expanded panel hints on keyboard focus', () => {
    const keybindings = TestBed.inject(KeybindingService);
    keybindings.customizeBinding('toggle-history', { key: 'j', modifiers: ['alt'] }); fixture.detectChanges();
    const history = fixture.debugElement.query(By.css('button[aria-label="History"]'));
    expect(history.nativeElement.getAttribute('aria-keyshortcuts')).toBe('Alt+J');
    const element = history.nativeElement as HTMLElement;
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"] kbd')?.textContent).toBe('Alt+J');
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    fixture.componentRef.setInput('controlPlaneOpen', true); fixture.componentRef.setInput('sideChatOpen', true); fixture.detectChanges();
    for (const label of ['Tools and Views', 'Sidechats']) {
      const toggle = fixture.debugElement.query(By.css(`button[aria-label="${label}"]`));
      expect(toggle.injector.get(AioTooltipDirective).appTooltipShowWhenExpanded()).toBe(true);
      expect(toggle.injector.get(AioTooltipDirective).appTooltipPosition()).toBe('after');
    }
  });

  it('has no Plugins rail destination', () => {
    expect(fixture.nativeElement.querySelector('a[href="/plugins"]')).toBeNull();
  });

  it('puts Needs you first with the shared count, accessible label and no native title', () => {
    const link = fixture.nativeElement.querySelector('nav a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/work');
    expect(link.getAttribute('aria-label')).toBe('Needs you: 3 waiting');
    expect(link.querySelector('.rail-badge')?.textContent).toBe('3');
    expect(link.hasAttribute('title')).toBe(false);
    needsYouCount.set(120); fixture.detectChanges();
    expect(link.querySelector('.rail-badge')?.textContent).toBe('99+');
    needsYouCount.set(0); fixture.detectChanges();
    expect(link.getAttribute('aria-label')).toBe('Needs you: nothing waiting');
    expect(link.querySelector('.rail-badge')).toBeNull();
    needsYouCount.set(3);
  });

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
    expect(item.getAttribute('aria-disabled')).toBeNull();

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
    expect(item.disabled).toBe(false);
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const matches = item.matches.bind(item);
    const focusVisible = vi.spyOn(item, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    item.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(item);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('There are no unread automation notices.');
    focusVisible.mockRestore();

    item.click();
    expect(markAllSeen).not.toHaveBeenCalled();
    unreadCount.set(1);
    TestBed.tick();
    const recovered = renderedMenu()?.querySelector('button[role="menuitem"]') as HTMLButtonElement;
    expect(recovered.getAttribute('aria-disabled')).toBeNull();
    recovered.click();
    expect(markAllSeen).toHaveBeenCalledOnce();
  });

  function sideChatButton(): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button[data-testid="sidechat-toggle"]') as HTMLButtonElement;
  }

  it('names parent sessions in the sidechat attention list and opens the exact conversation', () => {
    const parent = { kind: 'session' as const, historyThreadId: 'thread-1', originNodeId: null };
    sideChatAttention.set([{
      parent, parentTitle: 'Provider Hardening', total: 2, running: 1, unread: 1, needsAttention: 0, attentionSince: null, targetChatId: 'side-9',
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
      parent: { kind: 'chat', chatId: 'c1' }, parentTitle: 'Chat', total: 1, running: 1, unread: 0, needsAttention: 0, attentionSince: null, targetChatId: 'side-1',
    }]);
    fixture.detectChanges();

    expect(sideChatButton().querySelector('.rail-badge')).toBeNull();
    expect(sideChatButton().querySelector('.rail-activity-dot')).not.toBeNull();
  });

  function attentionFailureButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('button[aria-label="Sidechat activity did not load. Open to try again."]');
  }

  it('shows no failure control while sidechat activity loads normally', () => {
    expect(attentionFailureButton()).toBeNull();
    attentionLoadState.set('loading');
    fixture.detectChanges();
    expect(attentionFailureButton()).toBeNull();
  });

  it('shows a keyboard-reachable failure control that names the problem and retries from the menu', () => {
    attentionLoadState.set('error');
    fixture.detectChanges();

    const button = attentionFailureButton();
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('title')).toBe(false);
    expect(button?.getAttribute('aria-haspopup')).toBe('menu');
    expect(button?.getAttribute('aria-expanded')).toBe('false');

    button?.click();
    fixture.detectChanges();
    expect(button?.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(renderedMenu()?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]') ?? []);
    expect(items.map((item) => item.textContent?.trim())).toEqual(['Sidechat activity did not load', 'Try again']);
    expect(items[0].disabled).toBe(true);
    expect(items[1].disabled).toBe(false);

    items[1].click();
    expect(retryAttentionLoad).toHaveBeenCalledTimes(1);
  });

  it('shows the failure, not "No sidechat activity", in the right-click sidechat menu', () => {
    attentionLoadState.set('error');
    fixture.detectChanges();

    sideChatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    fixture.detectChanges();

    const labels = Array.from(renderedMenu()?.querySelectorAll('button[role="menuitem"]') ?? []).map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Sidechat activity did not load', 'Try again']);
  });

  it('keeps known sidechat activity listed after the failure items', () => {
    const parent = { kind: 'session' as const, historyThreadId: 'thread-1', originNodeId: null };
    sideChatAttention.set([{
      parent, parentTitle: 'Provider Hardening', total: 1, running: 0, unread: 1, needsAttention: 0, attentionSince: null, targetChatId: 'side-9',
    }]);
    attentionLoadState.set('error');
    fixture.detectChanges();

    sideChatButton().dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    fixture.detectChanges();

    const labels = Array.from(renderedMenu()?.querySelectorAll('button[role="menuitem"]') ?? []).map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Sidechat activity did not load', 'Try again', 'Provider Hardening — 1 unread']);
  });

  it('links to the Plan Queue page', () => {
    const link = fixture.nativeElement.querySelector('a[aria-label="Plan Queue"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/plan-queue');
  });

  function terminalButton(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('button[aria-label="Remote terminal on a worker computer"]');
  }

  it('shows the remote terminal toggle only when a worker is connected', () => {
    expect(terminalButton()).toBeNull();

    connectedNodes.set([{ id: 'windows-pc' }]);
    fixture.detectChanges();

    expect(terminalButton()).not.toBeNull();
    expect(terminalButton()?.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles the shared terminal drawer and keeps the toggle while it is open', () => {
    const drawer = TestBed.inject(TerminalDrawerStore);
    connectedNodes.set([{ id: 'windows-pc' }]);
    fixture.detectChanges();

    terminalButton()?.click();
    fixture.detectChanges();
    expect(drawer.isOpen()).toBe(true);
    expect(terminalButton()?.classList.contains('active')).toBe(true);

    connectedNodes.set([]);
    fixture.detectChanges();
    expect(terminalButton()).not.toBeNull();

    terminalButton()?.click();
    fixture.detectChanges();
    expect(drawer.isOpen()).toBe(false);
    expect(terminalButton()).toBeNull();
  });
});
