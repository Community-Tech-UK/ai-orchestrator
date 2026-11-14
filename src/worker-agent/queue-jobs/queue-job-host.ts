import type {
  QueueCollectParams, QueueCollectResult, QueueDeleteLeftOutParams, QueueDeleteLeftOutResult,
  QueueFetchPackParams, QueueFetchPackResult, QueueHaveParams, QueueHaveResult, QueueJobHostApi,
  QueuePrepareParams, QueuePrepareResult, QueueProjectCheckParams, QueueProjectCheckResult,
  QueueReadReportParams, QueueReadReportResult, QueueReceiveParams, QueueReceiveResult,
  QueueRemoveParams, QueueRemoveResult,
} from '../../main/remote-node/queue-job-rpc-schemas';
import { collectJob, fetchPackChunk } from './queue-job-collect';
import { deleteLeftOut, readReport, removeJob } from './queue-job-cleanup';
import {
  DEFAULT_QUEUE_JOB_LIMITS, type QueueInstaller, type QueueJobEnv, type QueueJobFolderControl, type QueueJobLimits,
  type QueueWorktreeCreator,
} from './queue-job-env';
import { QueueJobPaths } from './queue-job-paths';
import { prepareJob } from './queue-job-prepare';
import { QueueInstalledCheckout, npmInstaller } from './queue-installed-checkout';
import { KeyedMutex } from './queue-keyed-mutex';
import { runProcess, type QueueProcessRunner } from './queue-process';
import { checkProject } from './queue-project-check';
import { QueueRepoStore } from './queue-repo-store';
import { createQueueWorktree } from './queue-worktree-route';

export interface QueueJobHostOptions {
  /** `~/.orchestrator` (the worker's config folder); injected by specs. */
  root: string;
  /** The worker's instance manager: allowed folders per session, and which folders a session is in. */
  folders: QueueJobFolderControl;
  runner?: QueueProcessRunner;
  /** Installs dependencies in the installed checkout; specs inject one so no real `npm` runs. */
  install?: QueueInstaller;
  createWorktree?: QueueWorktreeCreator;
  limits?: Partial<QueueJobLimits>;
  now?: () => number;
}

/** This computer's half of "Plan Queue jobs on other computers": one method per `queue.*` call. */
export class QueueJobHost implements QueueJobHostApi {
  private readonly env: QueueJobEnv;
  private readonly repos: QueueRepoStore;
  private readonly installed: QueueInstalledCheckout;

  constructor(options: QueueJobHostOptions) {
    const runner = options.runner ?? runProcess;
    const limits = { ...DEFAULT_QUEUE_JOB_LIMITS, ...options.limits };
    this.env = {
      paths: new QueueJobPaths(options.root),
      runner,
      install: options.install ?? npmInstaller({ runner, limits }),
      createWorktree: options.createWorktree ?? createQueueWorktree,
      folders: options.folders,
      mutex: new KeyedMutex(),
      limits,
      now: options.now ?? Date.now,
    };
    this.repos = new QueueRepoStore(this.env);
    this.installed = new QueueInstalledCheckout(this.env, this.repos);
  }

  have(params: QueueHaveParams): Promise<QueueHaveResult> { return this.repos.have(params); }
  receive(params: QueueReceiveParams): Promise<QueueReceiveResult> { return this.repos.receive(params); }
  prepare(params: QueuePrepareParams): Promise<QueuePrepareResult> {
    return prepareJob({ env: this.env, repos: this.repos, installed: this.installed }, params);
  }
  collect(params: QueueCollectParams): Promise<QueueCollectResult> { return collectJob({ env: this.env, repos: this.repos }, params); }
  fetchPack(params: QueueFetchPackParams): Promise<QueueFetchPackResult> { return fetchPackChunk(this.env, params); }
  readReport(params: QueueReadReportParams): Promise<QueueReadReportResult> { return readReport(this.env, params); }
  deleteLeftOut(params: QueueDeleteLeftOutParams): Promise<QueueDeleteLeftOutResult> { return deleteLeftOut(this.env, params); }
  remove(params: QueueRemoveParams): Promise<QueueRemoveResult> { return removeJob(this.env, this.repos, params); }
  projectCheck(params: QueueProjectCheckParams): Promise<QueueProjectCheckResult> {
    return checkProject({ env: this.env, repos: this.repos, installed: this.installed }, params);
  }
}
