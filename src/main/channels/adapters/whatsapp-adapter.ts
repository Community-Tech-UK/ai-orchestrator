/**
 * WhatsApp Adapter - whatsapp-web.js implementation of ChannelAdapter
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../../logging/logger';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  ChannelPlatform,
  ChannelConfig,
  SendOptions,
  SentMessage,
  InboundChannelMessage,
} from '../../../shared/types/channels';

const logger = getLogger('WhatsAppAdapter');

const WHATSAPP_MAX_LENGTH = 65536;

export class WhatsAppAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'whatsapp';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any = null;
  private phoneNumber: string | null = null;

  async connect(_config: ChannelConfig): Promise<void> {
    this.setStatus('connecting');
    logger.info('Connecting to WhatsApp...');

    try {
      // Lazy import whatsapp-web.js and puppeteer-core
      const { Client: WAClient, LocalAuth } = await import('whatsapp-web.js');
      const puppeteer = await import('puppeteer-core');

      // Find Chrome executable
      const chromePath = this.findChromePath();
      if (!chromePath) {
        const errorMsg = 'Chrome/Chromium not found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH environment variable.';
        logger.error(errorMsg);
        this.setStatus('disconnected');
        this.emitError(errorMsg, false);
        return;
      }

      this.client = new WAClient({
        authStrategy: new LocalAuth({
          dataPath: this.getDataPath(),
        }),
        puppeteer: {
          executablePath: chromePath,
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
          ...(puppeteer as unknown as object),
        },
      });

      this.client.on('qr', (qr: string) => {
        logger.info('QR code received, waiting for scan...');
        this.emit('qr', qr);
      });

      this.client.on('authenticated', () => {
        logger.info('WhatsApp authenticated');
      });

      this.client.on('ready', () => {
        this.phoneNumber = this.client?.info?.wid?.user ?? null;
        logger.info('Connected to WhatsApp', { phoneNumber: this.phoneNumber });
        this.setStatus('connected', { phoneNumber: this.phoneNumber ?? undefined });
      });

      this.client.on('auth_failure', (msg: string) => {
        logger.error('WhatsApp auth failure', undefined, { message: msg });
        this.setStatus('error');
        this.emitError(`Authentication failed: ${msg}`, true);
      });

      this.client.on('disconnected', (reason: string) => {
        logger.info('WhatsApp disconnected', { reason });
        this.setStatus('disconnected');
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.client.on('message', (message: any) => {
        this.handleMessage(message).catch((err: unknown) => {
          logger.error('Error handling WhatsApp message', err instanceof Error ? err : new Error(String(err)));
        });
      });

      await this.client.initialize();

      // Apply config allowlists
      if (_config.allowedSenders.length > 0) {
        this.accessPolicy.allowedSenders = [..._config.allowedSenders];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to connect to WhatsApp', err instanceof Error ? err : new Error(message));
      this.setStatus('error');
      this.emitError(`Failed to connect: ${message}`, true);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      logger.info('Disconnecting from WhatsApp');
      try {
        await this.client.destroy();
      } catch (err) {
        logger.warn('Error during WhatsApp disconnect', { error: err });
      }
      this.client = null;
      this.phoneNumber = null;
      this.setStatus('disconnected');
    }
  }

  async sendMessage(chatId: string, content: string, options?: SendOptions): Promise<SentMessage> {
    if (!this.client) throw new Error('WhatsApp client not connected');

    const chunks = this.chunkMessage(content, options?.splitAt ?? WHATSAPP_MAX_LENGTH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastMessage: any;

    for (const chunk of chunks) {
      if (options?.replyTo && chunk === chunks[0]) {
        lastMessage = await this.client.sendMessage(chatId, chunk, { quotedMessageId: options.replyTo });
      } else {
        lastMessage = await this.client.sendMessage(chatId, chunk);
      }
    }

    return {
      messageId: lastMessage?.id?._serialized ?? lastMessage?.id ?? String(Date.now()),
      chatId,
      timestamp: (lastMessage?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    };
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<SentMessage> {
    if (!this.client) throw new Error('WhatsApp client not connected');

    const { MessageMedia } = await import('whatsapp-web.js');
    const media = MessageMedia.fromFilePath(filePath);
    const message = await this.client.sendMessage(chatId, media, {
      caption: caption ?? '',
    });

    return {
      messageId: message?.id?._serialized ?? message?.id ?? String(Date.now()),
      chatId,
      timestamp: (message?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async editMessage(_chatId: string, _messageId: string, _content: string): Promise<void> {
    throw new Error('WhatsApp does not support editing messages');
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('WhatsApp client not connected');

    const chat = await this.client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit: 50 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target = messages.find((m: any) =>
      (m.id._serialized ?? m.id) === messageId
    );
    if (target) {
      await target.react(emoji);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleMessage(message: any): Promise<void> {
    // Ignore messages from self
    if (message.fromMe) return;

    const contact = await message.getContact();
    const chat = await message.getChat();
    const isGroup = chat.isGroup ?? false;
    const isDM = !isGroup;

    const senderId = message.author ?? message.from;
    const senderName = contact?.pushname ?? contact?.name ?? senderId;

    // In groups, check if bot is mentioned (via @)
    if (isGroup) {
      const mentions = await message.getMentions();
      const botNumber = this.client?.info?.wid?.user;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const isMentioned = mentions.some((m: any) => m.id?.user === botNumber);
      if (!isMentioned && !message.body?.includes(`@${botNumber}`)) return;
    }

    // Access gate
    if (!this.isSenderAllowed(senderId)) {
      const pending = this.handlePairingRequest(senderId, senderName);
      if (pending) {
        try {
          await message.reply(
            `You're not yet paired with this bot. Your pairing code is: *${pending.code}*\nEnter this code in the Orchestrator UI to pair your account. Code expires in 5 minutes.`
          );
        } catch (err) {
          logger.warn('Failed to send pairing code', { senderId, error: err });
        }
      }
      return;
    }

    // Build inbound message
    const inbound: InboundChannelMessage = {
      id: crypto.randomUUID(),
      platform: 'whatsapp',
      chatId: chat.id._serialized ?? message.from,
      messageId: message.id._serialized ?? message.id,
      threadId: message.hasQuotedMsg ? `wa-quote-${message.id._serialized}` : undefined,
      senderId,
      senderName,
      content: message.body ?? '',
      attachments: message.hasMedia ? [{
        name: 'attachment',
        type: message.type ?? 'unknown',
        size: 0,
        url: undefined,
      }] : [],
      isGroup,
      isDM,
      replyTo: message.hasQuotedMsg ? message._data?.quotedStanzaID : undefined,
      timestamp: (message.timestamp ?? Math.floor(Date.now() / 1000)) * 1000,
    };

    this.emit('message', inbound);
  }

  private findChromePath(): string | null {
    // Check env var first
    const envPath = process.env['PUPPETEER_EXECUTABLE_PATH'];
    if (envPath) return envPath;

    // Check common locations
    const paths = process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
          ];

    for (const p of paths) {
      try {
        if (fs.existsSync(p)) return p;
      } catch {
        // continue
      }
    }

    return null;
  }

  private getDataPath(): string {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron');
      return path.join(app.getPath('userData'), 'whatsapp-session');
    } catch {
      return path.join(process.cwd(), '.whatsapp-session');
    }
  }
}
