import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Automation } from '../../../../shared/types/automation.types';
import { AutomationIpcService } from '../../core/services/ipc/automation-ipc.service';
import { AutomationWebhooksPanelComponent } from './automation-webhooks-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const templateSource = readFileSync(resolve(specDirectory, './automation-webhooks-panel.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './automation-webhooks-panel.component.css'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('automation-webhooks-panel.component.html')) return Promise.resolve(templateSource);
  if (url.endsWith('automation-webhooks-panel.component.css')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.css') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeAutomation(): Automation {
  return {
    id: 'automation-1',
    name: 'Build watcher',
    description: undefined,
    enabled: true,
    active: true,
    workspaceId: '/repo',
    schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
    trigger: { kind: 'schedule' },
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    destination: { kind: 'newInstance' },
    action: {
      prompt: 'Check the build',
      workingDirectory: '/repo',
    },
    nextFireAt: null,
    lastFiredAt: null,
    lastRunId: null,
    createdAt: 1,
    updatedAt: 1,
    unreadRunCount: 0,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureReason: null,
  };
}

describe('AutomationWebhooksPanelComponent', () => {
  let fixture: ComponentFixture<AutomationWebhooksPanelComponent>;
  let ipc: {
    webhookStatus: ReturnType<typeof vi.fn>;
    webhookListRoutes: ReturnType<typeof vi.fn>;
    webhookListDeliveries: ReturnType<typeof vi.fn>;
    webhookListSuggestions: ReturnType<typeof vi.fn>;
    webhookCreateRoute: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    ipc = {
      webhookStatus: vi.fn().mockResolvedValue({
        success: true,
        data: { running: true, port: 38217, routeCount: 1, recentDeliveries: [] },
      }),
      webhookListRoutes: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'route-1',
            path: '/hooks/build',
            enabled: true,
            secretHash: 'a'.repeat(64),
            allowUnsignedDev: false,
            maxBodyBytes: 262_144,
            allowedAutomationIds: ['automation-1'],
            allowedEvents: ['build.finished'],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
      webhookListDeliveries: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'delivery-1',
            routeId: 'route-1',
            deliveryId: 'external-1',
            eventType: 'build.finished',
            status: 'accepted',
            statusCode: 202,
            payloadHash: 'b'.repeat(64),
            receivedAt: 1_800_000_000_000,
          },
        ],
      }),
      webhookListSuggestions: vi.fn().mockResolvedValue({
        success: true,
        data: [
          {
            id: 'webhook-suggestion-1',
            eventType: 'build.finished',
            routeId: 'route-1',
            routePath: '/hooks/build',
            promptPattern: 'inspect the failing pipeline and fix the cause',
            promptCount: 3,
            deliveryCount: 2,
            confidence: 0.82,
            lastSeenAt: 1_800_000_000_000,
            rationale: '3 similar manual prompts followed 2 build.finished deliveries.',
            suggestedAutomationName: 'Handle build.finished',
            suggestedPrompt: 'When build.finished arrives, inspect the failing pipeline.',
          },
        ],
      }),
      webhookCreateRoute: vi.fn().mockResolvedValue({
        success: true,
        data: { id: 'route-2', path: '/hooks/deploy' },
      }),
    };

    await TestBed.configureTestingModule({
      imports: [AutomationWebhooksPanelComponent],
      providers: [{ provide: AutomationIpcService, useValue: ipc }],
    }).compileComponents();

    fixture = TestBed.createComponent(AutomationWebhooksPanelComponent);
    fixture.componentRef.setInput('automations', [makeAutomation()]);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('loads and renders webhook routes with linked automation names', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(ipc.webhookStatus).toHaveBeenCalled();
    expect(text).toContain('127.0.0.1:38217');
    expect(text).toContain('/hooks/build');
    expect(text).toContain('Build watcher');
    expect(text).toContain('build.finished');
    expect(text).toContain('accepted');
    expect(text).toContain('Suggested Automations');
    expect(text).toContain('Handle build.finished');
  });

  it('creates a route with selected automation and clears the secret field', async () => {
    const component = fixture.componentInstance;
    component.patchForm({
      path: '/hooks/deploy',
      secret: 'super-secret-value',
      automationId: 'automation-1',
      eventTypes: 'deploy.failed, deploy.fixed',
      allowUnsignedDev: true,
      maxBodyBytes: 65_536,
    });

    await component.createRoute();

    expect(ipc.webhookCreateRoute).toHaveBeenCalledWith({
      path: '/hooks/deploy',
      secret: 'super-secret-value',
      enabled: true,
      allowUnsignedDev: true,
      maxBodyBytes: 65_536,
      allowedAutomationIds: ['automation-1'],
      allowedEvents: ['deploy.failed', 'deploy.fixed'],
    });
    expect(component.form().secret).toBe('');
    expect(component.form().path).toBe('/hooks/');
  });
});
