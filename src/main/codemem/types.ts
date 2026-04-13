export type ContentHash = string;
export type AstNormalizedHash = string;
export type MerkleNodeHash = string;
export type SymbolId = string;
export type WorkspaceHash = string;
export type WorkspaceSymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'constant'
  | 'property'
  | 'namespace';

export type ChunkType =
  | 'function'
  | 'class'
  | 'method'
  | 'interface'
  | 'type'
  | 'enum'
  | 'module'
  | 'other';

export interface Chunk {
  contentHash: ContentHash;
  astNormalizedHash: AstNormalizedHash;
  language: string;
  chunkType: ChunkType;
  name: string;
  signature: string | null;
  docComment: string | null;
  symbolsJson: string;
  importsJson: string;
  exportsJson: string;
  rawText: string;
}

export interface MerkleNode {
  nodeHash: MerkleNodeHash;
  kind: 'file' | 'dir' | 'root';
  childrenJson: string;
}

export interface WorkspaceManifestRow {
  workspaceHash: WorkspaceHash;
  pathFromRoot: string;
  contentHash: ContentHash;
  merkleLeafHash: MerkleNodeHash;
  mtime: number;
}

export interface WorkspaceRoot {
  workspaceHash: WorkspaceHash;
  absPath: string;
  headCommit: string | null;
  primaryLanguage: string | null;
  lastIndexedAt: number;
  merkleRootHash: MerkleNodeHash | null;
  pagerankJson: string | null;
}

export interface WorkspaceSymbolRecord {
  workspaceHash: WorkspaceHash;
  symbolId: SymbolId;
  pathFromRoot: string;
  name: string;
  kind: WorkspaceSymbolKind;
  containerName: string | null;
  startLine: number;
  startCharacter: number;
  endLine: number | null;
  endCharacter: number | null;
  signature: string | null;
  docComment: string | null;
}
