/**
 * Help & tips content - network, remote, and diagnostics Settings tabs.
 * Grounded in the actual controls each tab exposes; keep in sync when tabs
 * gain or lose settings.
 */

import type { HelpEntry } from '../../../shared/help/help-content.types';

export const NETWORK_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Detects when you connect to a VPN and pauses outbound API requests until it disconnects, preventing sensitive traffic from routing over an untrusted network.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Enable Network safety to activate VPN detection.',
        'Requests queue while a VPN is detected and resume when it drops.',
        'Tweak the VPN interface pattern if yours uses unusual tunnel names.',
        'Use View events log to see what was paused and when.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Queued is not lost, but can look stuck',
      body: 'Paused requests wait in the queue and resume automatically. Long pauses make sessions look frozen; clear the queue manually if needed.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Network safety',
          value: 'On',
          why: 'Protects API calls from unexpected network routes.',
        },
        {
          label: 'Treat existing VPN as active',
          value: 'On',
          why: 'Applies the pause rule even when the VPN predates app launch.',
        },
      ],
    },
  ],
};

export const CONNECTIONS_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Connects Discord and WhatsApp so you can send instructions to the app from your phone or another device and control running sessions away from your desk.',
    },
    {
      kind: 'steps',
      heading: 'Discord setup',
      items: [
        'Create a bot in the Discord Developer Portal and copy its token.',
        'Paste the token here and click Connect.',
        'Invite the bot to your server.',
        'DM the bot "pair" and enter the code it replies with.',
      ],
    },
    {
      kind: 'steps',
      heading: 'WhatsApp setup',
      items: [
        'Click Connect via QR code.',
        'On your phone, open WhatsApp, go to Linked Devices, and scan.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Pairing is one-time',
      body: 'Once paired, the connection is saved. You can disconnect and reconnect later without re-pairing.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Keep tokens private',
      body: 'Discord and WhatsApp credentials are sensitive. Never share them or commit them to version control.',
    },
  ],
};

export const VOICE_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Routes speech-to-text to this Mac, a paired worker node, or OpenAI cloud. Choose privacy (local), availability (cloud), or a mix (auto).',
    },
    {
      kind: 'list',
      heading: 'Routing options',
      items: [
        'Auto: this device first, then worker, then OpenAI.',
        'This device: local engine only.',
        'Worker node: offload to a paired machine.',
        'Cloud: always OpenAI (needs an API key).',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Local privacy',
      body: 'This-device audio stays on this Mac. Worker-node audio goes only to a paired machine you control.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'This-device endpoint',
      body: 'Run whisper.cpp or any OpenAI-compatible STT server locally and point the endpoint URL (plus optional API-key environment variable) at it for private transcription.',
    },
    {
      kind: 'list',
      heading: 'Routing form fields',
      items: [
        'Worker node id: which paired machine handles audio.',
        'Model name and language: passed to the STT engine.',
        'Max segment ms: how audio is chunked for a real-time feel.',
      ],
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Routing mode',
          value: 'Auto',
          why: 'Balances privacy and availability without manual switching.',
        },
        {
          label: 'Max segment ms',
          value: '5000',
          why: 'Five-second chunks keep transcription feeling live without flooding the engine.',
        },
      ],
    },
  ],
};

export const REMOTE_NODES_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Lets this machine hand agent work to other machines you have paired as remote worker nodes, including browser automation, Android control, and GPU compute.',
    },
    {
      kind: 'steps',
      heading: 'Pairing a node',
      items: [
        'Enable Remote Nodes to start the pairing server.',
        'Create a one-time pairing credential.',
        'Scan the QR code or paste the link on the worker machine.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Credentials expire',
      body: 'Pairing credentials are single-use and time-limited. Generate a fresh one if a worker does not connect in time.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Remote automation is ungoverned',
      body: 'Agents on remote nodes can drive logged-in Chrome and Android with no per-action approval. Enable offload only on trusted nodes.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Auto-offload browser automation',
          value: 'On',
          why: 'Spreads browser load to nodes when available.',
        },
        {
          label: 'Require TLS',
          value: 'Off on trusted LANs',
          why: 'Enable it only when nodes sit on untrusted networks.',
        },
      ],
    },
  ],
};

export const MOBILE_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Runs a local mobile gateway so the phone app can connect: pair devices via QR code, manage them, set up push notifications, and optionally add TLS.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Ensure Tailscale runs on this Mac and your phone (same tailnet).',
        'Start the gateway to generate a pairing QR code.',
        'Scan the QR code or paste the connection code in the phone app.',
        'Optionally configure Apple Push credentials for notifications.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Tailscale is required',
      body: 'Both devices must share a tailnet for the connection. Push notifications travel over Apple’s network independently.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'QR codes expire',
      body: 'Pairing credentials are single-use and time-limited. Generate a fresh one if the phone does not connect in time.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Production APNs endpoint',
          value: 'Off while testing',
          why: 'Development builds need the development endpoint; switch only for production releases.',
        },
      ],
    },
  ],
};

export const CLI_HEALTH_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Shows every AI CLI installed on this machine, which copy is active, its version, shadow installs on PATH, and health-check results.',
    },
    {
      kind: 'steps',
      heading: 'Key actions',
      items: [
        'Click Refresh to rescan CLIs and run health probes.',
        'Click Show details to see all copies on PATH and check results.',
        'Use Update all, or Run updater for a single CLI.',
      ],
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Shadow installs cause version drift',
      body: 'When several copies of a CLI sit on PATH, the first wins. Remove redundant copies to avoid silent version mismatches.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Automatic updates',
          value: 'Notify',
          why: 'Stays current while keeping manual control over when updates land.',
        },
      ],
    },
  ],
};

export const DOCTOR_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Aggregates startup, provider, CLI, browser-automation, and command/skill/instruction diagnostics into one report.',
    },
    {
      kind: 'list',
      heading: 'Runbooks',
      items: [
        'Open Runbook in each section opens the matching troubleshooting guide.',
        'Repair actions show commands to copy; nothing runs automatically.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Sharing diagnostics',
      body: 'Operator Artifacts exports a redacted bundle: paths are home-relative and secrets are stripped, safe to attach to a bug report.',
    },
  ],
};

export const PROVIDER_QUOTA_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Monitors how much of each provider’s quota you have used and when it resets. Each provider can be polled on a schedule you choose.',
    },
    {
      kind: 'steps',
      heading: 'How to use it',
      items: [
        'Pick a polling interval per provider (Off up to hourly).',
        'Click Refresh now for an immediate check.',
        'Watch the usage limits column for remaining quota before reset.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Not all providers expose limits',
      body: 'Some CLIs only report quota inside an interactive session; for those, background checks show sign-in status only.',
    },
    {
      kind: 'recommend',
      items: [
        {
          label: 'Check automatically',
          value: 'Off (default)',
          why: 'Polling adds background network activity; enable it only for providers you actively track.',
        },
      ],
    },
  ],
};

export const RTK_SAVINGS_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Shows token savings from RTK, which compresses shell command output before it reaches the AI. Stats come from RTK’s local tracking file.',
    },
    {
      kind: 'steps',
      heading: 'Key actions',
      items: [
        'Click Refresh to reload the latest savings data.',
        'Toggle RTK on or off for new sessions.',
        'Check top commands by tokens saved to see where compression helps most.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Applies to new sessions only',
      body: 'Already-running sessions keep their RTK setting; restart a session to pick up a change.',
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Empty until RTK runs',
      body: 'The table stays empty until a session runs a shell command and RTK compresses its output.',
    },
  ],
};

export const COMPUTER_USE_TAB_HELP: HelpEntry = {
  sections: [
    {
      kind: 'callout',
      variant: 'info',
      heading: 'What this does',
      body: 'Lets local agents observe and control approved desktop apps through the Harness-owned computer-use MCP server (macOS v1). Off by default.',
    },
    {
      kind: 'callout',
      variant: 'warning',
      heading: 'Grants are per app',
      body: 'Agents can only touch apps you explicitly grant. Sensitive apps (the Harness itself, terminals, password managers, Keychain, System Settings security, payment apps) are always hard-denied.',
    },
    {
      kind: 'steps',
      heading: 'Setup on macOS',
      items: [
        'Enable Computer Use above.',
        'Grant Screen Recording and Accessibility to AI Orchestrator (use the Open settings buttons).',
        'Install the input helper (brew install cliclick) to enable click/type/scroll/drag.',
        'Click Refresh to re-check permission and driver health.',
      ],
    },
    {
      kind: 'callout',
      variant: 'tip',
      heading: 'Approvals happen inline',
      body: 'When an agent requests app access you approve it in the normal approval card. This tab is for reviewing health, active grants, and the audit log, and for revoking grants.',
    },
  ],
};
