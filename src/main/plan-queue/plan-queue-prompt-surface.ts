import type { PromptSurface } from '../logging/prompt-surfaces';
import { logPromptInjection } from '../logging/prompt-injection-log';

/**
 * The budget-table key of a queue prompt, read from how its builder in `plan-queue-prompts.ts` opens it.
 * Prompts that have no ceiling (a human's reply, a routine-clarification nudge) return undefined.
 */
export function queuePromptSurface(prompt: string): PromptSurface | undefined {
  const conflicts = prompt.includes('the merge has conflicts. The merge is still in progress');
  const livetest = prompt.includes('Plan Queue livetest worker');
  // A ticket prompt opens with its own words (`plan-queue-ticket-prompts.ts`), so it is not counted against a plan's ceiling.
  if (prompt.startsWith('You are resuming a Plan Queue ticket.')) return prompt.includes('An earlier, cheaper attempt did not pass') ? 'queueTicketStepUp' : 'queueTicketResume';
  if (prompt.startsWith('You are a Plan Queue ticket worker.')) return 'queueTicketWorker';
  if (prompt.startsWith('You are the Plan Queue ticket worker on a fix round.')) return 'queueTicketFix';
  if (prompt.startsWith('You are an independent Plan Queue ticket verifier.')) return 'queueTicketChecker';
  if (prompt.startsWith('Your session was stopped and has now been reopened.')) return conflicts ? 'queueContinueConflict' : 'queueContinue';
  if (prompt.startsWith('You are resuming a Plan Queue item.')) {
    if (prompt.includes('An earlier, cheaper attempt did not pass')) return livetest ? 'queueLivetestStepUp' : 'queueStepUp';
    return conflicts ? 'queueResumeConflict' : 'queueResume';
  }
  if (prompt.startsWith('You are a Plan Queue livetest worker.')) return 'queueLivetestWorker';
  if (prompt.startsWith('You are a Plan Queue worker.')) return 'queueWorker';
  if (prompt.startsWith('An independent verifier failed your work')) return 'queueFix';
  if (prompt.startsWith('The coordinator merged')) return 'queueConflict';
  if (prompt.startsWith('After the base branch was merged into your branch, a deterministic post-merge check failed.')) return 'queueGateFailure';
  if (prompt.startsWith('The coordinator could not land your work: your branch contains active planning documents')) return 'queueActiveDocuments';
  if (prompt.startsWith('Plan Queue reminder') && prompt.includes('without a recorded report')) return 'queueWorkerReminder';
  if (prompt.startsWith('Plan Queue reminder') && prompt.includes('without a recorded verdict')) return 'queueVerifierReminder';
  if (prompt.startsWith('You are the Plan Queue triage agent.')) return 'queueTriage';
  if (prompt.startsWith('You are an independent Plan Queue verifier.')) return prompt.includes('remediation register') ? 'queueLivetestVerifier' : 'queueVerifier';
  return undefined;
}

/** Log one injected queue prompt under the key of its ceiling; a prompt with no ceiling logs nothing. */
export function logQueuePrompt(prompt: string | null | undefined, session: string): void {
  const surface = prompt ? queuePromptSurface(prompt) : undefined;
  if (surface) logPromptInjection(surface, prompt, session);
}
