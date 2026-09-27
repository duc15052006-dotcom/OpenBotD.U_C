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

function fromRow(row: {
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
}): VerifiedPaymentReceipt | null {
  if (
    row.providerStatus !== "verified" ||
    row.balanceBeforeMinor === null ||
    !row.externalReference.trim() ||
    Number.isNaN(row.verifiedAt.getTime())
  ) {
    return null;
  }

  return {
    intentId: row.intentId,
    agentId: row.agentId,
    accountId: row.accountId,
    provider: row.provider,
    externalReference: row.externalReference,
    providerStatus: "verified",
    assetCode: row.assetCode,
    amountMinor: BigInt(row.amountMinor),
    destination: row.destination,
    balanceBeforeMinor: BigInt(row.balanceBeforeMinor),
    balanceAfterMinor:
      row.balanceAfterMinor === null ? null : BigInt(row.balanceAfterMinor),
    verifiedAt: row.verifiedAt,
  };
}

function sameReceipt(
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
    expected.destination === actual.destination &&
    expected.balanceBeforeMinor === actual.balanceBeforeMinor &&
    expected.balanceAfterMinor === actual.balanceAfterMinor &&
    expected.verifiedAt.getTime() === actual.verifiedAt.getTime()
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

    return row ? fromRow(row) : null;
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

      await database
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
        .onConflictDoNothing({ target: agentPaymentReceipts.intentId });

      const stored = await loadByIntent(receipt.intentId);
      if (!stored || !sameReceipt(receipt, stored)) {
        throw new PaymentReceiptConflictError(receipt.intentId);
      }
      return stored;
    },
  };
}
