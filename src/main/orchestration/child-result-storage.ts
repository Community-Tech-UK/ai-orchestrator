/**
 * Child Result Storage - Persists structured child results to disk
 *
 * This service stores child results externally to prevent context overflow
 * in parent instances. Results are stored as JSON files and can be
 * retrieved selectively.
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { LLMService } from '../rlm/llm-service';
import { getLogger } from '../logging/logger';

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

export class ChildResultStorage {
  private static instance: ChildResultStorage;
  private config: Required<ChildResultStorageConfig>;
  private results: Map<string, ChildResult> = new Map();
  private childToResult: Map<string, string> = new Map(); // childId -> resultId
  private initialized = false;
  private llmService: LLMService;

  private constructor(config: ChildResultStorageConfig = {}) {
    const storagePath = config.storagePath || path.join(app.getPath('userData'), 'child-results');
    this.config = { ...DEFAULT_CONFIG, ...config, storagePath };
    this.llmService = LLMService.getInstance();
  }

  static getInstance(config?: ChildResultStorageConfig): ChildResultStorage {
    if (!this.instance) {
      this.instance = new ChildResultStorage(config);
    }
    return this.instance;
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

    // Update in-memory indexes
    this.results.set(resultId, result);
    this.childToResult.set(childId, resultId);

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
      const index = JSON.parse(data) as { childToResult: Record<string, string> };
      this.childToResult = new Map(Object.entries(index.childToResult));
    } catch {
      // No index file yet
      this.childToResult = new Map();
    }
  }

  private async saveIndex(): Promise<void> {
    const indexPath = path.join(this.config.storagePath, 'index.json');
    const index = {
      childToResult: Object.fromEntries(this.childToResult),
    };
    await fs.writeFile(indexPath, JSON.stringify(index, null, 2));
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
    }

    return artifacts.slice(0, 10); // Limit total artifacts
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
