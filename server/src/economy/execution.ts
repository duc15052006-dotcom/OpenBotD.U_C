import {
  DEPLOYMENT_INITIATOR,
  type AuditInitiator,
  type AuditStore,
  recordAuditEvent,
} from "../audit";
import {
  decryptPaymentCredentialForUse,
  type PaymentCredentialSecretReader,
} from "../credentials";
import {
  decidePaymentIntent,
  type EconomyExecutionPolicy,
  type PaymentIntent,
  type SpendWindow,
} from "./intents";
import type {
  PaymentAccountAdapter,
  PreparedTransfer,
  TransferReceipt,
} from "./payment-adapter";
import type {
  DurablePaymentIntent,
  PaymentIntentReader,
} from "./payment-intent-store";

export interface ExecutablePaymentIntent extends PaymentIntent {
  id: string;
  accountId: string;
  idempotencyKey: string;
  assetCode: string;
}

export interface PaymentPolicySnapshot {
  version: number;
  policy: EconomyExecutionPolicy;
  settledBalanceMinor: bigint;
  availableDistributableProfitMinor: bigint;
  spend: SpendWindow;
}

export interface OwnerPaymentApproval {
  id: string;
  intentId: string;
  agentId: string;
  policyVersion: number;
  approverKind: "OWNER";
  approverId: string;
  approvedAt: Date;
}

export type PaymentAuthorization =
  | {
      decision: "ALLOW";
      policyVersion: number;
    }
  | {
      decision: "OWNER_CONFIRMATION";
      policyVersion: number;
      approvalId: string;
    };

export interface VerifiedPaymentReceipt {
  intentId: string;
  agentId: string;
  accountId: string;
  provider: string;
  externalReference: string;
  providerStatus: "verified";
  assetCode: string;
  amountMinor: bigint;
  destination: string;
  balanceBeforeMinor: bigint;
  balanceAfterMinor: bigint | null;
  verifiedAt: Date;
}

export interface PersistedVerifiedPaymentReceipt {
  receipt: VerifiedPaymentReceipt;
  created: boolean;
}

export interface VerifiedPaymentReceiptStore {
  loadByIntent(intentId: string): Promise<VerifiedPaymentReceipt | null>;
  saveVerified(
    receipt: VerifiedPaymentReceipt,
  ): Promise<PersistedVerifiedPaymentReceipt>;
}

export class PaymentExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentExecutionRefusedError";
  }
}

function requireDurableIntentMatchesExecution(
  durable: DurablePaymentIntent | null,
  intent: ExecutablePaymentIntent,
  provider: string,
  authorization: PaymentAuthorization,
): void {
  if (!durable) {
    throw new PaymentExecutionRefusedError(
      "durable payment intent was not found or Agent is inactive",
    );
  }

  if (
    durable.id !== intent.id ||
    durable.agentId !== intent.agentId ||
    durable.accountId !== intent.accountId ||
    durable.idempotencyKey !== intent.idempotencyKey ||
    durable.kind !== intent.kind
  ) {
    throw new PaymentExecutionRefusedError(
      "execution does not match durable payment intent identity",
    );
  }

  if (
    durable.amountMinor !== intent.amountMinor ||
    durable.assetCode !== intent.assetCode ||
    durable.destination !== intent.destination ||
    durable.category !== intent.category ||
    (durable.x402Domain ?? undefined) !== (intent.x402Domain ?? undefined)
  ) {
    throw new PaymentExecutionRefusedError(
      "execution does not match durable payment intent terms",
    );
  }

  if (durable.provider !== provider) {
    throw new PaymentExecutionRefusedError(
      "payment provider does not match durable financial account",
    );
  }

  if (
    durable.policyVersion !== authorization.policyVersion ||
    durable.decision !== authorization.decision
  ) {
    throw new PaymentExecutionRefusedError(
      "authorization does not match durable payment intent decision",
    );
  }
  if (durable.decision === "DENY") {
    throw new PaymentExecutionRefusedError(
      "durable payment intent was denied",
    );
  }
}

async function requireAuthorization(
  intent: ExecutablePaymentIntent,
  snapshot: PaymentPolicySnapshot,
  authorization: PaymentAuthorization,
  loadOwnerApproval?: (
    approvalId: string,
  ) => Promise<OwnerPaymentApproval | null>,
): Promise<void> {
  if (snapshot.version !== authorization.policyVersion) {
    throw new PaymentExecutionRefusedError(
      "financial policy changed after authorization",
    );
  }

  const decision = decidePaymentIntent({
    intent,
    policy: snapshot.policy,
    settledBalanceMinor: snapshot.settledBalanceMinor,
    availableDistributableProfitMinor:
      snapshot.availableDistributableProfitMinor,
    spend: snapshot.spend,
  });

  if (decision.decision === "DENY") {
    throw new PaymentExecutionRefusedError(decision.reason);
  }

  if (decision.decision !== "OWNER_CONFIRMATION") return;

  if (authorization.decision !== "OWNER_CONFIRMATION") {
    throw new PaymentExecutionRefusedError(
      "Owner confirmation is required before payment execution",
    );
  }
  if (!authorization.approvalId.trim() || !loadOwnerApproval) {
    throw new PaymentExecutionRefusedError(
      "persisted Owner approval is required before payment execution",
    );
  }

  const approval = await loadOwnerApproval(authorization.approvalId);
  if (!approval) {
    throw new PaymentExecutionRefusedError(
      "persisted Owner approval was not found",
    );
  }
  if (
    approval.id !== authorization.approvalId ||
    approval.intentId !== intent.id ||
    approval.agentId !== intent.agentId
  ) {
    throw new PaymentExecutionRefusedError(
      "Owner approval does not match payment intent",
    );
  }
  if (
    approval.policyVersion !== authorization.policyVersion ||
    approval.policyVersion !== snapshot.version
  ) {
    throw new PaymentExecutionRefusedError(
      "Owner approval policy version does not match execution policy",
    );
  }
  if (
    approval.approverKind !== "OWNER" ||
    !approval.approverId.trim() ||
    Number.isNaN(approval.approvedAt.getTime())
  ) {
    throw new PaymentExecutionRefusedError("Owner approval record is invalid");
  }
}

function requireMatchingPreparedTransfer(
  intent: ExecutablePaymentIntent,
  prepared: PreparedTransfer,
): void {
  if (prepared.request.idempotencyKey !== intent.idempotencyKey) {
    throw new PaymentExecutionRefusedError(
      "prepared transfer idempotency key does not match intent",
    );
  }
  if (prepared.request.amount.assetCode !== intent.assetCode) {
    throw new PaymentExecutionRefusedError(
      "prepared transfer asset does not match intent",
    );
  }
  if (prepared.request.amount.amountMinor !== intent.amountMinor) {
    throw new PaymentExecutionRefusedError(
      "prepared transfer amount does not match intent",
    );
  }
  if (prepared.request.destination !== intent.destination) {
    throw new PaymentExecutionRefusedError(
      "prepared transfer destination does not match intent",
    );
  }
}

function requireMatchingReceipt(
  intent: ExecutablePaymentIntent,
  receipt: TransferReceipt,
): void {
  if (receipt.idempotencyKey !== intent.idempotencyKey) {
    throw new Error("verified receipt idempotency key does not match intent");
  }
  if (receipt.amount.assetCode !== intent.assetCode) {
    throw new Error("verified receipt asset does not match intent");
  }
  if (receipt.amount.amountMinor !== intent.amountMinor) {
    throw new Error("verified receipt amount does not match intent");
  }
  if (receipt.destination !== intent.destination) {
    throw new Error("verified receipt destination does not match intent");
  }
}

/**
 * Execute one already-authorized intent through a server-side payment adapter.
 *
 * Policy is checked twice: once before preparing and once immediately before the external execution.
 * The second check is the kill-switch boundary. A freeze, spend-limit change or reserve change that
 * lands while the adapter is preparing therefore stops the transfer before money can move.
 */
export async function executeAuthorizedPayment(input: {
  intent: ExecutablePaymentIntent;
  authorization: PaymentAuthorization;
  provider: string;
  adapter: PaymentAccountAdapter;
  loadPolicySnapshot: () => Promise<PaymentPolicySnapshot>;
  loadOwnerApproval?: (
    approvalId: string,
  ) => Promise<OwnerPaymentApproval | null>;
}): Promise<VerifiedPaymentReceipt> {
  const initialSnapshot = await input.loadPolicySnapshot();
  await requireAuthorization(
    input.intent,
    initialSnapshot,
    input.authorization,
    input.loadOwnerApproval,
  );

  const balanceBefore = await input.adapter.getBalance(input.intent.assetCode);
  const prepared = await input.adapter.prepareTransfer({
    idempotencyKey: input.intent.idempotencyKey,
    amount: {
      assetCode: input.intent.assetCode,
      amountMinor: input.intent.amountMinor,
    },
    destination: input.intent.destination,
  });

  // The adapter may normalize provider-specific fields, but it may not widen or rewrite the
  // immutable financial instruction. Validate before the final policy read and, critically, before
  // executeTransfer() can move money. Receipt validation after execution remains defense in depth.
  requireMatchingPreparedTransfer(input.intent, prepared);

  // Deliberately re-read state after prepare. No cached decision crosses the actual execution line.
  const executionSnapshot = await input.loadPolicySnapshot();
  await requireAuthorization(
    input.intent,
    executionSnapshot,
    input.authorization,
    input.loadOwnerApproval,
  );

  const receipt = await input.adapter.executeTransfer(prepared);
  if (!(await input.adapter.verifyTransfer(receipt))) {
    throw new Error("payment adapter could not verify transfer receipt");
  }
  requireMatchingReceipt(input.intent, receipt);

  let balanceAfterMinor: bigint | null = null;
  try {
    balanceAfterMinor = (await input.adapter.getBalance(input.intent.assetCode))
      .amountMinor;
  } catch {
    // The transfer is already verified. A balance refresh outage must not erase proof that money
    // moved; reconciliation can fill this optional evidence later.
  }

  return {
    intentId: input.intent.id,
    agentId: input.intent.agentId,
    accountId: input.intent.accountId,
    provider: input.provider,
    externalReference: receipt.transferId,
    providerStatus: "verified",
    assetCode: receipt.amount.assetCode,
    amountMinor: receipt.amount.amountMinor,
    destination: receipt.destination,
    balanceBeforeMinor: balanceBefore.amountMinor,
    balanceAfterMinor,
    verifiedAt: new Date(),
  };
}

function requireStoredReceiptMatchesIntent(
  intent: ExecutablePaymentIntent,
  provider: string,
  receipt: VerifiedPaymentReceipt,
): void {
  if (
    receipt.intentId !== intent.id ||
    receipt.agentId !== intent.agentId ||
    receipt.accountId !== intent.accountId
  ) {
    throw new PaymentExecutionRefusedError(
      "stored payment receipt does not match payment intent identity",
    );
  }
  if (receipt.provider !== provider || receipt.providerStatus !== "verified") {
    throw new PaymentExecutionRefusedError(
      "stored payment receipt does not match payment provider",
    );
  }
  if (
    receipt.assetCode !== intent.assetCode ||
    receipt.amountMinor !== intent.amountMinor ||
    receipt.destination !== intent.destination
  ) {
    throw new PaymentExecutionRefusedError(
      "stored payment receipt does not match payment intent terms",
    );
  }
  if (
    !receipt.externalReference.trim() ||
    Number.isNaN(receipt.verifiedAt.getTime())
  ) {
    throw new PaymentExecutionRefusedError("stored payment receipt is invalid");
  }
}

/**
 * Execute once and durably persist the verified receipt.
 *
 * A retry that already has a matching durable receipt returns it without touching the payment
 * provider again. Concurrent first attempts still rely on the provider idempotency key at the
 * external boundary; the receipt store then collapses both verified outcomes onto the one immutable
 * intent row and rejects any conflicting identity or terms.
 */
export async function executeAndPersistAuthorizedPayment(input: {
  intent: ExecutablePaymentIntent;
  authorization: PaymentAuthorization;
  provider: string;
  adapter: PaymentAccountAdapter;
  receiptStore: VerifiedPaymentReceiptStore;
  intentReader: PaymentIntentReader;
  audit: {
    store: AuditStore;
    actorUserId?: string;
    initiator?: AuditInitiator;
  };
  loadPolicySnapshot: () => Promise<PaymentPolicySnapshot>;
  loadOwnerApproval?: (
    approvalId: string,
  ) => Promise<OwnerPaymentApproval | null>;
}): Promise<VerifiedPaymentReceipt> {
  const durableIntent = await input.intentReader.load(input.intent.id);
  requireDurableIntentMatchesExecution(
    durableIntent,
    input.intent,
    input.provider,
    input.authorization,
  );

  const existing = await input.receiptStore.loadByIntent(input.intent.id);
  if (existing) {
    requireStoredReceiptMatchesIntent(input.intent, input.provider, existing);
    return existing;
  }

  const receipt = await executeAuthorizedPayment({
    intent: input.intent,
    authorization: input.authorization,
    provider: input.provider,
    adapter: input.adapter,
    loadPolicySnapshot: input.loadPolicySnapshot,
    loadOwnerApproval: input.loadOwnerApproval,
  });
  const persisted = await input.receiptStore.saveVerified(receipt);
  const stored = persisted.receipt;
  requireStoredReceiptMatchesIntent(input.intent, input.provider, stored);

  if (persisted.created) {
    try {
      await recordAuditEvent(input.audit.store, {
        eventType: "economy.payment_executed",
        targetType: "payment_intent",
        targetId: stored.intentId,
        ...(input.audit.actorUserId
          ? { actorUserId: input.audit.actorUserId }
          : {}),
        initiator: input.audit.initiator ?? DEPLOYMENT_INITIATOR,
        payload: {
          agentId: stored.agentId,
          accountId: stored.accountId,
          provider: stored.provider,
          externalReference: stored.externalReference,
          assetCode: stored.assetCode,
          amountMinor: stored.amountMinor.toString(),
        },
      });
    } catch (auditError) {
      console.error(
        JSON.stringify({
          type: "economy-payment-audit-write-failed",
          intentId: stored.intentId,
          error: String(auditError),
        }),
      );
    }
  }

  return stored;
}

/**
 * Scope a payment adapter to a payment-only credential from the encrypted server vault.
 *
 * The plaintext is handed only to the server-side adapter factory and is never returned from this
 * function, written to an Economy table, or exposed to an Agent/Computer/plugin runtime.
 */
export async function withPaymentCredentialAdapter<T>(input: {
  encryptionKey: string;
  credentialReader: PaymentCredentialSecretReader;
  credentialId: string;
  createAdapter: (
    plaintextCredential: string,
  ) => PaymentAccountAdapter | Promise<PaymentAccountAdapter>;
  use: (adapter: PaymentAccountAdapter) => Promise<T>;
}): Promise<T> {
  const plaintext = await decryptPaymentCredentialForUse(
    input.encryptionKey,
    input.credentialReader,
    input.credentialId,
  );
  const adapter = await input.createAdapter(plaintext);
  return input.use(adapter);
}
