import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface SymbolIdInput {
  absPath: string;
  kind: string;
  name: string;
  containerName: string | null;
}

export function symbolId(input: SymbolIdInput): string {
  const canonical = JSON.stringify({
    absPath: input.absPath,
    kind: input.kind,
    name: input.name,
    containerName: input.containerName,
  });
  return createHash('sha1').update(canonical).digest('hex');
}

export function workspaceHashForPath(workspacePath: string): string {
  return createHash('sha1').update(path.resolve(workspacePath)).digest('hex');
}
