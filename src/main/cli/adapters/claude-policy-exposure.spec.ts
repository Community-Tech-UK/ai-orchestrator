import { afterEach, describe, expect, it } from 'vitest';
import { _setSettingsReaderForTesting } from './claude-env-pack';
import { claudePolicyExposure } from './claude-policy-exposure';
import { CLAUDE_HELPER_REVIEWER_RULE } from './claude-subagent-policy';

afterEach(() => _setSettingsReaderForTesting(null));

describe('Claude policy exposure record', () => {
  it('records the actual prompt and waiting-rule argv, with raw trial grouping', () => {
    _setSettingsReaderForTesting(() => 'trial');
    expect(claudePolicyExposure('session-a1', { trialKey: 'item-1', trialKeySource: 'plan-queue-item' },
      { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
      ['--append-system-prompt', CLAUDE_HELPER_REVIEWER_RULE,
        '--append-subagent-system-prompt-file', '/tmp/rule.txt'])).toMatchObject({
      setting: 'trial', arm: 'sonnet', applied: true, armKey: 'item-1', armSource: 'plan-queue-item',
      reviewerRuleDelivered: true, waitingRuleDelivered: true,
    });
  });

  it('does not claim reviewer or waiting-rule delivery on an omitted resume overlay', () => {
    _setSettingsReaderForTesting(() => 'trial');
    expect(claudePolicyExposure('session-aa', {}, {}, ['--resume', 'session-aa'])).toMatchObject({
      arm: 'same-as-session', applied: false, reviewerRuleDelivered: false, waitingRuleDelivered: false,
    });
  });
});
