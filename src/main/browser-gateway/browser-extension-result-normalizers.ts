import type { BrowserDownloadFileResult } from '@contracts/types/browser';

export function extractScreenshotBase64(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  const value = (result as Record<string, unknown>)['screenshotBase64'];
  if (typeof value !== 'string' || !value) {
    throw new Error('browser_extension_screenshot_result_invalid');
  }
  // CDP returns raw base64; tolerate older extension data URLs as well.
  return value.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '').slice(0, 2_000_000);
}

export function normalizeDownloadFileResult(result: unknown): BrowserDownloadFileResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('browser_download_result_invalid');
  }
  const value = result as Record<string, unknown>;
  const download: BrowserDownloadFileResult = {};
  if (typeof value['id'] === 'number' || typeof value['id'] === 'string') {
    download.id = value['id'];
  }
  if (typeof value['url'] === 'string') {
    download.url = value['url'];
  }
  if (typeof value['finalUrl'] === 'string') {
    download.finalUrl = value['finalUrl'];
  }
  if (typeof value['filename'] === 'string') {
    download.filename = value['filename'];
  }
  if (typeof value['mime'] === 'string') {
    download.mime = value['mime'];
  }
  if (typeof value['bytesReceived'] === 'number') {
    download.bytesReceived = value['bytesReceived'];
  }
  if (typeof value['totalBytes'] === 'number') {
    download.totalBytes = value['totalBytes'];
  }
  if (typeof value['state'] === 'string') {
    download.state = value['state'];
  }
  if (typeof value['startedAt'] === 'string') {
    download.startedAt = value['startedAt'];
  }
  if (typeof value['endedAt'] === 'string') {
    download.endedAt = value['endedAt'];
  }
  if (!download.filename && !download.url) {
    throw new Error('browser_download_result_invalid');
  }
  return download;
}
