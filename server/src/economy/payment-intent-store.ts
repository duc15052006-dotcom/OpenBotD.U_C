import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  agentFinancialAccounts,
  agentPaymentIntents,
  agentProfiles,
} from "../db/schema";
import type { PaymentDecision, PaymentIntentKind } from "./intents";

export interface DurablePaymentIntent {
  id: string;
  agentId: string;
  accountId: string;
  idempotencyKey: string;
  kind: PaymentIntentKind;
  amountMinor: bigint;
  assetCode: string;
  provider: string;
  destination: string;
  category: string;
  x402Domain?: string;
  decision: PaymentDecision;
  policyVersion: number;
}

export interface PaymentIntentReader {
  load(intentId: string): Promise<DurablePaymentIntent | null>;
}

function paymentKind(value: string): PaymentIntentKind | null {
  return value === "OPERATING_EXPENSE" ||
    value === "OWNER_PAYOUT" ||
    value === "CHILD_FUNDING" ||
    value === "X402_PAYMENT"
    ? value
    : null;
}

function paymentDecision(value: string): PaymentDecision | null {
  return value === "ALLOW" || value === "OWNER_CONFIRMATION" || value === "DENY"
    ? value
    : null;
}

export function createPaymentIntentReader(
  database: Database,
): PaymentIntentReader {
  return {
    async load(intentId) {
      const normalized = intentId.trim();
      if (!normalized) return null;

      const [row] = await database
        .select({
          id: agentPaymentIntents.id,
          agentId: agentPaymentIntents.agentId,
          accountId: agentPaymentIntents.accountId,
          idempotencyKey: agentPaymentIntents.idempotencyKey,
          kind: agentPaymentIntents.kind,
          amountMinor: agentPaymentIntents.amountMinor,
          destination: agentPaymentIntents.destination,
          category: agentPaymentIntents.category,
          x402Domain: agentPaymentIntents.x402Domain,
          decision: agentPaymentIntents.decision,
          policyVersion: agentPaymentIntents.policyVersion,
          assetCode: agentFinancialAccounts.assetCode,
          provider: agentFinancialAccounts.provider,
          profileAgentId: agentProfiles.agentId,
        })
        .from(agentPaymentIntents)
        .innerJoin(
          agentFinancialAccounts,
          and(
            eq(agentFinancialAccounts.id, agentPaymentIntents.accountId),
            eq(agentFinancialAccounts.agentId, agentPaymentIntents.agentId),
          ),
        )
        .leftJoin(
          agentProfiles,
          and(
            eq(agentProfiles.agentId, agentPaymentIntents.agentId),
            isNull(agentProfiles.deletedAt),
          ),
        )
        .where(eq(agentPaymentIntents.id, normalized))
        .limit(1);

      if (!row?.profileAgentId) return null;
      const kind = paymentKind(row.kind);
      const decision = paymentDecision(row.decision);
      if (!kind || !decision || row.policyVersion <= 0) return null;

      let amountMinor: bigint;
      try {
        amountMinor = BigInt(row.amountMinor);
      } catch {
        return null;
      }
      if (
        amountMinor <= 0n ||
        !row.idempotencyKey.trim() ||
        !row.assetCode.trim() ||
        !row.provider.trim() ||
        !row.destination.trim() ||
        !row.category.trim()
      ) {
        return null;
      }

      return {
        id: row.id,
        agentId: row.agentId,
        accountId: row.accountId,
        idempotencyKey: row.idempotencyKey,
        kind,
        amountMinor,
        assetCode: row.assetCode,
        provider: row.provider,
        destination: row.destination,
        category: row.category,
        ...(row.x402Domain ? { x402Domain: row.x402Domain } : {}),
        decision,
        policyVersion: row.policyVersion,
      };
    },
  };
}
