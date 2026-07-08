import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeFileTransferMcpError } from './remote-node-file-transfer-mcp-errors';
import { SecurityFilter } from './security-filter';

export function resolveInsideWorkspace(workspace: string, inputPath: string): string {
  const resolved = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(workspace, inputPath);
  if (!SecurityFilter.isWithinRoot(resolved, [workspace])) {
    throw new NodeFileTransferMcpError(
      'local_write_refused',
      `Local path must stay inside the current workspace: ${inputPath}`,
    );
  }
  return resolved;
}

export async function assertExistingPathInsideWorkspace(
  workspace: string,
  targetPath: string,
  label: string,
): Promise<void> {
  let realTarget: string;
  try {
    realTarget = await fs.realpath(targetPath);
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new NodeFileTransferMcpError('file_not_found', `${label} does not exist: ${targetPath}`);
    }
    throw error;
  }
  await assertRealPathInsideWorkspace(workspace, realTarget, label);
}

export async function assertClosestExistingPathInsideWorkspace(
  workspace: string,
  targetPath: string,
  label: string,
): Promise<void> {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      const realCurrent = await fs.realpath(current);
      await assertRealPathInsideWorkspace(workspace, realCurrent, label);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new NodeFileTransferMcpError(
          'local_write_refused',
          `${label} has no existing parent inside the workspace: ${targetPath}`,
        );
      }
      current = parent;
    }
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function lstatOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

export function sanitizeBasename(filePath: string): string {
  const base = basenameAnyPlatform(filePath).replace(/[^A-Za-z0-9._-]+/g, '_');
  return base || 'transfer.bin';
}

export function isWindowsStylePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.includes('\\');
}

export function normalizeExtension(extension: string): string {
  const value = extension.trim().toLowerCase();
  return value.startsWith('.') ? value : `.${value}`;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function assertRealPathInsideWorkspace(
  workspace: string,
  realTarget: string,
  label: string,
): Promise<void> {
  const realWorkspace = await fs.realpath(workspace);
  if (!SecurityFilter.isWithinRoot(realTarget, [realWorkspace])) {
    throw new NodeFileTransferMcpError(
      'local_write_refused',
      `${label} resolves outside the current workspace: ${realTarget}`,
    );
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function basenameAnyPlatform(filePath: string): string {
  return isWindowsStylePath(filePath) ? path.win32.basename(filePath) : path.basename(filePath);
}
