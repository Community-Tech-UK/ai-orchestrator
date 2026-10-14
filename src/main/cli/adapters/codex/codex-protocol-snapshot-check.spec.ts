import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ peek: vi.fn(), warn: vi.fn() }));
vi.mock('../../cli-detection', () => ({ getCliDetectionService: () => ({ peekCachedResult: mocks.peek }) }));
vi.mock('../../../logging/logger', () => ({ getLogger: () => ({ warn: mocks.warn }) }));
vi.mock('./generated/app-server-protocol.gen', () => ({ CODEX_APP_SERVER_PROTOCOL_VERSION: 'codex-cli 0.144.4' }));
import { describeSnapshotGap, warnOnceIfCodexSnapshotBehind, _resetCodexSnapshotCheckForTesting } from './codex-protocol-snapshot-check';

describe('Codex protocol snapshot safeguard', () => {
  beforeEach(() => { vi.clearAllMocks(); _resetCodexSnapshotCheckForTesting(); });
  it('names both versions and the minor gap exactly once', () => {
    mocks.peek.mockReturnValue({ detected: [{ name: 'codex', version: '0.162.1' }] });
    warnOnceIfCodexSnapshotBehind(); warnOnceIfCodexSnapshotBehind();
    expect(mocks.warn).toHaveBeenCalledExactlyOnceWith('Codex protocol snapshot is 18 minor versions behind the installed CLI', { snapshot: 'codex-cli 0.144.4', installed: '0.162.1' });
  });
  it('does not spend the once flag on an empty worker cache', () => {
    mocks.peek.mockReturnValue(null); warnOnceIfCodexSnapshotBehind();
    mocks.peek.mockReturnValue({ detected: [{ name: 'codex', version: '0.162.1' }] }); warnOnceIfCodexSnapshotBehind();
    expect(mocks.warn).toHaveBeenCalledOnce();
  });
  it.each([null, 'unknown', '0.144.4', '0.143.9', '0.162.1-beta', 'bad'])('does not warn at %s', version => {
    mocks.peek.mockReturnValue({ detected: [{ name: 'codex', version }] }); warnOnceIfCodexSnapshotBehind();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
  it('handles major upgrades and rejects malformed snapshot versions', () => {
    expect(describeSnapshotGap('codex-cli 0.162.1', '1.0.0')).toBe(1);
    expect(describeSnapshotGap('unknown', '0.162.1')).toBeNull();
  });
  it('never throws when detection fails', () => {
    mocks.peek.mockImplementation(() => { throw new Error('stub error'); });
    expect(warnOnceIfCodexSnapshotBehind).not.toThrow();
  });
});
