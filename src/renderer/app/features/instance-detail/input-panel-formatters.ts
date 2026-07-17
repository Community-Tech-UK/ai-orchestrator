import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import type { ProviderType } from '../../core/services/provider-state.service';
import type { PickerProvider } from '../models/compact-model-picker.types';
import type { ExtendedCommand } from '../../core/state/command.store';

/** Flattened searchable text for a command (name, aliases, description, etc.). */
export function commandSuggestionText(command: ExtendedCommand): string {
  return [
    command.name,
    ...(command.aliases ?? []),
    command.description,
    command.category ?? '',
    command.usage ?? '',
  ].filter(Boolean).join(' ');
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

/**
 * Countdown text for the quota-park banner above the composer. The park
 * auto-resumes at the recorded reset AND re-probes for an early lift, so the
 * copy says "by", not "in" — the recorded time is a ceiling, not a promise.
 */
export function formatQuotaParkCountdown(resumeAt: number, now: number): string {
  const secsLeft = Math.max(0, Math.round((resumeAt - now) / 1000));
  if (secsLeft <= 0) return 'resuming…';
  if (secsLeft < 60) return `auto-resumes in ${secsLeft}s`;
  const minsLeft = Math.ceil(secsLeft / 60);
  if (minsLeft < 120) return `auto-resumes in ≤${minsLeft}m`;
  const hours = Math.floor(minsLeft / 60);
  return `auto-resumes in ≤${hours}h ${minsLeft % 60}m`;
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
    || provider === 'grok'
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
