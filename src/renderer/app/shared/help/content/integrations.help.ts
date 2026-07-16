/**
 * Help & tips content - Integrations group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const MCP_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Manages Model Context Protocol servers that extend agent capabilities. Browse tools, resources, and prompts from connected servers, and control which servers feed which providers.',
    },
    {
      kind: 'steps',
      heading: 'Getting started',
      items: [
        'Add a server from the Discover tab or via the quick-add dialog.',
        'Connect it; tools, resources, and prompts load automatically.',
        'Select a server in the left panel to inspect and test its capabilities.',
        'Use the management tabs (Orchestrator, Shared, per-provider) to set scope.',
      ],
    },
    {
      kind: 'list',
      heading: 'Server scopes',
      items: [
        'Orchestrator: system-wide servers injected into the core harness.',
        'Shared: one config fanned out to multiple providers at once.',
        'Provider: per-CLI customisation for Claude, Codex, Gemini, Copilot.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Test tools interactively',
      body: 'Call Tool invokes any tool with custom JSON arguments and shows the result inline, without routing through an instance.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Auto-connect (orchestrator servers)',
          value: 'On',
          why: 'Servers connect at startup so their tools are immediately available.',
        },
        {
          label: 'Transport',
          value: 'stdio (default)',
          why: 'Simplest and most reliable for local server binaries.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'CLI-loaded entries are read-only',
      body: 'Tools loaded by provider CLIs cannot be edited here; they refresh when that CLI restarts.',
    },
  ],
};

export const BROWSER_GATEWAY_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Controls managed browser automation: create browser profiles, pick targets, approve or deny sensitive actions, and audit everything agents do in a browser.',
    },
    {
      kind: 'steps',
      heading: 'Creating a profile',
      items: [
        'Enter a label and optional default URL.',
        'Define allowed origins (for example example.com or *.example.com).',
        'Click Create Profile, then Launch to open the browser.',
        'Select a target tab and navigate.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Keep origins narrow',
      body: 'Allowed origins define which sites agents can automate. Broad wildcards expose every site to autonomous control.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Grants persist until revoked',
      body: 'Approved permissions survive restarts. Review the Active Grants section periodically and revoke what you no longer need.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Execution node',
          value: 'Local coordinator (default)',
          why: 'Runs the browser on this machine; choose a remote node only for isolated automation.',
        },
        {
          label: 'Autonomous submit/delete',
          value: 'Off',
          why: 'Keeping destructive actions behind approval prevents an agent posting or deleting on your behalf unnoticed.',
        },
      ],
    },
  ],
};

export const FILES_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Moves files between this Mac and a connected worker node. The left pane browses local folders, the right pane browses the worker’s approved folders. Drag files across to copy them; every copy is checksummed.',
    },
    {
      kind: 'steps',
      heading: 'Copying a file',
      items: [
        'Pick a worker and one of its approved folders in the right pane.',
        'Pick a local folder in the left pane.',
        'Drag files from one pane and drop them on the other.',
        'Watch the transfer log below the panes for the result.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Folders and large files',
      body: 'Folders are not draggable — ask an agent to run a folder sync instead. Single files over 50 MB are refused until streaming transfers land.',
    },
  ],
};

export const REMOTE_ACCESS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Generates a tokenised URL so another device can watch your running instances, repo jobs, and pending prompts in read-only mode.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Set the host and port (defaults 127.0.0.1:4877).',
        'Click Start Observer to begin listening.',
        'Copy a generated URL to the remote device.',
        'Rotate the token periodically.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'View-only by design',
      body: 'The remote device can see everything but cannot send commands or modify state.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'URLs contain access tokens',
      body: 'Anyone with the URL can watch your sessions. Share only with trusted people; rotating the token invalidates all previous URLs.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Host',
          value: '127.0.0.1 for local, 0.0.0.0 for remote',
          why: 'Bind to all interfaces only when another machine genuinely needs access.',
        },
      ],
    },
  ],
};

export const PLUGINS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Installs and manages Provider Plugins (custom AI backends) and Runtime Packages (event-driven extensions for notifications, logging, and automation).',
    },
    {
      kind: 'steps',
      heading: 'Installing a provider plugin',
      items: [
        'Click Discover Plugins on the Discover tab.',
        'Install a plugin, or use Install from Path for a local folder or file.',
        'On the Installed tab, click Load to activate it as a model backend.',
        'The plugin then appears in provider selection dropdowns.',
      ],
    },
    {
      kind: 'list',
      heading: 'Runtime packages',
      items: [
        'Event-driven hooks that react to orchestrator lifecycle events.',
        'Install from a folder, .zip file, or URL.',
        'Active while installed; no separate load step.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Scaffold your own',
      body: 'Create Plugin Template generates a starter JavaScript file you can edit and install from its path.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Plugins run code',
      body: 'Project plugins require explicit trust before running. Only trust plugin folders you have reviewed.',
    },
  ],
};

export const REMOTE_CONFIG_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Fetches and caches configuration from a remote source: a URL, a local file, or a git repository. Shows the current config, fetch status, and cache age.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Choose a source type (URL, File, or Git).',
        'Enter the source location and an optional refresh interval.',
        'Click Save Source to apply.',
        'Use Fetch Now to pull the latest config immediately.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Refresh interval',
          value: '3600 seconds (1 hour)',
          why: 'Keeps config reasonably fresh without constant network calls; 0 means manual only.',
        },
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Watch the cache age',
      body: 'The Connection Status card shows how old the cached config is. If it looks stale, Fetch Now refreshes it.',
    },
  ],
};

export const COMMUNICATION_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Sends messages between running instances and manages communication bridges. Instances can exchange text, commands, or data.',
    },
    {
      kind: 'steps',
      heading: 'Sending a message',
      items: [
        'Enter the From and To instance IDs.',
        'Choose a message type: text, command, or data.',
        'Type the content and click Send.',
        'Delivered messages appear in the Message Feed.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Bridges avoid repeat routing',
      body: 'A bridge connects two instances bidirectionally so they can keep talking without a route per message.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Pick the right message type',
      body: 'Use text for human-readable notes, command for directives, and data for structured payloads.',
    },
  ],
};

export const CHANNELS_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Connects Discord and WhatsApp so you can control and monitor the orchestrator from your phone or a Discord server, with message history and pairing management.',
    },
    {
      kind: 'steps',
      heading: 'Connecting Discord',
      items: [
        'Create a bot in the Discord Developer Portal and copy its token.',
        'Paste the token into the Discord card and click Connect.',
        'Invite the bot to your server.',
        'Use a pairing code to authorise users or devices.',
      ],
    },
    {
      kind: 'list',
      heading: 'Channels',
      items: [
        'Discord: slash commands and monitoring via server channels.',
        'WhatsApp: text control and alerts via DM; pair by scanning a QR code.',
      ],
    },
    {
      kind: 'list',
      heading: 'Sub-pages',
      items: [
        'Messages: history of everything received and sent, with a platform filter and inbound/outbound badges linking back to instances.',
        'Settings: manage paired accounts and access policies; enter a 6-character pairing code to link a new user or device without re-entering tokens.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Bot tokens grant full control',
      body: 'Never share a bot token; use pairing codes to add users instead. Disconnecting a channel revokes its access.',
    },
  ],
};

export const REMOTE_NODES_SURFACE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Manages worker nodes: remote machines running the worker agent that execute tasks, run browsers, or take on compute jobs for this orchestrator.',
    },
    {
      kind: 'steps',
      heading: 'Connecting a worker',
      items: [
        'Start the worker agent on the remote machine.',
        'It registers itself and appears in the nodes grid.',
        'Click a node card to view its capabilities and status.',
        'Use Start/Stop Server to control the worker registry.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Check node readiness',
      body: 'Ready means browser MCP is available; Chrome only means the runtime alone; Off means neither.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Trust the network',
      body: 'Workers and the orchestrator must reach each other over the network. Restrict access to machines you control.',
    },
  ],
};
