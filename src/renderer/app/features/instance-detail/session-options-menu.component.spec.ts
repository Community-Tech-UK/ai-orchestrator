import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { InstanceStore, type Instance } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SessionOptionsMenuComponent } from './session-options-menu.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources((url) => Promise.resolve(readFileSync(resolve(specDirectory, `./${url.split('/').pop()}`), 'utf8')));

describe('SessionOptionsMenuComponent', () => {
  let settings: Record<string, unknown> = {};
  const fastUnavailableProviders = signal<ReadonlySet<string>>(new Set());
  const navigate = vi.fn(async () => true);

  beforeEach(() => {
    settings = {};
    fastUnavailableProviders.set(new Set());
    navigate.mockClear();
    TestBed.configureTestingModule({
      imports: [SessionOptionsMenuComponent],
      providers: [
        { provide: SettingsStore, useValue: { settings: () => settings, showCost: () => true } },
        { provide: InstanceStore, useValue: { fastUnavailableProviders } },
        { provide: RemoteNodeStore, useValue: { nodeById: (id: string) => id === 'node-1' ? { name: 'Windows PC' } : undefined } },
        { provide: Router, useValue: { navigate } },
        { provide: ElectronIpcService, useValue: { getApi: () => undefined } },
      ],
    });
  });

  const session = (overrides: Partial<Instance> = {}): Instance =>
    ({ id: 'inst-1', provider: 'claude', status: 'idle', displayName: 'Session', ...overrides }) as Instance;

  function open(instance: Instance, inputs: Record<string, unknown> = {}) {
    const fixture = TestBed.createComponent(SessionOptionsMenuComponent);
    fixture.componentRef.setInput('instance', instance);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.trigger') as HTMLButtonElement).click();
    fixture.detectChanges();
    return fixture;
  }
  const option = (fixture: { nativeElement: HTMLElement }, label: string): HTMLButtonElement | undefined =>
    Array.from(fixture.nativeElement.querySelectorAll<HTMLButtonElement>('.option button')).find(b => b.textContent?.trim().startsWith(label));

  it('is a labelled button that opens a dialog and closes on Escape, giving focus back', () => {
    const fixture = open(session());
    const trigger = fixture.nativeElement.querySelector('.trigger') as HTMLButtonElement;
    expect(trigger.getAttribute('aria-label')).toBe('Session options');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).not.toBeNull();
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    fixture.nativeElement.querySelector('[role="dialog"]').dispatchEvent(escape);
    fixture.detectChanges();
    expect(escape.defaultPrevented).toBe(true);
    expect(fixture.nativeElement.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('changes mode, Auto-approve and Fast through the same outputs the header used', () => {
    const fixture = open(session({ agentId: 'plan' }));
    const events: string[] = [];
    fixture.componentInstance.cycleAgentMode.subscribe(() => events.push('mode'));
    fixture.componentInstance.toggleYolo.subscribe(() => events.push('yolo'));
    fixture.componentInstance.toggleFastMode.subscribe(() => events.push('fast'));
    expect(fixture.nativeElement.textContent).toContain('Click to switch to Review');
    option(fixture, 'Mode: Plan')!.click();
    option(fixture, 'Auto-approve: off')!.click();
    option(fixture, 'Fast: off')!.click();
    expect(events).toEqual(['mode', 'yolo', 'fast']);
  });

  it('holds mode and Fast while a turn runs, and Auto-approve while the session is starting', () => {
    const busy = open(session({ status: 'busy' }));
    const events: string[] = [];
    busy.componentInstance.cycleAgentMode.subscribe(() => events.push('mode'));
    busy.componentInstance.toggleFastMode.subscribe(() => events.push('fast'));
    busy.componentInstance.toggleYolo.subscribe(() => events.push('yolo'));
    for (const label of ['Mode:', 'Fast:']) {
      const button = option(busy, label)!;
      expect(button.getAttribute('aria-disabled')).toBe('true');
      button.click();
    }
    option(busy, 'Auto-approve')!.click();
    expect(events).toEqual(['yolo']);

    const starting = open(session({ status: 'initializing' }));
    starting.componentInstance.toggleYolo.subscribe(() => events.push('starting-yolo'));
    expect(option(starting, 'Auto-approve')!.getAttribute('aria-disabled')).toBe('true');
    option(starting, 'Auto-approve')!.click();
    expect(events).toEqual(['yolo']);
  });

  it('offers Fast for Claude and Codex only', () => {
    expect(option(open(session({ provider: 'codex' })), 'Fast')).toBeDefined();
    expect(option(open(session({ provider: 'gemini' })), 'Fast')).toBeUndefined();
  });

  it('shows what Auto-approve would cost, and a queued flip in arrow wording', () => {
    const fixture = open(session({ yoloMode: true, pendingYoloMode: false }), { yoloCostNote: 'The next message will re-read about 230K tokens at full price.' });
    expect(fixture.nativeElement.querySelector('.header-action-detail').textContent).toContain('230K tokens at full price');
    expect(fixture.nativeElement.textContent).toContain('Auto-approve → off after this reply');
  });

  it('shows the Computer Use choice, with its lifecycle as visible text, only when the feature is on', () => {
    const off = open(session());
    expect(off.nativeElement.querySelector('app-session-computer-use-control')).toBeNull();
    settings = { computerUseEnabled: true, computerUseAutonomyLevel: 'trusted' };
    const on = open(session());
    expect(on.nativeElement.querySelector('app-session-computer-use-control select')).not.toBeNull();
    expect(on.nativeElement.textContent).toContain('Applies to the next call, no restart, this session only');
    expect(on.nativeElement.querySelector('.computer-use-lifecycle[hidden]')).not.toBeNull();
  });

  it('says in one visible sentence what the session may do', () => {
    const text = (fixture: { nativeElement: HTMLElement }) => fixture.nativeElement.querySelector('.posture')?.textContent?.trim();
    expect(text(open(session({ agentId: 'build', yoloMode: true, hardened: true })))).toBe('Acts without asking · edits only inside this folder · web allowed');
    expect(text(open(session({ agentId: 'plan' })))).toBe('Asks before acting · read-only · web allowed');
    expect(text(open(session({ agentId: 'build', executionLocation: { type: 'remote', nodeId: 'node-1' } } as Partial<Instance>)))).toBe('Asks before acting · can edit files · web allowed · runs on Windows PC');
    expect(text(open(session({ agentId: 'custom' })))).toBe('Asks before acting · permissions set by the Custom mode');
  });

  it('puts what Auto-approve and Fast do in visible text, without the old words', () => {
    const fixture = open(session());
    const content = fixture.nativeElement.textContent as string;
    expect(content).toContain('Runs tools and edits without asking you');
    expect(content).toContain('Faster replies at some capability cost');
    expect(content).not.toMatch(/YOLO|ON\/OFF|N\/A/);
  });

  it('keeps saying Fast is not available once the provider has refused it', () => {
    fastUnavailableProviders.set(new Set(['copilot']));
    const fixture = open(session({ provider: 'copilot' }));
    expect(fixture.nativeElement.textContent).toContain('Fast: not available for Copilot');
    expect(option(fixture, 'Fast')).toBeUndefined();
    fastUnavailableProviders.set(new Set());
    fixture.detectChanges();
    expect(option(open(session({ provider: 'claude' })), 'Fast: off')).toBeDefined();
  });

  it('says desktop control is off in Settings, with a link to that tab, instead of an enabled select', () => {
    const fixture = open(session());
    expect(fixture.nativeElement.textContent).toContain('Desktop control: off in Settings');
    expect(fixture.nativeElement.querySelector('app-session-computer-use-control')).toBeNull();
    (fixture.nativeElement.querySelector('.link') as HTMLButtonElement).click();
    expect(navigate).toHaveBeenCalledWith(['/settings'], { queryParams: { tab: 'computer-use' } });
  });
});
