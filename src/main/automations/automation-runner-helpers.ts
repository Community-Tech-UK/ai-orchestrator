import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { getLogger } from '../logging/logger';
import { getArtifactAttributionStore } from '../session/artifact-attribution-store';
import { getChannelManager } from '../channels/channel-manager';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { ChannelPlatform } from '../../shared/types/channels';

const logger = getLogger('AutomationRunner');
const CHANNEL_DELIVERY_MAX_CHARS = 3500;

export interface RunTracking {
  runId: string;
  automationId: string;
  seenAssistantOutput: boolean;
  lastAssistantOutput?: string;
  outputChunks: {
    kind: string;
    content?: string;
    timestamp: number;
  }[];
}

function getUserDataPath(): string {
  const electronApp = app as { getPath?: (name: string) => string } | undefined;
  return typeof electronApp?.getPath === 'function'
    ? electronApp.getPath('userData')
    : path.join(os.tmpdir(), 'ai-orchestrator');
}

export function writeFullOutput(tracking: RunTracking): string | undefined {
  if (tracking.outputChunks.length === 0 && !tracking.lastAssistantOutput) {
    return undefined;
  }

  try {
    const outputDir = path.join(getUserDataPath(), 'automation-run-output');
    fs.mkdirSync(outputDir, { recursive: true });
    const filePath = path.join(outputDir, `${tracking.runId}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      runId: tracking.runId,
      automationId: tracking.automationId,
      lastAssistantOutput: tracking.lastAssistantOutput,
      events: tracking.outputChunks,
      capturedAt: Date.now(),
    }, null, 2), 'utf-8');
    getArtifactAttributionStore().registerArtifact({
      ownerType: 'automation_run',
      ownerId: tracking.runId,
      kind: 'automation_full_output',
      path: filePath,
    });
    return filePath;
  } catch (error) {
    logger.warn('Failed to persist full automation output', {
      runId: tracking.runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function deliverRunSummaryToChannel(run: AutomationRun): Promise<void> {
  if (run.deliveryMode !== 'notify') {
    return;
  }
  const target = getChannelDeliveryTarget(run);
  if (!target) {
    return;
  }

  const adapter = getChannelManager().getAdapter(target.platform);
  if (!adapter) {
    return;
  }

  const content = formatChannelRunSummary(run);
  const sent = await adapter.sendMessage(target.chatId, content, target.replyToMessageId
    ? { replyTo: target.replyToMessageId }
    : undefined);
  getChannelManager().emitResponseSent({
    channelMessageId: target.replyToMessageId ?? run.id,
    platform: target.platform,
    chatId: target.chatId,
    messageId: sent.messageId,
    instanceId: run.instanceId ?? run.id,
    content,
    status: run.status === 'failed' ? 'error' : 'complete',
    replyToMessageId: target.replyToMessageId,
    timestamp: Date.now(),
  });
}

function getChannelDeliveryTarget(run: AutomationRun): {
  platform: ChannelPlatform;
  chatId: string;
  replyToMessageId?: string;
} | null {
  const source = run.triggerSource;
  if (!source?.channel && !source?.metadata) {
    return null;
  }
  const metadata = source.metadata ?? {};
  const channelParts = typeof source.channel === 'string'
    ? source.channel.split(':')
    : [];
  const platform = toChannelPlatform(metadata['platform'])
    ?? toChannelPlatform(channelParts[0]);
  const chatId = typeof metadata['chatId'] === 'string'
    ? metadata['chatId']
    : channelParts.length > 1
      ? channelParts.slice(1).join(':')
      : undefined;
  if (!platform || !chatId) {
    return null;
  }
  const replyToMessageId = typeof metadata['replyToMessageId'] === 'string'
    ? metadata['replyToMessageId']
    : typeof metadata['messageId'] === 'string'
      ? metadata['messageId']
      : undefined;
  return { platform, chatId, replyToMessageId };
}

function toChannelPlatform(value: unknown): ChannelPlatform | null {
  return value === 'discord' || value === 'whatsapp' ? value : null;
}

function formatChannelRunSummary(run: AutomationRun): string {
  const name = run.configSnapshot?.name ?? run.automationId;
  const status = run.status === 'succeeded'
    ? 'succeeded'
    : run.status === 'failed'
      ? 'failed'
      : run.status;
  const body = run.outputSummary ?? run.error ?? 'No summary was captured.';
  const text = `Automation "${name}" ${status}.\n\n${body}`;
  return text.length > CHANNEL_DELIVERY_MAX_CHARS
    ? `${text.slice(0, CHANNEL_DELIVERY_MAX_CHARS - 3)}...`
    : text;
}
