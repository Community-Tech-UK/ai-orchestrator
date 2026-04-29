import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../validated-handler';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  showItemInFolder: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
  shell: {
    showItemInFolder: electronMocks.showItemInFolder,
  },
}));

const serviceMocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  collectSkills: vi.fn(),
  collectInstructions: vi.fn(),
  exportBundle: vi.fn(),
  getState: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('../../../diagnostics/doctor-service', () => ({
  getDoctorService: () => ({ getReport: serviceMocks.getReport }),
}));
vi.mock('../../../diagnostics/skill-diagnostics-service', () => ({
  getSkillDiagnosticsService: () => ({ collect: serviceMocks.collectSkills }),
}));
vi.mock('../../../diagnostics/instruction-diagnostics-service', () => ({
  getInstructionDiagnosticsService: () => ({ collect: serviceMocks.collectInstructions }),
}));
vi.mock('../../../diagnostics/operator-artifact-exporter', () => ({
  getOperatorArtifactExporter: () => ({ export: serviceMocks.exportBundle }),
}));
vi.mock('../../../cli/cli-update-poll-service', () => ({
  getCliUpdatePollService: () => ({
    getState: serviceMocks.getState,
    refresh: serviceMocks.refresh,
  }),
}));
vi.mock('../../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 100 }),
}));
vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { registerDiagnosticsHandlers } from '../diagnostics-handlers';

const fakeEvent = {};

describe('diagnostics-handlers', () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
    serviceMocks.getReport.mockResolvedValue({ schemaVersion: 1 });
    serviceMocks.collectSkills.mockResolvedValue([]);
    serviceMocks.collectInstructions.mockResolvedValue([]);
    serviceMocks.exportBundle.mockResolvedValue({ bundlePath: '/tmp/a.zip', bundleBytes: 1, manifest: {} });
    serviceMocks.getState.mockReturnValue({ count: 0, entries: [], generatedAt: 1 });
    serviceMocks.refresh.mockResolvedValue({ count: 0, entries: [], generatedAt: 2 });
    registerDiagnosticsHandlers();
  });

  it('validates doctor report payloads', async () => {
    const result = await invoke('diagnostics:get-doctor-report', { workingDirectory: 42 });

    expect(result.success).toBe(false);
    expect(serviceMocks.getReport).not.toHaveBeenCalled();
  });

  it('returns a doctor report', async () => {
    const result = await invoke('diagnostics:get-doctor-report', { workingDirectory: '/repo' });

    expect(result).toMatchObject({ success: true, data: { schemaVersion: 1 } });
    expect(serviceMocks.getReport).toHaveBeenCalledWith({ workingDirectory: '/repo' });
  });

  it('forwards skill and instruction diagnostics', async () => {
    await expect(invoke('diagnostics:get-skill-diagnostics', {})).resolves.toMatchObject({
      success: true,
      data: [],
    });

    await expect(invoke('diagnostics:get-instruction-diagnostics', { workingDirectory: '/repo' })).resolves.toMatchObject({
      success: true,
      data: [],
    });
    expect(serviceMocks.collectInstructions).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      broadRootFileThreshold: 100,
    });
  });

  it('exports and reveals bundles', async () => {
    const exportResult = await invoke('diagnostics:export-artifact-bundle', { sessionId: 'sess-1' });
    expect(exportResult.success).toBe(true);
    expect(serviceMocks.exportBundle).toHaveBeenCalledWith({ sessionId: 'sess-1' });

    const revealResult = await invoke('diagnostics:reveal-bundle', { bundlePath: '/tmp/a.zip' });
    expect(revealResult.success).toBe(true);
    expect(electronMocks.showItemInFolder).toHaveBeenCalledWith('/tmp/a.zip');
  });

  it('returns and refreshes CLI update pill state', async () => {
    await expect(invoke('cli-update-pill:get-state', {})).resolves.toMatchObject({
      success: true,
      data: { generatedAt: 1 },
    });
    await expect(invoke('cli-update-pill:refresh', {})).resolves.toMatchObject({
      success: true,
      data: { generatedAt: 2 },
    });
  });
});

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler(fakeEvent, payload);
}
