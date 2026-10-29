import type { TooltipCopyEntry } from './tooltip-copy';

export const RESUME_PLAN_QUEUE_COPY = {
  'planQueue.pauseRun': { label: 'Pause', meaning: 'Stops anything new from starting and pauses work already running. Paused work is saved and carries on when you resume.' },
  'planQueue.resumeRun': { label: 'Resume', meaning: 'Lets new documents and checks start again.' },
  'planQueue.cancelRun': { label: 'Cancel', meaning: 'Opens the confirmation to end this run and park work in progress.' },
  'planQueue.skip': { label: 'Skip', meaning: 'Opens the confirmation to leave this document out of this run.' },
  'planQueue.refresh': { label: 'Refresh', meaning: 'Checks for leftover workspaces and branches again.' },
  'planQueue.start': { label: 'Start run', meaning: 'Starts working through the selected documents.' },
  'planQueue.chooseParent': { label: 'Start run', meaning: 'Choose a parent session first.' },
  'planQueue.submit': { label: 'Submit answer', meaning: 'Sends this answer so the document can continue.' },
  'planQueue.chooseAnswer': { label: 'Submit answer', meaning: 'Pick an answer first.' },
} as const satisfies Record<string, TooltipCopyEntry>;
