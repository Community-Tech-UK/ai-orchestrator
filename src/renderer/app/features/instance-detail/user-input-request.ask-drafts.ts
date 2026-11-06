/**
 * What the person has chosen or typed so far for the questions on a waiting
 * card. One place holds it so the card's buttons and the message box fill in
 * the same answers, and a card with several questions is only sent once every
 * question has one.
 */

import { signal } from '@angular/core';
import type { AskUserQuestionEntry } from '../../../../shared/types/ask-user-question.types';
import { isAcpInputRequired } from './user-action-request.input-required';
import type { UserActionRequest } from './user-action-request.types';
import { questionSlots } from './user-input-request.kinds';

export interface AppliedAnswer {
  /** The question the text went to. */
  index: number;
  /** True once every question has an answer, so the card can be sent. */
  complete: boolean;
  /** Questions still waiting for an answer. */
  remaining: number;
  /** Picked from the choices, or kept as typed. */
  as: 'choice' | 'typed';
}

/** Typed text and option labels are compared ignoring case and spacing. */
export const normaliseChoice = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/** The option labels the text names: one for a single choice, a list for a multi-select. */
function matchingLabels(entry: AskUserQuestionEntry, text: string): string[] {
  const wanted = normaliseChoice(text);
  const exact = entry.options.filter((option) => normaliseChoice(option.label) === wanted).map((option) => option.label);
  if (exact.length > 0) return entry.multiSelect ? exact : [exact[0]];
  if (!entry.multiSelect) return [];
  const parts = text.split(/[,;\n]+/).map(normaliseChoice).filter(Boolean);
  if (parts.length < 2) return [];
  const labels = parts.map((part) => entry.options.find((option) => normaliseChoice(option.label) === part)?.label);
  return labels.every((label): label is string => label !== undefined) ? [...new Set(labels)] : [];
}

export class AskAnswerDrafts {
  /** Read by every getter, so a template that calls them re-renders when a draft changes. */
  private readonly revision = signal(0);
  private readonly picks = new Map<string, Map<number, Set<string>>>();
  private readonly texts = new Map<string, Map<number, string>>();

  isPicked(requestId: string, index: number, label: string): boolean {
    this.revision();
    return this.picks.get(requestId)?.get(index)?.has(label) ?? false;
  }

  text(requestId: string, index: number): string {
    this.revision();
    return this.texts.get(requestId)?.get(index) ?? '';
  }

  /** A click on a choice. A single-select holds one; a multi-select toggles each. */
  toggle(requestId: string, index: number, label: string, multiSelect: boolean): void {
    const current = new Set(this.picks.get(requestId)?.get(index));
    const wasPicked = current.has(label);
    if (!multiSelect) current.clear();
    if (!wasPicked) current.add(label);
    else if (multiSelect) current.delete(label);
    this.store(requestId, index, current, '');
  }

  setText(requestId: string, index: number, text: string): void {
    this.store(requestId, index, undefined, text);
  }

  canSubmit(request: UserActionRequest): boolean {
    const entries = questionSlots(request);
    return !!entries?.length && entries.every((entry, index) => this.isAnswered(request.id, entry, index));
  }

  /** The reply for the agent: ACP forms get JSON keyed by field, everything else one line per question. */
  responseText(request: UserActionRequest): string {
    const entries = questionSlots(request) ?? [];
    if (isAcpInputRequired(request)) {
      return JSON.stringify(Object.fromEntries(entries.map((entry, index) => {
        const { typed, picked } = this.parts(request.id, index);
        const value = entry.options.length === 0 ? typed
          : typed ? (entry.multiSelect ? [typed] : typed)
            : entry.multiSelect ? picked : picked[0];
        return [entry.header || entry.question, value];
      })));
    }
    return entries.map((entry, index) => {
      const { typed, picked } = this.parts(request.id, index);
      return `${entry.header || entry.question}: ${typed || picked.join(', ')}`;
    }).join('\n').trim();
  }

  /** Just the answers, joined on one line, for the receipt. */
  summary(request: UserActionRequest): string {
    return (questionSlots(request) ?? [])
      .map((_, index) => {
        const { typed, picked } = this.parts(request.id, index);
        return typed || picked.join(', ');
      })
      .filter(Boolean)
      .join('; ');
  }

  /**
   * Takes text typed in the message box. A choice the text names wins, looking
   * at the questions still open first; otherwise the text answers the first open
   * question (or the last one, when all are answered). Never sends anything.
   */
  apply(request: UserActionRequest, text: string): AppliedAnswer | undefined {
    const entries = questionSlots(request);
    const typed = text.trim();
    if (!entries?.length || !typed) return undefined;
    const open = entries.flatMap((entry, index) => (this.isAnswered(request.id, entry, index) ? [] : [index]));
    for (const index of open.length > 0 ? open : entries.keys()) {
      const labels = matchingLabels(entries[index], typed);
      if (labels.length === 0) continue;
      const kept = entries[index].multiSelect ? new Set(this.picks.get(request.id)?.get(index)) : new Set<string>();
      labels.forEach((label) => kept.add(label));
      this.store(request.id, index, kept, '');
      return this.outcome(request.id, entries, index, 'choice');
    }
    const index = open[0] ?? entries.length - 1;
    this.store(request.id, index, new Set(), typed);
    return this.outcome(request.id, entries, index, 'typed');
  }

  clear(requestId: string): void {
    this.picks.delete(requestId);
    this.texts.delete(requestId);
    this.revision.update((count) => count + 1);
  }

  private parts(requestId: string, index: number): { typed: string; picked: string[] } {
    return {
      typed: (this.texts.get(requestId)?.get(index) ?? '').trim(),
      picked: [...(this.picks.get(requestId)?.get(index) ?? [])],
    };
  }

  private isAnswered(requestId: string, entry: AskUserQuestionEntry, index: number): boolean {
    const { typed, picked } = this.parts(requestId, index);
    return typed !== '' || (entry.options.length > 0 && picked.length > 0);
  }

  private outcome(requestId: string, entries: AskUserQuestionEntry[], index: number, as: AppliedAnswer['as']): AppliedAnswer {
    const remaining = entries.filter((entry, position) => !this.isAnswered(requestId, entry, position)).length;
    return { index, complete: remaining === 0, remaining, as };
  }

  /** Sets a question's choices and text together, so a typed answer and a click never both stand. */
  private store(requestId: string, index: number, picked: Set<string> | undefined, text: string): void {
    if (picked) {
      const byQuestion = this.picks.get(requestId) ?? new Map<number, Set<string>>();
      byQuestion.set(index, picked);
      this.picks.set(requestId, byQuestion);
    }
    const textByQuestion = this.texts.get(requestId) ?? new Map<number, string>();
    textByQuestion.set(index, text);
    this.texts.set(requestId, textByQuestion);
    this.revision.update((count) => count + 1);
  }
}
