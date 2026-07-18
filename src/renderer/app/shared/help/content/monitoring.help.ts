/**
 * Help & tips content - Monitoring group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const SUPERVISION_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Monitors active orchestration tree nodes, task health, and circuit-breaker states. The page refreshes automatically every few seconds.',
    },
    {
      kind: 'list',
      heading: 'What you see',
      items: [
        'Totals: nodes, running, failed, and active workers.',
        'A tree view of node hierarchy and relationships.',
        'Circuit-breaker states (open, half-open, closed) with failure counts.',
        'A live event stream of supervision changes.',
      ],
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Click Refresh to reload all data immediately.',
        'Select a node in the tree, then Escalate to hand a failure upward.',
        'Watch the live events panel for recent state changes.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Open breakers mean repeated failures',
      body: 'An open circuit breaker indicates a node keeps failing. Check its logs and root cause before escalating manually.',
    },
  ],
};

export const VERIFICATION_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Runs cross-model verification: two or more CLIs answer the same prompt and a synthesis strategy reconciles the results.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select at least two agents from the available CLIs.',
        'Choose a synthesis strategy.',
        'Optionally set a working directory or drop files for context.',
        'Enter your prompt and start verification.',
        'Open a recent session below to review results.',
      ],
    },
    {
      kind: 'list',
      heading: 'Synthesis strategies',
      items: [
        'Consensus: keeps only statements all agents agree on.',
        'Debate: agents critique each other over multiple rounds.',
        'Best-of: picks the single best response.',
        'Merge: combines the best parts of each response.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Give it context',
      body: 'Drop files onto the prompt area or select a working directory. Preflight checks run automatically when a directory is selected.',
    },
  ],
};

export const STATS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Usage analytics: session counts, message volumes, token consumption, and cost breakdowns over a chosen period, with charts for message distribution and tool usage.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Pick a period: Day, Week, Month, Year, or All.',
        'Review the metric cards for sessions, messages, tokens, and cost.',
        'Check the charts for distribution and tool usage patterns.',
        'Use Export to save the data as JSON for external analysis.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Start with the Week view',
      body: 'Week reflects typical usage patterns; switch to Month or Year for trends. Storage usage sits at the bottom right.',
    },
  ],
};

export const COST_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Tracks provider spend across all API calls, shows cost trends and per-model breakdowns, and enforces optional daily, weekly, and monthly budget limits with alerts.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Review the metric cards for total cost, tokens, and requests.',
        'Check budget bars for current spend against each limit.',
        'Set limits in the bottom form and click Save to enable alerts.',
        'Use the line chart for cost over time and the donut for cost by model.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Budget limits',
          value: 'Set at least a monthly limit',
          why: 'You get a warning at 80% and an urgent alert past the limit, before the bill surprises you.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Blank means no limit',
      body: 'Leaving a limit field empty disables that alert entirely; spend is still tracked.',
    },
  ],
};

export const REPLAY_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Inspect, replay, and share past sessions. Load from a live instance, an archived history entry, or a saved JSON bundle, then review messages, artefacts, and snapshots before replaying locally.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Click Load Bundle to open a saved JSON file, or arrive here from history.',
        'Review the source info and warnings.',
        'Set a local working directory for the replay.',
        'Click Replay Bundle Locally to restore the session with a fresh agent.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Share safely',
      body: 'Save Redacted Bundle exports a clean copy with credentials and sensitive data stripped, suitable for sharing.',
    },
    {
      kind: 'list',
      heading: 'What you can inspect',
      items: [
        'Messages: the full transcript with timestamps.',
        'Artefacts: code and structured output captured in the session.',
        'Attachments: files and images included in the session.',
        'Snapshots: continuity checkpoints and file snapshots.',
      ],
    },
  ],
};

export const SECURITY_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Audit access logs, scan content for exposed secrets, validate environment variables, and configure bash command allowlists and blocklists.',
    },
    {
      kind: 'list',
      heading: 'Tabs',
      items: [
        'Audit: timestamped action logs filtered by severity; export to CSV.',
        'Scanner: paste content to detect or redact secrets before sharing.',
        'Environment: view safe variables and test whether one is allowed.',
        'Bash: validate command risk and manage allowed/blocked patterns.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Scanning is not foolproof',
      body: 'The scanner catches common secret patterns, not everything. Manually review and use Redact before sharing content externally.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Bash rules match the full command',
      body: 'Allowed and Blocked patterns are matched against the whole command line, so be as specific as possible.',
    },
  ],
};

export const LOGS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'View application logs in real time, filter by severity and subsystem, and run debug commands or diagnostics on demand.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Browse recent logs with the level and subsystem filters.',
        'Click the level pills to change the runtime log level.',
        'Switch to the Debug Panel tab for diagnostics and system info.',
        'Export logs to JSON or clear them from the filter bar.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Active log level',
          value: 'info',
          why: 'Debug level is noisy and slows the app; raise verbosity only while investigating.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Include system info in reports',
      body: 'The Debug Panel collects OS, node version, and memory details, which are useful when filing a bug.',
    },
  ],
};

export const WORKBOARD_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'One board that projects instances, loop runs, automation runs, and repository jobs into four attention lanes: Needs You, Working, Waiting, and Done / Idle. Related records collapse into a single card.',
    },
    {
      kind: 'list',
      heading: 'Lanes',
      items: [
        'Needs You: human input, permission, review, arbitration, or a failure needs attention.',
        'Working: execution is actively progressing.',
        'Waiting: queued, paused, hibernated, or rate-limited but resumable.',
        'Done / Idle: clean terminal work (last 24h) and available idle instances.',
      ],
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Check the Needs You lane first for anything urgent.',
        'Filter by workspace to focus on one project across every lane.',
        'Click a card to open its detail pane; instance-backed work reuses the full transcript and controls.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Cards at a glance',
      body: 'Each card shows the source, status, workspace, update time, progress, and badges for any related records grouped into it.',
    },
  ],
};

export const COMPARE_SPLIT_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Compares two agents side by side in a fixed 50/50 split. Pick a different instance for each pane and review their output streams in parallel.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Choose an instance in the left dropdown.',
        'Choose another in the right dropdown.',
        'Scroll each pane independently to compare responses.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Good for provider bake-offs',
      body: 'Run the same task on two different CLIs, then compare their approach, code quality, and reasoning here.',
    },
  ],
};
