import { describe, expect, it } from 'vitest';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';
import type { OutputMessage } from '../../../shared/types/instance.types';

// Real OpenCode 2.0.18 shapes (packages/cli/src/acp/event.ts): `session.retry.scheduled` is forwarded as
// session_info_update with `_meta['opencode/retry'] = { attempt, nextRetryAt (ISO string), error }`, and the next
// `session.step.started` clears it with `_meta['opencode/retry'] = null`. That clear means the next attempt is
// starting, not that it succeeded, so the notice reads "trying again" until the turn itself settles.
const sessionId = 'sess-acp-1';
const retryScheduled = { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': {
  attempt: 2, nextRetryAt: '2026-10-20T10:00:05.000Z', error: { type: 'api', message: 'fixture provider message', status: 429 },
} } };
const retryCleared = { sessionUpdate: 'session_info_update', _meta: { 'opencode/retry': null } };

describe('OpenCode retry marker clearing', () => {
  it('moves the retry notice to "trying again" on a null opencode/retry marker, before the turn ends, and settles it at turn end', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', promptTimeoutMs: 2000 });
    adapter.configureOpenCodeV2(true);
    const outputs: OutputMessage[] = [];
    adapter.on('output', (output: OutputMessage) => outputs.push(output));
    adapter.on('status', () => undefined);
    adapter.on('error', () => undefined);
    const retryNotices = () => outputs.filter(output => output.metadata?.['source'] === 'acp-retry-state');
    let seenBeforeTurnEnd: OutputMessage[] = [];
    try {
      await adapter.spawn();
      proc.onRequest('session/prompt', async request => {
        proc.notify('session/update', { sessionId, update: retryScheduled });
        proc.notify('session/update', { sessionId, update: retryCleared });
        // The turn stays open until the clear has had time to land (or the poll gives up).
        const deadline = Date.now() + 500;
        while (Date.now() < deadline && !retryNotices().some(output => output.metadata?.['phase'] === 'attempting')) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        seenBeforeTurnEnd = retryNotices().slice();
        proc.respond(request.id, { stopReason: 'end_turn' });
      });
      await adapter.sendMessage({ role: 'user', content: 'go' });
      const retrying = seenBeforeTurnEnd.find(output => output.metadata?.['phase'] === 'retrying');
      const attempting = seenBeforeTurnEnd.find(output => output.metadata?.['phase'] === 'attempting');
      expect(retrying?.content).toContain('Provider returned HTTP 429.');
      expect(retrying?.metadata?.['streaming']).toBe(true);
      expect(attempting?.content).toBe('Provider is trying the request again.');
      expect(attempting?.metadata?.['streaming']).toBe(true);
      expect(attempting?.id).toBe(retrying?.id);
      const settled = retryNotices().at(-1);
      expect(settled?.metadata?.['phase']).toBe('recovered');
      expect(settled?.metadata?.['streaming']).toBe(false);
      expect(settled?.id).toBe(retrying?.id);
      expect(JSON.stringify(outputs)).not.toContain('fixture provider message');
    } finally {
      proc.exit();
      await adapter.terminate(false);
    }
  });
});
