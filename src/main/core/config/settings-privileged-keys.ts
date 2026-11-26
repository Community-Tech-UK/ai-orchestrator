import type { AppSettings } from '../../../shared/types/settings.types';

export const PRIVILEGED_CLI_OPERATOR_ONLY_KEYS = new Set<keyof AppSettings>([
  // 2026-08-29 DELIBERATE WIDENING, authorised by the operator in session.
  //
  // `browserVaultMasterPasswordFile`, `browserVaultAutoUnlock` and
  // `browserAllowSharedTabCredentialFill` were removed from this set and are
  // now writable through the privileged `aio-mcp settings` CLI. They were the
  // whole of what stood between an agent and an unattended portal login: every
  // stalled task in this class was an authentication step, never an approval
  // step.
  //
  // NOT widened: the safe `set_setting` MCP tool (all three stay closed-tier
  // below); approval to send anything a human contact sees; the other anchors.
  //
  // Writes emit a `privileged_set` / `privileged_reset` record via
  // `logSettingMutation`. That is a `logger.info` line, not a tamper-evident
  // audit trail: enough for "what changed and when", not for "did something try
  // to hide this". The compensating visible control is the standing warning on
  // the Browser screen's vault card, fed by `sharedTabCredentialFillEnabled` on
  // `BrowserVaultStatus`.
  // WS-B1 phase 1 (2026-07-31 fresh-eyes CRITICAL fix): PR creation authority
  // is a human/GUI-only decision — the privileged repair CLI's agent-facing
  // `settings set` path must not be able to grant it either.
  'allowPrCreation',
  // 2026-08-19 fresh-eyes finding: a licence guardrail (e.g. keeping a
  // work-only Copilot seat out of automatic selection) is worthless if the
  // very agents it restricts can clear it through the privileged repair CLI.
  // `readOnly()` alone only blocks the safe `set_setting` MCP tool, not this
  // surface — same reasoning as `allowPrCreation` above.
  'providersExcludedFromAutomation',
  // The session watcher's level decides what Harness approves on the user's behalf (2026-11-15).
  'keepSessionsGoing',
  // Copilot account routing (2026-08-25). Same class of authority as the
  // exclusion list above, one step further: these decide WHICH GitHub identity
  // services a repository. An agent that could add a profile, move the default,
  // weaken a protected scope, or relax an automation policy could route
  // enterprise code through a personal seat — the exact mistake the feature
  // exists to prevent. Human/GUI-only, on both the safe tool and repair-CLI
  // surfaces.
  'copilotAccountProfiles',
  'copilotAccountRoutingRules',
  // Provider account pools (2026-09-13). Decide WHICH Claude/ChatGPT
  // subscription a conversation runs on and whether it may move between them.
  // An agent that could add a profile, reorder the pool or acknowledge
  // ownership could spend accounts the user never approved.
  'providerAccountProfiles',
  'providerAccountPools',
  // Plan Queue routing (2026-10-13): which of those accounts unattended queue
  // sessions may spend. Same authority class as the pool keys above.
  'planQueueRouting',
  // Plan Queue account rules (2026-10-27): which accounts unattended queue and
  // automation sessions must avoid or use last. Same authority class as the routing list.
  'planQueueAccountRules',
  // Plan Queue folder checklists (2026-11-04): the commands the queue runs in a
  // shell for a folder. An agent that could write them could run any command.
  'planQueueFolderChecklists',
  // Plan Queue Linear settings (2026-11-15): who Harness acts as in Linear and through which connector, which
  // projects a folder may take tickets from, and which providers may read client ticket text. An agent that could
  // write them could redirect the queue to another account or send a client's text to a provider he excluded.
  'planQueueLinearConnection',
  'planQueueLinearFolderLinks',
  'planQueueLinearTeams',
  // `planQueueFolders` left this set on 2026-11-14 at the operator's request, so a session he asks can add a folder
  // via this CLI; it stays closed to `set_setting`. Controls: the `privileged_set` log and the Plan Queue page list.
  // Authorizes automatic deletion of backup copies; the operator decides.
  'codexBackupKeepThree',
  'computerUseEnabled',
  'computerUseAllowedAppsJson',
  'computerUseDeniedAppsJson',
  'workspaceSecretsEnabled',
  'workspaceSecretsAllowAgentRequests',
  'browserSecretObservationProtectionEnabled', 'browserLocalComputerEnabled',
  // `browserPreApproveAgentFolderLogins` left this set on 2026-11-18 at the operator's request ("use the CLI to change
  // it"), like `browserAllowSharedTabCredentialFill`: it stays closed to `set_setting`; writes log `privileged_set`.
  'providerSignalFenceEnabled',
  'computerUseRequireApprovalForInput',
  'computerUseStoreScreenshotsForEscalations',
  'computerUseAutonomyLevel',
  'contextEvidenceModeByProvider',
  'graphClientId',
  'graphAuthority',
  'graphScopesJson',
  'graphAgentWritableAccountsJson',
  // Standing "Always allow" answers for Microsoft 365 changes. An agent that
  // could add one could send mail as James without anyone being asked.
  'graphAlwaysAllowedChanges',
  'localAiGuardDefaultFallbackPolicy',
  'localAiGuardDailyFallbackBudgetUsd',
  'localAiGuardConfirmAboveInputTokens',
]);
