import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DoctorReport } from '../../../shared/types/diagnostics.types';

const mocks = vi.hoisted(() => ({
  userData: '',
  lifecyclePath: '',
  getReport: vi.fn(),
  getSessionDiagnostics: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => mocks.userData),
    getVersion: vi.fn(() => '0.1.0-test'),
  },
}));

vi.mock('../doctor-service', () => ({
  getDoctorService: () => ({
    getReport: mocks.getReport,
  }),
}));

vi.mock('../../session/session-recall-service', () => ({
  getSessionRecallService: () => ({
    getSessionDiagnostics: mocks.getSessionDiagnostics,
  }),
}));

vi.mock('../../observability/lifecycle-trace', () => ({
  resolveLifecycleTraceFilePath: () => mocks.lifecyclePath,
}));

import { OperatorArtifactExporter } from '../operator-artifact-exporter';

describe('OperatorArtifactExporter', () => {
  beforeEach(async () => {
    mocks.userData = await mkdtemp(join(tmpdir(), 'operator-artifacts-'));
    mocks.lifecyclePath = join(mocks.userData, 'lifecycle.ndjson');
    mocks.getReport.mockResolvedValue(makeReport());
    mocks.getSessionDiagnostics.mockResolvedValue({
      sessionId: 'sess-1',
      content: 'secret message body',
      path: `${process.env['HOME'] ?? ''}/project/file.ts`,
    });
    await writeFile(mocks.lifecyclePath, [
      JSON.stringify({ event: 'one', path: `${process.env['HOME'] ?? ''}/x`, token: 'sk-1234567890abcdefghijklmnop' }),
      JSON.stringify({ event: 'two' }),
    ].join('\n'));
  });

  afterEach(async () => {
    await rm(mocks.userData, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('writes a redacted zip bundle with a self-described manifest', async () => {
    const exporter = new OperatorArtifactExporter();

    const result = await exporter.export({
      sessionId: 'sess-1',
      workingDirectory: `${process.env['HOME'] ?? ''}/project`,
    });

    expect(result.bundlePath).toContain('diagnostics-bundles');
    expect(result.manifest.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'doctor-report.json' }),
        expect.objectContaining({ name: 'selected-session-diagnostics.json' }),
        expect.objectContaining({ name: 'manifest.json', sha256: 'self-described' }),
      ]),
    );
    expect(result.manifest.workingDirectory).toMatch(/^~/);

    const zipText = (await readFile(result.bundlePath)).toString('utf-8');
    expect(zipText).toContain('[omitted-session-body]');
    expect(zipText).toContain('<redacted-secret>');
    expect(zipText).not.toContain('secret message body');
    expect(zipText).not.toContain('sk-1234567890');
  });
});

function makeReport(): DoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: 1,
    startupCapabilities: null,
    providerDiagnoses: [],
    cliHealth: { installs: [], updatePlans: [], generatedAt: 1 },
    browserAutomation: null,
    commandDiagnostics: {
      available: true,
      diagnostics: [],
      scanDirs: [],
      generatedAt: 1,
    },
    skillDiagnostics: [],
    instructionDiagnostics: [],
    sections: [],
  };
}
