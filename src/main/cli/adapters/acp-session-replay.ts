import type { OutputMessage } from '../../../shared/types/instance.types';

export interface AcpHistoryReplay { sessionId: string; messages: OutputMessage[] }

export function acpResumeCursor(sessionId: string, provider: string, workspacePath: string): Record<string, unknown> {
  return { transport: 'acp', provider, sessionId, workspacePath };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(content: unknown): string {
  if (!record(content)) return '';
  if (content['type'] === 'text' && typeof content['text'] === 'string') return content['text'];
  return '';
}

/** Own opening updates until the response confirms the requested session. */
export class AcpSessionReplay {
  private readonly messages = new Map<string, OutputMessage>();
  private readonly metadata = new Map<string, Record<string, unknown>>();
  private bytes = 0;
  private overflow = false;
  private sequence = 0;
  private metadataBytes = 0;

  constructor(readonly sessionId: string, private readonly replayHistory: boolean) {
    if (!sessionId || sessionId.length > 2000) throw new Error('ACP session identity exceeds the safe replay limit.');
  }

  observe(params: Record<string, unknown>): boolean {
    if (params['sessionId'] !== this.sessionId) return false;
    const update = params['update'];
    if (!record(update) || this.overflow) return true;
    // Child metadata is an exclusion boundary, including malformed ownership.
    if (record(update['_meta']) && Object.hasOwn(update['_meta'], 'opencode/child-session')) return true;
    const kind = update['sessionUpdate'];
    if (['available_commands_update', 'config_option_update', 'usage_update'].includes(String(kind))) {
      // At most three retained frames, one MiB in aggregate (including all
      // command/config identifiers and vendor fields). Replacement releases its
      // previous allowance. Oversize is explicit, never silently truncated.
      const length = JSON.stringify(update).length;
      this.metadataBytes += length - (this.metadata.has(String(kind)) ? JSON.stringify(this.metadata.get(String(kind))).length : 0);
      if (this.metadataBytes > 1024 * 1024) { this.overflow = true; return true; }
      this.metadata.set(String(kind), update);
    } else if (this.replayHistory) {
      if (kind === 'agent_message_chunk' || kind === 'user_message_chunk') {
        const content = text(update['content']);
        const type = kind === 'agent_message_chunk' ? 'assistant' : 'user';
        const id = typeof update['messageId'] === 'string' ? update['messageId'] : `acp-replay:${++this.sequence}`;
        if (id.length > 2000) { this.overflow = true; return true; }
        const previous = this.messages.get(id);
        this.put(id, { id, timestamp: Date.now(), type, content: (previous?.content ?? '') + content, metadata: { transport: 'acp', acpReplay: true } });
      }
    }
    return true;
  }

  private put(id: string, message: OutputMessage): void {
    this.bytes += message.content.length - (this.messages.get(id)?.content.length ?? 0);
    if (this.messages.size >= 10_000 && !this.messages.has(id) || this.bytes > 32 * 1024 * 1024) { this.overflow = true; return; }
    this.messages.set(id, message);
  }

  finish(): { history?: AcpHistoryReplay; metadata: Record<string, unknown>[] } {
    if (this.overflow) throw new Error('ACP session history exceeds the safe replay limit; refusing an incomplete restore.');
    const messages = [...this.messages.values()].filter((message) => message.content.trim());
    return { ...(this.replayHistory ? { history: { sessionId: this.sessionId, messages } } : {}), metadata: [...this.metadata.values()] };
  }
}
