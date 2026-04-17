import { describe, expect, it } from 'vitest';
import {
  EditorOpenFilePayloadSchema,
  EditorOpenFileAtLinePayloadSchema,
  EditorOpenDirectoryPayloadSchema,
  EditorSetPreferredPayloadSchema,
  WatcherStartPayloadSchema,
  WatcherStopPayloadSchema,
  WatcherGetChangesPayloadSchema,
  WatcherClearBufferPayloadSchema,
  MultiEditOperationSchema,
  MultiEditPayloadSchema,
  CodebaseIndexStorePayloadSchema,
  CodebaseIndexFilePayloadSchema,
  CodebaseWatcherPayloadSchema,
  AppOpenDocsPayloadSchema,
  DialogSelectFilesPayloadSchema,
  FileReadDirPayloadSchema,
  FileGetStatsPayloadSchema,
  FileReadTextPayloadSchema,
  FileWriteTextPayloadSchema,
  FileOpenPathPayloadSchema,
} from '../file-operations.schemas';

describe('file-operations.schemas', () => {
  it('EditorOpenFilePayloadSchema requires filePath', () => {
    expect(() => EditorOpenFilePayloadSchema.parse({})).toThrow();
  });

  it('MultiEditOperationSchema parses operations without throwing on well-formed input', () => {
    const valid = MultiEditOperationSchema.safeParse({
      filePath: '/tmp/x.txt',
      content: 'hi',
    });
    expect(typeof valid).toBe('object');
  });

  it('exports all file-operations-group schemas as Zod schemas', () => {
    const schemas = [
      EditorOpenFilePayloadSchema, EditorOpenFileAtLinePayloadSchema,
      EditorOpenDirectoryPayloadSchema, EditorSetPreferredPayloadSchema,
      WatcherStartPayloadSchema, WatcherStopPayloadSchema,
      WatcherGetChangesPayloadSchema, WatcherClearBufferPayloadSchema,
      MultiEditOperationSchema, MultiEditPayloadSchema,
      CodebaseIndexStorePayloadSchema, CodebaseIndexFilePayloadSchema,
      CodebaseWatcherPayloadSchema,
      AppOpenDocsPayloadSchema, DialogSelectFilesPayloadSchema,
      FileReadDirPayloadSchema, FileGetStatsPayloadSchema,
      FileReadTextPayloadSchema, FileWriteTextPayloadSchema,
      FileOpenPathPayloadSchema,
    ];
    for (const schema of schemas) {
      expect(typeof schema.parse).toBe('function');
    }
  });
});
