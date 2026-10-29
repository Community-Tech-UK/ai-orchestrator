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

  it('shows the full waiting detail visibly and keeps locked controls focusable without emitting actions', () => {
    fixture.componentRef.setInput('instance', { ...instance('codex'), waitReason: { kind: 'interrupt-ack', attempt: 2 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.wait-reason-detail').textContent).toBe('Attempt 2');
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
    expect(document.getElementById(mode.getAttribute('aria-describedby')!)?.textContent).toContain('Cannot change mode while instance is running or recovering');
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
  it.each([true, false])('allows the cost setting to control the header cost (%s)', (enabled) => {
    showCost = enabled;
    fixture.componentRef.setInput('instance', instance('claude'));
    fixture.componentRef.setInput('contextUsage', { used: 10, total: 100, percentage: 10, occupancyReported: true, costEstimate: 12.34 });
    fixture.detectChanges();
    expect(Boolean(fixture.nativeElement.querySelector('.cost'))).toBe(enabled);
  });
});
