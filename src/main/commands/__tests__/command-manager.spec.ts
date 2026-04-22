import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTemplate } from '../../../shared/types/command.types';
import { createMarkdownCommandId } from '../../../shared/types/command.types';

const {
  customCommands,
  mockListCommands,
  mockGetCommand,
} = vi.hoisted(() => ({
  customCommands: [] as CommandTemplate[],
  mockListCommands: vi.fn(),
  mockGetCommand: vi.fn(),
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: { customCommands },
    get: vi.fn(() => customCommands),
    set: vi.fn((_key: string, value: CommandTemplate[]) => {
      customCommands.splice(0, customCommands.length, ...value);
    }),
  })),
}));

vi.mock('../markdown-command-registry', () => ({
  getMarkdownCommandRegistry: vi.fn(() => ({
    listCommands: mockListCommands,
    getCommand: mockGetCommand,
  })),
}));

import { CommandManager } from '../command-manager';

describe('CommandManager', () => {
  beforeEach(() => {
    customCommands.splice(0, customCommands.length);
    vi.clearAllMocks();
    mockListCommands.mockResolvedValue({
      commands: [],
      candidatesByName: {},
      scanDirs: [],
    });
    mockGetCommand.mockResolvedValue(undefined);
  });

  it('resolves built-in commands through the shared execution path', async () => {
    const manager = new CommandManager();

    const resolved = await manager.executeCommand('builtin-review', ['focus', 'errors']);

    expect(resolved).not.toBeNull();
    expect(resolved?.command.name).toBe('review');
    expect(resolved?.execution).toEqual({ type: 'prompt' });
    expect(resolved?.resolvedPrompt).toContain('focus errors');
  });

  it('includes markdown commands in the registry listing with stable ids', async () => {
    const markdownCommand: CommandTemplate = {
      id: createMarkdownCommandId('workspace:review'),
      name: 'workspace:review',
      description: 'Project review command',
      template: 'Review the whole workspace',
      builtIn: false,
      source: 'file',
      createdAt: 1,
      updatedAt: 1,
    };
    mockListCommands.mockResolvedValue({
      commands: [markdownCommand],
      candidatesByName: { 'workspace:review': [markdownCommand] },
      scanDirs: ['/tmp/project/.claude/commands'],
    });

    const manager = new CommandManager();
    const commands = await manager.getAllCommands('/tmp/project');

    expect(commands).toContainEqual(markdownCommand);
  });

  it('resolves markdown commands by stable id', async () => {
    const markdownCommand: CommandTemplate = {
      id: createMarkdownCommandId('workspace:review'),
      name: 'workspace:review',
      description: 'Project review command',
      template: 'Review $ARGUMENTS',
      builtIn: false,
      source: 'file',
      createdAt: 1,
      updatedAt: 1,
    };
    mockGetCommand.mockResolvedValue(markdownCommand);

    const manager = new CommandManager();
    const resolved = await manager.executeCommand(
      createMarkdownCommandId('workspace:review'),
      ['staged', 'changes'],
      '/tmp/project',
    );

    expect(mockGetCommand).toHaveBeenCalledWith('/tmp/project', 'workspace:review');
    expect(resolved?.resolvedPrompt).toBe('Review staged changes');
  });

  it('resolves markdown slash commands through the same command parser', async () => {
    const markdownCommand: CommandTemplate = {
      id: createMarkdownCommandId('shipit'),
      name: 'shipit',
      description: 'Release checklist',
      template: 'Prepare release for $ARGUMENTS',
      builtIn: false,
      source: 'file',
      createdAt: 1,
      updatedAt: 1,
    };
    mockGetCommand.mockResolvedValue(markdownCommand);

    const manager = new CommandManager();
    const resolved = await manager.executeCommandString('/shipit patch build', '/tmp/project');

    expect(resolved?.command.id).toBe(createMarkdownCommandId('shipit'));
    expect(resolved?.resolvedPrompt).toBe('Prepare release for patch build');
  });

  it('keeps local commands ahead of markdown commands with the same name', async () => {
    const markdownCommand: CommandTemplate = {
      id: createMarkdownCommandId('review'),
      name: 'review',
      description: 'Markdown override',
      template: 'Markdown review',
      builtIn: false,
      source: 'file',
      createdAt: 1,
      updatedAt: 1,
    };
    mockListCommands.mockResolvedValue({
      commands: [markdownCommand],
      candidatesByName: { review: [markdownCommand] },
      scanDirs: ['/tmp/project/.claude/commands'],
    });

    const manager = new CommandManager();
    const commands = await manager.getAllCommands('/tmp/project');

    expect(commands.filter((command) => command.name === 'review')).toHaveLength(1);
    expect(commands.find((command) => command.name === 'review')?.id).toBe('builtin-review');
  });
});
