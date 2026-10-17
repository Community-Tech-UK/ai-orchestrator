import type { OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';
import type { ThreadItem } from './app-server-types';
import { parseCodexExecTranscript } from './exec-transcript-parser';
import {
  getCommandAggregatedOutput, getCommandExitCode, getFileChangeInput,
  getFileChangePath, getToolCallInput, getToolCallName,
  isCommandExecutionItem, isFailedThreadItemStatus,
} from './thread-item-accessors';

/** Per-child projection. Item boundaries publish progress, never turn completion. */
export class CodexExecOutput {
  private readonly started = new Set<string>();
  private readonly completed = new Set<string>();
  private fallbackLines: string[] = [];

  constructor(private readonly emit: (message: OutputMessage) => void) {}

  accept(line: string, event?: Record<string, unknown>): void {
    // Legacy plain text may contain multiline tool/thinking blocks. Keep their
    // boundaries intact; native JSON items can still publish immediately.
    if (typeof event?.['type'] !== 'string' && !line.trimStart().startsWith('{')) {
      this.fallbackLines.push(line);
      return;
    }
    this.flush();
    const eventType = event?.['type'];
    const rawItem = event?.['item'];
    const item = rawItem && typeof rawItem === 'object' && !Array.isArray(rawItem)
      ? rawItem as ThreadItem : undefined;
    if (item && ['item.created', 'item.started', 'item.completed'].includes(String(eventType))) {
      const complete = eventType === 'item.completed';
      if (complete && item.id && this.completed.has(item.id)) return;
      if (complete && item.id) this.completed.add(item.id);
      const tool = this.describeTool(item);
      if (tool) {
        const key = item.id ?? `${item.type}:${tool.content}`;
        const metadata = { ...(item.id ? { id: item.id } : {}), name: tool.name, input: tool.input };
        if (!this.started.has(key)) {
          this.started.add(key);
          this.publish('tool_use', tool.content, { ...metadata, streaming: true });
        }
        if (complete) {
          const exitCode = getCommandExitCode(item);
          const isError = isFailedThreadItemStatus(item)
            || (isCommandExecutionItem(item) && exitCode !== undefined && exitCode !== 0)
            || item['is_error'] === true;
          this.publish('tool_result', this.toolResult(item, tool.content, isError), {
            ...metadata, status: item.status, exitCode, is_error: isError,
          });
        }
        return;
      }
      if (!complete) return;
    }

    this.publishTranscript(line, item?.phase);
  }

  flush(): void {
    if (this.fallbackLines.length === 0) return;
    const text = this.fallbackLines.join('\n');
    this.fallbackLines = [];
    this.publishTranscript(text);
  }

  private publishTranscript(line: string, phase?: string): void {
    // Reuse the transcript parser for legacy text events, repaired JSON and
    // structured reasoning rather than maintaining a second text protocol.
    const { response } = parseCodexExecTranscript(line, [], generateId());
    for (const tool of response.toolCalls ?? []) {
      const metadata = { id: tool.id, name: tool.name, input: tool.arguments };
      this.publish('tool_use', `Using tool: ${tool.name}`, metadata);
      if (tool.result?.trim()) this.publish('tool_result', tool.result, { ...metadata, is_error: false });
    }
    if (response.content || response.thinking?.length) {
      this.emit({
        id: generateId(), timestamp: Date.now(), type: 'assistant', content: response.content,
        thinking: response.thinking?.map(block => ({ ...block, timestamp: block.timestamp ?? Date.now() })),
        metadata: { thinkingExtracted: true, ...(phase ? { phase } : {}) },
      });
    }
  }

  private describeTool(item: ThreadItem): { name: string; input: Record<string, unknown>; content: string } | undefined {
    if (isCommandExecutionItem(item) && typeof item.command === 'string') {
      return { name: 'Bash', input: { command: item.command }, content: `Running command: ${item.command}` };
    }
    if (item.type === 'file_change' || item.type === 'fileChange') {
      return { name: 'Edit', input: getFileChangeInput(item), content: `Editing file: ${getFileChangePath(item)}` };
    }
    if (['mcp_tool_call', 'mcpToolCall', 'dynamicToolCall'].includes(item.type)) {
      const name = getToolCallName(item);
      return { name, input: getToolCallInput(item), content: `Calling ${item.server || 'tool'}/${name}` };
    }
    if (item.type === 'web_search' || item.type === 'webSearch') {
      const query = typeof item.query === 'string' ? item.query : '';
      return { name: 'WebSearch', input: { query }, content: `Searching: ${query}` };
    }
    return undefined;
  }

  private toolResult(item: ThreadItem, fallback: string, isError: boolean): string {
    if (isCommandExecutionItem(item)) {
      const exitCode = getCommandExitCode(item);
      return getCommandAggregatedOutput(item)
        || (exitCode !== undefined ? `Command exited with code ${exitCode}` : `Command ${item.status || 'completed'}`);
    }
    for (const key of ['output', 'result', 'content', 'text', 'description']) {
      const value = item[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (value && typeof value === 'object') return JSON.stringify(value);
    }
    return `${fallback} (${isError ? item.status || 'failed' : item.status || 'completed'})`;
  }

  private publish(type: OutputMessage['type'], content: string, metadata: Record<string, unknown>): void {
    this.emit({ id: generateId(), timestamp: Date.now(), type, content, metadata });
  }
}
