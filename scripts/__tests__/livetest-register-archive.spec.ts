import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const register = readFileSync(resolve('docs/plans/livetest-remediation-register.md'), 'utf8');
const archive = readFileSync(resolve('docs/plans/livetest-remediation-register-archive-2026.md'), 'utf8');

describe('live-test remediation register and its archive', () => {
  it('stays a standing register and tells agents not to read the archive unprompted', () => {
    expect(register).toContain('Type: standing register');
    expect(register).toContain('Agents do not read');
    expect(archive.split('\n')[0]).toMatch(/^Agents do not read this archive unless a register index row points here\.$/);
  });

  it('keeps every register link into the archive pointing at a real archive anchor', () => {
    const anchors = new Set([...archive.matchAll(/<a id="([^"]+)"><\/a>/g)].map(match => match[1]));
    const targets = [...register.matchAll(/livetest-remediation-register-archive-2026\.md#([a-z0-9-]+)/g)].map(match => match[1]);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.filter(target => !anchors.has(target))).toEqual([]);
  });

  it('keeps every archived entry as a register heading made only of link stubs to its own archive detail', () => {
    const archivedKeys = [...archive.matchAll(/<a id="(lt-\d+)-archived-detail"><\/a>/g)].map(match => match[1]);
    expect(archivedKeys.length).toBeGreaterThan(0);
    const stubOf = (key: string) => `[Read the detail](livetest-remediation-register-archive-2026.md#${key}-archived-detail).`;
    const sectionsByKey = new Map<string, string[]>();
    for (const section of register.split(/^(?=## )/m)) {
      const key = /^## (LT-\d+)\b/.exec(section)?.[1]?.toLowerCase();
      if (key && archivedKeys.includes(key)) sectionsByKey.set(key, [...(sectionsByKey.get(key) ?? []), section]);
    }
    const problems: string[] = [];
    for (const key of archivedKeys) {
      // An id can also own a separate full-detail section that an index row links to by anchor; that one stays.
      const isLinkedDetail = (section: string) =>
        !section.split('\n').slice(1).some(line => line === stubOf(key)) &&
        register.includes(`<a id="${key}"></a>\n\n${section.split('\n')[0]}`) &&
        register.includes(`](#${key})`);
      const stubSections = (sectionsByKey.get(key) ?? []).filter(section => !isLinkedDetail(section));
      if (stubSections.length === 0) problems.push(`${key}: no stub heading left in the register`);
      for (const section of stubSections) {
        const lines = section.split('\n');
        lines.forEach((line, index) => {
          if (/^#{2,6} /.test(line)) {
            const next = lines.slice(index + 1).find(candidate => candidate.trim() !== '');
            if (next !== stubOf(key)) problems.push(`${key}: heading "${line.slice(0, 60)}" is not followed by its own stub link`);
          } else if (line.trim() !== '' && line !== stubOf(key) && !/^<a id="[^"]+"><\/a>$/.test(line)) {
            problems.push(`${key}: detail text left in a stub section: "${line.slice(0, 60)}"`);
          }
        });
      }
    }
    expect(problems).toEqual([]);
  });

  it('holds each archived detail once, with the closed entry still in the register index', () => {
    const archivedIds = [...archive.matchAll(/^## (LT-\d+)\b/gm)].map(match => match[1]);
    expect(new Set(archivedIds).size).toBe(archivedIds.length);
    for (const id of archivedIds) expect(register, `${id} index row`).toMatch(new RegExp(`^\\| ${id} \\|`, 'm'));
  });

  it('archives only entries whose index row does not say a live check or acceptance is still outstanding', () => {
    const outstanding =
      /live (re-?)?check (pending|on a deployed.*still to do)|live re-?check pending|re-verify after landing|still to do|not yet done|remains open|not re-observed|not rechecked|re-audit not/i;
    const archivedIds = [...archive.matchAll(/^## (LT-\d+)\b/gm)].map(match => match[1]);
    // An id can have rows in more than one index table; any one of them saying a check is outstanding keeps it.
    const indexRows = register.split('\n').filter(line => /^\| LT-\d+ \|/.test(line));
    const stillOutstanding = archivedIds.filter(id =>
      indexRows.some(row => row.startsWith(`| ${id} |`) && outstanding.test(row)),
    );
    expect(stillOutstanding).toEqual([]);
  });
});
