import { beforeEach, describe, expect, it, vi } from 'vitest';
const detectOne = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/cli-detection', () => ({ getCliDetectionService: () => ({ detectOne }) }));
import { readWorkerCliVersions, resetWorkerCliVersionsForTesting } from './worker-cli-versions';

describe('worker CLI versions', () => {
  beforeEach(() => { vi.clearAllMocks(); resetWorkerCliVersionsForTesting(); });
  it('reports the selected execution-node version and coalesces heartbeat probes', async () => {
    detectOne.mockResolvedValue({ installed: true, version: '2.1.296' });
    const [first, second] = await Promise.all([readWorkerCliVersions(), readWorkerCliVersions()]);
    expect(first).toEqual({ claude: '2.1.296' });
    expect(second).toEqual(first);
    await readWorkerCliVersions();
    expect(detectOne).toHaveBeenCalledTimes(1);
    expect(detectOne).toHaveBeenCalledWith('claude');
  });
  it.each([{ installed: false, version: '2.1.296' }, { installed: true }, { installed: true, version: 'unknown' }])(
    'does not advertise unconfirmed version %j', async result => {
      detectOne.mockResolvedValue(result);
      expect(await readWorkerCliVersions()).toEqual({});
    });
  it('keeps a failed version probe bounded by the heartbeat cache', async () => {
    detectOne.mockRejectedValue(new Error('unavailable'));
    expect(await readWorkerCliVersions()).toEqual({});
    expect(await readWorkerCliVersions()).toEqual({});
    expect(detectOne).toHaveBeenCalledTimes(1);
  });
});
