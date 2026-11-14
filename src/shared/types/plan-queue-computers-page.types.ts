/** What the Computers page reads and changes about Plan Queue jobs (contract types: plan-queue-computers.types.ts). */
import type { QueueJobComputer } from './plan-queue-computers.types';

/** A repository the Plan Queue has worked in, which a computer can be checked for. */
export interface QueueJobProject {
  /** The project's name on a computer (`queueProjectKey`); the key of `QueueJobComputer.projects`. */
  key: string;
  /** The repository's folder name, as people know the project. */
  name: string;
  /** The repository's folder on this Mac. */
  repoRoot: string;
}

export interface QueueJobsPageView {
  /** Every paired computer, in the Computers page's order. */
  computers: QueueJobComputer[];
  /** The repositories of the queue's runs, newest first. */
  projects: QueueJobProject[];
}

/** What a computer's settings can be changed to; the Computers page's two Plan Queue controls. */
export interface QueueJobsChange {
  takesJobs?: boolean;
  jobsAtOnce?: number;
}

/** The bounds of "jobs at once". */
export const MIN_QUEUE_JOBS_AT_ONCE = 1;
export const MAX_QUEUE_JOBS_AT_ONCE = 8;
