/**
 * Which computers take Plan Queue jobs (docs/plans/2026-11-08-plan-queue-jobs-on-other-computers_plan.md, stage 4).
 *
 * The switch, "jobs at once" and the project check results live in one small file in the Plan Queue's data folder, not
 * in the `computers` setting beside Pause. That setting can be changed by agents through Harness's settings tools, and a
 * switch that sends a project's code to another computer must be turned on by a person, on the Computers page. Order,
 * the name and Pause still come from where the page keeps them: the paired computers' saved order and Pause, and the
 * test machine's file. The file is written in one step, and a file that can't be read is refused, never replaced.
 */
import { readFileSync, renameSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_QUEUE_JOBS_AT_ONCE } from '../../shared/types/plan-queue-computers.types';
import type { QueueJobComputer, QueueJobComputerSource, QueueJobProjectCheck } from '../../shared/types/plan-queue-computers.types';
import { MAX_QUEUE_JOBS_AT_ONCE, MIN_QUEUE_JOBS_AT_ONCE } from '../../shared/types/plan-queue-computers-page.types';
import type { ComputerChoice } from '../../shared/types/settings.types';
import type { TestMachineView } from '../../shared/types/computers.types';
import type { RemoteNodeRosterEntry } from '../../shared/types/worker-node.types';
import { orderComputers, ownTestMachines } from '../../shared/utils/computers-order';
import { getSettingsManager } from '../core/config/settings-manager';
import { getRemoteNodeRosterService } from '../remote-node/remote-node-roster-service';
import { getPlanQueueDataDir } from '../plan-queue/plan-queue-data-dir';
import { readTestMachines } from './test-machine-file';

const MAX_SUMMARY_CHARS = 1000;
const MAX_PROBLEM_CHARS = 2000;

const ProjectCheckSchema = z.object({
  ok: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
  problem: z.string().max(MAX_PROBLEM_CHARS).nullable(),
  summary: z.string().max(MAX_SUMMARY_CHARS),
}).strict();

const StoredComputerSchema = z.object({
  takesJobs: z.boolean(),
  jobsAtOnce: z.number().int().min(MIN_QUEUE_JOBS_AT_ONCE).max(MAX_QUEUE_JOBS_AT_ONCE),
  projects: z.record(z.string().min(1).max(200), ProjectCheckSchema),
}).strict();

const StoredFileSchema = z.object({
  version: z.literal(1),
  computers: z.record(z.string().min(1).max(200), StoredComputerSchema),
}).strict();

type StoredFile = z.infer<typeof StoredFileSchema>;
type StoredComputer = z.infer<typeof StoredComputerSchema>;

/** Where the computers' choices and results come from; tests pass their own. */
export interface QueueJobComputersOptions {
  /** The file to keep them in. Defaults to `queue-job-computers.json` in the Plan Queue's data folder. */
  file?: string;
  roster?: () => readonly RemoteNodeRosterEntry[];
  /** The Computers page's order and Pause for paired computers. */
  choices?: () => readonly ComputerChoice[];
  /** The test machines, whose name and Pause belong to the computer they are part of. Throws when their file is broken. */
  testMachines?: () => readonly TestMachineView[];
}

function freshComputer(): StoredComputer {
  return { takesJobs: false, jobsAtOnce: DEFAULT_QUEUE_JOBS_AT_ONCE, projects: {} };
}

export class QueueJobComputers implements QueueJobComputerSource {
  private static instance: QueueJobComputers | null = null;

  static getInstance(): QueueJobComputers {
    this.instance ??= new QueueJobComputers();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(private readonly options: QueueJobComputersOptions = {}) {}

  /**
   * Every paired computer in the Computers page's order, connected or not. Throws when the saved file or the test
   * machine file can't be read: a placement that can't tell what is switched on or paused must not guess.
   */
  list(): QueueJobComputer[] {
    const stored = this.read();
    const nodes = this.nodes();
    const choices = this.choices();
    const ordered = orderComputers(nodes, choices);
    const machines = ownTestMachines(ordered, this.testMachines());
    return ordered.map((node) => {
      const own = stored.computers[node.id] ?? freshComputer();
      const machine = machines.get(node);
      return {
        nodeId: node.id,
        label: machine?.label ?? node.name,
        takesJobs: own.takesJobs,
        paused: choices.find(choice => choice.id === node.id)?.paused === true || machine?.paused === true,
        jobsAtOnce: own.jobsAtOnce,
        projects: { ...own.projects },
      };
    });
  }

  /** Turns Plan Queue jobs on or off for a paired computer. Throws when no such computer is paired. */
  setTakesJobs(nodeId: string, takesJobs: boolean): void {
    this.change(nodeId, entry => ({ ...entry, takesJobs }));
  }

  /** Throws when `jobsAtOnce` is not a whole number from 1 to 8, or no such computer is paired. */
  setJobsAtOnce(nodeId: string, jobsAtOnce: number): void {
    if (!Number.isInteger(jobsAtOnce) || jobsAtOnce < MIN_QUEUE_JOBS_AT_ONCE || jobsAtOnce > MAX_QUEUE_JOBS_AT_ONCE) {
      throw new Error(`Jobs at once must be a whole number from ${MIN_QUEUE_JOBS_AT_ONCE} to ${MAX_QUEUE_JOBS_AT_ONCE}.`);
    }
    this.change(nodeId, entry => ({ ...entry, jobsAtOnce }));
  }

  /** Keeps the newest result for the project on that computer. Long text is cut to what the file allows. */
  recordProjectCheck(nodeId: string, projectKey: string, result: QueueJobProjectCheck): void {
    const kept: QueueJobProjectCheck = {
      ok: result.ok,
      checkedAt: result.checkedAt,
      problem: result.problem === null ? null : result.problem.slice(0, MAX_PROBLEM_CHARS),
      summary: result.summary.slice(0, MAX_SUMMARY_CHARS),
    };
    this.change(nodeId, entry => ({ ...entry, projects: { ...entry.projects, [projectKey]: kept } }));
  }

  /**
   * Forgets a computer's results for one project, or for every project when none is named, so the project is checked
   * again before it gets a job. For when what was checked has changed there. Not an error when nothing was recorded.
   */
  clearProjectChecks(nodeId: string, projectKey?: string): void {
    const file = this.read();
    const entry = file.computers[nodeId];
    if (!entry) return;
    const projects = { ...entry.projects };
    if (projectKey === undefined) {
      for (const key of Object.keys(projects)) delete projects[key];
    } else {
      delete projects[projectKey];
    }
    this.write({ ...file, computers: { ...file.computers, [nodeId]: { ...entry, projects } } });
  }

  private change(nodeId: string, update: (entry: StoredComputer) => StoredComputer): void {
    if (!this.nodes().some(node => node.id === nodeId)) throw new Error('That computer is not paired with this Mac.');
    const file = this.read();
    this.write({ ...file, computers: { ...file.computers, [nodeId]: update(file.computers[nodeId] ?? freshComputer()) } });
  }

  private nodes(): readonly RemoteNodeRosterEntry[] {
    return (this.options.roster ?? (() => getRemoteNodeRosterService().list()))();
  }

  private choices(): readonly ComputerChoice[] {
    return (this.options.choices ?? (() => getSettingsManager().get('computers')))();
  }

  private testMachines(): readonly TestMachineView[] {
    return (this.options.testMachines ?? (() => readTestMachines()))();
  }

  private file(): string {
    return this.options.file ?? join(getPlanQueueDataDir(), 'queue-job-computers.json');
  }

  /** Nothing is saved yet when there is no file; a file that can't be read is an error, never "nothing saved". */
  private read(): StoredFile {
    let text: string;
    try {
      text = readFileSync(this.file(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, computers: {} };
      throw error;
    }
    const parsed = StoredFileSchema.safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error(`The Plan Queue computers file can't be read: ${parsed.error.issues[0]?.message ?? 'it is not in the expected form'}.`);
    return parsed.data;
  }

  /** The new file replaces the old in one step, so a reader sees one or the other, never half of each. */
  private write(file: StoredFile): void {
    const target = this.file();
    mkdirSync(dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(StoredFileSchema.parse(file), null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

export function getQueueJobComputers(): QueueJobComputers {
  return QueueJobComputers.getInstance();
}
