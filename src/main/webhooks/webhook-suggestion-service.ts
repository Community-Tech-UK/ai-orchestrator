import * as crypto from 'crypto';
import { getPromptHistoryService } from '../prompt-history/prompt-history-service';
import { getWebhookStore } from './webhook-store';
import type { PromptHistoryEntry } from '../../shared/types/prompt-history.types';
import type {
  WebhookAutomationSuggestion,
  WebhookDeliveryRecord,
  WebhookRouteConfig,
} from '../../shared/types/webhook.types';

const CORRELATION_WINDOW_MS = 2 * 60 * 60 * 1000;
const LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

interface PromptCandidate {
  text: string;
  createdAt: number;
}

interface SuggestionGroup {
  eventType: string;
  routeId: string;
  routePath?: string;
  promptPattern: string;
  promptCount: number;
  deliveryIds: Set<string>;
  lastSeenAt: number;
}

export function listWebhookAutomationSuggestions(limit = 10): WebhookAutomationSuggestion[] {
  const store = getWebhookStore();
  const deliveries = store.recentDeliveries(200);
  const routes = store.listRoutes();
  const prompts = Object.values(getPromptHistoryService().getSnapshot().byInstance)
    .flatMap((record) => record.entries);

  return buildWebhookAutomationSuggestions({
    deliveries,
    routes,
    prompts,
    limit,
  });
}

export function buildWebhookAutomationSuggestions(input: {
  deliveries: WebhookDeliveryRecord[];
  routes: WebhookRouteConfig[];
  prompts: PromptHistoryEntry[];
  limit?: number;
  now?: number;
}): WebhookAutomationSuggestion[] {
  const now = input.now ?? Date.now();
  const routesById = new Map(input.routes.map((route) => [route.id, route]));
  const deliveries = input.deliveries
    .filter((delivery) =>
      delivery.status === 'accepted' &&
      Boolean(delivery.eventType) &&
      delivery.receivedAt >= now - LOOKBACK_MS
    )
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const prompts = input.prompts
    .filter((prompt) => !prompt.wasSlashCommand && prompt.createdAt >= now - LOOKBACK_MS)
    .map((prompt): PromptCandidate => ({ text: prompt.text, createdAt: prompt.createdAt }))
    .sort((a, b) => a.createdAt - b.createdAt);

  const groups = new Map<string, SuggestionGroup>();

  for (const delivery of deliveries) {
    const eventType = delivery.eventType!;
    const route = routesById.get(delivery.routeId);
    const correlatedPrompts = prompts.filter((prompt) =>
      prompt.createdAt >= delivery.receivedAt &&
      prompt.createdAt <= delivery.receivedAt + CORRELATION_WINDOW_MS &&
      promptLooksActionable(prompt.text)
    );

    for (const prompt of correlatedPrompts) {
      const promptPattern = promptIntent(prompt.text, eventType);
      if (!promptPattern) continue;
      const key = `${delivery.routeId}:${eventType}:${promptPattern}`;
      const group = groups.get(key) ?? {
        eventType,
        routeId: delivery.routeId,
        routePath: route?.path,
        promptPattern,
        promptCount: 0,
        deliveryIds: new Set<string>(),
        lastSeenAt: 0,
      };
      group.promptCount += 1;
      group.deliveryIds.add(delivery.deliveryId);
      group.lastSeenAt = Math.max(group.lastSeenAt, prompt.createdAt, delivery.receivedAt);
      groups.set(key, group);
    }
  }

  return [...groups.values()]
    .filter((group) => group.promptCount >= 2 && group.deliveryIds.size >= 2)
    .map((group) => toSuggestion(group))
    .sort((a, b) => b.confidence - a.confidence || b.lastSeenAt - a.lastSeenAt)
    .slice(0, input.limit ?? 10);
}

function toSuggestion(group: SuggestionGroup): WebhookAutomationSuggestion {
  const promptCount = group.promptCount;
  const deliveryCount = group.deliveryIds.size;
  const confidence = Math.min(0.95, 0.45 + promptCount * 0.12 + deliveryCount * 0.08);
  const routeLabel = group.routePath ?? group.routeId;

  return {
    id: hashSuggestion(`${group.routeId}:${group.eventType}:${group.promptPattern}`),
    eventType: group.eventType,
    routeId: group.routeId,
    routePath: group.routePath,
    promptPattern: group.promptPattern,
    promptCount,
    deliveryCount,
    confidence,
    lastSeenAt: group.lastSeenAt,
    rationale: `${promptCount} similar manual prompts were sent within two hours of ${deliveryCount} ${group.eventType} webhook deliveries on ${routeLabel}.`,
    suggestedAutomationName: `Handle ${group.eventType}`,
    suggestedPrompt: `When a ${group.eventType} webhook arrives on ${routeLabel}, ${group.promptPattern}. Use the webhook payload as context and report what changed.`,
  };
}

function promptLooksActionable(text: string): boolean {
  const normalized = normalizePrompt(text);
  return /\b(fix|repair|broken|failing|failed|failure|pipeline|workflow|ci|build|test|deploy|release|push|pr|review)\b/.test(normalized);
}

function promptIntent(text: string, eventType: string): string | null {
  const normalized = normalizePrompt(`${text} ${eventType}`);
  if (/\b(pipeline|workflow|ci)\b/.test(normalized)) {
    return 'inspect the failing pipeline and fix the cause';
  }
  if (/\b(deploy|deployment|release)\b/.test(normalized)) {
    return 'inspect the deployment failure and prepare the fix';
  }
  if (/\b(build|test|tests)\b/.test(normalized)) {
    return 'inspect the failing build or tests and fix the cause';
  }
  if (/\b(push|pr|pull request|review)\b/.test(normalized)) {
    return 'review the change and resolve any follow-up work';
  }

  const words = normalized
    .split(' ')
    .filter((word) => word.length > 2)
    .slice(0, 10);
  return words.length >= 3 ? words.join(' ') : null;
}

function normalizePrompt(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashSuggestion(value: string): string {
  return `webhook-suggestion-${crypto.createHash('sha1').update(value).digest('hex').slice(0, 12)}`;
}
