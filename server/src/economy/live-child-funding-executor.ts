import type { AuditStore } from "../audit";
import type { ChildFundingReservationStore } from "./child-funding-reservation-store";
import type {
  ChildFundingStore,
  PersistedChildFunding,
} from "./child-funding-store";
import {
  executeAndPersistAuthorizedPayment,
  PaymentExecutionRefusedError,
  type PaymentAuthorization,
  type VerifiedPaymentReceipt,
  type VerifiedPaymentReceiptStore,
} from "./execution";
import type { AgentLedgerEntry } from "./model";
import type { OwnerPaymentApprovalStore } from "./approval-store";
import type { PaymentAdapterResolver } from "./payment-adapter-resolver";
import type { PaymentIntentCreationSnapshotLoader } from "./payment-intent-creator";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "./payment-intent-store";

export interface LiveChildFundingResult {
  receipt: VerifiedPaymentReceipt;
  ledgerEntry: AgentLedgerEntry;
  childLedgerEntry: AgentLedgerEntry;
  funding: PersistedChildFunding;
}

export interface LiveChildFundingExecutor {
  execute(input: {
    intentId: string;
    actorUserId: string;
    approvalId?: string;
  }): Promise<LiveChildFundingResult>;
}

function executableIntent(intent: DurablePaymentIntent) {
  return {
    id: intent.id,
    agentId: intent.agentId,
    accountId: intent.accountId,
    idempotencyKey: intent.idempotencyKey,
    kind: intent.kind,
    amountMinor: intent.amountMinor,
    assetCode: intent.assetCode,
    destination: intent.destination,
    category: intent.category,
    ...(intent.x402Domain ? { x402Domain: intent.x402Domain } : {}),
  };
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
      "persisted Owner approval is required before child funding execution",
    );
  }
  return {
    decision: "OWNER_CONFIRMATION",
    policyVersion: intent.policyVersion,
    approvalId: normalizedApprovalId,
  };
}

export function createLiveChildFundingExecutor(input: {
  intentReader: PaymentIntentReader;
  reservationStore: ChildFundingReservationStore;
  fundingStore: ChildFundingStore;
  adapterResolver: PaymentAdapterResolver;
  receiptStore: VerifiedPaymentReceiptStore;
  approvalStore: OwnerPaymentApprovalStore;
  loadPolicySnapshot: PaymentIntentCreationSnapshotLoader;
  auditStore: AuditStore;
}): LiveChildFundingExecutor {
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
      if (durable.kind !== "CHILD_FUNDING") {
        throw new PaymentExecutionRefusedError(
          "payment intent is not child funding",
        );
      }

      const authorization = authorizationFor(durable, approvalId);
      const reservation = await input.reservationStore.reserve(durable);
      const intent = executableIntent(durable);

      const receipt = await input.adapterResolver.useForAccount({
        agentId: durable.agentId,
        accountId: durable.accountId,
        use: async (adapter, provider) =>
          executeAndPersistAuthorizedPayment({
            intent,
            authorization,
            provider,
            adapter,
            receiptStore: input.receiptStore,
            intentReader: input.intentReader,
            audit: {
              store: input.auditStore,
              actorUserId: normalizedActorUserId,
            },
            loadOwnerApproval: (id) => input.approvalStore.load(id),
            loadPolicySnapshot: () =>
              input.loadPolicySnapshot({
                agentId: durable.agentId,
                accountId: durable.accountId,
              }),
            beforeExecute: () =>
              input.reservationStore.assertExecutable(reservation.id, durable),
          }),
      });

      const funding = await input.fundingStore.persistVerified({
        reservationId: reservation.id,
        intentId: durable.id,
      });

      return {
        receipt,
        ledgerEntry: funding.parentLedgerEntry,
        childLedgerEntry: funding.childLedgerEntry,
        funding,
      };
    },
  };
}
