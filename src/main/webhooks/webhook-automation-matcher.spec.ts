import { describe, expect, it } from 'vitest';
import type { Automation } from '../../shared/types/automation.types';
import type { WebhookRouteConfig } from '../../shared/types/webhook.types';
import { WebhookAutomationMatcher } from './webhook-automation-matcher';

const route: WebhookRouteConfig = {
  id: 'route-build',
  path: '/hooks/build',
  secretHash: 'hash',
  enabled: true,
  allowUnsignedDev: false,
  maxBodyBytes: 1000,
  allowedAutomationIds: ['matching', 'filter-miss', 'scheduled'],
  allowedEvents: [],
  createdAt: 0,
  updatedAt: 0,
};

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'matching',
    name: 'Handle successful build',
    enabled: true,
    active: true,
    workspaceId: 'workspace',
    schedule: { type: 'cron', expression: '0 * * * *', timezone: 'UTC' },
    trigger: {
      kind: 'webhook',
      routeId: 'route-build',
      filters: [
        { path: 'build.status', operator: 'equals', value: 'failed' },
        { path: 'build.labels', operator: 'contains', value: 'urgent' },
      ],
    },
    missedRunPolicy: 'skip',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: { prompt: 'Investigate', workingDirectory: '/tmp/workspace' },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('WebhookAutomationMatcher', () => {
  it('matches only enabled route-authorized webhook automations whose filters pass', async () => {
    const matcher = new WebhookAutomationMatcher({
      list: async () => [
        automation(),
        automation({ id: 'filter-miss', trigger: { kind: 'webhook', routeId: 'route-build', filters: [{ path: 'build.status', operator: 'equals', value: 'passed' }] } }),
        automation({ id: 'scheduled', trigger: { kind: 'schedule' } }),
        automation({ id: 'other-route', trigger: { kind: 'webhook', routeId: 'route-other', filters: [] } }),
        automation({ id: 'disabled', enabled: false, trigger: { kind: 'webhook', routeId: 'route-build', filters: [] } }),
      ],
    });

    const matched = await matcher.match(route, {
      build: { status: 'failed', labels: ['urgent', 'customer'] },
    });

    expect(matched.map((item) => item.id)).toEqual(['matching']);
  });

  it('fails closed for missing dotted paths and an empty route allow-list', async () => {
    const matcher = new WebhookAutomationMatcher({
      list: async () => [automation()],
    });

    await expect(matcher.match(route, { build: { status: 'failed' } })).resolves.toEqual([]);
    await expect(matcher.match({ ...route, allowedAutomationIds: [] }, {
      build: { status: 'failed', labels: ['urgent'] },
    })).resolves.toEqual([]);
  });
});
