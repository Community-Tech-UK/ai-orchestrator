/**
 * Artifact file classification.
 *
 * "Artifacts" are deliverable / human-consumable files an agent produces during
 * a session — markdown summaries, PDFs, generated images, exported CSVs, etc.
 * — as opposed to source-code files that are part of the project's own build.
 *
 * This module is shared between main (SessionDiffTracker decides whether to
 * track a file outside the working directory) and renderer (SessionArtifacts
 * strip decides which entries from `diffStats` to surface as chips).
 *
 * Keep this file dependency-free so it can be imported from both runtimes.
 */

/**
 * Coarse-grained artifact category, used by the UI to pick an icon / grouping.
 */
export type ArtifactCategory = 'doc' | 'office' | 'data' | 'image' | 'notebook';

/**
 * File extensions (without leading dot, lowercase) that we treat as artifacts.
 *
 * The categories double as the renderer's icon/grouping key.
 */
const ARTIFACT_EXTENSIONS_BY_CATEGORY: Record<ArtifactCategory, readonly string[]> = {
  doc: ['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'asciidoc'],
  office: ['docx', 'doc', 'pdf', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'key'],
  data: ['csv', 'tsv'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'bmp', 'heic', 'heif'],
  notebook: ['ipynb'],
};

const EXTENSION_TO_CATEGORY: ReadonlyMap<string, ArtifactCategory> = new Map(
  (Object.entries(ARTIFACT_EXTENSIONS_BY_CATEGORY) as [ArtifactCategory, readonly string[]][])
    .flatMap(([cat, exts]) => exts.map((ext) => [ext, cat] as const))
);

/**
 * All artifact extensions as a flat readonly set, lowercase, no leading dot.
 * Exposed for callers that just need a membership check.
 */
export const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set(EXTENSION_TO_CATEGORY.keys());

/**
 * Extract the lowercase extension from a path, without leading dot.
 * Returns an empty string for paths with no extension.
 *
 * Works for both POSIX and Windows-style separators.
 */
export function getFileExtension(filePath: string): string {
  // Strip query strings / fragments defensively (paths shouldn't have them but
  // some tool outputs do).
  const cleaned = filePath.split(/[?#]/)[0];
  // Find the last path segment.
  const lastSlash = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  // Ignore leading dot (dotfiles like ".env" have no extension).
  const dot = basename.lastIndexOf('.');
  if (dot <= 0 || dot === basename.length - 1) {
    return '';
  }
  return basename.slice(dot + 1).toLowerCase();
}

/**
 * Returns true when `filePath`'s extension is in the artifact whitelist.
 */
export function isArtifactPath(filePath: string): boolean {
  return ARTIFACT_EXTENSIONS.has(getFileExtension(filePath));
}

/**
 * Classify a file path into an artifact category, or `null` if not an artifact.
 */
export function artifactCategory(filePath: string): ArtifactCategory | null {
  return EXTENSION_TO_CATEGORY.get(getFileExtension(filePath)) ?? null;
}
