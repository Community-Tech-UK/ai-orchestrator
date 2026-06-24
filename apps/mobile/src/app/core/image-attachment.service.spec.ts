import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { Clipboard } from '@capacitor/clipboard';
import { ImageAttachmentService } from './image-attachment.service';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
  },
}));

vi.mock('@capacitor/camera', () => ({
  Camera: {
    pickImages: vi.fn(),
  },
}));

vi.mock('@capacitor/clipboard', () => ({
  Clipboard: {
    read: vi.fn(),
  },
}));

type TestableImageAttachmentService = ImageAttachmentService & {
  downscaleToJpegDataUrl(blob: Blob): Promise<string>;
};

const jpegDataUrl = 'data:image/jpeg;base64,QUJD';

describe('ImageAttachmentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
  });

  it('reads an image data URL from the native clipboard as an attachment', async () => {
    vi.mocked(Clipboard.read).mockResolvedValue({
      type: 'image',
      value: 'data:image/png;base64,UE5H',
    });
    const service = new ImageAttachmentService();
    const downscale = vi
      .spyOn(service as TestableImageAttachmentService, 'downscaleToJpegDataUrl')
      .mockResolvedValue(jpegDataUrl);

    const attachment = await service.pasteImageFromClipboard();

    expect(Clipboard.read).toHaveBeenCalledTimes(1);
    expect(downscale.mock.calls[0]?.[0].type).toBe('image/png');
    expect(downscale.mock.calls[0]?.[0].size).toBe(3);
    expect(attachment).toMatchObject({
      type: 'image/jpeg',
      size: 3,
      data: jpegDataUrl,
    });
    expect(attachment?.name).toMatch(/^clipboard-\d+\.jpg$/);
  });

  it('ignores non-image native clipboard content', async () => {
    vi.mocked(Clipboard.read).mockResolvedValue({
      type: 'text/plain',
      value: 'not an image',
    });
    const service = new ImageAttachmentService();
    const downscale = vi
      .spyOn(service as TestableImageAttachmentService, 'downscaleToJpegDataUrl')
      .mockResolvedValue(jpegDataUrl);

    await expect(service.pasteImageFromClipboard()).resolves.toBeNull();

    expect(downscale).not.toHaveBeenCalled();
  });

  it('converts image files from a paste event and prevents the browser text paste', async () => {
    const service = new ImageAttachmentService();
    vi.spyOn(service as TestableImageAttachmentService, 'downscaleToJpegDataUrl')
      .mockResolvedValue(jpegDataUrl);
    const preventDefault = vi.fn();
    const image = new File(['png'], 'screenshot.png', { type: 'image/png' });
    const event = {
      clipboardData: {
        files: [image],
        items: [],
      },
      preventDefault,
    } as unknown as ClipboardEvent;

    const attachments = await service.attachmentsFromPasteEvent(event);

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(attachments).toEqual([
      {
        name: 'screenshot.jpg',
        type: 'image/jpeg',
        size: 3,
        data: jpegDataUrl,
      },
    ]);
  });

  it('leaves plain text paste events alone', async () => {
    const service = new ImageAttachmentService();
    const preventDefault = vi.fn();
    const event = {
      clipboardData: {
        files: [],
        items: [],
      },
      preventDefault,
    } as unknown as ClipboardEvent;

    await expect(service.attachmentsFromPasteEvent(event)).resolves.toEqual([]);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('still picks camera-roll images through Capacitor Camera', async () => {
    vi.mocked(Camera.pickImages).mockResolvedValue({
      photos: [{ webPath: 'data:image/png;base64,UE5H' }],
    });
    const service = new ImageAttachmentService();
    vi.spyOn(service as TestableImageAttachmentService, 'downscaleToJpegDataUrl')
      .mockResolvedValue(jpegDataUrl);

    const attachments = await service.pickImages();

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.name).toMatch(/^photo-\d+-1\.jpg$/);
  });
});
