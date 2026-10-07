import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InstanceHeaderComponent } from './instance-header.component';
import { SkillStore } from '../../core/state/skill.store';
import { HookStore } from '../../core/state/hook.store';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import type { Instance } from '../../core/state/instance.store';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('instance-header.component.html')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, './instance-header.component.html'), 'utf8'));
  }
  if (url.endsWith('instance-header.component.scss')) {
    return Promise.resolve(readFileSync(resolve(specDirectory, './instance-header.component.scss'), 'utf8'));
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function instance(provider: Instance['provider']): Instance {
  return {
    id: 'inst-1',
    provider,
    status: 'busy',
    displayName: 'Session',
    workingDirectory: '/tmp/session',
  } as Instance;
}

describe('InstanceHeaderComponent interrupt tooltip', () => {
  let fixture: ComponentFixture<InstanceHeaderComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstanceHeaderComponent],
      providers: [
        {
          provide: SkillStore,
          useValue: {
            activeSkillCount: () => 0,
            activations: () => [],
            controlModeFor: () => 'enabled',
            discoverSkills: vi.fn(),
          },
        },
        { provide: HookStore, useValue: { enabledHookCount: () => 0, loadHooks: vi.fn() } },
        { provide: FileIpcService, useValue: {} },
        {
          provide: ElectronIpcService,
          useValue: {
            platform: 'darwin',
            getApi: () => new Proxy({}, { get: () => () => () => undefined }),
          },
        },
        { provide: RemoteNodeStore, useValue: { nodeById: () => null } },
        {
          provide: CrossModelReviewIpcService,
          useValue: {
            getReviewForInstance: () => undefined,
            status: () => null,
            pendingInstances: () => new Set(),
            skippedInstances: () => new Set(),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InstanceHeaderComponent);
  });

  it('names the session provider instead of always saying Claude', () => {
    fixture.componentRef.setInput('instance', instance('codex'));
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.btn-interrupt') as HTMLButtonElement;
    expect(button.title).toBe('Interrupt Codex (Esc)');
    expect(button.title).not.toContain('Claude');
  });
});
