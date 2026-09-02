import Module from 'node:module';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBootstrapModules,
  resetBootstrapRegistryForTesting,
} from './index';
import { registerMemoryBootstrap } from './memory-bootstrap';

describe('registerMemoryBootstrap', () => {
  const requireImpl = Module.prototype.require;

  afterEach(() => {
    vi.restoreAllMocks();
    resetBootstrapRegistryForTesting();
  });

  it('skips project-story setup when the app launches without a project cwd', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(path.parse(process.cwd()).root);
    registerMemoryBootstrap();

    const projectStoryModule = getBootstrapModules().find(
      (module) => module.name === 'Project story directory',
    );

    expect(projectStoryModule).toBeDefined();
    expect(() => projectStoryModule?.init()).not.toThrow();
  });

  it('initializes RLM collaborators without resolving the main-process context manager', () => {
    let contextManagerResolutions = 0;
    const getEpisodicRLMStore = vi.fn();
    const getSmartCompactionManager = vi.fn();
    const worker = {
      initialize: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const getSummarizationWorker = vi.fn(() => worker);

    vi.spyOn(Module.prototype, 'require').mockImplementation(function mockRequire(
      this: NodeJS.Module,
      id: string,
    ) {
      switch (id) {
        case '../rlm/context-manager':
          contextManagerResolutions += 1;
          return { getRLMContextManager: vi.fn() };
        case '../rlm/episodic-rlm-store':
          return { getEpisodicRLMStore };
        case '../rlm/smart-compaction':
          return { getSmartCompactionManager };
        case '../rlm/summarization-worker':
          return { getSummarizationWorker };
        default:
          return requireImpl.apply(this, [id]);
      }
    });

    registerMemoryBootstrap();
    const rlmModule = getBootstrapModules().find(
      (module) => module.name === 'RLM subsystem',
    );

    expect(rlmModule).toBeDefined();
    rlmModule?.init();

    expect(contextManagerResolutions).toBe(0);
    expect(getEpisodicRLMStore).toHaveBeenCalledOnce();
    expect(getSmartCompactionManager).toHaveBeenCalledOnce();
    expect(getSummarizationWorker).toHaveBeenCalledOnce();
    expect(worker.initialize).toHaveBeenCalledOnce();
    expect(worker.start).toHaveBeenCalledOnce();
  });

  it('stops the summarization worker during RLM teardown', () => {
    const worker = { stop: vi.fn() };
    const getSummarizationWorker = vi.fn(() => worker);

    vi.spyOn(Module.prototype, 'require').mockImplementation(function mockRequire(
      this: NodeJS.Module,
      id: string,
    ) {
      if (id === '../rlm/summarization-worker') {
        return { getSummarizationWorker };
      }
      return requireImpl.apply(this, [id]);
    });

    registerMemoryBootstrap();
    const rlmModule = getBootstrapModules().find(
      (module) => module.name === 'RLM subsystem',
    );

    expect(rlmModule).toBeDefined();
    rlmModule?.teardown?.();

    expect(getSummarizationWorker).toHaveBeenCalledOnce();
    expect(worker.stop).toHaveBeenCalledOnce();
  });
});
