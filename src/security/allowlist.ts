import type { AllowlistEntry } from "../config/environment";
import type { NormalizedMessage } from "../model/message";

/**
 * Explicit allowlists: a conversation is collected only when its stable platform id is listed. Nothing is
 * collected by default, and group NAMES are never used to authorize (names are not unique and can be changed by
 * any member); an optional label only gives the group a display name.
 */

export type AllowDecision =
  | { allowed: true; label: string | null }
  | { allowed: false; reason: "group_not_allowlisted" | "sender_not_allowlisted" | "missing_conversation_id" | "group_capture_unsupported" };

export class Allowlist {
  private readonly groups: Map<string, string | null>;
  private readonly senders: Map<string, string | null>;

  constructor(
    groups: AllowlistEntry[],
    senders: AllowlistEntry[],
    private readonly groupCaptureSupported: boolean,
  ) {
    this.groups = new Map(groups.map((g) => [g.id, g.label]));
    this.senders = new Map(senders.map((s) => [s.id, s.label]));
  }

  decide(m: Pick<NormalizedMessage, "conversationType" | "groupId" | "senderId">): AllowDecision {
    if (m.conversationType === "group") {
      if (!this.groupCaptureSupported) return { allowed: false, reason: "group_capture_unsupported" };
      if (!m.groupId) return { allowed: false, reason: "missing_conversation_id" };
      return this.groups.has(m.groupId) ? { allowed: true, label: this.groups.get(m.groupId) ?? null } : { allowed: false, reason: "group_not_allowlisted" };
    }
    if (!m.senderId) return { allowed: false, reason: "missing_conversation_id" };
    return this.senders.has(m.senderId) ? { allowed: true, label: null } : { allowed: false, reason: "sender_not_allowlisted" };
  }

  get counts(): { groups: number; senders: number } {
    return { groups: this.groups.size, senders: this.senders.size };
  }
}
