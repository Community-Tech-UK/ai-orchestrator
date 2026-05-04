import { describe, expect, it } from 'vitest';
import {
  toAgentSafeAudit,
  toAgentSafeHealth,
  toAgentSafeProfile,
  toAgentSafeTarget,
} from './browser-safe-dto';

describe('browser-safe-dto', () => {
  it('strips runtime debug fields from profiles', () => {
    const safe = toAgentSafeProfile({
      id: 'profile-1',
      label: 'Local',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
      status: 'running',
      debugPort: 9222,
      debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
      processId: 123,
      createdAt: 1,
      updatedAt: 1,
    });

    expect(safe).not.toHaveProperty('debugPort');
    expect(safe).not.toHaveProperty('debugEndpoint');
    expect(safe).not.toHaveProperty('processId');
  });

  it('strips driver target ids from targets', () => {
    const safe = toAgentSafeTarget({
      id: 'target-1',
      profileId: 'profile-1',
      driverTargetId: 'cdp-target-id',
      mode: 'session',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 1,
    });

    expect(safe).not.toHaveProperty('driverTargetId');
  });

  it('redacts debug endpoints, profile paths, and sensitive values from audits', () => {
    const safe = toAgentSafeAudit({
      id: 'audit-1',
      instanceId: 'instance-1',
      provider: 'copilot',
      action: 'snapshot',
      toolName: 'browser.snapshot',
      actionClass: 'read',
      url: 'ws://127.0.0.1:9222/devtools/browser/id',
      decision: 'allowed',
      outcome: 'succeeded',
      summary:
        'Read /Users/me/Library/Application Support/app/browser-profiles/profile-1 with Authorization: Bearer abc and localStorage token=secret',
      redactionApplied: true,
      createdAt: 1,
    });

    expect(JSON.stringify(safe)).not.toContain('ws://');
    expect(JSON.stringify(safe)).not.toContain('browser-profiles/profile-1');
    expect(JSON.stringify(safe)).not.toContain('Bearer abc');
    expect(JSON.stringify(safe)).not.toContain('secret');
  });

  it('redacts debug fields from nested health payloads', () => {
    const safe = toAgentSafeHealth({
      chromeRuntime: {
        available: true,
        debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
      },
      profile: {
        debugPort: 9222,
        debugEndpoint: 'ws://127.0.0.1:9222/devtools/browser/id',
      },
    });

    expect(JSON.stringify(safe)).not.toContain('debugPort');
    expect(JSON.stringify(safe)).not.toContain('debugEndpoint');
    expect(JSON.stringify(safe)).not.toContain('ws://');
  });
});
