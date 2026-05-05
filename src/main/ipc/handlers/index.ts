/**
 * IPC Handlers Barrel Export
 * Re-exports all domain-specific IPC handlers
 */

export { registerInstanceHandlers } from './instance-handlers';
export { registerSettingsHandlers } from './settings-handlers';
export { registerInstructionHandlers } from './instruction-handlers';
export { registerSessionHandlers } from './session-handlers';
export { registerProviderHandlers } from './provider-handlers';
export { registerVcsHandlers } from './vcs-handlers';
export { registerLspHandlers } from './lsp-handlers';
export { registerSnapshotHandlers } from './snapshot-handlers';
export { registerMcpHandlers } from './mcp-handlers';
export { registerBrowserGatewayHandlers } from './browser-gateway-handlers';
export { registerTodoHandlers } from './todo-handlers';
export { registerSecurityHandlers } from './security-handlers';
export { registerDebugHandlers } from './debug-handlers';
export { registerCostHandlers } from './cost-handlers';
export { registerQuotaHandlers } from './quota-handlers';
export { registerTaskHandlers } from './task-handlers';
export { registerRepoJobHandlers } from './repo-job-handlers';
export { registerSearchHandlers } from './search-handlers';
export { registerStatsHandlers } from './stats-handlers';
export { registerCommandHandlers } from './command-handlers';
export { registerPromptHistoryHandlers } from './prompt-history-handlers';
export { registerPauseHandlers } from './pause-handlers';
export { registerHistorySearchHandlers } from './history-search-handlers';
export { registerResumeHandlers } from './resume-handlers';
export { registerWorkflowHandlers } from './workflow-handlers';
export { registerDiagnosticsHandlers, bridgeCliUpdatePillDeltaToWindow } from './diagnostics-handlers';
export { registerAppHandlers } from './app-handlers';
export { registerEventStoreHandlers } from './event-store-handlers';
export { registerFileHandlers } from './file-handlers';
export { registerCodebaseHandlers } from './codebase-handlers';
export { registerSupervisionHandlers } from './supervision-handlers';
export { registerRecentDirectoriesHandlers } from './recent-directories-handlers';
export { registerEcosystemHandlers } from './ecosystem-handlers';
export { registerConsensusHandlers } from './consensus-handlers';
export { registerRoutingHandlers } from './routing-handlers';
export { registerCommunicationHandlers } from './communication-handlers';
export { registerParallelWorktreeHandlers } from './parallel-worktree-handlers';
export { registerRemoteObserverHandlers } from './remote-observer-handlers';
export { registerRemoteNodeHandlers } from './remote-node-handlers';
export { registerImageHandlers } from './image-handlers';
export { registerChannelHandlers } from './channel-handlers';
export { registerReactionHandlers } from './reaction-handlers';
export { registerRemoteFsHandlers } from './remote-fs-handlers';
export { registerKnowledgeGraphHandlers } from './knowledge-graph-handlers';
export { registerConversationMiningHandlers } from './conversation-mining-handlers';
export { registerWakeContextHandlers } from './wake-context-handlers';
export { registerAutomationHandlers } from './automation-handlers';
export { registerWebhookHandlers } from './webhook-handlers';
export { registerVoiceHandlers } from './voice-handlers';
export { registerConversationLedgerHandlers } from './conversation-ledger-handlers';
export { registerOperatorHandlers } from './operator-handlers';
