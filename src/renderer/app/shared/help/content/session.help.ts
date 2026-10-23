import type { HelpEntry } from '../help-content.types';

/** Keep aligned with the current header; Phase 3's new layout has not shipped. */
export const SESSION_HELP: HelpEntry = {
  sections: [
    { kind: 'callout', variant: 'info', heading: 'Working in a session', body: 'A session is one conversation with an artificial intelligence agent. Its name, controls and model are at the top. Write to the agent in the message box at the bottom.' },
    { kind: 'list', heading: 'At the top', items: [
      'Double-click the session name to rename it.',
      'Open lets you open the working folder in an editor or file manager. The terminal button opens a terminal there. Files and source control show files and changes when available.',
      'The model picker chooses which model answers. A change requested while the agent is working takes effect when the current reply finishes; select the pending change to cancel it.',
      'Build, Plan and Review choose the kind of work. Auto-approve controls permission prompts, and Fast selects a faster provider option where supported.',
      'The context bar shows how full the model’s memory is, when the provider reports it.',
    ] },
    { kind: 'list', heading: 'Writing to the agent', items: [
      'Messages sent while the agent is working wait in a queue. Steer sends a message ahead of other queued messages to change what it does next.',
      'Stop interrupts the current work. A paused queue stays paused until you select Resume.',
      'Loop Mode keeps the agent working towards a goal. Its help button explains the checks and limits that stop it.',
    ] },
    { kind: 'callout', variant: 'warning', heading: 'Auto-approve is risky', body: 'With auto-approve on, the agent can change files and run commands without asking. Use it in folders where you can afford to lose changes.' },
  ],
};
