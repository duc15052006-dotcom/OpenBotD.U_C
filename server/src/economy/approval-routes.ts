import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
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
