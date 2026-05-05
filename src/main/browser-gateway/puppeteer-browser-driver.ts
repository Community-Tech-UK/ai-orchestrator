import type { Browser, ConsoleMessage, HTTPRequest, Page } from 'puppeteer-core';
import type {
  BrowserElementContext,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserProcessLauncher,
  type BrowserProcessRuntime,
} from './browser-process-launcher';
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

export interface PuppeteerBrowserDriverOptions {
  launcher?: Pick<
    BrowserProcessLauncher,
    'launchProfile' | 'getBrowser' | 'closeProfile'
  >;
  targetRegistry?: BrowserTargetRegistry;
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

  constructor(options: PuppeteerBrowserDriverOptions = {}) {
    this.launcher = options.launcher ?? new BrowserProcessLauncher();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
  }

  async openProfile(
    profile: BrowserProfile,
    startUrl?: string,
  ): Promise<BrowserTarget[]> {
    if (!profile.userDataDir) {
      throw new Error(`Browser profile ${profile.id} has no userDataDir`);
    }
    await this.launcher.launchProfile({
      profile,
      userDataDir: profile.userDataDir,
      startUrl,
    });
    return this.indexPages(profile.id);
  }

  async closeProfile(profileId: string): Promise<void> {
    await this.launcher.closeProfile(profileId);
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
    const text = await page.evaluate(() => {
      const pageGlobal = globalThis as unknown as {
        document?: { body?: { innerText?: string } };
      };
      return pageGlobal.document?.body?.innerText?.slice(0, 12_000) ?? '';
    });
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
    await page.waitForSelector(selectorOrText, { timeout: timeoutMs });
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
    await page.click(selector);
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async type(
    profileId: string,
    targetId: string,
    selector: string,
    value: string,
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    await page.type(selector, value);
    await this.refreshPageTarget(profileId, targetId, page);
  }

  async fillForm(
    profileId: string,
    targetId: string,
    fields: BrowserFillFieldInput[],
  ): Promise<void> {
    const page = this.getPage(profileId, targetId);
    for (const field of fields) {
      await page.type(field.selector, field.value);
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
    await page.select(selector, value);
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

  private async indexPages(profileId: string): Promise<BrowserTarget[]> {
    const browser = this.getBrowser(profileId);
    const pages = await browser.pages();
    const targets: BrowserTarget[] = [];

    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!;
      const targetId = `${profileId}:${index}`;
      this.pagesByTargetId.set(targetId, page);
      this.instrumentPage(targetId, page);
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
      mode: current?.mode ?? 'session',
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
}

let puppeteerBrowserDriver: PuppeteerBrowserDriver | null = null;

export function getPuppeteerBrowserDriver(): PuppeteerBrowserDriver {
  if (!puppeteerBrowserDriver) {
    puppeteerBrowserDriver = new PuppeteerBrowserDriver();
  }
  return puppeteerBrowserDriver;
}

export function _resetPuppeteerBrowserDriverForTesting(): void {
  puppeteerBrowserDriver = null;
}
