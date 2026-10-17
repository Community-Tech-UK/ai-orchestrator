import type { AcpSessionResponseRequest } from './acp-session-config-response';

export interface AcpPendingRequest extends AcpSessionResponseRequest {
  preserveSessionIdentity?: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** Timer that rejects the pending promise if the agent never replies.
   *  Cleared on any settle path (resolve, reject, cancel, terminate). */
  timer: ReturnType<typeof setTimeout>;
  timeoutMs: number;
}

