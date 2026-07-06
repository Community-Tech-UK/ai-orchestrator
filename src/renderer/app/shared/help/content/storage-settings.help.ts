/**
 * Help & tips content - Storage group surfaces plus the settings-group pages
 * (Settings landing, Verification Settings, Models).
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const SETTINGS_SURFACE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Configures app behaviour, providers, and diagnostics. Each section has its own Help and tips panel like this one.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Finding your way',
      body: 'Use the search box to jump straight to any setting by name. Your last section reopens automatically next time you visit Settings.',
    },
    {
      kind: 'list',
      heading: 'Section groups',
      items: [
        'Everyday preferences: General, Display, Keyboard.',
        'Agent behaviour: Orchestration, Auxiliary Models, Cross-Model Review, Memory, Permissions.',
        'Workspace tools: Models, MCP Servers, Hooks, Worktrees, Snapshots, Archive, Ecosystem.',
        'Network & Remote: Network, Connections, Voice, Remote Nodes, Mobile, Remote Config.',
        'Health & Diagnostics: CLI Health, Doctor, Provider Quota, RTK Savings, Advanced.',
      ],
    },
  ],
};

export const SNAPSHOTS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Browse file snapshots captured during session execution, view diffs, and revert files to their snapshot state. Snapshots are grouped by session with storage metrics and evidence artefacts.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enter an instance ID and click Load Sessions.',
        'Select a session in the left panel to see its file snapshots.',
        'Select a snapshot to view its diff on the right.',
        'Use Revert File for one file or Revert Session for all of them.',
      ],
    },
    {
      kind: 'list',
      heading: 'Snapshot actions',
      items: [
        'Create: a new file was added during the session.',
        'Modify: an existing file was changed.',
        'Delete: a file was removed.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Reverts overwrite current files',
      body: 'Reverting replaces the current file content with the snapshot and cannot be undone. Check the diff first.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Cleanup purges old snapshots',
      body: 'The Cleanup button frees storage by deleting old snapshots. Review what you still need before running it.',
    },
  ],
};

export const ARCHIVE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Search, filter, and manage archived sessions. Tag them for organisation, inspect details, and restore or permanently delete records.',
    },
    {
      kind: 'steps',
      heading: 'How to filter',
      items: [
        'Type in the search box to match session IDs, notes, or tags.',
        'Click tag chips to filter by one or more tags.',
        'Set From and To dates to narrow the range.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Tags live in the detail drawer',
      body: 'Click an archive card to open its drawer, where you can add or remove tags and restore or delete the session.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Restore and delete both remove the archive entry',
      body: 'Restoring returns a session to active status and removes its archive record; deleting removes it permanently with no undo.',
    },
  ],
};

export const VERIFICATION_SETTINGS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Configures the verification subsystem: CLI tools, API keys, verification defaults, and advanced performance and caching options.',
    },
    {
      kind: 'list',
      heading: 'Tabs',
      items: [
        'CLI Tools: detect installed CLIs, set default models, timeouts, auto-approve.',
        'API Keys: authentication for each provider.',
        'Defaults: verification preferences and agent defaults.',
        'Advanced: parallel execution, caching, logging, and the danger zone.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Test connections first',
      body: 'Test Connection on each CLI card confirms it is installed and signed in. The status indicator shows the last result.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Default timeout',
          value: '300 seconds',
          why: 'Long enough for complex reasoning without hanging forever on a stuck CLI.',
        },
        {
          label: 'Max concurrent agents',
          value: '4',
          why: 'Good throughput without overloading the machine or provider quotas.',
        },
        {
          label: 'Cache duration',
          value: '3600 seconds',
          why: 'Speeds up repeat runs with minimal staleness risk.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Danger zone is permanent',
      body: 'Clear All Verification Data and Reset All Settings cannot be undone.',
    },
  ],
};

export const MODELS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Discovers the models each provider exposes, verifies they respond, and lets you pin per-model overrides such as temperature.',
    },
    {
      kind: 'steps',
      heading: 'Verifying availability',
      items: [
        'Use the provider buttons at the top (plus Favourites) to switch between model lists.',
        'Click Verify on a card to probe one model, or Verify all for everything visible.',
        'Review the results summary and any failure messages.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Verify before relying',
      body: 'Verify runs a real probe against the model. One still labelled "available" has not been confirmed to work yet.',
    },
    {
      kind: 'code',
      heading: 'Override config example',
      code: '{ "temperature": 0.7, "topP": 0.9 }',
    },
    {
      kind: 'list',
      heading: 'Status meanings',
      items: [
        'Available: discovered but not yet probed.',
        'Verified: tested and confirmed working.',
        'Error: verification failed; see the message for details.',
      ],
    },
  ],
};
