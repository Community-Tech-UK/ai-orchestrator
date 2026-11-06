import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Writable } from 'node:stream';
import { InputFormatter } from './input-formatter';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ debug: vi.fn(), warn: vi.fn() }) }));

function formatter() {
  const lines: string[] = [];
  const write = vi.fn((data: string, _encoding: string, callback: (error?: Error) => void) => {
    lines.push(data);
    callback();
    return true;
  });
  const stdin = Object.assign(new EventEmitter(), { writable: true, write }) as unknown as Writable;
  return { input: new InputFormatter(stdin), lines };
}

describe('InputFormatter control requests (Step 14a wire shape)', () => {
  it('writes exactly {type, request_id, request:{subtype, ...fields}} as one NDJSON line', async () => {
    const { input, lines } = formatter();
    await input.sendControlRequest('generate_session_title', 'ctl_1', {
      description: 'fix the login bug',
      persist: false,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({
      type: 'control_request',
      request_id: 'ctl_1',
      request: { subtype: 'generate_session_title', description: 'fix the login bug', persist: false },
    });
  });

  it('carries nested fields (apply_flag_settings) untouched inside `request`', async () => {
    const { input, lines } = formatter();
    await input.sendControlRequest('apply_flag_settings', 'ctl_2', { settings: { effortLevel: 'high' } });
    expect(JSON.parse(lines[0])).toEqual({
      type: 'control_request',
      request_id: 'ctl_2',
      request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } },
    });
  });

  it('writes just the subtype when a request has no fields', async () => {
    const { input, lines } = formatter();
    await input.sendControlRequest('get_settings', 'ctl_3');
    expect(JSON.parse(lines[0])).toEqual({
      type: 'control_request',
      request_id: 'ctl_3',
      request: { subtype: 'get_settings' },
    });
  });

  it('writes control_cancel_request with only the request id', async () => {
    const { input, lines } = formatter();
    await input.sendCancelControlRequest('ctl_4');
    expect(JSON.parse(lines[0])).toEqual({ type: 'control_cancel_request', request_id: 'ctl_4' });
  });
});
