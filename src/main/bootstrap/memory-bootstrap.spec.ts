import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getBootstrapModules,
  resetBootstrapRegistryForTesting,
} from './index';
import { registerMemoryBootstrap } from './memory-bootstrap';

describe('registerMemoryBootstrap', () => {
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
});
