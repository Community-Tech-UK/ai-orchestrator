/** The Computers page's view of the test machines and of where today's work ran. */

/** One test machine, as `scripts/remote-checks/route.js` reads the file; `host` names it there. */
export interface TestMachineView {
  host: string;
  /** `darwin` for a Mac, which can also run the specs that only work on macOS. */
  platform: 'linux' | 'darwin';
  /** What people call it, as the scripts print it: "Ran on the Windows PC in ...". */
  label: string;
  /** The paired computer this machine is part of, so the page shows them as one. */
  nodeName: string | null;
  paused: boolean;
  testRuns: boolean;
  checks: boolean;
  /** How many test runs or checks it takes at once. */
  slots: number;
}

/** Where today's work went. `there` ran on another computer; `here` could have and ran on this Mac. */
export interface WorkToday {
  testRuns: { there: number; here: number };
  checks: { there: number; here: number };
  /** iPhone builds and simulator work. `here` ran on this Mac because the test Mac was away, or a person asked. */
  iphone: { there: number; here: number };
  /** Short test runs, which are quicker here and never try another computer. */
  shortRunsHere: number;
  /** Why work ran here that could have gone elsewhere, most common first. */
  hereBecause: { reason: string; count: number }[];
}
