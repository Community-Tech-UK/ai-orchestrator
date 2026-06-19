import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, ConsoleMessage, HTTPRequest, Page } from 'puppeteer-core';
import type {
  BrowserAccessibilityNode,
  BrowserElementContext,
  BrowserElementCandidate,
  BrowserEvaluateResult,
  BrowserDownloadFileResult,
  BrowserProfile,
  BrowserProfileMode,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserProcessLauncher,
} from './browser-process-launcher';
import { RoutingBrowserLauncher } from './routing-browser-launcher';
import {
  normalizeAxTreeNodes,
  normalizeElementCandidates,
} from './puppeteer-browser-normalizers';
import {
  BrowserTargetRegistry,
  getBrowserTargetRegistry,
} from './browser-target-registry';
import {
  redactBrowserText,
  redactBrowserUrl,
  redactElementContext,
  redactHeaders,
} from './browser-redaction';
import {
  waitForCdpDownload,
  type BrowserCdpSession,
} from './browser-download-watcher';
import {
  evaluatePageBridge,
  isPageBridgeSnapshot,
} from './browser-page-bridge';
import {
  BrowserAntiThrottle,
  type AntiThrottlePage,
} from './browser-anti-throttle';
import { BrowserWedgeRecovery } from './browser-wedge-recovery';

export interface BrowserSnapshot {
  title: string;
  url: string;
  text: string;
}

export interface BrowserConsoleEntry {
  type: string;
  text: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
  timestamp: number;
}

export interface BrowserNetworkRequestEntry {
  url: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  timestamp: number;
}

export interface BrowserFillFieldInput {
  selector: string;
  value: string;
}

export interface BrowserDownloadFileInput {
  selector?: string;
  url?: string;
  timeoutMs?: number;
}

export interface PuppeteerBrowserDriverOptions {
  launcher?: Pick<
    BrowserProcessLauncher,
    'launchProfile' | 'getBrowser' | 'closeProfile'
  >;
  targetRegistry?: BrowserTargetRegistry;
  /** Keep backgrounded CDP tabs unthrottled/undiscarded (see BrowserAntiThrottle). Default true. */
  antiThrottle?: boolean;
  /** Interval (ms) between lifecycle keep-alive heartbeats. */
  lifecycleHeartbeatMs?: number;
  /** Auto-reload a target whose renderer wedges (default true). See BrowserWedgeRecovery. */
  autoRecoverWedged?: boolean;
}

export class PuppeteerBrowserDriver {
  private readonly launcher: Pick<
    BrowserProcessLauncher,
    'launchProfile' | 'getBrowser' | 'closeProfile'
  >;
  private readonly targetRegistry: BrowserTargetRegistry;
  private readonly pagesByTargetId = new Map<string, Page>();
  private readonly consoleByTargetId = new Map<string, BrowserConsoleEntry[]>();
  private readonly networkByTargetId = new Map<string, BrowserNetworkRequestEntry[]>();
  private readonly instrumentedTargetIds = new Set<string>();
  private readonly profileModesById = new Map<string, BrowserProfileMode>();
  private readonly profileDownloadDirsById = new Map<string, string>();
  private readonly antiThrottle: BrowserAntiThrottle;
  private readonly targetWatchedProfiles = new Set<string>();
  private readonly wedgeRecovery: BrowserWedgeRecovery;

  constructor(options: PuppeteerBrowserDriverOptions = {}) {
    this.launcher = options.launcher ?? new BrowserProcessLauncher();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
    this.wedgeRecovery = new BrowserWedgeRecovery({
      autoRecover: options.autoRecoverWedged ?? true,
      getPage: (targetId) => this.pagesByTargetId.get(targetId),
    });
    this.antiThrottle = new BrowserAntiThrottle({
      enabled: options.antiThrottle ?? true,
      ...(typeof options.lifecycleHeartbeatMs === 'number'
        ? { heartbeatMs: options.lifecycleHeartbeatMs }
        : {}),
      createSession: (page) => this.createPageSession(page as unknown as Page),
      onWedged: (targetId) => {
        void this.wedgeRecovery.recover(targetId);
      },
      onRecovered: (targetId) => this.wedgeRecovery.recovered(targetId),
    });
  }

  /** Targets whose renderer is wedged (browser-process pings ok, renderer probes time out). */
  listWedgedTargets(): string[] {
    return this.antiThrottle.wedgedTargets();
  }

  async openProfile(
    profile: BrowserProfile,
    startUrl?: string,
    preferredDebugPort?: number,
  ): Promise<BrowserTarget[]> {
    if (!profile.userDataDir && profile.mode !== 'isolated') {
      throw new Error(`Browser profile ${profile.id} has no userDataDir`);
    }
    this.profileModesById.set(profile.id, profile.mode);
    this.profileDownloadDirsById.set(
      profile.id,
      path.join(profile.userDataDir ?? profile.id, 'Downloads'),
    );
    try {
      await this.launcher.launchProfile({
        profile,
        userDataDir: profile.userDataDir ?? profile.id,
        startUrl,
        ...(typeof preferredDebugPort === 'number' ? { preferredDebugPort } : {}),
      });
      this.watchProfileTargets(profile.id);
      return this.indexPages(profile.id);
    } catch (error) {
      this.profileModesById.delete(profile.id);
      throw error;
    }
  }

  async closeProfile(profileId: string): Promise<void> {
    await this.antiThrottle.stopForProfile(profileId);
    await this.launcher.closeProfile(profileId);
    this.profileModesById.delete(profileId);
    this.profileDownloadDirsById.delete(profileId);
    this.targetWatchedProfiles.delete(profileId);
    this.targetRegistry.clearProfile(profileId);
    for (const targetId of Array.from(this.pagesByTargetId.keys())) {
      if (targetId.startsWith(`${profileId}:`)) {
        this.pagesByTargetId.delete(targetId);
        this.consoleByTargetId.delete(targetId);
        this.networkByTargetId.delete(targetId);
        this.instrumentedTargetIds.delete(targetId);
      }
    }
  }

  // Subscribe to `targetcreated` so tabs opened mid-session (window.open,
  // target=_blank) get keep-alive immediately rather than staying unprotected
  // until the next listTargets() re-index. Best-effort: a launcher whose browser
  // exposes no event emitter (e.g. test doubles) simply forgoes this.
  private watchProfileTargets(profileId: string): void {
    if (this.targetWatchedProfiles.has(profileId)) {
      return;
    }
    const browser = this.launcher.getBrowser(profileId) as
      | (Browser & { on?: (event: string, handler: () => void) => unknown }) | null | undefined;
    if (!browser || typeof browser.on !== 'function') {
      return;
    }
    this.targetWatchedProfiles.add(profileId);
    browser.on('targetcreated', () => {
      void this.indexPages(profileId).catch(() => undefined);
    });
  }

  async listTargets(profileId: string): Promise<BrowserTarget[]> {
    await this.indexPages(profileId);
    return this.targetRegistry.listTargets(profileId);
  }

  async refreshTarget(profileId: string, targetId: string): Promise<BrowserTarget> {
    const page = this.getPage(profileId, targetId);
    return this.refreshPageTarget(profileId, targetId, page);
  }

  async navigate(profileId: string, targetId: string, url: string): Promise<void> {
    const page = this.getPage(profileId, targetId);
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async snapshot(profileId: string, targetId: string): Promise<BrowserSnapshot> {
    const page = this.getPage(profileId, targetId);
    const result = await evaluatePageBridge(page, {
      action: 'snapshot',
      args: [],
    });
    const text = typeof result === 'string'
      ? result
      : isPageBridgeSnapshot(result)
        ? result.text
        : '';
    return {
      title: await page.title(),
      url: page.url(),
      text: String(text).slice(0, 12_000),
    };
  }

  async screenshot(
    profileId: string,
    targetId: string,
    options: { fullPage?: boolean } = {},
  ): Promise<string> {
    const page = this.getPage(profileId, targetId);
    const screenshot = await page.screenshot({
      type: 'png',
      encoding: 'base64',
      fullPage: options.fullPage ?? true,
    });
    return typeof screenshot === 'string'
      ? screenshot
      : Buffer.from(screenshot).toString('base64');
  }

  async consoleMessages(
    profileId: string,
    targetId: string,
  ): Promise<BrowserConsoleEntry[]> {
    this.getPage(profileId, targetId);
    return [...(this.consoleByTargetId.get(targetId) ?? [])];
  }

  async networkRequests(
    profileId: string,
    targetId: string,
  ): Promise<BrowserNetworkRequestEntry[]> {
    this.getPage(profileId, targetId);
    return [...(this.networkByTargetId.get(targetId) ?? [])];
  }

  async waitFor(
    profileId: string,
    targetId: string,
    selectorOrText: string,
    timeoutMs: number,
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    try {
      await page.waitForSelector(selectorOrText, { timeout: timeoutMs });
    } catch {
      await evaluatePageBridge(page, {
        action: 'wait_for',
        args: [selectorOrText, timeoutMs],
      });
    }
  }

  async queryElements(
    profileId: string,
    targetId: string,
    query?: string,
    limit?: number,
  ): Promise<BrowserElementCandidate[]> {
    const page = this.getPage(profileId, targetId);
    const result = await evaluatePageBridge(page, {
      action: 'query_elements',
      args: [query, limit],
    });
    return normalizeElementCandidates(result);
  }

  // Capture a flattened CDP accessibility tree. Mirrors the extension path so
  // managed profiles expose the same uid-addressable nodes (uid = backendNodeId)
  // that pierce open and closed shadow roots.
  async accessibilitySnapshot(
    profileId: string,
    targetId: string,
    options: { interestingOnly?: boolean; limit?: number } = {},
  ): Promise<BrowserAccessibilityNode[]> {
    const page = this.getPage(profileId, targetId);
    const session = await this.createPageSession(page);
    try {
      await session.send('DOM.enable').catch(() => undefined);
      await session.send('Accessibility.enable').catch(() => undefined);
      const tree = await session.send('Accessibility.getFullAXTree', {});
      return normalizeAxTreeNodes(tree, {
        interestingOnly: options.interestingOnly !== false,
        limit: Math.max(1, Math.min(options.limit ?? 2000, 2000)),
      });
    } finally {
      await this.detachSession(session);
    }
  }

  async evaluate(
    profileId: string,
    targetId: string,
    expression: string,
    awaitPromise: boolean,
  ): Promise<BrowserEvaluateResult> {
    const page = this.getPage(profileId, targetId);
    const session = await this.createPageSession(page);
    try {
      const evaluation = await session.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true,
      }) as {
        result?: { type?: string; value?: unknown; unserializableValue?: string; description?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      if (evaluation?.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description
          || evaluation.exceptionDetails.text
          || 'browser_evaluate_failed',
        );
      }
      const remote = evaluation?.result ?? {};
      let json: string | undefined;
      try {
        if (Object.prototype.hasOwnProperty.call(remote, 'value')) {
          json = JSON.stringify(remote.value);
        } else if (typeof remote.unserializableValue === 'string') {
          json = remote.unserializableValue;
        } else if (typeof remote.description === 'string') {
          json = remote.description;
        }
      } catch {
        json = typeof remote.description === 'string' ? remote.description : '';
      }
      const truncated = typeof json === 'string' && json.length > 20_000;
      return {
        ...(typeof remote.type === 'string' ? { type: remote.type } : {}),
        ...(typeof json === 'string' ? { json: json.slice(0, 20_000) } : {}),
        ...(truncated ? { truncated: true } : {}),
      };
    } finally {
      await this.detachSession(session);
    }
  }

  async inspectElement(
    profileId: string,
    targetId: string,
    selector: string,
  ): Promise<BrowserElementContext> {
    const page = this.getPage(profileId, targetId);
    const context = await page.$eval(selector, (element) => {
      const node = element as {
        getAttribute?: (name: string) => string | null;
        getAttributeNames?: () => string[];
        textContent?: string | null;
        tagName?: string;
        id?: string;
        className?: string;
        type?: string;
        name?: string;
        placeholder?: string;
        labels?: ArrayLike<{ textContent?: string | null }>;
        form?: { action?: string };
      };
      const attributes: Record<string, string> = {};
      for (const name of node.getAttributeNames?.() ?? []) {
        const value = node.getAttribute?.(name);
        if (value) {
          attributes[name] = value;
        }
      }
      const label = Array.from(node.labels ?? [])
        .map((item) => item.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      return {
        role: node.getAttribute?.('role') ?? node.tagName?.toLowerCase(),
        accessibleName:
          node.getAttribute?.('aria-label') ??
          node.getAttribute?.('title') ??
          (label || undefined),
        visibleText: node.textContent?.trim().slice(0, 2_000) || undefined,
        inputType: node.type,
        inputName: node.name,
        placeholder: node.placeholder,
        label: label || undefined,
        formAction: node.form?.action,
        attributes,
      };
    });
    return redactElementContext(context);
  }

  async click(profileId: string, targetId: string, selector: string): Promise<void> {
    const page = this.getPage(profileId, targetId);
    try {
      await page.click(selector);
    } catch {
      await evaluatePageBridge(page, {
        action: 'click',
        args: [selector],
      });
    }
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async type(
    profileId: string,
    targetId: string,
    selector: string,
    value: string,
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    try {
      await page.type(selector, value);
    } catch {
      await evaluatePageBridge(page, {
        action: 'type',
        args: [selector, value],
      });
    }
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async fillForm(
    profileId: string,
    targetId: string,
    fields: BrowserFillFieldInput[],
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    for (const field of fields) {
      try {
        await page.type(field.selector, field.value);
      } catch {
        await evaluatePageBridge(page, {
          action: 'type',
          args: [field.selector, field.value],
        });
      }
    }
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async select(
    profileId: string,
    targetId: string,
    selector: string,
    value: string,
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    try {
      await page.select(selector, value);
    } catch {
      await evaluatePageBridge(page, {
        action: 'select',
        args: [selector, value],
      });
    }
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async uploadFile(
    profileId: string,
    targetId: string,
    selector: string,
    filePath: string,
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    const handle = await page.$(selector);
    if (!handle) {
      throw new Error(`Browser upload target ${selector} not found`);
    }
    await handle.uploadFile(filePath);
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async downloadFile(
    profileId: string,
    targetId: string,
    input: BrowserDownloadFileInput,
  ): Promise<BrowserDownloadFileResult> {
    const page = this.getPage(profileId, targetId);
    const downloadDir = this.profileDownloadDirsById.get(profileId)
      ?? path.join(process.cwd(), '.aio-browser-downloads', profileId);
    await fs.promises.mkdir(downloadDir, { recursive: true });
    const session = await this.createPageSession(page);
    await session.send('Page.enable');
    await session.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
    });

    const waitForDownload = waitForCdpDownload(
      session,
      downloadDir,
      input.timeoutMs ?? 60_000,
    );
    if (input.url) {
      await page.goto(input.url, {
        waitUntil: 'domcontentloaded',
        timeout: input.timeoutMs ?? 60_000,
      });
    } else if (input.selector) {
      try {
        await page.click(input.selector);
      } catch {
        await evaluatePageBridge(page, {
          action: 'click',
          args: [input.selector],
        });
      }
    } else {
      throw new Error('Browser download requires selector or url.');
    }

    const download = await waitForDownload;
    await this.refreshPageTarget(profileId, targetId, page);
    return download;
  }

  private async indexPages(profileId: string): Promise<BrowserTarget[]> {
    const browser = this.getBrowser(profileId);
    const pages = await browser.pages();
    const targets: BrowserTarget[] = [];

    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!;
      const targetId = `${profileId}:${index}`;
      this.pagesByTargetId.set(targetId, page);
      this.instrumentPage(targetId, page);
      await this.antiThrottle.register(targetId, page as unknown as AntiThrottlePage);
      const target = await this.refreshPageTarget(profileId, targetId, page);
      targets.push(target);
    }

    return targets;
  }

  private async refreshPageTarget(
    profileId: string,
    targetId: string,
    page: Page,
  ): Promise<BrowserTarget> {
    const current = this.targetRegistry
      .listTargets(profileId)
      .find((target) => target.id === targetId);
    const url = page.url();
    return this.targetRegistry.upsertTarget({
      id: targetId,
      profileId,
      pageId: current?.pageId ?? targetId,
      driverTargetId: current?.driverTargetId ?? targetId,
      mode: current?.mode ?? this.profileModesById.get(profileId) ?? 'session',
      title: await page.title(),
      url,
      origin: this.originFromUrl(url),
      driver: current?.driver ?? 'cdp',
      status: current?.status ?? 'available',
      lastSeenAt: Date.now(),
    });
  }

  private instrumentPage(targetId: string, page: Page): void {
    if (this.instrumentedTargetIds.has(targetId) || typeof page.on !== 'function') {
      return;
    }
    this.instrumentedTargetIds.add(targetId);
    page.on('console', (message) => {
      this.pushBounded(this.consoleByTargetId, targetId, this.consoleEntry(message));
    });
    page.on('request', (request) => {
      this.pushBounded(this.networkByTargetId, targetId, this.networkEntry(request));
    });
  }

  private consoleEntry(message: ConsoleMessage): BrowserConsoleEntry {
    const location = message.location();
    return {
      type: message.type(),
      text: redactBrowserText(message.text()).slice(0, 4_000),
      location: location.url
        ? { ...location, url: redactBrowserUrl(location.url) }
        : location,
      timestamp: Date.now(),
    };
  }

  private networkEntry(request: HTTPRequest): BrowserNetworkRequestEntry {
    return {
      url: redactBrowserUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: redactHeaders(request.headers()),
      timestamp: Date.now(),
    };
  }

  private pushBounded<T>(
    map: Map<string, T[]>,
    targetId: string,
    entry: T,
  ): void {
    const entries = map.get(targetId) ?? [];
    entries.push(entry);
    map.set(targetId, entries.slice(-200));
  }

  private getBrowser(profileId: string): Browser {
    const browser = this.launcher.getBrowser(profileId);
    if (!browser) {
      throw new Error(`Browser profile ${profileId} is not open`);
    }
    return browser;
  }

  private getPage(profileId: string, targetId: string): Page {
    const page = this.pagesByTargetId.get(targetId);
    if (!page || !targetId.startsWith(`${profileId}:`)) {
      throw new Error(`Browser target ${targetId} not found for profile ${profileId}`);
    }
    return page;
  }

  private originFromUrl(url: string): string | undefined {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  private async createPageSession(page: Page): Promise<BrowserCdpSession> {
    const candidate = page as unknown as {
      createCDPSession?: () => Promise<BrowserCdpSession>;
      target?: () => {
        createCDPSession?: () => Promise<BrowserCdpSession>;
      };
    };
    const session = candidate.createCDPSession
      ? await candidate.createCDPSession()
      : await candidate.target?.().createCDPSession?.();
    if (!session) {
      throw new Error('Browser target does not expose a CDP session for downloads.');
    }
    return session;
  }

  private async detachSession(session: BrowserCdpSession): Promise<void> {
    const detachable = session as BrowserCdpSession & { detach?: () => Promise<void> };
    if (typeof detachable.detach === 'function') {
      await detachable.detach().catch(() => undefined);
    }
  }
}

let puppeteerBrowserDriver: PuppeteerBrowserDriver | null = null;

export function getPuppeteerBrowserDriver(): PuppeteerBrowserDriver {
  if (!puppeteerBrowserDriver) {
    // Route per-profile between a locally launched Chrome and a remote node's
    // Chrome (Path 2). Local-only profiles behave exactly as before.
    puppeteerBrowserDriver = new PuppeteerBrowserDriver({
      launcher: new RoutingBrowserLauncher({ local: new BrowserProcessLauncher() }),
    });
  }
  return puppeteerBrowserDriver;
}

export function _resetPuppeteerBrowserDriverForTesting(): void {
  puppeteerBrowserDriver = null;
}
