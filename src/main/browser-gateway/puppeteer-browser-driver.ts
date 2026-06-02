import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Browser, ConsoleMessage, HTTPRequest, Page } from 'puppeteer-core';
import type {
  BrowserElementContext,
  BrowserDownloadFileResult,
  BrowserProfile,
  BrowserProfileMode,
  BrowserTarget,
} from '@contracts/types/browser';
import {
  BrowserProcessLauncher,
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

  constructor(options: PuppeteerBrowserDriverOptions = {}) {
    this.launcher = options.launcher ?? new BrowserProcessLauncher();
    this.targetRegistry = options.targetRegistry ?? getBrowserTargetRegistry();
  }

  async openProfile(
    profile: BrowserProfile,
    startUrl?: string,
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
      });
      return this.indexPages(profile.id);
    } catch (error) {
      this.profileModesById.delete(profile.id);
      throw error;
    }
  }

  async closeProfile(profileId: string): Promise<void> {
    await this.launcher.closeProfile(profileId);
    this.profileModesById.delete(profileId);
    this.profileDownloadDirsById.delete(profileId);
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
}

interface BrowserCdpSession {
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

function waitForCdpDownload(
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

interface PageBridgeSnapshot {
  title: string;
  text: string;
}

function isPageBridgeSnapshot(value: unknown): value is PageBridgeSnapshot {
  return Boolean(
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof (value as Partial<PageBridgeSnapshot>).text === 'string',
  );
}

interface PageBridgeInput {
  action: string;
  args: unknown[];
}

interface PageBridgeRoot {
  textContent?: string | null;
  querySelector?: (selector: string) => PageBridgeElement | null;
  querySelectorAll?: (selector: string) => ArrayLike<PageBridgeElement>;
}

interface PageBridgeElement extends PageBridgeRoot {
  tagName?: string;
  innerText?: string;
  value?: string;
  isContentEditable?: boolean;
  shadowRoot?: PageBridgeRoot | null;
  scrollIntoView?: (options?: unknown) => void;
  focus?: () => void;
  click?: () => void;
  dispatchEvent?: (event: unknown) => boolean;
}

interface PageBridgeDocument extends PageBridgeRoot {
  title: string;
  body?: PageBridgeElement;
  documentElement: PageBridgeElement;
}

interface PageBridgeGlobal {
  document: PageBridgeDocument;
  InputEvent: new (type: string, options?: Record<string, unknown>) => unknown;
  Event: new (type: string, options?: Record<string, unknown>) => unknown;
  MutationObserver: new (callback: () => void) => {
    observe: (target: PageBridgeElement, options: Record<string, unknown>) => void;
    disconnect: () => void;
  };
}

function evaluatePageBridge(page: Page, input: PageBridgeInput): Promise<unknown> {
  const evaluate = page.evaluate as unknown as (
    fn: (payload: PageBridgeInput) => unknown,
    payload: PageBridgeInput,
  ) => Promise<unknown>;
  return evaluate.call(page, pageBridgeScript, input);
}

function pageBridgeScript(input: PageBridgeInput): unknown {
  const { action, args } = input;
  const pageGlobal = globalThis as unknown as PageBridgeGlobal;
  const documentRef = pageGlobal.document;

  function deepQuerySelector(
    selector: string,
    root: PageBridgeRoot = documentRef,
  ): PageBridgeElement | null {
    const direct = root.querySelector?.(selector);
    if (direct) {
      return direct;
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of Array.from(nodes as ArrayLike<PageBridgeElement>)) {
      if (!node.shadowRoot) {
        continue;
      }
      const found = deepQuerySelector(selector, node.shadowRoot);
      if (found) {
        return found;
      }
    }
    return null;
  }

  function collectVisibleText(
    root: PageBridgeRoot = documentRef,
    seen = new Set<PageBridgeRoot>(),
  ): string {
    if (seen.has(root)) {
      return '';
    }
    seen.add(root);
    const parts = [];
    if (root === documentRef) {
      parts.push(documentRef.body?.innerText || '');
    } else {
      parts.push(root.textContent || '');
    }
    const nodes = root.querySelectorAll?.('*') ?? [];
    for (const node of Array.from(nodes as ArrayLike<PageBridgeElement>)) {
      if (node.shadowRoot) {
        parts.push(collectVisibleText(node.shadowRoot, seen));
      }
    }
    return parts
      .map((part) => String(part).trim())
      .filter(Boolean)
      .join('\n');
  }

  function requireElement(selector: string): PageBridgeElement {
    const element = deepQuerySelector(selector);
    if (!element) {
      throw new Error(`No element matches selector: ${selector}`);
    }
    return element;
  }

  function describeElement(element: PageBridgeElement): Record<string, string | undefined> {
    return {
      tagName: element.tagName,
      text: (element.innerText || element.textContent || '').slice(0, 1000),
      value: typeof element.value === 'string' ? element.value.slice(0, 1000) : undefined,
    };
  }

  function typeIntoElement(selector: string, value: string): Record<string, string | undefined> {
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      element.value = value;
    }
    element.dispatchEvent?.(new pageGlobal.InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value,
    }));
    element.dispatchEvent?.(new pageGlobal.Event('change', { bubbles: true }));
    return describeElement(element);
  }

  if (action === 'snapshot') {
    return {
      title: documentRef.title,
      text: collectVisibleText().slice(0, 120_000),
    };
  }

  if (action === 'click') {
    const [selector] = args as [string];
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.click?.();
    return describeElement(element);
  }

  if (action === 'type') {
    const [selector, value] = args as [string, string];
    return typeIntoElement(selector, value);
  }

  if (action === 'select') {
    const [selector, value] = args as [string, string];
    const element = requireElement(selector);
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    element.value = value;
    element.dispatchEvent?.(new pageGlobal.Event('input', { bubbles: true }));
    element.dispatchEvent?.(new pageGlobal.Event('change', { bubbles: true }));
    return describeElement(element);
  }

  if (action === 'wait_for') {
    const [selector, timeoutMs] = args as [string, number];
    return new Promise((resolve, reject) => {
      const existing = deepQuerySelector(selector);
      if (existing) {
        resolve(describeElement(existing));
        return;
      }
      const observer = new pageGlobal.MutationObserver(() => {
        const element = deepQuerySelector(selector);
        if (!element) {
          return;
        }
        clearTimeout(timeout);
        observer.disconnect();
        resolve(describeElement(element));
      });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timed out waiting for selector: ${selector}`));
      }, timeoutMs);
      observer.observe(documentRef.documentElement, {
        childList: true,
        subtree: true,
      });
    });
  }

  throw new Error(`Unsupported page bridge action: ${action}`);
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
