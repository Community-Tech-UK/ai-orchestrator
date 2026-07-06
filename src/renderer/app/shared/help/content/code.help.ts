/**
 * Help & tips content - Code group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const WORKTREES_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Creates isolated git worktrees for parallel implementation tasks. Each worktree runs independently, and you can detect conflicts or merge completed work.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select an instance and enter a task description.',
        'Choose a merge strategy (auto, squash, rebase, manual).',
        'Click Create to spawn a worktree for the task.',
        'Monitor status in the main panel; click View to inspect conflicts.',
        'Merge or abandon completed worktrees when done.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Run preflight first',
      body: 'The Launch Preflight panel shows filesystem permissions and tool readiness. Blockers must be resolved before a worktree can be created.',
    },
    {
      kind: 'list',
      heading: 'Quick actions',
      items: [
        'Detect Conflicts: compares active worktrees for cross-branch issues.',
        'Merge All: bulk auto-merge of finished worktrees.',
        'Implement as Background Job: run the task as a local repo job instead.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Merge strategy matters',
      body: 'Auto merge only succeeds without conflicts. Squash and rebase rewrite history differently; manual requires resolving conflicts outside this page.',
    },
  ],
};

export const LSP_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Inspects language-server integration: navigate code structure, find definitions and references, run diagnostics, and search workspace symbols.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enter a file path and load document symbols to see the structure tree.',
        'Click a symbol for hover info, definition, or references.',
        'Search workspace symbols by name across the project root.',
        'Load diagnostics for a file to see errors, warnings, and hints.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Results are live',
      body: 'Hover info and references come from running language servers. If a symbol returns nothing, check the server status bar at the top.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Shutdown stops all servers',
      body: 'The Shutdown LSP button stops every language server. Agents and tools relying on them lose language intelligence until they restart.',
    },
  ],
};

export const VCS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Inspects git repositories: status, branches, commits, staged and unstaged diffs, and file history. Also launches background PR reviews and repo health audits.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enter a working directory and click Load to read git status.',
        'Switch between the Changes and Branches tabs.',
        'Click a file to see its diff; click a commit to see what changed.',
        'Open the bottom drawer to inspect the full history of one file.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Launch repo jobs from here',
      body: 'Once a repo is loaded, the job launch bar pre-fills branch and directory. Paste a PR URL to include its context in a background job.',
    },
    {
      kind: 'list',
      heading: 'File status labels',
      items: [
        'S staged, ready to commit.',
        'M modified but not staged.',
        'A added, new file.',
        'D deleted from the working tree.',
        '? untracked.',
      ],
    },
  ],
};

export const TASKS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Launches and monitors local background jobs: PR reviews, issue implementation runs, and repo health audits. Each job runs on this machine with its own instance and worktree.',
    },
    {
      kind: 'steps',
      heading: 'How to launch',
      items: [
        'Enter a working directory (a git repo works best).',
        'Choose the job type, base branch, and optional title or URL.',
        'Check Launch Preflight for permission and tooling blockers.',
        'Click Launch; jobs queue and run in order.',
      ],
    },
    {
      kind: 'list',
      heading: 'Job types',
      items: [
        'PR Review: analyse a diff, suggest fixes, verify the implementation.',
        'Issue Implementation: implement a feature or fix, optionally in a worktree.',
        'Repo Health Audit: scan for outdated dependencies and common problems.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Fix blockers before launching',
      body: 'Preflight flags filesystem access, tool availability, and browser tooling issues. A job launched over blockers will fail.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Cancel and rerun lose progress',
      body: 'Cancelling stops a queued or running job. Rerunning a completed job starts from scratch and discards previous results.',
    },
  ],
};

export const PLAN_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Controls plan mode for agent instances: an agent drafts and refines a plan before touching code. States are idle, planning, awaiting approval, and implementing.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enter an instance ID and click Load State.',
        'Enter Plan Mode so the agent drafts a plan.',
        'Edit or approve the plan when it reaches awaiting approval.',
        'Exit Plan Mode once implementation is complete.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'History tracks versions',
      body: 'Every update, approval, and state change is logged with a timestamp so you can see how the plan evolved.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Force exit discards the plan',
      body: 'Ticking Force exit drops the plan without saving. Use it only to cancel mid-planning.',
    },
  ],
};

export const SEARCH_CODE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Searches indexed codebase content. The main panel handles full-text and fuzzy file search; the right sidebar provides fast symbol lookup by name.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Use the main panel for full-text and fuzzy file search.',
        'Type in the Symbol Search box to find functions, classes, and interfaces.',
        'Click a symbol result to jump to its definition.',
        'Hit Refresh to re-scan after adding new files.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Symbol search is instant',
      body: 'Results appear as you type. Kind icons (C for class, f for function) identify what each match is.',
    },
  ],
};

export const MULTI_EDIT_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Previews and applies coordinated multi-file edits. Paste JSON edit operations, review the diff for each file, then apply or reject everything at once.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Paste edit operations as JSON (filePath, oldString, newString per file).',
        'Click Preview to generate diffs.',
        'Select files to review their changes.',
        'Click Apply All to commit, or Reject All to discard.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Diffs are read-only',
      body: 'Refine the JSON input and re-preview rather than editing in the diff viewer.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Apply writes to disk',
      body: 'Apply All commits changes directly with no undo. Check every diff before applying.',
    },
  ],
};

export const EDITOR_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Configures external editor integration: pick a default editor and open files at specific lines. Shows every detected editor and its availability.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Click Refresh to detect editors installed on this machine.',
        'Set your preferred editor as default.',
        'Use Quick Actions to open a file at an optional line number.',
        'Check Detection Status if an editor shows Not Found.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Detection is automatic',
      body: 'Editors are discovered from PATH and common install locations. Not Found usually means the editor is not on PATH.',
    },
  ],
};

export const SEMANTIC_SEARCH_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Natural-language code search using vector embeddings. Describe what you are looking for and the engine finds relevant code chunks by meaning, not just keywords.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Build or refresh the index from the Index Management panel first.',
        'Enter a plain-language query, such as "how does authentication work".',
        'Adjust limit, threshold, and file pattern as needed.',
        'Click Search, then expand a result card for full content with line numbers.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Threshold',
          value: '0.3 to 0.5',
          why: 'Filters noise while keeping partially related matches; 1.0 returns almost nothing.',
        },
        {
          label: 'Limit',
          value: '25',
          why: 'Enough coverage to scan without drowning in low-relevance chunks.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Exa API key is sensitive',
      body: 'If you enable Exa search, keep the API key private. Never share it or commit it to a repository.',
    },
  ],
};
