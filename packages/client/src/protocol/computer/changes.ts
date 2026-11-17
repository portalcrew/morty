/**
 * A browser follows its Computer's changes instead of polling for them. A notice names what changed and carries no data:
 * the browser reads it again through its ordinary request, so a notice never needs its own authorization or errors.
 */
export const RELAY_CHANGE_TOPICS = ["computer", "linked-devices"] as const;
export type RelayChangeTopic = (typeof RELAY_CHANGE_TOPICS)[number];

export const CHANGES_FOLLOW_KIND = "changes.follow";
export const CHANGES_READY_KIND = "changes.ready";
export const CHANGES_CHANGED_KIND = "changes.changed";
export const CHANGES_ERROR_KIND = "changes.error";
