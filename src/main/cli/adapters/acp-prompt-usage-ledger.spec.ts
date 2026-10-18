import { describe, it, expect } from 'vitest';
import { AcpCumulativePromptUsageLedger } from './acp-prompt-usage-ledger';
const frame = (inputTokens: number, cachedReadTokens: number, cachedWriteTokens: number, outputTokens: number) =>
  ({ inputTokens, cachedReadTokens, cachedWriteTokens, outputTokens });
describe('Copilot cumulative prompt usage', () => {
  it('differences measured frames and clamps gross cache rounding before an uncached third turn', () => {
    const ledger = new AcpCumulativePromptUsageLedger();
    ledger.settle(frame(894295,812622,81645,4180));
    expect(ledger.settle(frame(970826,877972,92830,7980))).toMatchObject({ inputTokens:0, cachedReadTokens:65350, cachedWriteTokens:11185, outputTokens:3800 });
    expect(ledger.settle(frame(1010826,905972,93830,9180))).toMatchObject({ inputTokens:11000, cachedReadTokens:28000, cachedWriteTokens:1000, outputTokens:1200 });
  });
  it('treats any falling counter as a restart and omits identical totals', () => {
    const ledger = new AcpCumulativePromptUsageLedger();
    ledger.settle(frame(100,70,20,10));
    expect(ledger.settle(frame(100,70,20,10))).toBeUndefined();
    expect(ledger.settle(frame(110,60,20,20))).toMatchObject({inputTokens:30,cachedReadTokens:60,cachedWriteTokens:20,outputTokens:20});
  });
  it('reset starts a new session; missing frames never erase the prior baseline', () => {
    const ledger = new AcpCumulativePromptUsageLedger();
    ledger.settle(frame(100,70,20,10)); ledger.settle(undefined);
    expect(ledger.settle(frame(150,100,30,20))).toMatchObject({ inputTokens:10,outputTokens:10 });
    ledger.reset(); expect(ledger.settle(frame(150,100,30,20))).toMatchObject({inputTokens:20,outputTokens:20});
  });
});
