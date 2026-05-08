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

  describe('copyMessage', () => {
    it('falls back to copyText when no images are attached', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const invoke = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({ text: 'hello' });

      expect(result).toEqual({ ok: true });
      expect(writeText).toHaveBeenCalledWith('hello');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('skips empty-array attachments and still uses the text path', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const invoke = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({ text: 'hi', images: [] });

      expect(result).toEqual({ ok: true });
      expect(writeText).toHaveBeenCalledWith('hi');
      expect(invoke).not.toHaveBeenCalled();
    });

    it('routes through image:copy-message with text + html + first image when attachments are present', async () => {
      const invoke = vi.fn().mockResolvedValue({ success: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: 'check this',
        images: [
          { dataUrl: ONE_PIXEL_PNG, name: 'pixel.png' },
          { dataUrl: ONE_PIXEL_PNG, name: 'second.png' },
        ],
      });

      expect(result).toEqual({ ok: true });
      expect(invoke).toHaveBeenCalledTimes(1);
      const [channel, payload] = invoke.mock.calls[0];
      expect(channel).toBe('image:copy-message');
      expect(payload.text).toBe('check this');
      // HTML must include the prose AND every image, not just the first
      expect(payload.html).toContain('<p>check this</p>');
      expect((payload.html.match(/<img /g) ?? []).length).toBe(2);
      expect(payload.html).toContain('alt="pixel.png"');
      expect(payload.html).toContain('alt="second.png"');
      // image slot uses the first attachment, in PNG/JPEG form
      expect(payload.imageDataUrl).toMatch(/^data:image\/(png|jpeg)/);
    });

    it('escapes HTML-special characters in the text body and image filenames', async () => {
      const invoke = vi.fn().mockResolvedValue({ success: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: '<script>alert("x")</script> & done',
        images: [{ dataUrl: ONE_PIXEL_PNG, name: '<x>"y".png' }],
      });

      const payload = invoke.mock.calls[0][1] as { html: string };
      expect(payload.html).not.toContain('<script>');
      expect(payload.html).toContain('&lt;script&gt;');
      expect(payload.html).toContain('&amp;');
      expect(payload.html).toContain('&quot;');
      // Filename should be escaped inside the alt attribute
      expect(payload.html).toContain('alt="&lt;x&gt;&quot;y&quot;.png"');
    });

    it('preserves line breaks in the HTML body', async () => {
      const invoke = vi.fn().mockResolvedValue({ success: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: 'line one\nline two',
        images: [{ dataUrl: ONE_PIXEL_PNG }],
      });

      const payload = invoke.mock.calls[0][1] as { html: string };
      expect(payload.html).toContain('line one<br/>line two');
    });

    it('drops attachments that are not image data URLs', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      const invoke = vi.fn();
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
        ],
      });

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: 'hi',
        images: [{ dataUrl: 'data:application/pdf;base64,AAAA' }],
      });

      // Filtered down to zero images → falls back to text-only path
      expect(result).toEqual({ ok: true });
      expect(invoke).not.toHaveBeenCalled();
      expect(writeText).toHaveBeenCalledWith('hi');
    });

    it('returns unavailable when image IPC is missing but the message has images', async () => {
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: {} },
        ],
      });

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: 'no electron',
        images: [{ dataUrl: ONE_PIXEL_PNG }],
      });

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

      const result = await TestBed.inject(ClipboardServiceImpl).copyMessage({
        text: 'x',
        images: [{ dataUrl: ONE_PIXEL_PNG }],
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('unknown');
      }
    });

    it('emits a success toast via the configured adapter unless silent', async () => {
      const invoke = vi.fn().mockResolvedValue({ success: true });
      const success = vi.fn();
      const error = vi.fn();
      TestBed.configureTestingModule({
        providers: [
          ClipboardServiceImpl,
          { provide: ElectronIpcService, useValue: { invoke } },
          { provide: CLIPBOARD_TOAST, useValue: { success, error } },
        ],
      });

      const service = TestBed.inject(ClipboardServiceImpl);
      await service.copyMessage(
        { text: 'x', images: [{ dataUrl: ONE_PIXEL_PNG }] },
      );
      await service.copyMessage(
        { text: 'x', images: [{ dataUrl: ONE_PIXEL_PNG }] },
        { silent: true },
      );

      expect(success).toHaveBeenCalledOnce();
      expect(success).toHaveBeenCalledWith('message');
      expect(error).not.toHaveBeenCalled();
    });
  });
});
