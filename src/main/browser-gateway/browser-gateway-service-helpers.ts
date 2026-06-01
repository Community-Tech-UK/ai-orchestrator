import * as path from 'node:path';
import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserAttachExistingTabRequest,
  BrowserGrantMode,
  BrowserManualStepRequest,
  BrowserTarget,
} from '@contracts/types/browser';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { normalizeOrigin } from './browser-origin-policy';
import { toAgentSafeTarget } from './browser-safe-dto';

export function manualStepActionClass(kind: BrowserManualStepRequest['kind']): BrowserActionClass {
  return kind === 'login' || kind === 'captcha' || kind === 'two_factor'
    ? 'credential'
    : 'unknown';
}

export function defaultManualStepPrompt(kind: BrowserManualStepRequest['kind']): string {
  if (kind === 'login') {
    return 'User login is required before Browser Gateway automation can continue.';
  }
  if (kind === 'captcha') {
    return 'Complete the browser CAPTCHA challenge before Browser Gateway automation continues.';
  }
  if (kind === 'two_factor') {
    return 'Complete the browser two-factor authentication step before Browser Gateway automation continues.';
  }
  return 'Manual browser review is required before Browser Gateway automation can continue.';
}

export function tryParseWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function allowedOriginFromUrl(url: string): BrowserAllowedOrigin | null {
  const normalized = normalizeOrigin(url);
  if (!normalized) {
    return null;
  }
  const defaultPort = normalized.scheme === 'https' ? 443 : 80;
  return {
    scheme: normalized.scheme,
    hostPattern: normalized.host,
    ...(normalized.port === defaultPort ? {} : { port: normalized.port }),
    includeSubdomains: false,
  };
}

export function extractTabPayload(result: unknown): BrowserAttachExistingTabRequest {
  const value = isRecord(result) && isRecord(result['tab'])
    ? result['tab']
    : result;
  if (!isRecord(value)) {
    throw new Error('browser_extension_tab_result_invalid');
  }
  const tabId = value['tabId'];
  const windowId = value['windowId'];
  const url = value['url'];
  if (
    typeof tabId !== 'number' ||
    typeof windowId !== 'number' ||
    typeof url !== 'string'
  ) {
    throw new Error('browser_extension_tab_result_invalid');
  }
  return {
    tabId,
    windowId,
    url,
    ...(typeof value['title'] === 'string' ? { title: value['title'] } : {}),
    ...(typeof value['text'] === 'string' ? { text: value['text'] } : {}),
    ...(typeof value['screenshotBase64'] === 'string'
      ? { screenshotBase64: value['screenshotBase64'] }
      : {}),
    ...(typeof value['capturedAt'] === 'number' ? { capturedAt: value['capturedAt'] } : {}),
  };
}

export function safeTargetFromExistingTab(
  attachment: BrowserExistingTabAttachment,
): ReturnType<typeof toAgentSafeTarget> {
  return toAgentSafeTarget({
    id: attachment.targetId,
    profileId: attachment.profileId,
    pageId: String(attachment.tabId),
    driverTargetId: `chrome-tab:${attachment.windowId}:${attachment.tabId}`,
    mode: 'existing-tab',
    title: attachment.title,
    url: attachment.url,
    origin: attachment.origin,
    driver: 'extension',
    status: 'selected',
    lastSeenAt: attachment.updatedAt,
  } satisfies BrowserTarget);
}

export function primaryActionClass(classes: BrowserActionClass[]): BrowserActionClass {
  if (classes.includes('destructive')) {
    return 'destructive';
  }
  if (classes.includes('submit')) {
    return 'submit';
  }
  if (classes.includes('credential')) {
    return 'credential';
  }
  if (classes.includes('file-upload')) {
    return 'file-upload';
  }
  return classes[0] ?? 'unknown';
}

export function defaultGrantExpiresAt(mode: BrowserGrantMode, now: number): number {
  if (mode === 'per_action') {
    return now + 30 * 60 * 1000;
  }
  return now + 8 * 60 * 60 * 1000;
}

export function capGrantExpiresAt(
  mode: BrowserGrantMode,
  requestedExpiresAt: number,
  now: number,
): number {
  const max = mode === 'autonomous'
    ? now + 24 * 60 * 60 * 1000
    : now + 24 * 60 * 60 * 1000;
  return Math.min(requestedExpiresAt, max);
}

export function proposedUploadRoots(
  currentRoots: string[] | undefined,
  resolvedFilePath: string | undefined,
): string[] | undefined {
  const roots = [...(currentRoots ?? [])];
  if (resolvedFilePath) {
    roots.push(path.dirname(resolvedFilePath));
  }
  return roots.length > 0 ? Array.from(new Set(roots)) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
