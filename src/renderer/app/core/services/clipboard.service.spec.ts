import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ElectronIpcService } from './ipc/electron-ipc.service';
import { ClipboardServiceImpl } from './clipboard.service';
import { CLIPBOARD_TOAST } from './clipboard-toast.token';

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=';

describe('ClipboardServiceImpl', () => {
  let originalClipboard: typeof navigator.clipboard | undefined;

  beforeEach(() => {
    originalClipboard = (navigator as { clipboard?: typeof navigator.clipboard }).clipboard;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
    });
    TestBed.resetTestingModule();
  });

  it('copies text through navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });

    const result = await TestBed.inject(ClipboardServiceImpl).copyText('hello');

    expect(result).toEqual({ ok: true });
    expect(writeText).toHaveBeenCalledWith('hello');
  });

  it('treats empty text as a successful no-op', async () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });

    const result = await TestBed.inject(ClipboardServiceImpl).copyText('');

    expect(result).toEqual({ ok: true });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns unavailable when navigator.clipboard is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });

    const result = await TestBed.inject(ClipboardServiceImpl).copyText('hello');

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns permission-denied on NotAllowedError', async () => {
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });

    const result = await TestBed.inject(ClipboardServiceImpl).copyText('hello');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('permission-denied');
    }
  });

  it('returns unknown on arbitrary write failure', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('boom'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });

    const result = await TestBed.inject(ClipboardServiceImpl).copyText('hello');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown');
    }
  });

  it('updates lastResult after each call', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const service = TestBed.inject(ClipboardServiceImpl);

    expect(service.lastResult()).toBeNull();
    await service.copyText('a');
    expect(service.lastResult()).toEqual({ ok: true });
  });

  it('serializes JSON with default and custom indentation', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const service = TestBed.inject(ClipboardServiceImpl);

    await service.copyJSON({ a: 1 });
    expect(writeText).toHaveBeenLastCalledWith('{\n  "a": 1\n}');

    await service.copyJSON({ a: 1 }, { jsonIndent: 0 });
    expect(writeText).toHaveBeenLastCalledWith('{"a":1}');
  });

  it('returns unknown for JSON serialization failure', async () => {
    TestBed.configureTestingModule({ providers: [ClipboardServiceImpl] });
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;

    const result = await TestBed.inject(ClipboardServiceImpl).copyJSON(cyclic);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown');
    }
  });

  it('calls the optional toast adapter unless silent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const success = vi.fn();
    const error = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: CLIPBOARD_TOAST, useValue: { success, error } },
      ],
    });
    const service = TestBed.inject(ClipboardServiceImpl);

    await service.copyText('x', { label: 'message' });
    await service.copyText('x', { silent: true, label: 'message' });

    expect(success).toHaveBeenCalledOnce();
    expect(success).toHaveBeenCalledWith('message');
    expect(error).not.toHaveBeenCalled();
  });

  it('calls the optional toast error handler on failure', async () => {
    const error = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: CLIPBOARD_TOAST, useValue: { success: vi.fn(), error } },
      ],
    });

    await TestBed.inject(ClipboardServiceImpl).copyText('x', { label: 'message' });

    expect(error).toHaveBeenCalledWith('Failed to copy message: unavailable');
  });

  it('routes image copies through the existing image IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: ElectronIpcService, useValue: { invoke } },
      ],
    });
    const png = await fetch(ONE_PIXEL_PNG).then((response) => response.blob());

    const result = await TestBed.inject(ClipboardServiceImpl).copyImage(png);

    expect(result).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('image:copy-to-clipboard', {
      dataUrl: expect.stringMatching(/^data:image\/(png|jpeg)/),
    });
  });

  it('does not use navigator.clipboard.write for image copies', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    const write = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(), write },
      configurable: true,
    });
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: ElectronIpcService, useValue: { invoke } },
      ],
    });
    const png = await fetch(ONE_PIXEL_PNG).then((response) => response.blob());

    await TestBed.inject(ClipboardServiceImpl).copyImage(png);

    expect(write).not.toHaveBeenCalled();
  });

  it('returns unavailable when image IPC is unavailable', async () => {
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: ElectronIpcService, useValue: {} },
      ],
    });

    const result = await TestBed.inject(ClipboardServiceImpl).copyImage(new Blob([], { type: 'image/png' }));

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('returns unknown when image IPC fails', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: false, error: { message: 'boom' } });
    TestBed.configureTestingModule({
      providers: [
        ClipboardServiceImpl,
        { provide: ElectronIpcService, useValue: { invoke } },
      ],
    });
    const png = await fetch(ONE_PIXEL_PNG).then((response) => response.blob());

    const result = await TestBed.inject(ClipboardServiceImpl).copyImage(png);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown');
    }
  });
});
