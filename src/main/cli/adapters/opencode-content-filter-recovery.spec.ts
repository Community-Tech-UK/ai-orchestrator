import { describe, expect, it, vi } from 'vitest';
import { sanitizeOpenCodeContentFilterSource } from './opencode-content-filter-recovery';

const part = { id: 'prt_example', messageID: 'msg_example', sessionID: 'ses_example', type: 'tool', tool: 'read', callID: 'call_example', state: { status: 'completed', input: { filePath: '/tmp/source.txt' }, output: 'source material', time: { start: 1, end: 2 } } };
const messages = [{ info: { id: 'msg_user', role: 'user' }, parts: [] }, { info: { id: 'msg_example', role: 'assistant' }, parts: [part] }];

describe('OpenCode content-filter source sanitization', () => {
  it('marks the latest read result compacted and verifies provider persisted it', async () => {
    let stored = part;
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') { stored = JSON.parse(init.body as string); return stored; }
      return path.includes('?') ? messages : { info: messages[1]!.info, parts: [stored] };
    });
    expect(await sanitizeOpenCodeContentFilterSource(request, 'ses_example')).toBe(true);
    expect(request.mock.calls[1]![0]).toBe('/session/ses_example/message/msg_example/part/prt_example');
    expect(stored.state.time).toMatchObject({ compacted: expect.any(Number) });
    expect(stored.state.output).toBe('source material');
  });
  it('fails closed when readback does not confirm exclusion', async () => {
    const request = vi.fn(async (path: string) => path.includes('?') ? messages : { parts: [part] });
    expect(await sanitizeOpenCodeContentFilterSource(request, 'ses_example')).toBe(false);
  });
  it('does not mutate user input or an unrelated earlier read after a mutating tool', async () => {
    const request = vi.fn(async () => [...messages, { info: { id: 'msg_next', role: 'assistant' }, parts: [{ ...part, tool: 'bash' }] }]);
    expect(await sanitizeOpenCodeContentFilterSource(request, 'ses_example')).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not mutate history when cancelled during source lookup', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => { controller.abort(); return messages; });
    expect(await sanitizeOpenCodeContentFilterSource(request, 'ses_example', controller.signal)).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects failed or unsupported native requests', async () => {
    expect(await sanitizeOpenCodeContentFilterSource(async () => { throw new Error('unsupported'); }, 'ses_example')).toBe(false);
  });
  it('does not redact an earlier read that is not the failing ACP turn call', async () => {
    const request = vi.fn(async () => messages);
    expect(await sanitizeOpenCodeContentFilterSource(request, 'ses_example', undefined, 'call_current')).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
