import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * This screen had no spec at all, which is why three review rounds missed that its
 * empty-transcript placeholder said "Connecting…" forever on an expired pairing.
 * A relaunch resumes straight back here (`resume-route.ts` restores `/projects…`),
 * so it is a likely landing spot for a phone whose token died overnight.
 */
describe('ConversationComponent connection surfaces', () => {
  const dir = 'src/app/features/conversation';
  const html = readFileSync(resolve(`${dir}/conversation.component.html`), 'utf8');
  const ts = readFileSync(resolve(`${dir}/conversation.component.ts`), 'utf8');

  it('routes every connection-dependent string through the shared helpers', () => {
    expect(html).toContain('{{ emptyTranscript() }}');
    expect(html).toContain('connectionHeadline()');
    expect(ts).toContain('emptyTranscriptText(this.gateway.state())');
    expect(ts).toContain('connectionHeadline(this.gateway.state())');
    expect(ts).toContain('connectionLabel(this.gateway.state())');
  });

  it('reports failed menu actions instead of swallowing them', () => {
    // Rename and Terminate used to `catch { /* ignore */ }`, so a rejected token
    // made them look like dead buttons while their siblings showed a notice.
    expect(ts).toContain('Rename failed: ${errorText(err)}');
    expect(ts).toContain('Terminate failed: ${errorText(err)}');
    expect(ts).not.toContain('/* ignore */');
    expect(html).toContain('(click)="rename()" [disabled]="!online()"');
  });

  it('no longer hard-codes connection copy that hides an expired pairing', () => {
    expect(html).not.toContain("'Connecting…'");
    expect(html).not.toContain("'Offline'");
    expect(ts).not.toContain(": 'offline'");
  });
});
