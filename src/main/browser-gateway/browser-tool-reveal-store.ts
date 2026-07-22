/**
 * Per-instance MCP tool-surface continuity for the Browser Gateway forwarder
 * (reliability hardening, 2026-07-17).
 *
 * With WS9 deferral the forwarder hides non-core tools until revealed, and the
 * reveal state used to live only inside the forwarder process — an MCP
 * reconnect (forwarder restart) silently re-hid every revealed tool
 * (`browser_evaluate` vanishing mid-task). The parent now remembers the
 * revealed names per instanceId so a restarted forwarder restores the exact
 * pre-reconnect tool surface before its first `tools/list`.
 *
 * Also records the forwarder's last self-reported tool surface + contract
 * version so `browser.health` can assert schema-match and tool parity.
 */

export interface BrowserReportedToolSurface {
  names: string[];
  revealedNames: string[];
  protocolVersion: number;
  surfaceHash: string;
  reportedAt: number;
  /** Set when this forwarder failed to restore its revealed set on startup. */
  revealRestoreFailed?: boolean;
}

export interface BrowserToolSurfaceParity {
  reportedCount: number;
  expectedCount: number;
  missing: string[];
  extra: string[];
  surfaceHashMatch: boolean;
  protocolVersionMatch: boolean;
}

const MAX_TRACKED_INSTANCES = 500;
const MAX_NAMES = 200;

export class BrowserToolRevealStore {
  private static instance: BrowserToolRevealStore | null = null;
  private readonly revealedByInstance = new Map<string, Set<string>>();
  private readonly surfaceByInstance = new Map<string, BrowserReportedToolSurface>();

  static getInstance(): BrowserToolRevealStore {
    if (!this.instance) {
      this.instance = new BrowserToolRevealStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  recordRevealed(instanceId: string, names: string[]): void {
    const existing = this.revealedByInstance.get(instanceId) ?? new Set<string>();
    for (const name of names.slice(0, MAX_NAMES)) {
      existing.add(name);
    }
    this.revealedByInstance.set(instanceId, existing);
    this.evictOldest(this.revealedByInstance);
  }

  getRevealed(instanceId: string): string[] {
    return [...(this.revealedByInstance.get(instanceId) ?? [])];
  }

  recordSurface(instanceId: string, surface: BrowserReportedToolSurface): void {
    this.surfaceByInstance.set(instanceId, {
      ...surface,
      names: surface.names.slice(0, MAX_NAMES),
      revealedNames: surface.revealedNames.slice(0, MAX_NAMES),
    });
    this.evictOldest(this.surfaceByInstance);
  }

  getSurface(instanceId: string): BrowserReportedToolSurface | null {
    return this.surfaceByInstance.get(instanceId) ?? null;
  }

  listSurfaces(): Array<{ instanceId: string; surface: BrowserReportedToolSurface }> {
    return [...this.surfaceByInstance.entries()].map(([instanceId, surface]) => ({
      instanceId,
      surface,
    }));
  }

  private evictOldest(map: Map<string, unknown>): void {
    while (map.size > MAX_TRACKED_INSTANCES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      map.delete(oldest);
    }
  }
}

export function getBrowserToolRevealStore(): BrowserToolRevealStore {
  return BrowserToolRevealStore.getInstance();
}

/** Compare a reported surface against the expected full tool surface. */
export function computeBrowserToolSurfaceParity(params: {
  reported: BrowserReportedToolSurface;
  expectedNames: string[];
  expectedSurfaceHash: string;
  expectedProtocolVersion: number;
}): BrowserToolSurfaceParity {
  const reportedSet = new Set(params.reported.names);
  const expectedSet = new Set(params.expectedNames);
  return {
    reportedCount: params.reported.names.length,
    expectedCount: params.expectedNames.length,
    missing: params.expectedNames.filter((name) => !reportedSet.has(name)),
    extra: params.reported.names.filter((name) => !expectedSet.has(name)),
    surfaceHashMatch: params.reported.surfaceHash === params.expectedSurfaceHash,
    protocolVersionMatch:
      params.reported.protocolVersion === params.expectedProtocolVersion,
  };
}
