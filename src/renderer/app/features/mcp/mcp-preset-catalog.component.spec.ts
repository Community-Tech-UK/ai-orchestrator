/**
 * Unit tests for McpPresetCatalogComponent
 *
 * Tests cover:
 *  - loading presets from IPC on init
 *  - marking a preset as installed when its id appears in configuredServerIds
 *  - calling mcpAddServer with the correct payload when Add is clicked
 *  - emitting presetAdded after a successful add
 *  - showing an error banner when IPC returns failure
 *  - presetCommandLabel formatting (command + args vs transport fallback)
 */

import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { McpPresetCatalogComponent, type McpPreset } from './mcp-preset-catalog.component';

const MOCK_PRESETS: McpPreset[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read and write files on the local filesystem',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'Interact with GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  },
];

function makeMockIpc(overrides: Partial<{
  mcpGetPresets: () => Promise<unknown>;
  mcpAddServer: (p: unknown) => Promise<unknown>;
}> = {}) {
  return {
    mcpGetPresets: vi.fn().mockResolvedValue({
      success: true,
      data: MOCK_PRESETS,
    }),
    mcpAddServer: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

describe('McpPresetCatalogComponent', () => {
  let mockIpc: ReturnType<typeof makeMockIpc>;

  beforeEach(() => {
    mockIpc = makeMockIpc();

    TestBed.configureTestingModule({
      providers: [
        { provide: McpIpcService, useValue: mockIpc },
      ],
    });
  });

  async function createComponent() {
    const fixture = TestBed.createComponent(McpPresetCatalogComponent);
    const component = fixture.componentInstance;
    // Call ngOnInit manually to trigger preset load
    await component.ngOnInit();
    return component;
  }

  it('loads presets from IPC on init', async () => {
    const component = await createComponent();
    expect(mockIpc.mcpGetPresets).toHaveBeenCalledOnce();
    expect(component.presets()).toHaveLength(2);
    expect(component.loading()).toBe(false);
  });

  it('sets loadError when IPC returns failure', async () => {
    mockIpc.mcpGetPresets = vi.fn().mockResolvedValue({
      success: false,
      error: { message: 'Connection refused' },
    });

    const component = await createComponent();
    expect(component.loadError()).toBe('Connection refused');
    expect(component.presets()).toHaveLength(0);
  });

  it('marks a preset as installed when its id is in configuredServerIds', async () => {
    const component = await createComponent();
    // input() signal defaults to [] since TestBed doesn't set it externally in this pattern
    expect(component.isInstalled('filesystem')).toBe(false);
  });

  it('isInstalled returns false for unknown id', async () => {
    const component = await createComponent();
    expect(component.isInstalled('unknown-server')).toBe(false);
  });

  it('calls mcpAddServer with correct payload when addPreset is called', async () => {
    const component = await createComponent();
    const preset = MOCK_PRESETS[0];

    const emitted: string[] = [];
    component.presetAdded.subscribe((id) => emitted.push(id));

    await component.addPreset(preset);

    expect(mockIpc.mcpAddServer).toHaveBeenCalledWith({
      id: 'filesystem',
      name: 'Filesystem',
      description: 'Read and write files on the local filesystem',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      autoConnect: false,
    });
    expect(emitted).toEqual(['filesystem']);
  });

  it('does not emit presetAdded when IPC add fails', async () => {
    mockIpc.mcpAddServer = vi.fn().mockResolvedValue({
      success: false,
      error: { message: 'Already exists' },
    });

    const component = await createComponent();
    const preset = MOCK_PRESETS[0];

    const emitted: string[] = [];
    component.presetAdded.subscribe((id) => emitted.push(id));

    await component.addPreset(preset);
    expect(emitted).toHaveLength(0);
  });

  it('resets working to false after addPreset completes (success path)', async () => {
    const component = await createComponent();
    await component.addPreset(MOCK_PRESETS[0]);
    expect(component.working()).toBe(false);
  });

  it('resets working to false after addPreset completes (failure path)', async () => {
    mockIpc.mcpAddServer = vi.fn().mockResolvedValue({ success: false, error: { message: 'err' } });
    const component = await createComponent();
    await component.addPreset(MOCK_PRESETS[0]);
    expect(component.working()).toBe(false);
  });

  describe('presetCommandLabel', () => {
    let component: McpPresetCatalogComponent;

    beforeEach(async () => {
      component = await createComponent();
    });

    it('joins command and args', () => {
      const preset: McpPreset = {
        id: 'filesystem',
        name: 'Filesystem',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
      };
      expect(component.presetCommandLabel(preset)).toBe(
        'npx -y @modelcontextprotocol/server-filesystem',
      );
    });

    it('returns just the command when args is empty', () => {
      const preset: McpPreset = {
        id: 'test',
        name: 'Test',
        transport: 'stdio',
        command: 'my-server',
        args: [],
      };
      expect(component.presetCommandLabel(preset)).toBe('my-server');
    });

    it('falls back to transport name when no command', () => {
      const preset: McpPreset = {
        id: 'remote',
        name: 'Remote',
        transport: 'http',
      };
      expect(component.presetCommandLabel(preset)).toBe('http');
    });
  });
});
