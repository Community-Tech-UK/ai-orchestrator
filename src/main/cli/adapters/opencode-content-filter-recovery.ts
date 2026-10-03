import { isReadOnlyProviderTool } from './acp-doom-loop-permission';

type NativeRequest = (path: string, init?: RequestInit) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Exclude a proven latest read result from OpenCode model conversion while retaining its forensic transcript. */
export async function sanitizeOpenCodeContentFilterSource(request: NativeRequest, sessionId: string, signal?: AbortSignal, expectedToolCallId?: string): Promise<boolean> {
  if (signal?.aborted) return false;
  try {
    const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
    const messages = await request(`${sessionPath}/message?limit=20`, { signal });
    if (signal?.aborted || !Array.isArray(messages)) return false;
    let latestTool: Record<string, unknown> | undefined;
    let sawUser = false;
    for (const message of messages) {
      if (!record(message) || !record(message['info']) || !Array.isArray(message['parts'])) return false;
      if (message['info']['role'] === 'user') { sawUser = true; latestTool = undefined; }
      if (message['info']['role'] !== 'assistant') continue;
      for (const part of message['parts']) if (record(part) && part['type'] === 'tool') latestTool = part;
    }
    if (!sawUser || !latestTool || typeof latestTool['tool'] !== 'string' || !isReadOnlyProviderTool(latestTool['tool'])) return false;
    const part = latestTool;
    if (expectedToolCallId !== undefined && part['callID'] !== expectedToolCallId) return false;
    const state = part['state'];
    if (!record(state) || state['status'] !== 'completed' || !record(state['time']) || typeof part['id'] !== 'string' || typeof part['messageID'] !== 'string' || part['sessionID'] !== sessionId) return false;
    if (typeof state['time']['compacted'] === 'number' && state['time']['compacted'] > 0) return false;
    const compacted = Date.now();
    const messagePath = `${sessionPath}/message/${encodeURIComponent(part['messageID'])}`;
    if (signal?.aborted) return false;
    await request(`${messagePath}/part/${encodeURIComponent(part['id'])}`, {
      method: 'PATCH', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...part, state: { ...state, time: { ...state['time'], compacted } } }),
    });
    if (signal?.aborted) return false;
    const persisted = await request(messagePath, { signal });
    if (signal?.aborted || !record(persisted) || !Array.isArray(persisted['parts'])) return false;
    return persisted['parts'].some((candidate: unknown) => record(candidate) && candidate['id'] === part['id'] && record(candidate['state']) && record(candidate['state']['time']) && candidate['state']['time']['compacted'] === compacted);
  } catch { return false; }
}
