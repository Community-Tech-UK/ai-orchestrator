import type { Instance } from "../../shared/types/instance.types";
import { MOBILE_OWNER_PROFILE_ID } from "../../shared/types/mobile-gateway.types";
import { isAutomationAttentionStatus } from "../../shared/types/instance-status-policy";
import { isProjectRailHiddenSession } from "../../shared/utils/project-rail-hidden-session";

type SessionView = Pick<Instance, "status" | "parentId" | "metadata">;

/** Sessions Harness starts for its own work; each reports through its own screen. */
const BACKGROUND_SPEND_PURPOSES = new Set<unknown>(["channel", "review", "repo-job"]);

/**
 * Mirrors the desktop project rail (`project-rail-builder.service.ts`):
 * internal worker sessions are never listed, and a hidden automation's
 * session appears only once it fails, parks waiting for a person, or the
 * operator takes it over.
 */
export function isHiddenFromMobile(instance: SessionView): boolean {
  const metadata = instance.metadata;
  if (isProjectRailHiddenSession(metadata)) return true;
  return metadata?.["automationHidden"] === true
    && metadata["automationRevealed"] !== true
    && !isAutomationAttentionStatus(instance.status);
}

/**
 * True for a top-level session the operator started or took over. A turn
 * ending anywhere else (automation runs, Plan Queue workers, child agents,
 * reviewers, channel replies, repo jobs) is not waiting on the operator:
 * those report success and failure through their own screens and pushes.
 */
export function isOperatorSession(instance: SessionView): boolean {
  const metadata = instance.metadata ?? {};
  if (instance.parentId) return false;
  if (isProjectRailHiddenSession(metadata)) return false;
  if (typeof metadata["planQueueRole"] === "string") return false;
  if (typeof metadata["automationId"] === "string") return metadata["automationRevealed"] === true;
  return !BACKGROUND_SPEND_PURPOSES.has(metadata["spendPurpose"]);
}

/** Instance metadata key naming the phone-app person a session belongs to. */
export const MOBILE_PROFILE_METADATA_KEY = "mobileProfileId";

/**
 * The person a session belongs to. Sessions started anywhere but a member's
 * phone carry no stamp and belong to the owner of the Mac.
 */
export function sessionProfileId(instance: Pick<Instance, "metadata">): string {
  const stamped = instance.metadata?.[MOBILE_PROFILE_METADATA_KEY];
  return typeof stamped === "string" && stamped ? stamped : MOBILE_OWNER_PROFILE_ID;
}
