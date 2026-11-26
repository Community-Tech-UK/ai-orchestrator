import { EventEmitter } from 'node:events';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NativeHelperSummary } from '../../../shared/types/instance.types';
import type { CliAdapterEvents, CliEvent } from './base-cli-adapter.types';
import { flushClaudeSubagentUsage, observeClaudeSubagentUsage } from './claude-subagent-usage';
import { ReceiptBus, type ReceiptPayloadMap } from './receipt-bus';

describe('native helper receipts', () => {
  it('covers every adapter event with the native helper payload contract', () => {
    expectTypeOf<keyof ReceiptPayloadMap>().toEqualTypeOf<CliEvent>();
    const receipt = new ReceiptBus().record('native_helpers', { running: 1 });
    expectTypeOf(receipt.payload).toEqualTypeOf<Parameters<CliAdapterEvents['native_helpers']>[0]>();
    expect(receipt).toMatchObject({ seq: 1, type: 'native_helpers', payload: { running: 1 } });
  });

  it('replays native lifecycle counts and wakes future receipt waiters without shell jobs', async () => {
    const adapter = new EventEmitter();
    const bus = new ReceiptBus();
    adapter.on('native_helpers', (summary: NativeHelperSummary) => bus.record('native_helpers', summary));
    const pending = bus.awaitReceipt(receipt => receipt.type === 'native_helpers', { includePast: false });

    observeClaudeSubagentUsage(adapter, {
      type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'foreground',
    });
    await expect(pending).resolves.toMatchObject({ seq: 1, type: 'native_helpers', payload: { running: 1 } });
    observeClaudeSubagentUsage(adapter, {
      type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: 'shell', is_backgrounded: true,
    });
    flushClaudeSubagentUsage(adapter);

    const receipts = bus.ofType('native_helpers');
    expectTypeOf(receipts[0].payload).toEqualTypeOf<NativeHelperSummary>();
    expect(receipts.map(receipt => receipt.payload)).toEqual([{ running: 1 }, { running: 0 }]);
    expect(receipts.map(receipt => receipt.seq)).toEqual([1, 2]);
    await expect(bus.awaitReceipt(receipt => receipt.seq === 2)).resolves.toBe(receipts[1]);
  });
});
