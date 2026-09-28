import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentPaymentApprovals,
  agentPaymentIntents,
  agentProfiles,
} from "../db/schema";
import type { OwnerPaymentApproval } from "./execution";

export class PaymentIntentApprovalNotFoundError extends Error {
  constructor(intentId: string) {
    super(`Payment intent ${intentId} was not found.`);
    this.name = "PaymentIntentApprovalNotFoundError";
  }
}

export class OwnerPaymentApprovalForbiddenError extends Error {
  constructor() {
    super("Only the Agent owner may approve this payment intent.");
    this.name = "OwnerPaymentApprovalForbiddenError";
  }
}

export class OwnerPaymentApprovalNotRequiredError extends Error {
  constructor(intentId: string) {
    super(`Payment intent ${intentId} does not require Owner confirmation.`);
    this.name = "OwnerPaymentApprovalNotRequiredError";
  }
}

export class OwnerPaymentApprovalConflictError extends Error {
  constructor(intentId: string) {
    super(`Payment intent ${intentId} already has a different Owner approval.`);
    this.name = "OwnerPaymentApprovalConflictError";
  }
}

export interface OwnerApprovalTarget {
  intentId: string;
  agentId: string;
  policyVersion: number;
  decision: string;
  ownerUserId: string | null;
  agentDeletedAt: Date | null;
}

export function requireOwnerApprovalTarget(
  target: OwnerApprovalTarget | null,
  actorUserId: string,
): OwnerApprovalTarget {
  if (!target) {
    throw new PaymentIntentApprovalNotFoundError("unknown");
  }
  // Deleted Agents cannot receive new financial authority. Treat deletion like a private/forbidden
  // target so callers cannot distinguish lifecycle state through this endpoint.
  if (
    target.agentDeletedAt ||
    !target.ownerUserId ||
    target.ownerUserId !== actorUserId
  ) {
    throw new OwnerPaymentApprovalForbiddenError();
  }
  if (target.decision !== "OWNER_CONFIRMATION") {
    throw new OwnerPaymentApprovalNotRequiredError(target.intentId);
  }
  if (!Number.isInteger(target.policyVersion) || target.policyVersion <= 0) {
    throw new OwnerPaymentApprovalConflictError(target.intentId);
  }
  return target;
}

function approvalFromRow(row: {
  id: string;
  intentId: string;
  agentId: string;
  policyVersion: number;
  approverKind: string;
  approverId: string;
  approvedAt: Date;
}): OwnerPaymentApproval | null {
  if (row.approverKind !== "OWNER") return null;
  return {
    id: row.id,
    intentId: row.intentId,
    agentId: row.agentId,
    policyVersion: row.policyVersion,
    approverKind: "OWNER",
    approverId: row.approverId,
    approvedAt: row.approvedAt,
  };
}

export type OwnerPaymentApprovalStore = {
  approve(input: {
    intentId: string;
    actorUserId: string;
    approvedAt?: Date;
    metadata?: Record<string, unknown>;
  }): Promise<OwnerPaymentApproval>;
  load(approvalId: string): Promise<OwnerPaymentApproval | null>;
};

/**
 * Canonical server-side persistence boundary for Owner payment approvals.
 *
 * Callers do not supply Agent identity or policy version. Both come from the immutable payment
 * intent, and Owner identity comes from the Agent profile. That prevents an HTTP/tool caller from
 * turning an approval for one Agent or policy version into authority for another.
 *
 * The unique intent index makes approval idempotent under retries. A concurrent duplicate returns
 * the already-persisted approval only when it matches the same Owner/Agent/policy tuple; any
 * mismatch fails closed rather than replacing history.
 */
export function createOwnerPaymentApprovalStore(
  database: Database,
): OwnerPaymentApprovalStore {
  return {
    async approve(input) {
      const intentId = input.intentId.trim();
      const actorUserId = input.actorUserId.trim();
      if (!intentId)
        throw new PaymentIntentApprovalNotFoundError(input.intentId);
      if (!actorUserId) throw new OwnerPaymentApprovalForbiddenError();

      return database.transaction(async (transaction) => {
        const [targetRow] = await transaction
          .select({
            intentId: agentPaymentIntents.id,
            agentId: agentPaymentIntents.agentId,
            policyVersion: agentPaymentIntents.policyVersion,
            decision: agentPaymentIntents.decision,
            ownerUserId: agentProfiles.ownerUserId,
            agentDeletedAt: agentProfiles.deletedAt,
          })
          .from(agentPaymentIntents)
          .leftJoin(
            agentProfiles,
            eq(agentProfiles.agentId, agentPaymentIntents.agentId),
          )
          .where(eq(agentPaymentIntents.id, intentId))
          .limit(1);

        if (!targetRow) throw new PaymentIntentApprovalNotFoundError(intentId);
        const target = requireOwnerApprovalTarget(targetRow, actorUserId);
        const approvedAt = input.approvedAt ?? new Date();
        if (Number.isNaN(approvedAt.getTime())) {
          throw new OwnerPaymentApprovalConflictError(intentId);
        }

        await transaction
          .insert(agentPaymentApprovals)
          .values({
            intentId: target.intentId,
            agentId: target.agentId,
            policyVersion: target.policyVersion,
            approverKind: "OWNER",
            approverId: actorUserId,
            approvedAt,
            metadata: input.metadata ?? {},
          })
          .onConflictDoNothing({ target: agentPaymentApprovals.intentId });

        const [stored] = await transaction
          .select({
            id: agentPaymentApprovals.id,
            intentId: agentPaymentApprovals.intentId,
            agentId: agentPaymentApprovals.agentId,
            policyVersion: agentPaymentApprovals.policyVersion,
            approverKind: agentPaymentApprovals.approverKind,
            approverId: agentPaymentApprovals.approverId,
            approvedAt: agentPaymentApprovals.approvedAt,
          })
          .from(agentPaymentApprovals)
          .where(eq(agentPaymentApprovals.intentId, target.intentId))
          .limit(1);

        const approval = stored ? approvalFromRow(stored) : null;
        if (
          !approval ||
          approval.intentId !== target.intentId ||
          approval.agentId !== target.agentId ||
          approval.policyVersion !== target.policyVersion ||
          approval.approverId !== actorUserId
        ) {
          throw new OwnerPaymentApprovalConflictError(intentId);
        }
        return approval;
      });
    },

    async load(approvalId) {
      const normalized = approvalId.trim();
      if (!normalized) return null;
      const [row] = await database
        .select({
          id: agentPaymentApprovals.id,
          intentId: agentPaymentApprovals.intentId,
          agentId: agentPaymentApprovals.agentId,
          policyVersion: agentPaymentApprovals.policyVersion,
          approverKind: agentPaymentApprovals.approverKind,
          approverId: agentPaymentApprovals.approverId,
          approvedAt: agentPaymentApprovals.approvedAt,
          profileAgentId: agentProfiles.agentId,
          agentDeletedAt: agentProfiles.deletedAt,
        })
        .from(agentPaymentApprovals)
        .leftJoin(
          agentProfiles,
          eq(agentProfiles.agentId, agentPaymentApprovals.agentId),
        )
        .where(eq(agentPaymentApprovals.id, normalized))
        .limit(1);
      if (!row?.profileAgentId || row.agentDeletedAt) return null;
      return approvalFromRow(row);
    },
  };
}
