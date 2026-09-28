import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AgentProfileStore } from "../agents/profile-store";
import type { AppVariables } from "../auth/guards";
import { CredentialUnusableError } from "../credentials";
import {
  PaymentExecutionRefusedError,
} from "./execution";
import {
  LiveOperatingPaymentUnsupportedError,
  type LiveOperatingPaymentExecutor,
} from "./live-payment-executor";
import { PaymentAdapterResolutionError } from "./payment-adapter-resolver";
import type { PaymentIntentReader } from "./payment-intent-store";

function approvalIdFrom(value: unknown): string | undefined | null {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function createLivePaymentRoutes(input: {
  executor: LiveOperatingPaymentExecutor;
  intentReader: PaymentIntentReader;
  profiles: AgentProfileStore;
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();

  routes.post("/:intentId/execute", input.requireUser, async (context) => {
    const intentId = context.req.param("intentId").trim();
    if (!intentId) {
      return context.json({ error: "Payment intent not found." }, 404);
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = await context.req.json();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        body = raw as Record<string, unknown>;
      } else {
        return context.json({ error: "Payment execution body is invalid." }, 400);
      }
    } catch {
      // Empty body is valid for ALLOW intents.
    }

    const approvalId = approvalIdFrom(body.approvalId);
    if (approvalId === null) {
      return context.json({ error: "Payment execution body is invalid." }, 400);
    }

    const durable = await input.intentReader.load(intentId);
    if (!durable) {
      return context.json({ error: "Payment intent not found." }, 404);
    }

    const actor = context.var.actor;
    const profile = await input.profiles
      .get({ id: actor.id, role: actor.role }, durable.agentId)
      .catch(() => null);
    if (!profile || profile.ownerUserId !== actor.id || profile.deletedAt) {
      return context.json({ error: "Payment intent not found." }, 404);
    }

    try {
      const result = await input.executor.execute({
        intentId,
        actorUserId: actor.id,
        ...(approvalId ? { approvalId } : {}),
      });

      return context.json({
        payment: {
          intentId: result.receipt.intentId,
          provider: result.receipt.provider,
          externalReference: result.receipt.externalReference,
          assetCode: result.receipt.assetCode,
          amountMinor: result.receipt.amountMinor.toString(),
          destination: result.receipt.destination,
          verifiedAt: result.receipt.verifiedAt.toISOString(),
          ledgerEntryId: result.ledgerEntry.id,
        },
      });
    } catch (error) {
      if (
        error instanceof PaymentExecutionRefusedError ||
        error instanceof LiveOperatingPaymentUnsupportedError
      ) {
        return context.json({ error: error.message }, 409);
      }
      if (
        error instanceof PaymentAdapterResolutionError ||
        error instanceof CredentialUnusableError
      ) {
        return context.json(
          { error: "Payment account is not ready for live execution." },
          409,
        );
      }
      throw error;
    }
  });

  return routes;
}
