import { describe, expect, it, vi } from 'vitest';
import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import type { DisplayItem } from './display-item.types';
import { OutputStreamComponent } from './output-stream.component';

describe('OutputStreamComponent Council reply action', () => {
  it('routes the session second opinion without pre-filling or opening Council', () => {
    const openAskCouncil = vi.fn();
    const requestReview = vi.fn().mockResolvedValue({ success: true });
    const closeContextMenu = vi.fn();
    const reply = { id: 'answer', timestamp: 2, type: 'assistant', content: 'Open Export in Settings.' };
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      instanceId: () => 'session-1',
      replyActions: { openAskCouncil, requestReview },
      closeContextMenu,
    }) as { buildContextMenuItems(item: DisplayItem): ContextMenuItem[] };
    const item = { id: 'reply-item', type: 'message', message: reply, bufferIndex: 1 } as DisplayItem;
    component.buildContextMenuItems(item).find(entry => entry.label === 'Get a second opinion')!.action();
    expect(requestReview).toHaveBeenCalledExactlyOnceWith('session-1');
    expect(closeContextMenu).toHaveBeenCalledOnce();
    expect(openAskCouncil).not.toHaveBeenCalled();
  });

  it('closes the menu, builds the matching question and reply, and opens Council', () => {
    const openAskCouncil = vi.fn();
    const closeContextMenu = vi.fn();
    const question = { id: 'question', timestamp: 1, type: 'user', content: 'How do I export?' };
    const reply = { id: 'answer', timestamp: 2, type: 'assistant', content: 'Open Export in Settings.' };
    // Use the production menu callback without starting unrelated scroll effects.
    const component = Object.assign(Object.create(OutputStreamComponent.prototype), {
      messages: () => [question, reply],
      olderMessagesHiddenCount: () => 100,
      replyActions: { openAskCouncil },
      closeContextMenu,
    }) as { buildContextMenuItems(item: DisplayItem): ContextMenuItem[] };
    const item = { id: 'reply-item', type: 'message', message: reply, bufferIndex: 101 } as DisplayItem;
    const action = component.buildContextMenuItems(item).find((entry) => entry.label === 'Ask other models about this reply');
    expect(action).toBeDefined();
    expect(openAskCouncil).not.toHaveBeenCalled();
    action!.action();
    const prompt = openAskCouncil.mock.calls[0]?.[0] as string;
    expect(prompt).toContain('<question>\nHow do I export?\n</question>');
    expect(prompt).toContain('<answer>\nOpen Export in Settings.\n</answer>');
    expect(closeContextMenu).toHaveBeenCalledOnce();
  });
});
