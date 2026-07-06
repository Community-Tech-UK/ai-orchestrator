/**
 * Help & tips content - core Settings tabs (everyday preferences and agent
 * behaviour). Grounded in the actual controls each tab exposes; keep in sync
 * when tabs gain or lose settings.
 */

import type { HelpEntry } from '../../../shared/help/help-content.types';

export const GENERAL_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Sets your default AI CLI, model, working folder, and whether new agents skip approval prompts. These become the baseline for every fresh instance you spawn.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Use fast mode wisely',
      body: 'Fast mode trades some accuracy for speed. Keep it for routine tasks rather than complex work.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Auto-approve (YOLO) is risky',
      body: 'With auto-approve on, agents act without asking. Enable it only for sandboxed work where mistakes cannot cause harm.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Default AI CLI',
          value: 'Auto-detect',
          why: 'Picks the first installed CLI automatically; switch manually when needed.',
        },
        {
          label: 'Auto-approve actions',
          value: 'Off',
          why: 'Approval prompts let you catch mistakes before an agent acts.',
        },
      ],
    },
  ],
};

export const DISPLAY_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Tunes the app theme, workspace density, sidebar layout, output font size, and transcript detail.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Preview before applying',
      body: 'Theme, density, sidebar, and output font changes preview immediately. Apply them to persist across restarts.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Transcript noise',
      body: 'Hide tool activity and reasoning panels for calmer runs, then turn them back on while debugging.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Broken layout?',
      body: 'Reset workspace layout (under Layout tools) restores sidebar and file explorer widths to their defaults without touching other settings.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Font size',
          value: '14 to 15px',
          why: 'Readable without cramping; adjust for your monitor and eyesight.',
        },
        {
          label: 'Context-full warning',
          value: '80%',
          why: 'Leaves headroom to wrap up a session before the model starts forgetting.',
        },
        {
          label: 'Show cost estimates',
          value: 'On',
          why: 'Keeps running spend visible per instance so surprises surface early.',
        },
      ],
    },
  ],
};

export const KEYBOARD_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Shows all keyboard shortcuts grouped by category and checks for conflicts. Export bindings to JSON and import them on another machine.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Browse shortcuts by category.',
        'Click Export to copy your bindings as JSON.',
        'Paste exported JSON on another machine and click Import.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Imports can conflict',
      body: 'If an imported shortcut clashes with an existing one, the import is blocked until you resolve the conflict.',
    },
  ],
};

export const ORCHESTRATION_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Controls how many agents run at once, how deep they can delegate to each other, and how idle agents are cleaned up. These settings govern resource use and agent spawning.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Match limits to your machine',
      body: 'Higher limits burn more CPU, memory, and API quota. Tune to your hardware and what else runs alongside.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Nested agents escalate quickly',
      body: 'High delegation depth lets one agent spawn a deep tree of children. Keep depth low (2 to 3) unless you know you need more.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Max sub-agents per agent',
          value: '10',
          why: 'Meaningful parallelism without overwhelming the system.',
        },
        {
          label: 'Max agents running at once',
          value: '20',
          why: 'A sensible cap for most machines; adjust to your hardware.',
        },
        {
          label: 'Close idle agents after',
          value: '30 minutes',
          why: 'Frees resources after a natural break in work.',
        },
      ],
    },
  ],
};

export const AUXILIARY_MODELS_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Routes lightweight helper tasks (compression, titles, scoring) to fast local or cheap cloud models instead of expensive frontier models, saving cost and latency.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enable auxiliary models and choose a routing mode.',
        'Click Refresh to scan for Ollama and custom endpoints.',
        'Set quick and quality tier models from the dropdowns.',
        'Test a slot to see which endpoint it routes through.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Tiers do the routing for you',
      body: 'Pick a small fast model for the quick tier and a larger one for quality. Most slots then route correctly without per-slot tweaks.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Enable auxiliary models',
          value: 'On',
          why: 'Local models are faster and cheaper; slots fall back safely when unavailable.',
        },
        {
          label: 'Routing mode',
          value: 'Local first',
          why: 'Prefers your own Ollama for speed and zero cost before any cloud call.',
        },
      ],
    },
  ],
};

export const REVIEW_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Enables cross-model review so a second AI double-checks code, plans, and architecture decisions. You choose which CLIs review, in what order, and with which models.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Turn on cross-model review.',
        'Choose review depth (Structured for a standard pass, Tiered to escalate complex work).',
        'Set how many reviewers run per check.',
        'Add reviewer CLIs in priority order, or leave empty to auto-pick.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Reviews cost time and quota',
      body: 'Each review is a separate model call. Start with one reviewer and expand only if it earns its keep.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Review depth',
          value: 'Structured',
          why: 'Standard thoroughness; Tiered only pays off for routinely complex output.',
        },
        {
          label: 'Reviewers per check',
          value: '2',
          why: 'More robust than one; beyond two adds cost with diminishing returns.',
        },
      ],
    },
  ],
};

export const MEMORY_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Controls how conversation history is stored: how much stays in RAM, what archives to disk, and how the app reacts to memory pressure.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Token compaction',
      body: 'Enable the token-spend threshold to compress long sessions once they pass a cost cap, keeping bills predictable.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Disk trades speed for space',
      body: 'Archived messages resume and query more slowly than in-RAM history. Cap the disk size so the archive cannot fill your drive.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Output buffer size',
          value: '500',
          why: 'Keeps recent history responsive without excessive RAM use.',
        },
        {
          label: 'Disk storage',
          value: 'On',
          why: 'Frees memory for active sessions and prevents unbounded growth.',
        },
        {
          label: 'Memory warning threshold',
          value: '1024 MB',
          why: 'Alerts you before performance degrades noticeably.',
        },
      ],
    },
  ],
};

export const PERMISSIONS_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Sets the default answer for filesystem and network actions an agent takes that no rule or earlier decision already covers.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: '"Allow" is broad',
      body: 'The Allow preset lets agents act with no confirmation. "Ask" is the safe default; switch to Allow only for trusted, sandboxed workspaces.',
    },
    {
      kind: 'list',
      heading: 'Decision scopes',
      items: [
        'This time only: applies to a single action.',
        'This session: until the app restarts.',
        'Always: saved as a persistent rule.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Learned patterns',
      body: 'Approving a learned pattern turns a repeated decision into a standing rule, cutting future prompts. The Activity summary shows rule counts, remembered decisions, and accuracy so you can judge how well automation is working.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Browser automation',
      body: 'The "things to know" cards explain how browser permissions differ from filesystem ones; read them before granting browser access.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Default for filesystem, network, and bash',
          value: 'Ask',
          why: 'Gives you a chance to review powerful operations before they run.',
        },
      ],
    },
  ],
};

export const ECOSYSTEM_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Browse, create, and edit custom commands, agents, tools, plugins, and output styles for a workspace. Everything is saved as files on disk so it travels with the project.',
    },
    {
      kind: 'list',
      heading: 'Ecosystem types',
      items: [
        'Commands: slash commands agents can invoke.',
        'Agents: custom profiles with their own prompts and permissions.',
        'Tools: JavaScript functions agents can call.',
        'Plugins: hooks that trigger on app events.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Output styles set the tone',
      body: 'Choose a built-in style or write your own markdown file to shape how new agent sessions communicate.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Instruction Inspector',
      body: 'The Resolved Instruction Stack shows which instruction files feed an agent session in this directory, and can generate and save a draft instructions file for you.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Large files may truncate',
      body: 'Very large files can be trimmed in the built-in editor for performance. Use Open File to edit them externally.',
    },
  ],
};

export const ADVANCED_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Low-level tuning for code indexing, browser automation, MCP safety, hook approvals, and backup/restore. Most people should leave these at their defaults.',
    },
    {
      kind: 'list',
      heading: 'Main sections',
      items: [
        'Runtime controls: parser buffer, diagnostics, file scanning.',
        'Code memory indexing: symbol search and workspace prewarm.',
        'Knowledge Graph auto-build and MCP safety guards.',
        'Hook approvals and backup/restore.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Defaults are production-tuned',
      body: 'Change values here only when you understand the trade-off or are investigating a specific problem.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Browser DevTools attach',
      body: 'Use Refresh profiles and the managed-profile dropdown to pick which Chrome profile agents drive. The Setup guides section walks through browser automation end to end.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Export before reinstalling',
      body: 'Export settings before moving machines; import restores your setup, credentials, and pairings in one step.',
    },
  ],
};
