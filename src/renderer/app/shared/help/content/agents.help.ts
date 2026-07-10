/**
 * Help & tips content - Agents group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const SKILLS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Discover skill bundles from configured paths, install them into memory, and match them against task descriptions. Each installed skill contributes reference and example content you can preview.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Update Discovery Paths to control where skills are searched for.',
        'Click Discover Skills to find available bundles.',
        'Click Install on a skill to load it into memory.',
        'Describe a task in Skill Matching and click Match Skills for recommendations.',
        'Click Details on an installed skill to preview its reference content.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Discovery paths are flexible',
      body: 'Separate paths with newlines or commas. Defaults cover .claude/skills, .codex/skills, and a skills folder in the current directory.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Matching shows confidence',
      body: 'Matched skills are ranked by relevance to your task description. Higher percentages indicate better fits.',
    },
  ],
};

export const REVIEWS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Run a code review session over chosen files using multiple review agents, track the issues they find, acknowledge them, and export results as markdown or JSON.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select an orchestrator instance from the dropdown.',
        'List file paths (one per line) or leave empty to review all changed files.',
        'Keep Diff Only on to review only changed lines.',
        'Tick or untick review agents in the strip, then click Start Session.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Issues are sorted for you',
      body: 'Critical and high-severity issues appear first, then medium, low, and info. Within each level, higher confidence ranks first.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Diff Only',
          value: 'On (default)',
          why: 'Focuses agents on actual changes and keeps review time and cost down.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Acknowledge to track resolution',
      body: 'Acknowledging an issue marks it as seen so you can tell triaged findings from new ones.',
    },
  ],
};

export const DOC_REVIEW_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'When an agent asks you to review a plan, spec, audit, or decision doc, it appears here as an interactive HTML document. Toggle Approve/Reject and add comments per section, set an overall verdict, and submit — your decisions go straight back to the agent as a message.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Pick a pending review from the list on the left.',
        'Read the document; toggle Approve or Reject and add comments per section.',
        'Set the overall verdict (Approve / Request changes / Reject).',
        'Click Submit decision — the agent receives your feedback and applies it to the Markdown source.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Prefer a full browser?',
      body: 'Open in browser shows the same artifact standalone, where Export decisions downloads a JSON file and copies a Markdown summary you can paste back to the agent.',
    },
  ],
};

export const SPECIALISTS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Recommends specialist agent personas for a task, spawns them in an orchestrator instance, and tracks their findings live with status and analysed files.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select an orchestrator instance from the dropdown.',
        'Describe your task in the Task Context field.',
        'Click Recommend to see specialists ranked by relevance.',
        'Click a specialist card to spawn an instance.',
        'Use the side panel to pause, resume, or complete running specialists.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Findings are live',
      body: 'The panel polls active instances every few seconds. Click a finding to expand its full details.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Relevance guides selection',
      body: 'Scores run 0 to 100 per cent; a higher score means a better fit for your task description. Failed instances show in red.',
    },
  ],
};

export const DEBATE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Runs a structured multi-agent debate where agents argue a question and converge on a consensus answer. You control the number of agents, rounds, and how strict agreement must be.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enter a question in the Query field, plus optional context.',
        'Set the number of agents (2 to 6) and maximum rounds (2 to 8).',
        'Adjust the convergence threshold (0.1 to 1.0).',
        'Click Start Debate, then select the debate chip to watch progress.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Threshold shapes debate length',
      body: 'A lower threshold (around 0.5) reaches consensus quickly; a higher one (0.9+) forces rigorous agreement and may hit the round limit.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Agents',
          value: '3',
          why: 'Enough diversity of argument without tripling cost for marginal benefit.',
        },
        {
          label: 'Convergence threshold',
          value: '0.7',
          why: 'A practical balance between speed and rigour for most questions.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Cancel discards partial results',
      body: 'Cancelling a debate stops it immediately and partial arguments are not synthesised into an answer.',
    },
  ],
};

export const ASK_COUNCIL_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Sends the same prompt to multiple AI providers in parallel and compares their answers side by side, with model, response time, and status per provider.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Type your prompt in the text area.',
        'Select which providers to ask (All and None buttons toggle quickly).',
        'Click Ask Council to fan the prompt out.',
        'Review answers and response times in the card grid.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Providers must be installed',
      body: 'Only installed CLIs appear in the list. If a provider is missing, install and sign in to its CLI first.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Failures do not block others',
      body: 'If one provider times out or errors, its card shows the error while the rest still answer. The summary counts successes.',
    },
  ],
};
