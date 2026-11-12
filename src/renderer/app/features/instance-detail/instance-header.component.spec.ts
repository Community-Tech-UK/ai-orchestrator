import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { KeybindingService } from '../../core/services/keybinding.service';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceHeaderComponent } from './instance-header.component';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import type { Instance } from '../../core/state/instance.store';
import { HelpDrawerService } from '../../shared/help/help-drawer.service';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('instance-header.component.html')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, './instance-header.component.html'), 'utf8'));
  }
  if (url.endsWith('instance-header.component.scss')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, './instance-header.component.scss'), 'utf8'));
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function instance(provider: Instance['provider']): Instance {
  return {
    id: 'inst-1',
    provider,
    status: 'busy',
    displayName: 'Session',
    workingDirectory: '/tmp/session',
  } as Instance;
}

describe('InstanceHeaderComponent', () => {
  let fixture: ComponentFixture<InstanceHeaderComponent>;
  let showCost = true;
  let settings: Record<string, unknown> = {};

  beforeEach(async () => {
    showCost = true;
    settings = {};
    await TestBed.configureTestingModule({
      imports: [InstanceHeaderComponent],
      providers: [
        { provide: KeybindingService, useValue: { formatBindingByAction: () => 'Escape', ariaShortcutsByAction: () => 'Escape' } },
        { provide: SettingsStore, useValue: { showCost: () => showCost, settings: () => settings, update: vi.fn() } },
        { provide: InstanceStore, useValue: { getInstance: () => undefined, instances: () => [] } },
        {
          provide: FileIpcService,
          useValue: {
            editorDetect: vi.fn().mockResolvedValue(undefined),
            editorGetDefault: vi.fn().mockResolvedValue({ data: null }),
            editorGetAvailable: vi.fn().mockResolvedValue({ data: [] }),
          },
        },
        {
          provide: ElectronIpcService,
          useValue: {
            platform: 'darwin',
            getApi: () => new Proxy({}, { get: () => () => () => undefined }),
          },
        },
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
        {
          provide: CrossModelReviewIpcService,
          useValue: {
            getReviewForInstance: () => undefined,
            status: () => null,
            pendingInstances: () => new Set(),
            skippedInstances: () => new Set(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InstanceHeaderComponent);
  });

  const render = (value: Instance): HTMLElement => {
    fixture.componentRef.setInput('instance', value);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };
  const chips = (): string[] => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.chip'))
    .map(chip => chip.textContent?.replace(/\s+/g, ' ').trim() ?? '');

  it('renders one row with no model picker, account chip, hooks, skills, context bar or Computer Use control', () => {
    const header = render({ ...instance('claude'), status: 'idle', contextUsage: { used: 10, total: 100, percentage: 10, occupancyReported: true } } as Instance);
    for (const gone of [
      'app-compact-model-picker', 'app-provider-account-chip', 'app-context-bar', 'app-session-skills-badge',
      'app-session-computer-use-control', 'app-copilot-premium-usage', '.provider-badge', '.copilot-account-badge',
      '.pending-model-badge', '.hooks-badge', '.skills-badge', '.header-bottom',
    ]) {
      expect(header.querySelector(gone), gone).toBeNull();
    }
    expect(header.querySelectorAll('.header-top')).toHaveLength(1);
    expect(chips()).toEqual([]);
  });

  it('has no Interrupt button: Stop lives by the message box', () => {
    const header = render(instance('claude'));
    expect(header.querySelector('.btn-interrupt')).toBeNull();
    expect(header.textContent).not.toContain('Interrupt');
  });

  it('shows Auto-approve, Plan and Fast chips only when they differ from default', () => {
    render({ ...instance('claude'), status: 'idle', yoloMode: false, agentId: 'build', fastMode: false });
    expect(chips()).toEqual([]);
    render({ ...instance('claude'), status: 'idle', yoloMode: true, agentId: 'plan', fastMode: true });
    expect(chips()).toEqual(['Auto-approve', 'Plan', 'Fast']);
    render({ ...instance('claude'), status: 'idle', yoloMode: false, agentId: 'review' });
    expect(chips()).toEqual(['Review']);
    expect(fixture.nativeElement.textContent).not.toContain('YOLO');
  });

  it('keeps the queued Auto-approve flip in arrow wording on its chip', () => {
    render({ ...instance('claude'), yoloMode: true, pendingYoloMode: false });
    expect(chips()).toEqual(['Auto-approve → off after this reply']);
    render({ ...instance('claude'), yoloMode: false, pendingYoloMode: true });
    expect(chips()).toEqual(['Auto-approve → on after this reply']);
    expect(fixture.nativeElement.querySelector('.chip').classList.contains('pending')).toBe(true);
  });

  it('shows the Computer Use chip only when computerUseEnabled is on and the session differs from global', () => {
    const session = { ...instance('claude'), status: 'idle' } as Instance;
    settings = { computerUseEnabled: false, computerUseAutonomyLevel: 'trusted' };
    render({ ...session, computerUseMode: 'unrestricted' });
    expect(chips()).toEqual([]);
    settings = { computerUseEnabled: true, computerUseAutonomyLevel: 'trusted' };
    render({ ...session, computerUseMode: 'unrestricted' });
    expect(chips()).toEqual(['Desktop control: unrestricted']);
    render({ ...session, computerUseMode: 'trusted' });
    expect(chips()).toEqual([]);
    render(session);
    expect(chips()).toEqual([]);
    expect(fixture.nativeElement.querySelector('app-session-computer-use-control')).toBeNull();
  });

  it.each([true, false])('shows the session cost only while the cost setting is on (%s)', (enabled) => {
    showCost = enabled;
    render({ ...instance('claude'), contextUsage: { used: 10, total: 100, percentage: 10, occupancyReported: true, costEstimate: 12.34 } } as Instance);
    const cost = fixture.nativeElement.querySelector('.cost') as HTMLElement | null;
    expect(Boolean(cost)).toBe(enabled);
    if (cost) {
      expect(cost.textContent).toContain('≈$12.34');
      expect(cost.tabIndex).toBe(0);
    }
  });

  it('offers a Session options button that carries the mode, Auto-approve and Fast controls', () => {
    render(instance('claude'));
    const trigger = fixture.nativeElement.querySelector('app-session-options-menu button[aria-label="Session options"]') as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    trigger.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-session-options-menu [role="dialog"]')).not.toBeNull();
  });

  it('offers Terminal once, in the Open menu, not as its own icon', async () => {
    render({ ...instance('codex'), status: 'idle' });
    expect(fixture.nativeElement.querySelector('.btn-terminal')).toBeNull();
    (fixture.nativeElement.querySelector('.btn-open') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const items = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.open-menu-item')).map(item => item.textContent?.trim());
    expect(items).toContain('Open in Terminal');
    expect(items.filter(item => item === 'Open in Terminal')).toHaveLength(1);
  });

  it('keeps the remote computer chip only for a remote session', () => {
    expect(render(instance('claude')).querySelector('.node-badge')).toBeNull();
    const remote = render({ ...instance('claude'), executionLocation: { type: 'remote', nodeId: 'remote-1' } } as Instance);
    expect(remote.querySelector('.node-badge')).not.toBeNull();
  });

  it('opens session help from the header action cluster', () => {
    render(instance('codex'));
    const button = fixture.nativeElement.querySelector('.header-actions app-help-link button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Help: working in a session');
    button.click();
    expect(TestBed.inject(HelpDrawerService).target()).toEqual({ topic: 'session' });
  });

  it('explains the waiting state on a focusable hover', () => {
    render({ ...instance('codex'), waitReason: { kind: 'interrupt-ack', attempt: 2, startedAt: 0 } });
    const wait = fixture.debugElement.query(By.css('.wait-reason-label'));
    expect(wait.nativeElement.tabIndex).toBe(0);
    expect(wait.nativeElement.textContent).not.toContain('Attempt 2');
    expect(wait.injector.get(AioTooltipDirective).appTooltip()).toBe('Attempt 2');
    expect(fixture.nativeElement.querySelector('.header-action-detail')).toBeNull();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('updates formatted waiting details while their hint is open and removes it when waiting ends', () => {
    const retryAt = Date.UTC(2026, 10, 3, 10, 15, 30);
    render({ ...instance('codex'), waitReason: { kind: 'backoff', attempt: 2, retryAt } });
    const waiting = fixture.debugElement.query(By.css('.wait-reason-label'));
    const tooltip = waiting.injector.get(AioTooltipDirective);
    expect(waiting.nativeElement.tabIndex).toBe(0);
    tooltip.show();
    fixture.detectChanges();
    const linkedHint = (): HTMLElement | null => document.getElementById(
      waiting.nativeElement.getAttribute('aria-describedby'),
    );
    expect(linkedHint()?.textContent).toBe(`Attempt 2, retry at ${new Date(retryAt).toLocaleTimeString()}`);

    render({
      ...instance('codex'),
      waitReason: { kind: 'resume-proof', provider: 'codex', sessionId: 'session-12345', startedAt: retryAt },
    });
    expect(linkedHint()?.textContent).toBe('Session: session-…');

    render({ ...instance('codex'), waitReason: { kind: 'remote-heartbeat', nodeId: 'worker', staleForMs: 2_600 } });
    expect(linkedHint()?.textContent).toBe('No reply for 3s');

    render(instance('codex'));
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps quota and sign-in timing in their composer banners rather than showing a header hint', () => {
    const timestamp = Date.UTC(2026, 10, 3, 10, 15, 30);
    const time = new Date(timestamp).toLocaleTimeString();
    render({ ...instance('codex'), waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: timestamp } });
    expect(fixture.componentInstance.waitReasonDetail()).toBe(`Codex allowance resets at ${time}`);
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();

    render({ ...instance('codex'), waitReason: { kind: 'auth-required', provider: 'codex', since: timestamp } });
    expect(fixture.componentInstance.waitReasonDetail()).toBe(`Signed out of Codex since ${time}`);
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();
  });

  it('explains a missing folder on the Open control without opening anything', () => {
    render({ ...instance('codex'), workingDirectory: '' });
    const debug = fixture.debugElement.query(By.css('.btn-open'));
    const button = debug.nativeElement as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(debug.injector.get(AioTooltipDirective).appTooltipDisabledReason()).toBe('Choose a working folder first');
    button.click();
    expect(fixture.componentInstance.showOpenMenu()).toBe(false);
    render(instance('codex'));
    expect(fixture.nativeElement.querySelector('.btn-open').getAttribute('aria-disabled')).toBeNull();
  });
});
