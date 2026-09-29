import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import type { PaymentAdapterResolver } from "../src/economy/payment-adapter-resolver";
import type { PaymentAccountAdapter } from "../src/economy/payment-adapter";
import {
  reconcileVerifiedPaymentReceipts,
  type PaymentReceiptReconciliationSource,
  type ReconciliationCandidate,
} from "../src/economy/reconciliation";

function candidate(id = "receipt-1"): ReconciliationCandidate {
  return {
    receiptId: id,
    receipt: {
      intentId: `intent-${id}`,
      agentId: "agent-a",
      accountId: "account-a",
      provider: "circle",
      externalReference: `circle-${id}`,
      providerStatus: "verified",
      assetCode: "USDC",
      amountMinor: 1_250_000n,
      destination: "0x1111111111111111111111111111111111111111",
      balanceBeforeMinor: 2_000_000n,
      balanceAfterMinor: 750_000n,
      verifiedAt: new Date("2026-09-29T00:00:00.000Z"),
    },
  };
}

function source(rows: ReconciliationCandidate[]): PaymentReceiptReconciliationSource {
  return {
    list: async () => rows,
  };
}

function adapter(verify: (externalReference: string) => boolean): PaymentAccountAdapter {
  return {
    getBalance: async (assetCode) => ({ assetCode, amountMinor: 0n }),
    prepareTransfer: async () => {
      throw new Error("not used");
    },
    executeTransfer: async () => {
      throw new Error("not used");
    },
    verifyTransfer: async (receipt) => verify(receipt.transferId),
  };
}

function resolver(
  paymentAdapter: PaymentAccountAdapter,
  options: { throwForAccount?: string } = {},
): PaymentAdapterResolver {
  return {
    useForAccount: async ({ accountId, use }) => {
      if (accountId === options.throwForAccount) {
        throw new Error("provider unavailable");
      }
      return use(paymentAdapter, "circle");
    },
  };
}

function audit(events: AuditEventInput[]): AuditStore {
  return {
    insert: async (event) => {
      events.push(event);
    },
  };
}

describe("Agent Economy payment receipt reconciliation", () => {
  test("successful provider re-verification produces no audit noise", async () => {
    const events: AuditEventInput[] = [];
    const report = await reconcileVerifiedPaymentReceipts({
      source: source([candidate()]),
      adapterResolver: resolver(adapter(() => true)),
      auditStore: audit(events),
    });

    expect(report).toEqual({
      checked: 1,
      verified: 1,
      failed: 0,
      auditWriteFailures: 0,
    });
    expect(events).toEqual([]);
  });

  test("provider evidence mismatch is audited without rewriting history", async () => {
    const events: AuditEventInput[] = [];
    const report = await reconcileVerifiedPaymentReceipts({
      source: source([candidate()]),
      adapterResolver: resolver(adapter(() => false)),
      auditStore: audit(events),
    });

    expect(report).toEqual({
      checked: 1,
      verified: 0,
      failed: 1,
      auditWriteFailures: 0,
    });
    expect(events).toEqual([
      {
        eventType: "economy.payment_reconciliation_failed",
        targetType: "payment_receipt",
        targetId: "receipt-1",
        initiator: { kind: "deployment" },
        payload: {
          intentId: "intent-receipt-1",
          agentId: "agent-a",
          accountId: "account-a",
          provider: "circle",
          reason: "provider_evidence_mismatch",
        },
      },
    ]);
  });

  test("one provider outage does not stop reconciliation of later receipts", async () => {
    const events: AuditEventInput[] = [];
    const first = candidate("receipt-1");
    const second = {
      ...candidate("receipt-2"),
      receipt: {
        ...candidate("receipt-2").receipt,
        accountId: "account-b",
      },
    };

    const report = await reconcileVerifiedPaymentReceipts({
      source: source([first, second]),
      adapterResolver: resolver(adapter(() => true), {
        throwForAccount: "account-a",
      }),
      auditStore: audit(events),
    });

    expect(report).toEqual({
      checked: 2,
      verified: 1,
      failed: 1,
      auditWriteFailures: 0,
    });
    expect(events[0]?.payload.reason).toBe("provider_unavailable");
  });

  test("audit write failure is counted but does not abort the pass", async () => {
    const report = await reconcileVerifiedPaymentReceipts({
      source: source([candidate()]),
      adapterResolver: resolver(adapter(() => false)),
      auditStore: {
        insert: async () => {
          throw new Error("audit unavailable");
        },
      },
    });

    expect(report).toEqual({
      checked: 1,
      verified: 0,
      failed: 1,
      auditWriteFailures: 1,
    });
  });
});
