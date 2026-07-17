import { describe, expect, it } from 'vitest';
import { computeBrowserToolSurfaceHash } from './browser-rpc-contract';

describe('computeBrowserToolSurfaceHash', () => {
  const clickTool = {
    name: 'browser.click',
    inputSchema: { type: 'object', properties: { uid: { type: 'string' } } },
  };
  const typeTool = {
    name: 'browser.type',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  };

  it('is order-independent', () => {
    expect(computeBrowserToolSurfaceHash([clickTool, typeTool])).toBe(
      computeBrowserToolSurfaceHash([typeTool, clickTool]),
    );
  });

  it('changes when a tool is missing', () => {
    expect(computeBrowserToolSurfaceHash([clickTool, typeTool])).not.toBe(
      computeBrowserToolSurfaceHash([clickTool]),
    );
  });

  it('changes when an input schema changes', () => {
    const widened = {
      ...clickTool,
      inputSchema: {
        type: 'object',
        properties: { uid: { type: 'string' }, force: { type: 'boolean' } },
      },
    };
    expect(computeBrowserToolSurfaceHash([clickTool])).not.toBe(
      computeBrowserToolSurfaceHash([widened]),
    );
  });

  it('ignores non-contract fields such as handlers and descriptions', () => {
    const withExtras = {
      ...clickTool,
      description: 'ignored',
      handler: () => null,
    } as never;
    expect(computeBrowserToolSurfaceHash([withExtras])).toBe(
      computeBrowserToolSurfaceHash([clickTool]),
    );
  });
});
