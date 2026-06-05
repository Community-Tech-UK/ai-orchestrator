import * as path from 'node:path';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { tryParseWebUrl } from './browser-gateway-service-helpers';

export function findExistingTabCandidate(
  tabs: BrowserExistingTabAttachment[],
  url: string | undefined,
  titleHint: string | undefined,
): BrowserExistingTabAttachment | null {
  const parsedUrl = url ? tryParseWebUrl(url) : null;

  if (parsedUrl && url) {
    const exactOrPrefix = tabs.find((tab) =>
      tab.url === url || tab.url.startsWith(url),
    );
    if (exactOrPrefix) {
      return exactOrPrefix;
    }
    const sameOrigin = tabs.find((tab) => tab.origin === parsedUrl.origin);
    if (sameOrigin) {
      return sameOrigin;
    }
  }

  if (titleHint) {
    return tabs.find((tab) =>
      (tab.title ?? '').toLowerCase().includes(titleHint),
    ) ?? null;
  }

  return null;
}

export function browserActionTargetLabel(request: { selector?: string; uid?: string }): string {
  return request.selector ?? `uid:${request.uid}`;
}

export function browserFillFieldTargetLabel(field: { selector?: string; uid?: string }): string {
  return field.selector ?? `uid:${field.uid}`;
}

export function browserActionTargetPayload(request: { selector?: string; uid?: string }): Record<string, unknown> {
  return {
    ...(request.selector ? { selector: request.selector } : {}),
    ...(request.uid ? { uid: request.uid } : {}),
  };
}

export function placeholderExistingTabProfileRoot(filePath: string): string {
  const root = path.parse(path.resolve(filePath)).root;
  return path.join(root, '.aio-browser-gateway-existing-tab-profile');
}
