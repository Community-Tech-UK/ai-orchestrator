import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import type { NetworkRequest } from '../security/network-policy';
import { CATALOG_OVERRIDE_FILE_NAME, MAX_OVERRIDE_BYTES } from './catalog-override-codec';

export const MAX_REMOTE_REDIRECTS = 5;

const REMOTE_REQUEST_TIMEOUT_MS = 6000;

export interface Watcher {
  close: () => void;
}

export interface NetworkPolicyRecorder {
  recordRequest(url: string, method?: string): NetworkRequest;
}

export interface FetchTextOptions {
  networkPolicy?: NetworkPolicyRecorder;
  maxRedirects?: number;
}

export type WatchDirectory = (dirPath: string, listener: () => void) => Watcher;
export type FetchText = (url: string, options?: FetchTextOptions) => Promise<string>;

export function defaultWatchDirectory(dirPath: string, listener: () => void): Watcher {
  const watcher = fs.watch(dirPath, (eventType, fileName) => {
    if (eventType === 'rename' || eventType === 'change') {
      if (!fileName || fileName.toString() === CATALOG_OVERRIDE_FILE_NAME) {
        listener();
      }
    }
  });
  return watcher;
}

export function defaultFetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<string> {
  return fetchTextWithRedirects(url, options, 0);
}

function fetchTextWithRedirects(
  url: string,
  options: FetchTextOptions,
  redirectCount: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      reject(error);
      return;
    }
    const client = parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null;
    if (!client) {
      reject(new Error('Only HTTP(S) catalog override URLs are supported'));
      return;
    }

    const request = client.get(parsed, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        const location = response.headers.location;
        if (!location) {
          reject(new Error(`HTTP ${status} redirect missing Location header`));
          return;
        }
        if (redirectCount >= (options.maxRedirects ?? MAX_REMOTE_REDIRECTS)) {
          reject(new Error('catalog override redirect limit exceeded'));
          return;
        }

        let redirectedUrl: string;
        try {
          redirectedUrl = new URL(location, parsed).toString();
        } catch (error) {
          reject(error);
          return;
        }

        if (options.networkPolicy) {
          let redirectedRequest: NetworkRequest;
          try {
            redirectedRequest = options.networkPolicy.recordRequest(redirectedUrl, 'GET');
          } catch (error) {
            reject(error);
            return;
          }
          if (!redirectedRequest.allowed) {
            reject(new Error(`Redirect blocked by network policy: ${redirectedRequest.reason}`));
            return;
          }
        }

        fetchTextWithRedirects(redirectedUrl, options, redirectCount + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`HTTP ${status}`));
        return;
      }

      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_OVERRIDE_BYTES) {
          request.destroy(new Error('catalog override response exceeded size cap'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

    request.setTimeout(REMOTE_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error('catalog override request timed out'));
    });
    request.on('error', reject);
  });
}
