import type {
  BrowserAllowedOrigin,
  BrowserAttachExistingTabRequest,
  BrowserHttpAuthChallenge,
  BrowserTarget,
  BrowserTargetInspectionState,
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
import { deriveBrowserTargetInspectionState } from './browser-target-inspection';
import type { BrowserExtensionCommandTarget } from './browser-extension-command-store';
import { normalizeBrowserExtensionInstanceId } from './browser-extension-contact-state';

/**
 * How long a node's attachments survive a channel drop (reliability
 * hardening). `nodeId` is stable (persisted worker config) and Chrome usually
 * outlives a worker blip, so the SAME deterministic profileId/targetId comes
 * back on reconnect — deleting the attachments was the only reason callers'
 * handles (and their per-profile grants) died. Suspended attachments are
 * deleted for real once the grace expires.
 */
export const SUSPENDED_ATTACHMENT_GRACE_MS = 15 * 60_000;

/**
 * How far behind its channel's freshest inventory an attachment may lag before
 * it is treated as gone (a closed tab, or a whole superseded browser session
 * whose window/tab ids died with a Chrome restart).
 *
 * The extension re-reports the FULL tab inventory on a ~30s alarm while its
 * channel is alive, so anything a live channel has not mentioned for this long
 * no longer exists. The comparison is relative to the same channel's newest
 * report — a channel that has gone quiet entirely (Chrome closed, extension
 * dead) prunes nothing, keeping its cached targets for the suspension flow.
 * Without this, tabs from an ended browser session accumulated forever and
 * were served alongside live ones (observed: a dead generation still listed
 * 7 hours after a Chrome restart).
 */
export const SUPERSEDED_ATTACHMENT_LAG_MS = 10 * 60_000;

export interface BrowserExistingTabAttachment {
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
  nodeId?: string;
  nodeName?: string;
  /** The extension install (Chrome profile) that reported this tab. */
  extensionInstanceId?: string;
  title?: string;
  url: string;
  origin: string;
  text?: string;
  // Set when the extension could not read `text` at all (e.g. no host
  // permission for this origin), distinct from a page with legitimately no
  // visible text. See LT-218.
  textUnavailableReason?: string;
  inspectionState?: BrowserTargetInspectionState;
  tabIndex?: number;
  pinned?: boolean;
  active?: boolean;
  screenshotBase64?: string;
  allowedOrigins: BrowserAllowedOrigin[];
  extensionOrigin?: string;
  capturedAt?: number;
  /** A Chrome HTTP auth prompt waiting on this tab (no credentials). */
  httpAuthChallenge?: BrowserHttpAuthChallenge;
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
  extensionInstanceId?: string;
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
    // Normalized here too, so no caller can put a `:` into a profile id.
    const instanceId = normalizeBrowserExtensionInstanceId(options.extensionInstanceId);
    const profileId = makeExistingTabProfileId(
      options.nodeId,
      input.windowId,
      input.tabId,
      instanceId,
    );
    const targetId = this.targetIdFor(profileId);
    const current = this.attachments.get(targetId);
    const reboundFromTargetId = current
      ? undefined
      : this.replaceLegacyAttachment(options.nodeId, input, instanceId, targetId)
        ?? this.findReboundSource(options.nodeId, instanceId, input.url, targetId);
    const now = this.now();
    const attachment: BrowserExistingTabAttachment = {
      profileId,
      targetId,
      tabId: input.tabId,
      windowId: input.windowId,
      ...(options.nodeId ? { nodeId: options.nodeId } : {}),
      ...(options.nodeName ? { nodeName: options.nodeName } : {}),
      ...(instanceId ? { extensionInstanceId: instanceId } : {}),
      title: input.title,
      url: input.url,
      origin: parsed.origin,
      text: input.text?.slice(0, 120_000),
      textUnavailableReason: input.textUnavailableReason,
      inspectionState: deriveBrowserTargetInspectionState(input),
      tabIndex: input.tabIndex,
      pinned: input.pinned,
      active: input.active,
      screenshotBase64: this.normalizeScreenshot(input.screenshotBase64),
      allowedOrigins,
      extensionOrigin: input.extensionOrigin,
      capturedAt: input.capturedAt,
      // A freshly attached payload carries the CURRENT challenge observation;
      // absent means no prompt is waiting, so never inherit a stale one.
      ...(input.httpAuthChallenge ? { httpAuthChallenge: input.httpAuthChallenge } : {}),
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
   *
   * With `extensionInstanceId`, only that Chrome profile's attachments are
   * suspended; another profile on the same node is unaffected. `null` means
   * the id-less (pre-0.2.42) profile's attachments only; omitted means all.
   */
  suspendNode(nodeId: string, extensionInstanceId?: string | null): number {
    this.sweepExpiredSuspensions();
    const now = this.now();
    let suspended = 0;
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (
        !attachmentInScope(attachment, nodeId, extensionInstanceId)
        || attachment.suspendedAt !== undefined
      ) {
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

  /**
   * The node's channel is back: lift suspension on its attachments, or only on
   * one Chrome profile's when `extensionInstanceId` is given (`null`: the
   * id-less profile's only).
   */
  restoreNode(nodeId: string, extensionInstanceId?: string | null): number {
    this.sweepExpiredSuspensions();
    const now = this.now();
    let restored = 0;
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (
        !attachmentInScope(attachment, nodeId, extensionInstanceId)
        || attachment.suspendedAt === undefined
      ) {
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
    this.sweepSupersededAttachments();
  }

  /**
   * Prune attachments a live channel has stopped reporting — closed tabs and
   * whole superseded browser-session generations. Scoped per channel
   * (`nodeId`, or the local extension) and relative to that channel's newest
   * non-suspended report, so a channel that has gone quiet keeps everything
   * (that case is the suspension flow's job, not evidence its tabs closed).
   * Deliberately per node, not per Chrome profile: a profile closed while
   * another on the same node keeps reporting has its tabs aged out after the
   * lag, instead of being listed as live indefinitely.
   */
  private sweepSupersededAttachments(): void {
    const newestByChannel = new Map<string, number>();
    for (const attachment of this.attachments.values()) {
      if (attachment.suspendedAt !== undefined) {
        continue;
      }
      const channel = attachment.nodeId ?? '';
      newestByChannel.set(
        channel,
        Math.max(newestByChannel.get(channel) ?? 0, attachment.updatedAt),
      );
    }
    const prunedByChannel = new Map<string, number>();
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (attachment.suspendedAt !== undefined) {
        continue;
      }
      const channel = attachment.nodeId ?? '';
      const newest = newestByChannel.get(channel) ?? 0;
      if (newest - attachment.updatedAt > SUPERSEDED_ATTACHMENT_LAG_MS) {
        this.attachments.delete(targetId);
        this.targetRegistry.markClosed(targetId);
        prunedByChannel.set(channel, (prunedByChannel.get(channel) ?? 0) + 1);
      }
    }
    for (const [channel, count] of prunedByChannel.entries()) {
      this.reliabilityEvents.record('attachment_superseded', {
        ...(channel ? { nodeId: channel } : {}),
        detail: { count, lagMs: SUPERSEDED_ATTACHMENT_LAG_MS },
      });
    }
  }

  /**
   * A tab attaching under NEW ids that matches a suspended attachment on the
   * same node + URL is almost certainly the same logical tab re-created after
   * a drop (Chrome restarted → new tabId). Report the remap to callers via
   * `reboundFromTargetId` instead of leaving them to hunt for the tab.
   * Never across Chrome profiles: the same URL open in another profile is a
   * different tab with a different login.
   */
  private findReboundSource(
    nodeId: string | undefined,
    extensionInstanceId: string | undefined,
    url: string,
    newTargetId: string,
  ): string | undefined {
    for (const [targetId, attachment] of this.attachments.entries()) {
      if (
        targetId !== newTargetId
        && attachment.suspendedAt !== undefined
        && attachment.nodeId === nodeId
        && attachment.extensionInstanceId === extensionInstanceId
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

  /**
   * One-time upgrade path: an extension that starts reporting its install id
   * re-reports tabs that are already attached under the id-less profile id.
   * Replace that entry (and tell callers via `reboundFromTargetId`) instead of
   * listing the same tab twice until the superseded sweep catches up.
   */
  private replaceLegacyAttachment(
    nodeId: string | undefined,
    input: Pick<BrowserAttachExistingTabRequest, 'windowId' | 'tabId'>,
    extensionInstanceId: string | undefined,
    newTargetId: string,
  ): string | undefined {
    if (!extensionInstanceId) {
      return undefined;
    }
    const legacyTargetId = this.targetIdFor(
      makeExistingTabProfileId(nodeId, input.windowId, input.tabId),
    );
    const legacy = this.attachments.get(legacyTargetId);
    if (!legacy || legacyTargetId === newTargetId || legacy.extensionInstanceId) {
      return undefined;
    }
    this.attachments.delete(legacyTargetId);
    this.targetRegistry.markClosed(legacyTargetId);
    this.reliabilityEvents.record('attachment_rebound', {
      ...(nodeId ? { nodeId } : {}),
      detail: { fromTargetId: legacyTargetId, toTargetId: newTargetId },
    });
    return legacyTargetId;
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
      targetId: attachment.targetId,
      ...(attachment.inspectionState ? { inspectionState: attachment.inspectionState } : {}),
      ...(attachment.textUnavailableReason
        ? { textUnavailableReason: attachment.textUnavailableReason }
        : {}),
      ...(attachment.httpAuthChallenge
        ? { httpAuthChallenge: attachment.httpAuthChallenge }
        : {}),
      windowId: attachment.windowId,
      ...(attachment.tabIndex !== undefined ? { tabIndex: attachment.tabIndex } : {}),
      ...(attachment.pinned !== undefined ? { pinned: attachment.pinned } : {}),
      ...(attachment.active !== undefined ? { active: attachment.active } : {}),
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

/**
 * Deterministic id for a shared tab. The Chrome profile segment (`p.<id>`)
 * keeps tabs from two profiles on one machine apart; it sits after the node
 * segment so `existingTabGrantNodeId` still reads the node, which keeps grants
 * and credential scopes per machine.
 */
export function makeExistingTabProfileId(
  nodeId: string | null | undefined,
  windowId: number,
  tabId: number,
  extensionInstanceId?: string,
): string {
  const instance = extensionInstanceId ? `p.${extensionInstanceId}:` : '';
  if (!nodeId) {
    return `existing-tab:${instance}${windowId}:${tabId}`;
  }
  return `existing-tab:n.${nodeId}:${instance}${windowId}:${tabId}`;
}

/**
 * The command target for a shared tab. Carries the reporting Chrome profile
 * so the command is only handed to that profile's extension.
 */
export function extensionCommandTargetForAttachment(
  attachment: Pick<
    BrowserExistingTabAttachment,
    'profileId' | 'targetId' | 'tabId' | 'windowId' | 'extensionInstanceId'
  >,
): BrowserExtensionCommandTarget {
  return {
    profileId: attachment.profileId,
    targetId: attachment.targetId,
    tabId: attachment.tabId,
    windowId: attachment.windowId,
    ...(attachment.extensionInstanceId
      ? { extensionInstanceId: attachment.extensionInstanceId }
      : {}),
  };
}

function attachmentInScope(
  attachment: BrowserExistingTabAttachment,
  nodeId: string,
  extensionInstanceId: string | null | undefined,
): boolean {
  return attachment.nodeId === nodeId
    && (extensionInstanceId === undefined
      || attachment.extensionInstanceId === (extensionInstanceId ?? undefined));
}
