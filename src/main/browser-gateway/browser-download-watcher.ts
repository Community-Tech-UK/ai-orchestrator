import * as path from 'node:path';
import type { BrowserDownloadFileResult } from '@contracts/types/browser';

export interface BrowserCdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(event: string, handler: (payload: unknown) => void): unknown;
  off?(event: string, handler: (payload: unknown) => void): unknown;
  removeListener?(event: string, handler: (payload: unknown) => void): unknown;
}

interface CdpDownloadStarted {
  guid: string;
  url?: string;
  suggestedFilename?: string;
}

interface CdpDownloadProgress {
  guid: string;
  state?: string;
  receivedBytes?: number;
  totalBytes?: number;
}

export function waitForCdpDownload(
  session: BrowserCdpSession,
  downloadDir: string,
  timeoutMs: number,
): Promise<BrowserDownloadFileResult> {
  return new Promise<BrowserDownloadFileResult>((resolve, reject) => {
    let started: CdpDownloadStarted | null = null;
    const startedAt = new Date().toISOString();
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('browser_download_timeout'));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timeout);
      removeSessionListener(session, 'Page.downloadWillBegin', handleBegin);
      removeSessionListener(session, 'Page.downloadProgress', handleProgress);
    };
    const finish = (progress: CdpDownloadProgress): void => {
      cleanup();
      const suggestedFilename = started?.suggestedFilename || 'download';
      resolve({
        id: progress.guid,
        url: started?.url,
        finalUrl: started?.url,
        filename: path.join(downloadDir, suggestedFilename),
        bytesReceived: progress.receivedBytes,
        totalBytes: progress.totalBytes,
        state: 'complete',
        startedAt,
        endedAt: new Date().toISOString(),
      });
    };
    function handleBegin(payload: unknown): void {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const value = payload as Partial<CdpDownloadStarted>;
      if (typeof value.guid !== 'string') {
        return;
      }
      started = {
        guid: value.guid,
        ...(typeof value.url === 'string' ? { url: value.url } : {}),
        ...(typeof value.suggestedFilename === 'string'
          ? { suggestedFilename: value.suggestedFilename }
          : {}),
      };
    }
    function handleProgress(payload: unknown): void {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const value = payload as Partial<CdpDownloadProgress>;
      if (typeof value.guid !== 'string' || started && value.guid !== started.guid) {
        return;
      }
      if (value.state === 'canceled') {
        cleanup();
        reject(new Error('browser_download_canceled'));
        return;
      }
      if (value.state === 'completed') {
        finish({
          guid: value.guid,
          state: value.state,
          receivedBytes: typeof value.receivedBytes === 'number' ? value.receivedBytes : undefined,
          totalBytes: typeof value.totalBytes === 'number' ? value.totalBytes : undefined,
        });
      }
    }

    addSessionListener(session, 'Page.downloadWillBegin', handleBegin);
    addSessionListener(session, 'Page.downloadProgress', handleProgress);
  });
}

function addSessionListener(
  session: BrowserCdpSession,
  event: string,
  handler: (payload: unknown) => void,
): void {
  session.on?.(event, handler);
}

function removeSessionListener(
  session: BrowserCdpSession,
  event: string,
  handler: (payload: unknown) => void,
): void {
  if (session.off) {
    session.off(event, handler);
    return;
  }
  session.removeListener?.(event, handler);
}
