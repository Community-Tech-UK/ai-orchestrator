import { expect, it, vi } from 'vitest';
import type { Writable } from 'node:stream';
import { ClaudeCliAdapter } from './claude-cli-adapter';
import { InputFormatter } from '../input-formatter';
const files = vi.hoisted(() => ({ process: vi.fn() }));
vi.mock('../file-handler', () => ({ processAttachments: files.process, buildMessageWithFiles: (message: string) => message }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
it('cancels Claude input during attachment preparation before admission or stdin write', async () => {
  const controller = new AbortController(); const write = vi.fn(); const admission = vi.fn();
  const adapter = new ClaudeCliAdapter({ workingDirectory: '/disposable-workspace' });
  Object.assign(adapter, { formatter: new InputFormatter({ writable: true, write } as unknown as Writable) });
  files.process.mockImplementation(async () => { await Promise.resolve(); controller.abort(); return []; });
  await expect(adapter.sendInput('synthetic continuation', [{ name: 'synthetic.txt', type: 'text/plain', size: 1, data: 'eA==' }], {
    dispatch: { signal: controller.signal, beforeProviderDispatch: admission },
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(files.process).toHaveBeenCalledOnce(); expect(admission).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
});
