import type { LoopStageMachine } from './loop-stage-machine';
import type { ReviewDrivenTerminal } from './loop-finish-phase';

/** A finish budget cannot waive human authority recorded in the question file. */
export async function applyOutstandingCompletionGate(terminal: ReviewDrivenTerminal, stageMachine: Pick<LoopStageMachine, 'readOutstanding'>): Promise<ReviewDrivenTerminal> {
  if (terminal.status !== 'completed') return terminal;
  try {
    const outstanding = await stageMachine.readOutstanding();
    return outstanding.needsHuman ? { ...terminal, status: 'completed-needs-review', reason: `${terminal.reason}\n${outstanding.unverifiable ? 'The outstanding questions could not be read completely. Review the file before accepting the result.' : 'Waiting for your decision:'}\n${outstanding.raw.trim()}` } : terminal;
  } catch {
    return { ...terminal, status: 'completed-needs-review', reason: `${terminal.reason}\nThe outstanding questions could not be read. Review them before accepting the result.` };
  }
}
