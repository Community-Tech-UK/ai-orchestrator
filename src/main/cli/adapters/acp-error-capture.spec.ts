import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runConversationLedgerMigrations } from '../../conversation-ledger/conversation-ledger-schema';
import { ProviderEventCaptureStore } from '../../conversation-ledger/provider-event-capture-store';
import { ProviderEventCaptureService } from '../../conversation-ledger/provider-event-capture-service';
import { emitRecoverySafeAdapterError } from '../../instance/instance-communication-recovery-safety';
import { createInitializedAgentHarness, TestAcpCliAdapter } from './acp-cli-adapter.test-helpers';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

describe('ACP error capture (MiMo LT-712)', () => {
  it.each(['absent', 'observed', 'http'] as const)('persists the received envelope with %s error data', async shape => {
    const db = new Database(':memory:') as unknown as SqliteDriver;
    runConversationLedgerMigrations(db);
    const store = new ProviderEventCaptureStore(db);
    const events = new EventEmitter();
    const capture = new ProviderEventCaptureService({
      enabled: () => true,
      ledger: { appendProviderEventCaptures: async rows => { store.append(rows); } },
    });
    capture.start(events);
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' });
    const httpData = {
      statusCode: 429,
      body: JSON.stringify({ error: { code: '429', message: 'quota exhausted', type: 'limitation' }, api_key: '<api-key-placeholder>' }),
      requestHeaders: { authorization: '<authorization-placeholder>' },
    };
    // Real OpenCode 1.19.5 refusal observed 2026-11-03. ACP supplies these
    // fields but no upstream HTTP status/body; -32603 must never become 429.
    const observedData = { service: 'session', errorName: 'APIError' };
    const data = shape === 'http' ? httpData : observedData;
    let requestId: string | number | undefined;
    proc.onRequest('session/prompt', message => {
      requestId = message.id;
      proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: {
        code: -32603, message: 'Internal error: quota exhausted', ...(shape !== 'absent' ? { data } : {}),
      } }) + '\n');
    });
    adapter.on('error', error => emitRecoverySafeAdapterError('example-session', undefined, error, false, (event, options) => {
      events.emit('provider:raw-event', {
        eventId: randomUUID(), seq: 0, timestamp: Date.now(), provider: 'opencode',
        instanceId: 'example-session', sessionId: 'sess-acp-1', event, raw: options.raw,
      });
    }));
    try {
      await adapter.spawn();
      await adapter.sendInput('Example quota fixture');
      await capture.flush();
      const rows = store.list({ instanceId: 'example-session' });
      expect(rows).toHaveLength(1);
      expect(rows[0].event).toMatchObject({ kind: 'error', quota: { exhausted: true } });
      const payload = rows[0].raw.payload as { cause: { transport: string; id: string | number; error: Record<string, unknown> } };
      expect(payload.cause).toMatchObject({
        transport: 'acp-jsonrpc', jsonrpc: '2.0', id: requestId,
        error: { code: -32603, message: 'Internal error: quota exhausted' },
      });
      if (shape === 'http') {
        expect(payload.cause.error['data']).toEqual({
          statusCode: 429,
          body: { error: { code: '429', message: 'quota exhausted', type: 'limitation' }, api_key: '<redacted-secret>' },
          requestHeaders: { authorization: '<redacted-secret>' },
        });
      } else if (shape === 'observed') {
        expect(payload.cause.error['data']).toEqual(observedData);
        expect(JSON.stringify(payload.cause)).not.toContain('429');
      } else {
        // An ACP message mentioning quota does not establish an HTTP status/body.
        expect(payload.cause.error).not.toHaveProperty('data');
      }
      expect(JSON.stringify(rows)).not.toContain('<api-key-placeholder>');
      expect(JSON.stringify(rows)).not.toContain('<authorization-placeholder>');
    } finally {
      proc.exit();
      await adapter.terminate(false);
      await capture.stop();
      db.close();
    }
  });
});
