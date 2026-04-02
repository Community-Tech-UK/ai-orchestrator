// src/main/session/__tests__/resume-hint.spec.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test' },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

// Use real fs for these tests — we write to a real temp directory
const TEST_DIR = path.join(os.tmpdir(), `resume-hint-test-${process.pid}`);

vi.mock('../resume-hint', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../resume-hint')>();
  return actual;
});

import {
  ResumeHintManager,
  getResumeHintManager,
  type ResumeHint,
} from '../resume-hint';

describe('ResumeHintManager', () => {
  beforeEach(() => {
    ResumeHintManager._resetForTesting();
    // Clean test directory
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    ResumeHintManager._resetForTesting();
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ResumeHintManager.getInstance(TEST_DIR);
      const b = ResumeHintManager.getInstance(TEST_DIR);
      expect(a).toBe(b);
    });

    it('getResumeHintManager() returns the singleton', () => {
      const mgr = getResumeHintManager(TEST_DIR);
      expect(mgr).toBe(ResumeHintManager.getInstance(TEST_DIR));
    });

    it('_resetForTesting creates a fresh instance', () => {
      const a = ResumeHintManager.getInstance(TEST_DIR);
      ResumeHintManager._resetForTesting();
      const b = ResumeHintManager.getInstance(TEST_DIR);
      expect(a).not.toBe(b);
    });
  });

  describe('saveHint()', () => {
    it('writes a JSON file to disk', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-001',
        instanceId: 'inst-001',
        displayName: 'My Session',
        timestamp: Date.now(),
        workingDirectory: '/home/user/project',
        instanceCount: 3,
        provider: 'claude',
        model: 'claude-opus-4-5',
      };

      mgr.saveHint(hint);

      const filePath = path.join(TEST_DIR, 'last-session.json');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it('written file is valid JSON matching the hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-002',
        instanceId: 'inst-002',
        displayName: 'Test Session',
        timestamp: 1700000000000,
        workingDirectory: '/tmp/work',
        instanceCount: 1,
        provider: 'gemini',
      };

      mgr.saveHint(hint);

      const filePath = path.join(TEST_DIR, 'last-session.json');
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as ResumeHint;

      expect(parsed.sessionId).toBe('sess-002');
      expect(parsed.instanceId).toBe('inst-002');
      expect(parsed.displayName).toBe('Test Session');
      expect(parsed.provider).toBe('gemini');
    });

    it('creates the directory if it does not exist', () => {
      const nestedDir = path.join(TEST_DIR, 'nested', 'deep');
      const mgr = new (ResumeHintManager as unknown as new (dir: string) => ResumeHintManager)(nestedDir);

      const hint: ResumeHint = {
        sessionId: 'sess-003',
        instanceId: 'inst-003',
        displayName: 'Nested',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      };

      expect(() => mgr.saveHint(hint)).not.toThrow();
      expect(fs.existsSync(path.join(nestedDir, 'last-session.json'))).toBe(true);
    });

    it('overwrites an existing hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'old-session',
        instanceId: 'inst-old',
        displayName: 'Old',
        timestamp: 1000,
        workingDirectory: '/old',
        instanceCount: 1,
        provider: 'claude',
      });

      mgr.saveHint({
        sessionId: 'new-session',
        instanceId: 'inst-new',
        displayName: 'New',
        timestamp: 2000,
        workingDirectory: '/new',
        instanceCount: 2,
        provider: 'gemini',
      });

      const filePath = path.join(TEST_DIR, 'last-session.json');
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ResumeHint;

      expect(parsed.sessionId).toBe('new-session');
    });

    it('does not throw if write fails (best-effort sync write)', () => {
      const mgr = ResumeHintManager.getInstance('/nonexistent-readonly-path');
      const hint: ResumeHint = {
        sessionId: 'sess-fail',
        instanceId: 'inst-fail',
        displayName: 'Fail',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      };

      // Should swallow errors — saveHint is called during shutdown
      expect(() => mgr.saveHint(hint)).not.toThrow();
    });
  });

  describe('getHint()', () => {
    it('returns null when no hint file exists', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });

    it('returns the saved hint', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const hint: ResumeHint = {
        sessionId: 'sess-get',
        instanceId: 'inst-get',
        displayName: 'Get Session',
        timestamp: Date.now(),
        workingDirectory: '/projects/app',
        instanceCount: 2,
        provider: 'claude',
        model: 'claude-3-sonnet',
      };

      mgr.saveHint(hint);
      const loaded = mgr.getHint();

      expect(loaded).not.toBeNull();
      expect(loaded?.sessionId).toBe('sess-get');
      expect(loaded?.model).toBe('claude-3-sonnet');
    });

    it('returns null when hint is older than 7 days', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;

      mgr.saveHint({
        sessionId: 'stale-session',
        instanceId: 'inst-stale',
        displayName: 'Stale',
        timestamp: eightDaysAgo,
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      expect(mgr.getHint()).toBeNull();
    });

    it('returns hint when exactly within 7 days', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;

      mgr.saveHint({
        sessionId: 'fresh-session',
        instanceId: 'inst-fresh',
        displayName: 'Fresh',
        timestamp: sixDaysAgo,
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      expect(mgr.getHint()).not.toBeNull();
    });

    it('returns null when hint file is corrupted JSON', () => {
      const filePath = path.join(TEST_DIR, 'last-session.json');
      fs.writeFileSync(filePath, 'not-valid-json', 'utf-8');

      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });

    it('returns null when hint file is valid JSON but missing required fields', () => {
      const filePath = path.join(TEST_DIR, 'last-session.json');
      fs.writeFileSync(filePath, JSON.stringify({ partial: true }), 'utf-8');

      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(mgr.getHint()).toBeNull();
    });
  });

  describe('clearHint()', () => {
    it('removes the hint file', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'clear-session',
        instanceId: 'inst-clear',
        displayName: 'Clear',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      const filePath = path.join(TEST_DIR, 'last-session.json');
      expect(fs.existsSync(filePath)).toBe(true);

      mgr.clearHint();
      expect(fs.existsSync(filePath)).toBe(false);
    });

    it('does not throw if hint file does not exist', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);
      expect(() => mgr.clearHint()).not.toThrow();
    });

    it('getHint() returns null after clearHint()', () => {
      const mgr = ResumeHintManager.getInstance(TEST_DIR);

      mgr.saveHint({
        sessionId: 'post-clear',
        instanceId: 'inst-pc',
        displayName: 'Post Clear',
        timestamp: Date.now(),
        workingDirectory: '/tmp',
        instanceCount: 1,
        provider: 'claude',
      });

      mgr.clearHint();
      expect(mgr.getHint()).toBeNull();
    });
  });
});
