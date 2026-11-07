/** User-saved Harness decisions exposed to settings. Never includes other rule sets. */
export interface SavedPermissionRule {
  id: string;
  action: 'allow' | 'deny' | 'ask';
  scope: string;
  pattern: string;
  literal: boolean;
  enabled: boolean;
  createdAt: number | null;
}
