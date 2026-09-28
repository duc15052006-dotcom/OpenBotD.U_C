import type { AuditStore } from "../audit";
import {
  PaymentExecutionRefusedError,
  type PaymentAuthorization,
  type VerifiedPaymentReceipt,
  type VerifiedPaymentReceiptStore,
} from "./execution";
import type { AgentLedgerReader } from "./ledger-reader";
import type { PaymentAdapterResolver } from "./payment-adapter-resolver";
import type { OwnerPaymentApprovalStore } from "./approval-store";
import type { PaymentIntentCreationSnapshotLoader } from "./payment-intent-creator";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "./payment-intent-store";
import type { OwnerPayoutAccountingStore } from "./payout-store";
import {
  executeManualOwnerPayout,
  type ManualOwnerPayoutResult,
} from "./payout";

export interface LiveOwnerPayoutExecutor {
  execute(input: {
    intentId: string;
    actorUserId: string;
    approvalId?: string;
  }): Promise<ManualOwnerPayoutResult>;
}

function authorizationFor(
  intent: DurablePaymentIntent,
  approvalId?: string,
): PaymentAuthorization {
  if (intent.decision === "DENY") {
    throw new PaymentExecutionRefusedError("durable payment intent was denied");
  }
  if (intent.decision === "ALLOW") {
    if (approvalId?.trim()) {
      throw new PaymentExecutionRefusedError(
        "Owner approval was not requested for this payment intent",
      );
    }
    return {
      decision: "ALLOW",
      policyVersion: intent.policyVersion,
    };
  }

  const normalizedApprovalId = approvalId?.trim();
  if (!normalizedApprovalId) {
    throw new PaymentExecutionRefusedError(
      "persisted Owner approval is required before payout execution",
    );
  }
  return {
    decision: "OWNER_CONFIRMATION",
    policyVersion: intent.policyVersion,
    approvalId: normalizedApprovalId,
  };
}

export function createLiveOwnerPayoutExecutor(input: {
  intentReader: PaymentIntentReader;
  ledgerReader: AgentLedgerReader;
  adapterResolver: PaymentAdapterResolver;
  receiptStore: VerifiedPaymentReceiptStore;
  payoutStore: OwnerPayoutAccountingStore;
  approvalStore: OwnerPaymentApprovalStore;
  loadPolicySnapshot: PaymentIntentCreationSnapshotLoader;
  auditStore: AuditStore;
}): LiveOwnerPayoutExecutor {
  return {
    async execute({ intentId, actorUserId, approvalId }) {
      const normalizedIntentId = intentId.trim();
      const normalizedActorUserId = actorUserId.trim();
      if (!normalizedIntentId || !normalizedActorUserId) {
        throw new PaymentExecutionRefusedError(
          "payment intent and actor are required",
        );
      }

      const durable = await input.intentReader.load(normalizedIntentId);
      if (!durable) {
        throw new PaymentExecutionRefusedError(
          "durable payment intent was not found or Agent is inactive",
        );
      }
      if (durable.kind !== "OWNER_PAYOUT") {
        throw new PaymentExecutionRefusedError(
          "payment intent is not an Owner payout",
        );
      }

      const authorization = authorizationFor(durable, approvalId);
      const ledgerEntries = await input.ledgerReader.loadAgentAsset({
        agentId: durable.agentId,
        assetCode: durable.assetCode,
      });

      return input.adapterResolver.useForAccount({
        agentId: durable.agentId,
        accountId: durable.accountId,
        use: (adapter, provider): Promise<ManualOwnerPayoutResult> =>
          executeManualOwnerPayout({
            intentId: durable.id,
            idempotencyKey: durable.idempotencyKey,
            agentId: durable.agentId,
            accountId: durable.accountId,
            assetCode: durable.assetCode,
            amountMinor: durable.amountMinor,
            destination: durable.destination,
            provider,
            authorization,
            ledgerEntries,
            adapter,
            receiptStore: input.receiptStore,
            intentReader: input.intentReader,
            payoutStore: input.payoutStore,
            requestedBy: normalizedActorUserId,
            audit: {
              store: input.auditStore,
              actorUserId: normalizedActorUserId,
            },
            loadPolicySnapshot: () =>
              input.loadPolicySnapshot({
                agentId: durable.agentId,
                accountId: durable.accountId,
              }),
            loadOwnerApproval: (id) => input.approvalStore.load(id),
          }),
      });
    },
  };
}
