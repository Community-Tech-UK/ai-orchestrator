import type { ChatService } from './chat-service';

// Read-only consumers such as history must not load the chat runtime just to
// check whether it has been initialized. This is the singleton's only state.
let instance: ChatService | null = null;

export function getInitializedChatService(): ChatService | null {
  return instance;
}

export function setInitializedChatService(service: ChatService | null): void {
  instance = service;
}
