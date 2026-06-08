import { describe, expect, it } from 'vitest';
import { parseCodexExecTranscript } from './exec-transcript-parser';

describe('parseCodexExecTranscript', () => {
  it('preserves dynamic tool call names and arguments', () => {
    const transcript = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'tool-1',
          type: 'dynamicToolCall',
          toolName: 'update_plan',
          input: {
            plan: [
              { step: 'Inspect current UI', status: 'completed' },
              { step: 'Add progress panel', status: 'in_progress' },
            ],
          },
          output: 'ok',
        },
      }),
    ].join('\n');

    const parsed = parseCodexExecTranscript(transcript, [], 'response-1');

    expect(parsed.hasMeaningfulOutput).toBe(true);
    expect(parsed.response.toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'update_plan',
        arguments: {
          plan: [
            { step: 'Inspect current UI', status: 'completed' },
            { step: 'Add progress panel', status: 'in_progress' },
          ],
        },
        result: 'ok',
      },
    ]);
  });

  it('extracts and unwraps a double-encoded turn.failed error from stdout', () => {
    const innerError = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
      },
    });
    const transcript = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'turn.failed', error: { message: innerError } }),
    ].join('\n');

    const parsed = parseCodexExecTranscript(transcript, [], 'response-1');

    expect(parsed.hasMeaningfulOutput).toBe(false);
    expect(parsed.errorMessage).toBe(
      "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."
    );
  });

  it('extracts a plain error event message from stdout', () => {
    const transcript = JSON.stringify({ type: 'error', message: 'stream disconnected before completion' });

    const parsed = parseCodexExecTranscript(transcript, [], 'response-1');

    expect(parsed.errorMessage).toBe('stream disconnected before completion');
  });

  it('leaves errorMessage undefined for a successful transcript', () => {
    const transcript = [
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'hi' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');

    const parsed = parseCodexExecTranscript(transcript, [], 'response-1');

    expect(parsed.errorMessage).toBeUndefined();
    expect(parsed.hasMeaningfulOutput).toBe(true);
  });
});
