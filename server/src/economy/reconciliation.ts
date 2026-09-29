import { desc, eq } from "drizzle-orm";
import type { AuditStore } from "../audit";
import { DEPLOYMENT_INITIATOR, recordAuditEvent } from "../audit";
import type { Database } from "../db/client";
import { agentPaymentReceipts } from "../db/schema";
import type { PaymentAdapterResolver } from "./payment-adapter-resolver";
import type { VerifiedPaymentReceipt } from "./execution";
import { verifiedPaymentReceiptFromRow } from "./receipt-store";

export interface ReconciliationCandidate {
  receiptId: string;
  receipt: VerifiedPaymentReceipt;
}

export interface PaymentReceiptReconciliationSource {
  list(batchSize: number): Promise<ReconciliationCandidate[]>;
}

export interface PaymentReconciliationReport {
  checked: number;
  verified: number;
  failed: number;
  auditWriteFailures: number;
}

export function createPaymentReceiptReconciliationSource(
  database: Database,
): PaymentReceiptReconciliationSource {
  return {
    async list(batchSize) {
      if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 500) {
        throw new Error("payment reconciliation batch size must be 1..500");
      }

      const rows = await database
        .select({
          id: agentPaymentReceipts.id,
          intentId: agentPaymentReceipts.intentId,
          agentId: agentPaymentReceipts.agentId,
          accountId: agentPaymentReceipts.accountId,
          provider: agentPaymentReceipts.provider,
          externalReference: agentPaymentReceipts.externalReference,
          providerStatus: agentPaymentReceipts.providerStatus,
          assetCode: agentPaymentReceipts.assetCode,
          amountMinor: agentPaymentReceipts.amountMinor,
          destination: agentPaymentReceipts.destination,
          balanceBeforeMinor: agentPaymentReceipts.balanceBeforeMinor,
          balanceAfterMinor: agentPaymentReceipts.balanceAfterMinor,
          verifiedAt: agentPaymentReceipts.verifiedAt,
        })
        .from(agentPaymentReceipts)
        .where(eq(agentPaymentReceipts.providerStatus, "verified"))
        .orderBy(desc(agentPaymentReceipts.verifiedAt))
        .limit(batchSize);

      return rows.map((row) => ({
        receiptId: row.id,
        receipt: verifiedPaymentReceiptFromRow(row),
      }));
    },
  };
}

async function auditFailure(
  auditStore: AuditStore,
  candidate: ReconciliationCandidate,
  reason: "provider_evidence_mismatch" | "provider_unavailable",
): Promise<boolean> {
  try {
    await recordAuditEvent(auditStore, {
      eventType: "economy.payment_reconciliation_failed",
      targetType: "payment_receipt",
      targetId: candidate.receiptId,
      initiator: DEPLOYMENT_INITIATOR,
      payload: {
        intentId: candidate.receipt.intentId,
        agentId: candidate.receipt.agentId,
        accountId: candidate.receipt.accountId,
        provider: candidate.receipt.provider,
        reason,
      },
    });
    return true;
  } catch {
    return false;
  }
}

export async function reconcileVerifiedPaymentReceipts(input: {
  source: PaymentReceiptReconciliationSource;
  adapterResolver: PaymentAdapterResolver;
  auditStore: AuditStore;
  batchSize?: number;
}): Promise<PaymentReconciliationReport> {
  const candidates = await input.source.list(input.batchSize ?? 100);
  let verified = 0;
  let failed = 0;
  let auditWriteFailures = 0;

  for (const candidate of candidates) {
    let ok = false;
    let reason: "provider_evidence_mismatch" | "provider_unavailable" =
      "provider_evidence_mismatch";

    try {
      ok = await input.adapterResolver.useForAccount({
        agentId: candidate.receipt.agentId,
        accountId: candidate.receipt.accountId,
        use: async (adapter, provider) => {
          if (provider !== candidate.receipt.provider) return false;
          return adapter.verifyTransfer({
            transferId: candidate.receipt.externalReference,
            idempotencyKey: candidate.receipt.intentId,
            amount: {
              assetCode: candidate.receipt.assetCode,
              amountMinor: candidate.receipt.amountMinor,
            },
            destination: candidate.receipt.destination,
          });
        },
      });
    } catch {
      reason = "provider_unavailable";
    }

    if (ok) {
      verified += 1;
      continue;
    }

    failed += 1;
    if (!(await auditFailure(input.auditStore, candidate, reason))) {
      auditWriteFailures += 1;
    }
  }

  return {
    checked: candidates.length,
    verified,
    failed,
    auditWriteFailures,
  };
}
