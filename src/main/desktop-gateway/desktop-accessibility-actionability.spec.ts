import { describe, expect, it } from 'vitest';
import type { DesktopAccessibilityNode } from '../../shared/types/desktop-gateway.types';
import { annotateInputEligibility } from './desktop-accessibility-actionability';

describe('annotateInputEligibility', () => {
  it('marks node centres inside the approved window as eligible and outside nodes as ineligible', () => {
    const nodes: DesktopAccessibilityNode[] = [{
      uid: 'app',
      role: 'AXApplication',
      children: [{
        uid: 'menu-open',
        role: 'AXMenuItem',
        label: 'Open profile...',
        bounds: { x: 20, y: 0, width: 120, height: 22 },
      }, {
        uid: 'window',
        role: 'AXWindow',
        bounds: { x: 0, y: 23, width: 800, height: 600 },
        children: [{
          uid: 'import',
          role: 'AXButton',
          label: 'Import',
          bounds: { x: 100, y: 100, width: 80, height: 30 },
        }],
      }],
    }];

    const annotated = annotateInputEligibility(nodes, {
      x: 0,
      y: 23,
      width: 800,
      height: 600,
    });

    expect(annotated[0]?.children?.[0]?.inputEligible).toBe(false);
    expect(annotated[0]?.children?.[1]?.inputEligible).toBe(true);
    expect(annotated[0]?.children?.[1]?.children?.[0]?.inputEligible).toBe(true);
    expect(nodes[0]?.children?.[0]).not.toHaveProperty('inputEligible');
  });

  it('leaves eligibility unknown when an accessibility node has no bounds', () => {
    const annotated = annotateInputEligibility([{
      uid: 'label',
      role: 'AXStaticText',
      label: 'Status',
    }], { x: 0, y: 0, width: 100, height: 100 });

    expect(annotated[0]).not.toHaveProperty('inputEligible');
  });
});
