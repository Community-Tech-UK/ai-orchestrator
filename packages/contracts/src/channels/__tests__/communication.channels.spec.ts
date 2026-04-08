import { COMMUNICATION_CHANNELS } from '../communication.channels';

describe('COMMUNICATION_CHANNELS', () => {
  it('has comm (cross-instance) channels', () => {
    expect(COMMUNICATION_CHANNELS.COMM_REQUEST_TOKEN).toBe('comm:request-token');
    expect(COMMUNICATION_CHANNELS.COMM_CREATE_BRIDGE).toBe('comm:create-bridge');
  });

  it('has channel management channels', () => {
    expect(COMMUNICATION_CHANNELS.CHANNEL_CONNECT).toBe('channel:connect');
    expect(COMMUNICATION_CHANNELS.CHANNEL_MESSAGE_RECEIVED).toBe('channel:message-received');
  });

  it('has reaction engine channels', () => {
    expect(COMMUNICATION_CHANNELS.REACTION_GET_CONFIG).toBe('reaction:get-config');
    expect(COMMUNICATION_CHANNELS.REACTION_EVENT).toBe('reaction:event');
  });

  it('has remote observer channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_OBSERVER_GET_STATUS).toBe('remote-observer:get-status');
    expect(COMMUNICATION_CHANNELS.REMOTE_OBSERVER_ROTATE_TOKEN).toBe('remote-observer:rotate-token');
  });

  it('has remote node channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_LIST).toBe('remote-node:list');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_NODES_CHANGED).toBe('remote-node:nodes-changed');
  });

  it('has remote filesystem channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_READ_DIR).toBe('remote-fs:read-dir');
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_UNWATCH).toBe('remote-fs:unwatch');
  });
});
