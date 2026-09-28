import type { AuditStore } from "../audit";
import {
  executeAndPersistAuthorizedPayment,
  PaymentExecutionRefusedError,
  type PaymentAuthorization,
  type VerifiedPaymentReceipt,
  type VerifiedPaymentReceiptStore,
} from "./execution";
import type { PaymentAccountingStore } from "./payment-accounting-store";
import type { PaymentAdapterResolver } from "./payment-adapter-resolver";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "./payment-intent-store";
import type { OwnerPaymentApprovalStore } from "./approval-store";
import type { PaymentIntentCreationSnapshotLoader } from "./payment-intent-creator";
import type { AgentLedgerEntry } from "./model";

export interface LiveOperatingPaymentResult {
  receipt: VerifiedPaymentReceipt;
  ledgerEntry: AgentLedgerEntry;
}

export interface LiveOperatingPaymentExecutor {
  execute(input: {
    intentId: string;
    actorUserId: string;
    approvalId?: string;
  }): Promise<LiveOperatingPaymentResult>;
}

export class LiveOperatingPaymentUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveOperatingPaymentUnsupportedError";
  }
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
    throw new PaymentExecutionRefusedError(
      "durable payment intent was denied",
    );
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
      "persisted Owner approval is required before payment execution",
    );
  }
  return {
    decision: "OWNER_CONFIRMATION",
    policyVersion: intent.policyVersion,
    approvalId: normalizedApprovalId,
  };
}

export function createLiveOperatingPaymentExecutor(input: {
  intentReader: PaymentIntentReader;
  adapterResolver: PaymentAdapterResolver;
  receiptStore: VerifiedPaymentReceiptStore;
  accountingStore: PaymentAccountingStore;
  approvalStore: OwnerPaymentApprovalStore;
  loadPolicySnapshot: PaymentIntentCreationSnapshotLoader;
  auditStore: AuditStore;
}): LiveOperatingPaymentExecutor {
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
      if (
        durable.kind !== "OPERATING_EXPENSE" &&
        durable.kind !== "X402_PAYMENT"
      ) {
        throw new LiveOperatingPaymentUnsupportedError(
          "this payment kind requires a specialized execution path",
        );
      }

      const authorization = authorizationFor(durable, approvalId);
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
          }),
      });

      const ledgerEntry = await input.accountingStore.persistOperatingPayment(
        durable.id,
      );

      return { receipt, ledgerEntry };
    },
  };
}
