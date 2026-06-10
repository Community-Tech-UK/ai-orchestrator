import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(tmpdir(), 'codemem-service-lazy-db-test'),
  },
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      codememEnabled: true,
      codememIndexingEnabled: false,
      codememLspWorkerEnabled: false,
    }),
  }),
}));

vi.mock('../../db/better-sqlite3-driver', () => ({
  defaultDriverFactory: vi.fn(() => ({
    close: vi.fn(),
  })),
}));

vi.mock('../cas-schema', () => ({
  migrate: vi.fn(),
}));

vi.mock('../../mcp/mcp-server', () => ({
  McpServer: {
    getInstance: () => ({
      isStarted: vi.fn(() => false),
      registerTools: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
  },
}));

import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { migrate } from '../cas-schema';
import { CodememService } from '../index';

describe('CodememService database lifecycle', () => {
  let service: CodememService | null = null;

  afterEach(async () => {
    await service?.shutdown();
    service = null;
    vi.clearAllMocks();
  });

  it('does not open codemem.sqlite just to construct and initialize service wiring', async () => {
    service = new CodememService();

    expect(defaultDriverFactory).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();

    await service.initialize();

    expect(defaultDriverFactory).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });
});
