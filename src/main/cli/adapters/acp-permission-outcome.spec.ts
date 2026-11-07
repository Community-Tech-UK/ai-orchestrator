import { describe, expect, it } from 'vitest';
import type { AcpPermissionOption } from '../../../shared/types/cli.types';
import { selectAcpPermissionOutcome } from './acp-permission-outcome';

// The option set from acp-cli-adapter.permission-resolved.spec.ts: an "allow" kind named "Allow"
// sits first, so any label-substring shortcut lands on the lasting grant.
const options: AcpPermissionOption[] = [
  { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject-always', name: 'Always reject', kind: 'reject_always' },
  { optionId: 'reject-once', name: 'Reject once', kind: 'reject_once' },
];
const pick = (reply: string) => selectAcpPermissionOutcome(options, reply);
const selected = (optionId: string) => ({ outcome: 'selected', optionId });

describe('selectAcpPermissionOutcome typed replies', () => {
  it('never lets a refusal land on an allow option just because it contains "allow"', () => {
    for (const reply of ['no, do not allow', "don't allow", 'do not allow this', 'not allowed', 'never allow', 'no thanks']) {
      expect(pick(reply), reply).toEqual(selected('reject-once'));
    }
  });

  it('never lets a one-time assent land on the lasting grant', () => {
    for (const reply of ['please allow this once', 'yes, allow it', 'yes', 'y', 'allow', 'approve', 'grant this', 'ok, go ahead']) {
      expect(pick(reply), reply).toEqual(selected('once'));
    }
  });

  it('prefers the lasting option only for explicit lasting wording', () => {
    for (const reply of ['always allow', 'allow always', 'yes, allow forever', 'please always approve']) {
      expect(pick(reply), reply).toEqual(selected('allow_always'));
    }
  });

  it('prefers the once option when the reply says once, even with lasting wording', () => {
    expect(pick('allow always, but just once')).toEqual(selected('once'));
  });

  it('keeps exact ids and single-word refusals working', () => {
    expect(pick('allow_always')).toEqual(selected('allow_always'));
    expect(pick('reject-once')).toEqual(selected('reject-once'));
    for (const reply of ['no', 'n', 'deny', 'reject', 'decline', 'stop']) {
      expect(pick(reply), reply).toEqual(selected('reject-once'));
    }
  });

  it('matches the agent\'s own option names as whole words after the user words', () => {
    expect(pick('Allow once')).toEqual(selected('once'));
    expect(pick('Always reject')).toEqual(selected('reject-always'));
    expect(pick('Reject once')).toEqual(selected('reject-once'));
  });

  it('treats question-style replies as non-consent even when they contain assent words', () => {
    for (const reply of ['what does this do?', 'please explain', 'yes, what does this do?', 'can you explain before you allow?', 'allow it? not sure', 'maybe', 'why is it deleting?']) {
      expect(pick(reply), reply).toEqual(selected('reject-once'));
    }
  });

  it('cancels empty replies and unadvertised cancel text', () => {
    expect(pick('')).toEqual({ outcome: 'cancelled' });
    expect(pick('cancel')).toEqual({ outcome: 'cancelled' });
    expect(pick('CANCEL')).toEqual({ outcome: 'cancelled' });
    expect(pick('please stop')).toEqual(selected('reject-once'));
  });

  it('matches explicit labels with polite wording, without guessing from surrounding prose', () => {
    for (const reply of ['run sandboxed', 'run sandboxed please', 'please run sandboxed']) {
      expect(selectAcpPermissionOutcome([...options, { optionId: 'sandbox', name: 'Run sandboxed', kind: 'other' }], reply), reply)
        .toEqual(selected('sandbox'));
    }
    for (const reply of ['I need sandboxing support first', 'run sandboxed if safe']) {
      expect(selectAcpPermissionOutcome([...options, { optionId: 'sandbox', name: 'Run sandboxed', kind: 'other' }], reply), reply)
        .toEqual(selected('reject-once'));
    }
  });

  it('treats ambiguous replies as non-consent and keeps an always-only agent working', () => {
    expect(pick('do whatever is safe')).toEqual(selected('reject-once'));
    const alwaysOnly: AcpPermissionOption[] = [{ optionId: 'always', name: 'Always allow', kind: 'allow_always' }];
    expect(selectAcpPermissionOutcome(alwaysOnly, 'yes')).toEqual(selected('always'));
    expect(selectAcpPermissionOutcome(alwaysOnly, 'no, do not allow')).toEqual({ outcome: 'cancelled' });
    expect(selectAcpPermissionOutcome(alwaysOnly, 'please explain')).toEqual({ outcome: 'cancelled' });
    expect(selectAcpPermissionOutcome(alwaysOnly, 'allow')).toEqual(selected('always'));
  });

  it('selects a numeric option id only when it is the actual answer', () => {
    const numericOptions: AcpPermissionOption[] = [{ optionId: '71', name: 'Always allow', kind: 'allow_always' }];
    expect(selectAcpPermissionOutcome(numericOptions, '71')).toEqual(selected('71'));
    expect(selectAcpPermissionOutcome(numericOptions, 'please explain')).toEqual({ outcome: 'cancelled' });
  });

  it('preserves an exact advertised label whose words also occur in refusal or question heuristics', () => {
    const advertised: AcpPermissionOption[] = [
      { optionId: 'remember', name: "Yes, and don't ask again", kind: 'allow_always' },
      { optionId: 'review', name: 'Review first', kind: 'other' },
      { optionId: 'never', name: 'Never ask again', kind: 'reject_always' },
      { optionId: 'later', name: 'Not now', kind: 'other' },
      { optionId: 'explain', name: 'Stop and explain', kind: 'other' },
      ...options,
    ];
    expect(selectAcpPermissionOutcome(advertised, "Yes, and don't ask again")).toEqual(selected('remember'));
    expect(selectAcpPermissionOutcome(advertised, 'Review first')).toEqual(selected('review'));
    expect(selectAcpPermissionOutcome(advertised, 'Never ask again')).toEqual(selected('never'));
    expect(selectAcpPermissionOutcome(advertised, 'Not now')).toEqual(selected('later'));
    expect(selectAcpPermissionOutcome(advertised, 'Stop and explain')).toEqual(selected('explain'));
  });

  it('never grants from a refusal even when an allow option has a contradictory refusal label', () => {
    for (const name of ["Don't allow", 'Never allow', 'Please do not allow']) {
      expect(selectAcpPermissionOutcome([{ optionId: 'contradictory', name, kind: 'allow_always' }, ...options], name), name)
        .toEqual(selected('reject-once'));
    }
  });

  it.each([
    ['What does this do', 'allow_once'],
    ['Explain this command', 'allow_once'],
    ['Please explain', 'allow_once'],
    ['Yes, what does this do', 'allow_once'],
    ['Allow, please explain', 'allow_always'],
    ['I refuse to allow', 'allow_always'],
    ['Yes, why is this needed', 'allow_always'],
    ['Allow, what will happen', 'allow_always'],
    ['May I approve this', 'allow_once'],
    ['I do not consent', 'allow_once'],
    ['I cannot agree', 'allow_once'],
    ['I am uncertain', 'allow_once'],
    ['I have not decided', 'allow_once'],
    ['My answer is no', 'allow_once'],
    ['Please clarify', 'allow_once'],
    ['Yes, tell me more', 'allow_once'],
    ["I don't want to allow this", 'allow_always'],
    ['I am not willing to approve this', 'allow_once'],
    ['I am not going to authorize this', 'allow_once'],
    ["I wouldn't allow this", 'allow_once'],
    ['I shouldn’t approve this', 'allow_once'],
    ["I couldn't grant permission", 'allow_once'],
    ["I didn't agree to this", 'allow_once'],
    ["I haven't agreed", 'allow_once'],
    ["I shan't authorize this", 'allow_once'],
    ["That isn't approved", 'allow_once'],
    ["I mustn't permit this", 'allow_once'],
    ['I wouldnt allow this', 'allow_once'],
    ['I havent agreed', 'allow_once'],
    ['Unable to allow this', 'allow_once'],
    ['I am unwilling to approve this', 'allow_once'],
    ['I am incapable of granting this', 'allow_once'],
    ['I am unprepared to authorize this', 'allow_once'],
    ['I am unready to consent', 'allow_once'],
    ['I am reluctant to allow this', 'allow_once'],
    ['I am hesitant to agree', 'allow_once'],
    ['I am opposed to granting this', 'allow_once'],
    ['I am against allowing this', 'allow_once'],
    ['I am disinclined to approve this', 'allow_once'],
    ['I disallow this', 'allow_once'],
    ['I disapprove of this', 'allow_once'],
    ['I forbid this', 'allow_once'],
    ['I prohibit this', 'allow_once'],
    ['I withhold consent', 'allow_once'],
    ['I refrain from allowing this', 'allow_once'],
    ['I veto this', 'allow_once'],
    ['I am not approving this', 'allow_once'],
    ['I am not authorizing this', 'allow_once'],
    ['Unable', 'allow_once'],
    ['I am unable to give approval', 'allow_once'],
    ['I abstain from allowing this', 'allow_once'],
    ['Please hold off allowing this', 'allow_once'],
    ['When tests pass, do not allow this', 'allow_once'],
    ['Allow if safe, but I refuse', 'allow_once'],
    ['When can I allow this, yes', 'allow_once'],
    ['Allow\nWhat will happen', 'allow_once'],
    ['Allow. What will happen', 'allow_once'],
    ['Maybe allow', 'allow_once'],
    ["I don't allow this", 'allow_once'],
    ['Allow once', 'allow_always'],
    ['Allow this time only', 'allow_always'],
  ] as const)('never grants from the ambiguous or contradictory allow label %j', (name, kind) => {
    const advertised: AcpPermissionOption[] = [{ optionId: 'contradictory-label', name, kind }, ...options];
    expect(selectAcpPermissionOutcome(advertised, name)).toEqual(selected('reject-once'));
    expect(selectAcpPermissionOutcome(advertised, 'contradictory-label')).toEqual(selected('contradictory-label'));
  });

  it('preserves an affirmative label and a separate advertised explanation choice', () => {
    const advertised: AcpPermissionOption[] = [
      { optionId: 'first', name: 'Allow this first', kind: 'allow_once' },
      { optionId: 'explanation', name: 'Explain this command', kind: 'other' },
      { optionId: 'session', name: 'Allow for this session', kind: 'allow_always' },
      ...options,
    ];
    expect(selectAcpPermissionOutcome(advertised, 'Allow this first')).toEqual(selected('first'));
    expect(selectAcpPermissionOutcome(advertised, 'Explain this command')).toEqual(selected('explanation'));
    expect(selectAcpPermissionOutcome(advertised, 'Allow for this session')).toEqual(selected('session'));
  });

  it('preserves a neutral agent choice that describes inability without granting permission', () => {
    expect(selectAcpPermissionOutcome([
      { optionId: 'unavailable', name: 'Unable to verify this', kind: 'other' }, ...options,
    ], 'Unable to verify this')).toEqual(selected('unavailable'));
  });

  it.each([
    ['allow_if_safe', 'Use the advertised approval', 'Allow if safe'],
    ['what_does_this_do', 'Use the advertised approval', 'What does this do'],
    ['allow_when_tests_pass', 'Use the advertised approval', 'Allow when tests pass'],
    ['limited', 'Allow one time', 'Allow one time'],
  ])('does not mistake prose for the explicit option id %j', (optionId, name, response) => {
    const advertised: AcpPermissionOption[] = [{ optionId, name, kind: 'allow_always' }, ...options];
    expect(selectAcpPermissionOutcome(advertised, response)).toEqual(selected('reject-once'));
    expect(selectAcpPermissionOutcome(advertised, optionId)).toEqual(selected(optionId));
  });

  it.each(['cancel', '✓', '#', ' spaced '])('keeps literal option ID %j selectable and a blank answer cancelled', optionId => {
    const advertised: AcpPermissionOption[] = [{ optionId, name: 'Allow once', kind: 'allow_once' }];
    expect(selectAcpPermissionOutcome(advertised, optionId)).toEqual(selected(optionId));
    expect(selectAcpPermissionOutcome(advertised, ' ')).toEqual({ outcome: 'cancelled' });
  });

  it('preserves clear ordinary assent including an explicit once or always qualifier', () => {
    for (const reply of ['yes once', 'yes just once', 'ok thanks', 'sounds good', 'approved', 'allowed']) {
      expect(pick(reply), reply).toEqual(selected('once'));
    }
    expect(pick('yes always')).toEqual(selected('allow_always'));
  });

  it.each([
    ['I approve this', 'once'],
    ['I allow this', 'once'],
    ['I grant this', 'once'],
    ['I accept this', 'once'],
    ['Yes, I approve this', 'once'],
    ['I approve this once', 'once'],
    ['I always approve this', 'allow_always'],
    ['I approve this always', 'allow_always'],
    ['I might approve this', 'reject-once'],
    ['I would approve this', 'reject-once'],
    ['I approve this if safe', 'reject-once'],
    ['I approve this?', 'reject-once'],
    ['I do not approve this', 'reject-once'],
    ['I approved this yesterday', 'reject-once'],
  ])('requires a complete affirmative first-person reply %j', (reply, optionId) => {
    expect(pick(reply)).toEqual(selected(optionId));
  });

  it.each([
    ['if-safe', 'Allow if safe'],
    ['after-tests', 'Allow when tests pass'],
    ['after-review', 'Allow contingent upon review'],
    ['bounded', 'Allow, but not forever'],
    ['session', 'Allow for this session'],
    ['after-tests-leading', 'When tests pass, allow this operation'],
    ['not-running', 'When tests are not running, allow this operation'],
    ['requested', 'Allow what I requested'],
    ['was-requested', 'Allow what was requested'],
    ['unable-condition', 'Allow if I am unable to run tests'],
    ['cannot-condition', 'When I cannot run tests, allow this operation'],
    ['after-rejection', 'Allow after I reject the preview'],
  ])('preserves offered scoped choice %j without inventing it from ordinary prose', (optionId, name) => {
    expect(pick(name)).toEqual(selected('reject-once'));
    expect(selectAcpPermissionOutcome([{ optionId, name, kind: 'allow_always' }, ...options], name)).toEqual(selected(optionId));
  });

  it.each(['Proceed with this choice', 'Allow'])('never guesses between duplicate advertised labels %j', name => {
    const advertised: AcpPermissionOption[] = [
      { optionId: 'approve-choice', name, kind: 'allow_always' },
      { optionId: 'reject-choice', name, kind: 'reject_once' },
    ];
    expect(selectAcpPermissionOutcome(advertised, name)).toEqual(selected('reject-choice'));
    expect(selectAcpPermissionOutcome(advertised, 'approve-choice')).toEqual(selected('approve-choice'));
  });
});
