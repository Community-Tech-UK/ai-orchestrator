/**
 * Status Colors - Visual indicators for instance states
 */

import type { InstanceStatus } from '../types/instance.types';

export const STATUS_COLORS: Record<InstanceStatus, string> = {
  initializing: '#f59e0b', // Amber - warming up
  ready: '#10b981',        // Green - fully started, awaiting input
  idle: '#10b981',         // Green - ready
  busy: '#3b82f6',         // Blue - processing
  processing: '#3b82f6',   // Blue - alive but no output yet (remote heartbeat)
  thinking_deeply: '#8b5cf6', // Purple - extended thinking (90s+ no stdout)
  waiting_for_input: '#f59e0b', // Amber - needs attention
  waiting_for_permission: '#f59e0b', // Amber - needs approval
  respawning: '#8b5cf6',   // Purple - recovering from interrupt
  hibernating: '#6b7280',  // Gray - transitioning to hibernate
  hibernated: '#4b5563',   // Darker gray - resting
  waking: '#f59e0b',       // Amber - waking up
  degraded: '#f97316',     // Orange - remote node disconnected, awaiting failover
  error: '#ef4444',        // Red - problem
  failed: '#ef4444',       // Red - unrecoverable failure
  terminated: '#6b7280',   // Gray - stopped
};

export const STATUS_LABELS: Record<InstanceStatus, string> = {
  initializing: 'Initializing...',
  ready: 'Ready',
  idle: 'Idle',
  busy: 'Processing...',
  processing: 'Processing...',
  thinking_deeply: 'Thinking deeply...',
  waiting_for_input: 'Waiting for input',
  waiting_for_permission: 'Needs approval',
  respawning: 'Resuming session...',
  hibernating: 'Hibernating...',
  hibernated: 'Hibernated',
  waking: 'Waking up...',
  degraded: 'Degraded',
  error: 'Error',
  failed: 'Failed',
  terminated: 'Terminated',
};

export const STATUS_PULSING: Record<InstanceStatus, boolean> = {
  initializing: true,
  ready: false,
  idle: false,
  busy: true,
  processing: true,
  thinking_deeply: true,
  waiting_for_input: false,
  waiting_for_permission: false,
  respawning: true,
  hibernating: true,
  hibernated: false,
  waking: true,
  degraded: true,          // Pulsing — in transition, awaiting reconnection
  error: false,
  failed: false,
  terminated: false,
};
