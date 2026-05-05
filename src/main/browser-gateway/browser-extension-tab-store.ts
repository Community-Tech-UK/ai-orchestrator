import type {
  BrowserAllowedOrigin,
  BrowserAttachExistingTabRequest,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserTargetRegistry,
  getBrowserTargetRegistry,
} from './browser-target-registry';
import { isOriginAllowed } from './browser-origin-policy';

export interface BrowserExistingTabAttachment {
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
  title?: string;
  url: string;
  origin: string;
  text?: string;
  screenshotBase64?: string;
  allowedOrigins: BrowserAllowedOrigin[];
  extensionOrigin?: string;
  capturedAt?: number;
  attachedAt: number;
  updatedAt: number;
}

export interface BrowserExtensionTabStoreOptions {
  targetRegistry?: BrowserTargetRegistry;
  now?: () => number;
}

export class BrowserExtensionTabStore {
  private static instance: BrowserExtensionTabStore | null = null;
  private readonly targetRegistry: BrowserTargetRegistry;
  private readonly now: () => number;
  private readonly attachments = new Map<string, BrowserExistingTabAttachment>();

  constructor(options: BrowserExtensionTabStoreOptions = {}) {
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.now = options.now ?? Date.now;
  }

  static getInstance(): BrowserExtensionTabStore {
    if (!this.instance) {
      this.instance = new BrowserExtensionTabStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  attachTab(input: BrowserAttachExistingTabRequest): BrowserExistingTabAttachment {
    const parsed = this.parseWebUrl(input.url);
    const allowedOrigins = input.allowedOrigins ?? [this.exactAllowedOrigin(parsed)];
    const originDecision = isOriginAllowed(input.url, allowedOrigins);
    if (!originDecision.allowed) {
      throw new Error(`existing_tab_origin_not_allowed:${originDecision.reason}`);
    }

    const profileId = this.profileIdFor(input.windowId, input.tabId);
    const targetId = this.targetIdFor(profileId);
    const current = this.attachments.get(targetId);
    const now = this.now();
    const attachment: BrowserExistingTabAttachment = {
      profileId,
      targetId,
      tabId: input.tabId,
      windowId: input.windowId,
      title: input.title,
      url: input.url,
      origin: parsed.origin,
      text: input.text?.slice(0, 120_000),
      screenshotBase64: this.normalizeScreenshot(input.screenshotBase64),
      allowedOrigins,
      extensionOrigin: input.extensionOrigin,
      capturedAt: input.capturedAt,
      attachedAt: current?.attachedAt ?? now,
      updatedAt: now,
    };
    this.attachments.set(targetId, attachment);
    this.targetRegistry.upsertTarget(this.toTarget(attachment));
    return attachment;
  }

  getTab(profileId: string, targetId: string): BrowserExistingTabAttachment | null {
    const attachment = this.attachments.get(targetId);
    return attachment?.profileId === profileId ? attachment : null;
  }

  detachTab(profileId: string, targetId: string): BrowserExistingTabAttachment | null {
    const attachment = this.getTab(profileId, targetId);
    if (!attachment) {
      return null;
    }
    this.attachments.delete(targetId);
    this.targetRegistry.markClosed(targetId);
    return attachment;
  }

  listTabs(): BrowserExistingTabAttachment[] {
    return Array.from(this.attachments.values());
  }

  private toTarget(attachment: BrowserExistingTabAttachment): BrowserTarget {
    return {
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
    };
  }

  private parseWebUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('unsupported_existing_tab_url');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('unsupported_existing_tab_url');
    }
    return parsed;
  }

  private exactAllowedOrigin(parsed: URL): BrowserAllowedOrigin {
    return {
      scheme: parsed.protocol === 'http:' ? 'http' : 'https',
      hostPattern: parsed.hostname,
      ...(parsed.port ? { port: Number(parsed.port) } : {}),
      includeSubdomains: false,
    };
  }

  private profileIdFor(windowId: number, tabId: number): string {
    return `existing-tab:${windowId}:${tabId}`;
  }

  private targetIdFor(profileId: string): string {
    return `${profileId}:target`;
  }

  private normalizeScreenshot(value: string | undefined): string | undefined {
    if (!value) {
      return undefined;
    }
    return value.replace(/^data:image\/png;base64,/i, '').slice(0, 2_000_000);
  }
}

export function getBrowserExtensionTabStore(): BrowserExtensionTabStore {
  return BrowserExtensionTabStore.getInstance();
}
