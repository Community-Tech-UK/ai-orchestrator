import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, expect, it, vi } from 'vitest';
import { SessionStatusHostComponent } from './session-status-host.component';
import { SessionStatusService } from './session-status.service';
import { InstanceStore } from '../../../core/state/instance.store';
import { ProviderQuotaStore } from '../../../core/state/provider-quota.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { ProviderAccountIpcService } from '../../../core/services/ipc/provider-account-ipc.service';
import { CopilotAccountIpcService } from '../../../core/services/ipc/copilot-account-ipc.service';
describe('root session-status host', () => {
  it('opens the native dialog for the requested session and closes it through the shared service', async () => {
    const show = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
    const close = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
    const instanceId = signal<string | null>(null);
    const status = { instanceId, breakdown: signal(null), close: vi.fn(() => instanceId.set(null)) };
    try {
      TestBed.configureTestingModule({ imports: [SessionStatusHostComponent], providers: [
        { provide: SessionStatusService, useValue: status },
        { provide: InstanceStore, useValue: { getInstance: () => ({ id: 'i', displayName: 'Repair', provider: 'claude', currentModel: 'opus', lastActivity: Date.now(), yoloMode: false,
          agentId: 'build', contextUsage: { used: 0, total: 200000, percentage: 0 } }) } },
        { provide: ProviderQuotaStore, useValue: { snapshots: () => ({}), accountSnapshots: () => [] } },
        { provide: SettingsStore, useValue: { showCost: () => false, settings: () => ({ computerUseEnabled: false }) } },
        { provide: ProviderAccountIpcService, useValue: { list: async () => ({ profiles: [] }) } },
        { provide: CopilotAccountIpcService, useValue: { list: async () => [] } },
      ] });
      const fixture = TestBed.createComponent(SessionStatusHostComponent); fixture.detectChanges();
      instanceId.set('i'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('dialog').open).toBe(true);
      expect(fixture.nativeElement.querySelector('dialog').getAttribute('aria-label')).toBe('Session status');
      expect(fixture.nativeElement.textContent).toContain('Repair');
      expect(fixture.nativeElement.textContent).not.toContain('$');
      status.close(); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('dialog').open).toBe(false);
      fixture.destroy();
    } finally {
      if (show) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', show); else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)['showModal'];
      if (close) Object.defineProperty(HTMLDialogElement.prototype, 'close', close); else delete (HTMLDialogElement.prototype as unknown as Record<string, unknown>)['close'];
    }
  });
});
