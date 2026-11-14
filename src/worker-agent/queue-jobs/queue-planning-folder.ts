import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  QueueRelativePathSchema, type QueueDocument,
} from '../../main/remote-node/queue-job-rpc-schemas';
import { QueueJobRefusal } from './queue-job-errors';
import type { QueueJobEnv } from './queue-job-env';
import { resolveInside } from './queue-job-paths';

const MAX_COLLECT_DOCUMENTS = 500;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function readManifest(env: QueueJobEnv, jobId: string): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(env.paths.manifestFile(jobId), 'utf8')) as { files?: unknown };
    const entries = Array.isArray(parsed.files) ? parsed.files : [];
    return new Map(entries.flatMap((entry): [string, string][] =>
      Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' ? [[entry[0], entry[1]]] : []));
  } catch {
    return new Map();
  }
}

/**
 * Clear the job's planning folder and fill it with the documents this Mac sent, each at its repository-relative
 * path. What was written (a sha256 per path) is kept outside the folder as "what was last sent".
 */
export async function writePlanningFolder(env: QueueJobEnv, jobId: string, documents: readonly QueueDocument[]): Promise<void> {
  const folder = env.paths.planningFolder(jobId);
  await fs.rm(folder, { recursive: true, force: true });
  await fs.mkdir(folder, { recursive: true });
  const written = new Map<string, string>();
  for (const document of documents) {
    const target = resolveInside(folder, document.path);
    if (!target) throw new QueueJobRefusal('path-outside', `The planning document path "${document.path}" is outside the job's planning folder.`);
    const data = Buffer.from(document.contentBase64, 'base64');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    written.set(document.path, sha256(data));
  }
  await fs.mkdir(env.paths.stateDir(jobId), { recursive: true });
  await fs.writeFile(env.paths.manifestFile(jobId), JSON.stringify({ files: [...written] }), 'utf8');
}

export interface PlanningChanges {
  documents: QueueDocument[];
  deleted: string[];
}

/**
 * The planning-folder files that differ from what was last sent (whole, base64), and the sent paths that are
 * gone. A link is never followed: one that leads outside the folder is refused, one that stays inside is not
 * carried back.
 */
export async function diffPlanningFolder(env: QueueJobEnv, jobId: string): Promise<PlanningChanges> {
  const folder = env.paths.planningFolder(jobId);
  const folderReal = await fs.realpath(folder).catch(() => null);
  if (!folderReal) throw new QueueJobRefusal('not-prepared', 'This job has no planning folder on this computer.');
  const manifest = await readManifest(env, jobId);
  const seen = new Set<string>();
  const documents: QueueDocument[] = [];
  let bytes = 0;

  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory)).sort()) {
      const absolute = path.join(directory, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await fs.realpath(absolute).catch(() => null);
        const inside = target !== null && (target === folderReal || target.startsWith(folderReal + path.sep));
        if (!inside) throw new QueueJobRefusal('path-outside', `"${relative}" in the planning folder leads outside it.`);
        continue;
      }
      if (stat.isDirectory()) { await walk(absolute, relative); continue; }
      if (!stat.isFile()) continue;
      if (!QueueRelativePathSchema.safeParse(relative).success) {
        throw new QueueJobRefusal('path-outside', `"${relative}" in the planning folder has a name that cannot be sent back.`);
      }
      seen.add(relative);
      if (stat.size > env.limits.maxDocumentBytes) throw new Error(`The planning document "${relative}" is too large to send back.`);
      const data = await fs.readFile(absolute);
      if (manifest.get(relative) === sha256(data)) continue;
      bytes += data.length;
      if (documents.length >= MAX_COLLECT_DOCUMENTS || bytes > env.limits.maxCollectDocumentBytes) {
        throw new Error('The planning folder has more changed documents than can be sent back in one go.');
      }
      documents.push({ path: relative, contentBase64: data.toString('base64') });
    }
  };
  await walk(folderReal, '');
  const deleted = [...manifest.keys()].filter(key => !seen.has(key)).sort();
  return { documents, deleted };
}
