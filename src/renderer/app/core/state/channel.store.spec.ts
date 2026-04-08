import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChannelErrorEvent,
  ChannelResponse,
  ChannelStatusEvent,
  InboundChannelMessage,
} from '../../../../shared/types/channels';
import { ChannelIpcService } from '../services/ipc/channel-ipc.service';
import { ChannelStore } from './channel.store';

function makeInboundMessage(overrides: Partial<InboundChannelMessage> = {}): InboundChannelMessage {
  return {
    id: 'inbound-1',
    platform: 'discord',
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'user-1',
    senderName: 'Alice',
    content: 'Hello from Discord',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: 1000,
    ...overrides,
  };
}

function makeResponse(overrides: Partial<ChannelResponse> = {}): ChannelResponse {
  return {
    channelMessageId: 'message-1',
    platform: 'discord',
    chatId: 'chat-1',
    messageId: 'response-1',
    instanceId: 'instance-1',
    content: 'Done.',
    status: 'complete',
    timestamp: 2000,
    ...overrides,
  };
}

describe('ChannelStore', () => {
  let store: ChannelStore;
  let statusListener: ((data: unknown) => void) | null;
  let messageListener: ((data: unknown) => void) | null;
  let responseListener: ((data: unknown) => void) | null;
  let errorListener: ((data: unknown) => void) | null;

  const ipcMock = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    getStatus: vi.fn().mockResolvedValue({ success: true, data: { discord: 'disconnected', whatsapp: 'disconnected' } }),
    getMessages: vi.fn(),
    sendMessage: vi.fn(),
    pairSender: vi.fn().mockResolvedValue({ success: true }),
    getAccessPolicy: vi.fn(),
    setAccessPolicy: vi.fn(),
    onStatusChanged: vi.fn((callback: (data: unknown) => void) => {
      statusListener = callback;
      return () => {
        if (statusListener === callback) {
          statusListener = null;
        }
      };
    }),
    onMessageReceived: vi.fn((callback: (data: unknown) => void) => {
      messageListener = callback;
      return () => {
        if (messageListener === callback) {
          messageListener = null;
        }
      };
    }),
    onResponseSent: vi.fn((callback: (data: unknown) => void) => {
      responseListener = callback;
      return () => {
        if (responseListener === callback) {
          responseListener = null;
        }
      };
    }),
    onError: vi.fn((callback: (data: unknown) => void) => {
      errorListener = callback;
      return () => {
        if (errorListener === callback) {
          errorListener = null;
        }
      };
    }),
  };

  beforeEach(() => {
    statusListener = null;
    messageListener = null;
    responseListener = null;
    errorListener = null;

    ipcMock.getStatus.mockClear();
    ipcMock.onStatusChanged.mockClear();
    ipcMock.onMessageReceived.mockClear();
    ipcMock.onResponseSent.mockClear();
    ipcMock.onError.mockClear();

    TestBed.configureTestingModule({
      providers: [
        ChannelStore,
        { provide: ChannelIpcService, useValue: ipcMock },
      ],
    });

    store = TestBed.inject(ChannelStore);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('maps inbound channel events into inbound message items', () => {
    messageListener?.(makeInboundMessage());

    expect(store.messages()).toEqual([
      {
        id: 'inbound-1',
        platform: 'discord',
        chatId: 'chat-1',
        senderId: 'user-1',
        senderName: 'Alice',
        content: 'Hello from Discord',
        direction: 'inbound',
        timestamp: 1000,
      },
    ]);
  });

  it('appends outbound responses from response-sent events', () => {
    responseListener?.(makeResponse());

    expect(store.messages()).toEqual([
      {
        id: 'out-response-1',
        platform: 'discord',
        chatId: 'chat-1',
        senderId: 'bot',
        senderName: 'Orchestrator',
        content: 'Done.',
        direction: 'outbound',
        instanceId: 'instance-1',
        timestamp: 2000,
      },
    ]);
  });

  it('stores the latest WhatsApp QR code on connecting status updates and clears it on connect', () => {
    statusListener?.({
      platform: 'whatsapp',
      status: 'connecting',
      qrCode: 'qr-data',
    } satisfies ChannelStatusEvent & { status: 'connecting' });

    expect(store.whatsapp().status).toBe('connecting');
    expect(store.whatsapp().qrCode).toBe('qr-data');

    statusListener?.({
      platform: 'whatsapp',
      status: 'connected',
      phoneNumber: '15551234567',
    } satisfies ChannelStatusEvent & { status: 'connected' });

    expect(store.whatsapp().status).toBe('connected');
    expect(store.whatsapp().phoneNumber).toBe('15551234567');
    expect(store.whatsapp().qrCode).toBeUndefined();
  });

  it('clears the WhatsApp QR code when an error event arrives', () => {
    statusListener?.({
      platform: 'whatsapp',
      status: 'connecting',
      qrCode: 'qr-data',
    } satisfies ChannelStatusEvent & { status: 'connecting' });

    errorListener?.({
      platform: 'whatsapp',
      error: 'Chrome not found',
      recoverable: false,
    } satisfies ChannelErrorEvent);

    expect(store.whatsapp().error).toBe('Chrome not found');
    expect(store.whatsapp().qrCode).toBeUndefined();
  });
});
