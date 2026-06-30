import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type {
  LoopPhaseSpec,
  LoopPlanPacketSummary,
} from '../../shared/types/loop.types';
import type { LoopArtifactPaths } from './loop-artifact-paths';

const PHASE_HEADING = /^##\s+Phase\s+(\d+)\s*:\s*(.+?)\s*$/;
const SECTION_HEADING = /^(Acceptance Criteria|Required Commands|Evidence):\s*$/;
const EVIDENCE_SHAPE = /\b\S+:\d+\b/;

type PacketSection = 'acceptance' | 'commands' | 'evidence' | null;

interface MutablePhase extends LoopPhaseSpec {
  sawAcceptance: boolean;
  sawCommands: boolean;
  sawEvidence: boolean;
}

export function renderPlanPacketInstructions(paths: LoopArtifactPaths): string {
  return [
    'Before leaving PLAN, write the loop plan packet:',
    '',
    `1. Write ROADMAP.md at \`${paths.roadmap}\`.`,
    `2. Create one phase file per phase under \`${paths.phasesDir}\`.`,
    '3. Each phase must include Acceptance Criteria, Required Commands, and Evidence.',
    `4. Seed LOOP_TASKS.md at \`${paths.tasks}\` from the phase criteria.`,
    '5. Do not write DONE.txt during PLAN.',
  ].join('\n');
}

export function parseLoopPlanPacketMarkdown(
  roadmapPath: string,
  markdown: string,
): LoopPlanPacketSummary {
  const phases: MutablePhase[] = [];
  let current: MutablePhase | null = null;
  let currentSection: PacketSection = null;
  let malformed = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim();
    const phaseMatch = PHASE_HEADING.exec(line);
    if (phaseMatch) {
      current = {
        id: `phase-${phaseMatch[1]}`,
        title: phaseMatch[2].trim(),
        acceptanceCriteria: [],
        requiredCommands: [],
        evidence: [],
        sawAcceptance: false,
        sawCommands: false,
        sawEvidence: false,
      };
      phases.push(current);
      currentSection = null;
      continue;
    }

    if (!current) continue;
    const sectionMatch = SECTION_HEADING.exec(line);
    if (sectionMatch) {
      currentSection = sectionMatch[1] === 'Acceptance Criteria'
        ? 'acceptance'
        : sectionMatch[1] === 'Required Commands'
          ? 'commands'
          : 'evidence';
      if (currentSection === 'acceptance') current.sawAcceptance = true;
      if (currentSection === 'commands') current.sawCommands = true;
      if (currentSection === 'evidence') current.sawEvidence = true;
      continue;
    }

    if (!line.startsWith('-')) continue;
    const item = cleanListItem(line);
    if (!item) continue;
    if (currentSection === 'acceptance') current.acceptanceCriteria.push(item);
    if (currentSection === 'commands') current.requiredCommands.push(item);
    if (currentSection === 'evidence' && EVIDENCE_SHAPE.test(item)) current.evidence.push(item);
  }

  if (phases.length === 0) malformed = true;
  for (const phase of phases) {
    if (!phase.sawAcceptance || !phase.sawCommands || !phase.sawEvidence) malformed = true;
  }

  const stablePhases: LoopPhaseSpec[] = phases.map((phase) => ({
    id: phase.id,
    title: phase.title,
    acceptanceCriteria: phase.acceptanceCriteria,
    requiredCommands: phase.requiredCommands,
    evidence: phase.evidence,
  }));
  const criteriaTotal = stablePhases.reduce((sum, phase) => sum + phase.acceptanceCriteria.length, 0);
  const criteriaWithEvidence = stablePhases.reduce(
    (sum, phase) => sum + Math.min(phase.acceptanceCriteria.length, phase.evidence.length),
    0,
  );

  return {
    roadmapPath,
    phases: stablePhases,
    criteriaTotal,
    criteriaWithEvidence,
    malformed,
  };
}

export async function readLoopPlanPacket(paths: LoopArtifactPaths): Promise<LoopPlanPacketSummary | null> {
  const phaseTexts = await readPhaseFiles(paths.phasesDir);
  if (phaseTexts.length > 0) {
    return parseLoopPlanPacketMarkdown(paths.roadmap, phaseTexts.join('\n\n'));
  }

  try {
    const roadmap = await fsp.readFile(paths.roadmap, 'utf8');
    return parseLoopPlanPacketMarkdown(paths.roadmap, roadmap);
  } catch {
    return null;
  }
}

function cleanListItem(line: string): string {
  return line
    .replace(/^-\s+\[[ xX]\]\s*/, '')
    .replace(/^-\s*/, '')
    .trim();
}

async function readPhaseFiles(phasesDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(phasesDir);
  } catch {
    return [];
  }
  const markdownFiles = entries
    .filter((entry) => entry.endsWith('.md') && !entry.endsWith('.fix.md'))
    .sort();
  const texts: string[] = [];
  for (const entry of markdownFiles) {
    try {
      texts.push(await fsp.readFile(path.join(phasesDir, entry), 'utf8'));
    } catch {
      // Best effort: malformed/missing phase files are handled by the summary.
    }
  }
  return texts;
}
