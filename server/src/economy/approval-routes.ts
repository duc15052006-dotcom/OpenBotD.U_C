import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import {
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import type { AppVariables } from "../auth/guards";
import {
  OwnerPaymentApprovalConflictError,
  OwnerPaymentApprovalForbiddenError,
  OwnerPaymentApprovalNotRequiredError,
  PaymentIntentApprovalNotFoundError,
  type OwnerPaymentApprovalStore,
} from "./approval-store";

/**
 * Owner-facing approval surface for immutable payment intents.
 *
 * The route deliberately accepts only the intent id from the path. Agent id, policy version and
 * Owner identity are resolved by the store from durable server state, so browser/tool input cannot
 * widen the authority being approved.
 */
export function createOwnerPaymentApprovalRoutes(
  approvals: OwnerPaymentApprovalStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  auditStore?: AuditStore,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:intentId/approve", requireUser, async (context) => {
    const intentId = context.req.param("intentId").trim();
    if (!intentId) {
      return context.json({ error: "A payment intent id is required." }, 400);
    }

    try {
      const approval = await approvals.approve({
        intentId,
        actorUserId: context.var.actor.id,
        metadata: { source: "owner_http" },
      });

      if (auditStore) {
        try {
          await recordAuditEvent(auditStore, {
            eventType: "economy.payment_approved",
            targetType: "payment_intent",
            targetId: approval.intentId,
            actorUserId: context.var.actor.id,
            payload: {
              approvalId: approval.id,
              agentId: approval.agentId,
              policyVersion: approval.policyVersion,
            },
          });
        } catch (auditError) {
          console.error(
            JSON.stringify({
              type: "economy-approval-audit-write-failed",
              outcome: "approved",
              error: String(auditError),
            }),
          );
        }
      }

      return context.json(
        {
          approval: {
            id: approval.id,
            intentId: approval.intentId,
            agentId: approval.agentId,
            policyVersion: approval.policyVersion,
            approvedAt: approval.approvedAt.toISOString(),
          },
        },
        201,
      );
    } catch (error) {
      const refusedReason =
        error instanceof PaymentIntentApprovalNotFoundError ||
        error instanceof OwnerPaymentApprovalForbiddenError
          ? "not_found_or_forbidden"
          : error instanceof OwnerPaymentApprovalNotRequiredError
            ? "not_required"
            : error instanceof OwnerPaymentApprovalConflictError
              ? "conflict"
              : null;

      if (refusedReason && auditStore) {
        try {
          await recordAuditEvent(auditStore, {
            eventType: "economy.payment_approval_refused",
            targetType: "payment_intent",
            actorUserId: context.var.actor.id,
            payload: { reason: refusedReason },
          });
        } catch (auditError) {
          console.error(
            JSON.stringify({
              type: "economy-approval-audit-write-failed",
              outcome: "refused",
              error: String(auditError),
            }),
          );
        }
      }

      if (
        error instanceof PaymentIntentApprovalNotFoundError ||
        error instanceof OwnerPaymentApprovalForbiddenError
      ) {
        // Do not reveal whether another person's payment intent exists.
        return context.json({ error: "Payment intent not found." }, 404);
      }
      if (
        error instanceof OwnerPaymentApprovalNotRequiredError ||
        error instanceof OwnerPaymentApprovalConflictError
      ) {
        return context.json({ error: error.message }, 409);
      }
      throw error;
    }
  });

  return routes;
}
