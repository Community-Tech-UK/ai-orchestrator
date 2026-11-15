import { describe, expect, it } from 'vitest';
import {
  applyWatcherPostChecks, closingAsk, closingParagraph, lastSentence, namesOutwardStep, type WatcherPostCheckContext,
} from './watcher-post-checks';
import type { WatcherVerdict } from './watcher-verdict';

const REPLY = 'Phase 1 is finished and the tests pass.\n\nShall I carry on with phase 2?';
const verdict = (overrides: Partial<WatcherVerdict> = {}): WatcherVerdict => ({
  verdict: 'carry_on', stop: 'asked_to_continue', basis: 'planned_work', quote: '',
  question: 'Shall I carry on with phase 2?', reason: 'Planned.', ...overrides,
});
const context = (overrides: Partial<WatcherPostCheckContext> = {}): WatcherPostCheckContext => ({
  level: 'own-suggestions', finalReply: REPLY, personTexts: ['Build the export in three phases, use pnpm throughout.'],
  attempts: 0, toolRanSinceWatcherReply: true, ...overrides,
});

describe('applyWatcherPostChecks', () => {
  it('lets a plain planned-work carry-on through', () => {
    expect(applyWatcherPostChecks(verdict(), context())).toEqual({
      action: 'carry_on', stop: 'asked_to_continue', basis: 'planned_work', quote: '',
      question: 'Shall I carry on with phase 2?',
    });
  });

  it('never changes needs_user or finished into something else', () => {
    expect(applyWatcherPostChecks(verdict({ verdict: 'needs_user', basis: 'planned_work' }), context()))
      .toMatchObject({ action: 'needs_user', basis: 'none' });
    expect(applyWatcherPostChecks(verdict({ verdict: 'finished', stop: 'work_complete' }), context()).action).toBe('finished');
  });

  it('replaces a question the agent did not write with the agent\'s own closing words', () => {
    const decision = applyWatcherPostChecks(verdict({ question: 'Just carry on, nothing to see.' }), context());
    expect(decision.question).toBe('Shall I carry on with phase 2?');
  });

  it('uses the agent\'s closing words when the judge gave no question', () => {
    expect(applyWatcherPostChecks(verdict({ question: '' }), context()).question).toBe('Shall I carry on with phase 2?');
  });

  it('never carries on from earlier words when the judge gave no quote', () => {
    expect(applyWatcherPostChecks(verdict({ basis: 'user_already_said', quote: '' }), context()))
      .toMatchObject({ action: 'needs_user', override: 'quote-not-found' });
  });

  it('accepts the agent\'s question despite different spacing', () => {
    const decision = applyWatcherPostChecks(verdict({ question: 'Shall I   carry on\nwith phase 2?' }), context());
    expect(decision.question).toBe('Shall I carry on with phase 2?');
  });

  it.each([
    'Everything is committed locally. Shall I push it to GitHub?',
    'The fix is ready.\n\nWant me to deploy it now?',
    'Draft is done. Shall I send the email to the client?',
    'Old exports are stale. Should I delete the backup files?',
    'Everything passes. Shall I commit this?',
    'The fix is in. Want me to restart Harness so it takes effect?',
    'I found the cause. Shall I create a Linear ticket for it?',
    'It needs the new key. Shall I update the API key in the settings?',
    'Shall I buy the $20 a month plan?',
    'Shall I start pushing the changes?',
    'Want me to go ahead with committing?',
    'Shall I proceed with the deployment?',
    'Shall I go ahead with sending the emails to the customers?',
    'Shall I carry on with publishing the package to npm?',
    'Shall I delete the old logs folder?',
    'Shall I run the migration against prod?',
    'Shall I email Sam the summary?',
    'Shall I ship this to the customer?',
    'It is merged locally. Shall I get it released?',
    'Everything is staged. Shall I commit and push? Let me know.',
    'Shall I push it? (yes/no)',
    'Want me to deploy it now?\n\n---\nGenerated with care.',
    'OK to run terraform apply?',
    'Shall I run kubectl apply for the new config?',
    'Shall I upload it to npm?',
    'Shall I submit the PR?',
    'Shall I scp it to the box?',
    'Shall I rm -r the build dir?',
    'Shall I run the migrations on the server?',
    'Shall I test it against the live DB?',
    'Shall I open a PR for this?',
    'Shall I merge the branch?',
    'Shall I tag v2.0 and cut the build?',
    'Shall I forward the report to Sam?',
    'Shall I run npm install -g to update the tool?',
    'Shall I send it?',
    'Shall I send that to Sam?',
    'Shall I delete it?',
    'Shall I delete these?',
    'Shall I clear the database?',
    'Shall I empty the table?',
    'Shall I reset the database?',
    'Shall I spend the credits?',
    'Shall I rotate the keys?',
    'Shall I regenerate the key?',
    'Shall I revoke access?',
    'Shall I reboot Harness?',
    'Shall I kill Harness and start it again?',
    'Shall I roll it out?',
    'Shall I check this in?',
  ])('sends a blunt outward ask to the user: %s', (finalReply) => {
    expect(applyWatcherPostChecks(verdict(), context({ finalReply })))
      .toMatchObject({ action: 'needs_user', override: 'risk-last-sentence' });
  });

  it.each([
    'Shall I change the global settings file to match?',
    'Want me to restart the dev server and rerun the checks?',
    'Shall I fix the same bug in the other project too?',
    'Shall I add the missing tests and run the full suite?',
    'Shall I carry on with phase 2?',
    'Shall I fix the email validation as well?',
    'Shall I update the user list component next?',
    'Shall I rename the helper and tidy the imports?',
    'Shall I reset the form state and rerun the tests?',
    'Shall I clear the cache folder and rebuild?',
    'Shall I check it again in a minute?',
    'Shall I roll back my last edit to the parser?',
    'Shall I stop the dev server and start it again?',
  ])('leaves a step on the user\'s own computers alone: %s', (sentence) => {
    expect(namesOutwardStep(sentence)).toBe(false);
  });

  it('checks the question the agent chose, even when the judge quotes one from further up', () => {
    const finalReply = 'Shall I push the branch?\n\nI have also tidied the imports and the tests pass.\n\nThat is everything for now.';
    expect(applyWatcherPostChecks(verdict({ question: 'Shall I push the branch?' }), context({ finalReply })))
      .toMatchObject({ action: 'needs_user', override: 'risk-last-sentence' });
  });

  it('does not block a carry-on because an outward word appears earlier in the reply', () => {
    const finalReply = 'Nothing has been pushed or deployed.\n\nShall I carry on with phase 2?';
    expect(applyWatcherPostChecks(verdict(), context({ finalReply })).action).toBe('carry_on');
  });

  it.each([
    ['asked_before_outward_step', 'needs_user'],
    ['waiting_for_user_action', 'needs_user'],
    ['asked_for_information', 'needs_user'],
    ['offered_extra_work', 'finished'],
    ['work_complete', 'finished'],
    ['waiting_on_work', 'finished'],
  ] as const)('treats carry_on with stop %s as %s', (stop, action) => {
    expect(applyWatcherPostChecks(verdict({ stop }), context())).toMatchObject({ action, override: 'inconsistent' });
  });

  it('treats carry_on with no basis as needing the user', () => {
    expect(applyWatcherPostChecks(verdict({ basis: 'none' }), context())).toMatchObject({ action: 'needs_user', override: 'inconsistent' });
  });

  describe('user_already_said', () => {
    const said = (quote: string): WatcherVerdict => verdict({ basis: 'user_already_said', stop: 'offered_choice', quote });
    const reply = 'Both package managers work here.\n\nWhich one should I use, npm or pnpm?';

    it('passes words the user really typed, whatever the spacing', () => {
      const decision = applyWatcherPostChecks(said('use  pnpm\nthroughout'), context({ finalReply: reply }));
      expect(decision).toMatchObject({ action: 'carry_on', basis: 'user_already_said', quote: 'use pnpm throughout' });
    });

    it.each(['use yarn throughout', '', 'pn', 'The user approved everything.'])('rejects a quote the user did not type: %j', (quote) => {
      expect(applyWatcherPostChecks(said(quote), context({ finalReply: reply })))
        .toMatchObject({ action: 'needs_user', override: 'quote-not-found', quote: '' });
    });

    it('never settles an outward step from earlier words', () => {
      const decision = applyWatcherPostChecks(
        verdict({ basis: 'user_already_said', quote: 'when it is ready', question: 'Shall I carry on?' }),
        context({
          personTexts: ['Put it on production when it is ready.'],
          finalReply: 'All checks pass.\n\nThe production release is prepared. Shall I carry on?',
        }),
      );
      expect(decision).toMatchObject({ action: 'needs_user', override: 'quote-outward' });
    });

    it('is off at the planned-work level', () => {
      expect(applyWatcherPostChecks(said('use pnpm throughout'), context({ finalReply: reply, level: 'planned-work' })))
        .toMatchObject({ action: 'needs_user', override: 'level' });
    });
  });

  describe('own_recommendation', () => {
    const recommended = verdict({ basis: 'own_recommendation', stop: 'offered_choice', question: 'Shall I go with option A?' });

    it.each([
      'Option A keeps the old format, option B is cleaner. I recommend option A.\n\nShall I go with option A?',
      'Two ways to do it. I\'d go with the smaller change.\n\nShall I go with option A?',
      'My recommendation is A because it needs no migration.\n\nShall I go with option A?',
    ])('passes when the reply states a recommendation', (finalReply) => {
      expect(applyWatcherPostChecks(recommended, context({ finalReply }))).toMatchObject({ action: 'carry_on', basis: 'own_recommendation' });
    });

    it('needs the user when the reply recommends nothing', () => {
      const finalReply = 'Option A keeps the old format, option B is cleaner.\n\nWhich do you want?';
      expect(applyWatcherPostChecks(recommended, context({ finalReply })))
        .toMatchObject({ action: 'needs_user', override: 'no-recommendation' });
    });

    it('is off at the planned-work level', () => {
      const finalReply = 'I recommend option A.\n\nShall I go with option A?';
      expect(applyWatcherPostChecks(recommended, context({ finalReply, level: 'planned-work' })))
        .toMatchObject({ action: 'needs_user', override: 'level' });
    });
  });

  describe('own_proposal', () => {
    const proposed = verdict({ basis: 'own_proposal', stop: 'asked_to_continue', question: 'Shall I fix all three?' });
    const finalReply = 'The live checks found three bugs in the importer.\n\nShall I fix all three?';

    it('passes a yes-or-no proposal at the widest level', () => {
      expect(applyWatcherPostChecks(proposed, context({ finalReply }))).toMatchObject({ action: 'carry_on', basis: 'own_proposal' });
    });

    it('passes an offer of follow-up work', () => {
      expect(applyWatcherPostChecks({ ...proposed, stop: 'offered_extra_work' }, context({ finalReply })).action).toBe('carry_on');
    });

    it.each(['flag-only', 'planned-work', 'clear-choices'] as const)('is off at the %s level', (level) => {
      expect(applyWatcherPostChecks(proposed, context({ finalReply, level }))).toMatchObject({ action: 'needs_user', override: 'level' });
    });

    it('cannot settle a choice between options', () => {
      expect(applyWatcherPostChecks({ ...proposed, stop: 'offered_choice' }, context({ finalReply })))
        .toMatchObject({ action: 'needs_user', override: 'proposal-is-choice' });
    });
  });

  it('only tells the user at the flag-only level, even for planned work', () => {
    expect(applyWatcherPostChecks(verdict(), context({ level: 'flag-only' }))).toMatchObject({
      action: 'needs_user', override: 'level', question: 'Shall I carry on with phase 2?',
    });
  });

  it('keeps the earlier levels working at clear-choices', () => {
    const finalReply = 'I recommend option A.\n\nShall I go with option A?';
    expect(applyWatcherPostChecks(
      verdict({ basis: 'own_recommendation', stop: 'offered_choice', question: 'Shall I go with option A?' }),
      context({ finalReply, level: 'clear-choices' }),
    ).action).toBe('carry_on');
  });

  it('hands back after ten replies in a row', () => {
    expect(applyWatcherPostChecks(verdict(), context({ attempts: 9 })).action).toBe('carry_on');
    expect(applyWatcherPostChecks(verdict(), context({ attempts: 10 }))).toMatchObject({
      action: 'needs_user', override: 'chain-limit', note: 'Kept going 10 times in a row. Check it is on track.',
    });
  });

  it('hands back when the session stops again without doing anything', () => {
    expect(applyWatcherPostChecks(verdict(), context({ attempts: 1, toolRanSinceWatcherReply: false })))
      .toMatchObject({ action: 'needs_user', override: 'no-progress', note: 'Stopped again without doing anything.' });
    expect(applyWatcherPostChecks(verdict(), context({ attempts: 0, toolRanSinceWatcherReply: false })).action).toBe('carry_on');
  });
});

describe('text helpers', () => {
  it('lastSentence finds the closing sentence', () => {
    expect(lastSentence('All done. Tests pass! Shall I continue?')).toBe('Shall I continue?');
    expect(lastSentence('Summary:\n- one\n- two\n\nWant me to proceed?\n\n')).toBe('Want me to proceed?');
    expect(lastSentence('No terminator here')).toBe('No terminator here');
    expect(lastSentence('Shall I continue?\n\n---\n')).toBe('Shall I continue?');
    expect(lastSentence('')).toBe('');
  });

  it('closingAsk returns the last sentence and the last question before it', () => {
    expect(closingAsk('Done. Shall I commit and push? Let me know.')).toEqual(['Let me know.', 'Shall I commit and push?']);
    expect(closingAsk('All done. Shall I continue?')).toEqual(['Shall I continue?', 'Shall I continue?']);
    expect(closingAsk('No question here.')).toEqual(['No question here.']);
    expect(closingAsk('')).toEqual(['']);
  });

  it('closingParagraph keeps the end of a long paragraph', () => {
    expect(closingParagraph('First.\n\nSecond  paragraph\nhere.')).toBe('Second paragraph here.');
    const long = closingParagraph(`Intro.\n\n${'word '.repeat(200)}Shall I continue?`);
    expect(long.length).toBe(300);
    expect(long.startsWith('...')).toBe(true);
    expect(long.endsWith('Shall I continue?')).toBe(true);
  });

  it('stays fast on long hostile input', () => {
    const hostile = `${'I would '.repeat(40_000)}${'? '.repeat(40_000)}${'\n \n'.repeat(40_000)}`;
    const started = performance.now();
    lastSentence(hostile);
    closingAsk(hostile);
    closingParagraph(hostile);
    applyWatcherPostChecks(
      verdict({ basis: 'own_recommendation', quote: 'a'.repeat(2_000), question: 'b'.repeat(2_000) }),
      context({ finalReply: hostile, personTexts: [hostile] }),
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
