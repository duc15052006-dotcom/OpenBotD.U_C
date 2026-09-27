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
  TransferReceipt,
} from "./payment-adapter";

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

export type PaymentAuthorization =
  | {
      decision: "ALLOW";
      policyVersion: number;
    }
  | {
      decision: "OWNER_CONFIRMATION";
      policyVersion: number;
      ownerConfirmed: true;
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
  balanceAfterMinor: bigint;
  verifiedAt: Date;
}

export class PaymentExecutionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentExecutionRefusedError";
  }
}

function requireAuthorization(
  intent: ExecutablePaymentIntent,
  snapshot: PaymentPolicySnapshot,
  authorization: PaymentAuthorization,
): void {
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

  if (
    decision.decision === "OWNER_CONFIRMATION" &&
    authorization.decision !== "OWNER_CONFIRMATION"
  ) {
    throw new PaymentExecutionRefusedError(
      "Owner confirmation is required before payment execution",
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
}): Promise<VerifiedPaymentReceipt> {
  const initialSnapshot = await input.loadPolicySnapshot();
  requireAuthorization(input.intent, initialSnapshot, input.authorization);

  const balanceBefore = await input.adapter.getBalance(input.intent.assetCode);
  const prepared = await input.adapter.prepareTransfer({
    idempotencyKey: input.intent.idempotencyKey,
    amount: {
      assetCode: input.intent.assetCode,
      amountMinor: input.intent.amountMinor,
    },
    destination: input.intent.destination,
  });

  // Deliberately re-read state after prepare. No cached decision crosses the actual execution line.
  const executionSnapshot = await input.loadPolicySnapshot();
  requireAuthorization(input.intent, executionSnapshot, input.authorization);

  const receipt = await input.adapter.executeTransfer(prepared);
  if (!(await input.adapter.verifyTransfer(receipt))) {
    throw new Error("payment adapter could not verify transfer receipt");
  }
  requireMatchingReceipt(input.intent, receipt);

  const balanceAfter = await input.adapter.getBalance(input.intent.assetCode);

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
    balanceAfterMinor: balanceAfter.amountMinor,
    verifiedAt: new Date(),
  };
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
