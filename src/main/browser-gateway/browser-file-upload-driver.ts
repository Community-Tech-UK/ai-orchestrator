import * as fs from 'node:fs';
import type { Page } from 'puppeteer-core';
import {
  basenameForUploadPath,
  verifyUploadedFileSelection,
} from './browser-upload-verify';

interface UploadElementHandle {
  uploadFile: (filePath: string) => Promise<void>;
  evaluate: <T>(fn: (element: UploadFileInputElement) => T) => Promise<T>;
}

interface UploadFileInputElement {
  files?: ArrayLike<{
    name: string;
    size: number;
    type: string;
  }> | null;
}

export async function uploadFileAndVerify(
  page: Pick<Page, '$'>,
  selector: string,
  filePath: string,
): Promise<void> {
  const handle = await page.$(selector);
  if (!handle) {
    throw new Error(`Browser upload target ${selector} not found`);
  }
  const uploadHandle = handle as unknown as UploadElementHandle;
  await uploadHandle.uploadFile(filePath);
  const readback = await uploadHandle.evaluate((element) => {
    const files = Array.from(element.files ?? []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    }));
    return {
      uploaded: files.length > 0,
      fileCount: files.length,
      files,
    };
  });
  let size: number | undefined;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    size = undefined;
  }
  verifyUploadedFileSelection(readback, {
    fileName: basenameForUploadPath(filePath),
    size,
  });
}
