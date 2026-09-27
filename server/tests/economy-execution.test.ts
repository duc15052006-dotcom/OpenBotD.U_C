import { describe, expect, test } from "bun:test";
import { encryptSecret } from "../src/credentials";
import {
  executeAuthorizedPayment,
  PaymentExecutionRefusedError,
  withPaymentCredentialAdapter,
  type ExecutablePaymentIntent,
  type PaymentPolicySnapshot,
} from "../src/economy/execution";
import type {
  Money,
  PaymentAccountAdapter,
  PreparedTransfer,
  TransferReceipt,
  TransferRequest,
} from "../src/economy/payment-adapter";
import type { EconomyExecutionPolicy } from "../src/economy/intents";

const policy: EconomyExecutionPolicy = {
  ownerShareBps: 5000n,
  reinvestmentShareBps: 3000n,
  reserveShareBps: 2000n,
  minimumReserveMinor: 10_000n,
  maxPaymentPerTransactionMinor: 50_000n,
  maxHourlySpendMinor: 60_000n,
  maxDailySpendMinor: 200_000n,
  maxMonthlySpendMinor: 1_000_000n,
  ownerConfirmationThresholdMinor: 10_000n,
  allowedPaymentAddresses: ["vendor-wallet"],
  allowedPaymentCategories: ["api"],
  maxChildFundingMinor: 20_000n,
  maxX402PaymentMinor: 5_000n,
  allowedX402Domains: ["example.com"],
  frozen: false,
};

const intent: ExecutablePaymentIntent = {
  id: "intent-id",
  accountId: "account-id",
  idempotencyKey: "intent-key",
  assetCode: "USDC",
  agentId: "agent-a",
  kind: "OPERATING_EXPENSE",
  amountMinor: 1_000n,
  destination: "vendor-wallet",
  category: "api",
};

function snapshot(
  overrides: Partial<PaymentPolicySnapshot> = {},
): PaymentPolicySnapshot {
  return {
    version: 7,
    policy,
    settledBalanceMinor: 100_000n,
    availableDistributableProfitMinor: 20_000n,
    spend: { hourlyMinor: 0n, dailyMinor: 0n, monthlyMinor: 0n },
    ...overrides,
  };
}

class RecordingAdapter implements PaymentAccountAdapter {
  prepareCalls = 0;
  executeCalls = 0;
  verifyCalls = 0;
  balance = 100_000n;
  receiptOverride?: Partial<TransferReceipt>;
  verifyResult = true;

  async getBalance(assetCode: string): Promise<Money> {
    return { assetCode, amountMinor: this.balance };
  }

  async prepareTransfer(request: TransferRequest): Promise<PreparedTransfer> {
    this.prepareCalls += 1;
    return { id: "prepared-1", request };
  }

  async executeTransfer(prepared: PreparedTransfer): Promise<TransferReceipt> {
    this.executeCalls += 1;
    this.balance -= prepared.request.amount.amountMinor;
    return {
      transferId: "provider-transfer-1",
      idempotencyKey: prepared.request.idempotencyKey,
      amount: prepared.request.amount,
      destination: prepared.request.destination,
      ...this.receiptOverride,
    };
  }

  async verifyTransfer(): Promise<boolean> {
    this.verifyCalls += 1;
    return this.verifyResult;
  }
}

describe("Agent Economy execution boundary", () => {
  test("rechecks policy after prepare and before executing", async () => {
    const adapter = new RecordingAdapter();
    let reads = 0;

    await expect(
      executeAuthorizedPayment({
        intent,
        authorization: { decision: "ALLOW", policyVersion: 7 },
        provider: "mock-provider",
        adapter,
        loadPolicySnapshot: async () => {
          reads += 1;
          return reads === 1
            ? snapshot()
            : snapshot({ policy: { ...policy, frozen: true } });
        },
      }),
    ).rejects.toBeInstanceOf(PaymentExecutionRefusedError);

    expect(adapter.prepareCalls).toBe(1);
    expect(adapter.executeCalls).toBe(0);
    expect(adapter.verifyCalls).toBe(0);
  });

  test("refuses execution if policy version changed after authorization", async () => {
    const adapter = new RecordingAdapter();

    await expect(
      executeAuthorizedPayment({
        intent,
        authorization: { decision: "ALLOW", policyVersion: 7 },
        provider: "mock-provider",
        adapter,
        loadPolicySnapshot: async () => snapshot({ version: 8 }),
      }),
    ).rejects.toThrow("financial policy changed after authorization");

    expect(adapter.prepareCalls).toBe(0);
    expect(adapter.executeCalls).toBe(0);
  });

  test("requires explicit Owner confirmation when current policy requires it", async () => {
    const adapter = new RecordingAdapter();
    const largeIntent = { ...intent, amountMinor: 15_000n };

    await expect(
      executeAuthorizedPayment({
        intent: largeIntent,
        authorization: { decision: "ALLOW", policyVersion: 7 },
        provider: "mock-provider",
        adapter,
        loadPolicySnapshot: async () => snapshot(),
      }),
    ).rejects.toThrow("Owner confirmation is required");

    expect(adapter.executeCalls).toBe(0);
  });

  test("returns a receipt only after adapter verification succeeds", async () => {
    const adapter = new RecordingAdapter();
    const receipt = await executeAuthorizedPayment({
      intent,
      authorization: { decision: "ALLOW", policyVersion: 7 },
      provider: "mock-provider",
      adapter,
      loadPolicySnapshot: async () => snapshot(),
    });

    expect(adapter.executeCalls).toBe(1);
    expect(adapter.verifyCalls).toBe(1);
    expect(receipt).toMatchObject({
      intentId: "intent-id",
      agentId: "agent-a",
      accountId: "account-id",
      provider: "mock-provider",
      externalReference: "provider-transfer-1",
      providerStatus: "verified",
      assetCode: "USDC",
      amountMinor: 1_000n,
      destination: "vendor-wallet",
      balanceBeforeMinor: 100_000n,
      balanceAfterMinor: 99_000n,
    });
  });

  test("fails closed when adapter verification fails", async () => {
    const adapter = new RecordingAdapter();
    adapter.verifyResult = false;

    await expect(
      executeAuthorizedPayment({
        intent,
        authorization: { decision: "ALLOW", policyVersion: 7 },
        provider: "mock-provider",
        adapter,
        loadPolicySnapshot: async () => snapshot(),
      }),
    ).rejects.toThrow("could not verify transfer receipt");
  });

  test("rejects a verified receipt whose amount does not match the intent", async () => {
    const adapter = new RecordingAdapter();
    adapter.receiptOverride = {
      amount: { assetCode: "USDC", amountMinor: 999n },
    };

    await expect(
      executeAuthorizedPayment({
        intent,
        authorization: { decision: "ALLOW", policyVersion: 7 },
        provider: "mock-provider",
        adapter,
        loadPolicySnapshot: async () => snapshot(),
      }),
    ).rejects.toThrow("verified receipt amount does not match intent");
  });
});

describe("Agent Economy payment credential custody", () => {
  test("decrypts a payment credential only inside the adapter scope", async () => {
    const encryptionKey = Buffer.alloc(32, 7).toString("base64");
    const encryptedValue = await encryptSecret(encryptionKey, "payment-secret");
    let factorySaw = "";
    let useSawAdapter = false;

    const result = await withPaymentCredentialAdapter({
      encryptionKey,
      credentialId: "credential-id",
      credentialReader: {
        readPaymentSecret: async () => ({
          encryptedValue,
          revokedAt: null,
        }),
      },
      createAdapter: (plaintext) => {
        factorySaw = plaintext;
        return new RecordingAdapter();
      },
      use: async () => {
        useSawAdapter = true;
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(factorySaw).toBe("payment-secret");
    expect(useSawAdapter).toBe(true);
  });

  test("refuses a revoked payment credential before adapter creation", async () => {
    const encryptionKey = Buffer.alloc(32, 9).toString("base64");
    const encryptedValue = await encryptSecret(encryptionKey, "payment-secret");
    let created = false;

    await expect(
      withPaymentCredentialAdapter({
        encryptionKey,
        credentialId: "credential-id",
        credentialReader: {
          readPaymentSecret: async () => ({
            encryptedValue,
            revokedAt: new Date(),
          }),
        },
        createAdapter: () => {
          created = true;
          return new RecordingAdapter();
        },
        use: async () => "never",
      }),
    ).rejects.toThrow("Credential is revoked");

    expect(created).toBe(false);
  });

  test("a non-payment credential id is unusable at this boundary", async () => {
    const encryptionKey = Buffer.alloc(32, 11).toString("base64");
    let created = false;

    await expect(
      withPaymentCredentialAdapter({
        encryptionKey,
        credentialId: "model-credential-id",
        credentialReader: {
          // The specialized vault reader filters kind=payment, so a model id returns null.
          readPaymentSecret: async () => null,
        },
        createAdapter: () => {
          created = true;
          return new RecordingAdapter();
        },
        use: async () => "never",
      }),
    ).rejects.toThrow("Credential was not found");

    expect(created).toBe(false);
  });
});
