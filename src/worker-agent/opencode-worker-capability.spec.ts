import { beforeEach, describe, expect, it, vi } from 'vitest';
const resolve = vi.hoisted(() => vi.fn());
vi.mock('../main/cli/adapters/opencode-cli-launch', () => ({ resolveOpenCodeLaunch: resolve }));
import { readWorkerOpenCodeMajor, resetWorkerOpenCodeMajorForTesting } from './opencode-worker-capability';
describe('worker OpenCode major detection', () => {
  beforeEach(() => { vi.clearAllMocks(); resetWorkerOpenCodeMajorForTesting(); });
  it('shares in-flight selection and caches the selected major for heartbeats', async () => {
    resolve.mockResolvedValue({ command: '/fixture/opencode2', major: 2 });
    expect(await Promise.all([readWorkerOpenCodeMajor(), readWorkerOpenCodeMajor()])).toEqual([2, 2]);
    expect(await readWorkerOpenCodeMajor()).toBe(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  it('omits a major when no supported install can run', async () => {
    resolve.mockRejectedValue(new Error('unsupported'));
    expect(await readWorkerOpenCodeMajor()).toBeUndefined();
  });
});
