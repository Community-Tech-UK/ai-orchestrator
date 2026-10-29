import { ChangeDetectionStrategy, Component, computed, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ComposerQueueComponent } from './composer-queue.component';
import { QueuePersistenceService } from '../../core/state/instance/queue-persistence.service';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import { ToastService } from '../../core/services/toast.service';
import type { QueuedMessage } from '../../core/state/instance/instance.types';

const directory = dirname(fileURLToPath(import.meta.url));
await resolveComponentResources(url => Promise.resolve(
  url.endsWith('composer-queue.component.html') || url.endsWith('composer-queue.component.scss')
    ? readFileSync(resolve(directory, url), 'utf8') : '',
));
const queues = signal(new Map<string, QueuedMessage[]>());
@Component({ changeDetection: ChangeDetectionStrategy.OnPush, imports: [ComposerQueueComponent], template: '<app-composer-queue [messages]="messages()" />' })
class QueueHost {
  readonly messages = computed(() => queues().get('session') ?? []);
}

describe('queue durability warning through the renderer signal chain', () => {
  it('removes the unsaved marker after durable save without replacing the entry identity', async () => {
    const entry: QueuedMessage = { message: 'keep this message' };
    queues.set(new Map([['session', [entry]]]));
    let finish!: (value: unknown) => void;
    const queueEnqueue = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [QueueHost], providers: [
        { provide: InstanceStateService, useValue: { messageQueue: queues } },
        { provide: InstanceIpcService, useValue: { queueEnqueue } },
        { provide: SettingsStore, useValue: { isInitialized: () => true, get: () => true } },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    }).compileComponents();
    const saving = TestBed.inject(QueuePersistenceService).notifyEnqueued('session', entry, 'back');
    const fixture = TestBed.createComponent(QueueHost);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.queued-drop-warning')?.textContent).toContain('not saved');
    finish({ success: true, data: { admissionId: 'saved-message' } });
    await saving;
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.queued-drop-warning')).toBeNull();
    expect(queues().get('session')?.[0]).toBe(entry);
    fixture.destroy();
  });
});
