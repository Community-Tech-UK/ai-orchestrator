import { generateId } from '../../../shared/utils/id-generator';

/** Prompt-free observation: a request is not proof that the CLI will wake itself. */
export type ClaudeSelfWakeupEvent =
  | { kind: 'requested'; toolUseId: string; requestedAt: number; delaySeconds: number; dueAt: number; reason: string }
  | { kind: 'refused'; toolUseId: string; requestedAt: number }
  | { kind: 'stopped'; toolUseId: string; requestedAt: number };

export function parseClaudeSelfWakeup(toolName: string, toolUseId: string, input: unknown, now: number): Exclude<ClaudeSelfWakeupEvent, { kind: 'refused' }> | null {
  if (!Number.isSafeInteger(now)) return null;
  if (toolName !== 'ScheduleWakeup' || !input || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  if (fields['noop'] === true || fields['is_error'] === true) return null;
  if (fields['stop'] === true) return { kind: 'stopped', toolUseId, requestedAt: now };
  const delaySeconds = fields['delaySeconds'];
  if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || delaySeconds <= 0) return null;
  const dueAt = now + delaySeconds * 1000;
  if (!Number.isSafeInteger(dueAt) || dueAt > 8.64e15) return null;
  return { kind: 'requested', toolUseId, requestedAt: now, delaySeconds, dueAt,
    reason: typeof fields['reason'] === 'string' ? fields['reason'].slice(0, 120) : '' };
}

/** Keep the private future prompt out of normal tool metadata too. */
export function sanitizeClaudeToolInput(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'ScheduleWakeup') return input;
  const safe: Record<string, unknown> = {};
  if (typeof input['delaySeconds'] === 'number' && Number.isFinite(input['delaySeconds'])) safe['delaySeconds'] = input['delaySeconds'];
  if (typeof input['reason'] === 'string') safe['reason'] = input['reason'].slice(0, 120);
  for (const key of ['noop', 'stop']) if (typeof input[key] === 'boolean') safe[key] = input[key];
  return safe;
}

const emittedRequests = new WeakMap<object, Set<string>>();

export function emitClaudeSelfWakeup(host: { emit(event: string, ...args: unknown[]): boolean }, toolName: string, toolUseId: string, input: unknown, now = Date.now()): void {
  const event = parseClaudeSelfWakeup(toolName, toolUseId, input, now);
  if (!event) return;
  const seen = emittedRequests.get(host) ?? new Set<string>();
  const key = `${event.kind}:${event.toolUseId}`;
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 1000) seen.delete(seen.values().next().value!);
  emittedRequests.set(host, seen);
  const content = event.kind === 'stopped' ? 'Claude cancelled its wake-up request' :
    `Claude asked to be woken at ${new Date(event.dueAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (in ${Math.round(event.delaySeconds / 60 * 10) / 10} minutes)`;
  host.emit('output', { id: generateId(), timestamp: now, type: 'system', content, metadata: { selfWakeup: event } });
  host.emit('self_wakeup', event);
}

/** Remote adapters carry the safe notice metadata on their existing output channel. */
export function readClaudeSelfWakeupNotice(metadata: Record<string, unknown> | undefined): ClaudeSelfWakeupEvent | null {
  const raw = metadata?.['selfWakeup'];
  if (!raw || typeof raw !== 'object') return null;
  const fields = raw as Record<string, unknown>;
  if (typeof fields['toolUseId'] !== 'string' || typeof fields['requestedAt'] !== 'number') return null;
  if (fields['kind'] === 'refused' && Number.isSafeInteger(fields['requestedAt'])) return { kind: 'refused', toolUseId: fields['toolUseId'], requestedAt: fields['requestedAt'] };
  if (fields['kind'] === 'stopped') return parseClaudeSelfWakeup('ScheduleWakeup', fields['toolUseId'], { stop: true }, fields['requestedAt']);
  if (fields['kind'] !== 'requested') return null;
  return parseClaudeSelfWakeup('ScheduleWakeup', fields['toolUseId'], fields, fields['requestedAt']);
}

/** A rejected result cannot leave a request looking pending. */
export function emitClaudeSelfWakeupRefusal(host: { emit(event: string, ...args: unknown[]): boolean }, toolName: string | undefined, toolUseId: string, isError: boolean): void {
  if (toolName !== 'ScheduleWakeup' || !isError) return;
  const event: ClaudeSelfWakeupEvent = { kind: 'refused', toolUseId, requestedAt: Date.now() };
  host.emit('output', { id: generateId(), timestamp: event.requestedAt, type: 'system', content: 'Claude’s wake-up request was refused; it will not happen.', metadata: { selfWakeup: event } });
  host.emit('self_wakeup', event);
}


/** Remove only the private future prompt from raw NDJSON kept for completion capture. */
export function sanitizeClaudeSelfWakeupRawNdjson(raw: string): string {
  if (!raw.includes('ScheduleWakeup')) return raw;
  return raw.split(/(\r?\n)/).map(line => {
    if (!line.includes('ScheduleWakeup')) return line;
    try {
      const parsed: unknown = JSON.parse(line);
      let changed = false;
      const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) { for (const child of value) visit(child); return; }
        const fields = value as Record<string, unknown>;
        if (fields['name'] === 'ScheduleWakeup' && fields['input'] && typeof fields['input'] === 'object') {
          const input = fields['input'] as Record<string, unknown>;
          if ('prompt' in input) { delete input['prompt']; changed = true; }
        }
        for (const child of Object.values(fields)) visit(child);
      };
      visit(parsed);
      return changed ? JSON.stringify(parsed) : line;
    } catch { return '[Unparseable ScheduleWakeup capture omitted]'; }
  }).join('');
}
