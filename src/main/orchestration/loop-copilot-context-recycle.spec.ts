import { describe, expect, it } from 'vitest';
import { evaluateLoopContextDiscipline } from './loop-context-discipline-runtime';

describe('Copilot loop compaction recycle', () => {
  it.each([[900, false], [901, true]])('honours strict 90%% root compaction even with ordinary discipline disabled: %s', (tokens, recycle) => {
    const outcome = evaluateLoopContextDiscipline({
      adapter: { getName: () => 'copilot-acp', getCopilotUsage: () => ({ compactions: 1, postCompactionTokens: tokens, tokenLimit: 1000 }) },
      enabled: false, resetAtUtilization: 0.95, cumulativeTokens: 9000000, alreadyNotifiedUnavailable: false,
    });
    expect(outcome.decision.recycle).toBe(recycle);
    if (recycle) expect(outcome.decision.utilization).toBe(0.901);
  });
  it('does not recycle another provider or a merely large billing counter', () => {
    for (const adapter of [
      { getName: () => 'claude-cli', getCopilotUsage: () => ({ compactions: 1, postCompactionTokens: 990, tokenLimit: 1000 }) },
      { getName: () => 'copilot-acp', getCopilotUsage: () => ({ compactions: 0, premiumRequests: 1000000 }) },
    ]) expect(evaluateLoopContextDiscipline({ adapter, enabled: false, resetAtUtilization: 0.95,
      cumulativeTokens: 9000000, alreadyNotifiedUnavailable: false }).decision.recycle).toBe(false);
  });
});
