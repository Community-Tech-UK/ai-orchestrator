import type { OutputMessage } from '../../src/shared/types/instance.types';
import { classifyUserText } from './message-classify';

/** Shape of the Claude Code transcript lines this reads; everything else on a line is ignored. */
interface TranscriptLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message?: { content?: unknown };
}

interface Block { type?: string; text?: string; id?: string; name?: string; input?: unknown }

function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const blocks = content as Block[];
  if (blocks.some((block) => block?.type === 'tool_result')) return null;
  return blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
}

/**
 * Turns the lines of one Claude Code transcript (already parsed) into the
 * message list the app keeps live. A person's typed line is `user` with
 * `inputOrigin`; a line the app wrote is `system` with `internalInput`;
 * assistant text is `assistant`; tool calls are `tool_use` rows. Sidechain
 * lines, meta lines, tool results and thinking are left out.
 */
export function transcriptToMessages(lines: readonly unknown[]): OutputMessage[] {
  const out: OutputMessage[] = [];
  lines.forEach((raw, index) => {
    const line = raw as TranscriptLine;
    if (!line || line.isSidechain || line.isMeta) return;
    const timestamp = Date.parse(line.timestamp ?? '');
    if (!Number.isFinite(timestamp)) return;
    const id = line.uuid ? `${line.uuid}` : `line-${index}`;

    if (line.type === 'user') {
      const raw = userText(line.message?.content);
      if (raw === null) return;
      const cls = classifyUserText(raw);
      if (cls.kind === 'person') {
        out.push({ id, timestamp, type: 'user', content: cls.text, metadata: { inputOrigin: { kind: 'person', typedAt: timestamp } } });
      } else {
        out.push({ id, timestamp, type: 'system', content: raw, metadata: { internalInput: { actor: 'harness', source: cls.source } } });
      }
    } else if (line.type === 'assistant') {
      const content = line.message?.content;
      if (!Array.isArray(content)) return;
      const blocks = content as Block[];
      const text = blocks.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
      if (text.trim()) out.push({ id, timestamp, type: 'assistant', content: text });
      blocks.forEach((block, blockIndex) => {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string') return;
        out.push({
          id: `${id}:tool${blockIndex}`, timestamp, type: 'tool_use', content: block.name,
          metadata: { name: block.name, input: block.input ?? {} },
        });
      });
    }
  });
  return out;
}
