/**
 * Child Result Storage - Persists structured child results to disk
 *
 * This service stores child results externally to prevent context overflow
 * in parent instances. Results are stored as JSON files and can be
 * retrieved selectively.
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { LLMService } from '../rlm/llm-service';
import { getLogger } from '../logging/logger';
import { getArtifactAttributionStore } from '../session/artifact-attribution-store';

const logger = getLogger('ChildResultStorage');
import type {
  ChildResult,
  ChildResultSummary,
  ChildArtifact,
  ArtifactType,
  ArtifactSeverity,
  ReportResultCommand,
  ChildSummaryResponse,
  ChildArtifactsResponse,
  ChildSectionResponse,
} from '../../shared/types/child-result.types';
import type { OutputMessage } from '../../shared/types/instance.types';

/**
 * Configuration for the storage service
 */
export interface ChildResultStorageConfig {
  storagePath?: string;
  maxResultAge?: number; // Max age in ms before cleanup (default: 24 hours)
  maxStorageSize?: number; // Max total storage in bytes (default: 100MB)
  summaryTargetTokens?: number; // Target tokens for auto-generated summaries
}

const DEFAULT_CONFIG: Required<ChildResultStorageConfig> = {
  storagePath: '', // Set in constructor
  maxResultAge: 24 * 60 * 60 * 1000, // 24 hours
  maxStorageSize: 100 * 1024 * 1024, // 100MB
  summaryTargetTokens: 300,
};

const BROWSER_EVIDENCE_FILE_PATTERN =
  /(?:^|[\s("'`])((?:\/|[A-Za-z]:[\\/])[^"'`\s]+\.(?:png|jpe?g|webp|gif|log|txt|json|har|trace|zip))(?:$|[\s)"'`])/g;

function getUserDataPath(): string {
  const electronApp = app as { getPath?: (name: string) => string } | undefined;
  return typeof electronApp?.getPath === 'function'
    ? electronApp.getPath('userData')
    : path.join(os.tmpdir(), 'ai-orchestrator');
}

export class ChildResultStorage {
  private static instance: ChildResultStorage | null = null;
  private config: Required<ChildResultStorageConfig>;
  private results: Map<string, ChildResult> = new Map();
  private childToResult: Map<string, string> = new Map(); // childId -> resultId
  private parentToResults: Map<string, string[]> = new Map(); // parentId -> resultIds
  private initialized = false;
  private llmService: LLMService;

  private constructor(config: ChildResultStorageConfig = {}) {
    const storagePath = config.storagePath || path.join(getUserDataPath(), 'child-results');
    this.config = { ...DEFAULT_CONFIG, ...config, storagePath };
    this.llmService = LLMService.getInstance();
  }

  static getInstance(config?: ChildResultStorageConfig): ChildResultStorage {
    if (!this.instance) {
      this.instance = new ChildResultStorage(config);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Initialize the storage directory
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.config.storagePath, { recursive: true });
      await this.loadIndex();
      this.initialized = true;
      logger.info('Initialized', { storagePath: this.config.storagePath });
    } catch (error) {
      logger.error('Failed to initialize', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Store a structured result from a child
   */
  async storeResult(
    childId: string,
    parentId: string,
    taskDescription: string,
    command: ReportResultCommand,
    outputBuffer: OutputMessage[],
    startTime: number
  ): Promise<ChildResult> {
    await this.ensureInitialized();

    const resultId = `result-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const completedAt = Date.now();

    // Generate artifacts with IDs
    const artifacts: ChildArtifact[] = (command.artifacts || []).map((a, i) => ({
      id: `artifact-${i}`,
      type: a.type,
      severity: a.severity,
      title: a.title,
      content: a.content,
      file: a.file,
      lines: a.lines,
      metadata: a.metadata,
      timestamp: completedAt,
    }));

    // Save full transcript to file
    const transcriptPath = path.join(this.config.storagePath, `${resultId}-transcript.json`);
    const transcript = outputBuffer.map((m) => ({
      type: m.type,
      content: m.content,
      timestamp: m.timestamp,
    }));
    await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 2));

    // Calculate token counts
    const fullTranscriptText = outputBuffer.map((m) => m.content).join('\n');
    const fullTranscriptTokens = this.llmService.countTokens(fullTranscriptText);
    const summaryTokens = this.llmService.countTokens(command.summary);

    // Build the result object
    const result: ChildResult = {
      id: resultId,
      childId,
      parentId,
      taskDescription,
      summary: command.summary,
      summaryTokens,
      artifacts,
      artifactCount: artifacts.length,
      conclusions: command.conclusions || [],
      keyDecisions: command.keyDecisions || [],
      fullTranscriptRef: transcriptPath,
      fullTranscriptTokens,
      success: command.success !== false,
      completedAt,
      duration: completedAt - startTime,
      tokensUsed: fullTranscriptTokens,
    };

    // Save result metadata
    const resultPath = path.join(this.config.storagePath, `${resultId}.json`);
    await fs.writeFile(resultPath, JSON.stringify(result, null, 2));
    this.registerArtifacts(result, resultPath, transcriptPath);

    // Update in-memory indexes
    this.results.set(resultId, result);
    this.childToResult.set(childId, resultId);
    const parentResults = this.parentToResults.get(parentId) || [];
    parentResults.push(resultId);
    this.parentToResults.set(parentId, parentResults);

    // Save index
    await this.saveIndex();

    logger.info('Stored result', {
      resultId,
      childId,
      artifactCount: artifacts.length,
      summaryTokens,
      fullTranscriptTokens,
    });

    return result;
  }

  private registerArtifacts(result: ChildResult, resultPath: string, transcriptPath: string): void {
    try {
      const registry = getArtifactAttributionStore();
      registry.registerArtifact({
        ownerType: 'child_result',
        ownerId: result.id,
        kind: 'child_result_json',
        path: resultPath,
        protected: true,
      });
      registry.registerArtifact({
        ownerType: 'child_result',
        ownerId: result.id,
        kind: 'child_transcript',
        path: transcriptPath,
      });
      for (const artifact of result.artifacts) {
        const artifactPath = typeof artifact.metadata?.['screenshotPath'] === 'string'
          ? artifact.metadata['screenshotPath']
          : typeof artifact.metadata?.['consolePath'] === 'string'
            ? artifact.metadata['consolePath']
            : typeof artifact.metadata?.['networkPath'] === 'string'
              ? artifact.metadata['networkPath']
              : typeof artifact.metadata?.['tracePath'] === 'string'
                ? artifact.metadata['tracePath']
                : artifact.file;
        if (artifactPath) {
          registry.registerArtifact({
            ownerType: 'child_result',
            ownerId: result.id,
            kind: artifact.type,
            path: artifactPath,
            metadata: { artifactId: artifact.id, childId: result.childId },
          });
        }
      }
    } catch (error) {
      logger.warn('Failed to register child result artifacts', {
        resultId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Store a result from the existing report_task_complete flow
   * This auto-generates a structured result from the output buffer
   */
  async storeFromOutputBuffer(
    childId: string,
    parentId: string,
    taskDescription: string,
    summary: string,
    success: boolean,
    outputBuffer: OutputMessage[],
    startTime: number
  ): Promise<ChildResult> {
    // Extract artifacts from output buffer
    const artifacts = this.extractArtifactsFromOutput(outputBuffer);

    // Extract conclusions from assistant messages
    const conclusions = this.extractConclusionsFromOutput(outputBuffer);

    const command: ReportResultCommand = {
      action: 'report_result',
      summary,
      success,
      artifacts,
      conclusions,
      keyDecisions: [],
    };

    return this.storeResult(childId, parentId, taskDescription, command, outputBuffer, startTime);
  }

  /**
   * Get the summary for a child's result
   */
  async getChildSummary(childId: string): Promise<ChildSummaryResponse | null> {
    await this.ensureInitialized();

    const resultId = this.childToResult.get(childId);
    if (!resultId) return null;

    const result = await this.loadResult(resultId);
    if (!result) return null;

    const artifactTypes = [...new Set(result.artifacts.map((a) => a.type))];

    return {
      resultId: result.id,
      childId: result.childId,
      summary: result.summary,
      success: result.success,
      artifactCount: result.artifactCount,
      artifactTypes,
      conclusions: result.conclusions,
      hasMoreDetails: result.artifactCount > 0 || result.fullTranscriptTokens > 0,
      commands: {
        getArtifacts: `{"action": "get_child_artifacts", "childId": "${childId}"}`,
        getDecisions: `{"action": "get_child_section", "childId": "${childId}", "section": "decisions"}`,
        getFull: `{"action": "get_child_section", "childId": "${childId}", "section": "full"}`,
      },
    };
  }

  /**
   * Get artifacts for a child's result
   */
  async getChildArtifacts(
    childId: string,
    types?: ArtifactType[],
    severities?: ArtifactSeverity[],
    limit?: number
  ): Promise<ChildArtifactsResponse | null> {
    await this.ensureInitialized();

    const resultId = this.childToResult.get(childId);
    if (!resultId) return null;

    const result = await this.loadResult(resultId);
    if (!result) return null;

    let artifacts = result.artifacts;

    // Apply filters
    if (types && types.length > 0) {
      artifacts = artifacts.filter((a) => types.includes(a.type));
    }
    if (severities && severities.length > 0) {
      artifacts = artifacts.filter((a) => a.severity && severities.includes(a.severity));
    }

    const total = result.artifacts.length;
    const filtered = artifacts.length;

    // Apply limit
    const limitedArtifacts = limit ? artifacts.slice(0, limit) : artifacts;

    return {
      childId,
      artifacts: limitedArtifacts,
      total,
      filtered,
      hasMore: limitedArtifacts.length < filtered,
    };
  }

  /**
   * Get a specific section of the child's result
   */
  async getChildSection(
    childId: string,
    section: 'conclusions' | 'decisions' | 'artifacts' | 'full',
    artifactId?: string,
    includeContext?: boolean
  ): Promise<ChildSectionResponse | null> {
    await this.ensureInitialized();

    const resultId = this.childToResult.get(childId);
    if (!resultId) return null;

    const result = await this.loadResult(resultId);
    if (!result) return null;

    let content: string;
    let tokenCount: number;

    switch (section) {
      case 'conclusions':
        content = result.conclusions.length > 0 ? result.conclusions.join('\n\n') : 'No conclusions recorded.';
        tokenCount = this.llmService.countTokens(content);
        break;

      case 'decisions':
        content =
          result.keyDecisions.length > 0 ? result.keyDecisions.join('\n\n') : 'No key decisions recorded.';
        tokenCount = this.llmService.countTokens(content);
        break;

      case 'artifacts':
        if (artifactId) {
          const artifact = result.artifacts.find((a) => a.id === artifactId);
          if (!artifact) {
            content = `Artifact ${artifactId} not found.`;
          } else {
            content = this.formatArtifact(artifact, includeContext);
          }
        } else {
          content = result.artifacts.map((a) => this.formatArtifact(a, false)).join('\n\n---\n\n');
        }
        tokenCount = this.llmService.countTokens(content);
        break;

      case 'full':
        try {
          const transcriptData = await fs.readFile(result.fullTranscriptRef, 'utf-8');
          const transcript = JSON.parse(transcriptData) as Array<{
            type: string;
            content: string;
            timestamp: number;
          }>;
          content = transcript.map((m) => `[${m.type}] ${m.content}`).join('\n\n');
          tokenCount = result.fullTranscriptTokens;
        } catch {
          content = 'Full transcript not available.';
          tokenCount = 0;
        }
        break;
    }

    return {
      childId,
      section,
      content,
      tokenCount,
    };
  }

  /**
   * Check if a child has a stored result
   */
  hasResult(childId: string): boolean {
    return this.childToResult.has(childId);
  }

  /**
   * Get all stored results for a parent
   */
  async getResultsForParent(parentId: string): Promise<ChildResult[]> {
    await this.ensureInitialized();

    let resultIds = this.parentToResults.get(parentId) || [];

    if (resultIds.length === 0) {
      resultIds = await this.rebuildParentIndex(parentId);
    }

    const loaded = await Promise.all(resultIds.map((resultId) => this.loadResult(resultId)));

    return loaded
      .filter((result): result is ChildResult => result !== null)
      .sort((a, b) => b.completedAt - a.completedAt);
  }

  /**
   * Get result ID for a child
   */
  getResultId(childId: string): string | undefined {
    return this.childToResult.get(childId);
  }

  /**
   * Clean up old results
   */
  async cleanup(): Promise<number> {
    await this.ensureInitialized();

    const now = Date.now();
    let cleaned = 0;

    for (const [resultId, result] of this.results) {
      if (now - result.completedAt > this.config.maxResultAge) {
        await this.deleteResult(resultId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      await this.saveIndex();
      logger.info('Cleaned up old results', { count: cleaned });
    }

    return cleaned;
  }

  // ============================================
  // Private Methods
  // ============================================

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  private async loadResult(resultId: string): Promise<ChildResult | null> {
    // Check in-memory cache first
    if (this.results.has(resultId)) {
      return this.results.get(resultId)!;
    }

    // Load from disk
    const resultPath = path.join(this.config.storagePath, `${resultId}.json`);
    try {
      const data = await fs.readFile(resultPath, 'utf-8');
      const result = JSON.parse(data) as ChildResult;
      this.results.set(resultId, result);
      return result;
    } catch {
      return null;
    }
  }

  private async deleteResult(resultId: string): Promise<void> {
    const result = this.results.get(resultId);
    if (result) {
      this.childToResult.delete(result.childId);
      const parentResults = this.parentToResults.get(result.parentId);
      if (parentResults) {
        const remaining = parentResults.filter((id) => id !== resultId);
        if (remaining.length > 0) {
          this.parentToResults.set(result.parentId, remaining);
        } else {
          this.parentToResults.delete(result.parentId);
        }
      }
    }
    this.results.delete(resultId);

    // Delete files
    try {
      await fs.unlink(path.join(this.config.storagePath, `${resultId}.json`));
      await fs.unlink(path.join(this.config.storagePath, `${resultId}-transcript.json`));
    } catch {
      /* intentionally ignored: files may not exist if result was never written */
    }
  }

  private async loadIndex(): Promise<void> {
    const indexPath = path.join(this.config.storagePath, 'index.json');
    try {
      const data = await fs.readFile(indexPath, 'utf-8');
      const index = JSON.parse(data) as {
        childToResult: Record<string, string>;
        parentToResults?: Record<string, string[]>;
      };
      this.childToResult = new Map(Object.entries(index.childToResult));
      this.parentToResults = new Map(
        Object.entries(index.parentToResults || {}).map(([parentId, resultIds]) => [
          parentId,
          Array.isArray(resultIds) ? resultIds : [],
        ]),
      );
    } catch {
      // No index file yet
      this.childToResult = new Map();
      this.parentToResults = new Map();
    }
  }

  private async saveIndex(): Promise<void> {
    const indexPath = path.join(this.config.storagePath, 'index.json');
    const index = {
      childToResult: Object.fromEntries(this.childToResult),
      parentToResults: Object.fromEntries(this.parentToResults),
    };
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
  }

  private async rebuildParentIndex(parentId: string): Promise<string[]> {
    const resultIds: string[] = [];

    try {
      const files = await fs.readdir(this.config.storagePath);
      for (const file of files) {
        if (!file.endsWith('.json') || file === 'index.json' || file.endsWith('-transcript.json')) {
          continue;
        }

        const resultId = file.replace(/\.json$/, '');
        const result = await this.loadResult(resultId);
        if (!result || result.parentId !== parentId) {
          continue;
        }

        resultIds.push(result.id);
      }
    } catch {
      return [];
    }

    if (resultIds.length > 0) {
      this.parentToResults.set(parentId, resultIds);
      await this.saveIndex();
    }

    return resultIds;
  }

  private formatArtifact(artifact: ChildArtifact, includeContext?: boolean): string {
    const parts: string[] = [];

    // Header
    const severityBadge = artifact.severity ? `[${artifact.severity.toUpperCase()}]` : '';
    const title = artifact.title || artifact.type;
    parts.push(`## ${severityBadge} ${title}`);

    // Location
    if (artifact.file) {
      const location = artifact.lines ? `${artifact.file}:${artifact.lines}` : artifact.file;
      parts.push(`**Location:** \`${location}\``);
    }

    // Content
    if (artifact.type === 'code_snippet') {
      parts.push('```');
      parts.push(artifact.content);
      parts.push('```');
    } else {
      parts.push(artifact.content);
    }

    // Metadata
    if (includeContext && artifact.metadata) {
      parts.push('\n**Metadata:**');
      parts.push('```json');
      parts.push(JSON.stringify(artifact.metadata, null, 2));
      parts.push('```');
    }

    return parts.join('\n');
  }

  /**
   * Extract artifacts from output buffer automatically
   */
  private extractArtifactsFromOutput(
    outputBuffer: OutputMessage[]
  ): ReportResultCommand['artifacts'] {
    const artifacts: ReportResultCommand['artifacts'] = [];
    const seenEvidencePaths = new Set<string>();

    for (const msg of outputBuffer) {
      // Extract file references from tool results
      if (msg.type === 'tool_result' && msg.content.includes(':')) {
        const fileMatch = msg.content.match(/([^\s]+\.(ts|js|tsx|jsx|py|go|rs|java|c|cpp|h|hpp|md|json|yaml|yml)):(\d+)/);
        if (fileMatch) {
          artifacts.push({
            type: 'file_reference',
            content: `Referenced in analysis`,
            file: fileMatch[1],
            lines: fileMatch[3],
          });
        }
      }

      // Extract errors
      if (msg.type === 'error') {
        artifacts.push({
          type: 'error',
          severity: 'high',
          content: msg.content,
        });
      }

      // Extract code snippets from assistant messages
      if (msg.type === 'assistant') {
        const codeBlocks = msg.content.match(/```[\s\S]*?```/g);
        if (codeBlocks) {
          for (const block of codeBlocks.slice(0, 3)) {
            // Limit to 3 code blocks
            artifacts.push({
              type: 'code_snippet',
              content: block.replace(/```\w*\n?/g, '').replace(/```$/g, ''),
            });
          }
        }
      }

      artifacts.push(...this.extractBrowserEvidenceArtifacts(msg, seenEvidencePaths));
    }

    return artifacts.slice(0, 10); // Limit total artifacts
  }

  private extractBrowserEvidenceArtifacts(
    message: OutputMessage,
    seenEvidencePaths: Set<string>,
  ): NonNullable<ReportResultCommand['artifacts']> {
    const artifacts: NonNullable<ReportResultCommand['artifacts']> = [];

    let match: RegExpExecArray | null;
    BROWSER_EVIDENCE_FILE_PATTERN.lastIndex = 0;
    match = BROWSER_EVIDENCE_FILE_PATTERN.exec(message.content);

    while (match) {
      const candidate = match[1];
      const resolved = path.resolve(candidate);
      if (seenEvidencePaths.has(resolved)) {
        match = BROWSER_EVIDENCE_FILE_PATTERN.exec(message.content);
        continue;
      }

      const type = this.classifyBrowserEvidenceArtifact(resolved);
      if (type) {
        seenEvidencePaths.add(resolved);
        artifacts.push({
          type,
          severity: type === 'network_error_summary' ? 'medium' : 'info',
          title: path.basename(resolved),
          content: this.summarizeEvidenceMessage(message.content, resolved),
          file: resolved,
          metadata: this.buildBrowserEvidenceMetadata(type, resolved, message),
        });
      }

      match = BROWSER_EVIDENCE_FILE_PATTERN.exec(message.content);
    }

    if (artifacts.length === 0 && /network error|request failed|console error/i.test(message.content)) {
      artifacts.push({
        type: /network error|request failed/i.test(message.content)
          ? 'network_error_summary'
          : 'console_log_excerpt',
        severity: 'medium',
        content: message.content.slice(0, 800),
        metadata: {
          sourceMessageType: message.type,
        },
      });
    }

    return artifacts;
  }

  private classifyBrowserEvidenceArtifact(filePath: string): ArtifactType | null {
    const extension = path.extname(filePath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extension)) {
      return 'screenshot';
    }
    if (extension === '.har') {
      return 'network_error_summary';
    }
    if (['.trace', '.zip'].includes(extension)) {
      return 'trace_reference';
    }
    if (['.log', '.txt', '.json'].includes(extension)) {
      return 'console_log_excerpt';
    }
    return null;
  }

  private summarizeEvidenceMessage(content: string, evidencePath: string): string {
    const basename = path.basename(evidencePath);
    const normalized = content.split(evidencePath).join(basename).trim();
    return normalized.length > 800 ? `${normalized.slice(0, 797)}...` : normalized;
  }

  private buildBrowserEvidenceMetadata(
    type: ArtifactType,
    evidencePath: string,
    message: OutputMessage,
  ): Record<string, unknown> {
    const metadata: Record<string, unknown> = {
      path: evidencePath,
      sourceMessageType: message.type,
    };

    switch (type) {
      case 'screenshot':
        metadata['screenshotPath'] = evidencePath;
        break;
      case 'console_log_excerpt':
        metadata['consolePath'] = evidencePath;
        break;
      case 'network_error_summary':
        metadata['networkPath'] = evidencePath;
        break;
      case 'trace_reference':
        metadata['tracePath'] = evidencePath;
        break;
      default:
        break;
    }

    return metadata;
  }

  /**
   * Extract conclusions from the final assistant messages
   */
  private extractConclusionsFromOutput(outputBuffer: OutputMessage[]): string[] {
    const conclusions: string[] = [];

    // Look at the last few assistant messages
    const assistantMessages = outputBuffer
      .filter((m) => m.type === 'assistant')
      .slice(-3);

    for (const msg of assistantMessages) {
      // Look for bullet points or numbered lists that might be conclusions
      const bulletPoints = msg.content.match(/^[\s]*[-*•]\s+.+$/gm);
      if (bulletPoints) {
        conclusions.push(...bulletPoints.slice(0, 5).map((p) => p.trim()));
      }
    }

    return conclusions.slice(0, 5); // Limit to 5 conclusions
  }
}

/**
 * Get the singleton instance
 */
export function getChildResultStorage(config?: ChildResultStorageConfig): ChildResultStorage {
  return ChildResultStorage.getInstance(config);
}
