import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { KeybindingService } from '../../core/services/keybinding.service';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceHeaderComponent } from './instance-header.component';
import { SkillStore } from '../../core/state/skill.store';
import { HookStore } from '../../core/state/hook.store';
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

describe('InstanceHeaderComponent interrupt tooltip', () => {
  let fixture: ComponentFixture<InstanceHeaderComponent>;
  let showCost = true;

  beforeEach(async () => {
    showCost = true;
    await TestBed.configureTestingModule({
      imports: [InstanceHeaderComponent],
      providers: [
        { provide: KeybindingService, useValue: { formatBindingByAction: () => 'Escape', ariaShortcutsByAction: () => 'Escape' } },
        { provide: SettingsStore, useValue: { showCost: () => showCost, settings: () => ({}), update: vi.fn() } },
        { provide: InstanceStore, useValue: { getInstance: () => undefined } },
        {
          provide: SkillStore,
          useValue: {
            activeSkillCount: () => 0,
            activations: () => [],
            controlModeFor: () => 'enabled',
            discoverSkills: vi.fn(),
          },
        },
        { provide: HookStore, useValue: { enabledHookCount: () => 0, loadHooks: vi.fn() } },
        { provide: FileIpcService, useValue: {} },
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

  it('names the session provider instead of always saying Claude', () => {
    fixture.componentRef.setInput('instance', instance('codex'));
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.btn-interrupt') as HTMLButtonElement;
    const hint = fixture.debugElement.query(By.css('.btn-interrupt')).injector.get(AioTooltipDirective);
    expect(hint.appTooltip()).toBe('Interrupt Codex');
    expect(hint.appTooltipShortcut()).toBe('cancel-operation');
    expect(button.hasAttribute('title')).toBe(false);
  });

  it('shows measured Copilot premium usage and explicitly marks missing data unavailable', () => {
    fixture.componentRef.setInput('instance', instance('copilot'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Premium requests used: unavailable');
    fixture.componentRef.setInput('contextUsage', { used: 0, total: 0, percentage: 0, copilotUsage: { compactions: 0, premiumRequests: 15.5 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Premium requests used: 15.5');
    fixture.componentRef.setInput('instance', instance('claude'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('Premium requests used:');
  });

  it('explains the waiting state on a focusable hover and keeps locked controls focusable without emitting actions', () => {
    fixture.componentRef.setInput('instance', { ...instance('codex'), waitReason: { kind: 'interrupt-ack', attempt: 2 } });
    fixture.detectChanges();
    const wait = fixture.debugElement.query(By.css('.wait-reason-label'));
    expect(wait.nativeElement.tabIndex).toBe(0);
    expect(wait.nativeElement.textContent).not.toContain('Attempt 2');
    expect(wait.injector.get(AioTooltipDirective).appTooltip()).toBe('Attempt 2');
    const header = fixture.nativeElement as HTMLElement;
    expect(header.querySelector('.header-action-detail')).toBeNull();
    const changed = vi.fn();
    fixture.componentInstance.cycleAgentMode.subscribe(changed);
    const mode = fixture.nativeElement.querySelector('.mode-badge') as HTMLButtonElement;
    expect(mode.disabled).toBe(false);
    expect(mode.getAttribute('aria-disabled')).toBe('true');
    mode.click();
    expect(changed).not.toHaveBeenCalled();
    const original = mode.matches.bind(mode);
    vi.spyOn(mode, 'matches').mockImplementation(selector => selector === ':focus-visible' || original(selector));
    mode.dispatchEvent(new FocusEvent('focus'));
    fixture.detectChanges();
    expect(document.getElementById(mode.getAttribute('aria-describedby')!)?.textContent).toContain('Cannot change mode while the session is running or recovering');
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
  });

  it('opens session help from the header action cluster', () => {
    fixture.componentRef.setInput('instance', instance('codex'));
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.header-actions app-help-link button') as HTMLButtonElement;
    expect(button.getAttribute('aria-label')).toBe('Help: working in a session');
    button.click();
    expect(TestBed.inject(HelpDrawerService).target()).toEqual({ topic: 'session' });
  });

  it('updates formatted waiting details while their hint is open and removes it when waiting ends', () => {
    const retryAt = Date.UTC(2026, 10, 3, 10, 15, 30);
    fixture.componentRef.setInput('instance', {
      ...instance('codex'), waitReason: { kind: 'backoff', attempt: 2, retryAt },
    });
    fixture.detectChanges();
    const waiting = fixture.debugElement.query(By.css('.wait-reason-label'));
    const tooltip = waiting.injector.get(AioTooltipDirective);
    expect(waiting.nativeElement.tabIndex).toBe(0);
    tooltip.show();
    fixture.detectChanges();
    const linkedHint = (): HTMLElement | null => document.getElementById(
      waiting.nativeElement.getAttribute('aria-describedby'),
    );
    expect(linkedHint()?.textContent).toBe(`Attempt 2, retry at ${new Date(retryAt).toLocaleTimeString()}`);

    fixture.componentRef.setInput('instance', {
      ...instance('codex'),
      waitReason: { kind: 'resume-proof', provider: 'codex', sessionId: 'session-12345', startedAt: retryAt },
    });
    fixture.detectChanges();
    expect(linkedHint()?.textContent).toBe('Session: session-…');

    fixture.componentRef.setInput('instance', {
      ...instance('codex'), waitReason: { kind: 'remote-heartbeat', nodeId: 'worker', staleForMs: 2_600 },
    });
    fixture.detectChanges();
    expect(linkedHint()?.textContent).toBe('Node: worker, stale for 3s');

    fixture.componentRef.setInput('instance', instance('codex'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps quota and sign-in timing in their composer banners rather than showing a header hint', () => {
    const timestamp = Date.UTC(2026, 10, 3, 10, 15, 30);
    const time = new Date(timestamp).toLocaleTimeString();
    fixture.componentRef.setInput('instance', {
      ...instance('codex'), waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: timestamp },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.waitReasonDetail()).toBe(`Provider: codex, resumes at ${time}`);
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();

    fixture.componentRef.setInput('instance', {
      ...instance('codex'), waitReason: { kind: 'auth-required', provider: 'codex', since: timestamp },
    });
    fixture.detectChanges();
    expect(fixture.componentInstance.waitReasonDetail()).toBe(`Signed out of codex since ${time}`);
    expect(fixture.nativeElement.querySelector('.wait-reason-label')).toBeNull();
  });

  it('keeps a locked mode reachable, explains it, and permits a change after the turn finishes', () => {
    fixture.componentRef.setInput('instance', instance('claude'));
    fixture.detectChanges();
    const changed = vi.fn();
    fixture.componentInstance.cycleAgentMode.subscribe(changed);
    const debug = fixture.debugElement.query(By.css('.mode-badge'));
    const button = debug.nativeElement as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    const tooltip = debug.injector.get(AioTooltipDirective);
    tooltip.show();
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('running or recovering');
    tooltip.hide();
    button.click();
    expect(changed).not.toHaveBeenCalled();

    fixture.componentRef.setInput('instance', { ...instance('claude'), status: 'idle' });
    fixture.detectChanges();
    expect(button.getAttribute('aria-disabled')).toBeNull();
    button.click();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('explains a missing folder on both workspace controls without opening anything', () => {
    fixture.componentRef.setInput('instance', { ...instance('codex'), workingDirectory: '' });
    fixture.detectChanges();
    for (const selector of ['.btn-open', '.btn-terminal']) {
      const debug = fixture.debugElement.query(By.css(selector));
      const button = debug.nativeElement as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.getAttribute('aria-disabled')).toBe('true');
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(debug.injector.get(AioTooltipDirective).appTooltipDisabledReason()).toBe('Choose a working folder first');
      button.click();
    }
    expect(fixture.componentInstance.showOpenMenu()).toBe(false);
    fixture.componentRef.setInput('instance', instance('codex'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.btn-open').getAttribute('aria-disabled')).toBeNull();
    expect(fixture.nativeElement.querySelector('.btn-terminal').getAttribute('aria-disabled')).toBeNull();
  });
  it.each([true, false])('allows the cost setting to control the header cost (%s)', (enabled) => {
    showCost = enabled;
    fixture.componentRef.setInput('instance', instance('claude'));
    fixture.componentRef.setInput('contextUsage', { used: 10, total: 100, percentage: 10, occupancyReported: true, costEstimate: 12.34 });
    fixture.detectChanges();
    expect(Boolean(fixture.nativeElement.querySelector('.cost'))).toBe(enabled);
  });
});
