/** A measured retrieved block, credited only after its physical send succeeds. */
export interface InputContextDelivery { messageId: string; deliveryId: string; tokens: number | null }
export interface InstanceInputContextDeliveredEvent extends InputContextDelivery { instanceId: string }
export type RetrievedContextDeliveries = Record<string, number | null>;
export type RetrievedContextMetadata = Partial<Record<'rlmContext' | 'unifiedMemoryContext' | 'indexedCodebaseContext', { injected: true; tokens: number | null }>>;
