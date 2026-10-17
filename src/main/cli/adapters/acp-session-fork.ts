import type { AcpSessionNewParams } from '../../../shared/types/cli.types';

/** Clone before starting another process; reserve the source's input admission until the snapshot exists. */
export async function forkAcpSession(
  context: { ready: boolean; active: boolean; supported: boolean; sessionId: string | null; params: AcpSessionNewParams },
  reserve: (active: boolean) => void,
  request: (params: AcpSessionNewParams & { sessionId: string }) => Promise<{ sessionId: string }>,
): Promise<string> {
  if (!context.ready || !context.supported || !context.sessionId) throw new Error('Native session fork is unavailable.');
  if (context.active) throw new Error('Cannot fork while the source turn is running.');
  reserve(true);
  try {
    const result = await request({ ...context.params, sessionId: context.sessionId });
    if (typeof result?.sessionId !== 'string' || !result.sessionId.trim() || result.sessionId === context.sessionId) throw new Error('ACP fork did not return a new session identity.');
    return result.sessionId;
  } finally { reserve(false); }
}
