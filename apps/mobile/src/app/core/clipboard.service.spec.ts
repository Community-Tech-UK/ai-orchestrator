import { Capacitor } from '@capacitor/core';
import { Clipboard } from '@capacitor/clipboard';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardService } from './clipboard.service';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock('@capacitor/clipboard', () => ({
  Clipboard: {
    write: vi.fn(),
  },
}));

describe('ClipboardService', () => {
  let service: ClipboardService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ClipboardService();
  });

  it('writes through the native clipboard on device', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Clipboard.write).mockResolvedValue(undefined);

    await expect(service.copy('hello')).resolves.toBe(true);
    expect(Clipboard.write).toHaveBeenCalledWith({ string: 'hello' });
  });

  it('falls back to the web clipboard API off-device', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await expect(service.copy('web text')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('web text');
    expect(Clipboard.write).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the platform denies the write', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    vi.mocked(Clipboard.write).mockRejectedValue(new Error('denied'));

    await expect(service.copy('nope')).resolves.toBe(false);
  });

  it('rejects empty payloads without touching the clipboard', async () => {
    await expect(service.copy('')).resolves.toBe(false);
    expect(Clipboard.write).not.toHaveBeenCalled();
  });
});
