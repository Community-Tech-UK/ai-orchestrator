import * as path from 'node:path';

export interface BrowserUploadVerificationExpectation {
  fileName?: string;
  size?: number;
}

interface BrowserUploadReadbackFile {
  name?: unknown;
  size?: unknown;
}

interface BrowserUploadReadback {
  uploaded?: unknown;
  fileCount?: unknown;
  files?: unknown;
}

export function verifyUploadedFileSelection(
  readback: unknown,
  expected: BrowserUploadVerificationExpectation = {},
): void {
  if (!isRecord(readback)) {
    throw new Error('browser_upload_verify_mismatch:readback');
  }
  const state = readback as BrowserUploadReadback;
  const files = Array.isArray(state.files)
    ? (state.files as BrowserUploadReadbackFile[])
    : [];
  const firstFile = files[0];
  const mismatches: string[] = [];

  if (typeof state.fileCount !== 'number' || state.fileCount < 1 || !firstFile) {
    mismatches.push('file_count');
  }
  if (state.uploaded !== true) {
    mismatches.push('uploaded');
  }
  if (
    expected.size !== undefined &&
    (!firstFile || firstFile.size !== expected.size)
  ) {
    mismatches.push('size');
  }
  if (
    expected.fileName &&
    (!firstFile || firstFile.name !== expected.fileName)
  ) {
    mismatches.push('file_name');
  }

  if (mismatches.length > 0) {
    throw new Error(`browser_upload_verify_mismatch:${[...new Set(mismatches)].join(',')}`);
  }
}

export function basenameForUploadPath(filePath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') || filePath.includes('\\')) {
    return path.win32.basename(filePath);
  }
  return path.posix.basename(filePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
