/** Chat replies to a pending mode approval; unrelated text remains ordinary input. */
export function parseSwitchModeApprovalReply(message: string): boolean | undefined {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, ' ');
  if (/^(yes|y|yeah|yep|sure|ok|okay|approved|approve|proceed|continue|go ahead|go for it|do it|sounds good|let'?s do it|switch)$/.test(normalized)) return true;
  if (/^(no|n|nope|nah|don'?t|do not|stop|cancel|reject|not now)$/.test(normalized)) return false;
  return undefined;
}
