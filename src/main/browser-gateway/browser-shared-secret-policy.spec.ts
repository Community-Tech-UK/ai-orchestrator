import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

describe('secret protection shared by several Harnesses', () => {
  it('does not let one Harness turn off another Harness\'s protection, even after a restart', async () => {
    const saved: Record<string, unknown> = {};
    const make = () => runInNewContext(`${readFileSync('resources/browser-extension/browser-session-claims.js', 'utf8')}; createSharedBrowserSecretPolicy`)({
      storage: {
        get: async (key: string) => ({ [key]: saved[key] }),
        set: async (values: Record<string, unknown>) => { Object.assign(saved, structuredClone(values)); },
      },
    }) as { stamp: (command: { payload: { secretObservationProtectionEnabled: boolean } }, host: string, connected: string[]) => Promise<void> };
    const policy = make();
    const a = { payload: { secretObservationProtectionEnabled: true } };
    await policy.stamp(a, 'HARNESS_A_PLACEHOLDER', ['HARNESS_A_PLACEHOLDER', 'HARNESS_B_PLACEHOLDER']);
    const b = { payload: { secretObservationProtectionEnabled: false } };
    await make().stamp(b, 'HARNESS_B_PLACEHOLDER', ['HARNESS_B_PLACEHOLDER']);
    expect(b.payload.secretObservationProtectionEnabled).toBe(true);
    const off = { payload: { secretObservationProtectionEnabled: false } };
    await policy.stamp(off, 'HARNESS_A_PLACEHOLDER', ['HARNESS_A_PLACEHOLDER', 'HARNESS_B_PLACEHOLDER']);
    expect(off.payload.secretObservationProtectionEnabled).toBe(false);
  });
});
