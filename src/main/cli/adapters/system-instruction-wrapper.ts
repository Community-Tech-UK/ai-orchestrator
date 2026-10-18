/** Shared ACP/Codex delimiter boundary. Phase 0 retains the existing label. */
export function escapeSystemInstructionDelimiter(instructions: string): string {
  return instructions.replace(/\[\/SYSTEM INSTRUCTIONS\]/gi, '[\\/SYSTEM INSTRUCTIONS]');
}

export function wrapSystemInstructions(instructions: string): string {
  return `[SYSTEM INSTRUCTIONS]\n${escapeSystemInstructionDelimiter(instructions)}\n[/SYSTEM INSTRUCTIONS]`;
}
