import { describe, expect, it } from 'vitest';
import { AUTOMATION_CHANNELS, IPC_CHANNELS } from '../index';

describe('AUTOMATION_CHANNELS', () => {
  it('has automation management channels', () => {
    expect(AUTOMATION_CHANNELS.AUTOMATION_LIST).toBe('automation:list');
    expect(AUTOMATION_CHANNELS.AUTOMATION_CREATE).toBe('automation:create');
    expect(AUTOMATION_CHANNELS.AUTOMATION_RUN_NOW).toBe('automation:run-now');
    expect(AUTOMATION_CHANNELS.AUTOMATION_TEMPLATES_LIST).toBe('automation:templates-list');
  });

  it('has webhook channels', () => {
    expect(AUTOMATION_CHANNELS.WEBHOOK_STATUS).toBe('webhook:status');
    expect(AUTOMATION_CHANNELS.WEBHOOK_LIST_ROUTES).toBe('webhook:list-routes');
    expect(AUTOMATION_CHANNELS.WEBHOOK_CREATE_ROUTE).toBe('webhook:create-route');
    expect(AUTOMATION_CHANNELS.WEBHOOK_LIST_DELIVERIES).toBe('webhook:list-deliveries');
    expect(AUTOMATION_CHANNELS.WEBHOOK_LIST_SUGGESTIONS).toBe('webhook:list-suggestions');
  });

  it('is included in the merged IPC channel map', () => {
    expect(IPC_CHANNELS.AUTOMATION_LIST).toBe('automation:list');
    expect(IPC_CHANNELS.WEBHOOK_LIST_SUGGESTIONS).toBe('webhook:list-suggestions');
  });
});
