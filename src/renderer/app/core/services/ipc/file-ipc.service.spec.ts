import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from './electron-ipc.service';
import { FileIpcService } from './file-ipc.service';

describe('FileIpcService', () => {
  let invoke: ReturnType<typeof vi.fn>;
  let api: { imageConvertHeic: ReturnType<typeof vi.fn> } | null;
  let service: FileIpcService;

  beforeEach(() => {
    invoke = vi.fn().mockResolvedValue({ success: true });
    api = null;

    TestBed.configureTestingModule({
      providers: [
        FileIpcService,
        {
          provide: ElectronIpcService,
          useValue: {
            invoke,
            getApi: () => api,
          },
        },
      ],
    });

    service = TestBed.inject(FileIpcService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  it('routes legacy editorOpen calls through the handled editor open-file channel', async () => {
    await service.editorOpen('/tmp/review.md', { line: 4, column: 2 });

    expect(invoke).toHaveBeenCalledWith('editor:open-file', {
      filePath: '/tmp/review.md',
      line: 4,
      column: 2,
    });
  });

  it('flattens editorOpenFile options for the main-process schema', async () => {
    await service.editorOpenFile('/tmp/review.md', { waitForClose: true });

    expect(invoke).toHaveBeenCalledWith('editor:open-file', {
      filePath: '/tmp/review.md',
      waitForClose: true,
    });
  });

  describe('convertHeicToJpeg', () => {
    const heic = () => {
      const file = new File([new Uint8Array([1, 2, 3])], 'IMG_1531.HEIC', { type: 'image/heic' });
      // jsdom's File omits Blob.arrayBuffer; Chromium's File provides it.
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
      return file;
    };
    const readBytes = (file: File) =>
      new Promise<number[]>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve([...new Uint8Array(reader.result as ArrayBuffer)]);
        reader.readAsArrayBuffer(file);
      });

    it('sends the photo bytes to the main process and returns a JPEG file', async () => {
      const imageConvertHeic = vi.fn().mockResolvedValue({
        success: true,
        data: { data: new Uint8Array([0xff, 0xd8, 0xff]) },
      });
      api = { imageConvertHeic };

      const jpeg = await service.convertHeicToJpeg(heic());

      expect(imageConvertHeic).toHaveBeenCalledWith({ data: new Uint8Array([1, 2, 3]) });
      expect(jpeg.name).toBe('IMG_1531.jpg');
      expect(jpeg.type).toBe('image/jpeg');
      expect(await readBytes(jpeg)).toEqual([0xff, 0xd8, 0xff]);
    });

    it('offers another photo format and preserves the conversion diagnostic as the cause', async () => {
      api = {
        imageConvertHeic: vi.fn().mockResolvedValue({
          success: false,
          error: { code: 'IMAGE_CONVERT_HEIC_FAILED', message: 'HEIC photos can only be converted on a Mac.' },
        }),
      };

      await expect(service.convertHeicToJpeg(heic())).rejects.toMatchObject({
        message: 'This photo could not be converted. Save it as JPEG or PNG and attach that instead.',
        cause: 'HEIC photos can only be converted on a Mac.',
      });
    });

    it('throws outside the desktop app', async () => {
      await expect(service.convertHeicToJpeg(heic())).rejects.toThrow(/only be converted in the desktop app/);
    });
  });
});
