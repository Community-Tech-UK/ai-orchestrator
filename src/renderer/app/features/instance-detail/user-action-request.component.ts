/**
 * User Action Request Component - Displays pending orchestrator requests to the user
 */

import {
  Component,
  inject,
  signal,
  OnInit,
  OnDestroy,
  ChangeDetectionStrategy,
  input,
  effect
} from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc';
import { InstanceStore } from '../../core/state/instance.store';

export interface UserActionRequest {
  id: string;
  instanceId: string;
  requestType: 'switch_mode' | 'approve_action' | 'confirm' | 'select_option' | 'input_required';
  title: string;
  message: string;
  targetMode?: 'build' | 'plan' | 'review';
  options?: {
    id: string;
    label: string;
    description?: string;
  }[];
  context?: Record<string, unknown>;
  createdAt: number;
  /** Permission metadata for input_required requests (action, path, etc.) */
  permissionMetadata?: {
    type?: string;
    tool_use_id?: string;
    action?: string;
    path?: string;
    originalContent?: string;
  };
}

@Component({
  selector: 'app-user-action-request',
  standalone: true,
  imports: [],
  template: `
    @if (pendingRequests().length > 0) {
      <div class="user-action-requests">
        @for (request of pendingRequests(); track request.id) {
          <div class="request-card" [class]="'request-' + request.requestType">
            <div class="request-header">
              <span class="request-icon">{{
                getRequestIcon(request.requestType)
              }}</span>
              <span class="request-title">{{ request.title }}</span>
            </div>
            <p class="request-message">{{ request.message }}</p>

            @if (request.requestType === 'select_option' && request.options) {
              <div class="request-options">
                @for (option of request.options; track option.id) {
                  <button
                    class="option-btn"
                    (click)="onSelectOption(request, option.id)"
                    [disabled]="isResponding()"
                  >
                    {{ option.label }}
                    @if (option.description) {
                      <span class="option-desc">{{ option.description }}</span>
                    }
                  </button>
                }
              </div>
            } @else {
              <div class="request-actions">
                <button
                  class="btn-reject"
                  (click)="onReject(request)"
                  [disabled]="isResponding()"
                >
                  Reject
                </button>
                @if (request.requestType === 'input_required') {
                  <button
                    class="btn-yolo"
                    (click)="onEnableYolo(request)"
                    [disabled]="isResponding()"
                    title="Enable YOLO mode to auto-approve all permissions for this session"
                  >
                    ⚡ YOLO
                  </button>
                }
                <button
                  class="btn-approve"
                  (click)="onApprove(request)"
                  [disabled]="isResponding()"
                >
                  {{ getApproveLabel(request) }}
                </button>
              </div>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [
    `
      .user-action-requests {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-md);
      }

      .request-card {
        background: var(--bg-secondary);
        border: 2px solid var(--primary-color);
        border-radius: var(--radius-lg);
        padding: var(--spacing-md);
        animation:
          slideIn 0.3s ease-out,
          pulse-border 2s ease-in-out infinite;
        box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
      }

      @keyframes slideIn {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes pulse-border {
        0%,
        100% {
          border-color: var(--primary-color);
          box-shadow: 0 4px 16px rgba(var(--primary-rgb), 0.2);
        }
        50% {
          border-color: var(--primary-hover);
          box-shadow: 0 4px 24px rgba(var(--primary-rgb), 0.35);
        }
      }

      .request-switch_mode {
        border-color: #6366f1;
        box-shadow: 0 4px 16px rgba(99, 102, 241, 0.2);
      }

      .request-approve_action {
        border-color: #f59e0b;
        box-shadow: 0 4px 16px rgba(245, 158, 11, 0.2);
      }

      .request-input_required {
        border-color: #ef4444;
        box-shadow: 0 4px 16px rgba(239, 68, 68, 0.2);
      }

      .request-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-sm);
      }

      .request-icon {
        font-size: 20px;
      }

      .request-title {
        font-family: var(--font-display);
        font-size: 16px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .request-message {
        font-size: 14px;
        color: var(--text-secondary);
        margin: 0 0 var(--spacing-md) 0;
        line-height: 1.5;
      }

      .request-actions {
        display: flex;
        gap: var(--spacing-sm);
        justify-content: flex-end;
      }

      .request-options {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .option-btn {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-md);
        color: var(--text-primary);
        font-size: 14px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover:not(:disabled) {
          background: rgba(var(--primary-rgb), 0.1);
          border-color: var(--primary-color);
        }

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .option-desc {
        font-size: 12px;
        color: var(--text-muted);
        font-weight: 400;
        margin-top: 2px;
      }

      .btn-reject,
      .btn-approve,
      .btn-yolo {
        padding: var(--spacing-sm) var(--spacing-lg);
        border-radius: var(--radius-md);
        font-family: var(--font-display);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      }

      .btn-reject {
        background: var(--bg-tertiary);
        border: 1px solid var(--border-subtle);
        color: var(--text-secondary);

        &:hover:not(:disabled) {
          background: rgba(var(--error-rgb), 0.1);
          border-color: var(--error-color);
          color: var(--error-color);
        }
      }

      .btn-yolo {
        background: linear-gradient(
          135deg,
          #f59e0b 0%,
          #d97706 100%
        );
        border: none;
        color: #000;
        box-shadow: 0 2px 8px rgba(245, 158, 11, 0.3);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(245, 158, 11, 0.5);
        }
      }

      .btn-approve {
        background: linear-gradient(
          135deg,
          var(--primary-color) 0%,
          var(--primary-hover) 100%
        );
        border: none;
        color: var(--bg-primary);
        box-shadow: 0 2px 8px rgba(var(--primary-rgb), 0.3);

        &:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(var(--primary-rgb), 0.4);
        }
      }
    `
  ],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class UserActionRequestComponent implements OnInit, OnDestroy {
  private ipc = inject(ElectronIpcService);
  private instanceStore = inject(InstanceStore);

  instanceId = input<string | null>(null);

  pendingRequests = signal<UserActionRequest[]>([]);
  isResponding = signal(false);

  private unsubscribeUserAction: (() => void) | null = null;
  private unsubscribeInputRequired: (() => void) | null = null;

  constructor() {
    // Reload pending requests when instanceId changes
    effect(() => {
      const id = this.instanceId();
      // Clear and reload when instance changes
      this.pendingRequests.set([]);
      if (id) {
        this.loadPendingRequests();
      }
    });
  }

  ngOnInit(): void {
    // Initial load of pending requests (for cases where instanceId is already set)
    this.loadPendingRequests();

    // Subscribe to user action requests (orchestrator commands)
    this.unsubscribeUserAction = this.ipc.onUserActionRequest((request) => {
      const req = request as UserActionRequest;
      const currentInstanceId = this.instanceId();

      // Only show requests for this instance (or all if no instanceId specified)
      if (!currentInstanceId || req.instanceId === currentInstanceId) {
        this.pendingRequests.update((requests) => [...requests, req]);
      }
    });

    // Subscribe to input required events (CLI permission prompts)
    console.log('[UserActionRequestComponent] Setting up onInputRequired subscription');
    this.unsubscribeInputRequired = this.ipc.onInputRequired((payload) => {
      console.log('=== [UserActionRequestComponent] INPUT_REQUIRED CALLBACK TRIGGERED ===');
      console.log('[UserActionRequestComponent] Payload:', JSON.stringify(payload, null, 2));

      const currentInstanceId = this.instanceId();
      console.log('[UserActionRequestComponent] Current instance ID:', currentInstanceId);
      console.log('[UserActionRequestComponent] Payload instance ID:', payload.instanceId);

      // Only show for this instance
      if (!currentInstanceId || payload.instanceId === currentInstanceId) {
        console.log('[UserActionRequestComponent] Instance ID matches, creating request...');
        const metadata = payload.metadata as UserActionRequest['permissionMetadata'];
        const req: UserActionRequest = {
          id: payload.requestId,
          instanceId: payload.instanceId,
          requestType: 'input_required',
          title: 'Permission Required',
          message: payload.prompt,
          createdAt: payload.timestamp,
          permissionMetadata: metadata // Store permission details for retry message
        };
        console.log('[UserActionRequestComponent] Created request:', JSON.stringify(req, null, 2));
        this.pendingRequests.update((requests) => {
          console.log('[UserActionRequestComponent] Current pending requests:', requests.length);
          const updated = [...requests, req];
          console.log('[UserActionRequestComponent] Updated pending requests:', updated.length);
          return updated;
        });
        console.log('[UserActionRequestComponent] Request added to pending list');
      } else {
        console.log('[UserActionRequestComponent] Instance ID mismatch, ignoring');
      }
      console.log('=== [UserActionRequestComponent] INPUT_REQUIRED HANDLING COMPLETE ===');
    });
    console.log('[UserActionRequestComponent] onInputRequired subscription set up');
  }

  ngOnDestroy(): void {
    if (this.unsubscribeUserAction) {
      this.unsubscribeUserAction();
    }
    if (this.unsubscribeInputRequired) {
      this.unsubscribeInputRequired();
    }
  }

  private async loadPendingRequests(): Promise<void> {
    const currentInstanceId = this.instanceId();

    try {
      const response = currentInstanceId
        ? await this.ipc.listUserActionRequestsForInstance(currentInstanceId)
        : await this.ipc.listUserActionRequests();

      if (response.success && 'data' in response && response.data) {
        this.pendingRequests.set(response.data as UserActionRequest[]);
      }
    } catch (error) {
      console.error('Failed to load pending user action requests:', error);
    }
  }

  getRequestIcon(requestType: string): string {
    switch (requestType) {
      case 'switch_mode':
        return '🔄';
      case 'approve_action':
        return '✋';
      case 'confirm':
        return '❓';
      case 'select_option':
        return '📋';
      case 'input_required':
        return '🔐';
      default:
        return '📢';
    }
  }

  getApproveLabel(request: UserActionRequest): string {
    switch (request.requestType) {
      case 'switch_mode':
        return request.targetMode
          ? `Switch to ${request.targetMode.charAt(0).toUpperCase() + request.targetMode.slice(1)} Mode`
          : 'Approve';
      case 'approve_action':
        return 'Approve';
      case 'confirm':
        return 'Confirm';
      case 'input_required':
        return 'Allow';
      default:
        return 'Yes';
    }
  }

  async onApprove(request: UserActionRequest): Promise<void> {
    await this.respond(request, true);
  }

  async onReject(request: UserActionRequest): Promise<void> {
    await this.respond(request, false);
  }

  async onEnableYolo(request: UserActionRequest): Promise<void> {
    this.isResponding.set(true);
    try {
      // Toggle YOLO mode for this instance
      const result = await this.ipc.toggleYoloMode(request.instanceId);
      if (result.success) {
        // Remove all pending permission requests for this instance since YOLO is now enabled
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.instanceId !== request.instanceId || r.requestType !== 'input_required')
        );
      }
    } catch (error) {
      console.error('Failed to enable YOLO mode:', error);
    } finally {
      this.isResponding.set(false);
    }
  }

  async onSelectOption(
    request: UserActionRequest,
    optionId: string
  ): Promise<void> {
    await this.respond(request, true, optionId);
  }

  private async respond(
    request: UserActionRequest,
    approved: boolean,
    selectedOption?: string
  ): Promise<void> {
    this.isResponding.set(true);

    try {
      // Handle input_required differently - send retry message or denial to CLI
      if (request.requestType === 'input_required') {
        let response: string;
        const meta = request.permissionMetadata;
        // Create permission key to clear pending permission tracking
        const permissionKey = meta?.action && meta?.path ? `${meta.action}:${meta.path}` : undefined;

        if (approved) {
          // Construct a helpful retry message based on the permission metadata
          if (meta?.action && meta?.path) {
            // Tell Claude to retry the specific action
            response = `Permission granted. Please proceed to ${meta.action} ${meta.path}.`;
          } else {
            // Generic approval message
            response = `Permission granted. Please proceed with the operation.`;
          }
          console.log('[UserActionRequestComponent] Sending approval with retry message:', response);
        } else {
          response = 'Permission denied. Please do not perform that operation.';
          console.log('[UserActionRequestComponent] Sending denial message:', response);
        }

        const result = await this.ipc.respondToInputRequired(
          request.instanceId,
          request.id,
          response,
          permissionKey
        );

        if (result.success) {
          this.pendingRequests.update((requests) =>
            requests.filter((r) => r.id !== request.id)
          );
        }
        return;
      }

      // Handle orchestrator user action requests
      const response = await this.ipc.respondToUserAction(
        request.id,
        approved,
        selectedOption
      );

      if (response.success) {
        if (
          approved &&
          request.requestType === 'switch_mode' &&
          request.targetMode
        ) {
          await this.instanceStore.changeAgentMode(
            request.instanceId,
            request.targetMode
          );
        }
        // Remove the request from the list
        this.pendingRequests.update((requests) =>
          requests.filter((r) => r.id !== request.id)
        );
      }
    } catch (error) {
      console.error('Failed to respond to user action request:', error);
    } finally {
      this.isResponding.set(false);
    }
  }
}
