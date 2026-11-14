/**
 * What the Plan Queue needs to know about each computer that might run a job
 * (docs/plans/2026-11-08-plan-queue-jobs-on-other-computers_plan.md, stages 3.2 and 4).
 *
 * The Computers page writes these; `PlanQueueJobPlacement` (src/main/plan-queue/remote/) reads them.
 */

/** One computer's Plan Queue settings and the project checks it has passed. */
export interface QueueJobComputer {
  /** The paired computer's node id. */
  nodeId: string;
  /** What people call it: "the Windows PC". Used in every sentence that names where a job runs. */
  label: string;
  /** Off until James turns it on. */
  takesJobs: boolean;
  /** Paused on the Computers page: it gets no new job. */
  paused: boolean;
  /** At most this many jobs at once, counted apart from this Mac's own limit. Default 2. */
  jobsAtOnce: number;
  /** Results of the per-project check, by project key (`queueProjectKey`). */
  projects: Record<string, QueueJobProjectCheck>;
}

export interface QueueJobProjectCheck {
  ok: boolean;
  checkedAt: number;
  /** Plain words when `ok` is false. */
  problem: string | null;
  /** What the check measured, for the page: "Checks took 43 s; a job folder's dependencies took 0.2 s." */
  summary: string;
}

/** Where placement reads the computers, in the Computers page's order. */
export interface QueueJobComputerSource {
  /** Every paired computer, in the Computers page's order. */
  list(): QueueJobComputer[];
}

/** The default for "jobs at once". */
export const DEFAULT_QUEUE_JOBS_AT_ONCE = 2;
