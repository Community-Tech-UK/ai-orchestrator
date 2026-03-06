import * as fs from 'fs/promises';
import * as path from 'path';
import type { ChildResult } from '../../shared/types/child-result.types';
import type { ConversationData } from '../../shared/types/history.types';
import type { ExportedSession, Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  SessionShareArtifact,
  SessionShareAttachment,
  SessionShareBundle,
  SessionShareBundleSource,
  SessionShareFileSnapshotSession,
  SessionShareSnapshotSummary,
} from '../../shared/types/session-share.types';
import { getLogger } from '../logging/logger';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import { getSnapshotManager } from '../persistence/snapshot-manager';
import { redactAllSecrets, redactLogOutput } from '../security/secret-redaction';
import { getSessionContinuityManager } from './session-continuity';

const logger = getLogger('SessionShareService');

const MAX_EMBED_TEXT_BYTES = 256 * 1024;
const MAX_EMBED_BINARY_BYTES = 1 * 1024 * 1024;
const EVIDENCE_FILE_PATTERN = /(?:^|[\s("'`])((?:\/|[A-Za-z]:[\\/])[^"'`\s]+\.(?:png|jpe?g|webp|gif|json|har|log|txt|trace|zip))(?:$|[\s)"'`])/g;

const TEXT_MEDIA_TYPES = new Set([
  '.json',
  '.har',
  '.log',
  '.md',
  '.text',
  '.trace',
  '.txt',
  '.yaml',
  '.yml',
]);

const IMAGE_MEDIA_TYPES = new Map<string, string>([
  ['.gif', 'image/gif'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
]);

export interface SessionShareTarget {
  instance?: Instance;
  conversation?: ConversationData;
}

export class SessionShareService {
  private static instance: SessionShareService | null = null;

  static getInstance(): SessionShareService {
    if (!this.instance) {
      this.instance = new SessionShareService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  async createBundle(target: SessionShareTarget): Promise<SessionShareBundle> {
    if (target.instance) {
      return this.createBundleFromInstance(target.instance);
    }

    if (target.conversation) {
      return this.createBundleFromConversation(target.conversation);
    }

    throw new Error('Session share bundle generation requires an instance or a conversation.');
  }

  async saveBundle(bundle: SessionShareBundle, filePath: string): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
  }

  async loadBundle(filePath: string): Promise<SessionShareBundle> {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as SessionShareBundle;

    if (parsed.version !== '1.0' || !Array.isArray(parsed.messages)) {
      throw new Error('Invalid session share bundle.');
    }

    return parsed;
  }

  toExportedSession(
    bundle: SessionShareBundle,
    workingDirectory: string,
    displayName?: string,
  ): ExportedSession {
    return {
      version: `share-bundle:${bundle.version}`,
      exportedAt: Date.now(),
      metadata: {
        displayName: displayName || `${bundle.source.displayName} (replay)`,
        createdAt: bundle.source.createdAt || Date.now(),
        workingDirectory,
        agentId: 'build',
        agentMode: 'build',
        totalMessages: bundle.messages.length,
        contextUsage: {
          used: 0,
          total: 200000,
          percentage: 0,
        },
      },
      messages: bundle.messages.map((message) => ({
        ...message,
        attachments: message.attachments?.map((attachment) => ({
          ...attachment,
          data: '',
        })),
      })),
    };
  }

  private async createBundleFromInstance(instance: Instance): Promise<SessionShareBundle> {
    const source = this.buildSource({
      kind: 'instance',
      instanceId: instance.id,
      displayName: instance.displayName,
      workingDirectoryLabel: '<workspace>',
      createdAt: instance.createdAt,
      status: instance.status === 'terminated' || instance.status === 'error' ? 'completed' : 'active',
    });

    return this.buildBundle({
      source,
      workingDirectory: instance.workingDirectory,
      messages: instance.outputBuffer,
      parentId: instance.id,
    });
  }

  private async createBundleFromConversation(conversation: ConversationData): Promise<SessionShareBundle> {
    const entry = conversation.entry;
    const source = this.buildSource({
      kind: 'history',
      historyEntryId: entry.id,
      instanceId: entry.originalInstanceId,
      displayName: entry.displayName,
      workingDirectoryLabel: '<workspace>',
      createdAt: entry.createdAt,
      endedAt: entry.endedAt,
      status: entry.status,
    });

    return this.buildBundle({
      source,
      workingDirectory: entry.workingDirectory,
      messages: conversation.messages,
      parentId: entry.originalInstanceId,
    });
  }

  private async buildBundle(params: {
    source: SessionShareBundleSource;
    workingDirectory: string;
    messages: OutputMessage[];
    parentId: string;
  }): Promise<SessionShareBundle> {
    const sanitizedMessages = params.messages.map((message) =>
      this.sanitizeMessage(message, params.workingDirectory),
    );
    const continuitySnapshots = this.getContinuitySnapshots(params.parentId);
    const fileSnapshotSessions = this.getFileSnapshotSessions(params.parentId);
    const childResults = await getChildResultStorage().getResultsForParent(params.parentId);
    const { artifacts, evidencePaths } = this.buildArtifacts(childResults, params.workingDirectory);
    const attachments = await this.buildAttachments(
      evidencePaths.concat(this.extractEvidencePathsFromMessages(params.messages)),
      params.workingDirectory,
    );

    const warnings: string[] = [];
    if (attachments.some((attachment) => !attachment.embeddedText && !attachment.embeddedBase64)) {
      warnings.push('Some evidence files were referenced but not embedded because they were too large or unavailable.');
    }
    if (childResults.length === 0) {
      warnings.push('No structured child-result artifacts were recorded for this run.');
    }

    const summary = {
      totalMessages: sanitizedMessages.length,
      userMessages: sanitizedMessages.filter((message) => message.type === 'user').length,
      assistantMessages: sanitizedMessages.filter((message) => message.type === 'assistant').length,
      toolMessages: sanitizedMessages.filter(
        (message) => message.type === 'tool_result' || message.type === 'tool_use',
      ).length,
      artifactCount: artifacts.length,
      attachmentCount: attachments.length,
      continuitySnapshotCount: continuitySnapshots.length,
      fileSnapshotSessionCount: fileSnapshotSessions.length,
      redactedContentCount: sanitizedMessages.filter((message) => message.content.includes('[REDACTED]')).length,
    };

    return {
      version: '1.0',
      createdAt: Date.now(),
      redacted: true,
      source: params.source,
      summary,
      messages: sanitizedMessages,
      artifacts,
      attachments,
      continuitySnapshots,
      fileSnapshotSessions,
      warnings,
    };
  }

  private buildSource(source: SessionShareBundleSource): SessionShareBundleSource {
    return source;
  }

  private getContinuitySnapshots(instanceId: string): SessionShareSnapshotSummary[] {
    return getSessionContinuityManager()
      .listSnapshots(instanceId)
      .map((snapshot) => ({
        id: snapshot.id,
        timestamp: snapshot.timestamp,
        name: snapshot.name,
        description: snapshot.description,
        trigger: snapshot.metadata.trigger,
        messageCount: snapshot.metadata.messageCount,
        tokensUsed: snapshot.metadata.tokensUsed,
      }));
  }

  private getFileSnapshotSessions(instanceId: string): SessionShareFileSnapshotSession[] {
    return getSnapshotManager()
      .getSessionsForInstance(instanceId)
      .map((session) => ({
        id: session.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        description: session.description,
        fileCount: session.fileCount,
        snapshotCount: session.snapshots.length,
      }));
  }

  private sanitizeMessage(message: OutputMessage, workingDirectory: string): OutputMessage {
    return {
      ...message,
      content: this.sanitizeText(message.content, workingDirectory),
      metadata: this.sanitizeUnknownValue(message.metadata, workingDirectory) as Record<string, unknown> | undefined,
      attachments: message.attachments?.map((attachment) => ({
        ...attachment,
        data: '',
      })),
      thinking: message.thinking?.map((block) => ({
        ...block,
        content: this.sanitizeText(block.content, workingDirectory),
      })),
    };
  }

  private sanitizeUnknownValue(value: unknown, workingDirectory: string): unknown {
    if (typeof value === 'string') {
      return this.sanitizeText(value, workingDirectory);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeUnknownValue(item, workingDirectory));
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, innerValue]) => [
          key,
          key.toLowerCase().includes('path') && typeof innerValue === 'string'
            ? this.sanitizePathLabel(innerValue, workingDirectory)
            : this.sanitizeUnknownValue(innerValue, workingDirectory),
        ]),
      );
    }

    return value;
  }

  private sanitizeText(text: string, workingDirectory: string): string {
    let result = text;
    if (workingDirectory) {
      result = result.split(workingDirectory).join('<workspace>');
    }
    result = redactLogOutput(result, { fullMask: false });
    result = result.replace(
      /\b(token|secret|password|api[_ -]?key)\b(\s*[:=]?\s+)([^\s]+)/gi,
      (_match, label: string, spacer: string) => `${label}${spacer}[REDACTED]`,
    );
    return redactAllSecrets(result, { fullMask: false });
  }

  private sanitizePathLabel(filePath: string, workingDirectory: string): string {
    const resolved = path.resolve(filePath);
    if (workingDirectory) {
      const relative = path.relative(workingDirectory, resolved);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return path.posix.join('<workspace>', relative.split(path.sep).join('/'));
      }
    }

    return path.posix.join('<external>', path.basename(resolved));
  }

  private buildArtifacts(
    childResults: ChildResult[],
    workingDirectory: string,
  ): { artifacts: SessionShareArtifact[]; evidencePaths: string[] } {
    const artifacts: SessionShareArtifact[] = [];
    const evidencePaths = new Set<string>();

    for (const result of childResults) {
      for (const artifact of result.artifacts) {
        artifacts.push({
          id: `${result.id}:${artifact.id}`,
          source: 'child-result',
          type: artifact.type,
          timestamp: artifact.timestamp,
          severity: artifact.severity,
          title: artifact.title || artifact.type,
          content: this.sanitizeText(artifact.content, workingDirectory),
          fileLabel: artifact.file ? this.sanitizePathLabel(artifact.file, workingDirectory) : undefined,
          metadata: this.sanitizeUnknownValue(artifact.metadata, workingDirectory) as Record<string, unknown> | undefined,
        });

        if (artifact.file) {
          evidencePaths.add(artifact.file);
        }

        const metadataCandidatePaths = this.extractPathCandidatesFromMetadata(artifact.metadata);
        for (const candidate of metadataCandidatePaths) {
          evidencePaths.add(candidate);
        }
      }
    }

    return {
      artifacts,
      evidencePaths: Array.from(evidencePaths),
    };
  }

  private extractPathCandidatesFromMetadata(metadata: Record<string, unknown> | undefined): string[] {
    if (!metadata) {
      return [];
    }

    const keys = ['filePath', 'path', 'screenshotPath', 'consolePath', 'networkPath', 'tracePath', 'artifactPath'];
    const candidates: string[] = [];

    for (const key of keys) {
      const value = metadata[key];
      if (typeof value === 'string' && path.isAbsolute(value)) {
        candidates.push(value);
      }
    }

    return candidates;
  }

  private extractEvidencePathsFromMessages(messages: OutputMessage[]): string[] {
    const paths = new Set<string>();

    for (const message of messages) {
      let match: RegExpExecArray | null;
      const content = message.content;
      EVIDENCE_FILE_PATTERN.lastIndex = 0;
      match = EVIDENCE_FILE_PATTERN.exec(content);
      while (match) {
        const candidate = match[1];
        if (path.isAbsolute(candidate)) {
          paths.add(candidate);
        }
        match = EVIDENCE_FILE_PATTERN.exec(content);
      }
    }

    return Array.from(paths);
  }

  private async buildAttachments(
    evidencePaths: string[],
    workingDirectory: string,
  ): Promise<SessionShareAttachment[]> {
    const attachments: SessionShareAttachment[] = [];
    const seen = new Set<string>();

    for (const evidencePath of evidencePaths) {
      const resolved = path.resolve(evidencePath);
      if (seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);

      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          continue;
        }

        const ext = path.extname(resolved).toLowerCase();
        const title = path.basename(resolved);
        const attachment: SessionShareAttachment = {
          id: `attachment:${attachments.length}`,
          kind: this.classifyAttachmentKind(ext),
          timestamp: Number.isFinite(stat.mtimeMs) ? Math.round(stat.mtimeMs) : undefined,
          title,
          fileName: title,
          size: stat.size,
          sourcePathLabel: this.sanitizePathLabel(resolved, workingDirectory),
          mediaType: IMAGE_MEDIA_TYPES.get(ext) || (TEXT_MEDIA_TYPES.has(ext) ? 'text/plain' : undefined),
        };

        if (TEXT_MEDIA_TYPES.has(ext) && stat.size <= MAX_EMBED_TEXT_BYTES) {
          const text = await fs.readFile(resolved, 'utf-8');
          attachment.embeddedText = this.sanitizeText(text, workingDirectory);
        } else if (IMAGE_MEDIA_TYPES.has(ext) && stat.size <= MAX_EMBED_BINARY_BYTES) {
          const data = await fs.readFile(resolved);
          attachment.embeddedBase64 = data.toString('base64');
          attachment.mediaType = IMAGE_MEDIA_TYPES.get(ext);
        }

        attachments.push(attachment);
      } catch (error) {
        logger.info('Skipping share attachment that could not be read', {
          filePath: resolved,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return attachments;
  }

  private classifyAttachmentKind(extension: string): SessionShareAttachment['kind'] {
    if (IMAGE_MEDIA_TYPES.has(extension)) {
      return 'image';
    }
    if (extension === '.json') {
      return 'json';
    }
    if (extension === '.har' || extension === '.trace' || extension === '.zip') {
      return 'trace';
    }
    if (TEXT_MEDIA_TYPES.has(extension)) {
      return 'text';
    }
    return 'other';
  }
}

export function getSessionShareService(): SessionShareService {
  return SessionShareService.getInstance();
}
