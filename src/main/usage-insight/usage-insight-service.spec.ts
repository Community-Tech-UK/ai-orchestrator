import { describe, expect, it, vi } from 'vitest';
import type { UsageRequestFact, UsageScanProgress } from '../../shared/usage-insight/usage-insight.types';
import type { TranscriptScan } from './claude-transcript-usage-scanner';
import type { AttributionDigest } from './usage-attribution-reader';
import { UsageInsightService, buildDataset, type SessionLinks, type UsageInsightDeps } from './usage-insight-service';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const BASE = NOW - DAY;

function fact(overrides: Partial<UsageRequestFact> = {}): UsageRequestFact {
  return {
    sessionId: 'sess-1', at: BASE, model: 'claude-opus-5', input: 100, cacheWrite: 0, cacheRead: 0,
    output: 10, helper: false, bigResult: false, ...overrides,
  };
}

function emptyAttribution(overrides: Partial<AttributionDigest> = {}): AttributionDigest {
  return { parentByInstance: new Map(), effortByInstance: new Map(), sessionToInstance: new Map(), unreadableFiles: 0, ...overrides };
}

function emptyScan(overrides: Partial<TranscriptScan> = {}): TranscriptScan {
  return { requests: [], sessionStarts: new Map(), notes: [], ...overrides };
}

/** A scanner whose read finishes when the test says so. */
function controlledScanner(scan: TranscriptScan) {
  let finish: () => void = () => undefined;
  let fail: (error: Error) => void = () => undefined;
  const refresh = vi.fn((onProgress?: (progress: UsageScanProgress) => void) => {
    onProgress?.({ filesDone: 1, filesTotal: 4, bytesDone: 50, bytesTotal: 200 });
    return new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  });
  return { refresh, collect: vi.fn(() => scan), finish: () => finish(), fail: (error: Error) => fail(error) };
}

function setup(options: {
  scan?: TranscriptScan;
  attribution?: AttributionDigest;
  links?: SessionLinks;
  linksUnavailable?: boolean;
  instances?: Record<string, { provider: string; sessionId?: string; remote?: boolean }>;
} = {}) {
  const scanner = controlledScanner(options.scan ?? emptyScan({ requests: [fact(), fact({ at: BASE + MINUTE, input: 200_000 })] }));
  let now = NOW;
  const deps: UsageInsightDeps = {
    scanner,
    attribution: { read: vi.fn(async () => options.attribution ?? emptyAttribution()) },
    loadSessionLinks: vi.fn(async () => ({ links: options.links ?? new Map(), unavailable: options.linksUnavailable })),
    resolveInstance: (id) => options.instances?.[id],
    now: () => now,
  };
  const service = new UsageInsightService(deps);
  /** Lets the pending read finish and waits until the service reports a settled report. */
  const settle = async () => {
    scanner.finish();
    await vi.waitFor(() => {
      const response = service.getResponse({});
      expect(response.status === 'ready' && !response.refreshing).toBe(true);
    });
  };
  return { service, scanner, deps, settle, advance: (ms: number) => { now += ms; } };
}

describe('UsageInsightService', () => {
  describe('status', () => {
    it('says it is reading, with progress, until the first read is done', () => {
      const { service } = setup();
      expect(service.getResponse({})).toEqual({
        status: 'scanning',
        progress: { filesDone: 1, filesTotal: 4, bytesDone: 50, bytesTotal: 200 },
      });
    });

    it('answers with a report once the read has finished', async () => {
      const { service, settle } = setup();
      service.getResponse({});
      await settle();
      const response = service.getResponse({});
      expect(response.status).toBe('ready');
      if (response.status !== 'ready') return;
      expect(response.refreshing).toBe(false);
      expect(response.report.totals.requests).toBe(2);
      expect(response.report.scope).toEqual({ kind: 'all' });
      expect(response.report.causes.find((cause) => cause.id === 'cacheMiss')?.requests).toBe(1);
    });

    it('starts only one read however many callers ask while it runs', async () => {
      const { service, scanner, settle } = setup();
      service.getResponse({});
      service.getResponse({});
      service.getResponse({ refresh: true });
      expect(scanner.refresh).toHaveBeenCalledTimes(1);
      await settle();
    });

    it('does not read again while the result is fresh', async () => {
      const { service, scanner, settle, advance } = setup();
      service.getResponse({});
      await settle();
      advance(4 * MINUTE);
      service.getResponse({});
      expect(scanner.refresh).toHaveBeenCalledTimes(1);
    });

    it('keeps showing the old report while a stale one is refreshed', async () => {
      const { service, scanner, settle, advance } = setup();
      service.getResponse({});
      await settle();
      advance(6 * MINUTE);
      const response = service.getResponse({});
      expect(scanner.refresh).toHaveBeenCalledTimes(2);
      expect(response).toMatchObject({ status: 'ready', refreshing: true });
    });

    it('reads again straight away when asked to refresh', async () => {
      const { service, scanner, settle } = setup();
      service.getResponse({});
      await settle();
      const response = service.getResponse({ refresh: true });
      expect(scanner.refresh).toHaveBeenCalledTimes(2);
      expect(response).toMatchObject({ status: 'ready', refreshing: true });
    });

    it('reuses the same report object for the same scope until the data changes', async () => {
      const { service, settle } = setup();
      service.getResponse({});
      await settle();
      const first = service.getResponse({});
      const second = service.getResponse({});
      expect(first.status === 'ready' && second.status === 'ready' && first.report === second.report).toBe(true);
    });
  });

  describe('when the read fails', () => {
    it('reports the failure, and does not hammer a failing read', async () => {
      const { service, scanner, advance } = setup();
      service.getResponse({});
      scanner.fail(new Error('disk went away'));
      await vi.waitFor(() => expect(service.getResponse({}).status).toBe('error'));
      expect(service.getResponse({})).toEqual({ status: 'error', message: 'disk went away' });
      expect(scanner.refresh).toHaveBeenCalledTimes(1);
      advance(31_000);
      service.getResponse({});
      expect(scanner.refresh).toHaveBeenCalledTimes(2);
    });

    it('tries again at once when asked to', async () => {
      const { service, scanner } = setup();
      service.getResponse({});
      scanner.fail(new Error('boom'));
      await vi.waitFor(() => expect(service.getResponse({}).status).toBe('error'));
      service.getResponse({ refresh: true });
      expect(scanner.refresh).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good report and says the update failed', async () => {
      const { service, scanner, settle } = setup();
      service.getResponse({});
      await settle();
      service.getResponse({ refresh: true });
      scanner.fail(new Error('could not update'));
      await vi.waitFor(() => {
        const response = service.getResponse({});
        expect(response).toMatchObject({ status: 'ready', refreshing: false, refreshError: 'could not update' });
      });
    });

    it('treats a failure to read the cost log as a failure of the read', async () => {
      const { service, scanner, deps } = setup();
      vi.mocked(deps.attribution.read).mockRejectedValueOnce(new Error('log unreadable'));
      service.getResponse({});
      scanner.finish();
      await vi.waitFor(() => expect(service.getResponse({})).toEqual({ status: 'error', message: 'log unreadable' }));
    });
  });

  describe('one session', () => {
    const instances = { 'inst-claude': { provider: 'claude', sessionId: 'sess-1' }, 'inst-codex': { provider: 'codex', sessionId: 'thread-9' } };

    it('refuses sessions that are not open', () => {
      const { service, scanner } = setup({ instances });
      expect(service.getResponse({ instanceId: 'gone' })).toEqual({ status: 'unsupported', reason: 'unknown-instance' });
      expect(scanner.refresh).not.toHaveBeenCalled();
    });

    it('refuses sessions that are not Claude, because only Claude transcripts carry per-request detail', () => {
      const { service } = setup({ instances });
      expect(service.getResponse({ instanceId: 'inst-codex' })).toEqual({ status: 'unsupported', reason: 'not-claude' });
    });

    it('refuses sessions running on another computer, because their transcripts are kept there', () => {
      const { service, scanner } = setup({ instances: { 'inst-far': { provider: 'claude', sessionId: 'sess-1', remote: true } } });
      expect(service.getResponse({ instanceId: 'inst-far' })).toEqual({ status: 'unsupported', reason: 'remote' });
      expect(scanner.refresh).not.toHaveBeenCalled();
    });

    it('reports only that session, using the cost log to find all the Claude sessions it has run', async () => {
      const scan = emptyScan({
        requests: [
          fact({ sessionId: 'sess-1', input: 200_000 }),
          fact({ sessionId: 'sess-old', at: BASE + MINUTE }),
          fact({ sessionId: 'someone-else', at: BASE + 2 * MINUTE, input: 200_000 }),
        ],
      });
      const links: SessionLinks = new Map([['sess-old', ['inst-claude']], ['someone-else', ['inst-other']]]);
      const { service, settle } = setup({ scan, links, instances });
      service.getResponse({ instanceId: 'inst-claude' });
      await settle();
      const response = service.getResponse({ instanceId: 'inst-claude' });
      expect(response.status).toBe('ready');
      if (response.status !== 'ready') return;
      expect(response.report.scope).toEqual({ kind: 'session', instanceId: 'inst-claude' });
      expect(response.report.totals.requests).toBe(2);
      expect(response.report.causes.find((cause) => cause.id === 'cacheMiss')?.requests).toBe(1);
    });

    it('answers for a session with nothing recorded yet', async () => {
      const { service, settle } = setup({ instances: { fresh: { provider: 'claude' } } });
      service.getResponse({ instanceId: 'fresh' });
      await settle();
      const response = service.getResponse({ instanceId: 'fresh' });
      expect(response.status === 'ready' && response.report.totals.requests).toBe(0);
    });

    it('keeps separate reports for separate scopes', async () => {
      const { service, settle } = setup({ instances });
      service.getResponse({});
      await settle();
      const all = service.getResponse({});
      const one = service.getResponse({ instanceId: 'inst-claude' });
      expect(all.status === 'ready' && one.status === 'ready' && all.report !== one.report).toBe(true);
    });
  });

  describe('what it could not read', () => {
    it('says so when the saved cost history is unavailable', async () => {
      const { service, settle } = setup({ linksUnavailable: true });
      service.getResponse({});
      await settle();
      const response = service.getResponse({});
      expect(response.status === 'ready' && response.report.notes).toContainEqual({ code: 'session-links-unavailable' });
    });

    it('says so when days of the cost log could not be read', async () => {
      const { service, settle } = setup({ attribution: emptyAttribution({ unreadableFiles: 2 }) });
      service.getResponse({});
      await settle();
      const response = service.getResponse({});
      expect(response.status === 'ready' && response.report.notes).toContainEqual({ code: 'cost-log-unreadable', count: 2 });
    });

    it('says nothing when everything was readable', async () => {
      const { service, settle } = setup();
      service.getResponse({});
      await settle();
      const response = service.getResponse({});
      expect(response.status === 'ready' && response.report.notes.map((note) => note.code)).toEqual([]);
    });
  });

  it('stops reading when disposed', async () => {
    const { service, scanner } = setup();
    service.dispose();
    service.getResponse({});
    expect(scanner.refresh).not.toHaveBeenCalled();
  });
});

describe('buildDataset', () => {
  it('links sessions to the Harness sessions that ran them, and helpers to their parent', () => {
    const attribution = emptyAttribution({
      parentByInstance: new Map([['inst-child', 'inst-root']]),
      effortByInstance: new Map([['inst-root', [{ at: BASE, effort: 'max' }]], ['inst-child', [{ at: BASE, effort: 'high' }]]]),
    });
    const links: SessionLinks = new Map([['sess-root', ['inst-root']], ['sess-child', ['inst-child']]]);
    const scan = emptyScan({
      requests: [fact({ sessionId: 'sess-root' }), fact({ sessionId: 'sess-child' }), fact({ sessionId: 'sess-terminal' })],
      sessionStarts: new Map([['sess-root', 52_000], ['sess-terminal', 9_000]]),
    });
    const { sessions } = buildDataset(scan, attribution, links, NOW);

    expect(sessions.get('sess-root')).toMatchObject({
      instanceId: 'inst-root', groupKey: 'harness:inst-root', isHelperSession: false,
      startPromptTokens: 52_000, efforts: [{ at: BASE, effort: 'max' }],
    });
    expect(sessions.get('sess-child')).toMatchObject({
      instanceId: 'inst-child', groupKey: 'harness:inst-root', isHelperSession: true, efforts: [{ at: BASE, effort: 'high' }],
    });
    // A session run from a terminal is on its own and nothing is known about its effort.
    expect(sessions.get('sess-terminal')).toEqual({
      sessionId: 'sess-terminal', startPromptTokens: 9_000, groupKey: 'sess-terminal', isHelperSession: false, efforts: [],
    });
  });

  it('follows a chain of helpers up to the top session', () => {
    const attribution = emptyAttribution({ parentByInstance: new Map([['c', 'b'], ['b', 'a']]) });
    const { sessions } = buildDataset(
      emptyScan({ requests: [fact({ sessionId: 's-c' })] }), attribution, new Map([['s-c', ['c']]]), NOW,
    );
    expect(sessions.get('s-c')?.groupKey).toBe('harness:a');
  });

  it('does not loop on a chain that points back at itself', () => {
    const attribution = emptyAttribution({ parentByInstance: new Map([['x', 'y'], ['y', 'x']]) });
    expect(() => buildDataset(emptyScan({ requests: [fact({ sessionId: 's-x' })] }), attribution, new Map([['s-x', ['x']]]), NOW)).not.toThrow();
  });

  it('uses the most recent Harness session for a Claude session several have run, and joins their efforts', () => {
    const attribution = emptyAttribution({
      effortByInstance: new Map([['older', [{ at: BASE, effort: 'high' }]], ['newer', [{ at: BASE + MINUTE, effort: 'max' }]]]),
    });
    const { sessions, instanceSessions } = buildDataset(
      emptyScan({ requests: [fact({ sessionId: 'shared' })] }), attribution, new Map([['shared', ['older', 'newer']]]), NOW,
    );
    expect(sessions.get('shared')).toMatchObject({
      instanceId: 'newer',
      efforts: [{ at: BASE, effort: 'high' }, { at: BASE + MINUTE, effort: 'max' }],
    });
    expect([...(instanceSessions.get('older') ?? [])]).toEqual(['shared']);
    expect([...(instanceSessions.get('newer') ?? [])]).toEqual(['shared']);
  });

  it('adds sessions named by recent turns in the attribution log', () => {
    const attribution = emptyAttribution({ sessionToInstance: new Map([['sess-new', 'inst-new']]) });
    const { sessions } = buildDataset(emptyScan({ requests: [fact({ sessionId: 'sess-new' })] }), attribution, new Map(), NOW);
    expect(sessions.get('sess-new')).toMatchObject({ instanceId: 'inst-new' });
  });

  it('passes the notes from reading the files through', () => {
    const dataset = buildDataset(emptyScan({ notes: [{ code: 'lines-skipped', count: 2 }] }), emptyAttribution(), new Map(), NOW);
    expect(dataset.notes).toEqual([{ code: 'lines-skipped', count: 2 }]);
    expect(dataset.generatedAt).toBe(NOW);
  });
});
