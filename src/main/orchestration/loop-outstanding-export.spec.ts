import { describe, expect, it } from 'vitest';
import type { LoopOutstandingItem } from '../../shared/types/loop.types';
import { buildOutstandingMarkdown } from './loop-outstanding-export';

function item(overrides: Partial<LoopOutstandingItem> = {}): LoopOutstandingItem {
  return {
    id: 'id-1',
    loopRunId: 'loop-1',
    chatId: 'chat-1',
    workspaceCwd: '/tmp/project',
    kind: 'needs-human',
    text: 'Deploy to a device',
    userResponse: null,
    status: 'open',
    loopStatus: 'completed-needs-review',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    resolvedAt: null,
    ...overrides,
  };
}

const GENERATED_AT = 1_700_000_500_000;

describe('buildOutstandingMarkdown', () => {
  it('renders an empty-state digest when there are no items', () => {
    const md = buildOutstandingMarkdown([], { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });
    expect(md).toContain('# Outstanding');
    expect(md).toContain('_No open outstanding items._');
  });

  it('groups items by run and splits by kind', () => {
    const items: LoopOutstandingItem[] = [
      item({ id: 'a', kind: 'needs-human', text: 'Sign the release' }),
      item({ id: 'b', kind: 'open-question', text: 'Cache the model?' }),
      item({ id: 'c', loopRunId: 'loop-2', kind: 'needs-human', text: 'Other run item' }),
    ];
    const md = buildOutstandingMarkdown(items, { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });

    expect(md).toContain('## Loop loop-1');
    expect(md).toContain('## Loop loop-2');
    expect(md).toContain('### Needs human');
    expect(md).toContain('- [ ] Sign the release');
    expect(md).toContain('### Open questions');
    expect(md).toContain('- Cache the model?');
    expect(md).toContain('- [ ] Other run item');
    // The run header carries the loop's terminal status.
    expect(md).toContain('Status: completed-needs-review');
  });

  it('renders a recorded answer as an indented sub-bullet', () => {
    const items = [
      item({ id: 'a', kind: 'needs-human', text: 'Pick interrupt mechanism', userResponse: 'Use control_request' }),
      item({ id: 'b', kind: 'open-question', text: 'Cache the model?', userResponse: 'Yes, 30m TTL\ninvalidate on deploy' }),
      item({ id: 'c', kind: 'needs-human', text: 'No answer yet', userResponse: null }),
    ];
    const md = buildOutstandingMarkdown(items, { workspaceCwd: '/tmp/project', generatedAt: GENERATED_AT });

    expect(md).toContain('- [ ] Pick interrupt mechanism');
    expect(md).toContain('  - **Answer:** Use control_request');
    // Multi-line answers keep their continuation lines nested under the item.
    expect(md).toContain('  - **Answer:** Yes, 30m TTL');
    expect(md).toContain('    invalidate on deploy');
    // An item with no answer gets no Answer line directly under it — the next
    // line is the section break, not an Answer sub-bullet.
    expect(md).toContain('- [ ] No answer yet\n\n### Open questions');
  });
});
