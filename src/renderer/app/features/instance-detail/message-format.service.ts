import { Injectable } from '@angular/core';
import { DisplayItem } from './display-item-processor.service';
import { OutputMessage } from '../../core/state/instance.store';

@Injectable({ providedIn: 'root' })
export class MessageFormatService {
  /** Summary shown on a collapsed work-cycle header, e.g.
   *  "7 thoughts · 4 Bash · 1 error" — counts grouped by sub-type. */
  summarizeCycle(item: DisplayItem): string {
    const children = item.children;
    if (!children || children.length === 0) return '';
    let thoughtCount = 0;
    let errorCount = 0;
    const toolCounts = new Map<string, number>();
    for (const child of children) {
      if (child.type === 'thought-group') {
        thoughtCount++;
      } else if (child.type === 'tool-group' && child.toolMessages) {
        for (const m of child.toolMessages) {
          if (m.type === 'tool_use') {
            const name = this.getToolName(m);
            toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
          }
        }
      } else if (child.type === 'message' && child.message) {
        if (child.message.type === 'error') errorCount++;
        else if (child.message.type === 'tool_use') {
          const name = this.getToolName(child.message);
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
        }
      }
    }
    const parts: string[] = [];
    if (thoughtCount > 0) parts.push(`${thoughtCount} thought${thoughtCount === 1 ? '' : 's'}`);
    for (const [name, count] of toolCounts) parts.push(`${count} ${name}`);
    if (errorCount > 0) parts.push(`${errorCount} error${errorCount === 1 ? '' : 's'}`);
    return parts.length > 0 ? parts.join(' · ') : `${children.length} steps`;
  }

  /** "23s" / "2m 15s" elapsed across the cycle's children; empty if unknown. */
  formatCycleDuration(item: DisplayItem): string {
    const children = item.children;
    if (!children || children.length < 2) return '';
    const firstTs = this.getCycleChildTimestamp(children[0]);
    const lastTs = this.getCycleChildTimestamp(children[children.length - 1]);
    if (firstTs === null || lastTs === null || lastTs <= firstTs) return '';
    const seconds = Math.round((lastTs - firstTs) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rem = seconds % 60;
    return rem > 0 ? `${minutes}m ${rem}s` : `${minutes}m`;
  }

  getCycleChildTimestamp(child: DisplayItem): number | null {
    if (child.timestamp) return child.timestamp;
    if (child.message) return child.message.timestamp;
    if (child.response) return child.response.timestamp;
    if (child.toolMessages?.[0]) return child.toolMessages[0].timestamp;
    return null;
  }

  formatType(type: string, provider: string): string {
    if (type === 'assistant') {
      return this.getProviderDisplayName(provider);
    }
    const labels: Record<string, string> = {
      user: 'You',
      system: 'System',
      tool_use: 'Tool',
      tool_result: 'Result',
      error: 'Error'
    };
    return labels[type] || type;
  }

  getProviderDisplayName(provider: string): string {
    switch (provider) {
      case 'claude':
        return 'Claude';
      case 'copilot':
        return 'Copilot';
      case 'codex':
        return 'Codex';
      case 'gemini':
        return 'Gemini';
      case 'ollama':
        return 'Ollama';
      case 'cursor':
        return 'Cursor';
      default:
        return 'AI';
    }
  }

  hasContent(message: OutputMessage): boolean {
    // Check if message has meaningful content to display
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      return !!message.metadata || !!message.content;
    }
    // User messages may have attachments without text
    if (message.attachments && message.attachments.length > 0) {
      return true;
    }
    return !!message.content?.trim();
  }

  isCompactionBoundary(message: OutputMessage): boolean {
    return message.type === 'system' && !!message.metadata?.['isCompactionBoundary'];
  }

  isRestoreNotice(message: OutputMessage): boolean {
    return message.type === 'system' && !!message.metadata?.['isRestoreNotice'];
  }

  getCompactionLabel(message: OutputMessage): string {
    const meta = message.metadata;
    if (!meta) return 'Context compacted';

    const prev = meta['previousUsage'] as { percentage?: number } | undefined;
    const next = meta['newUsage'] as { percentage?: number } | undefined;
    const method = meta['method'] as 'native' | 'restart-with-summary' | undefined;
    const methodLabel = method ? `[${method}]` : '';

    if (prev?.percentage !== undefined && next?.percentage !== undefined) {
      return `Context compacted ${methodLabel} (${Math.round(prev.percentage)}% → ${Math.round(next.percentage)}%)`.trim();
    }

    return `Context compacted ${methodLabel}`.trim();
  }

  formatCompactionReason(reason: string): string {
    const labels: Record<string, string> = {
      hard_limit: 'history threshold',
      background_threshold: 'context budget',
      cooldown: 'cooldown',
      none: 'context update',
      'context-budget': 'context budget',
    };
    const label = labels[reason];
    if (label) return label;

    const fallback = reason.replace(/[_-]+/g, ' ').trim();
    return fallback || 'context update';
  }

  formatCompactionFallbackMode(mode: string): string {
    const labels: Record<string, string> = {
      'in-place': 'in place',
      'snapshot-restore': 'snapshot restore',
      'native-resume': 'native resume',
      'replay-fallback': 'replay fallback',
    };
    return labels[mode] ?? mode.replace(/[_-]+/g, ' ').trim();
  }

  /**
   * Check if a thought-group has any content to display.
   * Returns false if thinking is hidden AND response is empty.
   * @param showThinking - current value of the showThinking input signal
   */
  hasThoughtGroupContent(item: DisplayItem, showThinking: boolean): boolean {
    const hasThinking = (item.thinking && item.thinking.length > 0) ||
                       (item.thoughts && item.thoughts.length > 0);
    const showsThinking = hasThinking && showThinking;
    const hasResponse = !!(item.response && this.hasContent(item.response));

    return showsThinking || hasResponse;
  }

  getToolName(message: OutputMessage): string {
    if (message.metadata && 'name' in message.metadata) {
      return String(message.metadata['name']);
    }
    return message.type === 'tool_use' ? 'Tool Call' : 'Result';
  }

  formatContent(message: OutputMessage): string {
    if (message.metadata) {
      return JSON.stringify(message.metadata, null, 2);
    }
    return message.content || '';
  }

  getMessageSignature(messages: OutputMessage[]): string {
    const lastMessage = messages[messages.length - 1];
    return [
      messages.length,
      lastMessage?.id ?? '',
      lastMessage?.timestamp ?? '',
      lastMessage?.content?.length ?? 0
    ].join(':');
  }
}
