import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  settings: {
    graphClientId: 'client-id-placeholder',
    graphAuthority: 'https://login.microsoftonline.com/organizations',
    graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
    graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
  } as Record<string, string>,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => state.settings[key],
    set: (key: string, value: string) => { state.settings[key] = value; },
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
    expect(JSON.parse(state.settings['graphAgentWritableAccountsJson'])).toEqual(['james@communitytech.co.uk']);
    expect(await service.isWritable('work-key')).toBe(true);
  });
});
