import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportCapabilities } from '../capability-reporter';

// Mock child_process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => Buffer.from('')),
  };
});

describe('capability-reporter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns valid capabilities with correct platform', async () => {
    const caps = await reportCapabilities([]);
    expect(caps.platform).toBe(process.platform);
    expect(caps.arch).toBe(process.arch);
    expect(caps.cpuCores).toBeGreaterThan(0);
    expect(caps.totalMemoryMB).toBeGreaterThan(0);
    expect(caps.availableMemoryMB).toBeGreaterThan(0);
    expect(caps.maxConcurrentInstances).toBe(10);
    expect(Array.isArray(caps.supportedClis)).toBe(true);
    expect(Array.isArray(caps.workingDirectories)).toBe(true);
  });

  it('includes provided working directories', async () => {
    const caps = await reportCapabilities(['/tmp/project']);
    expect(caps.workingDirectories).toContain('/tmp/project');
  });
});
