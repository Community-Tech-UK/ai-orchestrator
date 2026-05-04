import type { ConversationProvider } from '../../shared/types/conversation-ledger.types';
import type { NativeConversationAdapter } from './native-conversation-adapter';

export class NativeConversationRegistry {
  private static instance: NativeConversationRegistry | null = null;
  private readonly adapters = new Map<ConversationProvider, NativeConversationAdapter>();

  static getInstance(): NativeConversationRegistry {
    this.instance ??= new NativeConversationRegistry();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  register(adapter: NativeConversationAdapter, options: { override?: boolean } = {}): void {
    if (this.adapters.has(adapter.provider) && !options.override) {
      throw new Error(`Native conversation adapter already registered for ${adapter.provider}`);
    }
    this.adapters.set(adapter.provider, adapter);
  }

  get(provider: ConversationProvider): NativeConversationAdapter | undefined {
    return this.adapters.get(provider);
  }

  listCapabilities() {
    return Array.from(this.adapters.values()).map(adapter => adapter.getCapabilities());
  }
}

export function getNativeConversationRegistry(): NativeConversationRegistry {
  return NativeConversationRegistry.getInstance();
}
