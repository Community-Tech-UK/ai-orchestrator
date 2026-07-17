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
import {
  getBrowserReliabilityEvents,
  type BrowserReliabilityEvents,
} from './browser-reliability-events';

/**
 * How long a node's attachments survive a channel drop (reliability
 * hardening). `nodeId` is stable (persisted worker config) and Chrome usually
 * outlives a worker blip, so the SAME deterministic profileId/targetId comes
 * back on reconnect — deleting the attachments was the only reason callers'
 * handles (and their per-profile grants) died. Suspended attachments are
 * deleted for real once the grace expires.
 */
export const SUSPENDED_ATTACHMENT_GRACE_MS = 15 * 60_000;

export interface BrowserExistingTabAttachment {
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
  nodeId?: string;
  nodeName?: string;
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
  /** Set while the attachment's node channel is down (grace window). */
  suspendedAt?: number;
  /** Previous targetId when this tab re-appeared under new ids after a drop. */
  reboundFromTargetId?: string;
}

export interface BrowserExtensionTabStoreOptions {
  targetRegistry?: BrowserTargetRegistry;
  reliabilityEvents?: Pick<BrowserReliabilityEvents, 'record'>;
  now?: () => number;
}

export interface BrowserExtensionTabAttachOptions {
  nodeId?: string;
  nodeName?: string;
}

export class BrowserExtensionTabStore {
  private static instance: BrowserExtensionTabStore | null = null;
  private readonly targetRegistry: BrowserTargetRegistry;
  private readonly reliabilityEvents: Pick<BrowserReliabilityEvents, 'record'>;
  private readonly now: () => number;
  private readonly attachments = new Map<string, BrowserExistingTabAttachment>();

  constructor(options: BrowserExtensionTabStoreOptions = {}) {
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.reliabilityEvents = options.reliabilityEvents ?? getBrowserReliabilityEvents();
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

  attachTab(
    input: BrowserAttachExistingTabRequest,
    options: BrowserExtensionTabAttachOptions = {},
  ): BrowserExistingTabAttachment {
    const parsed = this.parseWebUrl(input.url);
    const allowedOrigins = input.allowedOrigins ?? [this.exactAllowedOrigin(parsed)];
    const originDecision = isOriginAllowed(input.url, allowedOrigins);
    if (!originDecision.allowed) {
      throw new Error(`existing_tab_origin_not_allowed:${originDecision.reason}`);
    }

    this.sweepExpiredSuspensions();
    const profileId = makeExistingTabProfileId(options.nodeId, input.windowId, input.tabId);
    const targetId = this.targetIdFor(profileId);
    const current = this.attachments.get(targetId);
    const reboundFromTargetId = current ? undefined : this.findReboundSource(
      options.nodeId,
      input.url,
      targetId,
    );
    const now = this.now();
    const attachment: BrowserExistingTabAttachment = {
      profileId,
      targetId,
      tabId: input.tabId,
      windowId: input.windowId,
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.nodeName ? { nodeName: options.nodeName } : {}),
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
      // A fresh attach means the tab is live again: never inherit suspension.
      ...(reboundFromTargetId ? { reboundFromTargetId } : {}),
    };
    if (current?.suspendedAt !== undefined) {
      this.reliabilityEvents.record('attachment_restored', {
        ...(attachment.nodeId ? { nodeId: attachment.nodeId } : {}),
        detail: { targetId, via: 'reattach' },
      });
    }
    this.attachments.set(targetId, attachment);
    this.targetRegistry.upsertTarget(this.toTarget(attachment));
    return attachment;
  }

  getTab(profileId: string, targetId: string): BrowserExistingTabAttachment | null {
    this.sweepExpiredSuspensions();
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
    this.sweepExpiredSuspensions();
    return Array.from(this.attachments.values());
  }

  /**
   * The node's channel dropped. Attachments are SUSPENDED (kept, marked stale
   * in the target registry) instead of deleted: on reconnect the same
   * deterministic ids re-derive, so callers' handles and per-profile grants
   * survive the blip. Deleted for real after the grace window.
   */
  suspendNode(nodeId: string): number {
    this.sweepExpiredSuspensions();
    const now = this.now();
    let suspended = 0;
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (attachment.nodeId !== nodeId || attachment.suspendedAt !== undefined) {
        continue;
      }
      const next = { ...attachment, suspendedAt: now, updatedAt: now };
      this.attachments.set(targetId, next);
      this.targetRegistry.upsertTarget({ ...this.toTarget(next), stale: true });
      suspended += 1;
    }
    if (suspended > 0) {
      this.reliabilityEvents.record('attachment_suspended', {
        nodeId,
        detail: { count: suspended, graceMs: SUSPENDED_ATTACHMENT_GRACE_MS },
      });
    }
    return suspended;
  }

  /** The node's channel is back: lift suspension on its attachments. */
  restoreNode(nodeId: string): number {
    this.sweepExpiredSuspensions();
    const now = this.now();
    let restored = 0;
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (attachment.nodeId !== nodeId || attachment.suspendedAt === undefined) {
        continue;
      }
      const { suspendedAt: _suspendedAt, ...rest } = attachment;
      const next = { ...rest, updatedAt: now };
      this.attachments.set(targetId, next);
      this.targetRegistry.upsertTarget(this.toTarget(next));
      restored += 1;
    }
    if (restored > 0) {
      this.reliabilityEvents.record('attachment_restored', {
        nodeId,
        detail: { count: restored, via: 'channel_recovered' },
      });
    }
    return restored;
  }

  private sweepExpiredSuspensions(): void {
    const now = this.now();
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (
        attachment.suspendedAt !== undefined
        && now - attachment.suspendedAt > SUSPENDED_ATTACHMENT_GRACE_MS
      ) {
        this.attachments.delete(targetId);
        this.targetRegistry.markClosed(targetId);
      }
    }
  }

  /**
   * A tab attaching under NEW ids that matches a suspended attachment on the
   * same node + URL is almost certainly the same logical tab re-created after
   * a drop (Chrome restarted → new tabId). Report the remap to callers via
   * `reboundFromTargetId` instead of leaving them to hunt for the tab.
   */
  private findReboundSource(
    nodeId: string | undefined,
    url: string,
    newTargetId: string,
  ): string | undefined {
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (
        targetId !== newTargetId
        && attachment.suspendedAt !== undefined
        && attachment.nodeId === nodeId
        && attachment.url === url
      ) {
        this.attachments.delete(targetId);
        this.targetRegistry.markClosed(targetId);
        this.reliabilityEvents.record('attachment_rebound', {
          ...(nodeId ? { nodeId } : {}),
          detail: { fromTargetId: targetId, toTargetId: newTargetId },
        });
        return targetId;
      }
    }
    return undefined;
  }

  private toTarget(attachment: BrowserExistingTabAttachment): BrowserTarget {
    return {
      id: attachment.targetId,
      profileId: attachment.profileId,
      pageId: String(attachment.tabId),
      driverTargetId: `chrome-tab:${attachment.windowId}:${attachment.tabId}`,
      mode: 'existing-tab',
      ...(attachment.nodeId ? { nodeId: attachment.nodeId } : {}),
      ...(attachment.nodeName ? { nodeName: attachment.nodeName } : {}),
      title: attachment.title,
      url: attachment.url,
      origin: attachment.origin,
      driver: 'extension',
      status: 'selected',
      lastSeenAt: attachment.updatedAt,
      lastConfirmedAt: attachment.updatedAt,
      ...(attachment.reboundFromTargetId
        ? { reboundFromTargetId: attachment.reboundFromTargetId }
        : {}),
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

export function makeExistingTabProfileId(
  nodeId: string | null | undefined,
  windowId: number,
  tabId: number,
): string {
  if (!nodeId) {
    return `existing-tab:${windowId}:${tabId}`;
  }
  return `existing-tab:n.${nodeId}:${windowId}:${tabId}`;
}
