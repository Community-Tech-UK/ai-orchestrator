import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodememPrewarmCoordinator } from '../codemem/codemem-prewarm-coordinator';
import { getWorkAdmission, WorkAdmission } from './work-admission';
import type { AppSettings } from '../../shared/types/settings.types';

afterEach(() => WorkAdmission._resetForTesting());
describe('background workload', () => {
  it('retains the warm-up queue on Lightest and starts it when Balanced is restored', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'background-admission-'));
    const warmed: string[] = [];
    const settings: Partial<AppSettings> = { codememPrewarmEnabled: true, codememPrewarmMaxConcurrent: 2, codememPrewarmDebounceMs: 0 };
    const coordinator = new CodememPrewarmCoordinator({
      recentDirectoriesManager: new EventEmitter(),
      settings: { get: key => settings[key] as AppSettings[typeof key] },
      codemem: { isEnabled: () => true, isIndexingEnabled: () => true, getLastIndexedAt: () => null,
        warmWorkspace: async root => { warmed.push(root); return { ready: true, filePath: null }; } },
    });
    try {
      coordinator.start();
      getWorkAdmission().setWorkloadLevel(1);
      coordinator.hintActiveWorkspace(workspace);
      await Promise.resolve();
      expect(warmed).toEqual([]);
      expect(coordinator._inspectForTesting().queue).toEqual([workspace]);
      getWorkAdmission().setWorkloadLevel(3);
      await vi.waitFor(() => expect(warmed).toEqual([workspace]));
    } finally { coordinator.stop(); rmSync(workspace, { recursive: true, force: true }); }
  });
});
