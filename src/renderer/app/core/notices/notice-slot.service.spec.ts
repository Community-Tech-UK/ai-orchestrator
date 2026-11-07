import { signal } from '@angular/core';
import type { DestroyRef } from '@angular/core';
import { describe, expect, it } from 'vitest';
import { NoticeSlotService } from './notice-slot.service';

function life() {
  let cleanup = (): void => undefined;
  return { ref: { onDestroy: (fn: () => void) => { cleanup = fn; } } as DestroyRef, destroy: () => cleanup() };
}
describe('NoticeSlotService', () => {
  it('renders by priority, always renders blocking decisions and expands the rest', () => {
    const service = new NoticeSlotService();
    const update = service.register('app-update', signal(true), life().ref);
    const pauseVisible = signal(true);
    const pauseLife = life();
    const pause = service.register('pause', pauseVisible, pauseLife.ref);
    expect(update()).toBe(false);
    expect(pause()).toBe(true);
    const blocking = signal(false);
    const approval = service.register('permission-approvals', blocking, life().ref);
    const browser = service.register('browser-approvals', blocking, life().ref);
    blocking.set(true);
    expect(approval()).toBe(true);
    expect(browser()).toBe(true);
    expect(pause()).toBe(false);
    expect(service.hidden().map(n => n.label)).toEqual(['Paused', 'App update']);
    service.toggle();
    expect(update()).toBe(true);
    expect(pause()).toBe(true);
    service.toggle();
    blocking.set(false);
    pauseLife.destroy();
    expect(update()).toBe(true);
    expect(service.hidden()).toEqual([]);
  });
});
