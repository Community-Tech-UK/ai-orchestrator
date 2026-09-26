import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../../core/app-lock.service';
import type { MobileAutomationDto } from '../../core/models';
import { AutomationStore } from './automation.store';
import { AutomationsComponent } from './automations.component';
import { HostStore } from '../../core/host-store';
import { GatewayClient } from '../../core/gateway-client.service';

await resolveComponentResources(url => Promise.resolve(
  url.endsWith('automations.component.html')
    ? readFileSync(resolve('src/app/features/automations/automations.component.html'), 'utf8')
    : '',
));

const ITEM: MobileAutomationDto = {
  id: 'daily-review', name: 'Daily review', enabled: true, nextRunAt: 20,
  schedule: { type: 'cron', expression: '0 8 * * *', timezone: 'Europe/London' },
  lastRun: { status: 'failed', at: 10 }, provider: 'codex', model: 'gpt-5.4',
};

describe('AutomationsComponent', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = false; } });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });

  it.each(['recover', 'switch-host'])('retains a lost-response intent through a failed reconnect list until %s', async next => {
    const activeHost = signal({ id: 'a', name: 'Host A' });
    const gateway = { online: signal(true), dataHostId: signal('a'),
      automations: vi.fn<() => Promise<MobileAutomationDto[]>>().mockResolvedValue([ITEM]), runAutomation: vi.fn() };
    const keys: string[] = [];
    const fires = new Set<string>();
    gateway.runAutomation.mockImplementation(async (_id: string, key: string) => {
      keys.push(key); fires.add(key);
      if (keys.length === 1) throw new Error('Response lost after firing');
      return { status: 'started', runId: 'one-logical-run' };
    });
    TestBed.configureTestingModule({ imports: [AutomationsComponent], providers: [
      { provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(AutomationsComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const store = TestBed.inject(AutomationStore);
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    await fixture.whenStable(); fixture.detectChanges();
    gateway.online.set(false); fixture.detectChanges(); await fixture.whenStable();
    gateway.automations.mockRejectedValue(new Error('List temporarily unavailable'));
    gateway.online.set(true); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(store.status()).toBe('error');
    expect(root.querySelector('dialog')).not.toBeNull();
    expect(root.querySelector('dialog [role="alert"]')).not.toBeNull();
    const confirm = root.querySelector<HTMLButtonElement>('[data-confirm-run]')!;
    expect(confirm.disabled).toBe(true);
    confirm.click(); await store.runNow(ITEM);
    expect(keys).toHaveLength(1);
    if (next === 'switch-host') {
      activeHost.set({ id: 'b', name: 'Host B' });
      confirm.click(); fixture.detectChanges(); await fixture.whenStable();
      expect(root.querySelector('dialog')).toBeNull();
      expect(keys).toHaveLength(1);
      return;
    }
    let recover!: (items: MobileAutomationDto[]) => void;
    gateway.automations.mockImplementationOnce(() => new Promise(resolve => { recover = resolve; }));
    root.querySelector<HTMLButtonElement>('[data-refresh-automations]')!.click();
    fixture.detectChanges();
    expect(root.querySelector('dialog')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.disabled).toBe(true);
    const fresh = JSON.parse(JSON.stringify(ITEM)) as MobileAutomationDto;
    recover([fresh]); await vi.waitFor(() => expect(store.status()).toBe('loaded'));
    fixture.detectChanges(); await fixture.whenStable();
    expect(store.automations()[0]).not.toBe(ITEM);
    expect(root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.disabled).toBe(false);
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(fires.size).toBe(1);
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('closes a host-A confirmation on host change and a stale confirm click sends no request', async () => {
    const activeHost = signal({ id: 'a', name: 'Host A' });
    const dataHostId = signal('a');
    const gateway = { online: signal(true), dataHostId, automations: vi.fn().mockResolvedValue([ITEM]), runAutomation: vi.fn().mockResolvedValue({ status: 'started', runId: 'run' }) };
    TestBed.configureTestingModule({ imports: [AutomationsComponent], providers: [
      { provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(AutomationsComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click(); fixture.detectChanges(); await fixture.whenStable();
    const confirm = root.querySelector<HTMLButtonElement>('[data-confirm-run]')!;
    activeHost.set({ id: 'b', name: 'Host B' }); dataHostId.set('b');
    confirm.click();
    expect(gateway.runAutomation).not.toHaveBeenCalled();
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('requires confirmation before run-now and renders status without create/edit affordances', async () => {
    const runNow = vi.fn().mockResolvedValue(true);
    const cancelRun = vi.fn();
    TestBed.configureTestingModule({ imports: [AutomationsComponent], providers: [
      { provide: AutomationStore, useValue: {
        automations: signal([ITEM]), status: signal('loaded'), online: signal(true), hasCurrentList: signal(true),
        hostId: signal('a'), hostName: signal('Studio'), runNow, cancelRun, running: vi.fn(() => false),
        feedbackFor: vi.fn(() => 'Started'), refresh: vi.fn(),
      } },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(AutomationsComponent); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Daily review');
    expect(root.textContent).toContain('Failed');
    expect(root.textContent).toContain('gpt-5.4');
    expect(root.querySelector('[aria-label="Create automation"]')).toBeNull();
    expect(root.querySelector('[aria-label="Edit automation"]')).toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    expect(runNow).not.toHaveBeenCalled();
    expect(root.querySelector('dialog[aria-label="Run Daily review?"]')).not.toBeNull();
    [...root.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Cancel')!.click();
    fixture.detectChanges();
    expect(cancelRun).toHaveBeenCalledTimes(2);
    expect(root.querySelector('dialog')).toBeNull();
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click(); fixture.detectChanges(); await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    await fixture.whenStable(); fixture.detectChanges();
    expect(runNow).toHaveBeenCalledWith(ITEM);
    expect(root.textContent).toContain('Started');
  });

  it('retains confirmation and its lost-response key across same-host reconnect with fresh JSON objects', async () => {
    const activeHost = signal({ id: 'a', name: 'Host A' });
    const gateway = { online: signal(true), dataHostId: signal('a'),
      automations: vi.fn(async () => JSON.parse(JSON.stringify([ITEM])) as MobileAutomationDto[]),
      runAutomation: vi.fn(),
    };
    const keys: string[] = [];
    const fires = new Set<string>();
    let finishRetry!: () => void;
    gateway.runAutomation.mockImplementation(async (_id: string, key: string) => {
      keys.push(key); fires.add(key);
      if (keys.length === 1) throw new Error('Response lost after firing');
      await new Promise<void>(resolve => { finishRetry = resolve; });
      return { status: 'started', runId: 'one-run' };
    });
    TestBed.configureTestingModule({ imports: [AutomationsComponent], providers: [
      { provide: HostStore, useValue: { activeHost } }, { provide: GatewayClient, useValue: gateway },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(AutomationsComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const store = TestBed.inject(AutomationStore);
    const original = store.automations()[0];
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    await fixture.whenStable(); fixture.detectChanges();
    gateway.online.set(false); fixture.detectChanges(); await fixture.whenStable();
    gateway.online.set(true); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(store.automations()[0]).not.toBe(original);
    expect(root.querySelector('dialog')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    // A further same-host refresh while the response is pending also rebinds.
    await store.refresh(); fixture.detectChanges();
    finishRetry();
    await vi.waitFor(() => expect(store.feedbackFor(ITEM.id)).toBe('Started'));
    await fixture.whenStable(); fixture.detectChanges();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]); expect(fires.size).toBe(1);
    expect(root.querySelector('dialog')).toBeNull();
  });

  it.each(['removed', 'disabled'])('cancels a confirmation when the refreshed automation is %s', async change => {
    const gateway = { online: signal(true), dataHostId: signal('a'),
      automations: vi.fn<() => Promise<MobileAutomationDto[]>>().mockResolvedValue([ITEM]),
      runAutomation: vi.fn().mockRejectedValue(new Error('Uncertain result')) };
    TestBed.configureTestingModule({ imports: [AutomationsComponent], providers: [
      { provide: HostStore, useValue: { activeHost: signal({ id: 'a', name: 'Host A' }) } },
      { provide: GatewayClient, useValue: gateway },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(AutomationsComponent);
    fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const store = TestBed.inject(AutomationStore);
    root.querySelector<HTMLButtonElement>('[aria-label="Run Daily review now"]')!.click();
    fixture.detectChanges(); await fixture.whenStable();
    root.querySelector<HTMLButtonElement>('[data-confirm-run]')!.click();
    await fixture.whenStable();
    const oldKey = gateway.runAutomation.mock.calls[0][1];
    gateway.automations.mockResolvedValue(change === 'removed' ? [] : [{ ...ITEM, enabled: false }]);
    await store.refresh(); fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('dialog')).toBeNull();
    expect(store.feedbackFor(ITEM.id)).toBeNull();
    gateway.automations.mockResolvedValue([{ ...ITEM }]); await store.refresh();
    await store.runNow(store.automations()[0]);
    expect(gateway.runAutomation.mock.calls[1][1]).not.toBe(oldKey);
  });
});
