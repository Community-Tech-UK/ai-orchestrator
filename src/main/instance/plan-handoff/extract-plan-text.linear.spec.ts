import { describe, expect, it } from 'vitest';
import { extractPlanText, stripOrchestratorBlocks } from './extract-plan-text';

const OPEN = ':::ORCHESTRATOR_COMMAND:::';
const CLOSE = ':::END_COMMAND:::';

/** The implementation this scan replaced, kept as the oracle. */
const LEGACY_BLOCK = /:::ORCHESTRATOR_COMMAND:::[\s\S]*?:::END_COMMAND:::/g;
const legacyStrip = (text: string): string => text.replace(LEGACY_BLOCK, '');

/** Small deterministic generator so a failure is reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const EDGE_INPUTS: string[] = [
  '',
  'plain text with no markers',
  OPEN,
  CLOSE,
  `${OPEN}${CLOSE}`,
  `before ${OPEN}x${CLOSE} after`,
  `${OPEN}a${CLOSE}${OPEN}b${CLOSE}`,
  `${OPEN}a${OPEN}b${CLOSE}c${CLOSE}`, // nested: first closer ends the block
  `keep ${OPEN} unclosed final marker`,
  `${OPEN}a${CLOSE} middle ${OPEN} unclosed tail`,
  `${OPEN}${OPEN}${OPEN}`,
  `${CLOSE}${OPEN}x${CLOSE}${CLOSE}`,
  // Overlapping delimiters: the opener's final ::: is the next opener's first :::.
  `${OPEN}ORCHESTRATOR_COMMAND:::x${CLOSE}`,
  `${OPEN.slice(0, -3)}${OPEN}y${CLOSE}`,
  `:::END_COMMAND:::END_COMMAND:::`,
  `${OPEN}:::END_COMMAND:::END_COMMAND:::`,
  // Markers inside code fences are still stripped, exactly as before.
  `Plan:\n\`\`\`\n${OPEN}{"type":"x"}${CLOSE}\n\`\`\`\nDone`,
  `\`\`\`text\n${OPEN}\n\`\`\`\nstill open\n\`\`\`\n${CLOSE}`,
  `${OPEN}\n multi\n line \n${CLOSE}\r\nnext`,
  `::: ORCHESTRATOR_COMMAND ::: not a marker ${CLOSE}`,
];

const FRAGMENTS = [
  OPEN, CLOSE, ':::', ':', 'ORCHESTRATOR_COMMAND', 'END_COMMAND', 'text ', '\n', '```', ' ', '\r\n', 'x',
];

describe('stripOrchestratorBlocks (R5M3)', () => {
  it.each(EDGE_INPUTS.map((input, index) => [index, input] as const))(
    'matches the legacy regex on edge input %i',
    (_index, input) => {
      expect(stripOrchestratorBlocks(input)).toBe(legacyStrip(input));
    },
  );

  it('removes a closed block and keeps an unclosed final marker verbatim', () => {
    expect(stripOrchestratorBlocks(`a ${OPEN}x${CLOSE} b ${OPEN} tail`)).toBe(`a  b ${OPEN} tail`);
  });

  it('matches the legacy regex on 5,000 random marker-heavy inputs', () => {
    const random = makeRandom(20_261_020);
    for (let round = 0; round < 5_000; round += 1) {
      const pieces = 1 + Math.floor(random() * 14);
      let input = '';
      for (let piece = 0; piece < pieces; piece += 1) {
        input += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
      }
      expect(stripOrchestratorBlocks(input), JSON.stringify(input)).toBe(legacyStrip(input));
    }
  });

  it('matches the legacy regex on random slices of marker text', () => {
    const random = makeRandom(7);
    const alphabet = `${OPEN}${CLOSE}${OPEN}ab\n`;
    for (let round = 0; round < 2_000; round += 1) {
      const start = Math.floor(random() * alphabet.length);
      const end = start + Math.floor(random() * (alphabet.length - start));
      const input = alphabet.slice(start, end) + alphabet.slice(0, Math.floor(random() * 30));
      expect(stripOrchestratorBlocks(input), JSON.stringify(input)).toBe(legacyStrip(input));
    }
  });

  it('gives the same output as the legacy regex on a large mixed input', () => {
    const input = `${'Step one\n'.repeat(200)}${OPEN}x${CLOSE}${'tail '.repeat(300)}${OPEN} unclosed`.repeat(40);
    expect(stripOrchestratorBlocks(input)).toBe(legacyStrip(input));
  });
});

describe('extractPlanText strip scan: timing (R5M3)', () => {
  it('handles 1 MB of unclosed openers in linear time', () => {
    const hostile = `Plan start\n${OPEN}`.repeat(Math.ceil(1_000_000 / (OPEN.length + 11)));
    expect(hostile.length).toBeGreaterThanOrEqual(1_000_000 - 100);
    const started = performance.now();
    const result = extractPlanText({ messages: [{ type: 'assistant', content: hostile }] });
    const elapsed = performance.now() - started;
    expect(result.text).toContain('Plan start');
    // The regex took ~1.2 s at this size; the linear scan takes a few milliseconds.
    expect(elapsed).toBeLessThan(250);
  });

  it('handles 1 MB of closed blocks and 1 MB of closers alone in linear time', () => {
    const closed = `${OPEN}x${CLOSE}`.repeat(Math.ceil(1_000_000 / (OPEN.length + CLOSE.length + 1)));
    const closers = CLOSE.repeat(Math.ceil(1_000_000 / CLOSE.length));
    const started = performance.now();
    expect(stripOrchestratorBlocks(closed)).toBe('');
    expect(stripOrchestratorBlocks(closers)).toBe(closers);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
