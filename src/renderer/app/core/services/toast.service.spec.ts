import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastService } from './toast.service';
describe('action toast lifetime', () => {
  let service: ToastService;
  beforeEach(() => { vi.useFakeTimers(); TestBed.configureTestingModule({}); service = TestBed.inject(ToastService); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('keeps plain calls working and action toasts for five seconds', () => {
    service.show('Plain'); service.show('Undoable', 'success', { action: { label: 'Undo', run: vi.fn() } });
    vi.advanceTimersByTime(4000); expect(service.toasts().map((t) => t.text)).toEqual(['Undoable']);
    vi.advanceTimersByTime(1000); expect(service.toasts()).toEqual([]);
  });
  it('pauses for both focus and hover until both leave', () => {
    service.show('Paused', 'success', { action: { label: 'Undo', run: vi.fn() } });
    const id = service.toasts()[0].id;
    vi.advanceTimersByTime(1000); service.pause(id, 'hover'); service.pause(id, 'focus');
    vi.advanceTimersByTime(10_000); service.resume(id, 'hover'); vi.advanceTimersByTime(10_000);
    expect(service.toasts()).toHaveLength(1); service.resume(id, 'focus');
    vi.advanceTimersByTime(3999); expect(service.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1); expect(service.toasts()).toEqual([]);
  });
  it('replaces the same key and preserves action toasts beyond the plain cap', () => {
    service.show('Old', 'success', { key: 'undo:archive' });
    service.show('New', 'success', { key: 'undo:archive', action: { label: 'Undo', run: vi.fn() } });
    for (let i = 0; i < 5; i++) service.show(String(i));
    expect(service.toasts().some((t) => t.text === 'Old')).toBe(false);
    expect(service.toasts().some((t) => t.text === 'New')).toBe(true);
    expect(service.toasts().filter((t) => !t.action)).toHaveLength(3);
    service.dismissKey('undo:archive'); expect(service.toasts().some((t) => t.action)).toBe(false);
    service.dismissAll(); expect(service.toasts()).toEqual([]);
  });
});

describe('ToastService notices', () => {
  it('keeps errors, expires success at four seconds and warning at eight', () => {
    vi.useFakeTimers();
    const service = new ToastService();
    service.show('Error', 'error');
    service.show('Saved');
    service.show('Warning', 'warning');
    vi.advanceTimersByTime(3999);
    expect(service.toasts()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(service.toasts().map(t => t.text)).toEqual(['Error', 'Warning']);
    vi.advanceTimersByTime(4000);
    expect(service.toasts().map(t => t.text)).toEqual(['Error']);
  });
  it('folds keys, sorts errors first, caps visible rows and withdraws by key', () => {
    vi.useFakeTimers();
    const service = new ToastService();
    service.show('Saved');
    service.show('Warning', 'warning');
    service.show('Another');
    service.show('Broken', 'error', { key: 'error' });
    service.show('Broken again', 'error', { key: 'error' });
    expect(service.visibleToasts()).toHaveLength(3);
    expect(service.visibleToasts()[0]).toMatchObject({ text: 'Broken again', repeatCount: 2 });
    expect(service.overflowCount()).toBe(1);
    service.dismissKey('error');
    expect(service.toasts()).toHaveLength(3);
    service.dismissAll();
    expect(service.toasts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('dismisses only the notices on screen, so an error behind "+N more" is never lost unread', () => {
    vi.useFakeTimers();
    const service = new ToastService();
    for (const name of ['One', 'Two', 'Three', 'Four']) service.show(name, 'error');
    expect(service.visibleToasts().map(t => t.text)).toEqual(['One', 'Two', 'Three']);
    expect(service.overflowCount()).toBe(1);

    service.dismissVisible();

    expect(service.toasts().map(t => t.text)).toEqual(['Four']);
    expect(service.visibleToasts().map(t => t.text)).toEqual(['Four']);
    expect(service.overflowCount()).toBe(0);
  });
});
