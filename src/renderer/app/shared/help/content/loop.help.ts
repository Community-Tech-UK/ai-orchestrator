import type { HelpEntry } from '../help-content.types';

/** Describes the current engine. Refresh finish rules when Phase 2 changes them. */
export const LOOP_MODE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout', variant: 'info', heading: 'Loop Mode',
      body: 'Loop Mode keeps an agent working towards a goal until its checks pass, a limit is reached or you stop it. There is no token or cost limit unless you set one. Round and time limits still apply.',
    },
    {
      kind: 'list', heading: 'Same session vs fresh child',
      items: [
        'Same session keeps one conversation going between rounds where the provider supports it. When it gets full, supported providers can start a fresh conversation with a summary.',
        'Fresh child starts a new conversation each round and reloads progress from files. Gemini and Antigravity use this approach even when same session is selected.',
      ],
    },
    {
      kind: 'list', heading: 'When the loop stops',
      items: [
        'Finish by reviews requires consecutive clean self-reviews with no new work changes. Configured checks and any enabled independent review must pass too.',
        'Finish by checks looks for completion evidence, runs the check command and requires a plan rename if configured. The recipe and work stages apply to this mode.',
        'Back-and-forth review asks a second model to check each completion claim until it agrees. A repeated-tool warning means the agent keeps calling the same tools, which is a different problem.',
        'A round or time limit may allow one final tidy-up round to write hand-off notes, only when enabled and the provider can restrict tools for that round. Currently this is supported by Claude. A token or cost limit stops the loop straight away.',
        'When no progress is detected, Harness can ask the agent to change approach. Attempts are limited; if they fail, the loop pauses or stops according to its settings.',
        'If a failed attempt already changed files, or Harness cannot tell whether it did, the loop pauses for your review. Trying again could make things worse. That is not the loop being stuck.',
      ],
    },
    {
      kind: 'list', heading: 'State files',
      items: [
        'OUTSTANDING.md holds questions and work that needs your input.',
        'LOOP_TASKS.md records the work and its progress. Finishing a check does not by itself close every item.',
        'A separate working copy may need its dependencies installed before tests can run. Inspect the failure before deciding the agent’s work is wrong.',
      ],
    },
    { kind: 'callout', variant: 'tip', heading: 'Check before resuming', body: 'Read the pause reason and inspect the work. A review pause can protect changes that would be unsafe to repeat.' },
  ],
};
