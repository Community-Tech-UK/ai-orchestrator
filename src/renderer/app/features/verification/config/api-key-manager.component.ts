/**
 * API Key Manager Component
 *
 * Secure management of API keys for CLI fallbacks:
 * - Add/edit/remove API keys
 * - Masked display with reveal toggle
 * - Key validation testing
 * - Last used tracking
 */

import {
  Component,
  signal,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CLIPBOARD_SERVICE } from '../../../core/services/clipboard.service';

interface ApiKeyEntry {
  id: string;
  provider: string;
  name: string;
  keyMasked: string;
  keyFull?: string;
  isValid?: boolean;
  lastUsed?: Date;
  lastValidated?: Date;
  addedAt: Date;
  isRevealed: boolean;
  isEditing: boolean;
  isTesting: boolean;
}

interface ProviderInfo {
  id: string;
  name: string;
  placeholder: string;
  helpUrl: string;
  keyPrefix?: string;
}

@Component({
  selector: 'app-api-key-manager',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="api-key-manager">
      <div class="section-header">
        <div>
          <h2>API Keys</h2>
          <p class="section-description">
            Manage API keys for CLI fallbacks when CLIs are unavailable
          </p>
        </div>
        <button class="btn-primary" (click)="showAddForm.set(true)">
          + Add API Key
        </button>
      </div>

      <!-- Security Notice -->
      <div class="security-notice">
        <span class="notice-icon">🔒</span>
        <div class="notice-content">
          <strong>Security Note:</strong> API keys are stored securely in your system's keychain.
          They are never sent to external servers except to their respective providers.
        </div>
      </div>

      <!-- Add Key Form -->
      @if (showAddForm()) {
        <div class="add-key-form">
          <h3>Add New API Key</h3>

          <div class="form-row">
            <span class="form-label">Provider:</span>
            <select [(ngModel)]="newKeyProvider" (ngModelChange)="onProviderChange($event)">
              <option value="">Select provider...</option>
              @for (provider of providers; track provider.id) {
                <option [value]="provider.id">{{ provider.name }}</option>
              }
            </select>
          </div>

          <div class="form-row">
            <span class="form-label">Display Name:</span>
            <input
              type="text"
              [(ngModel)]="newKeyName"
              [placeholder]="getSelectedProvider()?.name + ' API Key'"
            />
          </div>

          <div class="form-row">
            <span class="form-label">API Key:</span>
            <div class="key-input-wrapper">
              <input
                [type]="showNewKey() ? 'text' : 'password'"
                [(ngModel)]="newKeyValue"
                [placeholder]="getSelectedProvider()?.placeholder || 'Enter API key...'"
              />
              <button class="btn-icon" (click)="showNewKey.set(!showNewKey())">
                {{ showNewKey() ? '👁️' : '👁️‍🗨️' }}
              </button>
            </div>
          </div>

          @if (getSelectedProvider()?.helpUrl) {
            <div class="form-hint">
              <a [href]="getSelectedProvider()?.helpUrl" target="_blank" rel="noopener">
                📖 How to get your {{ getSelectedProvider()?.name }} API key
              </a>
            </div>
          }

          <div class="form-actions">
            <button class="btn-secondary" (click)="cancelAddKey()">Cancel</button>
            <button
              class="btn-secondary"
              (click)="validateNewKey()"
              [disabled]="!newKeyValue || isValidating()"
            >
              {{ isValidating() ? 'Validating...' : 'Test Key' }}
            </button>
            <button
              class="btn-primary"
              (click)="saveNewKey()"
              [disabled]="!newKeyProvider || !newKeyValue"
            >
              Save Key
            </button>
          </div>

          @if (validationResult()) {
            <div class="validation-result" [class.success]="validationResult()?.success">
              @if (validationResult()?.success) {
                ✓ Key is valid
              } @else {
                ✗ {{ validationResult()?.error }}
              }
            </div>
          }
        </div>
      }

      <!-- Key List -->
      <div class="key-list">
        @if (apiKeys().length === 0 && !showAddForm()) {
          <div class="empty-state">
            <p>No API keys configured</p>
            <p class="hint">Add API keys to use provider APIs when CLI tools are unavailable</p>
          </div>
        }

        @for (key of apiKeys(); track key.id) {
          <div class="key-card" [class.invalid]="key.isValid === false">
            <div class="key-header">
              <div class="key-provider">
                <span class="provider-icon">{{ getProviderIcon(key.provider) }}</span>
                <div class="provider-info">
                  <span class="provider-name">{{ key.name }}</span>
                  <span class="provider-type">{{ getProviderName(key.provider) }}</span>
                </div>
              </div>
              <div class="key-status">
                @if (key.isValid === true) {
                  <span class="status-badge valid">✓ Valid</span>
                } @else if (key.isValid === false) {
                  <span class="status-badge invalid">✗ Invalid</span>
                } @else {
                  <span class="status-badge unknown">? Untested</span>
                }
              </div>
            </div>

            <div class="key-value-row">
              <div class="key-value">
                @if (key.isRevealed) {
                  <code>{{ key.keyFull }}</code>
                } @else {
                  <code>{{ key.keyMasked }}</code>
                }
              </div>
              <div class="key-actions">
                <button
                  class="btn-icon"
                  (click)="toggleKeyReveal(key.id)"
                  [title]="key.isRevealed ? 'Hide' : 'Reveal'"
                >
                  {{ key.isRevealed ? '🙈' : '👁️' }}
                </button>
                <button
                  class="btn-icon"
                  (click)="copyKey(key.id)"
                  title="Copy to clipboard"
                >
                  📋
                </button>
              </div>
            </div>

            <div class="key-meta">
              <span>Added: {{ formatDate(key.addedAt) }}</span>
              @if (key.lastUsed) {
                <span>Last used: {{ formatDate(key.lastUsed) }}</span>
              }
              @if (key.lastValidated) {
                <span>Validated: {{ formatDate(key.lastValidated) }}</span>
              }
            </div>

            <div class="key-footer">
              <button
                class="btn-small"
                (click)="testKey(key.id)"
                [disabled]="key.isTesting"
              >
                {{ key.isTesting ? 'Testing...' : 'Test Key' }}
              </button>
              <button class="btn-small" (click)="editKey(key.id)">
                Edit
              </button>
              <button class="btn-small danger" (click)="deleteKey(key.id)">
                Delete
              </button>
            </div>
          </div>
        }
      </div>

      <!-- Usage Information -->
      <div class="usage-info">
        <h3>API Key Usage</h3>
        <ul>
          <li>
            <strong>Fallback Mode:</strong> API keys are used when CLI tools are unavailable
          </li>
          <li>
            <strong>Priority:</strong> CLI tools are always preferred over API fallbacks
          </li>
          <li>
            <strong>Cost Tracking:</strong> API usage is tracked and shown in verification results
          </li>
        </ul>
      </div>
    </div>
  `,
  styles: [`
    .api-key-manager {
      padding: 0;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      margin-bottom: 20px;
    }

    .section-header h2 {
      margin: 0;
      font-size: 16px;
      font-weight: 600;
    }

    .section-description {
      margin: 4px 0 0;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .security-notice {
      display: flex;
      gap: 12px;
      padding: 12px 16px;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 8px;
      margin-bottom: 20px;
    }

    .notice-icon {
      font-size: 20px;
    }

    .notice-content {
      font-size: 13px;
      line-height: 1.5;
    }

    .notice-content strong {
      color: #22c55e;
    }

    .add-key-form {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 20px;
    }

    .add-key-form h3 {
      margin: 0 0 16px;
      font-size: 15px;
      font-weight: 600;
    }

    .form-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
    }

    .form-row > .form-label {
      width: 120px;
      font-size: 13px;
      color: var(--text-secondary);
      flex-shrink: 0;
    }

    .form-row input,
    .form-row select {
      flex: 1;
      padding: 10px 12px;
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      background: var(--bg-primary);
    }

    .key-input-wrapper {
      flex: 1;
      display: flex;
      gap: 8px;
    }

    .key-input-wrapper input {
      flex: 1;
      font-family: monospace;
    }

    .form-hint {
      margin: 8px 0 16px 132px;
      font-size: 12px;
    }

    .form-hint a {
      color: var(--accent-color);
      text-decoration: none;
    }

    .form-hint a:hover {
      text-decoration: underline;
    }

    .form-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border-color);
    }

    .validation-result {
      margin-top: 12px;
      padding: 10px 12px;
      border-radius: 6px;
      font-size: 13px;
      background: rgba(239, 68, 68, 0.1);
      color: #ef4444;
    }

    .validation-result.success {
      background: rgba(34, 197, 94, 0.1);
      color: #22c55e;
    }

    .empty-state {
      text-align: center;
      padding: 40px 20px;
      color: var(--text-secondary);
    }

    .empty-state p {
      margin: 0;
    }

    .empty-state .hint {
      font-size: 13px;
      margin-top: 8px;
      color: var(--text-muted);
    }

    .key-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .key-card {
      border: 1px solid var(--border-color);
      border-radius: 8px;
      padding: 16px;
      background: var(--bg-secondary);
    }

    .key-card.invalid {
      border-color: rgba(239, 68, 68, 0.5);
      background: rgba(239, 68, 68, 0.05);
    }

    .key-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
    }

    .key-provider {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .provider-icon {
      font-size: 24px;
    }

    .provider-info {
      display: flex;
      flex-direction: column;
    }

    .provider-name {
      font-weight: 600;
      font-size: 14px;
    }

    .provider-type {
      font-size: 12px;
      color: var(--text-secondary);
    }

    .status-badge {
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .status-badge.valid {
      background: rgba(34, 197, 94, 0.15);
      color: #22c55e;
    }

    .status-badge.invalid {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
    }

    .status-badge.unknown {
      background: var(--bg-tertiary);
      color: var(--text-secondary);
    }

    .key-value-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      background: var(--bg-primary);
      border-radius: 6px;
      margin-bottom: 12px;
    }

    .key-value code {
      font-family: monospace;
      font-size: 13px;
      color: var(--text-primary);
      word-break: break-all;
    }

    .key-actions {
      display: flex;
      gap: 4px;
      flex-shrink: 0;
    }

    .key-meta {
      display: flex;
      gap: 16px;
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }

    .key-footer {
      display: flex;
      gap: 8px;
      padding-top: 12px;
      border-top: 1px solid var(--border-color);
    }

    .usage-info {
      margin-top: 24px;
      padding: 16px;
      background: var(--bg-secondary);
      border-radius: 8px;
    }

    .usage-info h3 {
      margin: 0 0 12px;
      font-size: 14px;
      font-weight: 600;
    }

    .usage-info ul {
      margin: 0;
      padding: 0 0 0 20px;
      font-size: 13px;
      color: var(--text-secondary);
    }

    .usage-info li {
      margin-bottom: 8px;
    }

    .usage-info strong {
      color: var(--text-primary);
    }

    /* Buttons */
    .btn-primary {
      padding: 10px 20px;
      background: var(--accent-color);
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-primary:hover {
      opacity: 0.9;
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-secondary {
      padding: 8px 16px;
      background: var(--bg-tertiary);
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
    }

    .btn-secondary:hover {
      background: var(--bg-hover);
    }

    .btn-secondary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-small {
      padding: 6px 12px;
      font-size: 12px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
    }

    .btn-small:hover {
      background: var(--bg-hover);
    }

    .btn-small:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-small.danger {
      color: #ef4444;
    }

    .btn-small.danger:hover {
      background: rgba(239, 68, 68, 0.1);
    }

    .btn-icon {
      width: 32px;
      height: 32px;
      padding: 0;
      background: none;
      border: 1px solid var(--border-color);
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }

    .btn-icon:hover {
      background: var(--bg-tertiary);
    }
  `],
})
export class ApiKeyManagerComponent {
  private clipboard = inject(CLIPBOARD_SERVICE);

  // Providers
  providers: ProviderInfo[] = [
    {
      id: 'anthropic',
      name: 'Anthropic (Claude)',
      placeholder: 'sk-ant-...',
      helpUrl: 'https://console.anthropic.com/settings/keys',
      keyPrefix: 'sk-ant-',
    },
    {
      id: 'openai',
      name: 'OpenAI',
      placeholder: 'sk-...',
      helpUrl: 'https://platform.openai.com/api-keys',
      keyPrefix: 'sk-',
    },
    {
      id: 'google',
      name: 'Google AI (Gemini)',
      placeholder: 'AIza...',
      helpUrl: 'https://aistudio.google.com/app/apikey',
      keyPrefix: 'AIza',
    },
    {
      id: 'mistral',
      name: 'Mistral AI',
      placeholder: 'API key...',
      helpUrl: 'https://console.mistral.ai/api-keys/',
    },
    {
      id: 'cohere',
      name: 'Cohere',
      placeholder: 'API key...',
      helpUrl: 'https://dashboard.cohere.ai/api-keys',
    },
  ];

  // State
  apiKeys = signal<ApiKeyEntry[]>([]);
  showAddForm = signal(false);
  showNewKey = signal(false);
  isValidating = signal(false);
  validationResult = signal<{ success: boolean; error?: string } | null>(null);

  // Form fields
  newKeyProvider = '';
  newKeyName = '';
  newKeyValue = '';

  constructor() {
    this.loadApiKeys();
  }

  private loadApiKeys(): void {
    // Load from secure storage via IPC
    // For now, use mock data
    this.apiKeys.set([
      {
        id: '1',
        provider: 'anthropic',
        name: 'Claude API Key',
        keyMasked: 'sk-ant-••••••••••••••••fG2x',
        keyFull: 'sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxxxxfG2x',
        isValid: true,
        addedAt: new Date('2024-01-15'),
        lastUsed: new Date('2024-01-18'),
        lastValidated: new Date('2024-01-18'),
        isRevealed: false,
        isEditing: false,
        isTesting: false,
      },
    ]);
  }

  getSelectedProvider(): ProviderInfo | undefined {
    return this.providers.find(p => p.id === this.newKeyProvider);
  }

  onProviderChange(providerId: unknown): void {
    if (typeof providerId !== 'string') return;
    const provider = this.providers.find(p => p.id === providerId);
    if (provider && !this.newKeyName) {
      this.newKeyName = `${provider.name} API Key`;
    }
  }

  getProviderIcon(providerId: string): string {
    const icons: Record<string, string> = {
      anthropic: '🤖',
      openai: '💚',
      google: '🔵',
      mistral: '🌀',
      cohere: '🔶',
    };
    return icons[providerId] || '🔑';
  }

  getProviderName(providerId: string): string {
    return this.providers.find(p => p.id === providerId)?.name || providerId;
  }

  async validateNewKey(): Promise<void> {
    if (!this.newKeyValue || !this.newKeyProvider) return;

    this.isValidating.set(true);
    this.validationResult.set(null);

    try {
      // Call IPC to validate key
      const result = await (window as unknown as { electronAPI?: { invoke: (channel: string, arg: unknown) => Promise<unknown> } }).electronAPI?.invoke('api-key:validate', {
        provider: this.newKeyProvider,
        key: this.newKeyValue,
      }) as { valid?: boolean; error?: string } | undefined;

      this.validationResult.set({
        success: result?.valid ?? false,
        error: result?.error,
      });
    } catch (error) {
      this.validationResult.set({
        success: false,
        error: (error as Error).message,
      });
    } finally {
      this.isValidating.set(false);
    }
  }

  async saveNewKey(): Promise<void> {
    if (!this.newKeyProvider || !this.newKeyValue) return;

    const masked = this.maskKey(this.newKeyValue);
    const newKey: ApiKeyEntry = {
      id: crypto.randomUUID(),
      provider: this.newKeyProvider,
      name: this.newKeyName || `${this.getProviderName(this.newKeyProvider)} API Key`,
      keyMasked: masked,
      keyFull: this.newKeyValue,
      isValid: this.validationResult()?.success,
      addedAt: new Date(),
      lastValidated: this.validationResult()?.success ? new Date() : undefined,
      isRevealed: false,
      isEditing: false,
      isTesting: false,
    };

    // Save to secure storage via IPC
    try {
      await (window as unknown as { electronAPI?: { invoke: (channel: string, arg: unknown) => Promise<unknown> } }).electronAPI?.invoke('api-key:save', {
        id: newKey.id,
        provider: newKey.provider,
        name: newKey.name,
        key: newKey.keyFull,
      });
    } catch (error) {
      console.error('Failed to save API key:', error);
    }

    this.apiKeys.update(keys => [...keys, newKey]);
    this.cancelAddKey();
  }

  cancelAddKey(): void {
    this.showAddForm.set(false);
    this.newKeyProvider = '';
    this.newKeyName = '';
    this.newKeyValue = '';
    this.showNewKey.set(false);
    this.validationResult.set(null);
  }

  toggleKeyReveal(keyId: string): void {
    this.apiKeys.update(keys =>
      keys.map(key =>
        key.id === keyId ? { ...key, isRevealed: !key.isRevealed } : key
      )
    );
  }

  async copyKey(keyId: string): Promise<void> {
    const key = this.apiKeys().find(k => k.id === keyId);
    if (key?.keyFull) {
      const result = await this.clipboard.copyText(key.keyFull, {
        silent: true,
        label: 'API key',
      });
      if (!result.ok) {
        console.error('Failed to copy API key:', result.reason, result.cause);
      }
    }
  }

  async testKey(keyId: string): Promise<void> {
    const key = this.apiKeys().find(k => k.id === keyId);
    if (!key) return;

    this.apiKeys.update(keys =>
      keys.map(k => (k.id === keyId ? { ...k, isTesting: true } : k))
    );

    try {
      const result = await (window as unknown as { electronAPI?: { invoke: (channel: string, arg: unknown) => Promise<unknown> } }).electronAPI?.invoke('api-key:validate', {
        provider: key.provider,
        key: key.keyFull,
      }) as { valid?: boolean } | undefined;

      this.apiKeys.update(keys =>
        keys.map(k =>
          k.id === keyId
            ? {
                ...k,
                isTesting: false,
                isValid: result?.valid ?? false,
                lastValidated: new Date(),
              }
            : k
        )
      );
    } catch {
      this.apiKeys.update(keys =>
        keys.map(k =>
          k.id === keyId
            ? { ...k, isTesting: false, isValid: false, lastValidated: new Date() }
            : k
        )
      );
    }
  }

  editKey(keyId: string): void {
    // Open edit modal or inline edit
    const key = this.apiKeys().find(k => k.id === keyId);
    if (key) {
      this.newKeyProvider = key.provider;
      this.newKeyName = key.name;
      this.newKeyValue = key.keyFull || '';
      this.showAddForm.set(true);
      // Remove old key on save
      this.apiKeys.update(keys => keys.filter(k => k.id !== keyId));
    }
  }

  async deleteKey(keyId: string): Promise<void> {
    if (!confirm('Are you sure you want to delete this API key?')) return;

    try {
      await (window as unknown as { electronAPI?: { invoke: (channel: string, arg: unknown) => Promise<unknown> } }).electronAPI?.invoke('api-key:delete', { id: keyId });
    } catch (error) {
      console.error('Failed to delete API key:', error);
    }

    this.apiKeys.update(keys => keys.filter(k => k.id !== keyId));
  }

  private maskKey(key: string): string {
    if (key.length <= 8) return '••••••••';
    return key.substring(0, 6) + '••••••••••••••••' + key.substring(key.length - 4);
  }

  formatDate(date: Date): string {
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  }
}
