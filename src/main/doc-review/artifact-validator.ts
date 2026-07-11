import { realpathSync, statSync } from 'node:fs';
import { readFile, appendFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { getLogger } from '../logging/logger';
import { containsIgnore } from '../orchestration/loop-attachments';

const logger = getLogger('DocReviewArtifact');

/** Workspace-relative folder that holds review artifacts. Never committed. */
export const DOC_REVIEW_DIR_NAME = '.aio-review';

/** Same 25 MB ceiling the loop-attachment path uses. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

export type ArtifactPathResult =
  | { ok: true; resolvedPath: string }
  | { ok: false; reason: string };

/**
 * Resolve and security-check an artifact path. The path must resolve to a real file
 * inside `<workspacePath>/.aio-review/`, with symlink escapes rejected (realpath is
 * compared, not the lexical path) and the file capped at MAX_ARTIFACT_BYTES.
 *
 * Treats the artifact path as untrusted — this is the guard for both createSession
 * (agent-supplied path) and READ_ARTIFACT (stored path re-validated on every read).
 */
export function validateArtifactPath(
  workspacePath: string,
  artifactPath: string,
): ArtifactPathResult {
  if (!workspacePath || !artifactPath) {
    return { ok: false, reason: 'workspacePath and artifactPath are required' };
  }
  const reviewDir = join(workspacePath, DOC_REVIEW_DIR_NAME);
  const requested = isAbsolute(artifactPath)
    ? resolve(artifactPath)
    : resolve(workspacePath, artifactPath);

  let realWorkspace: string;
  let realReviewDir: string;
  let realFile: string;
  try {
    realWorkspace = realpathSync(workspacePath);
  } catch {
    return { ok: false, reason: 'workspace directory does not exist' };
  }
  try {
    realReviewDir = realpathSync(reviewDir);
  } catch {
    return { ok: false, reason: `no ${DOC_REVIEW_DIR_NAME}/ directory in workspace` };
  }
  // The review dir must be a real directory directly under the workspace — reject a
  // `.aio-review` that is itself a symlink escaping the workspace (directory-level escape).
  if (realReviewDir !== join(realWorkspace, DOC_REVIEW_DIR_NAME)) {
    return { ok: false, reason: `${DOC_REVIEW_DIR_NAME}/ must be a real directory in the workspace` };
  }
  try {
    realFile = realpathSync(requested);
  } catch {
    return { ok: false, reason: 'artifact file does not exist' };
  }

  if (realFile !== realReviewDir && !realFile.startsWith(realReviewDir + sep)) {
    return { ok: false, reason: `artifact must be inside ${DOC_REVIEW_DIR_NAME}/` };
  }

  let stats;
  try {
    stats = statSync(realFile);
  } catch {
    return { ok: false, reason: 'artifact file is not readable' };
  }
  if (!stats.isFile()) {
    return { ok: false, reason: 'artifact path is not a file' };
  }
  if (stats.size > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'artifact exceeds the 25 MB cap' };
  }
  return { ok: true, resolvedPath: realFile };
}

export interface ArtifactMeta {
  isArtifact: boolean;
  title?: string;
  source?: string;
}

function readMetaContent(html: string, name: string): string | undefined {
  const re = new RegExp(
    `<meta\\s+name=["']${name}["']\\s+content=["']([^"']*)["']`,
    'i',
  );
  const match = re.exec(html);
  return match ? match[1] : undefined;
}

/** Confirm the HTML carries the v1 doc-review marker and pull title/source. */
export function parseArtifactMeta(html: string): ArtifactMeta {
  const marker = readMetaContent(html, 'aio-doc-review');
  if (marker !== 'v1') {
    return { isArtifact: false };
  }
  return {
    isArtifact: true,
    title: readMetaContent(html, 'aio-doc-review-title') || undefined,
    source: readMetaContent(html, 'aio-doc-review-source') || undefined,
  };
}

/**
 * Append `.aio-review/` to the workspace's .gitignore if not already covered. Best-effort
 * and idempotent — mirrors ensureLoopAttachmentsIgnored so artifacts never get committed.
 */
export async function ensureDocReviewIgnored(workspacePath: string): Promise<void> {
  const gitignorePath = join(workspacePath, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    // No .gitignore yet — appendFile below creates one.
  }
  if (containsIgnore(existing, DOC_REVIEW_DIR_NAME)) return;

  const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
  const block = `${needsLeadingNewline ? '\n' : ''}# Doc-review HTML artifacts (never committed)\n${DOC_REVIEW_DIR_NAME}/\n`;
  try {
    await appendFile(gitignorePath, block);
  } catch (err) {
    logger.warn('Failed to update .gitignore for doc-review artifacts', {
      error: String(err),
    });
  }
}
