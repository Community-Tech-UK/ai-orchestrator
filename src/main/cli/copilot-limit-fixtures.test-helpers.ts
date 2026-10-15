/** Shipped Copilot runtime messages; URLs and request IDs are public/placeholders. */
export const COPILOT_LIMIT_FIXTURES = [
  ["You've hit your rate limit. Please wait for your limit to reset or switch to auto model to continue.", 'rate'],
  ["You've hit the rate limit for this model. Please switch models or wait for your limit to reset.", 'model-rate'],
  ["You've hit your session rate limit.", 'rate'],
  ["You've reached your weekly rate limit. Learn More (https://docs.github.com/copilot/concepts/rate-limits).", 'weekly-rate'],
  ["You've reached the spending limit for this session. Start a new session to continue.", 'session-spend'],
  ["You've run out of your included AI credits for the month. Manage budget: https://github.com/settings/copilot/features", 'monthly-credits'],
  ["You've run out of your AI credits. Manage budget: https://github.com/settings/copilot/features", 'monthly-credits'],
  ["You've reached your additional usage limit for your plan. Go to https://github.com/settings/copilot/features for more details.", 'additional-usage'],
] as const;
