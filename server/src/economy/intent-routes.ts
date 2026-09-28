import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import {
  PaymentIntentAccountForbiddenError,
  PaymentIntentCreationConflictError,
  PaymentIntentCreationInvalidError,
  type PaymentIntentCreator,
} from "./payment-intent-creator";
import { PaymentPolicySnapshotError } from "./policy-snapshot-store";

const PAYMENT_KINDS = new Set([
  "OPERATING_EXPENSE",
  "OWNER_PAYOUT",
  "CHILD_FUNDING",
  "X402_PAYMENT",
]);

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function optionalText(
  body: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function positiveMinor(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

export function createPaymentIntentRoutes(
  creator: PaymentIntentCreator,
  profiles: AgentProfileStore,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/", requireUser, async (context) => {
    let raw: unknown;
    try {
      raw = await context.req.json();
    } catch {
      return context.json(
        { error: "A JSON payment intent body is required." },
        400,
      );
    }

    const body = bodyObject(raw);
    if (!body) {
      return context.json(
        { error: "A JSON payment intent body is required." },
        400,
      );
    }

    const agentId = requiredText(body, "agentId");
    const accountId = requiredText(body, "accountId");
    const idempotencyKey = requiredText(body, "idempotencyKey");
    const destination = requiredText(body, "destination");
    const category = requiredText(body, "category");
    const x402Domain = optionalText(body, "x402Domain");
    const kind =
      typeof body.kind === "string" && PAYMENT_KINDS.has(body.kind)
        ? body.kind
        : null;
    const amountMinor = positiveMinor(body.amountMinor);

    if (
      !agentId ||
      !accountId ||
      !idempotencyKey ||
      !kind ||
      !amountMinor ||
      !destination ||
      !category ||
      x402Domain === null
    ) {
      return context.json({ error: "Payment intent request is invalid." }, 400);
    }

    const actor = context.var.actor;
    const profile = await profiles
      .get({ id: actor.id, role: actor.role }, agentId)
      .catch(() => null);

    // Visibility is not financial authority. Public Agents remain visible to other people, but only
    // the actual human Owner may create an Owner-originated payment intent through this HTTP route.
    if (!profile || profile.ownerUserId !== actor.id || profile.deletedAt) {
      return context.json({ error: "Agent not found." }, 404);
    }

    try {
      const created = await creator.create({
        accountId,
        idempotencyKey,
        intent: {
          agentId,
          kind: kind as
            | "OPERATING_EXPENSE"
            | "OWNER_PAYOUT"
            | "CHILD_FUNDING"
            | "X402_PAYMENT",
          amountMinor,
          destination,
          category,
          ...(x402Domain ? { x402Domain } : {}),
        },
        initiator: { kind: "person", id: actor.id },
      });

      return context.json(
        {
          intent: {
            id: created.id,
            agentId: created.agentId,
            accountId: created.accountId,
            idempotencyKey: created.idempotencyKey,
            kind: created.kind,
            amountMinor: created.amountMinor.toString(),
            assetCode: created.assetCode,
            provider: created.provider,
            destination: created.destination,
            category: created.category,
            ...(created.x402Domain ? { x402Domain: created.x402Domain } : {}),
            decision: created.decision,
            decisionReason: created.decisionReason,
            policyVersion: created.policyVersion,
            requestedAt: created.requestedAt.toISOString(),
          },
        },
        201,
      );
    } catch (error) {
      if (error instanceof PaymentIntentCreationInvalidError) {
        return context.json(
          { error: "Payment intent request is invalid." },
          400,
        );
      }
      if (error instanceof PaymentIntentAccountForbiddenError) {
        // Keep another Agent's financial account existence private.
        return context.json({ error: "Financial account not found." }, 404);
      }
      if (error instanceof PaymentIntentCreationConflictError) {
        return context.json({ error: error.message }, 409);
      }
      if (error instanceof PaymentPolicySnapshotError) {
        return context.json(
          { error: "Financial policy state is not ready for this Agent." },
          409,
        );
      }
      throw error;
    }
  });

  return routes;
}
