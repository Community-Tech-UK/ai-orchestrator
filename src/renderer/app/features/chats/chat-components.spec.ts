import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat feature templates', () => {
  it('renders the top-level Chats group and create-chat controls', () => {
    const template = readFileSync(
      'src/renderer/app/features/chats/chat-sidebar.component.html',
      'utf-8',
    );
    const source = readFileSync(
      'src/renderer/app/features/chats/chat-sidebar.component.ts',
      'utf-8',
    );

    expect(template).toContain('New chat');
    expect(template).toContain('<div class="chat-group-label">Chats</div>');
    expect(template).toContain('chatStore.chats()');
    expect(template).toContain('archiveChat($event, chat.id)');
    expect(source).toContain("this.historyStore.clearSelection()");
    expect(source).toContain("this.instanceStore.setSelectedInstance(null)");
  });

  it('gates the composer behind migrated-chat bootstrap fields', () => {
    const template = readFileSync(
      'src/renderer/app/features/chats/chat-detail.component.html',
      'utf-8',
    );

    expect(template).toContain('Setup required');
    expect(template).toContain('[disabled]="!setupComplete() || chatStore.sending()"');
    expect(template).toContain("setupComplete() ? 'Send a message...' : 'Choose provider and project first'");
    // Provider + model selection now lives in the compact picker; project (cwd)
    // selection still uses ngModel + keydown.enter.
    expect(template).toContain('<app-compact-model-picker');
    expect(template).toContain('mode="live-instance"');
    expect(template).toContain('(keydown.enter)="applyCwd()"');
  });

  it('surfaces chat-scoped operator runs with refresh and cancellation actions', () => {
    const template = readFileSync(
      'src/renderer/app/features/chats/chat-detail.component.html',
      'utf-8',
    );
    const source = readFileSync(
      'src/renderer/app/features/chats/chat-detail.component.ts',
      'utf-8',
    );

    expect(template).toContain('aria-label="Chat runs"');
    expect(template).toContain('(click)="refreshRuns()"');
    expect(template).toContain('(click)="cancelRun(run.id)"');
    expect(source).toContain('this.operatorIpc.listRuns({ threadId, limit: 5 })');
    expect(source).toContain('this.operatorIpc.cancelRun(runId)');
  });
});
