import * as crypto from 'node:crypto';
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

export type BrowserExtensionCommandKind = 'refresh_tab';
export type BrowserExtensionCommandStatus =
  | 'queued'
  | 'sent'
  | 'succeeded'
  | 'failed';

export interface BrowserExtensionCommand {
  id: string;
  kind: BrowserExtensionCommandKind;
  status: BrowserExtensionCommandStatus;
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

export interface BrowserExtensionPollCommandRequest {
  profileId: string;
  targetId: string;
  tabId: number;
  windowId: number;
}

export interface BrowserExtensionCompleteCommandRequest
  extends BrowserExtensionPollCommandRequest {
  commandId: string;
  status: 'succeeded' | 'failed';
  error?: string;
  tab?: BrowserAttachExistingTabRequest;
}

export interface BrowserExtensionTabStoreOptions {
  targetRegistry?: BrowserTargetRegistry;
  now?: () => number;
  createCommandId?: () => string;
}

export class BrowserExtensionTabStore {
  private static instance: BrowserExtensionTabStore | null = null;
  private readonly targetRegistry: BrowserTargetRegistry;
  private readonly now: () => number;
  private readonly createCommandId: () => string;
  private readonly attachments = new Map<string, BrowserExistingTabAttachment>();
  private readonly commands = new Map<string, BrowserExtensionCommand>();

  constructor(options: BrowserExtensionTabStoreOptions = {}) {
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.now = options.now ?? Date.now;
    this.createCommandId = options.createCommandId ?? (() => crypto.randomUUID());
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

  queueRefresh(profileId: string, targetId: string): BrowserExtensionCommand | null {
    const attachment = this.getTab(profileId, targetId);
    if (!attachment) {
      return null;
    }
    const existing = Array.from(this.commands.values()).find((command) =>
      command.profileId === profileId &&
      command.targetId === targetId &&
      command.kind === 'refresh_tab' &&
      (command.status === 'queued' || command.status === 'sent'),
    );
    if (existing) {
      return existing;
    }

    const now = this.now();
    const command: BrowserExtensionCommand = {
      id: this.createCommandId(),
      kind: 'refresh_tab',
      status: 'queued',
      profileId,
      targetId,
      tabId: attachment.tabId,
      windowId: attachment.windowId,
      createdAt: now,
      updatedAt: now,
    };
    this.commands.set(command.id, command);
    return command;
  }

  pollCommand(request: BrowserExtensionPollCommandRequest): BrowserExtensionCommand | null {
    if (!this.matchesAttachment(request)) {
      return null;
    }
    const command = Array.from(this.commands.values()).find((candidate) =>
      candidate.profileId === request.profileId &&
      candidate.targetId === request.targetId &&
      candidate.tabId === request.tabId &&
      candidate.windowId === request.windowId &&
      candidate.status === 'queued',
    );
    if (!command) {
      return null;
    }

    const sent: BrowserExtensionCommand = {
      ...command,
      status: 'sent',
      updatedAt: this.now(),
    };
    this.commands.set(sent.id, sent);
    return sent;
  }

  completeCommand(
    request: BrowserExtensionCompleteCommandRequest,
  ): BrowserExtensionCommand | null {
    const command = this.commands.get(request.commandId);
    const attachment = this.getTab(request.profileId, request.targetId);
    if (!command || !attachment || !this.matchesCommand(command, request)) {
      return null;
    }

    let error = request.error;
    if (request.status === 'succeeded' && request.tab) {
      try {
        this.attachTab({
          ...request.tab,
          tabId: request.tabId,
          windowId: request.windowId,
          allowedOrigins: attachment.allowedOrigins,
          extensionOrigin: request.tab.extensionOrigin ?? attachment.extensionOrigin,
        });
      } catch (attachError) {
        error = attachError instanceof Error ? attachError.message : String(attachError);
      }
    }

    const completed: BrowserExtensionCommand = {
      ...command,
      status: error ? 'failed' : request.status,
      updatedAt: this.now(),
      ...(error ? { error } : {}),
    };
    this.commands.delete(command.id);
    return completed;
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

  private matchesAttachment(request: BrowserExtensionPollCommandRequest): boolean {
    const attachment = this.getTab(request.profileId, request.targetId);
    return Boolean(
      attachment &&
      attachment.tabId === request.tabId &&
      attachment.windowId === request.windowId,
    );
  }

  private matchesCommand(
    command: BrowserExtensionCommand,
    request: BrowserExtensionPollCommandRequest & { commandId: string },
  ): boolean {
    return command.id === request.commandId &&
      command.profileId === request.profileId &&
      command.targetId === request.targetId &&
      command.tabId === request.tabId &&
      command.windowId === request.windowId;
  }
}

export function getBrowserExtensionTabStore(): BrowserExtensionTabStore {
  return BrowserExtensionTabStore.getInstance();
}
