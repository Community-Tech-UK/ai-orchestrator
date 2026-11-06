import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfirmService } from './confirm.service';

describe('ConfirmService', () => {
  it('resolves the active request and exposes default labels', async () => {
    const service = TestBed.inject(ConfirmService);
    const yes = service.confirm({ message: 'Continue?', confirmLabel: 'Continue' });
    expect(service.pending()).toMatchObject({ title: 'Confirm', cancelLabel: 'Cancel', danger: false });
    service.resolve(true);
    await expect(yes).resolves.toBe(true);
    expect(service.pending()).toBeNull();
    const no = service.confirm({ message: 'Delete?', confirmLabel: 'Delete', danger: true });
    service.resolve(false);
    await expect(no).resolves.toBe(false);
  });

  it('queues requests in order without resolving later callers early', async () => {
    const service = TestBed.inject(ConfirmService);
    const first = service.confirm({ message: 'First', confirmLabel: 'First' });
    const second = service.confirm({ message: 'Second', confirmLabel: 'Second' });
    expect(service.pending()?.message).toBe('First');
    service.resolve(false);
    await expect(first).resolves.toBe(false);
    expect(service.pending()?.message).toBe('Second');
    service.resolve(true);
    await expect(second).resolves.toBe(true);
  });

  it('cancels active and queued callers when the root dialog is destroyed', async () => {
    const service = TestBed.inject(ConfirmService);
    const first = service.confirm({ message: 'First', confirmLabel: 'First' });
    const second = service.confirm({ message: 'Second', confirmLabel: 'Second' });
    service.cancelAll();
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    expect(service.pending()).toBeNull();
  });
});
