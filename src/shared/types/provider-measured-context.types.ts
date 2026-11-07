export interface ContextAdvice {
  id: string;
  level: 'info' | 'act';
  text: string;
  tokens?: number;
  action?: 'compact-now' | 'open-usage';
}
export interface ProviderMeasuredContext {
  categories: { name: string; tokens: number; isDeferred?: boolean }[];
  totalTokens: number;
  maxTokens: number;
  autoCompactThreshold?: number;
  isAutoCompactEnabled?: boolean;
  memoryFiles: { name: string; tokens: number }[];
  connectorTools: { server: string; loadedTokens: number; deferredTokens: number }[];
  topTools: { name: string; tokens: number }[];
  toolResultTokens?: number;
}
export type ContextProviderMeasurement = { status: 'measured'; measured: ProviderMeasuredContext; advice: ContextAdvice[] }
  | { status: 'not-running' | 'not-supported' | 'timeout' | 'error'; advice: ContextAdvice[] };
