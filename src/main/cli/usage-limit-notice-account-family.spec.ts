/**
 * An OpenCode account is always a MiMo Token Plan account, so the allowance
 * message names "MiMo" and keeps the word out of the account's own label.
 * See `src/shared/display-names.ts` (`accountFamilyName`).
 */

import { describe, expect, it } from 'vitest';
import { buildUsageLimitNotice, buildUsageWarningNotice } from './usage-limit-notice';

const now = new Date(2026, 9, 20, 12).getTime();
const base = { provider: 'opencode', now, rawDetail: 'The provider said the plan is exhausted.' };

describe('usage-limit notices for an OpenCode (MiMo plan) account', () => {
  it('names the plan, not the tool', () => {
    expect(buildUsageLimitNotice({ ...base, allowance: 'weekly' }).content)
      .toContain('Your MiMo account has used its weekly allowance.');
  });

  it('puts the account\'s own name before MiMo, and does not repeat MiMo inside it', () => {
    const { content } = buildUsageLimitNotice({ ...base, account: 'MiMo Work', allowance: 'weekly' });
    expect(content).toContain('Your Work MiMo account has used its weekly allowance.');
    expect(content).not.toContain('MiMo Work MiMo');
  });

  it('does not strip "OpenCode" from a label, because the sentence never says "OpenCode"', () => {
    expect(buildUsageLimitNotice({ ...base, account: 'OpenCode Home', allowance: 'weekly' }).content)
      .toContain('Your OpenCode Home MiMo account has used its weekly allowance.');
  });

  it('says MiMo in the early warning too', () => {
    expect(buildUsageWarningNotice({ ...base, account: 'Work', allowance: 'weekly' }))
      .toContain('Your Work MiMo account is close to its weekly allowance.');
  });
});
