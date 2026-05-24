import { describe, expect, it } from 'vitest';
import { resolveAioMcpCliPath } from '../aio-mcp-cli-path';

describe('resolveAioMcpCliPath', () => {
  const PACKAGED_RESOURCES = '/Applications/AI Orchestrator.app/Contents/Resources';
  const PACKAGED_BINARY = `${PACKAGED_RESOURCES}/aio-mcp-cli/aio-mcp`;
  const DEV_CWD = '/repo';
  const DEV_BINARY = '/repo/dist/aio-mcp-cli-sea/aio-mcp';

  it('returns the packaged path when present', () => {
    expect(
      resolveAioMcpCliPath({
        resourcesPath: PACKAGED_RESOURCES,
        cwd: DEV_CWD,
        platform: 'darwin',
        exists: (p) => p === PACKAGED_BINARY,
      }),
    ).toBe(PACKAGED_BINARY);
  });

  it('falls back to the dev SEA path when packaged path is missing', () => {
    expect(
      resolveAioMcpCliPath({
        resourcesPath: PACKAGED_RESOURCES,
        cwd: DEV_CWD,
        platform: 'darwin',
        exists: (p) => p === DEV_BINARY,
      }),
    ).toBe(DEV_BINARY);
  });

  it('returns null when neither candidate exists', () => {
    expect(
      resolveAioMcpCliPath({
        resourcesPath: PACKAGED_RESOURCES,
        cwd: DEV_CWD,
        platform: 'darwin',
        exists: () => false,
      }),
    ).toBeNull();
  });

  it('adds the .exe suffix on Windows', () => {
    let lastChecked: string | null = null;
    resolveAioMcpCliPath({
      resourcesPath: 'C:\\Program Files\\AI Orchestrator\\resources',
      cwd: 'C:\\repo',
      platform: 'win32',
      exists: (p) => {
        lastChecked = p;
        return false;
      },
    });
    expect(lastChecked).toMatch(/aio-mcp\.exe$/);
  });

  it('prefers packaged over dev when both exist', () => {
    expect(
      resolveAioMcpCliPath({
        resourcesPath: PACKAGED_RESOURCES,
        cwd: DEV_CWD,
        platform: 'darwin',
        exists: () => true,
      }),
    ).toBe(PACKAGED_BINARY);
  });
});
