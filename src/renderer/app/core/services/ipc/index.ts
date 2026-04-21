/**
 * IPC Services Barrel Export
 *
 * This module provides domain-specific IPC services and a facade for backwards compatibility.
 */

// Re-export base service as BaseIpcService and common types
export { ElectronIpcService as BaseIpcService, IpcResponse, FileEntry, CopilotModelInfo } from './electron-ipc.service';

// Re-export domain services
export { AppIpcService } from './app-ipc.service';
export { InstanceIpcService, CreateInstanceConfig, CreateInstanceWithMessageConfig } from './instance-ipc.service';
export { ProviderIpcService } from './provider-ipc.service';
export { PluginIpcService } from './plugin-ipc.service';
export { SettingsIpcService } from './settings-ipc.service';
export { FileIpcService } from './file-ipc.service';
export { HistoryIpcService } from './history-ipc.service';
export { VcsIpcService } from './vcs-ipc.service';
export { SnapshotIpcService } from './snapshot-ipc.service';
export { TodoIpcService } from './todo-ipc.service';
export { McpIpcService } from './mcp-ipc.service';
export { HooksIpcService } from './hooks-ipc.service';
export { PlanModeIpcService } from './plan-mode-ipc.service';
export { MemoryIpcService } from './memory-ipc.service';
export { OrchestrationIpcService } from './orchestration-ipc.service';
export { VerificationIpcService } from './verification-ipc.service';
export { CommandIpcService } from './command-ipc.service';
export { LspIpcService } from './lsp-ipc.service';
export { TaskIpcService } from './task-ipc.service';
export { SecurityIpcService } from './security-ipc.service';
export { CostIpcService } from './cost-ipc.service';
export { LoggingIpcService } from './logging-ipc.service';
export { StatsIpcService } from './stats-ipc.service';
export { SearchIpcService } from './search-ipc.service';
export { TrainingIpcService } from './training-ipc.service';
export { RecentDirectoriesIpcService } from './recent-directories-ipc.service';
export { CommIpcService } from './comm-ipc.service';
export { SessionShareIpcService } from './session-share-ipc.service';
export { RemoteObserverIpcService } from './remote-observer-ipc.service';
export { ChannelIpcService } from './channel-ipc.service';
export { IpcEventBusService } from './ipc-event-bus.service';

// Import services for facade
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import { AppIpcService } from './app-ipc.service';
import { InstanceIpcService } from './instance-ipc.service';
import { ProviderIpcService } from './provider-ipc.service';
import { SettingsIpcService } from './settings-ipc.service';
import { FileIpcService } from './file-ipc.service';
import { HistoryIpcService } from './history-ipc.service';
import { VcsIpcService } from './vcs-ipc.service';
import { SnapshotIpcService } from './snapshot-ipc.service';
import { TodoIpcService } from './todo-ipc.service';
import { McpIpcService } from './mcp-ipc.service';
import { HooksIpcService } from './hooks-ipc.service';
import { PlanModeIpcService } from './plan-mode-ipc.service';
import { MemoryIpcService } from './memory-ipc.service';
import { OrchestrationIpcService } from './orchestration-ipc.service';
import { VerificationIpcService } from './verification-ipc.service';
import { CommandIpcService } from './command-ipc.service';
import { LspIpcService } from './lsp-ipc.service';
import { TaskIpcService } from './task-ipc.service';
import { SecurityIpcService } from './security-ipc.service';
import { CostIpcService } from './cost-ipc.service';
import { LoggingIpcService } from './logging-ipc.service';
import { StatsIpcService } from './stats-ipc.service';
import { SearchIpcService } from './search-ipc.service';
import { TrainingIpcService } from './training-ipc.service';
import { SessionShareIpcService } from './session-share-ipc.service';

/**
 * IPC Facade Service - Provides backwards compatibility with the original ElectronIpcService
 *
 * This service aggregates all domain-specific IPC services and exposes their methods
 * at the top level for backwards compatibility. New code should inject domain services directly.
 *
 * @deprecated Use domain-specific IPC service instead (e.g. InstanceIpcService, TodoIpcService,
 * CommandIpcService, ProviderIpcService, etc.). This facade will be removed in a future release.
 *
 * @example
 * // Legacy usage (still works, but deprecated)
 * const ipc = inject(IpcFacadeService);
 * await ipc.createInstance(config);
 *
 * // Preferred usage (new code)
 * const instanceIpc = inject(InstanceIpcService);
 * await instanceIpc.createInstance(config);
 */
@Injectable({ providedIn: 'root' })
export class IpcFacadeService {
  // Expose domain services for direct access
  readonly base = inject(ElectronIpcService);
  readonly app = inject(AppIpcService);
  readonly instance = inject(InstanceIpcService);
  readonly provider = inject(ProviderIpcService);
  readonly settings = inject(SettingsIpcService);
  readonly file = inject(FileIpcService);
  readonly history = inject(HistoryIpcService);
  readonly vcs = inject(VcsIpcService);
  readonly snapshot = inject(SnapshotIpcService);
  readonly todo = inject(TodoIpcService);
  readonly mcp = inject(McpIpcService);
  readonly hooks = inject(HooksIpcService);
  readonly planMode = inject(PlanModeIpcService);
  readonly memory = inject(MemoryIpcService);
  readonly orchestration = inject(OrchestrationIpcService);
  readonly verification = inject(VerificationIpcService);
  readonly command = inject(CommandIpcService);
  readonly lsp = inject(LspIpcService);
  readonly task = inject(TaskIpcService);
  readonly security = inject(SecurityIpcService);
  readonly cost = inject(CostIpcService);
  readonly logging = inject(LoggingIpcService);
  readonly stats = inject(StatsIpcService);
  readonly search = inject(SearchIpcService);
  readonly training = inject(TrainingIpcService);
  readonly sessionShare = inject(SessionShareIpcService);

  // ============================================
  // Base Service Properties
  // ============================================

  get isElectron() { return this.base.isElectron; }
  get platform() { return this.base.platform; }
  getApi = this.base.getApi.bind(this.base);
  invoke = this.base.invoke.bind(this.base);
  on = this.base.on.bind(this.base);

  // ============================================
  // App Service Methods
  // ============================================

  appReady = this.app.appReady.bind(this.app);
  getVersion = this.app.getVersion.bind(this.app);

  // ============================================
  // Instance Service Methods
  // ============================================

  createInstance = this.instance.createInstance.bind(this.instance);
  createInstanceWithMessage = this.instance.createInstanceWithMessage.bind(this.instance);
  sendInput = this.instance.sendInput.bind(this.instance);
  terminateInstance = this.instance.terminateInstance.bind(this.instance);
  interruptInstance = this.instance.interruptInstance.bind(this.instance);
  restartInstance = this.instance.restartInstance.bind(this.instance);
  restartFreshInstance = this.instance.restartFreshInstance.bind(this.instance);
  renameInstance = this.instance.renameInstance.bind(this.instance);
  changeAgentMode = this.instance.changeAgentMode.bind(this.instance);
  toggleYoloMode = this.instance.toggleYoloMode.bind(this.instance);
  changeModel = this.instance.changeModel.bind(this.instance);
  terminateAllInstances = this.instance.terminateAllInstances.bind(this.instance);
  listInstances = this.instance.listInstances.bind(this.instance);
  onInstanceCreated = this.instance.onInstanceCreated.bind(this.instance);
  onInstanceRemoved = this.instance.onInstanceRemoved.bind(this.instance);
  onInstanceStateUpdate = this.instance.onInstanceStateUpdate.bind(this.instance);
  onBatchUpdate = this.instance.onBatchUpdate.bind(this.instance);
  onUserActionRequest = this.instance.onUserActionRequest.bind(this.instance);
  respondToUserAction = this.instance.respondToUserAction.bind(this.instance);
  listUserActionRequests = this.instance.listUserActionRequests.bind(this.instance);
  listUserActionRequestsForInstance = this.instance.listUserActionRequestsForInstance.bind(this.instance);
  onInputRequired = this.instance.onInputRequired.bind(this.instance);
  respondToInputRequired = this.instance.respondToInputRequired.bind(this.instance);
  loadOlderMessages = this.instance.loadOlderMessages.bind(this.instance);
  compactInstance = this.instance.compactInstance.bind(this.instance);
  onCompactStatus = this.instance.onCompactStatus.bind(this.instance);
  onContextWarning = this.instance.onContextWarning.bind(this.instance);
  onOrchestrationActivity = this.instance.onOrchestrationActivity.bind(this.instance);

  // ============================================
  // Provider Service Methods
  // ============================================

  detectClis = this.provider.detectClis.bind(this.provider);
  detectOneCli = this.provider.detectOneCli.bind(this.provider);
  checkCli = this.provider.checkCli.bind(this.provider);
  testCliConnection = this.provider.testCliConnection.bind(this.provider);
  listCopilotModels = this.provider.listCopilotModels.bind(this.provider);
  listProviders = this.provider.listProviders.bind(this.provider);
  getProviderStatus = this.provider.getProviderStatus.bind(this.provider);
  getAllProviderStatus = this.provider.getAllProviderStatus.bind(this.provider);
  updateProviderConfig = this.provider.updateProviderConfig.bind(this.provider);
  pluginsDiscover = this.provider.pluginsDiscover.bind(this.provider);
  pluginsLoad = this.provider.pluginsLoad.bind(this.provider);
  pluginsUnload = this.provider.pluginsUnload.bind(this.provider);
  pluginsInstall = this.provider.pluginsInstall.bind(this.provider);
  pluginsUninstall = this.provider.pluginsUninstall.bind(this.provider);
  pluginsGetLoaded = this.provider.pluginsGetLoaded.bind(this.provider);
  pluginsCreateTemplate = this.provider.pluginsCreateTemplate.bind(this.provider);

  // ============================================
  // Settings Service Methods
  // ============================================

  getSettings = this.settings.getSettings.bind(this.settings);
  setSetting = this.settings.setSetting.bind(this.settings);
  updateSettings = this.settings.updateSettings.bind(this.settings);
  onSettingsChanged = this.settings.onSettingsChanged.bind(this.settings);
  resolveConfig = this.settings.resolveConfig.bind(this.settings);
  getProjectConfig = this.settings.getProjectConfig.bind(this.settings);
  saveProjectConfig = this.settings.saveProjectConfig.bind(this.settings);
  createProjectConfig = this.settings.createProjectConfig.bind(this.settings);
  findProjectConfig = this.settings.findProjectConfig.bind(this.settings);
  remoteConfigFetch = this.settings.remoteConfigFetch.bind(this.settings);
  remoteConfigGet = this.settings.remoteConfigGet.bind(this.settings);
  remoteConfigSetSource = this.settings.remoteConfigSetSource.bind(this.settings);
  remoteConfigStatus = this.settings.remoteConfigStatus.bind(this.settings);
  onRemoteConfigUpdated = this.settings.onRemoteConfigUpdated.bind(this.settings);
  onRemoteConfigError = this.settings.onRemoteConfigError.bind(this.settings);

  // ============================================
  // File Service Methods
  // ============================================

  selectFolder = this.file.selectFolder.bind(this.file);
  selectFiles = this.file.selectFiles.bind(this.file);
  readDir = this.file.readDir.bind(this.file);
  getFileStats = this.file.getFileStats.bind(this.file);
  openPath = this.file.openPath.bind(this.file);
  revealFile = this.file.revealFile.bind(this.file);
  watcherWatch = this.file.watcherWatch.bind(this.file);
  watcherUnwatch = this.file.watcherUnwatch.bind(this.file);
  watcherGetActive = this.file.watcherGetActive.bind(this.file);
  onWatcherFileChanged = this.file.onWatcherFileChanged.bind(this.file);
  onWatcherFileAdded = this.file.onWatcherFileAdded.bind(this.file);
  onWatcherFileRemoved = this.file.onWatcherFileRemoved.bind(this.file);
  onWatcherError = this.file.onWatcherError.bind(this.file);
  editorOpen = this.file.editorOpen.bind(this.file);
  editorGetAvailable = this.file.editorGetAvailable.bind(this.file);
  editorSetDefault = this.file.editorSetDefault.bind(this.file);
  editorGetDefault = this.file.editorGetDefault.bind(this.file);
  multiEditPreview = this.file.multiEditPreview.bind(this.file);
  multiEditApply = this.file.multiEditApply.bind(this.file);

  // ============================================
  // History Service Methods
  // ============================================

  listHistory = this.history.listHistory.bind(this.history);
  loadHistoryEntry = this.history.loadHistoryEntry.bind(this.history);
  deleteHistoryEntry = this.history.deleteHistoryEntry.bind(this.history);
  restoreHistory = this.history.restoreHistory.bind(this.history);
  clearHistory = this.history.clearHistory.bind(this.history);
  forkSession = this.history.forkSession.bind(this.history);
  exportSession = this.history.exportSession.bind(this.history);
  importSession = this.history.importSession.bind(this.history);
  copySessionToClipboard = this.history.copySessionToClipboard.bind(this.history);
  saveSessionToFile = this.history.saveSessionToFile.bind(this.history);
  archiveSession = this.history.archiveSession.bind(this.history);
  archiveList = this.history.archiveList.bind(this.history);
  archiveRestore = this.history.archiveRestore.bind(this.history);
  archiveDelete = this.history.archiveDelete.bind(this.history);
  archiveSearch = this.history.archiveSearch.bind(this.history);

  // ============================================
  // VCS Service Methods
  // ============================================

  vcsIsRepo = this.vcs.vcsIsRepo.bind(this.vcs);
  vcsGetStatus = this.vcs.vcsGetStatus.bind(this.vcs);
  vcsGetBranches = this.vcs.vcsGetBranches.bind(this.vcs);
  vcsGetCommits = this.vcs.vcsGetCommits.bind(this.vcs);
  vcsGetDiff = this.vcs.vcsGetDiff.bind(this.vcs);
  vcsGetFileHistory = this.vcs.vcsGetFileHistory.bind(this.vcs);
  vcsGetFileAtCommit = this.vcs.vcsGetFileAtCommit.bind(this.vcs);
  vcsGetBlame = this.vcs.vcsGetBlame.bind(this.vcs);

  // ============================================
  // Snapshot Service Methods
  // ============================================

  snapshotTake = this.snapshot.snapshotTake.bind(this.snapshot);
  snapshotStartSession = this.snapshot.snapshotStartSession.bind(this.snapshot);
  snapshotEndSession = this.snapshot.snapshotEndSession.bind(this.snapshot);
  snapshotGetForInstance = this.snapshot.snapshotGetForInstance.bind(this.snapshot);
  snapshotGetForFile = this.snapshot.snapshotGetForFile.bind(this.snapshot);
  snapshotGetSessions = this.snapshot.snapshotGetSessions.bind(this.snapshot);
  snapshotGetContent = this.snapshot.snapshotGetContent.bind(this.snapshot);
  snapshotRevertFile = this.snapshot.snapshotRevertFile.bind(this.snapshot);
  snapshotRevertSession = this.snapshot.snapshotRevertSession.bind(this.snapshot);
  snapshotGetDiff = this.snapshot.snapshotGetDiff.bind(this.snapshot);
  snapshotDelete = this.snapshot.snapshotDelete.bind(this.snapshot);
  snapshotCleanup = this.snapshot.snapshotCleanup.bind(this.snapshot);
  snapshotGetStats = this.snapshot.snapshotGetStats.bind(this.snapshot);

  // ============================================
  // Todo Service Methods
  // ============================================

  todoGetList = this.todo.todoGetList.bind(this.todo);
  todoCreate = this.todo.todoCreate.bind(this.todo);
  todoUpdate = this.todo.todoUpdate.bind(this.todo);
  todoDelete = this.todo.todoDelete.bind(this.todo);
  todoWriteAll = this.todo.todoWriteAll.bind(this.todo);
  todoClear = this.todo.todoClear.bind(this.todo);
  todoGetCurrent = this.todo.todoGetCurrent.bind(this.todo);
  onTodoListChanged = this.todo.onTodoListChanged.bind(this.todo);

  // ============================================
  // MCP Service Methods
  // ============================================

  mcpGetState = this.mcp.mcpGetState.bind(this.mcp);
  mcpGetServers = this.mcp.mcpGetServers.bind(this.mcp);
  mcpAddServer = this.mcp.mcpAddServer.bind(this.mcp);
  mcpRemoveServer = this.mcp.mcpRemoveServer.bind(this.mcp);
  mcpConnect = this.mcp.mcpConnect.bind(this.mcp);
  mcpDisconnect = this.mcp.mcpDisconnect.bind(this.mcp);
  mcpRestart = this.mcp.mcpRestart.bind(this.mcp);
  mcpGetTools = this.mcp.mcpGetTools.bind(this.mcp);
  mcpGetResources = this.mcp.mcpGetResources.bind(this.mcp);
  mcpGetPrompts = this.mcp.mcpGetPrompts.bind(this.mcp);
  mcpCallTool = this.mcp.mcpCallTool.bind(this.mcp);
  mcpReadResource = this.mcp.mcpReadResource.bind(this.mcp);
  mcpGetPrompt = this.mcp.mcpGetPrompt.bind(this.mcp);
  mcpGetPresets = this.mcp.mcpGetPresets.bind(this.mcp);
  onMcpStateChanged = this.mcp.onMcpStateChanged.bind(this.mcp);
  onMcpServerStatusChanged = this.mcp.onMcpServerStatusChanged.bind(this.mcp);

  // ============================================
  // Hooks Service Methods
  // ============================================

  hooksList = this.hooks.hooksList.bind(this.hooks);
  hooksGet = this.hooks.hooksGet.bind(this.hooks);
  hooksCreate = this.hooks.hooksCreate.bind(this.hooks);
  hooksUpdate = this.hooks.hooksUpdate.bind(this.hooks);
  hooksDelete = this.hooks.hooksDelete.bind(this.hooks);
  hooksEvaluate = this.hooks.hooksEvaluate.bind(this.hooks);
  hooksImport = this.hooks.hooksImport.bind(this.hooks);
  hooksExport = this.hooks.hooksExport.bind(this.hooks);

  // ============================================
  // Plan Mode Service Methods
  // ============================================

  enterPlanMode = this.planMode.enterPlanMode.bind(this.planMode);
  exitPlanMode = this.planMode.exitPlanMode.bind(this.planMode);
  approvePlan = this.planMode.approvePlan.bind(this.planMode);
  updatePlanContent = this.planMode.updatePlanContent.bind(this.planMode);
  getPlanModeState = this.planMode.getPlanModeState.bind(this.planMode);

  // ============================================
  // Command Service Methods
  // ============================================

  listCommands = this.command.listCommands.bind(this.command);
  executeCommand = this.command.executeCommand.bind(this.command);
  createCommand = this.command.createCommand.bind(this.command);
  updateCommand = this.command.updateCommand.bind(this.command);
  deleteCommand = this.command.deleteCommand.bind(this.command);
  bashValidate = this.command.bashValidate.bind(this.command);
  bashGetConfig = this.command.bashGetConfig.bind(this.command);
  bashAddAllowed = this.command.bashAddAllowed.bind(this.command);
  bashAddBlocked = this.command.bashAddBlocked.bind(this.command);

  // ============================================
  // LSP Service Methods
  // ============================================

  lspGetAvailableServers = this.lsp.lspGetAvailableServers.bind(this.lsp);
  lspGetStatus = this.lsp.lspGetStatus.bind(this.lsp);
  lspGoToDefinition = this.lsp.lspGoToDefinition.bind(this.lsp);
  lspFindReferences = this.lsp.lspFindReferences.bind(this.lsp);
  lspHover = this.lsp.lspHover.bind(this.lsp);
  lspDocumentSymbols = this.lsp.lspDocumentSymbols.bind(this.lsp);
  lspWorkspaceSymbols = this.lsp.lspWorkspaceSymbols.bind(this.lsp);
  lspDiagnostics = this.lsp.lspDiagnostics.bind(this.lsp);
  lspIsAvailable = this.lsp.lspIsAvailable.bind(this.lsp);
  lspShutdown = this.lsp.lspShutdown.bind(this.lsp);

  // ============================================
  // Task Service Methods
  // ============================================

  taskGetStatus = this.task.taskGetStatus.bind(this.task);
  taskGetHistory = this.task.taskGetHistory.bind(this.task);
  taskGetByParent = this.task.taskGetByParent.bind(this.task);
  taskGetByChild = this.task.taskGetByChild.bind(this.task);
  taskCancel = this.task.taskCancel.bind(this.task);
  taskGetQueue = this.task.taskGetQueue.bind(this.task);

  // ============================================
  // Security Service Methods
  // ============================================

  securityDetectSecrets = this.security.securityDetectSecrets.bind(this.security);
  securityRedactContent = this.security.securityRedactContent.bind(this.security);
  securityCheckFile = this.security.securityCheckFile.bind(this.security);
  securityGetAuditLog = this.security.securityGetAuditLog.bind(this.security);
  securityClearAuditLog = this.security.securityClearAuditLog.bind(this.security);
  securityGetSafeEnv = this.security.securityGetSafeEnv.bind(this.security);
  securityCheckEnvVar = this.security.securityCheckEnvVar.bind(this.security);
  securityGetEnvFilterConfig = this.security.securityGetEnvFilterConfig.bind(this.security);

  // ============================================
  // Cost Service Methods
  // ============================================

  costRecordUsage = this.cost.costRecordUsage.bind(this.cost);
  costGetSummary = this.cost.costGetSummary.bind(this.cost);
  costGetHistory = this.cost.costGetHistory.bind(this.cost);
  costSetBudget = this.cost.costSetBudget.bind(this.cost);
  costGetBudgetStatus = this.cost.costGetBudgetStatus.bind(this.cost);
  onCostUsageRecorded = this.cost.onCostUsageRecorded.bind(this.cost);
  onCostBudgetWarning = this.cost.onCostBudgetWarning.bind(this.cost);
  onCostBudgetExceeded = this.cost.onCostBudgetExceeded.bind(this.cost);

  // ============================================
  // Logging Service Methods
  // ============================================

  logMessage = this.logging.logMessage.bind(this.logging);
  logGetLogs = this.logging.logGetLogs.bind(this.logging);
  logSetLevel = this.logging.logSetLevel.bind(this.logging);
  logExport = this.logging.logExport.bind(this.logging);
  logClear = this.logging.logClear.bind(this.logging);
  debugExecute = this.logging.debugExecute.bind(this.logging);
  debugGetCommands = this.logging.debugGetCommands.bind(this.logging);
  debugGetInfo = this.logging.debugGetInfo.bind(this.logging);
  debugRunDiagnostics = this.logging.debugRunDiagnostics.bind(this.logging);

  // ============================================
  // Stats Service Methods
  // ============================================

  statsRecordSessionStart = this.stats.statsRecordSessionStart.bind(this.stats);
  statsRecordSessionEnd = this.stats.statsRecordSessionEnd.bind(this.stats);
  statsRecordMessage = this.stats.statsRecordMessage.bind(this.stats);
  statsRecordToolUsage = this.stats.statsRecordToolUsage.bind(this.stats);
  statsGetStats = this.stats.statsGetStats.bind(this.stats);
  statsExport = this.stats.statsExport.bind(this.stats);

  // ============================================
  // Search Service Methods
  // ============================================

  searchSemantic = this.search.searchSemantic.bind(this.search);
  searchBuildIndex = this.search.searchBuildIndex.bind(this.search);
  searchConfigureExa = this.search.searchConfigureExa.bind(this.search);
  searchGetIndexStats = this.search.searchGetIndexStats.bind(this.search);

  // ============================================
  // Memory Service Methods (RLM, Learning, Memory-R1, Unified Memory)
  // ============================================

  rlmCreateStore = this.memory.rlmCreateStore.bind(this.memory);
  rlmAddSection = this.memory.rlmAddSection.bind(this.memory);
  rlmRemoveSection = this.memory.rlmRemoveSection.bind(this.memory);
  rlmGetStore = this.memory.rlmGetStore.bind(this.memory);
  rlmListStores = this.memory.rlmListStores.bind(this.memory);
  rlmListSections = this.memory.rlmListSections.bind(this.memory);
  rlmListSessions = this.memory.rlmListSessions.bind(this.memory);
  rlmDeleteStore = this.memory.rlmDeleteStore.bind(this.memory);
  rlmStartSession = this.memory.rlmStartSession.bind(this.memory);
  rlmEndSession = this.memory.rlmEndSession.bind(this.memory);
  rlmExecuteQuery = this.memory.rlmExecuteQuery.bind(this.memory);
  rlmGetSession = this.memory.rlmGetSession.bind(this.memory);
  rlmGetStoreStats = this.memory.rlmGetStoreStats.bind(this.memory);
  rlmGetSessionStats = this.memory.rlmGetSessionStats.bind(this.memory);
  rlmConfigure = this.memory.rlmConfigure.bind(this.memory);
  rlmRecordOutcome = this.memory.rlmRecordOutcome.bind(this.memory);
  rlmGetPatterns = this.memory.rlmGetPatterns.bind(this.memory);
  rlmGetStrategySuggestions = this.memory.rlmGetStrategySuggestions.bind(this.memory);
  learningRecordOutcome = this.memory.learningRecordOutcome.bind(this.memory);
  learningGetPatterns = this.memory.learningGetPatterns.bind(this.memory);
  learningGetSuggestions = this.memory.learningGetSuggestions.bind(this.memory);
  learningEnhancePrompt = this.memory.learningEnhancePrompt.bind(this.memory);
  memoryR1DecideOperation = this.memory.memoryR1DecideOperation.bind(this.memory);
  memoryR1ExecuteOperation = this.memory.memoryR1ExecuteOperation.bind(this.memory);
  memoryR1AddEntry = this.memory.memoryR1AddEntry.bind(this.memory);
  memoryR1DeleteEntry = this.memory.memoryR1DeleteEntry.bind(this.memory);
  memoryR1GetEntry = this.memory.memoryR1GetEntry.bind(this.memory);
  memoryR1Retrieve = this.memory.memoryR1Retrieve.bind(this.memory);
  memoryR1RecordOutcome = this.memory.memoryR1RecordOutcome.bind(this.memory);
  memoryR1GetStats = this.memory.memoryR1GetStats.bind(this.memory);
  memoryR1Save = this.memory.memoryR1Save.bind(this.memory);
  memoryR1Load = this.memory.memoryR1Load.bind(this.memory);
  memoryR1Configure = this.memory.memoryR1Configure.bind(this.memory);
  unifiedMemoryProcessInput = this.memory.unifiedMemoryProcessInput.bind(this.memory);
  unifiedMemoryRetrieve = this.memory.unifiedMemoryRetrieve.bind(this.memory);
  unifiedMemoryRecordSessionEnd = this.memory.unifiedMemoryRecordSessionEnd.bind(this.memory);
  unifiedMemoryRecordWorkflow = this.memory.unifiedMemoryRecordWorkflow.bind(this.memory);
  unifiedMemoryRecordStrategy = this.memory.unifiedMemoryRecordStrategy.bind(this.memory);
  unifiedMemoryRecordOutcome = this.memory.unifiedMemoryRecordOutcome.bind(this.memory);
  unifiedMemoryGetStats = this.memory.unifiedMemoryGetStats.bind(this.memory);
  unifiedMemoryGetSessions = this.memory.unifiedMemoryGetSessions.bind(this.memory);
  unifiedMemoryGetPatterns = this.memory.unifiedMemoryGetPatterns.bind(this.memory);
  unifiedMemoryGetWorkflows = this.memory.unifiedMemoryGetWorkflows.bind(this.memory);
  unifiedMemorySave = this.memory.unifiedMemorySave.bind(this.memory);
  unifiedMemoryLoad = this.memory.unifiedMemoryLoad.bind(this.memory);
  unifiedMemoryConfigure = this.memory.unifiedMemoryConfigure.bind(this.memory);

  // ============================================
  // Orchestration Service Methods
  // ============================================

  workflowListTemplates = this.orchestration.workflowListTemplates.bind(this.orchestration);
  workflowGetTemplate = this.orchestration.workflowGetTemplate.bind(this.orchestration);
  workflowStart = this.orchestration.workflowStart.bind(this.orchestration);
  workflowGetExecution = this.orchestration.workflowGetExecution.bind(this.orchestration);
  workflowGetByInstance = this.orchestration.workflowGetByInstance.bind(this.orchestration);
  workflowCompletePhase = this.orchestration.workflowCompletePhase.bind(this.orchestration);
  workflowSatisfyGate = this.orchestration.workflowSatisfyGate.bind(this.orchestration);
  workflowSkipPhase = this.orchestration.workflowSkipPhase.bind(this.orchestration);
  workflowCancel = this.orchestration.workflowCancel.bind(this.orchestration);
  workflowGetPromptAddition = this.orchestration.workflowGetPromptAddition.bind(this.orchestration);
  reviewListAgents = this.orchestration.reviewListAgents.bind(this.orchestration);
  reviewGetAgent = this.orchestration.reviewGetAgent.bind(this.orchestration);
  reviewStartSession = this.orchestration.reviewStartSession.bind(this.orchestration);
  reviewGetSession = this.orchestration.reviewGetSession.bind(this.orchestration);
  reviewGetIssues = this.orchestration.reviewGetIssues.bind(this.orchestration);
  reviewAcknowledgeIssue = this.orchestration.reviewAcknowledgeIssue.bind(this.orchestration);
  worktreeCreate = this.orchestration.worktreeCreate.bind(this.orchestration);
  worktreeList = this.orchestration.worktreeList.bind(this.orchestration);
  worktreeGetSession = this.orchestration.worktreeGetSession.bind(this.orchestration);
  worktreeComplete = this.orchestration.worktreeComplete.bind(this.orchestration);
  worktreePreviewMerge = this.orchestration.worktreePreviewMerge.bind(this.orchestration);
  worktreeMerge = this.orchestration.worktreeMerge.bind(this.orchestration);
  worktreeDetectConflicts = this.orchestration.worktreeDetectConflicts.bind(this.orchestration);
  worktreeSync = this.orchestration.worktreeSync.bind(this.orchestration);
  worktreeAbandon = this.orchestration.worktreeAbandon.bind(this.orchestration);
  worktreeCleanup = this.orchestration.worktreeCleanup.bind(this.orchestration);
  worktreeDelete = this.orchestration.worktreeDelete.bind(this.orchestration);
  worktreeGetStatus = this.orchestration.worktreeGetStatus.bind(this.orchestration);
  specialistList = this.orchestration.specialistList.bind(this.orchestration);
  specialistListBuiltin = this.orchestration.specialistListBuiltin.bind(this.orchestration);
  specialistListCustom = this.orchestration.specialistListCustom.bind(this.orchestration);
  specialistGet = this.orchestration.specialistGet.bind(this.orchestration);
  specialistGetByCategory = this.orchestration.specialistGetByCategory.bind(this.orchestration);
  specialistAddCustom = this.orchestration.specialistAddCustom.bind(this.orchestration);
  specialistUpdateCustom = this.orchestration.specialistUpdateCustom.bind(this.orchestration);
  specialistRemoveCustom = this.orchestration.specialistRemoveCustom.bind(this.orchestration);
  specialistRecommend = this.orchestration.specialistRecommend.bind(this.orchestration);
  specialistCreateInstance = this.orchestration.specialistCreateInstance.bind(this.orchestration);
  specialistGetInstance = this.orchestration.specialistGetInstance.bind(this.orchestration);
  specialistGetActiveInstances = this.orchestration.specialistGetActiveInstances.bind(this.orchestration);
  specialistUpdateStatus = this.orchestration.specialistUpdateStatus.bind(this.orchestration);
  specialistAddFinding = this.orchestration.specialistAddFinding.bind(this.orchestration);
  specialistUpdateMetrics = this.orchestration.specialistUpdateMetrics.bind(this.orchestration);
  specialistGetPromptAddition = this.orchestration.specialistGetPromptAddition.bind(this.orchestration);
  supervisionGetTree = this.orchestration.supervisionGetTree.bind(this.orchestration);
  supervisionGetHealth = this.orchestration.supervisionGetHealth.bind(this.orchestration);
  supervisionGetHierarchy = this.orchestration.supervisionGetHierarchy.bind(this.orchestration);
  supervisionGetAllRegistrations = this.orchestration.supervisionGetAllRegistrations.bind(this.orchestration);
  supervisionHandleFailure = this.orchestration.supervisionHandleFailure.bind(this.orchestration);
  debateStart = this.orchestration.debateStart.bind(this.orchestration);
  debateGetResult = this.orchestration.debateGetResult.bind(this.orchestration);
  debateGetActive = this.orchestration.debateGetActive.bind(this.orchestration);
  debateCancel = this.orchestration.debateCancel.bind(this.orchestration);
  debateGetStats = this.orchestration.debateGetStats.bind(this.orchestration);
  skillsDiscover = this.orchestration.skillsDiscover.bind(this.orchestration);
  skillsList = this.orchestration.skillsList.bind(this.orchestration);
  skillsGet = this.orchestration.skillsGet.bind(this.orchestration);
  skillsLoad = this.orchestration.skillsLoad.bind(this.orchestration);
  skillsUnload = this.orchestration.skillsUnload.bind(this.orchestration);
  skillsLoadReference = this.orchestration.skillsLoadReference.bind(this.orchestration);
  skillsLoadExample = this.orchestration.skillsLoadExample.bind(this.orchestration);
  skillsMatch = this.orchestration.skillsMatch.bind(this.orchestration);
  skillsGetMemory = this.orchestration.skillsGetMemory.bind(this.orchestration);

  // ============================================
  // Verification Service Methods
  // ============================================

  verificationVerifyMulti = this.verification.verificationVerifyMulti.bind(this.verification);
  verificationStartCli = this.verification.verificationStartCli.bind(this.verification);
  verificationCancel = this.verification.verificationCancel.bind(this.verification);
  verificationGetActive = this.verification.verificationGetActive.bind(this.verification);
  verificationGetResult = this.verification.verificationGetResult.bind(this.verification);

  // ============================================
  // Training Service Methods
  // ============================================

  trainingRecordOutcome = this.training.trainingRecordOutcome.bind(this.training);
  trainingGetStats = this.training.trainingGetStats.bind(this.training);
  trainingExportData = this.training.trainingExportData.bind(this.training);
  trainingImportData = this.training.trainingImportData.bind(this.training);
  trainingGetTrend = this.training.trainingGetTrend.bind(this.training);
  trainingGetTopStrategies = this.training.trainingGetTopStrategies.bind(this.training);
  trainingConfigure = this.training.trainingConfigure.bind(this.training);
}

/**
 * ElectronIpcService - Backwards compatibility alias for IpcFacadeService
 *
 * @deprecated Use domain-specific IPC service instead. Import the appropriate service
 * (e.g. InstanceIpcService, TodoIpcService, CommandIpcService, ProviderIpcService)
 * directly from '@core/services/ipc'. This alias will be removed in a future release.
 *
 * This alias allows existing code that imports ElectronIpcService to continue
 * working without changes. New code should use domain-specific services directly.
 */
export { IpcFacadeService as ElectronIpcService };
