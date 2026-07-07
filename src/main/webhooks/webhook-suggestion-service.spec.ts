import { describe, expect, it } from 'vitest';
import type { PromptHistoryEntry } from '../../shared/types/prompt-history.types';
import type { WebhookDeliveryRecord, WebhookRouteConfig } from '../../shared/types/webhook.types';
import { buildWebhookAutomationSuggestions } from './webhook-suggestion-service';

const route: WebhookRouteConfig = {
  id: 'route-1',
  path: '/hooks/build',
  enabled: true,
  secretHash: 'hash',
  allowUnsignedDev: false,
  maxBodyBytes: 262_144,
  allowedAutomationIds: [],
  allowedEvents: [],
  createdAt: 1,
  updatedAt: 1,
};

function delivery(id: string, receivedAt: number): WebhookDeliveryRecord {
  return {
    id,
    routeId: route.id,
    deliveryId: id,
    eventType: 'build.finished',
    status: 'accepted',
    payloadHash: `payload-${id}`,
    receivedAt,
  };
}

function prompt(
  id: string,
  text: string,
  createdAt: number,
  options: Pick<PromptHistoryEntry, 'wasSlashCommand'> = {},
): PromptHistoryEntry {
  return {
    id,
    text,
    createdAt,
    ...options,
  };
}

describe('buildWebhookAutomationSuggestions', () => {
  it('suggests a webhook automation for repeated manual prompts after deliveries', () => {
    const suggestions = buildWebhookAutomationSuggestions({
      now: 9_000_000,
      routes: [route],
      deliveries: [
        delivery('delivery-1', 1_000),
        delivery('delivery-2', 8_000_000),
      ],
      prompts: [
        prompt('prompt-1', 'Fix this broken pipeline', 1_500),
        prompt('prompt-2', 'Please fix the failing pipeline again', 8_000_500),
      ],
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      eventType: 'build.finished',
      routeId: route.id,
      routePath: route.path,
      promptPattern: 'inspect the failing pipeline and fix the cause',
      promptCount: 2,
      deliveryCount: 2,
      suggestedAutomationName: 'Handle build.finished',
    });
  });

  it('does not suggest from one-off correlations', () => {
    const suggestions = buildWebhookAutomationSuggestions({
      now: 10_000_000,
      routes: [route],
      deliveries: [delivery('delivery-1', 1_000)],
      prompts: [prompt('prompt-1', 'Fix this broken pipeline', 1_500)],
    });

    expect(suggestions).toEqual([]);
  });

  it('ignores rejected deliveries, slash commands, and prompts outside the correlation window', () => {
    const rejectedDelivery: WebhookDeliveryRecord = {
      ...delivery('delivery-2', 3_000),
      status: 'rejected',
    };
    const suggestions = buildWebhookAutomationSuggestions({
      now: 10_000_000,
      routes: [route],
      deliveries: [
        delivery('delivery-1', 1_000),
        rejectedDelivery,
        delivery('delivery-3', 6_000),
      ],
      prompts: [
        prompt('prompt-1', 'Fix this broken pipeline', 1_500),
        prompt('prompt-2', 'Fix this broken pipeline', 3_500),
        prompt('prompt-3', 'Fix this broken pipeline', 15_000_000),
        prompt('prompt-4', '/fix-pipeline', 6_500, { wasSlashCommand: true }),
      ],
    });

    expect(suggestions).toEqual([]);
  });

  it('does not suggest automation from repeated generic prompts after matching events', () => {
    const suggestions = buildWebhookAutomationSuggestions({
      now: 10_000_000,
      routes: [route],
      deliveries: [
        delivery('delivery-1', 1_000),
        delivery('delivery-2', 3_000),
      ],
      prompts: [
        prompt('prompt-1', 'What happened?', 1_500),
        prompt('prompt-2', 'Can you look?', 3_500),
      ],
    });

    expect(suggestions).toEqual([]);
  });
});
