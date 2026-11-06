import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverTranscriptFiles, resolveClaudeConfigRoots } from './claude-transcript-files';
import { assistantLine, setModified, writeTranscript } from './claude-transcript.test-helpers';
import { ClaudeTranscriptScanner } from './claude-transcript-usage-scanner';
import { UsageInsightService } from './usage-insight-service';

const NOW = Date.parse('2026-10-28T12:00:00Z');
const denied = () => Object.assign(new Error('transcript folder cannot be read'), { code: 'EACCES' });

describe('transcript discovery coverage', () => {
  let root: string;
  let service: UsageInsightService;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'transcript-coverage-')));
    const file = join(root, 'projects', 'project', 'session', 'subagents', 'helper.jsonl');
    writeTranscript(file, [assistantLine({ id: '1', at: NOW - 60_000 })]);
    setModified(file, NOW - 60_000);
    service = new UsageInsightService({
      scanner: new ClaudeTranscriptScanner({ roots: () => [root], now: () => NOW }),
      attribution: { read: async () => ({ sessionToInstance: new Map(), parentByInstance: new Map(), effortByInstance: new Map(), unreadableFiles: 0 }) },
      loadSessionLinks: async () => ({ links: new Map() }),
      resolveInstance: () => undefined,
      now: () => NOW,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    service.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function refreshed() {
    await vi.waitFor(() => {
      const response = service.getResponse({});
      expect(response.status === 'ready' && !response.refreshing).toBe(true);
    });
    return service.getResponse({});
  }

  it.each(['projects', 'projects/project', 'projects/project/session/subagents'])(
    'keeps measured usage and reports a refresh failure when %s is unreadable', async (relative) => {
      expect(await refreshed()).toMatchObject({ status: 'ready', report: { totals: { requests: 1 } } });
      const original = fs.promises.readdir;
      const blocked = join(root, relative);
      const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((...args: Parameters<typeof original>) => {
        if (args[0] === blocked) return Promise.reject(denied());
        return original(...args);
      });
      service.getResponse({ refresh: true });
      expect(await refreshed()).toMatchObject({
        status: 'ready', refreshError: expect.any(String), report: { totals: { requests: 1 } },
      });
      spy.mockRestore();
      service.getResponse({ refresh: true });
      const recovered = await refreshed();
      expect(recovered).toMatchObject({ status: 'ready', report: { totals: { requests: 1 } } });
      expect(recovered).not.toHaveProperty('refreshError');
    },
  );

  it('reports failure on the first scan instead of claiming there is no usage', async () => {
    vi.spyOn(fs.promises, 'readdir').mockRejectedValue(denied());
    await vi.waitFor(() => expect(service.getResponse({})).toMatchObject({ status: 'error' }));
  });

  it('does not silently remove a transcript when stat fails', async () => {
    vi.spyOn(fs.promises, 'stat').mockRejectedValue(denied());
    await expect(discoverTranscriptFiles([root], NOW - 86_400_000)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('reports an invalid profile directory rather than dropping those accounts', () => {
    fs.writeFileSync(join(root, 'claude-cli-profiles'), 'not a directory');
    expect(() => resolveClaudeConfigRoots({ home: root, stateRoot: root, env: {} })).toThrow();
  });

  it('reports an invalid config home path rather than omitting its usage', () => {
    const home = join(root, 'home');
    fs.writeFileSync(home, 'not a directory');
    expect(() => resolveClaudeConfigRoots({ home, env: {} })).toThrow();
  });

  // Unix modes cannot deny the root user and do not express Windows directory access.
  const cannotDenyRead = process.platform === 'win32' || process.getuid?.() === 0;
  it.skipIf(cannotDenyRead)('reports a real permission failure when listing account profiles', () => {
    const profiles = join(root, 'claude-cli-profiles');
    fs.mkdirSync(profiles);
    fs.chmodSync(profiles, 0o000);
    try {
      expect(() => resolveClaudeConfigRoots({ home: root, stateRoot: root, env: {} }))
        .toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      fs.chmodSync(profiles, 0o700);
    }
  });

  it.skipIf(cannotDenyRead)('reports a real permission failure when resolving a config home', () => {
    const home = join(root, 'home');
    fs.mkdirSync(join(home, '.claude'), { recursive: true });
    fs.chmodSync(home, 0o000);
    try {
      expect(() => resolveClaudeConfigRoots({ home, env: {} }))
        .toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      fs.chmodSync(home, 0o700);
    }
  });
});
