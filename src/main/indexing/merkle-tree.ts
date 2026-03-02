/**
 * Merkle Tree Manager
 *
 * Efficient change detection for codebase files using content hashing.
 * Uses a tree structure where each node's hash depends on its children,
 * enabling fast detection of changed files between indexing runs.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { getLogger } from '../logging/logger';
import type {
  MerkleNode,
  MerkleTreeConfig,
  ChangedFile,
} from '../../shared/types/codebase.types';
import { DEFAULT_MERKLE_CONFIG } from './config';

// ============================================================================
// Serialization Format
// ============================================================================

interface SerializedMerkleNode {
  h: string; // hash
  p: string; // path
  d: boolean; // isDirectory
  m?: number; // modifiedAt
  s?: number; // size
  c?: SerializedMerkleNode[]; // children (array for JSON serialization)
}

// ============================================================================
// MerkleTreeManager Class
// ============================================================================

const logger = getLogger('MerkleTree');

export class MerkleTreeManager {
  private config: MerkleTreeConfig;
  private ignoreRegexes: RegExp[];

  constructor(config: Partial<MerkleTreeConfig> = {}) {
    this.config = { ...DEFAULT_MERKLE_CONFIG, ...config };
    this.ignoreRegexes = this.config.ignorePatterns.map(
      (pattern) => new RegExp(`(^|/)${this.escapeRegex(pattern)}(/|$)`)
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Build a Merkle tree from a filesystem directory.
   */
  async buildTree(rootPath: string): Promise<MerkleNode> {
    const absolutePath = path.resolve(rootPath);
    return this.buildNodeRecursive(absolutePath, absolutePath);
  }

  /**
   * Compare two trees and return changed files.
   */
  diffTrees(oldTree: MerkleNode, newTree: MerkleNode): ChangedFile[] {
    const changes: ChangedFile[] = [];
    this.diffNodesRecursive(oldTree, newTree, changes);
    return changes;
  }

  /**
   * Serialize a tree to a Buffer for storage.
   */
  serialize(tree: MerkleNode): Buffer {
    const serialized = this.serializeNode(tree);
    return Buffer.from(JSON.stringify(serialized), 'utf-8');
  }

  /**
   * Deserialize a tree from a Buffer.
   */
  deserialize(data: Buffer): MerkleNode {
    const serialized = JSON.parse(data.toString('utf-8')) as SerializedMerkleNode;
    return this.deserializeNode(serialized);
  }

  /**
   * Get statistics about a tree.
   */
  getTreeStats(tree: MerkleNode): {
    fileCount: number;
    directoryCount: number;
    totalSize: number;
  } {
    let fileCount = 0;
    let directoryCount = 0;
    let totalSize = 0;

    const traverse = (node: MerkleNode): void => {
      if (node.isDirectory) {
        directoryCount++;
        if (node.children) {
          for (const child of node.children.values()) {
            traverse(child);
          }
        }
      } else {
        fileCount++;
        totalSize += node.size || 0;
      }
    };

    traverse(tree);
    return { fileCount, directoryCount, totalSize };
  }

  /**
   * Find a node in the tree by path.
   */
  findNode(tree: MerkleNode, targetPath: string): MerkleNode | null {
    const normalizedTarget = path.normalize(targetPath);

    const find = (node: MerkleNode): MerkleNode | null => {
      if (path.normalize(node.path) === normalizedTarget) {
        return node;
      }

      if (node.isDirectory && node.children) {
        for (const child of node.children.values()) {
          const found = find(child);
          if (found) return found;
        }
      }

      return null;
    };

    return find(tree);
  }

  /**
   * Collect all file paths from a tree.
   */
  collectAllFilePaths(tree: MerkleNode): string[] {
    const paths: string[] = [];

    const traverse = (node: MerkleNode): void => {
      if (node.isDirectory) {
        if (node.children) {
          for (const child of node.children.values()) {
            traverse(child);
          }
        }
      } else {
        paths.push(node.path);
      }
    };

    traverse(tree);
    return paths;
  }

  // ==========================================================================
  // Private: Tree Building
  // ==========================================================================

  private async buildNodeRecursive(
    absolutePath: string,
    rootPath: string
  ): Promise<MerkleNode> {
    const stats = await fs.promises.stat(absolutePath);
    const relativePath = path.relative(rootPath, absolutePath);

    if (stats.isDirectory()) {
      return this.buildDirectoryNode(absolutePath, rootPath, relativePath, stats);
    } else {
      return this.buildFileNode(absolutePath, relativePath, stats);
    }
  }

  private async buildDirectoryNode(
    absolutePath: string,
    rootPath: string,
    relativePath: string,
    stats: fs.Stats
  ): Promise<MerkleNode> {
    const entries = await fs.promises.readdir(absolutePath, { withFileTypes: true });
    const children = new Map<string, MerkleNode>();

    // Build children in parallel with concurrency limit
    const CONCURRENCY_LIMIT = 20;
    const childEntries = entries.filter((entry) => this.shouldInclude(entry.name, relativePath));

    for (let i = 0; i < childEntries.length; i += CONCURRENCY_LIMIT) {
      const batch = childEntries.slice(i, i + CONCURRENCY_LIMIT);
      const childNodes = await Promise.all(
        batch.map(async (entry) => {
          const childPath = path.join(absolutePath, entry.name);
          try {
            return await this.buildNodeRecursive(childPath, rootPath);
          } catch (error) {
            // Skip files that can't be read (permissions, broken symlinks, etc.)
            logger.warn('Skipping file due to read error', { childPath, error: String(error) });
            return null;
          }
        })
      );

      for (const node of childNodes) {
        if (node) {
          children.set(path.basename(node.path), node);
        }
      }
    }

    // Compute directory hash from sorted child hashes
    const sortedChildHashes = Array.from(children.values())
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((child) => child.hash)
      .join('');

    const hash = this.computeHash(sortedChildHashes || 'empty-directory');

    return {
      hash,
      path: relativePath || '.',
      isDirectory: true,
      children,
      modifiedAt: stats.mtimeMs,
    };
  }

  private async buildFileNode(
    absolutePath: string,
    relativePath: string,
    stats: fs.Stats
  ): Promise<MerkleNode> {
    // For files, hash the content
    const content = await fs.promises.readFile(absolutePath);
    const hash = this.computeHash(content);

    return {
      hash,
      path: relativePath,
      isDirectory: false,
      modifiedAt: stats.mtimeMs,
      size: stats.size,
    };
  }

  // ==========================================================================
  // Private: Tree Diff
  // ==========================================================================

  private diffNodesRecursive(
    oldNode: MerkleNode | null,
    newNode: MerkleNode | null,
    changes: ChangedFile[]
  ): void {
    // Case 1: Node deleted
    if (oldNode && !newNode) {
      this.collectDeleted(oldNode, changes);
      return;
    }

    // Case 2: Node added
    if (!oldNode && newNode) {
      this.collectAdded(newNode, changes);
      return;
    }

    // Case 3: Both exist
    if (oldNode && newNode) {
      // If hashes match, entire subtree is unchanged
      if (oldNode.hash === newNode.hash) {
        return;
      }

      // Hashes differ - check if it's a file or directory
      if (!oldNode.isDirectory && !newNode.isDirectory) {
        // File modified
        changes.push({
          path: newNode.path,
          type: 'modified',
          oldHash: oldNode.hash,
          newHash: newNode.hash,
        });
      } else if (oldNode.isDirectory && newNode.isDirectory) {
        // Directory changed - recurse into children
        const oldChildren = oldNode.children || new Map();
        const newChildren = newNode.children || new Map();

        // Check all old children
        for (const [name, oldChild] of oldChildren) {
          const newChild = newChildren.get(name);
          this.diffNodesRecursive(oldChild, newChild || null, changes);
        }

        // Check for new children
        for (const [name, newChild] of newChildren) {
          if (!oldChildren.has(name)) {
            this.collectAdded(newChild, changes);
          }
        }
      } else {
        // Type changed (file <-> directory) - treat as delete + add
        this.collectDeleted(oldNode, changes);
        this.collectAdded(newNode, changes);
      }
    }
  }

  private collectDeleted(node: MerkleNode, changes: ChangedFile[]): void {
    if (node.isDirectory) {
      if (node.children) {
        for (const child of node.children.values()) {
          this.collectDeleted(child, changes);
        }
      }
    } else {
      changes.push({
        path: node.path,
        type: 'deleted',
        oldHash: node.hash,
      });
    }
  }

  private collectAdded(node: MerkleNode, changes: ChangedFile[]): void {
    if (node.isDirectory) {
      if (node.children) {
        for (const child of node.children.values()) {
          this.collectAdded(child, changes);
        }
      }
    } else {
      changes.push({
        path: node.path,
        type: 'added',
        newHash: node.hash,
      });
    }
  }

  // ==========================================================================
  // Private: Serialization
  // ==========================================================================

  private serializeNode(node: MerkleNode): SerializedMerkleNode {
    const serialized: SerializedMerkleNode = {
      h: node.hash,
      p: node.path,
      d: node.isDirectory,
    };

    if (node.modifiedAt !== undefined) {
      serialized.m = node.modifiedAt;
    }

    if (node.size !== undefined) {
      serialized.s = node.size;
    }

    if (node.children && node.children.size > 0) {
      serialized.c = Array.from(node.children.values())
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((child) => this.serializeNode(child));
    }

    return serialized;
  }

  private deserializeNode(serialized: SerializedMerkleNode): MerkleNode {
    const node: MerkleNode = {
      hash: serialized.h,
      path: serialized.p,
      isDirectory: serialized.d,
    };

    if (serialized.m !== undefined) {
      node.modifiedAt = serialized.m;
    }

    if (serialized.s !== undefined) {
      node.size = serialized.s;
    }

    if (serialized.c && serialized.c.length > 0) {
      node.children = new Map();
      for (const childSerialized of serialized.c) {
        const child = this.deserializeNode(childSerialized);
        node.children.set(path.basename(child.path), child);
      }
    }

    return node;
  }

  // ==========================================================================
  // Private: Utilities
  // ==========================================================================

  private computeHash(content: string | Buffer): string {
    const algorithm = this.config.hashAlgorithm === 'xxhash' ? 'md5' : this.config.hashAlgorithm;
    return crypto.createHash(algorithm).update(content).digest('hex');
  }

  private shouldInclude(name: string, parentPath: string): boolean {
    // Skip hidden files/directories
    if (name.startsWith('.')) {
      return false;
    }

    // Check ignore patterns
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    for (const regex of this.ignoreRegexes) {
      if (regex.test(fullPath) || regex.test(name)) {
        return false;
      }
    }

    return true;
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let merkleTreeManagerInstance: MerkleTreeManager | null = null;

export function getMerkleTreeManager(config?: Partial<MerkleTreeConfig>): MerkleTreeManager {
  if (!merkleTreeManagerInstance) {
    merkleTreeManagerInstance = new MerkleTreeManager(config);
  }
  return merkleTreeManagerInstance;
}

export function resetMerkleTreeManager(): void {
  merkleTreeManagerInstance = null;
}
