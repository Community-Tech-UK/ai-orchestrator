/**
 * Help & tips content - Automation group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const AUTOMATIONS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Create and manage scheduled automations that run AI agents on a recurring or one-time basis. Build them via chat description, templates, or manual configuration, and monitor their run history and status.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Choose Create via chat or Create manually from the top-right menu.',
        'Fill in a name, working directory, and your prompt or instructions.',
        'Set a schedule (cron or one-time), then choose a provider and model.',
        'Run Preflight to validate permissions and readiness, then Save.',
        'Click an automation to view recent runs, edit, pause, or run it now.',
      ],
    },
    {
      kind: 'list',
      heading: 'Key options',
      items: [
        'Schedule: Cron (recurring) or One time (single execution).',
        'Provider: Auto lets the orchestrator choose; or pin a specific CLI.',
        'Missed runs: Skip, Notify, or Run once. Concurrency: Skip or Queue.',
        'YOLO mode skips safety checks; use only for trusted, sandboxed work.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Templates',
      body: 'Automation templates let you reuse common setups. Select a template in the form and click Apply to fill in suggested values.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Missed runs',
          value: 'Notify',
          why: 'You see a warning when a scheduled run is skipped instead of it silently vanishing.',
        },
        {
          label: 'Concurrency',
          value: 'Skip',
          why: 'Prevents overlapping runs of the same automation piling up.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Deletion is permanent',
      body: 'Deleted automations and their run history cannot be recovered. Pausing is safer if you only want to stop one temporarily.',
    },
  ],
};

export const CAMPAIGNS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Build and execute graphs of AI loops, where each node is an independent agent task and edges define when tasks run based on success or failure. Supports parallel execution and approval gates.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Use Add node mode to create tasks by clicking the canvas.',
        'Switch to Connect mode to draw edges that define when each task runs.',
        'Configure node details: label, prompt, stage, provider, working directory.',
        'Set campaign policies: title, max parallel tasks, needs-review behaviour.',
        'Click Validate to check the graph, then Run to execute.',
      ],
    },
    {
      kind: 'list',
      heading: 'Key controls',
      items: [
        'Modes: Select (move/edit), Add node, Connect (click two nodes).',
        'Edge conditions: any completion, a specific status, several statuses, or the inverse.',
        'Max parallel: how many nodes run at once (1 to 16).',
        'Worktrees: isolate each node to prevent file conflicts.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Validate before running',
      body: 'Validate catches circular references and orphaned nodes before you spend tokens. The editor reports blockers and warnings.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Max parallel tasks',
          value: '2 to 4',
          why: 'Keeps CPU and provider quota manageable; raise it only on strong hardware.',
        },
        {
          label: 'Worktree isolation',
          value: 'On',
          why: 'Parallel nodes editing the same repo will conflict without it.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Reset clears everything',
      body: 'Reset wipes your campaign nodes and edges with no undo. Use it only when starting over.',
    },
  ],
};

export const WORKFLOWS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Execute template-driven workflows that run multiple phases in sequence, with human approval gates between phases. Each phase can require conditions, confirmations, or data before proceeding.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Select an Instance and a Template from the toolbars at the top.',
        'Click Start Workflow to begin execution.',
        'Monitor progress and respond to approval gates when they appear.',
        'Use Manual Actions to complete phases, skip phases, or cancel the workflow.',
      ],
    },
    {
      kind: 'list',
      heading: 'Side panels',
      items: [
        'Launch Preflight: permissions and tool readiness for the selected instance.',
        'Manual Actions: complete/skip the current phase, refresh, cancel, or provide phase data as JSON.',
        'Prompt Addition: extra instructions added to the current phase prompt.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Phase data',
      body: 'For phases that need input, provide a JSON object in the Manual Actions field before clicking Complete Phase.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Approval gates are blocking',
      body: 'A workflow pauses at a gate until you approve, skip, or reject. Rejecting a confirmation cancels the entire workflow.',
    },
  ],
};

export const HOOKS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Define rules that intercept agent events (tool use, file writes) and warn or block. Hooks support conditional logic on context such as commands, file paths, or prompts.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Create a rule: name it, pick an event type, and set conditions.',
        'Choose an action (Warn or Block) and the message to show.',
        'Click Create; the hook is active immediately if enabled.',
        'Use the Approvals panel for hooks that require explicit approval.',
        'Test rules with Evaluation Preview before relying on them.',
      ],
    },
    {
      kind: 'list',
      heading: 'Key concepts',
      items: [
        'Events: PreToolUse, PreFileWrite, and other lifecycle points.',
        'Tool matcher: optional filter such as "Bash|Git" to target specific tools.',
        'Conditions: regex, substring, exact, or prefix/suffix on fields like command or filePath.',
        'Sources: Built-in, Project (in your repo), and User (personal).',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Preview before enforcing',
      body: 'Paste a JSON hook context into Evaluation Preview to see which rules would match. Start from the default template to learn the event schema.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'New rule action',
          value: 'Warn first',
          why: 'Run a new rule in Warn mode to observe its impact before switching to Block.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Blocked actions are final',
      body: 'A Block action stops the tool or file operation immediately. A bad pattern can block legitimate agent work across every session.',
    },
  ],
};
