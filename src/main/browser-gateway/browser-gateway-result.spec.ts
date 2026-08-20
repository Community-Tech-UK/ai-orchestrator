import { describe, expect, it, vi } from 'vitest';
import { BrowserGatewayResultRecorder, type BrowserGatewayResultInput } from './browser-gateway-result';

function baseParams(overrides: Partial<BrowserGatewayResultInput<null>> = {}): BrowserGatewayResultInput<null> {
  return {
    context: { instanceId: 'instance-1', provider: 'claude' },
    action: 'attach_existing_tab',
    toolName: 'browser.extension_attach_tab',
    actionClass: 'read',
    decision: 'allowed',
    outcome: 'succeeded',
    summary: 'Attached tab',
    data: null,
    ...overrides,
  };
}

describe('BrowserGatewayResultRecorder', () => {
  it('LT-217: writes to the audit store by default', () => {
    const record = vi.fn().mockReturnValue({ id: 'persisted-id' });
    const recorder = new BrowserGatewayResultRecorder({ record });

    const result = recorder.record(baseParams());

    expect(record).toHaveBeenCalledTimes(1);
    expect(result.auditId).toBe('persisted-id');
  });

  it('LT-217: recordAudit: false skips the audit-store write entirely', () => {
    const record = vi.fn().mockReturnValue({ id: 'persisted-id' });
    const recorder = new BrowserGatewayResultRecorder({ record });

    const result = recorder.record(baseParams({ recordAudit: false }));

    expect(record).not.toHaveBeenCalled();
    expect(result.auditId).toBeTruthy();
    expect(result.auditId).not.toBe('persisted-id');
  });
});
