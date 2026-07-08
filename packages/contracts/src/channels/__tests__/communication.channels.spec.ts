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
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_ISSUE_PAIRING).toBe('remote-node:issue-pairing');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_LIST_PAIRINGS).toBe('remote-node:list-pairings');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_REPAIR_DIAGNOSE).toBe('remote-node:repair:diagnose');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_REPAIR_COMMAND).toBe('remote-node:repair:command');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_PROVIDER_DIAGNOSE).toBe('remote-node:provider:diagnose');
    expect(COMMUNICATION_CHANNELS.REMOTE_NODE_UPDATE_ANDROID_AUTOMATION).toBe('remote-node:update-android-automation');
  });

  it('has pair-both onboarding channels', () => {
    expect(COMMUNICATION_CHANNELS.PAIR_BOTH_COORDINATOR_START).toBe('pair-both:coordinator:start');
    expect(COMMUNICATION_CHANNELS.PAIR_BOTH_COORDINATOR_APPROVE).toBe('pair-both:coordinator:approve');
    expect(COMMUNICATION_CHANNELS.PAIR_BOTH_WORKER_CONNECT).toBe('pair-both:worker:connect');
    expect(COMMUNICATION_CHANNELS.PAIR_BOTH_WORKER_APPLY_MANUAL).toBe('pair-both:worker:apply-manual');
  });

  it('has remote filesystem channels', () => {
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_READ_DIR).toBe('remote-fs:read-dir');
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_UNWATCH).toBe('remote-fs:unwatch');
    expect(COMMUNICATION_CHANNELS.REMOTE_FS_EVENT).toBe('remote-fs:event');
  });
});
