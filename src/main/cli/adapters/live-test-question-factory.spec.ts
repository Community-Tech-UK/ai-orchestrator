import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const liveTest = vi.hoisted(() => ({ on: false }));
vi.mock('../../app/live-test-context', () => ({
  isHarnessLiveTest: () => liveTest.on,
  harnessLiveTestDataPath: () => null,
}));
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { createCliAdapter } from './adapter-factory';
import { LiveTestQuestionAdapter } from './live-test-question-adapter';
import {
  _resetLiveTestQuestionFoldersForTesting,
  claimLiveTestQuestionFolder,
} from './live-test-question-fixtures';

const FOLDER = '/tmp/aio-lt-question-factory-spec/question-session-a';

describe('createCliAdapter for a live-test question session', () => {
  beforeEach(() => {
    _resetLiveTestQuestionFoldersForTesting();
    liveTest.on = true;
    claimLiveTestQuestionFolder(FOLDER);
  });
  afterEach(() => {
    liveTest.on = false;
    _resetLiveTestQuestionFoldersForTesting();
  });

  it('gives the scripted adapter for the folder it was made for, on every spawn', () => {
    const options = { workingDirectory: FOLDER, instanceId: 'inst-1' };
    expect(createCliAdapter('opencode', options)).toBeInstanceOf(LiveTestQuestionAdapter);
    expect(createCliAdapter('opencode', options)).toBeInstanceOf(LiveTestQuestionAdapter);
  });

  it('refuses any other provider or a remote placement rather than starting a real one', () => {
    const options = { workingDirectory: FOLDER, instanceId: 'inst-1' };
    expect(() => createCliAdapter('claude', options)).toThrow('runs locally as an OpenCode session');
    expect(() => createCliAdapter('opencode', options, { type: 'remote', nodeId: 'node-1' })).toThrow('runs locally');
  });

  it('is not used in an app that is not a live-test copy, even for a claimed folder', () => {
    liveTest.on = false;
    let adapter: unknown;
    try { adapter = createCliAdapter('opencode', { workingDirectory: FOLDER, instanceId: 'inst-1' }); } catch { /* a real OpenCode may be absent */ }
    expect(adapter).not.toBeInstanceOf(LiveTestQuestionAdapter);
  });

  it('is not used for a folder that was never claimed', () => {
    let adapter: unknown;
    try { adapter = createCliAdapter('opencode', { workingDirectory: '/tmp/somewhere-else', instanceId: 'inst-2' }); } catch { /* a real OpenCode may be absent */ }
    expect(adapter).not.toBeInstanceOf(LiveTestQuestionAdapter);
  });
});
