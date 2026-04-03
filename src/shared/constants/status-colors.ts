/**
 * Status Colors - Visual indicators for instance states
 */

import type { InstanceStatus } from '../types/instance.types';

export const STATUS_COLORS: Record<InstanceStatus, string> = {
  initializing: '#f59e0b', // Amber - warming up
  ready: '#10b981',        // Green - fully started, awaiting input
  idle: '#10b981',         // Green - ready
  busy: '#3b82f6',         // Blue - processing
  waiting_for_input: '#f59e0b', // Amber - needs attention
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
  waiting_for_input: 'Waiting for input',
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
  waiting_for_input: false,
  respawning: true,
  hibernating: true,
  hibernated: false,
  waking: true,
  degraded: true,          // Pulsing — in transition, awaiting reconnection
  error: false,
  failed: false,
  terminated: false,
};
