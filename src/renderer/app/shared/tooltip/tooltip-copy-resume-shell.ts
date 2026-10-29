import type { TooltipCopyEntry } from './tooltip-copy';

export const RESUME_SHELL_COPY = {
  "shell.resumeTraffic": { label: "Sending", meaning: "Queued paused traffic is resuming" },
  "shell.sidechats": { label: "Sidechats", meaning: "Sidechats. Right-click for sidechat activity. Shift+F10 also opens sidechat activity." },
  "shell.remoteTerminal": { label: "Remote terminal", meaning: "Remote terminal on a worker computer" },
  "shell.closeAllSessions": { label: "Close all sessions", meaning: "Close all sessions" },
  "shell.historyVisibility": { label: "History", meaning: "Choose how much imported history appears in the project rail" },
  "shell.historyActivity": { label: "Activity", meaning: "Limit projects and threads by recent activity" },
  "shell.hiddenAutomations": { label: "Show hidden automation runs", meaning: "Hidden automations stay out of the rail while they are working normally. A run that fails, or stops for permission, is always shown." },
  "shell.resumeDraft": { label: "Resume draft", meaning: "Resume draft in this project" },
  "shell.startProjectConversation": { label: "New conversation", meaning: "Start a new conversation in this project" },
  "shell.completedHistory": { label: "Completed", meaning: "Completed — click to view" },
  "shell.quotaPacing": { label: "Quota pacing", meaning: "Quota is being consumed ahead of this window's time budget" },
  "shell.accountsSignIn": { label: "Accounts", meaning: "Open Accounts to sign in" },
  "shell.copilotAccountsSignIn": { label: "Copilot Accounts", meaning: "Open Copilot Accounts to sign in" },
  "shell.archiveHistory": { label: "Archive thread", meaning: "Hides this thread from the project list. The conversation is kept in Archive." },
} as const satisfies Record<string, TooltipCopyEntry>;
