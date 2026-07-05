export const BROWSER_EXTENSION_CONTACT_FRESH_MS = 90_000;

export interface BrowserExtensionContactSnapshot {
  nodeId: string;
  lastContactAt?: number;
  silent: boolean;
  staleForMs?: number;
}

export interface BrowserExtensionContactStateReader {
  getLastExtensionContactAt(nodeId: string): number | undefined;
  isExtensionContactFresh(nodeId: string): boolean;
  describeExtensionContact(nodeId: string): BrowserExtensionContactSnapshot;
}

export interface BrowserExtensionContactStateOptions {
  now?: () => number;
  freshMs?: number;
}

export class BrowserExtensionContactState implements BrowserExtensionContactStateReader {
  private static instance: BrowserExtensionContactState | null = null;
  private readonly now: () => number;
  private readonly freshMs: number;
  private readonly lastContactAtByNode = new Map<string, number>();

  constructor(options: BrowserExtensionContactStateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.freshMs = options.freshMs ?? BROWSER_EXTENSION_CONTACT_FRESH_MS;
  }

  static getInstance(): BrowserExtensionContactState {
    if (!this.instance) {
      this.instance = new BrowserExtensionContactState();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  markExtensionContact(nodeId: string, contactedAt = this.now()): void {
    this.lastContactAtByNode.set(nodeId, contactedAt);
  }

  forgetNode(nodeId: string): void {
    this.lastContactAtByNode.delete(nodeId);
  }

  getLastExtensionContactAt(nodeId: string): number | undefined {
    return this.lastContactAtByNode.get(nodeId);
  }

  isExtensionContactFresh(nodeId: string): boolean {
    const lastContactAt = this.getLastExtensionContactAt(nodeId);
    return isBrowserExtensionContactFresh(lastContactAt, this.now(), this.freshMs);
  }

  describeExtensionContact(nodeId: string): BrowserExtensionContactSnapshot {
    return describeBrowserExtensionContact(
      nodeId,
      this.getLastExtensionContactAt(nodeId),
      this.now(),
      this.freshMs,
    );
  }
}

export function getBrowserExtensionContactState(): BrowserExtensionContactState {
  return BrowserExtensionContactState.getInstance();
}

export function describeBrowserExtensionContact(
  nodeId: string,
  lastContactAt: number | undefined,
  now: number,
  freshMs = BROWSER_EXTENSION_CONTACT_FRESH_MS,
): BrowserExtensionContactSnapshot {
  const silent = !isBrowserExtensionContactFresh(lastContactAt, now, freshMs);
  return {
    nodeId,
    ...(lastContactAt !== undefined ? { lastContactAt } : {}),
    silent,
    ...(lastContactAt !== undefined && silent
      ? { staleForMs: Math.max(0, now - lastContactAt - freshMs) }
      : {}),
  };
}

export function isBrowserExtensionContactFresh(
  lastContactAt: number | undefined,
  now: number,
  freshMs = BROWSER_EXTENSION_CONTACT_FRESH_MS,
): boolean {
  return lastContactAt !== undefined && now - lastContactAt <= freshMs;
}
