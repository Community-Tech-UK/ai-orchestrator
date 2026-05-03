/**
 * Memory IPC Service - Memory, RLM, and unified memory operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  ProjectCodeIndexRefreshRequest,
  ProjectKnowledgeEvidenceRequest,
  ProjectKnowledgeReadModelRequest,
} from '../../../../../shared/types/knowledge-graph.types';

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = (): void => {};

@Injectable({ providedIn: 'root' })
export class MemoryIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // RLM Context
  // ============================================

  /**
   * Create or fetch a context store
   */
  async rlmCreateStore(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmCreateStore(instanceId);
  }

  /**
   * Add a section to a context store
   */
  async rlmAddSection(payload: {
    storeId: string;
    type: 'file' | 'conversation' | 'tool_output' | 'external' | 'summary';
    name: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmAddSection(payload);
  }

  /**
   * Remove a section from a context store
   */
  async rlmRemoveSection(payload: { storeId: string; sectionId: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmRemoveSection(payload);
  }

  /**
   * Get a context store
   */
  async rlmGetStore(storeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStore(storeId);
  }

  /**
   * List context stores
   */
  async rlmListStores(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListStores();
  }

  /**
   * List sections in a store
   */
  async rlmListSections(storeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListSections(storeId);
  }

  /**
   * List active RLM sessions
   */
  async rlmListSessions(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmListSessions();
  }

  /**
   * Delete a context store
   */
  async rlmDeleteStore(storeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmDeleteStore(storeId);
  }

  /**
   * Start an RLM session
   */
  async rlmStartSession(payload: { storeId: string; instanceId: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmStartSession(payload);
  }

  /**
   * End an RLM session
   */
  async rlmEndSession(sessionId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmEndSession(sessionId);
  }

  /**
   * Execute an RLM query
   */
  async rlmExecuteQuery(payload: {
    sessionId: string;
    query: { type: string; params: Record<string, unknown> };
    depth?: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmExecuteQuery(payload);
  }

  /**
   * Get an RLM session
   */
  async rlmGetSession(sessionId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetSession(sessionId);
  }

  /**
   * Get RLM store stats
   */
  async rlmGetStoreStats(storeId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStoreStats(storeId);
  }

  /**
   * Get RLM session stats
   */
  async rlmGetSessionStats(sessionId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetSessionStats(sessionId);
  }

  /**
   * Configure RLM
   */
  async rlmConfigure(config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmConfigure(config);
  }

  /**
   * Record task outcome for RLM
   */
  async rlmRecordOutcome(payload: {
    instanceId: string;
    taskType: string;
    taskDescription: string;
    prompt: string;
    context?: string;
    agentUsed: string;
    modelUsed: string;
    workflowUsed?: string;
    toolsUsed: { tool: string; count: number; avgDuration: number; errorCount: number }[];
    tokensUsed: number;
    duration: number;
    success: boolean;
    completionScore?: number;
    userSatisfaction?: number;
    errorType?: string;
    errorMessage?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmRecordOutcome(payload);
  }

  /**
   * Get RLM learned patterns
   */
  async rlmGetPatterns(minSuccessRate?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetPatterns(minSuccessRate);
  }

  /**
   * Get RLM strategy suggestions
   */
  async rlmGetStrategySuggestions(context: string, maxSuggestions?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rlmGetStrategySuggestions(context, maxSuggestions);
  }

  // ============================================
  // Learning
  // ============================================

  /**
   * Record learning outcome
   */
  async learningRecordOutcome(payload: {
    instanceId: string;
    taskType: string;
    taskDescription: string;
    prompt: string;
    context?: string;
    agentUsed: string;
    modelUsed: string;
    workflowUsed?: string;
    toolsUsed: { tool: string; count: number; avgDuration: number; errorCount: number }[];
    tokensUsed: number;
    duration: number;
    success: boolean;
    completionScore?: number;
    userSatisfaction?: number;
    errorType?: string;
    errorMessage?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningRecordOutcome(payload);
  }

  /**
   * Get learning patterns
   */
  async learningGetPatterns(minSuccessRate?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningGetPatterns(minSuccessRate);
  }

  /**
   * Get learning suggestions
   */
  async learningGetSuggestions(context: string, maxSuggestions?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningGetSuggestions(context, maxSuggestions);
  }

  /**
   * Enhance prompt with learning
   */
  async learningEnhancePrompt(prompt: string, context: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.learningEnhancePrompt(prompt, context);
  }

  // ============================================
  // Memory-R1
  // ============================================

  /**
   * Memory-R1: Decide what operation to perform
   */
  async memoryR1DecideOperation(payload: {
    context: string;
    candidateContent: string;
    taskId: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1DecideOperation(payload);
  }

  /**
   * Memory-R1: Execute a decided operation
   */
  async memoryR1ExecuteOperation(decision: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1ExecuteOperation(decision);
  }

  /**
   * Memory-R1: Add entry directly
   */
  async memoryR1AddEntry(payload: {
    content: string;
    reason: string;
    sourceType?: string;
    sourceSessionId?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1AddEntry(payload);
  }

  /**
   * Memory-R1: Delete entry
   */
  async memoryR1DeleteEntry(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1DeleteEntry(entryId);
  }

  /**
   * Memory-R1: Get entry
   */
  async memoryR1GetEntry(entryId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1GetEntry(entryId);
  }

  /**
   * Memory-R1: Retrieve memories
   */
  async memoryR1Retrieve(payload: { query: string; taskId: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Retrieve(payload);
  }

  /**
   * Memory-R1: Record task outcome
   */
  async memoryR1RecordOutcome(payload: {
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1RecordOutcome(payload);
  }

  /**
   * Memory-R1: Get stats
   */
  async memoryR1GetStats(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1GetStats();
  }

  /**
   * Memory-R1: Save state
   */
  async memoryR1Save(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Save();
  }

  /**
   * Memory-R1: Load state
   */
  async memoryR1Load(snapshot: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Load(snapshot);
  }

  /**
   * Memory-R1: Configure
   */
  async memoryR1Configure(config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.memoryR1Configure(config);
  }

  // ============================================
  // Unified Memory
  // ============================================

  /**
   * Unified Memory: Process input
   */
  async unifiedMemoryProcessInput(payload: {
    input: string;
    sessionId: string;
    taskId: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryProcessInput(payload);
  }

  /**
   * Unified Memory: Retrieve
   */
  async unifiedMemoryRetrieve(payload: {
    query: string;
    taskId: string;
    options?: { types?: string[]; maxTokens?: number; sessionId?: string; instanceId?: string };
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRetrieve(payload);
  }

  /**
   * Unified Memory: Record session end
   */
  async unifiedMemoryRecordSessionEnd(payload: {
    sessionId: string;
    outcome: string;
    summary: string;
    lessons: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordSessionEnd(payload);
  }

  /**
   * Unified Memory: Record workflow
   */
  async unifiedMemoryRecordWorkflow(payload: {
    name: string;
    steps: string[];
    applicableContexts: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordWorkflow(payload);
  }

  /**
   * Unified Memory: Record strategy
   */
  async unifiedMemoryRecordStrategy(payload: {
    strategy: string;
    conditions: string[];
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordStrategy(payload);
  }

  /**
   * Unified Memory: Record outcome
   */
  async unifiedMemoryRecordOutcome(payload: {
    taskId: string;
    success: boolean;
    score: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryRecordOutcome(payload);
  }

  /**
   * Unified Memory: Get stats
   */
  async unifiedMemoryGetStats(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetStats();
  }

  /**
   * Unified Memory: Get sessions
   */
  async unifiedMemoryGetSessions(limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetSessions(limit);
  }

  /**
   * Unified Memory: Get patterns
   */
  async unifiedMemoryGetPatterns(minSuccessRate?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetPatterns(minSuccessRate);
  }

  /**
   * Unified Memory: Get workflows
   */
  async unifiedMemoryGetWorkflows(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryGetWorkflows();
  }

  /**
   * Unified Memory: Save state
   */
  async unifiedMemorySave(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemorySave();
  }

  /**
   * Unified Memory: Load state
   */
  async unifiedMemoryLoad(snapshot: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryLoad(snapshot);
  }

  /**
   * Unified Memory: Configure
   */
  async unifiedMemoryConfigure(config: Record<string, unknown>): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.unifiedMemoryConfigure(config);
  }

  // ============================================
  // Memory Stats & Monitoring
  // ============================================

  async getMemoryStats(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getMemoryStats();
  }

  onMemoryStatsUpdate(callback: (stats: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onMemoryStatsUpdate(callback);
  }

  onMemoryWarning(callback: (warning: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onMemoryWarning(callback);
  }

  onMemoryCritical(callback: (alert: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onMemoryCritical(callback);
  }

  // ============================================
  // Knowledge Graph
  // ============================================

  async kgAddFact(payload: {
    subject: string;
    predicate: string;
    object: string;
    confidence?: number;
    sourceFile?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgAddFact(payload);
  }

  async kgInvalidateFact(payload: {
    subject: string;
    predicate: string;
    object?: string;
    ended?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgInvalidateFact(payload);
  }

  async kgQueryEntity(payload: {
    entityName: string;
    direction?: string;
    asOf?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgQueryEntity(payload);
  }

  async kgQueryRelationship(payload: {
    predicate: string;
    asOf?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgQueryRelationship(payload);
  }

  async kgGetTimeline(payload: {
    entityName: string;
    limit?: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgGetTimeline(payload);
  }

  async kgGetStats(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgGetStats();
  }

  async kgAddEntity(payload: {
    name: string;
    type: string;
    properties?: Record<string, unknown>;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.kgAddEntity(payload);
  }

  // ============================================
  // Wake Context
  // ============================================

  async wakeGenerate(payload: { wing?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeGenerate(payload);
  }

  async wakeGetText(payload: { wing?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeGetText(payload);
  }

  async wakeAddHint(payload: {
    content: string;
    importance?: number;
    room?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeAddHint(payload);
  }

  async wakeRemoveHint(payload: { id: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeRemoveHint(payload);
  }

  async wakeSetIdentity(payload: { text: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeSetIdentity(payload);
  }

  async wakeListHints(payload: { room?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.wakeListHints(payload);
  }

  // ============================================
  // Codebase Mining
  // ============================================

  async codebaseMineDirectory(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseMineDirectory(payload);
  }

  async codebaseGetStatus(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseGetStatus(payload);
  }

  async codebasePauseProject(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebasePauseProject(payload);
  }

  async codebaseResumeProject(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseResumeProject(payload);
  }

  async codebaseExcludeProject(payload: { dirPath: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.codebaseExcludeProject(payload);
  }

  async projectKnowledgeListProjects(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectKnowledgeListProjects();
  }

  async projectKnowledgeGetReadModel(payload: ProjectKnowledgeReadModelRequest): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectKnowledgeGetReadModel(payload);
  }

  async projectKnowledgeGetEvidence(payload: ProjectKnowledgeEvidenceRequest): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectKnowledgeGetEvidence(payload);
  }

  async projectKnowledgeRefreshCodeIndex(payload: ProjectCodeIndexRefreshRequest): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.projectKnowledgeRefreshCodeIndex(payload);
  }

  // ============================================
  // Conversation Mining
  // ============================================

  async convoImportFile(payload: {
    filePath: string;
    wing: string;
    format?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoImportFile(payload);
  }

  async convoImportString(payload: {
    content: string;
    wing: string;
    sourceFile: string;
    format?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoImportString(payload);
  }

  async convoDetectFormat(payload: { content: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.convoDetectFormat(payload);
  }

  // ============================================
  // Knowledge Event Listeners
  // ============================================

  onKgFactAdded(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onKgFactAdded(callback);
  }

  onKgFactInvalidated(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onKgFactInvalidated(callback);
  }

  onConvoImportComplete(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onConvoImportComplete(callback);
  }

  onWakeHintAdded(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onWakeHintAdded(callback);
  }

  onWakeContextGenerated(callback: (data: unknown) => void): () => void {
    if (!this.api) return noop;
    return this.api.onWakeContextGenerated(callback);
  }
}
