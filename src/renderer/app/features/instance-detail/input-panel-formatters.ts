import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import type { ProviderType } from '../../core/services/provider-state.service';
import type { PickerProvider } from '../models/compact-model-picker.types';

export function getFileIcon(file: File): string {
  if (file.type.startsWith('image/')) return '🖼️';
  if (file.type.includes('pdf')) return '📄';
  if (file.type.includes('text')) return '📝';
  if (file.type.includes('json') || file.type.includes('javascript')) return '📋';
  return '📎';
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function defaultWakeupLocal(): string {
  return toDatetimeLocal(Date.now() + 60 * 60 * 1000);
}

export function parseWakeupLocal(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function truncateQueuedMessage(message: string): string {
  const firstLine = message.split('\n')[0];
  if (firstLine.length > 50) {
    return firstLine.slice(0, 50) + '...';
  }
  return firstLine + (message.includes('\n') ? '...' : '');
}

export function formatWaitReasonLabel(wr: InstanceWaitReason | undefined): string | null {
  if (!wr) return null;
  switch (wr.kind) {
    case 'respawning': return `Held — session respawning (${wr.strategy})`;
    case 'interrupt-ack': return 'Held — waiting for interrupt acknowledgement';
    case 'backoff': return `Held — backing off (attempt ${wr.attempt})`;
    case 'quota-park': return `Held — provider quota limit (${wr.provider})`;
    case 'provider-slot': return `Held — waiting for provider slot (${wr.provider})`;
    case 'resume-proof': return 'Held — verifying resume';
    case 'remote-heartbeat': return 'Held — remote worker unresponsive';
    case 'mutex': return `Held — waiting for session lock (${wr.operation})`;
    case 'terminating': return 'Held — instance terminating';
    default: return null;
  }
}

export function formatVoiceStatusLabel(
  mode: string,
  error: string | null | undefined,
  partialTranscript: string | null | undefined,
): string | null {
  if (error) return error;
  switch (mode) {
    case 'connecting': return 'Connecting voice...';
    case 'listening': return 'Listening';
    case 'transcribing': return partialTranscript || 'Listening';
    case 'sending': return 'Sending voice message...';
    case 'waiting-for-session': return 'Waiting for response...';
    case 'speaking': return 'Speaking';
    case 'stopping': return 'Stopping voice...';
    default: return null;
  }
}

export function toLoopPickerProvider(
  provider: ProviderType | InstanceProvider | null | undefined,
): PickerProvider {
  return provider === 'claude'
    || provider === 'codex'
    || provider === 'gemini'
    || provider === 'antigravity'
    || provider === 'copilot'
    || provider === 'cursor'
    ? provider
    : 'claude';
}

export function startsWithLikelyPath(text: string): boolean {
  const firstToken = text.trimStart().split(/\s+/)[0] ?? '';
  return /^\/{2}[^/\s]+\/[^/\s]+/.test(firstToken)
    || /^\/[^/\s]+\/.+/.test(firstToken);
}

export function getFolderDisplayName(folderPath: string): string {
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

function toDatetimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}
