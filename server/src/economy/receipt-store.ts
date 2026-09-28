import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agentPaymentReceipts } from "../db/schema";
import type {
  VerifiedPaymentReceipt,
  VerifiedPaymentReceiptStore,
} from "./execution";

export class PaymentReceiptConflictError extends Error {
  constructor(intentId: string) {
    super(
      `Payment intent ${intentId} already has a conflicting verified receipt.`,
    );
    this.name = "PaymentReceiptConflictError";
  }
}

export class PaymentReceiptIntegrityError extends Error {
  constructor(intentId: string) {
    super(
      `Stored receipt for payment intent ${intentId} failed integrity checks.`,
    );
    this.name = "PaymentReceiptIntegrityError";
  }
}

export function verifiedPaymentReceiptFromRow(row: {
  intentId: string;
  agentId: string;
  accountId: string;
  provider: string;
  externalReference: string;
  providerStatus: string;
  assetCode: string;
  amountMinor: string;
  destination: string;
  balanceBeforeMinor: string | null;
  balanceAfterMinor: string | null;
  verifiedAt: Date;
}): VerifiedPaymentReceipt {
  if (
    !row.intentId.trim() ||
    !row.agentId.trim() ||
    !row.accountId.trim() ||
    !row.provider.trim() ||
    row.providerStatus !== "verified" ||
    !row.assetCode.trim() ||
    !row.destination.trim() ||
    row.balanceBeforeMinor === null ||
    !row.externalReference.trim() ||
    Number.isNaN(row.verifiedAt.getTime())
  ) {
    throw new PaymentReceiptIntegrityError(row.intentId);
  }

  let amountMinor: bigint;
  let balanceBeforeMinor: bigint;
  let balanceAfterMinor: bigint | null;
  try {
    amountMinor = BigInt(row.amountMinor);
    balanceBeforeMinor = BigInt(row.balanceBeforeMinor);
    balanceAfterMinor =
      row.balanceAfterMinor === null ? null : BigInt(row.balanceAfterMinor);
  } catch {
    throw new PaymentReceiptIntegrityError(row.intentId);
  }
  if (
    amountMinor <= 0n ||
    balanceBeforeMinor < 0n ||
    (balanceAfterMinor !== null && balanceAfterMinor < 0n)
  ) {
    throw new PaymentReceiptIntegrityError(row.intentId);
  }

  return {
    intentId: row.intentId,
    agentId: row.agentId,
    accountId: row.accountId,
    provider: row.provider,
    externalReference: row.externalReference,
    providerStatus: "verified",
    assetCode: row.assetCode,
    amountMinor,
    destination: row.destination,
    balanceBeforeMinor,
    balanceAfterMinor,
    verifiedAt: row.verifiedAt,
  };
}

export function sameVerifiedPaymentTransfer(
  expected: VerifiedPaymentReceipt,
  actual: VerifiedPaymentReceipt,
): boolean {
  return (
    expected.intentId === actual.intentId &&
    expected.agentId === actual.agentId &&
    expected.accountId === actual.accountId &&
    expected.provider === actual.provider &&
    expected.externalReference === actual.externalReference &&
    expected.providerStatus === actual.providerStatus &&
    expected.assetCode === actual.assetCode &&
    expected.amountMinor === actual.amountMinor &&
    expected.destination === actual.destination
  );
}

export function createVerifiedPaymentReceiptStore(
  database: Database,
): VerifiedPaymentReceiptStore {
  const loadByIntent = async (
    intentId: string,
  ): Promise<VerifiedPaymentReceipt | null> => {
    const normalized = intentId.trim();
    if (!normalized) return null;

    const [row] = await database
      .select({
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
      .where(eq(agentPaymentReceipts.intentId, normalized))
      .limit(1);

    return row ? verifiedPaymentReceiptFromRow(row) : null;
  };

  return {
    loadByIntent,

    async saveVerified(receipt) {
      if (
        !receipt.intentId.trim() ||
        !receipt.agentId.trim() ||
        !receipt.accountId.trim() ||
        !receipt.provider.trim() ||
        !receipt.externalReference.trim() ||
        !receipt.assetCode.trim() ||
        receipt.amountMinor <= 0n ||
        !receipt.destination.trim() ||
        receipt.balanceBeforeMinor < 0n ||
        (receipt.balanceAfterMinor !== null &&
          receipt.balanceAfterMinor < 0n) ||
        Number.isNaN(receipt.verifiedAt.getTime())
      ) {
        throw new PaymentReceiptConflictError(receipt.intentId);
      }

      const inserted = await database
        .insert(agentPaymentReceipts)
        .values({
          intentId: receipt.intentId,
          agentId: receipt.agentId,
          accountId: receipt.accountId,
          provider: receipt.provider,
          externalReference: receipt.externalReference,
          providerStatus: "verified",
          assetCode: receipt.assetCode,
          amountMinor: receipt.amountMinor.toString(),
          destination: receipt.destination,
          balanceBeforeMinor: receipt.balanceBeforeMinor.toString(),
          balanceAfterMinor: receipt.balanceAfterMinor?.toString() ?? null,
          verifiedAt: receipt.verifiedAt,
          metadata: {},
        })
        .onConflictDoNothing({ target: agentPaymentReceipts.intentId })
        .returning({ intentId: agentPaymentReceipts.intentId });

      const stored = await loadByIntent(receipt.intentId);
      if (!stored || !sameVerifiedPaymentTransfer(receipt, stored)) {
        throw new PaymentReceiptConflictError(receipt.intentId);
      }
      return { receipt: stored, created: inserted.length === 1 };
    },
  };
}
