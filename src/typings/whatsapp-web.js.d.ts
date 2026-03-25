/**
 * Ambient module declaration for whatsapp-web.js
 * The actual package is loaded lazily at runtime only when a WhatsApp connection is initiated.
 */
declare module 'whatsapp-web.js' {
  export class Client {
    constructor(options?: Record<string, unknown>);
    on(event: string, listener: (...args: unknown[]) => void): this;
    initialize(): Promise<void>;
    sendMessage(chatId: string, content: unknown, options?: Record<string, unknown>): Promise<unknown>;
    getChats(): Promise<unknown[]>;
    destroy(): Promise<void>;
    info: { wid: { user: string }; pushname: string };
  }

  export class LocalAuth {
    constructor(options?: { dataPath?: string });
  }

  export class MessageMedia {
    static fromFilePath(filePath: string): MessageMedia;
    static fromUrl(url: string, options?: Record<string, unknown>): Promise<MessageMedia>;
  }
}
