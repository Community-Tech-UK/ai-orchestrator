import { createHash } from 'node:crypto';
import * as path from 'node:path';
import {
  QueueBranchSchema, QueueJobIdSchema, QueueProjectSchema, QueueTurnIdSchema,
} from '../../main/remote-node/queue-job-rpc-schemas';

const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** Everything the queue keeps on this computer lives under one root (`~/.orchestrator` by default). */
export class QueueJobPaths {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get reposDir(): string { return path.join(this.root, 'queue-repos'); }
  get worktreesDir(): string { return path.join(this.root, 'queue-worktrees'); }
  get uploadsDir(): string { return path.join(this.root, 'queue-uploads'); }
  get packsDir(): string { return path.join(this.root, 'queue-packs'); }

  bareRepo(project: string): string { return path.join(this.reposDir, `${QueueProjectSchema.parse(project)}.git`); }
  installedCheckout(project: string): string { return path.join(this.reposDir, `${QueueProjectSchema.parse(project)}-installed`); }
  /** The branch is `queue/...` (checked by the wire schema), so this stays inside `queue-worktrees`. */
  jobFolder(branch: string): string { return path.join(this.worktreesDir, ...QueueBranchSchema.parse(branch).split('/')); }
  planningFolder(jobId: string): string { return path.join(this.root, 'queue-docs', QueueJobIdSchema.parse(jobId)); }
  reportFolder(jobId: string): string { return path.join(this.root, 'queue-reports', QueueJobIdSchema.parse(jobId)); }
  reportFile(jobId: string, turnId: string): string { return path.join(this.reportFolder(jobId), `${QueueTurnIdSchema.parse(turnId)}.json`); }
  /** Small records about a job that must not sit in a folder the agent can edit. */
  stateDir(jobId: string): string { return path.join(this.root, 'queue-state', QueueJobIdSchema.parse(jobId)); }
  manifestFile(jobId: string): string { return path.join(this.stateDir(jobId), 'planning-manifest.json'); }
  uploadDir(uploadId: string): string { return path.join(this.uploadsDir, checkedId(uploadId)); }
  packFile(packId: string): string { return path.join(this.packsDir, `${checkedId(packId)}.pack`); }
}

function checkedId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('Not a valid upload or pack id.');
  return id;
}

/** A fixed-length prefix for a job's pack ids, so one job's packs can be found without matching on its id. */
export function packPrefix(jobId: string): string {
  return createHash('sha256').update(jobId).digest('hex').slice(0, 12);
}

/**
 * `relativePosix` joined under `base`, or null when it would land outside it (or on `base` itself).
 * The wire schemas already refuse `..`; this is the second, independent check.
 */
export function resolveInside(base: string, relativePosix: string): string | null {
  const target = path.resolve(base, ...relativePosix.split('/'));
  const relative = path.relative(base, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return target;
}
