import type { HelpEntry } from '../help-content.types';

/** Keep aligned with the one-row session header and the controls beside the message box. */
export const SESSION_HELP: HelpEntry = {
  sections: [
    { kind: 'callout', variant: 'info', heading: 'Working in a session', body: 'A session is one conversation with an artificial intelligence agent. Its name and folder are at the top. The model, account and context are beside the message box at the bottom, where you write to the agent.' },
    { kind: 'list', heading: 'At the top', items: [
      'Double-click the session name to rename it.',
      'Open lets you open the working folder in an editor, file manager or terminal. Files and source control show files and changes when available.',
      'Session options changes Build, Plan or Review, Auto-approve, Fast and desktop control. A small label appears next to it only while one of them is not at its normal setting, so a normal session shows none.',
      'The cost so far appears here when cost display is on in Settings.',
    ] },
    { kind: 'list', heading: 'Beside the message box', items: [
      'The model picker chooses which model answers. A change requested while the agent is working takes effect when the current reply finishes; select the pending change to cancel it.',
      'The ring shows how full the model’s memory is, when the provider reports it. Select it for Context details, where the memory goes, and Compact now.',
    ] },
    { kind: 'list', heading: 'Writing to the agent', items: [
      'Messages sent while the agent is working wait in a queue. Steer sends a message ahead of other queued messages to change what it does next.',
      'Stop, beside the message box, interrupts the current work whenever the agent is busy, even with text typed. A paused queue stays paused until you select Resume.',
      'Loop Mode keeps the agent working towards a goal. Its help button explains the checks and limits that stop it.',
    ] },
    { kind: 'callout', variant: 'warning', heading: 'Auto-approve is risky', body: 'With auto-approve on, the agent can change files and run commands without asking. Use it in folders where you can afford to lose changes.' },
  ],
};
