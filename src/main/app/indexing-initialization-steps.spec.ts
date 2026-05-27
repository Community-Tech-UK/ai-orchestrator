import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodebaseAutoIndexCoordinatorStep } from './indexing-initialization-steps';
import type { AppSettings } from '../../shared/types/settings.types';

type SettingsFixture = Partial<AppSettings> & Record<string, unknown>;

const fakes = vi.hoisted(() => {
  const state = {
    settings: {} as SettingsFixture,
    getAll: vi.fn(() => state.settings),
    getDirectories: vi.fn(),
    coordinator: {
      start: vi.fn(),
      hintActiveWorkspace: vi.fn(),
    },
  };
  return state;
});

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: fakes.getAll,
  }),
}));

vi.mock('../core/config/recent-directories-manager', () => ({
  getRecentDirectoriesManager: () => ({
    getDirectories: fakes.getDirectories,
  }),
}));

vi.mock('../indexing', () => ({
  getCodebaseIndexingAutoCoordinator: () => fakes.coordinator,
}));

vi.mock('../codemem', () => ({
  getCodememPrewarmCoordinator: () => ({
    start: vi.fn(),
    hintActiveWorkspace: vi.fn(),
  }),
}));

vi.mock('../memory', () => ({
  getProjectKnowledgeAutoMirrorCoordinator: () => ({
    start: vi.fn(),
    hintActiveWorkspace: vi.fn(),
  }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

describe('indexing initialization steps', () => {
  beforeEach(() => {
    fakes.settings = {};
    fakes.getAll.mockClear();
    fakes.getDirectories.mockReset();
    fakes.coordinator.start.mockClear();
    fakes.coordinator.hintActiveWorkspace.mockClear();
  });

  it('starts codebase auto-index without a startup workspace hint when startup hints are disabled', async () => {
    fakes.settings = {
      codebaseAutoIndexEnabled: true,
      codebaseAutoIndexStartupHint: false,
    };
    fakes.getDirectories.mockResolvedValue([
      {
        path: '/repo',
        displayName: 'repo',
        lastAccessed: 1,
        accessCount: 1,
        isPinned: false,
      },
    ]);

    await createCodebaseAutoIndexCoordinatorStep().fn();

    expect(fakes.coordinator.start).toHaveBeenCalledTimes(1);
    expect(fakes.getDirectories).not.toHaveBeenCalled();
    expect(fakes.coordinator.hintActiveWorkspace).not.toHaveBeenCalled();
  });
});
