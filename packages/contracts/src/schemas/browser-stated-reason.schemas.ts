import { z } from 'zod';

/**
 * Why the agent is asking, in its own words. Accepted (optional) on every
 * browser tool that can raise an approval and shown to the person who decides.
 * It is never read from the page. The gateway cleans it before it is stored.
 */
export const BrowserStatedReasonSchema = z.string().min(1).max(1000);
