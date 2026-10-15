export interface LoopEndDescriptionInput {
  status: string; endReason?: string | null; roundsFinished: number; endedAt: number | null;
  mergeHeld?: boolean; branch?: string;
}
const HEADLINES: Record<string, string> = {
  completed: 'Finished', 'completed-needs-review': 'Ended · see notes', 'attempt-failed': 'Stopped: a step failed',
  cancelled: 'Stopped by you', 'cost-exceeded': 'Stopped at the spending limit', error: 'Stopped by an error',
  failed: 'Stopped without finishing', 'no-progress': 'Stopped: no progress', 'provider-limit': "Stopped: the provider's usage limit",
  'needs-human-arbitration': 'Your call: the builder and the second model disagree',
  'reviewer-unreliable': 'Stopped: the second model kept failing', 'reviewer-unavailable': 'Stopped: no second model was available',
  'builder-unreliable': 'Stopped: it kept saying done without fixing the findings',
};

export function describeLoopEnd(input: LoopEndDescriptionInput): { headline: string; sentence: string } {
  const reason = input.endReason?.trim() ?? '';
  let headline = HEADLINES[input.status] ?? 'Loop ended';
  if (input.status === 'cap-reached') {
    const cap = /^cap=(iterations|cost|tokens|wall-time)/.exec(reason)?.[1];
    const rounds = /after\s+(\d+)\s+iteration/.exec(reason)?.[1];
    const dollars = /\$\d+(?:\.\d+)?/.exec(reason)?.[0];
    const label = cap === 'iterations' ? `${rounds ?? input.roundsFinished}-round` : cap === 'cost' ? dollars ?? 'spending'
      : cap === 'tokens' ? 'token' : cap === 'wall-time' ? 'time' : 'configured';
    headline = `Stopped at the ${label} limit before finishing`;
  }
  let sentence = reason;
  if (input.mergeHeld) sentence = 'Nothing was merged because a check was skipped. Merge it when you have looked.'
    + (input.branch ? ` The work is on branch ${input.branch}.` : '');
  else if (/signal=/.test(reason)) sentence = 'The agent said it was done and the checks passed.';
  else if (/cap=/.test(reason)) sentence = /no completion was attempted/.test(reason)
    ? "The agent hadn't said it was done yet." : 'The configured limit was reached before the work finished.';
  else if (reason === 'user cancelled') sentence = 'You stopped it.';
  else if (reason === 'app-restart') sentence = 'It paused when Harness restarted.';
  else if (reason) sentence = reason.split(/(?<=[.!?])\s+/)[0];
  else sentence = input.status === 'completed' ? 'The work finished and the checks passed.' : 'Open Details to review the result.';
  return { headline, sentence };
}
