import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateOpenAiCompatibleOnWorker } from './worker-auxiliary-generate';

function res(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response;
}

const BASE = {
  model: 'qwen/qwen3.5-9b',
  systemPrompt: 'You score things.',
  userPrompt: 'Score this.',
  temperature: 0,
  maxOutputTokens: 512,
  timeoutMs: 5000,
  requireJson: true,
};

describe('generateOpenAiCompatibleOnWorker', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('returns trimmed content on success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      res({ choices: [{ message: { content: '\n{"score":8}' }, finish_reason: 'stop' }] }),
    ));
    const out = await generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE });
    expect(out).toBe('{"score":8}');
  });

  it('sends response_format json_object on the first attempt when requireJson', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE, requireJson: true });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('injects the /no_think directive into the system message (suppress reasoning)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.messages[0].content).toContain('/no_think');
    expect(body.messages[0].content).toContain('You score things.');
  });

  it('retries WITHOUT response_format when LM Studio 400s on json_object', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        res({ error: "'response_format.type' must be 'json_schema' or 'text'" }, false, 400),
      )
      .mockResolvedValueOnce(
        res({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const out = await generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE, requireJson: true });

    expect(out).toBe('{"ok":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string);
    expect(retryBody.response_format).toBeUndefined();
  });

  it('does NOT retry and surfaces the body for an unrelated 400 (e.g. context overflow)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      res({ error: 'n_keep: 15018 >= n_ctx: 4096' }, false, 400),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE, requireJson: true }),
    ).rejects.toThrow(/n_ctx: 4096/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws on empty content from a reasoning model (finish_reason length)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      res({ choices: [{ message: { content: '', reasoning_content: 'x'.repeat(500) }, finish_reason: 'length' }] }),
    ));
    await expect(
      generateOpenAiCompatibleOnWorker('http://127.0.0.1:1234', { ...BASE }),
    ).rejects.toThrow(/empty content.*finish_reason=length/);
  });
});
