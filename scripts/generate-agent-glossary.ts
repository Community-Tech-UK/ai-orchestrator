#!/usr/bin/env node
/** Regenerate the agent word list from the single vocabulary source. */
import { writeFileSync } from 'node:fs';
import { GLOSSARY, type GlossaryEntry } from '../src/shared/glossary/glossary';
import { renderAgentGlossary } from './ui-hints/glossary-report';

const entries = Object.values(GLOSSARY) as GlossaryEntry[];
writeFileSync('docs/agent-vocabulary.md', renderAgentGlossary(entries));
process.stdout.write(`Wrote docs/agent-vocabulary.md (${entries.length} entries).\n`);
