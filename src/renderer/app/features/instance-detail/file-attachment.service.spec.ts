/**
 * Unit Tests for FileAttachmentService
 *
 * Covers:
 * - selectAndLoadFiles: dialog + load, cancel, defaultPath passthrough
 * - loadFilesFromPaths: IPC binary read per path → File conversion, naming, error handling
 * - loadDroppedFilesFromPaths: skips directories and missing paths, loads regular files
 * - prependPendingFolders: empty, single, multiple, empty-message handling
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FileAttachmentService } from './file-attachment.service';
import { ElectronIpcService, FileIpcService } from '../../core/services/ipc';

describe('FileAttachmentService', () => {
  let service: FileAttachmentService;
  let ipc: { selectFiles: Mock };
  let fileIpc: { getFileStats: Mock; readFileBytes: Mock };

  /**
   * Build a successful readFileBytes result containing `contents` as raw bytes.
   */
  function mockBytesResult(contents: string): {
    buffer: ArrayBuffer;
    truncated: boolean;
    totalSize: number;
  } {
    const encoded = new TextEncoder().encode(contents);
    const buffer = new ArrayBuffer(encoded.byteLength);
    new Uint8Array(buffer).set(encoded);
    return { buffer, truncated: false, totalSize: encoded.byteLength };
  }

  beforeEach(() => {
    ipc = {
      selectFiles: vi.fn(),
    };
    fileIpc = {
      getFileStats: vi.fn(),
      readFileBytes: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        FileAttachmentService,
        { provide: ElectronIpcService, useValue: ipc },
        { provide: FileIpcService, useValue: fileIpc },
      ],
    });

    service = TestBed.inject(FileAttachmentService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  // ============================================
  // selectAndLoadFiles
  // ============================================

  describe('selectAndLoadFiles', () => {
    it('returns [] when the user cancels the dialog (null result)', async () => {
      ipc.selectFiles.mockResolvedValue(null);

      const files = await service.selectAndLoadFiles();

      expect(files).toEqual([]);
      expect(fileIpc.readFileBytes).not.toHaveBeenCalled();
    });

    it('returns [] when the dialog returns an empty array', async () => {
      ipc.selectFiles.mockResolvedValue([]);

      const files = await service.selectAndLoadFiles();

      expect(files).toEqual([]);
      expect(fileIpc.readFileBytes).not.toHaveBeenCalled();
    });

    it('loads files via IPC when paths are selected', async () => {
      ipc.selectFiles.mockResolvedValue(['/tmp/a.txt', '/tmp/b.txt']);
      fileIpc.readFileBytes
        .mockResolvedValueOnce(mockBytesResult('A'))
        .mockResolvedValueOnce(mockBytesResult('B'));

      const files = await service.selectAndLoadFiles();

      expect(fileIpc.readFileBytes).toHaveBeenCalledWith('/tmp/a.txt');
      expect(fileIpc.readFileBytes).toHaveBeenCalledWith('/tmp/b.txt');
      expect(files).toHaveLength(2);
      expect(files[0].name).toBe('a.txt');
      expect(files[1].name).toBe('b.txt');
    });

    it('passes defaultPath through to selectFiles', async () => {
      ipc.selectFiles.mockResolvedValue([]);

      await service.selectAndLoadFiles('/home/user/project');

      expect(ipc.selectFiles).toHaveBeenCalledWith({
        multiple: true,
        defaultPath: '/home/user/project',
      });
    });

    it('sends undefined defaultPath when null is passed', async () => {
      ipc.selectFiles.mockResolvedValue([]);

      await service.selectAndLoadFiles(null);

      expect(ipc.selectFiles).toHaveBeenCalledWith({
        multiple: true,
        defaultPath: undefined,
      });
    });

    it('sends undefined defaultPath when omitted', async () => {
      ipc.selectFiles.mockResolvedValue([]);

      await service.selectAndLoadFiles();

      expect(ipc.selectFiles).toHaveBeenCalledWith({
        multiple: true,
        defaultPath: undefined,
      });
    });
  });

  // ============================================
  // loadFilesFromPaths
  // ============================================

  describe('loadFilesFromPaths', () => {
    it('returns [] for an empty list', async () => {
      const files = await service.loadFilesFromPaths([]);
      expect(files).toEqual([]);
      expect(fileIpc.readFileBytes).not.toHaveBeenCalled();
    });

    it('converts each path into a File with the basename as name', async () => {
      fileIpc.readFileBytes.mockResolvedValue(mockBytesResult('hello'));

      const files = await service.loadFilesFromPaths(['/deeply/nested/doc.md']);

      expect(files).toHaveLength(1);
      expect(files[0]).toBeInstanceOf(File);
      expect(files[0].name).toBe('doc.md');
      expect(files[0].type).toBe('text/markdown');
    });

    it('uses application/octet-stream when extension is unknown', async () => {
      fileIpc.readFileBytes.mockResolvedValue(mockBytesResult('x'));

      const files = await service.loadFilesFromPaths(['/f.bin']);

      expect(files[0].type).toBe('application/octet-stream');
    });

    it('falls back to "file" as name when path has no basename', async () => {
      fileIpc.readFileBytes.mockResolvedValue(mockBytesResult(''));

      const files = await service.loadFilesFromPaths(['']);

      expect(files[0].name).toBe('file');
    });

    it('skips files that fail to load and keeps the rest', async () => {
      fileIpc.readFileBytes
        .mockResolvedValueOnce(mockBytesResult('ok'))
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(mockBytesResult('also ok'));

      const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

      const files = await service.loadFilesFromPaths([
        '/a.txt',
        '/broken.txt',
        '/c.txt',
      ]);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toEqual(['a.txt', 'c.txt']);
      expect(warn).toHaveBeenCalled();
    });

    it('skips files whose IPC read throws', async () => {
      fileIpc.readFileBytes.mockRejectedValueOnce(new Error('bad read'));

      const warn = vi.spyOn(console, 'warn').mockReturnValue(undefined);

      const files = await service.loadFilesFromPaths(['/x.txt']);

      expect(files).toEqual([]);
      expect(warn).toHaveBeenCalled();
    });
  });

  // ============================================
  // loadDroppedFilesFromPaths
  // ============================================

  describe('loadDroppedFilesFromPaths', () => {
    it('skips directories and loads regular files', async () => {
      fileIpc.getFileStats.mockImplementation(async (path: string) => ({
        isDirectory: path.endsWith('dir'),
      }));
      fileIpc.readFileBytes.mockResolvedValue(mockBytesResult('ok'));

      const log = vi.spyOn(console, 'log').mockReturnValue(undefined);

      const files = await service.loadDroppedFilesFromPaths([
        '/a.txt',
        '/some/dir',
        '/b.txt',
      ]);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
      expect(log).toHaveBeenCalledWith('Directory dropped - not supported yet:', '/some/dir');
    });

    it('skips paths whose stats cannot be loaded (null)', async () => {
      fileIpc.getFileStats.mockResolvedValue(null);

      const files = await service.loadDroppedFilesFromPaths(['/missing.txt']);

      expect(files).toEqual([]);
      expect(fileIpc.readFileBytes).not.toHaveBeenCalled();
    });

    it('returns [] when called with no paths', async () => {
      const files = await service.loadDroppedFilesFromPaths([]);
      expect(files).toEqual([]);
      expect(fileIpc.getFileStats).not.toHaveBeenCalled();
      expect(fileIpc.readFileBytes).not.toHaveBeenCalled();
    });

    it('loads all when every path is a file', async () => {
      fileIpc.getFileStats.mockResolvedValue({ isDirectory: false });
      fileIpc.readFileBytes.mockResolvedValue(mockBytesResult('data'));

      const files = await service.loadDroppedFilesFromPaths([
        '/a.txt',
        '/b.txt',
      ]);

      expect(files).toHaveLength(2);
      expect(files.map((f) => f.name)).toEqual(['a.txt', 'b.txt']);
    });
  });

  // ============================================
  // prependPendingFolders
  // ============================================

  describe('prependPendingFolders', () => {
    it('returns the message unchanged when folder list is empty', () => {
      expect(service.prependPendingFolders('hello', [])).toBe('hello');
    });

    it('returns the message unchanged (empty) when folder list is empty', () => {
      expect(service.prependPendingFolders('', [])).toBe('');
    });

    it('prepends a single folder reference above the message', () => {
      const result = service.prependPendingFolders('do the thing', ['/src']);
      expect(result).toBe('[Folder: /src]\n\ndo the thing');
    });

    it('prepends multiple folder references, each on its own line', () => {
      const result = service.prependPendingFolders('analyze these', [
        '/a',
        '/b',
      ]);
      expect(result).toBe('[Folder: /a]\n[Folder: /b]\n\nanalyze these');
    });

    it('returns only folder refs (no blank line) when message is empty', () => {
      const result = service.prependPendingFolders('', ['/a', '/b']);
      expect(result).toBe('[Folder: /a]\n[Folder: /b]');
    });
  });
});
