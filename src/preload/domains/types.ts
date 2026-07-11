/**
 * Shared types for preload domain modules.
 */

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    timestamp: number;
  };
}
