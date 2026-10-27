/**
 * Help & tips content - Integrations group surfaces.
 * Grounded in the actual controls each page exposes; keep in sync when the
 * pages gain or lose functionality.
 */

import type { HelpEntry } from '../help-content.types';

export const MCP_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout', variant: 'info', heading: 'Connectors',
      body: 'Save a tool server and its sign-in once in Harness. Select which AI tools receive it in new local sessions. A separate account uses a separate connector name.',
    },
    {
      kind: 'steps', heading: 'Add a connector',
      items: [
        'In Connectors, select Add and choose a local program, remote server, or Microsoft 365 account.',
        'Choose a unique name using letters, numbers and hyphens, then select the AI tools that may use it.',
        'For a remote server, choose browser sign-in or an API key if required. Save, then select Sign in for browser sign-in.',
        'For Microsoft 365, choose whether to include mail and select Sign in and save. Use one organisation account per connector.',
        'Select Test, then start a new session to use the connector.',
      ],
    },
    {
      kind: 'list', heading: 'Where these settings apply',
      items: [
        'Connectors: Harness supplies them to selected local Claude, Codex, Gemini, Copilot, Cursor, Grok and OpenCode sessions.',
        'Workspace: connectors belong to one project folder and AI tool.',
        'The AI tool tabs show its own settings files. User settings can be edited here; project and managed settings are read-only.',
        'Antigravity, the direct Anthropic API, and sessions on remote computers do not receive Harness connectors.',
        'Previous Shared entries become connectors. Copies already written into AI tools’ own settings stay there.',
      ],
    },
    {
      kind: 'callout', variant: 'warning', heading: 'Microsoft 365 account permissions',
      body: 'Agents may write only for accounts you allow on the connector. Allowing writes permits calendar changes, mail drafts and sending mail. Other accounts start read-only. Your organisation may require its IT administrator to approve sign-in.',
    },
    {
      kind: 'callout', variant: 'tip', heading: 'Saved sign-in',
      body: 'Harness stores connector sign-ins encrypted and refreshes them when needed. If sign-in expires, sign in again here. A running session or automation never opens a sign-in window on its own.',
    },
    {
      kind: 'callout', variant: 'tip', heading: 'Inspect a local tool server',
      body: 'Select a connected local server below to browse its tools, resources and prompts. Call Tool runs a tool with your arguments and shows its result here.',
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
      body: 'Installs packages that react to what happens in Harness, such as sessions starting, messages, automations and file edits. A package can send notifications or record activity.',
    },
    {
      kind: 'steps',
      heading: 'Installing a package',
      items: [
        'In Install a package, paste the location of a folder, .js file or .zip file, or a web address.',
        'Click Check to see the package name and any warnings.',
        'Click Install. The package is active straight away.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Plugins run code',
      body: 'An installed package runs code on this computer. Plugins inside a project folder run code too, once you trust that folder. Only install or trust plugins you have reviewed.',
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

export const WORKER_MODE_SURFACE_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Lets your main Harness send work to this computer. Harness stays fully usable here while the worker runs.',
    },
    {
      kind: 'steps',
      heading: 'Pairing this computer',
      items: [
        'On the main Harness, open Remote Nodes settings and start pairing.',
        'Here, choose Pair With Harness, or paste the invitation if it is not found.',
        'Check the code matches on both computers, then approve on the main Harness.',
        'Choose how it runs. On Windows, "Keep working when Harness is closed" starts it whenever you sign in; otherwise tick "Open Harness when I sign in" so it comes back after a restart.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Pausing the worker',
      body: 'Stop Worker pauses it: until Harness next opens, or, for a worker that keeps working with Harness closed, until you press Start Worker. Turn Off Worker Mode keeps the pairing but stops the worker until you switch it back on.',
    },
  ],
};
