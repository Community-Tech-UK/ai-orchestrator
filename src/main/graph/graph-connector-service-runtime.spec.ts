import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {
    graphClientId: 'client-id-placeholder',
    graphAuthority: 'https://login.microsoftonline.com/organizations',
    graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
    graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
  } as Record<string, unknown>,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => state.settings[key],
    set: (key: string, value: unknown) => { state.settings[key] = value; },
  }),
}));
vi.mock('../operator/operator-database', () => ({ getOperatorDatabase: () => ({ db: {} }) }));
vi.mock('../mcp/secret-storage', () => ({ getMcpSecretStorage: () => ({}) }));
vi.mock('./graph-token-store', () => ({
  GraphTokenStore: class {
    listAccounts() {
      return [{ accountKey: 'work-key', username: 'james@communitytech.co.uk', tenant: 'tenant', createdAt: 1, updatedAt: 1 }];
    }
  },
}));

import { GraphConnectorService, getGraphConnectorService } from './graph-connector-service';

describe('Graph connector runtime write policy', () => {
  afterEach(() => {
    GraphConnectorService._resetForTesting();
    state.settings['graphAgentWritableAccountsJson'] = '["james@communitytech.co.uk"]';
    delete state.settings['graphAlwaysAllowedChanges'];
  });

  it('reads a malformed always-allowed setting as nothing allowed, so every change asks again', () => {
    state.settings['graphAlwaysAllowedChanges'] = { 'james@communitytech.co.uk': 'graph_mail_send' };
    expect(getGraphConnectorService().isAlwaysAllowed('work-key', 'graph_mail_send')).toBe(false);
  });

  it('saves "Always allow" to the setting and reads it back', () => {
    state.settings['graphAlwaysAllowedChanges'] = {};
    const service = getGraphConnectorService();
    service.allowAlways('work-key', 'graph_mail_send');
    expect(state.settings['graphAlwaysAllowedChanges']).toEqual({ 'james@communitytech.co.uk': ['graph_mail_send'] });
    expect(service.isAlwaysAllowed('work-key', 'graph_mail_send')).toBe(true);
  });

  it('fails closed on malformed persisted policy rather than restoring the writable default', async () => {
    state.settings['graphAgentWritableAccountsJson'] = 'not-json';
    const service = getGraphConnectorService();
    expect(await service.isWritable('work-key')).toBe(false);
    await expect(service.callTool('work-key', 'graph_mail_create_draft', {
      subject: 'Planning', body: { contentType: 'text', content: 'Agenda' },
      toRecipients: [{ emailAddress: { address: 'recipient@example.test' } }],
    }, true)).rejects.toThrow(/not permitted/);
  });

  it('updates the existing persisted policy and immediately applies changes', async () => {
    const service = getGraphConnectorService();
    await service.setWritable('work-key', false);
    expect(state.settings['graphAgentWritableAccountsJson']).toBe('[]');
    expect(await service.isWritable('work-key')).toBe(false);
    await service.setWritable('work-key', true);
    expect(JSON.parse(state.settings['graphAgentWritableAccountsJson'] as string)).toEqual(['james@communitytech.co.uk']);
    expect(await service.isWritable('work-key')).toBe(true);
  });
});
