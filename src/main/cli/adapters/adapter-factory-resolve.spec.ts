import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCliType } from './adapter-factory';

const detectAllMock = vi.hoisted(() => vi.fn());

vi.mock('../cli-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cli-detection')>();
  return {
    ...actual,
    CliDetectionService: {
      getInstance: () => ({
        detectAll: detectAllMock,
      }),
    },
  };
});

function detectionResult(available: string[]) {
  return {
    detected: [],
    available: available.map((name) => ({ name })),
    unavailable: [],
    timestamp: new Date(),
  };
}

describe('resolveCliType', () => {
  beforeEach(() => {
    detectAllMock.mockReset();
  });

  it('honors explicit ollama requests even when a higher-priority CLI is available', async () => {
    detectAllMock.mockResolvedValue(detectionResult(['claude', 'ollama']));

    await expect(resolveCliType('ollama', 'auto')).resolves.toBe('ollama');
  });

  it('reuses a single detection result when falling back from an unavailable default', async () => {
    detectAllMock.mockResolvedValue(detectionResult(['claude']));

    await expect(resolveCliType(undefined, 'codex')).resolves.toBe('claude');

    expect(detectAllMock).toHaveBeenCalledTimes(1);
  });
});
