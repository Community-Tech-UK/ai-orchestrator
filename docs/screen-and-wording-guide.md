# Screen and wording guide

Read this before changing anything under `src/renderer/` or any text a user can see: labels, tooltips, messages,
notifications and help. This says where Harness is going. Screens that disagree are debt, not precedent.
When James gives the same feedback twice, add it here as a rule.
Tokens and layout live in `docs/shell-component-standards.md`; this page owns wording and screen behaviour.

## 1. Words

- The product is Harness. Never AIO, Orchestrator or AI Orchestrator on screen.
- Follow `src/shared/copy/ui-vocabulary.ts`: use one name for each concept. Say session and helper agent.
  A page title is its menu label. The vocabulary migration and guard remain Phase 3 work; planned rows are guidance.
- Plain English, sentence case. Say what happened, what it means and what to do next. Codes, ids, raw statuses and
  stack text go behind Details. Never say Harness is fixing something unless a fix is running.
- Remove introductory copy when the title, control or nearby status already explains the task. Keep text that
  changes a decision, explains a failure or gives a required next step.
- Settings names describe what the user wants done. A word that needs explaining gets an entry in GLOSSARY
  (`src/renderer/app/shared/glossary/glossary.ts`) and an `<app-term>` on its first use.
  Inside another control, use `termTooltip()` instead of nesting a button.

## 2. Status

- Use one shared source for session labels and colours. Do not introduce a local status-to-label map.
  The unified status presenter is pending Phase 3; do not assume a helper exists until it ships.
- State is never carried by colour or a glyph alone, and never only in a tooltip.
- Healthy is invisible: no chip, dot or banner unless something needs attention or differs from the default.
- Status panels explain; they do not configure. A link to Settings is fine; a second settings page is not.

## 3. What may sit in the session header and composer

Always visible: what the agent may do without asking (auto-approve), the model, how full the context is, and Send or
Stop. For anything else, ask:
1. Would nearly every session use it?
2. Can the state be read from somewhere else?
3. Does the user choose it on purpose through a menu, `/` or `@`, rather than a permanent switch?
Abilities the agent chooses for itself, such as tools, skills and tool servers, never become persistent toggles.
Every chip is visible, removable and says what it costs. On narrow windows the least-used items collapse first;
auto-approve is never hidden. Phase 3 owns the header layout change; current help describes the current controls.

## 4. Notices

- A banner only if it changes what Send does. Anything else is one quiet transcript line with one action.
- At most one banner row; extra ones collapse to N more. Errors stay until dismissed and offer the fix as a button.
  A notice names the session and opens it. Phase 3 owns the shared banner mechanism; this is the admission rule.

## 5. Controls and hints

- Every icon-only control has a tooltip and an accessible name with the same words. No new native `title` on controls.
  Use `[appIconButton]` to supply both from one phrase; `appTooltipShortcut` reads the live shortcut.
  `appTooltipDisabledReason` keeps a lasting disabled state focusable and explains its reason.
- A tooltip is a short phrase, not a paragraph or a copy of a visible label. Name menu items so they explain themselves.
  Text lives in TOOLTIP_COPY when it carries a consequence, is used twice or is long.
- A tooltip may elaborate, but never holds the only state or consequence. Actions that delete, stop work, spend money
  or bypass approval say so beside the control or in a confirmation.
- A control that stays disabled explains why to keyboard users through `aria-disabled` and its reason.
  A control disabled briefly shows progress in its label.
- Shortcuts shown to the user come from live key bindings, never typed glyphs.

## 6. Reviewing a renderer change

Look at the changed lines only for this wording check. Do not build, trace or ask for screenshots as part of it.
Report each check below that you can point to, with the line. If none apply, answer exactly `All clear`.
1. An icon-only control without a tooltip and an accessible name.
2. A native `title` on a control.
3. New raw status text, internal code or jargon in text a user can see.
4. A local status-to-label map instead of the shared status presentation convention.
5. A destructive, money-spending or auto-approving action whose consequence is not shown next to it.
These advisory notes do not replace the task’s normal verification and never determine whether a loop may finish.
The template ratchet (`npm run check:ui-hints`) enforces checks 1 and 2 file by file; reviewers judge checks 3 to 5.
