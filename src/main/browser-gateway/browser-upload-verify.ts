import * as path from 'node:path';

export interface BrowserUploadVerificationExpectation {
  fileName?: string;
  size?: number;
}

export interface BrowserUploadRecoveryContext {
  url?: string;
  actionHint?: string;
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

export function appendBrowserUploadRecoveryHint(
  error: unknown,
  context: BrowserUploadRecoveryContext,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const hint = browserUploadRecoveryHint(context);
  if (!hint || message.includes(hint)) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(`${message}. Recovery hint: ${hint}`);
}

function browserUploadRecoveryHint(context: BrowserUploadRecoveryContext): string | null {
  const haystack = `${context.url ?? ''} ${context.actionHint ?? ''}`.toLowerCase();
  if (
    haystack.includes('play.google.com') &&
    (haystack.includes('add from library') || haystack.includes('library'))
  ) {
    return 'For Play Console Add from library, reopen the library picker, clear any stale selection, search the uploaded artifact by name or version, select it again, and verify the selected asset row after reload.';
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
